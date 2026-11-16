import time

import pytest

from nma.news.normalize import (
    canonicalize_url, clean_text, entry_timestamp, first_external_link,
    strip_publisher_suffix, strip_section_suffix, url_hash, within_window,
)


@pytest.mark.parametrize("a,b", [
    # http/https、www、末尾斜杠、fragment
    ("http://www.example.com/post/1/", "https://example.com/post/1"),
    ("https://Example.COM/post/1#comments", "https://example.com/post/1"),
    # 追踪参数
    ("https://example.com/a?utm_source=rss&utm_medium=feed&id=3", "https://example.com/a?id=3"),
    ("https://example.com/a?fbclid=xyz&gclid=1&ref=hn", "https://example.com/a"),
    ("https://example.com/a?UTM_Campaign=x", "https://example.com/a"),
    # 参数排序
    ("https://example.com/a?b=2&a=1", "https://example.com/a?a=1&b=2"),
    # 默认端口、重复斜杠、index.html
    ("https://example.com:443//a//b/index.html", "https://example.com/a/b"),
    # BBC 的 at_* 参数
    ("https://www.bbc.co.uk/news/articles/abc?at_campaign=rss&at_medium=RSS", "https://bbc.co.uk/news/articles/abc"),
    # 根路径
    ("https://example.com/", "https://example.com"),
    # Google News 的 oc/hl 参数
    ("https://news.google.com/rss/articles/CBMiXX?oc=5&hl=en", "https://news.google.com/rss/articles/CBMiXX"),
])
def test_canonicalize_equivalent(a, b):
    assert canonicalize_url(a) == b


def test_canonicalize_keeps_meaningful_params_and_ports():
    assert canonicalize_url("https://example.com/watch?v=abc") == "https://example.com/watch?v=abc"
    assert canonicalize_url("http://example.com:8080/x") == "https://example.com:8080/x"


def test_canonicalize_non_http_and_empty():
    assert canonicalize_url("") == ""
    assert canonicalize_url("mailto:a@b.com") == "mailto:a@b.com"
    assert canonicalize_url("//cdn.example.com/x/") == "https://cdn.example.com/x"


def test_url_hash_stable_and_distinct():
    h1 = url_hash(canonicalize_url("http://www.example.com/a/?utm_source=x"))
    h2 = url_hash(canonicalize_url("https://example.com/a"))
    assert h1 == h2 and len(h1) == 16
    assert url_hash("https://example.com/b") != h1


def test_clean_text():
    raw = "<p>Hello&nbsp;<b>world</b></p><script>alert(1)</script>\n\n  &amp; more"
    assert clean_text(raw) == "Hello world & more"
    assert clean_text("a" * 20, max_len=10) == "a" * 9 + "…"
    assert clean_text(None) == ""


def test_first_external_link():
    html = ('<p>摘要</p><p>🔗 <a href="https://aihot.news/x">站内</a> '
            '<a href="https://nvidianews.nvidia.com/news/a?x=1&amp;y=2">原文</a></p>')
    assert first_external_link(html, "https://aihot.news/items/1") == "https://nvidianews.nvidia.com/news/a?x=1&y=2"
    assert first_external_link("<p>no link</p>", "https://aihot.news/items/1") is None


def test_strip_publisher_suffix():
    assert strip_publisher_suffix("Big news - Reuters", "Reuters") == "Big news"
    assert strip_publisher_suffix("Big news - Reuters", None) == "Big news - Reuters"


def test_entry_timestamp_and_window():
    now = 1_800_000_000
    old = time.gmtime(now - 72 * 3600)
    assert entry_timestamp({"published_parsed": old}, now) == now - 72 * 3600
    assert entry_timestamp({}, now) == now                                          # 无时间 → now
    assert entry_timestamp({"updated_parsed": time.gmtime(now + 999)}, now) == now  # 未来 → now
    assert not within_window(now - 72 * 3600, 48, now)
    assert within_window(now - 47 * 3600, 48, now)


def test_strip_section_suffix():
    assert strip_section_suffix("水疗中心董事涉拖欠8.9万SST 面对12控状皆不认罪 - 国内 - 即时国内") == \
        "水疗中心董事涉拖欠8.9万SST 面对12控状皆不认罪"
    assert strip_section_suffix("印尼林火波及邻国 普拉博沃向马新致歉 | 国内") == "印尼林火波及邻国 普拉博沃向马新致歉"
    assert strip_section_suffix("GDP成绩周三出炉 大马经济料延续强势 | e南洋") == "GDP成绩周三出炉 大马经济料延续强势"
    # 不动：英文标题、没有空格的连字符、去完太短的
    assert strip_section_suffix("Big news - Reuters") == "Big news - Reuters"
    assert strip_section_suffix("马股扬0.34%至1588.03点") == "马股扬0.34%至1588.03点"
    assert strip_section_suffix("快讯 - 国内") == "快讯 - 国内"
