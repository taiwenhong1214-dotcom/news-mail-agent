"""判重顺序、批量更新、合并跳过、阶段顺序、数据保留、本地库增量迁移。"""
import sqlite3
from datetime import datetime

from nma.__main__ import STAGES
from nma.db import SQLiteDatabase, migrate_sqlite, update_rows
from nma.digest import MYT, maybe_send_digest
from nma.news import prefilter
from nma.news.pipeline import (ingest, merge_due, merge_events, prune_db, push_bundle, push_instant,
                               score_pending)
from nma.settings import MIGRATIONS_DIR

from test_pipeline import NOW, FakeLLM, FakeTG, env, make_item  # noqa: F401  (env 是 fixture)


def at(h, m=0, day=13):
    return int(datetime(2026, 11, day, h, m, tzinfo=MYT).timestamp())


# ---------------- 预筛先于近似判重 ----------------

def test_filtered_item_does_not_swallow_later_report(env):
    s, db, _ = env
    rules = prefilter.build_rules({"require_any": {"my-jobs": ["hiring"]}})
    title = "Google announces new Malaysia data center in Johor"
    # 先从白名单分组抓到（没有 hiring → 被过滤），之后正式报道从别的分组进来
    ingest(db, [make_item("https://a.com/1", title, group="my-jobs", tier="T2")], s, rules, now=NOW)
    st = ingest(db, [make_item("https://b.com/1", title, group="my-it")], s, rules, now=NOW + 600)
    assert st["pending"] == 1 and not st.get("near_dup")
    rows = {r["url"]: r for r in db.query("SELECT url, status, cluster_id, id FROM news_items")}
    assert rows["https://a.com/1"]["status"] == "filtered"
    assert rows["https://b.com/1"]["status"] == "pending"
    assert rows["https://b.com/1"]["cluster_id"] == rows["https://b.com/1"]["id"]


def test_filtered_item_in_same_batch_is_not_a_primary(env):
    s, db, _ = env
    rules = prefilter.build_rules({"require_any": {"my-jobs": ["hiring"]}})
    title = "Google announces new Malaysia data center in Johor"
    # 同一批里被过滤的是 T1、正式报道是 T2：以前 T1 排在前面当了主条目，把 T2 吞成 dup
    st = ingest(db, [make_item("https://a.com/1", title, group="my-jobs", tier="T1"),
                     make_item("https://b.com/1", title, group="my-it", tier="T2")], s, rules, now=NOW)
    assert st["filtered"] == 1 and st["pending"] == 1 and not st.get("near_dup")


# ---------------- 批量 UPDATE ----------------

def test_update_rows_spans_chunks(env):
    _, db, rules = env
    s = env[0]
    ingest(db, [make_item(f"https://u.com/{i}", f"Unique headline number {i} about things") for i in range(25)],
           s, rules, now=NOW)
    ids = [r["id"] for r in db.query("SELECT id FROM news_items ORDER BY id")]
    n = update_rows(db, "news_items", "id", ("score", "summary_zh"),
                    [(i, i / 10, f"摘要 {i}") for i in ids], extra_set="status = 'scored'")
    assert n == 25
    for r in db.query("SELECT id, score, summary_zh, status FROM news_items"):
        assert r["score"] == r["id"] / 10 and r["summary_zh"] == f"摘要 {r['id']}" and r["status"] == "scored"


def test_score_pending_counts_merge_candidates(env):
    s, db, rules = env
    ingest(db, [make_item("https://m.com/1", "A fairly important headline here"),
                make_item("https://m.com/2", "A rather boring headline here")], s, rules, now=NOW)
    st = score_pending(db, FakeLLM(scores={"A fairly important headline here": 7}), s, now=NOW)
    assert st["scored"] == 2 and st["merge_candidates"] == 1
    row = db.query("SELECT llm_attempts, status FROM news_items WHERE url = 'https://m.com/1'")[0]
    assert row == {"llm_attempts": 1, "status": "scored"}


# ---------------- 合并按需跑 ----------------

def test_merge_due_only_with_new_candidates_or_after_failure(env):
    s, db, rules = env
    assert not merge_due(db, {"scored": 5, "merge_candidates": 0})
    assert merge_due(db, {"scored": 5, "merge_candidates": 1})
    ingest(db, [make_item("https://g.com/1", "First headline about one event"),
                make_item("https://g.com/2", "Second headline about other thing")], s, rules, now=NOW)
    score_pending(db, FakeLLM(scores={"First headline about one event": 7,
                                      "Second headline about other thing": 7}), s, now=NOW)
    merge_events(db, FakeLLM(mode="error"), s, now=NOW)
    assert merge_due(db, {"merge_candidates": 0})          # 上次因 LLM 不可用跳过 → 下次补跑
    merge_events(db, FakeLLM(), s, now=NOW)
    assert not merge_due(db, {"merge_candidates": 0})


# ---------------- 阶段顺序：日报先于推送 ----------------

def test_digest_runs_before_push():
    assert STAGES.index("digest") < STAGES.index("push")


