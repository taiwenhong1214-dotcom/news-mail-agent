"""v2 功能：反馈样本进打分 prompt、招聘字段、推送按钮、话题盯梢、周报。"""
import json
from datetime import datetime

from nma.digest import MYT
from nma.llm import validate_jobs
from nma.news.pipeline import (ingest, preference_section, push_instant, push_watches, score_pending,
                               watch_matches)
from nma.weekly import build_weekly, maybe_send_weekly, parse_weekly, trend_label, weekly_slot

from test_pipeline import NOW, FakeLLM, FakeTG, env, make_item  # noqa: F401  (env 是 fixture)


def _ids(db):
    return {r["title"]: r["id"] for r in db.query("SELECT id, title FROM news_items")}


# ---------------- 反馈 ----------------

def test_preferences_need_enough_samples_and_go_into_prompt(env):
    s, db, rules = env
    titles = [f"Headline number {i} about platform engineering" for i in range(4)]
    ingest(db, [make_item(f"https://x.com/{i}", t) for i, t in enumerate(titles)], s, rules, now=NOW)
    ids = _ids(db)
    assert preference_section(db, s, NOW) == ""                          # 没有反馈
    db.execute("INSERT INTO feedback (item_id, vote, saved_at, updated_at) VALUES (?, 1, NULL, ?)",
               [ids[titles[0]], NOW])
    assert preference_section(db, s, NOW) == ""                          # 样本太少（<3）不加
    db.execute("INSERT INTO feedback (item_id, vote, saved_at, updated_at) VALUES (?, -1, NULL, ?)",
               [ids[titles[1]], NOW])
    db.execute("INSERT INTO feedback (item_id, vote, saved_at, updated_at) VALUES (?, NULL, ?, ?)",
               [ids[titles[2]], NOW, NOW])                               # 只收藏 = 正样本
    sec = preference_section(db, s, NOW)
    up, down = sec.split("读者点了 👎 的：")
    assert titles[0] in up and titles[2] in up and titles[1] in down

    llm = FakeLLM()
    score_pending(db, llm, s, now=NOW)
    assert "读者最近的反馈" in llm.prompts[0] and "{{preferences}}" not in llm.prompts[0]


def test_old_feedback_is_ignored(env):
    s, db, rules = env
    ingest(db, [make_item(f"https://x.com/{i}", f"Old feedback headline {i} here") for i in range(3)],
           s, rules, now=NOW)
    for iid in _ids(db).values():
        db.execute("INSERT INTO feedback (item_id, vote, updated_at) VALUES (?, 1, ?)", [iid, NOW - 90 * 86400])
    assert preference_section(db, s, NOW) == ""


def test_push_has_feedback_buttons(env):
    s, db, rules = env
    ingest(db, [make_item("https://x.com/a", "Important cloud outage hits region")], s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={"Important cloud outage hits region": 8}), s, now=NOW)
    tg = FakeTG()
    push_instant(db, tg, s, now=NOW)
    iid = _ids(db)["Important cloud outage hits region"]
    row = tg.markups[0]["inline_keyboard"][0]
    assert [b["callback_data"] for b in row] == [f"fb:{iid}:s", f"fb:{iid}:u", f"fb:{iid}:d"]
    assert all(len(b["callback_data"].encode()) <= 64 for b in row)       # Telegram 上限


# ---------------- 招聘字段 ----------------

def test_validate_jobs():
    assert validate_jobs(None) is None
    assert validate_jobs({"company": "Google", "action": "expand"}) is None          # action 不合法
    assert validate_jobs({"company": "", "action": "hiring"}) is None
    assert validate_jobs({"company": "Infineon", "action": "Hiring", "scale": "+1000 人", "location": "null"}) == \
        {"company": "Infineon", "action": "hiring", "scale": "+1000 人"}


def test_jobs_are_stored_when_scoring(env):
    s, db, rules = env
    t = "Infineon to hire 1000 engineers in Kulim"
    ingest(db, [make_item("https://x.com/j", t, group="my-jobs"), make_item("https://x.com/k", "Unrelated tech news headline")],
           s, rules, now=NOW)
    db.execute("UPDATE news_items SET status = 'pending', filter_reason = NULL")   # 跳过 my-jobs 白名单预筛
    score_pending(db, FakeLLM(jobs={t: {"company": "Infineon", "action": "hiring", "scale": "+1000 人",
                                        "location": "Kulim"}}), s, now=NOW)
    rows = {r["title"]: r["jobs"] for r in db.query("SELECT title, jobs FROM news_items")}
    assert json.loads(rows[t]) == {"company": "Infineon", "action": "hiring", "scale": "+1000 人", "location": "Kulim"}
    assert rows["Unrelated tech news headline"] is None


# ---------------- 盯梢 ----------------

def test_watch_matching_rules():
    kw = ["kubernetes 1.36", "k8s 1.36"]
    assert watch_matches(kw, "Kubernetes 1.36 released")
    assert watch_matches(kw, "What's new in K8s 1.36?")
    assert not watch_matches(kw, "Kubernetes 1.35 released")
    assert not watch_matches(["ai"], "He said nothing")                  # 英文按词边界
    assert watch_matches(["ai"], "New AI chip")
    assert watch_matches(["谷歌 数据中心"], "谷歌在柔佛建数据中心")           # 中文按子串，组内全部命中
    assert not watch_matches(["谷歌 数据中心"], "谷歌发布新手机")


