"""64 位 SimHash，用于近似判重（同一事件的不同报道）。

分词：英文按单词（小写、去停用词），中文按相邻两字（bigram），中英混排都能处理。
默认只用标题：实测 564 条真实条目，标题 + 摘要只能找出 2 对重复，只用标题能找出 19 对，
且没有误判。原因是不同来源的摘要措辞差异太大，会把同一事件的距离拉开。
需要时可以把下面的 SUMMARY_WEIGHT 改成 1，给摘要一个小权重。
"""
from __future__ import annotations

import hashlib
import re
from collections import Counter

BITS = 64
TITLE_WEIGHT = 1
SUMMARY_WEIGHT = 0  # 默认不用摘要，见模块说明
SUMMARY_MAX_CHARS = 300

_WORD_RE = re.compile(r"[a-z0-9]+(?:[.'][a-z0-9]+)*")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")

STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with",
    "by", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this",
    "that", "these", "those", "will", "has", "have", "had", "not", "no", "can", "could",
    "would", "should", "may", "after", "over", "into", "about", "than", "more", "new",
    "says", "said", "how", "why", "what", "who", "when", "you", "your", "we", "our",
    "they", "their", "he", "she", "his", "her", "up", "out", "s",
}


def tokenize(text: str) -> list[str]:
    text = (text or "").lower()
    tokens = [w for w in _WORD_RE.findall(text) if w not in STOPWORDS and len(w) > 1]
    for run in _CJK_RE.findall(text):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens


def _hash64(token: str) -> int:
    return int.from_bytes(hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest(), "big")


def simhash(title: str, summary: str = "", summary_weight: int | None = None) -> int:
    sw = SUMMARY_WEIGHT if summary_weight is None else summary_weight
    weights: Counter[str] = Counter()
    for t in tokenize(title):
        weights[t] += TITLE_WEIGHT
    if sw:
        for t in tokenize((summary or "")[:SUMMARY_MAX_CHARS]):
            weights[t] += sw
    if not weights:
        return 0
    v = [0] * BITS
    for token, w in weights.items():
        h = _hash64(token)
        for i in range(BITS):
            v[i] += w if (h >> i) & 1 else -w
    out = 0
    for i in range(BITS):
        if v[i] > 0:
            out |= 1 << i
    return out


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def to_hex(h: int) -> str:
    return format(h, "016x")


def from_hex(s: str) -> int:
    return int(s, 16)


class SimIndex:
    """在一组已知 simhash 中查找近似重复。用 4 段 16 位分桶加速：
    距离 ≤ 3 的两个 hash，必有至少一段完全相同（鸽巢原理）。"""

    def __init__(self, max_distance: int = 3):
        if max_distance > 3:
            # 分 4 段只保证 ≤3 的召回；更大距离退化为全量比较
            self._bucketed = False
        else:
            self._bucketed = True
        self.max_distance = max_distance
        self._buckets: dict[tuple[int, int], list[tuple[int, object]]] = {}
        self._all: list[tuple[int, object]] = []

    @staticmethod
    def _bands(h: int) -> list[tuple[int, int]]:
        return [(i, (h >> (16 * i)) & 0xFFFF) for i in range(4)]

    def add(self, h: int, key: object) -> None:
        self._all.append((h, key))
        for band in self._bands(h):
            self._buckets.setdefault(band, []).append((h, key))

    def find(self, h: int) -> object | None:
        """返回距离最近且 ≤ max_distance 的 key；没有则 None。"""
        if h == 0:
            return None
        candidates = (
            (c for band in self._bands(h) for c in self._buckets.get(band, ()))
            if self._bucketed
            else iter(self._all)
        )
        best_key, best_d = None, self.max_distance + 1
        for other, key in candidates:
            if other == 0:
                continue
            d = hamming(h, other)
            if d < best_d:
                best_key, best_d = key, d
        return best_key
