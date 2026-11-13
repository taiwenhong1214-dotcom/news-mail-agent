-- 流水线发出的推送消息：24 小时后自动删除（收藏过或点过 👍/👎 的保留），聊天记录不会越堆越长
CREATE TABLE sent_messages (
  message_id INTEGER PRIMARY KEY,            -- Telegram message_id（只有一个对话，不会重复）
  item_id    INTEGER,                        -- 单条推送对应的 news_items.id；快讯合集为 NULL
  kind       TEXT    NOT NULL,               -- push | watch | bundle
  sent_at    INTEGER NOT NULL
);
CREATE INDEX idx_sent_messages_sent ON sent_messages(sent_at);
