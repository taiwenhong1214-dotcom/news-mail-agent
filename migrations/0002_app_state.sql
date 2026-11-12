-- 小型键值状态（Worker 用：告警节流等）
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
