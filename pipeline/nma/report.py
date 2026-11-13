"""手动 /run 跑完后发给用户的结果回报：没有可推送的新闻也要说一声，不让人干等。"""
from __future__ import annotations

from .settings import Settings
from .telegram import esc


def format_run_report(stats: dict, errors: list[str], seconds: float, settings: Settings) -> str:
    lines = [("⚠️" if errors else "✅") + f" <b>流水线跑完</b> · {round(seconds)} 秒"]

    f = stats.get("fetch") or {}
    if f:
        failed = len(f.get("failed_sources") or [])
        lines.append(f"• 抓取：{f.get('sources', 0)} 个源，新增 {f.get('new', 0)} 条"
                     + (f"，{failed} 个源失败" if failed else ""))

    sc = stats.get("score") or {}
    if "scored" in sc or "candidates" in sc:
        lines.append(f"• 打分：{sc.get('scored', 0)} 条，其中 ≥{settings.push_threshold:g} 分 {sc.get('pushable', 0)} 条")

    p = stats.get("push") or {}
    if p:
        bundle = p.get("bundle")
        parts = []
        if p.get("pushed"):
            parts.append(f"单独 {p['pushed']} 条")
        if p.get("watch_pushed"):
            parts.append(f"盯梢 {p['watch_pushed']} 条")
        if isinstance(bundle, int) and bundle:
            parts.append(f"快讯合集 {bundle} 条")
        if parts:
            lines.append("• 推送：" + " · ".join(parts))
        else:
            lines.append("• 推送：这次没有新的够推送标准的新闻")
            lines.append(f"  <i>单独推送要 ≥{settings.push_instant_min:g} 分且 {settings.push_fresh_hours} 小时内抓到；"
                         f"合集收 ≥{settings.push_threshold:g} 分、{settings.push_max_age_hours} 小时内发布的</i>")
        if bundle == "wait_digest":
            lines.append("  <i>合集等今天的日报发出后再发</i>")
        if p.get("deleted"):
            lines.append(f"• 清理：删掉 {p['deleted']} 条 {settings.cleanup_after_hours} 小时前的推送")

    if (stats.get("digest") or {}).get("digest") == "sent":
        lines.append("• 日报已发送")
    if (stats.get("weekly") or {}).get("weekly") == "sent":
        lines.append("• 周报已发送")
    if errors:
        failed_stages = "、".join(esc(e.split(":", 1)[0]) for e in errors)
        lines.append(f"• 出错的阶段：{failed_stages}（详情见上面的告警）")
    return "\n".join(lines)
