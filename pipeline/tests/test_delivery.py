"""推送节奏：分级推送（≥8.5 单独推，其余攒成快讯合集）、免打扰时段、24 小时后自动清理。"""
from datetime import datetime

import httpx

from nma.digest import MYT, maybe_send_digest
from nma.news.pipeline import (cleanup_messages, in_quiet_hours, ingest, push_bundle, push_instant,
                               push_watches, record_sent, score_pending)
from nma.telegram import Telegram

from test_pipeline import NOW, FakeLLM, FakeTG, env, make_item  # noqa: F401  (env 是 fixture)


def at(h, m=0, day=13):
    return int(datetime(2026, 11, day, h, m, tzinfo=MYT).timestamp())


def _scored(db, s, rules, scores, now=NOW, age_h=1):
    items = [make_item(f"https://x.com/{i}", t, age_h=age_h) for i, t in enumerate(scores)]
    ingest(db, items, s, rules, now=now)
    score_pending(db, FakeLLM(scores=scores), s, now=now)


def _digest_sent(db, date="2026-11-13"):
    db.execute("INSERT INTO digests (date, content_md, created_at, sent_at) VALUES (?, '', 0, 1)", [date])


def test_quiet_hours(env):
    s, _, _ = env
    assert in_quiet_hours(at(23, 30), s) and in_quiet_hours(at(3), s)
    assert not in_quiet_hours(at(8), s) and not in_quiet_hours(at(22, 59), s)
    s.quiet_hours = "off"
    assert not in_quiet_hours(at(3), s)
    s.quiet_hours = "1-6"                                               # 不跨午夜的写法
    assert in_quiet_hours(at(3), s) and not in_quiet_hours(at(7), s)


def test_instant_only_for_high_and_fresh(env):
    s, db, rules = env
    _scored(db, s, rules, {"Major cloud region outage today": 9, "Solid but routine release notes": 7.5})
    tg = FakeTG()
    assert push_instant(db, tg, s, now=NOW)["pushed"] == 1                # 只有 9 分的单独推
    assert "x.com/0" in tg.messages[0]
    # 4 小时后才轮到推送的高分条目（比如打分积压）不算即时，交给合集
    _scored(db, s, rules, {"Another very big headline here": 9}, now=NOW)
    assert push_instant(db, FakeTG(), s, now=NOW + 4 * 3600)["pushed"] == 0


def test_quiet_hours_only_push_top_scores(env):
    s, db, rules = env
    night = at(2)
    _scored(db, s, rules, {"Huge breaking world event now": 9.6, "Important but can wait till morning": 9},
            now=night)
    tg = FakeTG()
    st = push_instant(db, tg, s, now=night)
    assert st == {"pushed": 1, "quiet": True} and "x.com/0" in tg.messages[0]
    assert push_watches(db, tg, s, now=night) == {"watches": "quiet"}
    assert push_bundle(db, tg, s, now=night) == {"bundle": "quiet"}


def test_bundle_collects_mid_scores_every_3h(env):
    s, db, rules = env
    _digest_sent(db)
    _scored(db, s, rules, {"Mid score news one headline": 7.5, "Mid score news two headline": 8,
                           "Low score filler headline here": 5})
    tg = FakeTG()
    push_instant(db, tg, s, now=NOW)
    assert push_bundle(db, tg, s, now=NOW) == {"bundle": 2}
    msg = tg.messages[-1]
    assert msg.startswith("📋 <b>快讯合集</b> · 2 条") and msg.index("x.com/1") < msg.index("x.com/0")  # 按分数排
    assert "x.com/2" not in msg
    assert db.query("SELECT COUNT(*) AS n FROM news_items WHERE pushed_at IS NOT NULL")[0]["n"] == 2

    later = make_item("https://y.com/later", "Penang chip plant expansion approved", age_h=0)
    ingest(db, [later], s, rules, now=NOW + 3600)
    score_pending(db, FakeLLM(scores={"Penang chip plant expansion approved": 7.2}), s, now=NOW + 3600)
    assert push_bundle(db, tg, s, now=NOW + 3600) == {"bundle": "not_yet"}
    assert push_bundle(db, tg, s, now=NOW + 3 * 3600 - 300) == {"bundle": 1}   # 3 小时（容许 10 分钟抖动）


def test_bundle_caps_items_and_marks_all(env):
    s, db, rules = env
    _digest_sent(db)
    s.bundle_max_items = 2
    titles = ["Bank Negara holds overnight policy rate", "Grab posts first quarterly profit",
              "Johor rail link testing begins soon", "Petronas signs LNG supply deal"]   # 标题要够不同，免得被 SimHash 判重
    _scored(db, s, rules, {t: 7 + i / 10 for i, t in enumerate(titles)})
    tg = FakeTG()
    assert push_bundle(db, tg, s, now=NOW) == {"bundle": 4}
    assert "· 4 条" in tg.messages[0] and "另有 2 条" in tg.messages[0]
    assert db.query("SELECT COUNT(*) AS n FROM news_items WHERE pushed_at IS NULL AND status = 'scored'")[0]["n"] == 0


