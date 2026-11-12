"""LLMClient：重试、备用模型切换、去掉不支持的参数。用 httpx.MockTransport，不发真实请求。"""
import json

import httpx
import pytest

from nma.llm import LLMClient, LLMError


def ok(content="{}"):
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}],
                                     "usage": {"prompt_tokens": 3, "completion_tokens": 2}})


def make(handler, **kw):
    seen = []

    def wrapped(request):
        body = json.loads(request.content)
        seen.append(body)
        return handler(body, len(seen))

    c = LLMClient("https://x/v1/", "k", kw.pop("model", "m1"), transport=httpx.MockTransport(wrapped),
                  backoff=0, **kw)
    return c, seen


def test_success_counts_usage():
    c, seen = make(lambda b, n: ok('{"items": []}'))
    assert c.chat([{"role": "user", "content": "hi"}]) == '{"items": []}'
    assert c.usage.calls == 1 and c.usage.prompt_tokens == 3
    assert seen[0]["response_format"] == {"type": "json_object"}


def test_retry_then_success():
    c, seen = make(lambda b, n: httpx.Response(503) if n < 3 else ok("x"))
    assert c.chat([]) == "x" and len(seen) == 3 and c.model == "m1"


def test_fallback_to_next_model_and_stick():
    c, seen = make(lambda b, n: httpx.Response(503) if b["model"] == "m1" else ok(b["model"]),
                   fallback_models=["m2", "m3"])
    assert c.chat([]) == "m2"
    assert c.chat([]) == "m2"                      # 本次运行内继续用 m2
    assert [b["model"] for b in seen] == ["m1", "m1", "m1", "m2", "m2"]


def test_404_switches_model_immediately():
    c, seen = make(lambda b, n: httpx.Response(404) if b["model"] == "m1" else ok("y"),
                   fallback_models=["m2"])
    assert c.chat([]) == "y" and len(seen) == 2


def test_all_models_down_raises():
    c, _ = make(lambda b, n: httpx.Response(503), fallback_models=["m2"])
    with pytest.raises(LLMError, match="所有模型都不可用"):
        c.chat([])


def test_400_drops_unsupported_params():
    def handler(b, n):
        if "reasoning_effort" in b or "response_format" in b:
            return httpx.Response(400, json={"error": "invalid argument"})
        return ok("plain")
    c, seen = make(handler, reasoning_effort="low")
    assert c.chat([]) == "plain"
    assert len(seen) == 3 and c.reasoning_effort == "" and c.json_mode is False
    c.chat([])
    assert len(seen) == 4                          # 之后不再传这两个参数


def test_other_4xx_raises():
    c, _ = make(lambda b, n: httpx.Response(401, text="bad key"), json_mode=False)
    with pytest.raises(LLMError, match="401"):
        c.chat([])