def test_morning_run_sends_digest_then_bundle_without_repeats(env):
    s, db, rules = env
    night = at(6)
    items = [make_item(f"https://n.com/{i}", t, age_h=0) for i, t in
             enumerate(["Overnight big story headline", "Overnight middle story headline"])]
    ingest(db, items, s, rules, now=night)
    score_pending(db, FakeLLM(scores={"Overnight big story headline": 9,
                                      "Overnight middle story headline": 7.5}), s, now=night)
    s.digest_top_n = 1
    tg = FakeTG()
    morning = at(8, 7)
    # 按 STAGES 的顺序：先日报，再单独推送和合集
    assert maybe_send_digest(db, tg, s, now=morning)["digest"] == "sent"
    assert push_instant(db, tg, s, now=morning)["pushed"] == 0        # 9 分那条已经在日报里了
    assert push_bundle(db, tg, s, now=morning) == {"bundle": 1}        # 合集当场发，不用等下一轮
    assert len(tg.messages) == 2 and "n.com/1" in tg.messages[1] and "n.com/0" not in tg.messages[1]


# ---------------- 数据保留 ----------------

def _insert(db, url, status, age_days, pushed=None):
    db.execute(
        "INSERT INTO news_items (url_hash, url, title, source, feed_group, tier, published_at, fetched_at, "
        "simhash, status, pushed_at) VALUES (?, ?, 'some title here', 'S', 'devops', 'T2', ?, ?, '0', ?, ?)",
        [url, url, NOW - age_days * 86400, NOW - age_days * 86400, status, pushed],
    )
    return db.query("SELECT id FROM news_items WHERE url = ?", [url])[0]["id"]


def test_prune_removes_old_rows_but_keeps_feedback(env):
    _, db, _ = env
    _insert(db, "filtered-old", "filtered", 15)
    _insert(db, "filtered-new", "filtered", 3)
    _insert(db, "dup-old", "dup", 31)
    _insert(db, "dup-pushed", "dup", 31, pushed=NOW - 31 * 86400)   # 被事件合并的已推送条目：留到 180 天
    _insert(db, "dup-new", "dup", 20)
    _insert(db, "scored-old", "scored", 200)
    kept = _insert(db, "scored-old-fb", "scored", 200)
    _insert(db, "scored-new", "scored", 100)
    db.execute("INSERT INTO feedback (item_id, vote, updated_at) VALUES (?, 1, ?)", [kept, NOW])
    db.execute("INSERT INTO runs (started_at) VALUES (?)", [NOW - 40 * 86400])
    db.execute("INSERT INTO runs (started_at) VALUES (?)", [NOW - 86400])
    db.execute("INSERT INTO watches (name, keywords, created_at, expires_at) VALUES ('a', '[]', 0, ?)",
               [NOW - 40 * 86400])
    db.execute("INSERT INTO watches (name, keywords, created_at, expires_at) VALUES ('b', '[]', 0, ?)",
               [NOW + 86400])

    st = prune_db(db, now=NOW)
    assert st["pruned_filtered"] == 1 and st["pruned_dup"] == 1 and st["pruned_old"] == 1
    assert st["pruned_runs"] == 1 and st["pruned_watches"] == 1
    left = {r["url"] for r in db.query("SELECT url FROM news_items")}
    assert left == {"filtered-new", "dup-pushed", "dup-new", "scored-old-fb", "scored-new"}
    # 删掉的条目也从全文索引里移除了（触发器）
    assert db.query("SELECT COUNT(*) AS n FROM news_fts")[0]["n"] == len(left)
    assert prune_db(db, now=NOW + 3600) == {"prune": "not_yet"}   # 每天一次


# ---------------- 本地 SQLite 增量迁移 ----------------

def test_sqlite_applies_new_migrations_to_existing_db(tmp_path):
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    latest = int(files[-1].name.split("_", 1)[0])
    path = tmp_path / "old.db"
    # 旧版代码建的库：只跑过前 3 个迁移，没记 user_version
    conn = sqlite3.connect(path)
    for f in files[:3]:
        conn.executescript(f.read_text(encoding="utf-8"))
    conn.commit()
    conn.close()

    db = SQLiteDatabase(str(path))
    tables = {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"search_cache", "sent_messages"} <= tables
    assert db.query("PRAGMA user_version")[0]["user_version"] == latest
    db.close()
    SQLiteDatabase(str(path)).close()   # 再打开不会重复执行


def test_sqlite_runs_only_newer_migrations(tmp_path):
    mig = tmp_path / "mig"
    mig.mkdir()
    (mig / "0001_a.sql").write_text("CREATE TABLE a (x INTEGER);", encoding="utf-8")
    conn = sqlite3.connect(tmp_path / "x.db")
    migrate_sqlite(conn, mig)
    (mig / "0002_b.sql").write_text("ALTER TABLE a ADD COLUMN y TEXT;", encoding="utf-8")
    migrate_sqlite(conn, mig)
    migrate_sqlite(conn, mig)
    assert [r[1] for r in conn.execute("PRAGMA table_info(a)")] == ["x", "y"]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    conn.close()
