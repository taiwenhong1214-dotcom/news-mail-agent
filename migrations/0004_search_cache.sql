-- 联网搜索结果缓存：同样的搜索几小时内不再调 Tavily（免费额度每月 1000 次）
CREATE TABLE search_cache (
  key        TEXT PRIMARY KEY,               -- topic|time_range|max_results|规范化后的搜索词
  result     TEXT    NOT NULL,               -- 返回给 LLM 的 JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_search_cache_created ON search_cache(created_at);
