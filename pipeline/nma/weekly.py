"""周报：本周 5 件大事 + 趋势判断（一次 LLM 调用）+ 分类热度对比 + 大马科技招聘雷达。

每次运行检查「最近一个周日 20:00 MYT 已过、24 小时内、还没发过」才发；错过 24 小时就跳过这一周，
免得周三突然收到上周的周报。
"""
from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Callable

from .db import Database
from .digest import MYT
from .llm import LLMClient, LLMError, _balanced_spans, _try_load, _FENCE_RE, truncate
from .settings import Settings, load_prompt
from .telegram import Telegram, esc

log = logging.getLogger(__name__)

JOB_LABELS = {"hiring": "扩张 / 招聘", "layoff": "裁员", "investment": "新投资"}
MAX_EVENT_INPUT = 40


def weekly_slot(now: int, settings: Settings) -> datetime:
    """最近一个已经到点的「周日 20:00 MYT」（星期几和钟点可配置）。"""
    local = datetime.fromtimestamp(now, MYT)
    days_back = (local.weekday() - settings.weekly_weekday) % 7
    slot = (local - timedelta(days=days_back)).replace(hour=settings.weekly_hour_myt, minute=0, second=0, microsecond=0)
    if slot > local:
        slot -= timedelta(days=7)
    return slot


def maybe_send_weekly(db: Database, tg: Telegram, settings: Settings, get_llm: Callable[[], LLMClient],
                      now: int | None = None, force: bool = False) -> dict:
    now = int(time.time()) if now is None else now
    slot = weekly_slot(now, settings)
    if not force and now - int(slot.timestamp()) > 24 * 3600:
        return {"weekly": "not_due"}
    key = f"weekly:{slot.date().isoformat()}"
    existing = db.query("SELECT sent_at FROM reports WHERE key = ?", [key])
    if existing and existing[0]["sent_at"] and not force:
        return {"weekly": "already_sent"}

    content, st = build_weekly(db, get_llm, now)
    db.execute(
        "INSERT INTO reports (key, content, created_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET content = excluded.content, created_at = excluded.created_at",
        [key, content, now],
    )
    if tg.send(content):
        db.execute("UPDATE reports SET sent_at = ? WHERE key = ?", [now, key])
        return {"weekly": "sent", **st}
    return {"weekly": "send_failed", **st}


def build_weekly(db: Database, get_llm: Callable[[], LLMClient] | None, now: int) -> tuple[str, dict]:
    week_start, prev_start = now - 7 * 86400, now - 14 * 86400
    d0 = datetime.fromtimestamp(week_start, MYT).strftime("%m/%d")
    d1 = datetime.fromtimestamp(now, MYT).strftime("%m/%d")
    lines = [f"📅 <b>本周回顾 · {d0} – {d1}</b>", ""]
    st: dict = {}

    # 1) 5 件大事 + 趋势
    rows = db.query(
        "SELECT id, url, title, source, source_count, score, summary_zh, published_at FROM news_items "
        "WHERE status = 'scored' AND score >= 7 AND published_at >= ? "
        "ORDER BY score DESC, source_count DESC, published_at DESC LIMIT ?",
        [week_start, MAX_EVENT_INPUT],
    )
    events, trend = [], ""
    if rows and get_llm is not None:  # 本周没有 ≥7 分的就不创建 LLM 客户端
        try:
            events, trend = _llm_events(get_llm(), rows)
        except LLMError as e:
            log.warning("周报 LLM 调用失败: %s", e)
            st["llm_error"] = True
    if rows and not events:  # LLM 失败或输出无法解析：按分数取前 5，不写趋势
        events = [{"ids": [r["id"]], "title": r["title"], "summary": r["summary_zh"] or ""} for r in rows[:5]]
    by_id = {r["id"]: r for r in rows}
    if events:
        lines.append(f"<b>🏆 本周 {len(events)} 件大事</b>")
        for i, ev in enumerate(events, 1):
            members = [by_id[x] for x in ev["ids"]]
            lead = max(members, key=lambda r: (r["score"], r["source_count"] or 1))
            n_src = sum(r["source_count"] or 1 for r in members)
            extra = f"（{n_src} 个来源）" if n_src > 1 else ""
            lines.append(f"{i}. <b><a href=\"{esc(lead['url'])}\">{esc(ev['title'])}</a></b>")
            if ev["summary"]:
                lines.append(f"    {esc(ev['summary'])}{extra}")
    else:
        lines.append("本周没有 ≥7 分的新闻。")
    if trend:
        lines += ["", "<b>📈 趋势</b>", esc(trend)]
    st["events"] = len(events)

    # 2) 分类热度：本周 vs 上周（≥5 分的主条目）
    cats = db.query(
        "SELECT category, SUM(CASE WHEN published_at >= ? THEN 1 ELSE 0 END) AS cur, "
        "SUM(CASE WHEN published_at < ? THEN 1 ELSE 0 END) AS prev FROM news_items "
        "WHERE status = 'scored' AND score >= 5 AND published_at >= ? GROUP BY category",
        [week_start, week_start, prev_start],
    )
    cats = [c for c in cats if (c["cur"] or 0) > 0]
    if cats:
        lines += ["", "<b>📊 分类热度</b>（≥5 分，和上周比）"]
        for c in sorted(cats, key=lambda c: -(c["cur"] or 0)):
            lines.append(f"• {esc(c['category'] or '其他')} {c['cur']} 条 {trend_label(c['cur'] or 0, c['prev'] or 0)}")

    # 3) 大马科技招聘雷达
    radar = jobs_radar(db, week_start)
    st["jobs"] = sum(len(v) for v in radar.values())
    lines += ["", "<b>💼 大马科技招聘雷达</b>"]
    if radar:
        for action in ("hiring", "layoff", "investment"):
            if radar.get(action):
                lines.append(f"• <b>{JOB_LABELS[action]}</b>：" + "、".join(radar[action]))
    else:
        lines.append("本周没有抓到大马科技公司招聘、裁员或投资的新闻。")
    return "\n".join(lines), st


