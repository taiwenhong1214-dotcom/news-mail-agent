"""环境变量 + YAML 配置加载。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"
PROMPTS_DIR = ROOT / "prompts"
MIGRATIONS_DIR = ROOT / "migrations"


def load_dotenv(path: Path = ROOT / ".env") -> None:
    """极简 .env 加载，只用于本地开发；不覆盖已有环境变量。"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _env(name: str, default: str = "") -> str:
    # 空字符串也视为未设置（GitHub Actions 里没定义的 vars.X 会传进来一个空值）
    return os.environ.get(name, "").strip() or default


def _env_int(name: str, default: int) -> int:
    v = _env(name)
    return int(v) if v else default


def _env_float(name: str, default: float) -> float:
    v = _env(name)
    return float(v) if v else default


@dataclass
class Settings:
    # 数据库：d1（生产）或 sqlite（本地开发 / 测试）
    db_backend: str = "d1"
    sqlite_path: str = str(ROOT / "local.db")
    cf_account_id: str = ""
    cf_api_token: str = ""
    d1_database_id: str = ""

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""

    llm_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    llm_api_key: str = ""
    llm_model: str = "gemini-3.5-flash-lite"
    llm_fallback_models: str = "gemini-3.1-flash-lite,gemini-2.5-flash"  # 逗号分隔，主模型过载时依次换
    llm_reasoning_effort: str = "low"    # 空字符串 = 不传；gemini-3.5-flash-lite 不支持 "none"
    llm_json_mode: bool = True           # 传 response_format=json_object

    window_hours: int = 48               # 只保留多少小时内的条目
    simhash_distance: int = 3            # 汉明距离 ≤ 此值视为同一事件
    simhash_window_hours: int = 24       # 近似判重只和这个时间窗内的条目比较
    score_batch_size: int = 10
    max_score_batches: int = 8           # 每次运行最多调用几次打分（控制费用和限流）
    max_llm_attempts: int = 3
    merge_min_score: float = 6.0         # LLM 事件合并只看 ≥ 此分数的条目
    merge_max_items: int = 60
    push_threshold: float = 7.0
    push_max_per_run: int = 8
    push_max_age_hours: int = 12         # 超过这个年龄的高分条目不即时推送，只进日报
    push_instant_min: float = 8.5        # ≥ 此分且刚抓到的单独推送；push_threshold 到这个分数之间的攒进快讯合集
    push_fresh_hours: int = 3            # 单独推送只推这么多小时内抓到的（夜里攒下的交给日报 / 合集）
    bundle_interval_hours: int = 3       # 快讯合集多久发一次
    bundle_max_items: int = 15
    quiet_hours: str = "23-8"            # MYT 免打扰时段（"off" 关闭）；期间只推 ≥ quiet_override 的
    quiet_override: float = 9.5
    cleanup_after_hours: int = 24        # 推送多久后自动删除（0 = 不删；Telegram 只允许删 48 小时内的）
    digest_hour_myt: int = 8
    digest_top_n: int = 10
    watch_min_score: float = 4.0         # 盯梢命中也要 ≥ 此分，挡掉软文和标题党
    watch_max_per_run: int = 5           # 盯梢推送每次最多几条，话题太宽时不刷屏
    feedback_samples: int = 10           # 打分时带上最近多少条 👍 和多少条 👎 的标题
    weekly_weekday: int = 6              # 周报：星期几发（Python weekday，0 = 周一，6 = 周日）
    weekly_hour_myt: int = 20
    fetch_timeout: float = 10.0
    fetch_concurrency: int = 10
    dry_run: bool = False                # True 时不发 Telegram，只打印
    manual_run: bool = False             # 用户在 Telegram 发 /run 触发：不受免打扰和合集间隔限制，跑完回报结果

    feeds_config: dict = field(default_factory=dict)
    filters_config: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        s = cls(
            db_backend=_env("DB_BACKEND", "d1"),
            sqlite_path=_env("SQLITE_PATH", str(ROOT / "local.db")),
            cf_account_id=_env("CF_ACCOUNT_ID"),
            cf_api_token=_env("CF_API_TOKEN"),
            d1_database_id=_env("D1_DATABASE_ID"),
            telegram_bot_token=_env("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=_env("TELEGRAM_CHAT_ID"),
            llm_base_url=_env("LLM_BASE_URL", cls.llm_base_url),
            llm_api_key=_env("LLM_API_KEY"),
            llm_model=_env("LLM_MODEL", cls.llm_model),
            llm_fallback_models=_env("LLM_FALLBACK_MODELS", cls.llm_fallback_models),
            llm_reasoning_effort=_env("LLM_REASONING_EFFORT", cls.llm_reasoning_effort),
            llm_json_mode=_env("LLM_JSON_MODE", "1") not in ("0", "false", "no"),
            window_hours=_env_int("WINDOW_HOURS", cls.window_hours),
            simhash_distance=_env_int("SIMHASH_DISTANCE", cls.simhash_distance),
            simhash_window_hours=_env_int("SIMHASH_WINDOW_HOURS", cls.simhash_window_hours),
            max_score_batches=_env_int("MAX_SCORE_BATCHES", cls.max_score_batches),
            push_threshold=_env_float("PUSH_THRESHOLD", cls.push_threshold),
            push_max_per_run=_env_int("PUSH_MAX_PER_RUN", cls.push_max_per_run),
            push_max_age_hours=_env_int("PUSH_MAX_AGE_HOURS", cls.push_max_age_hours),
            push_instant_min=_env_float("PUSH_INSTANT_MIN", cls.push_instant_min),
            bundle_interval_hours=_env_int("BUNDLE_INTERVAL_HOURS", cls.bundle_interval_hours),
            quiet_hours=_env("QUIET_HOURS", cls.quiet_hours),
            cleanup_after_hours=_env_int("CLEANUP_AFTER_HOURS", cls.cleanup_after_hours),
            digest_hour_myt=_env_int("DIGEST_HOUR_MYT", cls.digest_hour_myt),
            watch_min_score=_env_float("WATCH_MIN_SCORE", cls.watch_min_score),
            weekly_hour_myt=_env_int("WEEKLY_HOUR_MYT", cls.weekly_hour_myt),
            dry_run=_env("DRY_RUN", "0") in ("1", "true", "yes"),
        )
        s.feeds_config = load_yaml(CONFIG_DIR / "feeds.yaml")
        s.filters_config = load_yaml(CONFIG_DIR / "filters.yaml")
        return s

    def group_names(self) -> dict[str, str]:
        """分组 key -> 显示名（中文）。"""
        groups = self.feeds_config.get("groups", {}) or {}
        return {k: (v or {}).get("name", k) for k, v in groups.items()}


def load_yaml(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")
