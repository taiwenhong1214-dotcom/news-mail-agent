"""新闻流水线：入库判重 → 预筛 → LLM 打分 → 即时推送。"""
from __future__ import annotations

import json
import logging
import time
from collections import Counter

from ..db import Database, chunked, insert_rows, select_in
from ..llm import LLMClient, LLMError, extract_groups, extract_json_items, validate_scores
from ..settings import Settings, load_prompt
from ..telegram import Telegram, esc
from . import prefilter
from .fetch import Item
from .simhash import SimIndex, from_hex, to_hex

log = logging.getLogger(__name__)

INSERT_COLUMNS = (
    "url_hash", "url", "title", "summary", "source", "feed_group", "tier",
    "published_at", "fetched_at", "simhash", "cluster_id", "status", "filter_reason",
)


def load_muted(db: Database) -> list[str]:
    try:
        return [r["word"] for r in db.query("SELECT word FROM muted_keywords")]
    except Exception as e:
        log.warning("读取 muted_keywords 失败: %s", e)
        return []


# ---------------- 入库 + 判重 + 预筛 ----------------

def ingest(db: Database, items: list[Item], settings: Settings, rules: prefilter.FilterRules,
           now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    stats = Counter(fetched=len(items))

    # 1) 本批内 URL 判重
    uniq: dict[str, Item] = {}
    for it in items:
        uniq.setdefault(it.url_hash, it)
    batch = list(uniq.values())

    # 2) 与库里 URL 判重
    existing = {
        r["url_hash"]
        for r in select_in(db, "SELECT url_hash FROM news_items WHERE url_hash IN ({in})",
                           [i.url_hash for i in batch])
    }
    new = [i for i in batch if i.url_hash not in existing]
    stats["url_dup"] = len(items) - len(new)
    if not new:
        return dict(stats)

    # 3) SimHash 近似判重：和最近 simhash_window_hours 内的主条目 + 本批已确定的主条目比较
    #    （窗口比 48h 短，避免把每天重复的标题，比如"Bursa Malaysia opens higher"，跨天合并）
    since = now - settings.simhash_window_hours * 3600
    index = SimIndex(settings.simhash_distance)
    for r in db.query(
        "SELECT id, simhash FROM news_items WHERE published_at >= ? AND cluster_id = id", [since]
    ):
        index.add(from_hex(r["simhash"]), ("db", r["id"]))

    # T1 优先、发布早的优先成为主条目（通常是首发报道）
    new.sort(key=lambda i: (i.tier != "T1", i.published_at))
    primaries: list[Item] = []
    dups: list[tuple[Item, tuple[str, object]]] = []
    for it in new:
        key = index.find(it.simhash) if it.published_at >= since else None
        if key is not None:
            dups.append((it, key))
        else:
            primaries.append(it)
            index.add(it.simhash, ("new", it.url_hash))

    # 4) 主条目预筛 + 入库
    rows = []
    for it in primaries:
        reason = prefilter.check(it.title, it.summary, it.group, rules)
        stats["filtered" if reason else "pending"] += 1
        rows.append(_row(it, now, None, "filtered" if reason else "pending", reason))
    insert_rows(db, "news_items", INSERT_COLUMNS, rows)
    db.execute("UPDATE news_items SET cluster_id = id WHERE cluster_id IS NULL")

    # 5) 重复条目入库，挂到主条目下，并给主条目 source_count +1
    if dups:
        new_ids = {
            r["url_hash"]: r["id"]
            for r in select_in(db, "SELECT id, url_hash FROM news_items WHERE url_hash IN ({in})",
                               list({k[1] for _, k in dups if k[0] == "new"}))
        }
        dup_rows, counts = [], Counter()
        for it, (kind, ref) in dups:
            cid = ref if kind == "db" else new_ids.get(ref)
            if cid is None:
                continue
            dup_rows.append(_row(it, now, cid, "dup", None))
            counts[cid] += 1
        insert_rows(db, "news_items", INSERT_COLUMNS, dup_rows)
        _increment_source_counts(db, counts)
        stats["near_dup"] = len(dup_rows)

    stats["new"] = len(new)
    return dict(stats)


def _row(it: Item, now: int, cluster_id, status: str, reason: str | None) -> tuple:
    return (
        it.url_hash, it.url, it.title, it.summary, it.source, it.group, it.tier,
        it.published_at, now, to_hex(it.simhash), cluster_id, status, reason,
    )


def _increment_source_counts(db: Database, counts: Counter) -> None:
    pairs = list(counts.items())
    for chunk in chunked(pairs, 30):  # 每个 id 占 3 个参数，留在 100 以内
        case = " ".join("WHEN ? THEN ?" for _ in chunk)
        params = [v for cid, n in chunk for v in (cid, n)] + [cid for cid, _ in chunk]
        db.execute(
            f"UPDATE news_items SET source_count = source_count + CASE id {case} ELSE 0 END "
            f"WHERE id IN ({','.join('?' * len(chunk))})",
            params,
        )


# ---------------- LLM 打分 ----------------

def score_pending(db: Database, llm: LLMClient, settings: Settings, now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    since = now - settings.window_hours * 3600
    group_names = settings.group_names()
    categories = [*group_names.values(), "其他"]
    template = load_prompt("score.md").replace("{{categories}}", " / ".join(categories))

    rows = db.query(
        "SELECT id, title, summary, source, feed_group, tier FROM news_items "
        "WHERE status IN ('pending', 'llm_failed') AND llm_attempts < ? AND published_at >= ? "
        "ORDER BY (tier = 'T1') DESC, published_at DESC LIMIT ?",
        [settings.max_llm_attempts, since, settings.score_batch_size * settings.max_score_batches],
    )
    stats = Counter(candidates=len(rows))
    consecutive_errors = 0
    for batch in chunked(rows, settings.score_batch_size):
        ids = {r["id"] for r in batch}
        payload = [
            {
                "id": r["id"],
                "title": r["title"],
                "summary": (r["summary"] or "")[:300],
                "source": r["source"],
                "group": group_names.get(r["feed_group"], r["feed_group"]),
                "tier": r["tier"],
            }
            for r in batch
        ]
        prompt = template.replace("{{items}}", json.dumps(payload, ensure_ascii=False, indent=1))
        try:
            text = llm.chat([{"role": "user", "content": prompt}])
            consecutive_errors = 0
        except LLMError as e:
            log.warning("LLM 调用失败: %s", e)
            stats["llm_errors"] += 1
            _mark_failed(db, ids)
            consecutive_errors += 1
            if consecutive_errors >= 2:  # 连续失败就停，避免浪费时间和额度
                break
            continue

        fallback = {r["id"]: group_names.get(r["feed_group"], "其他") for r in batch}
        results = validate_scores(extract_json_items(text), ids, categories, fallback)
        for iid, res in results.items():
            db.execute(
                "UPDATE news_items SET status = 'scored', score = ?, category = ?, summary_zh = ?, "
                "reason = ?, llm_attempts = llm_attempts + 1 WHERE id = ?",
                [res["score"], res["category"], res["summary_zh"], res["reason"], iid],
            )
        missing = ids - results.keys()
        if missing:
            log.warning("LLM 结果缺失或无法解析 %d/%d 条，下次重试", len(missing), len(ids))
            _mark_failed(db, missing)
        stats["scored"] += len(results)
        stats["parse_failed"] += len(missing)

    if stats["llm_errors"] and not stats["scored"]:
        raise LLMError(f"本次打分全部失败（{stats['llm_errors']} 次调用错误）")
    return dict(stats)


def merge_events(db: Database, llm: LLMClient, settings: Settings, now: int | None = None) -> dict:
    """LLM 事件合并：SimHash 只能合并标题几乎相同的报道；同一事件的不同角度报道
    （"CEO 辞职" / "股价因此下跌" / "分析师点评"）交给 LLM 分组，每组只保留一条主条目。"""
    now = int(time.time()) if now is None else now
    rows = db.query(
        "SELECT id, title, summary_zh, score, tier, source_count, pushed_at, published_at "
        "FROM news_items WHERE status = 'scored' AND cluster_id = id AND score >= ? "
        "AND published_at >= ? ORDER BY score DESC, published_at DESC LIMIT ?",
        [settings.merge_min_score, now - 24 * 3600, settings.merge_max_items],
    )
    if len(rows) < 2:
        return {"candidates": len(rows), "merged": 0}

    by_id = {r["id"]: r for r in rows}
    payload = [{"id": r["id"], "title": r["title"], "summary": r["summary_zh"]} for r in rows]
    prompt = load_prompt("events.md").replace(
        "{{items}}", json.dumps(payload, ensure_ascii=False, indent=1)
    )
    groups = extract_groups(llm.chat([{"role": "user", "content": prompt}]), set(by_id))

    merged = 0
    for g in groups:
        members = [by_id[i] for i in g]
        # 已推送过的优先当主条目（避免同一事件再推一次），其次分数高、T1、发布早
        primary = max(members, key=lambda r: (r["pushed_at"] is not None, r["score"],
                                              r["tier"] == "T1", -r["published_at"]))
        others = [m["id"] for m in members if m is not primary]
        ph = ",".join("?" * len(others))
        # 被合并条目自己的重复报道也一起挂到新主条目下
        db.execute(f"UPDATE news_items SET cluster_id = ? WHERE cluster_id IN ({ph})",
                   [primary["id"], *others])
        db.execute(f"UPDATE news_items SET status = 'dup' WHERE id IN ({ph})", others)
        db.execute("UPDATE news_items SET source_count = source_count + ? WHERE id = ?",
                   [sum(by_id[o]["source_count"] or 1 for o in others), primary["id"]])
        merged += len(others)
    return {"candidates": len(rows), "groups": len(groups), "merged": merged}


def _mark_failed(db: Database, ids) -> None:
    ids = list(ids)
    db.execute(
        f"UPDATE news_items SET status = 'llm_failed', llm_attempts = llm_attempts + 1 "
        f"WHERE id IN ({','.join('?' * len(ids))})",
        ids,
    )


# ---------------- 即时推送 ----------------

def format_item(r: dict, group_names: dict[str, str] | None = None, now: int | None = None) -> str:
    now = int(time.time()) if now is None else now
    lines = [
        f"🔥 <b>{r['score']:g}</b> · {esc(r.get('category') or '')}",
        f"<b><a href=\"{esc(r['url'])}\">{esc(r['title'])}</a></b>",
    ]
    if r.get("summary_zh"):
        lines.append(esc(r["summary_zh"]))
    if r.get("reason"):
        lines.append(f"💡 {esc(r['reason'])}")
    meta = [esc(r.get("source") or "")]
    if (r.get("source_count") or 1) > 1:
        meta.append(f"{r['source_count']} 个来源报道")
    meta.append(_ago(now - int(r["published_at"])))
    lines.append("📰 " + " · ".join(m for m in meta if m))
    return "\n".join(lines)


def _ago(seconds: int) -> str:
    if seconds < 3600:
        return f"{max(1, seconds // 60)} 分钟前"
    if seconds < 86400:
        return f"{seconds // 3600} 小时前"
    return f"{seconds // 86400} 天前"


def push_instant(db: Database, tg: Telegram, settings: Settings, now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    rows = db.query(
        "SELECT id, url, title, source, source_count, score, category, summary_zh, reason, published_at "
        "FROM news_items WHERE status = 'scored' AND score >= ? AND pushed_at IS NULL "
        "AND published_at >= ? ORDER BY score DESC, source_count DESC, published_at DESC LIMIT ?",
        [settings.push_threshold, now - settings.push_max_age_hours * 3600, settings.push_max_per_run],
    )
    pushed = 0
    for r in rows:
        if tg.send(format_item(r, now=now)):
            db.execute("UPDATE news_items SET pushed_at = ? WHERE id = ?", [now, r["id"]])
            pushed += 1
    return {"pushed": pushed}
