"""OpenAI 兼容的 Chat Completions 客户端 + LLM JSON 容错解析。"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    pass


@dataclass
class LLMUsage:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0


class LLMClient:
    def __init__(
        self, base_url: str, api_key: str, model: str,
        reasoning_effort: str = "", json_mode: bool = True,
        timeout: float = 90.0, retries: int = 3, fallback_models: list[str] | None = None,
        transport: httpx.BaseTransport | None = None, backoff: float = 1.0,
    ):
        if not api_key:
            raise LLMError("缺少 LLM_API_KEY")
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.models = [model, *[m for m in (fallback_models or []) if m and m != model]]
        self.model_idx = 0
        self.reasoning_effort = reasoning_effort
        self.json_mode = json_mode
        self.retries = retries
        self.usage = LLMUsage()
        self.backoff = backoff  # 测试里设 0，跳过等待
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout, transport=transport
        )

    @property
    def model(self) -> str:
        return self.models[self.model_idx]

    def chat(self, messages: list[dict], temperature: float = 0.2) -> str:
        """主模型过载（429/5xx/超时重试用尽）或不存在（404）时，切到下一个备用模型，
        并在本次运行内一直用它。"""
        errors = []
        while True:
            try:
                return self._chat_once(self.model, messages, temperature)
            except _ModelUnavailable as e:
                errors.append(f"{self.model}: {e}")
                if self.model_idx + 1 >= len(self.models):
                    raise LLMError("所有模型都不可用 | " + " | ".join(errors)) from None
                self.model_idx += 1
                log.warning("切换到备用模型 %s", self.model)

    def _chat_once(self, model: str, messages: list[dict], temperature: float) -> str:
        body: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature}
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort

        last: Exception | str | None = None
        failures = 0  # 网络错误 / 429 / 5xx 的次数，到 self.retries 就换模型
        while failures < self.retries:
            try:
                r = self.client.post(self.url, json=body)
            except httpx.HTTPError as e:
                last = e
                failures += 1
                time.sleep(self.backoff * 2 ** failures)
                continue
            if r.status_code == 404:
                raise _ModelUnavailable("HTTP 404（模型不存在）")
            if r.status_code == 429 or r.status_code >= 500:
                last = f"HTTP {r.status_code}"
                failures += 1
                retry_after = r.headers.get("retry-after")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else 5 * 2 ** (failures - 1)
                time.sleep(self.backoff * min(wait, 30))
                continue
            if r.status_code == 400 and ("reasoning_effort" in body or "response_format" in body):
                # 有的模型 / 服务商不支持这两个参数：依次去掉再试，并记住，后续调用不再传
                dropped = "reasoning_effort" if "reasoning_effort" in body else "response_format"
                log.warning("LLM 返回 400，去掉参数 %s 后重试", dropped)
                body.pop(dropped)
                if dropped == "reasoning_effort":
                    self.reasoning_effort = ""
                else:
                    self.json_mode = False
                continue
            if r.status_code >= 400:
                raise LLMError(f"LLM HTTP {r.status_code}: {r.text[:300]}")
            data = r.json()
            u = data.get("usage") or {}
            self.usage.calls += 1
            self.usage.prompt_tokens += int(u.get("prompt_tokens") or 0)
            self.usage.completion_tokens += int(u.get("completion_tokens") or 0)
            try:
                return data["choices"][0]["message"]["content"] or ""
            except (KeyError, IndexError, TypeError) as e:
                raise LLMError(f"LLM 响应格式异常: {str(data)[:300]}") from e
        raise _ModelUnavailable(f"重试 {self.retries} 次仍失败: {last}")

    def close(self) -> None:
        self.client.close()


class _ModelUnavailable(Exception):
    pass


# ---------------- JSON 容错解析 ----------------

_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.DOTALL)
_TRAILING_COMMA_RE = re.compile(r",\s*([\]}])")


def _try_load(s: str) -> Any:
    try:
        return json.loads(s)
    except (json.JSONDecodeError, ValueError):
        pass
    try:
        return json.loads(_TRAILING_COMMA_RE.sub(r"\1", s))
    except (json.JSONDecodeError, ValueError):
        return None


def _balanced_spans(s: str, open_ch: str, close_ch: str) -> list[str]:
    """找出所有顶层的平衡括号片段（忽略字符串里的括号）。"""
    spans, depth, start, in_str, esc = [], 0, -1, False, False
    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == open_ch:
            if depth == 0:
                start = i
            depth += 1
        elif ch == close_ch and depth > 0:
            depth -= 1
            if depth == 0:
                spans.append(s[start : i + 1])
    return spans


def extract_json_items(text: str) -> list[dict]:
    """从 LLM 输出里尽量抢救出条目列表。

    依次尝试：整体解析 → 去 ``` 包裹 → 截取最外层 {...} / [...] → 逐个对象解析。
    支持 {"items": [...]}、[...]、单个对象三种形态。完全失败返回 []，不抛异常。
    """
    if not text or not text.strip():
        return []
    candidates = [text.strip()]
    candidates += [m.strip() for m in _FENCE_RE.findall(text)]

    for cand in candidates:
        items = _as_items(_try_load(cand))
        if items:
            return items
        # 前后夹杂了说明文字：在所有平衡片段里取能解析出最多条目的那个
        best: list[dict] = []
        for span in _balanced_spans(cand, "[", "]") + _balanced_spans(cand, "{", "}"):
            items = _as_items(_try_load(span))
            if len(items) > len(best):
                best = items
        if best:
            return best

    # 最后手段：逐个解析能解析的对象（比如输出被截断时，前面完整的条目还能用）
    rescued = []
    for cand in candidates:
        inner = cand
        m = re.search(r"\[", cand)
        if m:
            inner = cand[m.start() + 1 :]
        for span in _balanced_spans(inner, "{", "}"):
            obj = _try_load(span)
            if isinstance(obj, dict):
                rescued.append(obj)
        if rescued:
            break
    return rescued


def extract_groups(text: str, valid_ids: set[int]) -> list[list[int]]:
    """解析事件分组 {"groups": [[1, 2], [3, 4, 5]]}。非法 id、重复 id、少于 2 条的组都丢掉。"""
    data = None
    for cand in [text or "", *_FENCE_RE.findall(text or "")]:
        data = _try_load(cand.strip())
        if data is None:
            for span in _balanced_spans(cand, "{", "}"):
                data = _try_load(span)
                if isinstance(data, dict) and "groups" in data:
                    break
        if isinstance(data, dict) and "groups" in data:
            break
    raw = data.get("groups") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return []
    used: set[int] = set()
    out: list[list[int]] = []
    for g in raw:
        if not isinstance(g, list):
            continue
        ids = []
        for x in g:
            try:
                i = int(x)
            except (TypeError, ValueError):
                continue
            if i in valid_ids and i not in used and i not in ids:
                ids.append(i)
        if len(ids) >= 2:
            used.update(ids)
            out.append(ids)
    return out


def _as_items(data: Any) -> list[dict]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("items", "results", "data", "news"):
            if isinstance(data.get(key), list):
                return [x for x in data[key] if isinstance(x, dict)]
        if "id" in data:
            return [data]
    return []


def truncate(s: Any, n: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[:n].rstrip() + "…"


def validate_scores(
    items: list[dict], expected_ids: set[int], categories: list[str], fallback_category: dict[int, str]
) -> dict[int, dict]:
    """校验 LLM 返回的打分条目，丢弃不合格的。返回 id -> 规范化后的结果。"""
    out: dict[int, dict] = {}
    cats = set(categories)
    for it in items:
        try:
            iid = int(str(it.get("id")).strip())
        except (TypeError, ValueError):
            continue
        if iid not in expected_ids or iid in out:
            continue
        try:
            score = float(it.get("score"))
        except (TypeError, ValueError):
            continue
        if score != score:  # NaN
            continue
        score = max(0.0, min(10.0, round(score, 1)))
        cat = str(it.get("category") or "").strip()
        if cat not in cats:
            cat = fallback_category.get(iid, cat or "其他")
        summary = truncate(it.get("summary_zh"), 60)
        if not summary:
            continue
        out[iid] = {
            "score": score,
            "category": cat,
            "summary_zh": summary,
            "reason": truncate(it.get("reason"), 30),
            "jobs": validate_jobs(it.get("jobs")),
        }
    return out


JOB_ACTIONS = ("hiring", "layoff", "investment")


def validate_jobs(v: Any) -> dict | None:
    """打分时顺带抽取的大马科技招聘信息：{company, action, scale, location}。不合格返回 None。"""
    if not isinstance(v, dict):
        return None
    company = truncate(v.get("company"), 40)
    action = str(v.get("action") or "").strip().lower()
    if not company or action not in JOB_ACTIONS:
        return None
    out = {"company": company, "action": action}
    for key in ("scale", "location"):
        val = truncate(v.get(key), 30)
        if val and val.lower() not in ("null", "none", "n/a", "未知", "无"):
            out[key] = val
    return out