def test_morning_bundle_waits_for_digest_and_skips_digest_items(env):
    s, db, rules = env
    night = at(3)
    _scored(db, s, rules, {"Overnight top story headline": 8, "Overnight minor story headline": 7.2}, now=night)
    s.digest_top_n = 1
    tg = FakeTG()
    morning = at(8, 7)
    assert push_bundle(db, tg, s, now=morning) == {"bundle": "wait_digest"}
    assert maybe_send_digest(db, tg, s, now=morning)["digest"] == "sent"   # 日报 Top 1 标记为已推送
    assert push_bundle(db, tg, s, now=at(8, 37)) == {"bundle": 1}
    assert "x.com/1" in tg.messages[-1] and "x.com/0" not in tg.messages[-1]


def test_cleanup_deletes_old_pushes_but_keeps_ones_with_feedback(env):
    s, db, rules = env
    _scored(db, s, rules, {"First pushed headline here": 9, "Second pushed headline here": 9})
    ids = {r["url"]: r["id"] for r in db.query("SELECT id, url FROM news_items")}
    t0 = NOW - 25 * 3600
    record_sent(db, [11], ids["https://x.com/0"], "push", t0)
    record_sent(db, [12], ids["https://x.com/1"], "push", t0)
    record_sent(db, [13], None, "bundle", t0)
    record_sent(db, [14], None, "bundle", NOW - 50 * 3600)                # 超过 48 小时，删不了
    record_sent(db, [15], None, "bundle", NOW - 3600)                     # 还不到 24 小时
    record_sent(db, [-1], None, "bundle", t0)                             # dry-run 的占位 id 不记
    db.execute("INSERT INTO feedback (item_id, saved_at, updated_at) VALUES (?, ?, ?)", [ids["https://x.com/1"], NOW, NOW])

    tg = FakeTG()
    assert cleanup_messages(db, tg, s, now=NOW) == {"deleted": 2, "kept": 2}
    assert sorted(tg.deleted) == [11, 13]
    assert [r["message_id"] for r in db.query("SELECT message_id FROM sent_messages")] == [15]
    s.cleanup_after_hours = 0
    assert cleanup_messages(db, tg, s, now=NOW + 86400) == {}


def test_push_records_message_ids(env):
    s, db, rules = env
    _scored(db, s, rules, {"Big news headline right here": 9})
    push_instant(db, FakeTG(), s, now=NOW)
    assert db.query("SELECT message_id, kind FROM sent_messages") == [{"message_id": 1001, "kind": "push"}]


def test_telegram_client_returns_ids_and_deletes():
    seen = []

    def handler(req: httpx.Request):
        seen.append((req.url.path.rsplit("/", 1)[-1], req.content))
        if req.url.path.endswith("/sendMessage"):
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 77}})
        return httpx.Response(200, json={"ok": True, "result": True})

    tg = Telegram("T", "123")
    tg.client = httpx.Client(transport=httpx.MockTransport(handler))
    assert tg.send("hi") and tg.last_message_ids == [77]
    assert tg.delete_messages(list(range(150)))
    assert [p for p, _ in seen] == ["sendMessage", "deleteMessages", "deleteMessages"]   # 每次最多 100 个


# ---------------- 手动 /run ----------------

def test_manual_run_ignores_quiet_hours_and_bundle_interval(env):
    s, db, rules = env
    night = at(2)
    _digest_sent(db)
    _scored(db, s, rules, {"Mid score overnight headline": 7.6}, now=night)
    db.execute("INSERT INTO app_state (key, value, updated_at) VALUES ('bundle_last', ?, 0)", [str(night - 600)])
    tg = FakeTG()
    assert push_bundle(db, tg, s, now=night) == {"bundle": "quiet"}
    s.manual_run = True
    assert push_bundle(db, tg, s, now=night) == {"bundle": 1}           # 刚发过合集也立即结算
    assert "x.com/0" in tg.messages[-1]


def test_run_report(env):
    from nma.report import format_run_report
    s, _, _ = env
    s.push_threshold = 7.5
    base = {"fetch": {"sources": 43, "new": 12, "failed_sources": []},
            "score": {"candidates": 12, "scored": 12, "pushable": 0}}
    empty = format_run_report({**base, "push": {"deleted": 0, "pushed": 0, "watches": 0, "bundle": 0}}, [], 41.6, s)
    assert empty.startswith("✅ <b>流水线跑完</b> · 42 秒")
    assert "新增 12 条" in empty and "≥7.5 分 0 条" in empty
    assert "没有新的够推送标准的新闻" in empty and "≥8.5 分且 3 小时内" in empty

    busy = format_run_report({**base, "push": {"pushed": 1, "watch_pushed": 2, "bundle": 4, "deleted": 3},
                              "digest": {"digest": "sent"}}, [], 60, s)
    assert "单独 1 条 · 盯梢 2 条 · 快讯合集 4 条" in busy and "删掉 3 条" in busy and "日报已发送" in busy
    assert "没有新的" not in busy

    failed = format_run_report({"fetch": {"sources": 43, "new": 0, "failed_sources": ["A: timeout"]}},
                               ["score: LLMError: boom\ntrace"], 5, s)
    assert failed.startswith("⚠️") and "1 个源失败" in failed and "出错的阶段：score" in failed
