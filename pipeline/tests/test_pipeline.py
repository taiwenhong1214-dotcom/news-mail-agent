"""端到端：SQLite + 假 LLM + 假 Telegram，验证入库判重 → 预筛 → 打分 → 推送 → 日报。"""
import json
from datetime import datetime

import pytest

from nma.db import SQLiteDatabase
from nma.digest import MYT, maybe_send_digest
from nma.llm import LLMError
from nma.news import prefilter
from nma.news.fetch import Item
from nma.news.normalize import canonicalize_url, url_hash
from nma.news.pipeline import ingest, merge_events, push_instant, score_pending
from nma.news.simhash import simhash
from nma.settings import Settings

# 2026-11-13 10:00 MYT
NOW = int(datetime(2026, 11, 13, 10, 0, tzinfo=MYT).timestamp())


def make_item(url, title, summary="", group="devops", tier="T1", age_h=1, source="Src"):
    u = canonicalize_url(url)
    return Item(url=u, url_hash=url_hash(u), title=title, summary=summary, source=source,
                group=group, tier=tier, published_at=NOW - age_h * 3600,
                simhash=simhash(title, summary))


class FakeLLM:
    """按 id 返回固定分数；可以模拟坏 JSON 或调用失败。"""

    def __init__(self, mode="ok", scores=None, groups=None):
        self.mode, self.scores, self.calls = mode, scores or {}, 0
        self.groups = groups or []  # 事件合并：按标题分组

    def chat(self, messages, temperature=0.2):
        self.calls += 1
        if self.mode == "error":
            raise LLMError("boom")
        if self.mode == "garbage":
            return "抱歉，我不能输出 JSON"
        content = messages[0]["content"]
        if "## 新闻列表" in content:
            items = json.loads(content.split("## 新闻列表", 1)[1])
            by_title = {it["title"]: it["id"] for it in items}
            return json.dumps({"groups": [[by_title[t] for t in g if t in by_title] for g in self.groups]})
        items = json.loads(content.split("## 待评分新闻", 1)[1])
        out = [{"id": it["id"], "score": self.scores.get(it["title"], 5), "category": it["group"],
                "summary_zh": "摘要" + it["title"][:10], "reason": "理由"} for it in items]
        return "```json\n" + json.dumps({"items": out}, ensure_ascii=False) + "\n```"


class FakeTG:
    def __init__(self):
        self.messages = []

    def send(self, text, preview=False):
        self.messages.append(text)
        return True


@pytest.fixture
def env(tmp_path):
    s = Settings.from_env()
    s.db_backend = "sqlite"
    db = SQLiteDatabase(str(tmp_path / "t.db"))
    rules = prefilter.build_rules(s.filters_config)
    yield s, db, rules
    db.close()


def test_full_flow(env):
    s, db, rules = env
    items = [
        make_item("https://a.com/k8s?utm_source=rss", "Kubernetes 1.36 released with in-place pod resize GA"),
        make_item("http://www.a.com/k8s/", "Kubernetes 1.36 released with in-place pod resize GA"),  # 同 URL
        make_item("https://b.com/news/k8s", "Kubernetes 1.36 released with in-place pod resize GA!",
                  tier="T2", source="B"),                                                         # 近似重复
        make_item("https://c.com/ad", "Sponsored: the best CI tool you will ever buy"),           # 黑名单
        make_item("https://d.com/weather", "Kuala Lumpur weather sunny all week long", group="my-jobs"),  # 白名单不命中
        make_item("https://e.com/low", "Minor patch release of some small library", tier="T2"),
    ]
    st = ingest(db, items, s, rules, now=NOW)
    assert st["url_dup"] == 1 and st["near_dup"] == 1 and st["filtered"] == 2 and st["pending"] == 2

    rows = {r["url"]: r for r in db.query("SELECT * FROM news_items")}
    main = rows["https://a.com/k8s"]
    assert main["cluster_id"] == main["id"] and main["source_count"] == 2
    assert rows["https://b.com/news/k8s"]["cluster_id"] == main["id"]
    assert rows["https://b.com/news/k8s"]["status"] == "dup"
    assert rows["https://c.com/ad"]["filter_reason"] == "block:sponsored"

    # 第二次运行同样的条目：全部被 URL 判重
    st2 = ingest(db, items, s, rules, now=NOW)
    assert st2.get("new", 0) == 0

    llm = FakeLLM(scores={"Kubernetes 1.36 released with in-place pod resize GA": 8.5})
    st = score_pending(db, llm, s, now=NOW)
    assert st["scored"] == 2 and llm.calls == 1

    tg = FakeTG()
    assert push_instant(db, tg, s, now=NOW)["pushed"] == 1
    assert "2 个来源报道" in tg.messages[0] and "https://a.com/k8s" in tg.messages[0]
    assert push_instant(db, tg, s, now=NOW)["pushed"] == 0           # 不重复推送

    # 日报：10:00 MYT 已过 08:00 → 发送；再跑一次不重复
    assert maybe_send_digest(db, tg, s, now=NOW)["digest"] == "sent"
    assert "Top 2" in tg.messages[-1]
    assert maybe_send_digest(db, tg, s, now=NOW)["digest"] == "already_sent"
    early = int(datetime(2026, 11, 14, 7, 0, tzinfo=MYT).timestamp())
    assert maybe_send_digest(db, tg, s, now=early)["digest"] == "not_yet"

    # 全文检索可用（trigram）
    hits = db.query("SELECT rowid FROM news_fts WHERE news_fts MATCH ?", ["Kubernetes"])
    assert len(hits) >= 1


