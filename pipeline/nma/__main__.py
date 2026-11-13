"""入口：python -m nma [all|fetch|score|merge|push|digest|weekly] [--force-digest] [--force-weekly] [--dry-run] [--sqlite]"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import traceback

from . import digest, weekly
from .db import DBError, connect
from .llm import LLMClient
from .news import prefilter
from .news.fetch import fetch_items, load_sources
from .news.pipeline import ingest, load_muted, merge_events, push_instant, push_watches, score_pending
from .settings import Settings
from .telegram import Telegram

log = logging.getLogger("nma")

STAGES = ("fetch", "score", "merge", "push", "digest", "weekly")


def _make_llm(settings: Settings) -> LLMClient:
    return LLMClient(
        settings.llm_base_url, settings.llm_api_key, settings.llm_model,
        settings.llm_reasoning_effort, settings.llm_json_mode,
        fallback_models=[m.strip() for m in settings.llm_fallback_models.split(",")],
        retries=2,  # 每个模型重试 2 次就换下一个，过载时不在一个模型上耗太久
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="nma")
    ap.add_argument("stage", nargs="?", default="all", choices=("all", *STAGES))
    ap.add_argument("--force-digest", action="store_true", help="不管时间和是否已发，立即生成并发送日报")
    ap.add_argument("--force-weekly", action="store_true", help="不管时间和是否已发，立即生成并发送周报")
    ap.add_argument("--dry-run", action="store_true", help="不发 Telegram，只打印")
    ap.add_argument("--sqlite", metavar="PATH", nargs="?", const="", help="用本地 SQLite 代替 D1")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    settings = Settings.from_env()
    if args.dry_run:
        settings.dry_run = True
    if args.sqlite is not None:
        settings.db_backend = "sqlite"
        if args.sqlite:
            settings.sqlite_path = args.sqlite

    tg = Telegram(settings.telegram_bot_token, settings.telegram_chat_id, settings.dry_run)
    try:
        db = connect(settings)
    except DBError as e:
        tg.alert("News pipeline：数据库连接失败", str(e))
        log.error("数据库连接失败: %s", e)
        return 2

    started = int(time.time())
    run_id = None
    try:
        db.execute("INSERT INTO runs (started_at) VALUES (?)", [started])
        run_id = (db.query("SELECT MAX(id) AS id FROM runs") or [{}])[0].get("id")
    except Exception as e:
        log.warning("写 runs 表失败: %s", e)

    stages = STAGES if args.stage == "all" else (args.stage,)
    stats: dict = {}
    errors: list[str] = []
    llm: LLMClient | None = None

    for stage in stages:
        t0 = time.time()
        try:
            if stage == "fetch":
                sources = load_sources(settings.feeds_config, db)
                items, failures = fetch_items(
                    sources, settings.window_hours, settings.fetch_timeout, settings.fetch_concurrency
                )
                rules = prefilter.build_rules(settings.filters_config, load_muted(db))
                st = ingest(db, items, settings, rules)
                st["sources"] = len(sources)
                st["failed_sources"] = failures
                if sources and len(failures) > len(sources) / 2:
                    errors.append(f"fetch: {len(failures)}/{len(sources)} 个信源失败，可能是网络问题")
            elif stage == "score":
                llm = llm or _make_llm(settings)
                st = score_pending(db, llm, settings)
                st["tokens"] = llm.usage.prompt_tokens + llm.usage.completion_tokens
                st["model"] = llm.model
            elif stage == "merge":
                if args.stage == "all" and not (stats.get("score") or {}).get("scored"):
                    st = {"skipped": "本次没有新打分的条目"}
                else:
                    llm = llm or _make_llm(settings)
                    st = merge_events(db, llm, settings)
            elif stage == "push":
                st = push_instant(db, tg, settings)
                st.update(push_watches(db, tg, settings))  # 分数推送之后再跑，已推送的不会重复
            elif stage == "digest":
                st = digest.maybe_send_digest(db, tg, settings, force=args.force_digest)
            else:
                def get_llm() -> LLMClient:
                    nonlocal llm
                    llm = llm or _make_llm(settings)
                    return llm
                st = weekly.maybe_send_weekly(db, tg, settings, get_llm, force=args.force_weekly)
            st["seconds"] = round(time.time() - t0, 1)
            stats[stage] = st
            log.info("%s: %s", stage, json.dumps({k: v for k, v in st.items() if k != "failed_sources"},
                                                   ensure_ascii=False))
            if st.get("failed_sources"):
                log.info("失败信源: %s", "; ".join(st["failed_sources"]))
        except Exception as e:
            log.exception("阶段 %s 失败", stage)
            tb = traceback.format_exc(limit=3)
            errors.append(f"{stage}: {type(e).__name__}: {e}\n{tb}")

    if errors:
        tg.alert("News pipeline 出错", "\n\n".join(errors))

    if run_id is not None:
        try:
            db.execute(
                "UPDATE runs SET finished_at = ?, stats = ?, error = ? WHERE id = ?",
                [int(time.time()), json.dumps(stats, ensure_ascii=False),
                 "\n".join(e.splitlines()[0] for e in errors) or None, run_id],
            )
        except Exception as e:
            log.warning("更新 runs 表失败: %s", e)

    if llm:
        llm.close()
    db.close()
    return 2 if errors else 0  # 2 = 出错但已发 Telegram 告警；未捕获崩溃时 Python 返回 1


if __name__ == "__main__":
    sys.exit(main())
