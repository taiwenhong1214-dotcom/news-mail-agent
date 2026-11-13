-- v2：推送反馈 / 收藏、话题盯梢、周报、大马科技招聘字段

-- 每条新闻一行：👍/👎 互斥（vote），⭐ 收藏单独记（saved_at）
CREATE TABLE feedback (
  item_id    INTEGER PRIMARY KEY,            -- news_items.id
  vote       INTEGER,                        -- 1 = 👍，-1 = 👎，NULL = 没投
  saved_at   INTEGER,                        -- ⭐ 收藏时间；NULL = 没收藏
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_saved ON feedback(saved_at);
CREATE INDEX idx_feedback_updated ON feedback(updated_at);

-- 话题盯梢：命中就推送，不看分数阈值（流水线 push 阶段匹配）
CREATE TABLE watches (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,              -- 用户说的话题，如「Google 大马数据中心」
  keywords    TEXT    NOT NULL,              -- JSON 数组；每个元素是一组空格分隔的词，组内全部命中才算命中，任一组命中即可
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER
);

-- 周报等定期报告（不放 digests 表：那张表的 date 是 YYYY-MM-DD，/digest 按 date 排序取最新）
CREATE TABLE reports (
  key        TEXT PRIMARY KEY,               -- 例如 weekly:2026-11-15（周日日期，MYT）
  content    TEXT NOT NULL,                  -- Telegram HTML
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);

-- 打分时顺带抽取的大马科技招聘 / 裁员 / 投资信息（JSON，大多数条目为 NULL）
ALTER TABLE news_items ADD COLUMN jobs TEXT;