def _add_watch(db, name, keywords, created_at):
    db.execute("INSERT INTO watches (name, keywords, created_at, expires_at) VALUES (?, ?, ?, ?)",
               [name, json.dumps(keywords), created_at, created_at + 30 * 86400])


def test_watch_pushes_below_threshold_once(env):
    s, db, rules = env
    _add_watch(db, "Kubernetes 1.36", ["kubernetes 1.36"], NOW - 3600)
    hit, low, other = ("Kubernetes 1.36 beta notes published", "Kubernetes 1.36 trivia quiz",
                       "Some other cloud news here")
    ingest(db, [make_item("https://x.com/1", hit), make_item("https://x.com/2", low),
                make_item("https://x.com/3", other)], s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={hit: 5, low: 2, other: 5}), s, now=NOW)

    tg = FakeTG()
    assert push_instant(db, tg, s, now=NOW)["pushed"] == 0                # 都没到 7 分
    st = push_watches(db, tg, s, now=NOW)
    assert st == {"watches": 1, "watch_pushed": 1}                       # 2 分的被 watch_min_score 挡掉
    assert "盯梢" in tg.messages[0] and "x.com/1" in tg.messages[0] and tg.markups[0]
    assert db.query("SELECT hits FROM watches")[0]["hits"] == 1
    assert push_watches(db, tg, s, now=NOW)["watch_pushed"] == 0          # 不重复推


def test_watch_ignores_items_before_creation_and_expired(env):
    s, db, rules = env
    t = "Google Malaysia data centre expansion in Johor"
    ingest(db, [make_item("https://x.com/1", t)], s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={t: 6}), s, now=NOW)
    _add_watch(db, "Google 大马数据中心", ["google malaysia data"], NOW + 60)   # 条目入库之后才建的盯梢
    _add_watch(db, "过期", ["google"], NOW - 40 * 86400)
    assert push_watches(db, FakeTG(), s, now=NOW + 120)["watch_pushed"] == 0


# ---------------- 周报 ----------------

def test_weekly_slot_and_window(env):
    s, _, _ = env
    sun_21 = int(datetime(2026, 11, 15, 21, 0, tzinfo=MYT).timestamp())
    assert weekly_slot(sun_21, s).date().isoformat() == "2026-11-15"
    sun_19 = int(datetime(2026, 11, 15, 19, 0, tzinfo=MYT).timestamp())
    assert weekly_slot(sun_19, s).date().isoformat() == "2026-11-08"     # 还没到 20:00 → 上周日


def test_trend_label():
    assert trend_label(14, 10) == "↑40%"
    assert trend_label(6, 10) == "↓40%"
    assert trend_label(10, 10) == "→ 持平"
    assert trend_label(3, 2) == "（上周 2）"                               # 样本少不算百分比


def test_parse_weekly_drops_unknown_ids():
    text = 'xx {"events": [{"ids": [1, 99], "title": "A"}, {"ids": [99], "title": "B"}, {"ids": [1], "title": "C"}], "trend": "T"}'
    events, trend = parse_weekly(text, {1, 2})
    assert events == [{"ids": [1], "title": "A", "summary": ""}] and trend == "T"
    assert parse_weekly("不是 JSON", {1}) == ([], "")


def test_weekly_report_end_to_end(env):
    s, db, rules = env
    a, b, c = ("Nvidia CEO resigns suddenly today", "Nvidia shares drop after CEO exit",
               "Google to build data centre in Johor")
    ingest(db, [make_item("https://x.com/a", a), make_item("https://x.com/b", b, source="B"),
                make_item("https://x.com/c", c, source="C")], s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={a: 9, b: 8, c: 7},
                              jobs={c: {"company": "Google", "action": "investment", "location": "Johor"}}),
                  s, now=NOW)
    ids = _ids(db)
    out = json.dumps({"events": [{"ids": [ids[a], ids[b]], "title": "Nvidia CEO 辞职", "summary": "股价下跌"}],
                      "trend": "AI 芯片领导层变动"}, ensure_ascii=False)
    text, st = build_weekly(db, lambda: FakeLLM(weekly=out), NOW + 3600)
    assert "Nvidia CEO 辞职" in text and "https://x.com/a" in text and "（2 个来源）" in text
    assert "AI 芯片领导层变动" in text
    assert "新投资" in text and "Google" in text and "Johor" in text
    assert st["events"] == 1 and st["jobs"] == 1

    # LLM 失败时退回按分数取前几条，周报照发
    text, st = build_weekly(db, lambda: FakeLLM(mode="error"), NOW + 3600)
    assert st.get("llm_error") and a in text and "趋势" not in text


def test_maybe_send_weekly_once(env):
    s, db, rules = env
    sun_21 = int(datetime(2026, 11, 15, 21, 0, tzinfo=MYT).timestamp())
    tg, llm = FakeTG(), FakeLLM()
    assert maybe_send_weekly(db, tg, s, lambda: llm, now=sun_21)["weekly"] == "sent"
    assert maybe_send_weekly(db, tg, s, lambda: llm, now=sun_21 + 1800)["weekly"] == "already_sent"
    wed = int(datetime(2026, 11, 18, 10, 0, tzinfo=MYT).timestamp())
    assert maybe_send_weekly(db, tg, s, lambda: llm, now=wed)["weekly"] == "not_due"   # 错过 24h 不补发
    assert len(tg.messages) == 1 and "本周回顾" in tg.messages[0]
