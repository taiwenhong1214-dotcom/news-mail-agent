"""数据库访问：生产用 Cloudflare D1 HTTP API，本地开发 / 测试用 SQLite（同一套 SQL）。"""
from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable, Protocol, Sequence

import httpx

from .settings import MIGRATIONS_DIR, Settings

log = logging.getLogger(__name__)

# D1 单条语句最多 100 个绑定参数
MAX_PARAMS = 100


class DBError(RuntimeError):
    pass


class Database(Protocol):
    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict]: ...
    def execute(self, sql: str, params: Sequence[Any] = ()) -> int: ...
    def close(self) -> None: ...


class D1Database:
    def __init__(self, account_id: str, database_id: str, api_token: str, retries: int = 3):
        if not (account_id and database_id and api_token):
            raise DBError("缺少 CF_ACCOUNT_ID / D1_DATABASE_ID / CF_API_TOKEN")
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/d1/database/{database_id}/query"
        )
        self.retries = retries
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {api_token}"}, timeout=30.0
        )

    def _post(self, sql: str, params: Sequence[Any]) -> dict:
        body = {"sql": sql, "params": [_coerce(p) for p in params]}
        last_exc: Exception | None = None
        for attempt in range(self.retries):
            try:
                r = self.client.post(self.url, json=body)
            except httpx.HTTPError as e:
                last_exc = e
            else:
                if r.status_code == 429 or r.status_code >= 500:
                    last_exc = DBError(f"D1 HTTP {r.status_code}")
                else:
                    data = r.json()
                    if not data.get("success"):
                        # SQL 错误等，不重试
                        raise DBError(f"D1 error: {data.get('errors')}")
                    return data["result"][0]
            time.sleep(2**attempt)
        raise DBError(f"D1 请求失败（已重试 {self.retries} 次）: {last_exc}")

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict]:
        return self._post(sql, params).get("results") or []

    def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        return int((self._post(sql, params).get("meta") or {}).get("changes", 0))

    def close(self) -> None:
        self.client.close()


class SQLiteDatabase:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        migrate_sqlite(self.conn)

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict]:
        cur = self.conn.execute(sql, [_coerce(p) for p in params])
        rows = [dict(r) for r in cur.fetchall()]
        self.conn.commit()
        return rows

    def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        cur = self.conn.execute(sql, [_coerce(p) for p in params])
        self.conn.commit()
        return cur.rowcount

    def close(self) -> None:
        self.conn.close()


def migrate_sqlite(conn: sqlite3.Connection, migrations_dir: Path = MIGRATIONS_DIR) -> None:
    """按文件名序号增量执行 migrations/*.sql，已执行到的序号记在 PRAGMA user_version。
    （生产 D1 用 wrangler d1 migrations apply，不走这里。）"""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    # 旧版本建的本地库：表已经有了但没记版本，不知道跑到了哪个迁移，逐条执行、跳过已存在的对象
    legacy = version == 0 and conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='news_items'"
    ).fetchone() is not None
    for f in sorted(migrations_dir.glob("*.sql")):
        num = int(f.name.split("_", 1)[0])
        if num <= version:
            continue
        sql = f.read_text(encoding="utf-8")
        if legacy:
            _apply_tolerant(conn, sql)
        else:
            conn.executescript(sql)
        conn.execute(f"PRAGMA user_version = {num}")
        conn.commit()


_ALREADY_APPLIED = ("already exists", "duplicate column name")


def _apply_tolerant(conn: sqlite3.Connection, sql: str) -> None:
    stmt = ""
    for line in sql.splitlines(keepends=True):
        stmt += line
        if not sqlite3.complete_statement(stmt):  # 触发器里有分号，按完整语句切
            continue
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError as e:
            if not any(s in str(e) for s in _ALREADY_APPLIED):
                raise
        stmt = ""
    conn.commit()


def _coerce(v: Any) -> Any:
    if isinstance(v, bool):
        return int(v)
    return v


def connect(settings: Settings) -> Database:
    if settings.db_backend == "sqlite":
        return SQLiteDatabase(settings.sqlite_path)
    return D1Database(settings.cf_account_id, settings.d1_database_id, settings.cf_api_token)


# ---------- 批量辅助 ----------

def chunked(seq: Sequence, size: int) -> Iterable[Sequence]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def insert_rows(
    db: Database, table: str, columns: Sequence[str], rows: Sequence[Sequence[Any]],
    or_clause: str = "OR IGNORE",
) -> int:
    """多行 INSERT，按 D1 参数上限自动分块。返回写入行数。"""
    if not rows:
        return 0
    per_stmt = max(1, MAX_PARAMS // len(columns))
    placeholder = "(" + ",".join("?" * len(columns)) + ")"
    total = 0
    for chunk in chunked(rows, per_stmt):
        sql = (
            f"INSERT {or_clause} INTO {table} ({','.join(columns)}) VALUES "
            + ",".join([placeholder] * len(chunk))
        )
        params = [v for row in chunk for v in row]
        total += db.execute(sql, params)
    return total


def update_rows(
    db: Database, table: str, key: str, columns: Sequence[str], rows: Sequence[Sequence[Any]],
    extra_set: str = "",
) -> int:
    """按主键批量更新多行、每行值不同：rows 每行是 (key, col1, col2, ...)。
    拼成 UPDATE ... SET col = CASE key WHEN ? THEN ? ... END WHERE key IN (...)，按参数上限分块。
    extra_set 是对所有行都一样的 SET 片段，例如 "status = 'scored'"。"""
    if not rows:
        return 0
    per_stmt = max(1, MAX_PARAMS // (2 * len(columns) + 1))
    total = 0
    for chunk in chunked(rows, per_stmt):
        sets, params = [], []
        for i, col in enumerate(columns, 1):
            sets.append(f"{col} = CASE {key} " + " ".join(["WHEN ? THEN ?"] * len(chunk)) + " END")
            params += [v for row in chunk for v in (row[0], row[i])]
        if extra_set:
            sets.append(extra_set)
        params += [row[0] for row in chunk]
        total += db.execute(
            f"UPDATE {table} SET {', '.join(sets)} WHERE {key} IN ({','.join('?' * len(chunk))})", params
        )
    return total


def select_in(
    db: Database, sql_template: str, values: Sequence[Any], extra_params: Sequence[Any] = ()
) -> list[dict]:
    """sql_template 里用 {in} 占位，例如 "SELECT ... WHERE url_hash IN ({in})"。"""
    out: list[dict] = []
    size = MAX_PARAMS - len(extra_params)
    for chunk in chunked(list(values), size):
        sql = sql_template.format(**{"in": ",".join("?" * len(chunk))})
        out.extend(db.query(sql, [*chunk, *extra_params]))
    return out
