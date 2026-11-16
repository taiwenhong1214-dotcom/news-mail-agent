"""URL 规范化、文本清洗、时间解析。"""
from __future__ import annotations

import calendar
import hashlib
import html
import re
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# 任何站点都去掉的追踪参数
TRACKING_PARAMS = {
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid",
    "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "ref_src", "ref_url",
    "cmpid", "ocid", "sr_share", "guccounter", "guce_referrer", "guce_referrer_sig",
    "spm", "share_source", "s_cid", "icid", "__twitter_impression", "ref",
    "_ga", "_gl", "vero_id", "trk", "trkcampaign", "smid", "smtyp",
}
TRACKING_PREFIXES = ("utm_", "pk_", "hsa_", "mtm_", "at_")  # at_*：BBC 等用的 AT Internet
# 某些站点特有的追踪参数
HOST_TRACKING_PARAMS = {
    "news.google.com": {"oc", "hl", "gl", "ceid"},
    "www.youtube.com": {"si", "feature"},
}
DEFAULT_PORTS = {"http": 80, "https": 443}


def canonicalize_url(url: str) -> str:
    """规范化 URL，使同一篇文章的不同写法得到同一个字符串。

    - http 统一成 https，host 小写并去掉 www.，去掉默认端口
    - 去掉 utm_* 等追踪参数，剩余参数排序
    - 去掉 #fragment 和末尾斜杠
    """
    url = (url or "").strip()
    if not url:
        return ""
    if url.startswith("//"):
        url = "https:" + url
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        return url
    scheme = "https"

    host = (parts.hostname or "").lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    netloc = host
    if parts.port and parts.port not in DEFAULT_PORTS.values():
        netloc = f"{host}:{parts.port}"

    host_params = HOST_TRACKING_PARAMS.get(host, set()) | HOST_TRACKING_PARAMS.get("www." + host, set())
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not _is_tracking(k, host_params)
    ]
    query.sort()

    path = re.sub(r"/{2,}", "/", parts.path or "")
    if path.endswith("/"):
        path = path.rstrip("/")
    for suffix in ("/index.html", "/index.htm", "/index.php"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]

    return urlunsplit((scheme, netloc, path, urlencode(query), ""))


def _is_tracking(key: str, host_params: set[str]) -> bool:
    k = key.lower()
    return k in TRACKING_PARAMS or k in host_params or k.startswith(TRACKING_PREFIXES)


def url_hash(canonical_url: str) -> str:
    return hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()[:16]


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def clean_text(raw: str | None, max_len: int = 0) -> str:
    """去 HTML 标签、反转义、合并空白；可选截断。"""
    if not raw:
        return ""
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", raw)
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = _WS_RE.sub(" ", text).strip()
    if max_len and len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


_HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


def first_external_link(html_text: str, own_url: str) -> str | None:
    """从 HTML 摘要里找第一个和 own_url 不同站点的 http(s) 链接（聚合站取原文用）。"""
    own_host = (urlsplit(own_url).hostname or "").lower().removeprefix("www.")
    for href in _HREF_RE.findall(html_text or ""):
        href = html.unescape(href).strip()
        host = (urlsplit(href).hostname or "").lower().removeprefix("www.")
        if href.startswith(("http://", "https://")) and host and host != own_host:
            return href
    return None


def strip_publisher_suffix(title: str, publisher: str | None) -> str:
    """Google News 的标题形如 "Headline - Publisher"，去掉后缀便于判重。"""
    if publisher and title.endswith(" - " + publisher):
        return title[: -(len(publisher) + 3)].rstrip()
    return title


# 中文媒体（经 Google News）的标题常带栏目尾巴："... - 国内 - 即时国内"、"... | 财经"、"... | e南洋"。
# 每条都带同样的几个字，会让 SimHash 把不相关的标题拉近，也占打分 prompt 的位置。
# 只认两侧有空格的分隔符 + 不超过 6 个汉字（可带一个英文字母前缀）的短标签。
_SECTION_SUFFIX_RE = re.compile(r"(?:\s+[-|｜]\s+[A-Za-z]?[一-鿿]{1,6})+\s*$")


def strip_section_suffix(title: str) -> str:
    m = _SECTION_SUFFIX_RE.search(title)
    if not m:
        return title
    head = title[: m.start()].rstrip()
    return head if len(head) >= 4 else title  # 去完太短说明不是栏目标签，保留原样


def entry_timestamp(entry: dict, now: float | None = None) -> int:
    """取 feed 条目的发布时间（unix 秒）。没有时间的用当前时间；未来时间截到当前。"""
    now = time.time() if now is None else now
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        st = entry.get(key)
        if st:
            try:
                return int(min(calendar.timegm(st), now))
            except (TypeError, ValueError, OverflowError):
                continue
    return int(now)


def within_window(ts: int, window_hours: int, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    return now - ts <= window_hours * 3600