def test_bad_llm_json_degrades_and_retries(env):
    s, db, rules = env
    ingest(db, [make_item("https://x.com/1", "Some meaningful news headline here")], s, rules, now=NOW)

    st = score_pending(db, FakeLLM(mode="garbage"), s, now=NOW)       # 解析失败：不抛异常
    assert st["parse_failed"] == 1
    r = db.query("SELECT status, llm_attempts FROM news_items")[0]
    assert r["status"] == "llm_failed" and r["llm_attempts"] == 1

    score_pending(db, FakeLLM(mode="garbage"), s, now=NOW)
    score_pending(db, FakeLLM(mode="garbage"), s, now=NOW)
    llm = FakeLLM()
    assert score_pending(db, llm, s, now=NOW)["candidates"] == 0       # 超过 3 次放弃
    assert llm.calls == 0


def test_llm_call_errors_raise_for_alert(env):
    s, db, rules = env
    ingest(db, [make_item("https://x.com/1", "Some meaningful news headline here")], s, rules, now=NOW)
    with pytest.raises(LLMError):
        score_pending(db, FakeLLM(mode="error"), s, now=NOW)
    assert db.query("SELECT status FROM news_items")[0]["status"] == "llm_failed"


def test_old_high_score_not_pushed(env):
    s, db, rules = env
    ingest(db, [make_item("https://x.com/old", "Old but important headline about cloud", age_h=20)],
           s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={"Old but important headline about cloud": 9}), s, now=NOW)
    assert push_instant(db, FakeTG(), s, now=NOW)["pushed"] == 0   # 超过 12h 只进日报


def test_merge_events_keeps_pushed_primary(env):
    s, db, rules = env
    a, b, c = ("Nvidia CEO Jensen Huang resigns effective immediately",
               "Nvidia stock falls 10% after CEO departure news",
               "Kubernetes 1.36 released with in-place pod resize")
    ingest(db, [make_item("https://x.com/a", a, tier="T2"), make_item("https://x.com/b", b),
                make_item("https://x.com/b2", b + "!", source="Other"),    # b 的近似重复
                make_item("https://x.com/c", c)], s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={a: 9, b: 8, c: 7}), s, now=NOW)
    db.execute("UPDATE news_items SET pushed_at = ? WHERE url = 'https://x.com/a'", [NOW])

    st = merge_events(db, FakeLLM(groups=[[a, b]]), s, now=NOW)
    assert st["merged"] == 1
    rows = {r["url"]: r for r in db.query("SELECT * FROM news_items")}
    pa = rows["https://x.com/a"]
    assert pa["status"] == "scored" and pa["source_count"] == 3          # 已推送的 a 当主条目：1 + b(2)
    assert rows["https://x.com/b"]["status"] == "dup"
    assert rows["https://x.com/b"]["cluster_id"] == pa["id"]
    assert rows["https://x.com/b2"]["cluster_id"] == pa["id"]            # b 的重复也跟过来
    assert rows["https://x.com/c"]["status"] == "scored"
    tg = FakeTG()
    push_instant(db, tg, s, now=NOW)
    assert len(tg.messages) == 1 and "x.com/c" in tg.messages[0]         # b 不会再推


def test_merge_events_bad_output_is_noop(env):
    s, db, rules = env
    ingest(db, [make_item("https://x.com/a", "First important headline here"),
                make_item("https://x.com/b", "Second important headline there")], s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={}), s, now=NOW)
    db.execute("UPDATE news_items SET score = 8")

    class Garbage(FakeLLM):
        def chat(self, messages, temperature=0.2):
            return "我觉得都不一样"
    assert merge_events(db, Garbage(), s, now=NOW)["merged"] == 0
