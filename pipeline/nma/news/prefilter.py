"""不调用 LLM 的预筛：标题长度、黑名单、广告模式、分组白名单。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


def _keyword_pattern(words: list[str]) -> re.Pattern | None:
    """英文词按词首边界匹配（job 能匹配 jobs，但不会匹配 enjoy）；中文按子串匹配。"""
    parts = []
    for w in words:
        w = (w or "").strip().lower()
        if not w:
            continue
        esc = re.escape(w)
        parts.append(rf"\b{esc}" if w[0].isascii() and w[0].isalnum() else esc)
    if not parts:
        return None
    return re.compile("|".join(parts), re.IGNORECASE)


@dataclass
class FilterRules:
    min_len: int = 8
    max_len: int = 300
    block: re.Pattern | None = None
    ad_patterns: list[re.Pattern] = field(default_factory=list)
    require_any: dict[str, re.Pattern] = field(default_factory=dict)


def build_rules(cfg: dict, muted_words: list[str] = ()) -> FilterRules:
    title_cfg = cfg.get("title") or {}
    require = {}
    for group, words in (cfg.get("require_any") or {}).items():
        pat = _keyword_pattern(words or [])
        if pat:
            require[group] = pat
    return FilterRules(
        min_len=int(title_cfg.get("min_len", 8)),
        max_len=int(title_cfg.get("max_len", 300)),
        block=_keyword_pattern([*(cfg.get("block") or []), *muted_words]),
        ad_patterns=[re.compile(p) for p in (cfg.get("ad_patterns") or [])],
        require_any=require,
    )


def check(title: str, summary: str, group: str, rules: FilterRules) -> str | None:
    """返回过滤原因；None 表示放行。"""
    t = (title or "").strip()
    if len(t) < rules.min_len:
        return "title_too_short"
    if len(t) > rules.max_len:
        return "title_too_long"
    text = f"{t}\n{summary or ''}"
    if rules.block:
        m = rules.block.search(text)
        if m:
            return f"block:{m.group(0).lower()}"
    for p in rules.ad_patterns:
        if p.search(t):
            return "ad_pattern"
    req = rules.require_any.get(group)
    if req and not req.search(text):
        return "no_required_keyword"
    return None
