-- News Agent D1 schema v1
-- 应用：npx wrangler d1 migrations apply news-agent --remote（在 worker/ 目录下）

-- 新闻条目：所有抓到的条目都落库，包括被筛掉的
CREATE TABLE news_items (
  id            INTEGER PRIMARY KEY,
  url_hash      TEXT    NOT NULL UNIQUE,     -- sha256(规范化URL) 前16位，UNIQUE 兜底判重
  url           TEXT    NOT NULL,            -- 规范化后的 URL
  title         TEXT    NOT NULL,
  summary       TEXT,                        -- feed 原始摘要，去 HTML，截断
  source        TEXT    NOT NULL,            -- 信源名
  feed_group    TEXT    NOT NULL,            -- feeds.yaml 里的分组 key
  tier          TEXT    NOT NULL,            -- T1 / T2
  published_at  INTEGER NOT NULL,            -- unix 秒
  fetched_at    INTEGER NOT NULL,
  simhash       TEXT    NOT NULL,            -- 64 位 hex
  cluster_id    INTEGER,                     -- 同一事件的主条目 id；主条目自己 = id
  source_count  INTEGER NOT NULL DEFAULT 1,  -- 主条目上记录"N 个来源报道"
  status        TEXT    NOT NULL,            -- pending | filtered | dup | scored | llm_failed
  filter_reason TEXT,
  llm_attempts  INTEGER NOT NULL DEFAULT 0,
  score         REAL,
  category      TEXT,
  summary_zh    TEXT,
  reason        TEXT,
  pushed_at     INTEGER                      -- 即时推送时间；NULL = 未推
);
CREATE INDEX idx_news_published ON news_items(published_at);
CREATE INDEX idx_news_status_score ON news_items(status, score);
CREATE INDEX idx_news_cluster ON news_items(cluster_id);

-- 全文检索（对话 search_news 用）。trigram 分词：中英文混排都能搜，查询词需 ≥ 3 个字符
CREATE VIRTUAL TABLE news_fts USING fts5(
  title, summary_zh, summary,
  content='news_items', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER news_fts_ai AFTER INSERT ON news_items BEGIN
  INSERT INTO news_fts(rowid, title, summary_zh, summary)
  VALUES (new.id, new.title, new.summary_zh, new.summary);
END;
CREATE TRIGGER news_fts_ad AFTER DELETE ON news_items BEGIN
  INSERT INTO news_fts(news_fts, rowid, title, summary_zh, summary)
  VALUES ('delete', old.id, old.title, old.summary_zh, old.summary);
END;
CREATE TRIGGER news_fts_au AFTER UPDATE OF title, summary_zh, summary ON news_items BEGIN
  INSERT INTO news_fts(news_fts, rowid, title, summary_zh, summary)
  VALUES ('delete', old.id, old.title, old.summary_zh, old.summary);
  INSERT INTO news_fts(rowid, title, summary_zh, summary)
  VALUES (new.id, new.title, new.summary_zh, new.summary);
END;

-- 日报
CREATE TABLE digests (
  date       TEXT PRIMARY KEY,               -- YYYY-MM-DD（MYT）
  content_md TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);

-- 对话里加的信源（与 config/feeds.yaml 合并；yaml 是基线）
CREATE TABLE config_feeds (
  id         INTEGER PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,
  name       TEXT,
  feed_group TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'T2',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 对话里加的屏蔽词（与 config/filters.yaml 的 block 合并）
CREATE TABLE muted_keywords (
  word       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 对话历史（阶段 3 使用）：每次写入后裁剪到最近 20 轮
CREATE TABLE chat_history (
  id         INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  role       TEXT    NOT NULL,               -- user | assistant | tool
  content    TEXT,
  tool_calls TEXT,                           -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_chat ON chat_history(chat_id, id);

-- Telegram webhook 重试去重（阶段 3 使用）
CREATE TABLE tg_updates (
  update_id  INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 每次运行的统计
CREATE TABLE runs (
  id          INTEGER PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  stats       TEXT,                          -- JSON
  error       TEXT
);