def trend_label(cur: int, prev: int) -> str:
    """样本太少时百分比没有意义（2 → 3 是 +50%），只给上周条数。"""
    if prev < 5 or cur < 5:
        return f"（上周 {prev}）"
    pct = round((cur - prev) / prev * 100)
    if abs(pct) < 10:
        return "→ 持平"
    return f"↑{pct}%" if pct > 0 else f"↓{-pct}%"


def jobs_radar(db: Database, since: int, per_action: int = 8) -> dict[str, list[str]]:
    """按 action 分组、按公司去重（同一家公司本周多条报道只列一次，链接取分数最高的那条）。"""
    rows = db.query(
        "SELECT url, jobs, score FROM news_items WHERE jobs IS NOT NULL AND status IN ('scored', 'dup') "
        "AND published_at >= ? ORDER BY score DESC LIMIT 200",
        [since],
    )
    seen: dict[str, dict[str, dict]] = defaultdict(dict)
    for r in rows:
        try:
            j = json.loads(r["jobs"])
        except (TypeError, ValueError):
            continue
        action, company = j.get("action"), str(j.get("company") or "").strip()
        if action not in JOB_LABELS or not company:
            continue
        entry = seen[action].setdefault(company.lower(), {"company": company, "url": r["url"], "details": []})
        for k in ("location", "scale"):
            if j.get(k) and j[k] not in entry["details"]:
                entry["details"].append(j[k])
    out: dict[str, list[str]] = {}
    for action, entries in seen.items():
        out[action] = [
            f"<a href=\"{esc(e['url'])}\">{esc(e['company'])}</a>"
            + (f"（{esc('，'.join(e['details'][:3]))}）" if e["details"] else "")
            for e in list(entries.values())[:per_action]
        ]
    return out


def _llm_events(llm: LLMClient, rows: list[dict]) -> tuple[list[dict], str]:
    payload = [
        {
            "id": r["id"],
            "title": r["title"],
            "summary": r["summary_zh"],
            "score": r["score"],
            "sources": r["source_count"] or 1,
            "date": datetime.fromtimestamp(r["published_at"], MYT).strftime("%m-%d"),
        }
        for r in rows
    ]
    prompt = load_prompt("weekly.md").replace("{{items}}", json.dumps(payload, ensure_ascii=False, indent=1))
    return parse_weekly(llm.chat([{"role": "user", "content": prompt}]), {r["id"] for r in rows})


def parse_weekly(text: str, valid_ids: set[int]) -> tuple[list[dict], str]:
    """解析 {"events": [...], "trend": "..."}；id 不在输入里的丢掉，保证链接都是真实条目。"""
    data = None
    for cand in [text or "", *_FENCE_RE.findall(text or "")]:
        data = _try_load(cand.strip())
        if not isinstance(data, dict):
            data = next((d for d in map(_try_load, _balanced_spans(cand, "{", "}"))
                         if isinstance(d, dict) and "events" in d), None)
        if isinstance(data, dict) and "events" in data:
            break
    if not isinstance(data, dict):
        return [], ""
    events, used = [], set()
    for ev in data.get("events") or []:
        if not isinstance(ev, dict):
            continue
        ids = []
        for x in ev.get("ids") or []:
            try:
                i = int(x)
            except (TypeError, ValueError):
                continue
            if i in valid_ids and i not in used:
                ids.append(i)
                used.add(i)
        title = truncate(ev.get("title"), 40)
        if ids and title:
            events.append({"ids": ids, "title": title, "summary": truncate(ev.get("summary"), 120)})
        if len(events) == 5:
            break
    return events, truncate(data.get("trend"), 300)
