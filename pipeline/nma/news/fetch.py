"""信源加载与并发抓取。单源失败不影响整体。"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import feedparser
import httpx

from ..db import Database
from . import normalize
from .simhash import simhash

log = logging.getLogger(__name__)

USER_AGENT = "Mozilla/5.0 (compatible; NewsDigestBot/1.0; +https://github.com)"
SUMMARY_MAX = 500


@dataclass
class FeedSource:
    name: str
    url: str
    group: str
    tier: str = "T2"
    original_link: bool = False  # 聚合站：从摘要里取第一个站外链接作为原文链接


@dataclass
class Item:
    url: str
    url_hash: str
    title: str
    summary: str
    source: str
    group: str
    tier: str
    published_at: int
    simhash: int


def load_sources(feeds_cfg: dict, db: Database | None = None) -> list[FeedSource]:
    """合并 feeds.yaml 和 D1 config_feeds（对话里加的源）。同一 URL 只保留一次。"""
    rsshub = (feeds_cfg.get("rsshub_base") or "https://rsshub.app").rstrip("/")
    out: dict[str, FeedSource] = {}

    def add(name: str, url: str, group: str, tier: str, original_link: bool = False) -> None:
        url = (url or "").strip()
        if url.startswith("rsshub:"):
            url = rsshub + "/" + url[len("rsshub:"):].lstrip("/")
        if url and url not in out:
            out[url] = FeedSource(name=name or url, url=url, group=group, tier=tier or "T2",
                                  original_link=bool(original_link))

    for group, gcfg in (feeds_cfg.get("groups") or {}).items():
        for f in (gcfg or {}).get("feeds") or []:
            add(f.get("name"), f.get("url"), group, f.get("tier", "T2"), f.get("original_link", False))

    if db is not None:
        try:
            rows = db.query("SELECT name, url, feed_group, tier FROM config_feeds WHERE enabled = 1")
        except Exception as e:  # 动态配置读失败时只用 yaml
            log.warning("读取 config_feeds 失败，只用 feeds.yaml: %s", e)
            rows = []
        for r in rows:
            add(r.get("name"), r["url"], r["feed_group"], r.get("tier") or "T2")
    return list(out.values())


async def _fetch_one(client: httpx.AsyncClient, sem: asyncio.Semaphore, src: FeedSource,
                     timeout: float) -> tuple[FeedSource, bytes | None, str | None, str]:
    """返回 (源, 内容, 错误, Content-Type)。"""
    async with sem:
        try:
            r = await asyncio.wait_for(client.get(src.url, follow_redirects=True), timeout)
            if r.status_code != 200:
                return src, None, f"HTTP {r.status_code}", ""
            return src, r.content, None, r.headers.get("content-type", "")
        except asyncio.TimeoutError:
            return src, None, "timeout", ""
        except httpx.HTTPError as e:
            return src, None, type(e).__name__, ""


async def fetch_all(sources: list[FeedSource], timeout: float = 10.0, concurrency: int = 10):
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"},
        timeout=timeout,
    ) as client:
        return await asyncio.gather(*[_fetch_one(client, sem, s, timeout) for s in sources])


def parse_feed(src: FeedSource, content: bytes, window_hours: int, now: float | None = None,
               content_type: str = "") -> list[Item]:
    now = time.time() if now is None else now
    # 把 HTTP Content-Type 交给 feedparser：有的站（如 Bernama）HTTP 头写 UTF-8、XML 声明却写 ISO-8859-1，
    # 按规范以 HTTP 头为准；不传的话 feedparser 只看 XML 声明，标题里的 ’ 会变成 â€™
    parsed = feedparser.parse(content, response_headers={"content-type": content_type} if content_type else None)
    items: list[Item] = []
    for e in parsed.entries:
        link = e.get("link") or ""
        title = normalize.clean_text(e.get("title"))
        if not link or not title:
            continue
        published = normalize.entry_timestamp(e, now)
        if not normalize.within_window(published, window_hours, now):
            continue
        publisher = ((e.get("source") or {}).get("title") or "").strip() or None
        title = normalize.strip_publisher_suffix(title, publisher)
        raw_summary = e.get("summary") or e.get("description") or ""
        summary = normalize.clean_text(raw_summary, SUMMARY_MAX)
        if summary == title:
            summary = ""
        if src.original_link:
            link = normalize.first_external_link(raw_summary, link) or link
        url = normalize.canonicalize_url(link)
        items.append(Item(
            url=url,
            url_hash=normalize.url_hash(url),
            title=title,
            summary=summary,
            source=publisher or src.name,
            group=src.group,
            tier=src.tier,
            published_at=published,
            simhash=simhash(title, summary),
        ))
    return items


def fetch_items(sources: list[FeedSource], window_hours: int, timeout: float = 10.0,
                concurrency: int = 10) -> tuple[list[Item], list[str]]:
    """抓取所有源，返回（窗口内条目，失败源描述列表）。"""
    results = asyncio.run(fetch_all(sources, timeout, concurrency))
    items: list[Item] = []
    failures: list[str] = []
    for src, content, err, content_type in results:
        if err:
            failures.append(f"{src.name}: {err}")
            continue
        try:
            items.extend(parse_feed(src, content, window_hours, content_type=content_type))
        except Exception as e:  # 单个 feed 解析异常不影响整体
            failures.append(f"{src.name}: parse {type(e).__name__}")
    return items, failures
