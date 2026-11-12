"""每日日报：Top N + 分类汇总。每次运行检查"MYT 已过 08:00 且今天没发"才发。"""
from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from .db import Database
from .settings import Settings
from .telegram import Telegram, esc

MYT = timezone(timedelta(hours=8))


def myt_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, MYT).date().isoformat()


def build_digest(db: Database, settings: Settings, now: int) -> str:
    since = now - 24 * 3600
    date = myt_date(now)
    rows = db.query(
        "SELECT id, url, title, source, source_count, score, category, summary_zh "
        "FROM news_items WHERE status = 'scored' AND published_at >= ? "
        "ORDER BY score DESC, source_count DESC, published_at DESC LIMIT 300",
        [since],
    )
    counts = {
        r["status"]: r["n"]
        for r in db.query(
            "SELECT status, COUNT(*) AS n FROM news_items WHERE fetched_at >= ? GROUP BY status",
            [since],
        )
    }

    lines = [f"🗞 <b>每日新闻简报 · {date}</b>", ""]
    top = rows[: settings.digest_top_n]
    if not top:
        lines.append("过去 24 小时没有打过分的新闻。")
    else:
        lines.append(f"<b>🏆 Top {len(top)}</b>")
        for i, r in enumerate(top, 1):
            extra = f" · {r['source_count']} 个来源" if (r["source_count"] or 1) > 1 else ""
            lines.append(
                f"{i}. <b>{r['score']:g}</b> <a href=\"{esc(r['url'])}\">{esc(r['title'])}</a>"
            )
            lines.append(f"    {esc(r['summary_zh'] or '')}（{esc(r['source'])}{extra}）")

    # 分类汇总：每类 ≥5 分的条数，加上 Top N 之外的 2 条代表
    top_ids = {r["id"] for r in top}
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["score"] >= 5:
            by_cat[r["category"] or "其他"].append(r)
    if by_cat:
        lines += ["", "<b>📂 分类汇总</b>（≥5 分）"]
        for cat, items in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
            lines.append(f"• <b>{esc(cat)}</b> {len(items)} 条")
            for r in [x for x in items if x["id"] not in top_ids][:2]:
                lines.append(f"    - <a href=\"{esc(r['url'])}\">{esc(r['summary_zh'] or r['title'])}</a>")

    total = sum(counts.values())
    lines += [
        "",
        f"<i>24h 新入库 {total} 条：打分 {counts.get('scored', 0)}，"
        f"同事件合并 {counts.get('dup', 0)}，预筛过滤 {counts.get('filtered', 0)}，"
        f"待处理 {counts.get('pending', 0) + counts.get('llm_failed', 0)}</i>",
    ]
    return "\n".join(lines)


def maybe_send_digest(db: Database, tg: Telegram, settings: Settings,
                      now: int | None = None, force: bool = False) -> dict:
    now = int(time.time()) if now is None else now
    local = datetime.fromtimestamp(now, MYT)
    date = local.date().isoformat()
    if not force and local.hour < settings.digest_hour_myt:
        return {"digest": "not_yet"}
    existing = db.query("SELECT sent_at FROM digests WHERE date = ?", [date])
    if existing and existing[0]["sent_at"] and not force:
        return {"digest": "already_sent"}

    content = build_digest(db, settings, now)
    db.execute(
        "INSERT INTO digests (date, content_md, created_at) VALUES (?, ?, ?) "
        "ON CONFLICT(date) DO UPDATE SET content_md = excluded.content_md, created_at = excluded.created_at",
        [date, content, now],
    )
    if tg.send(content):
        db.execute("UPDATE digests SET sent_at = ? WHERE date = ?", [now, date])
        return {"digest": "sent"}
    return {"digest": "send_failed"}
