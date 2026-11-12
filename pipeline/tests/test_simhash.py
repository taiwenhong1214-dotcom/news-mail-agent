from nma.news.simhash import SimIndex, from_hex, hamming, simhash, to_hex, tokenize


def test_tokenize_mixed():
    toks = tokenize("OpenAI 发布新模型 GPT-6")
    assert "openai" in toks and "gpt" in toks and "发布" in toks and "模型" in toks
    assert "the" not in tokenize("The cat")


def test_identical_text_distance_zero():
    a = simhash("Kubernetes 1.36 released", "In-place pod resize goes GA")
    assert hamming(a, simhash("Kubernetes 1.36 released", "In-place pod resize goes GA")) == 0


def test_near_duplicate_within_threshold():
    # 同一标题，只有标点 / 空格差异（转载、聚合站常见）
    a = simhash("NVIDIA announces CEO transition: Jensen Huang steps down, Colette Kress named interim CEO")
    b = simhash("NVIDIA announces CEO transition - Jensen Huang steps down, Colette Kress named interim CEO")
    assert hamming(a, b) <= 3
    zh1 = simhash("英伟达宣布CEO变动：黄仁勋辞任，CFO克雷斯出任临时CEO")
    zh2 = simhash("英伟达宣布 CEO 变动：黄仁勋辞任，CFO 克雷斯出任临时 CEO！")
    assert hamming(zh1, zh2) <= 3


def test_same_title_different_summary_is_same_event():
    # 不同来源同一标题、摘要措辞不同：默认只看标题，判为同一事件
    title = "Anthropic files for IPO, Goldman Sachs and Morgan Stanley to lead offering"
    a = simhash(title, "Anthropic has filed a registration statement with the SEC.")
    b = simhash(title, "The AI lab confirmed the long-rumoured listing on Thursday, sources said.")
    assert hamming(a, b) == 0


def test_reordered_title_is_same_event():
    assert hamming(simhash("Nvidia CEO Jensen Huang resigns"),
                   simhash("Jensen Huang resigns as Nvidia CEO")) <= 3


def test_summary_weight_optional():
    title = "Kubernetes 1.36 released"
    assert simhash(title, "foo bar baz", summary_weight=1) != simhash(title, "")


def test_different_events_far_apart():
    a = simhash("Kubernetes 1.36 released with in-place pod resize")
    b = simhash("Bursa Malaysia closes higher on tech rally")
    assert hamming(a, b) > 10


def test_hex_roundtrip_full_64bit():
    h = (1 << 63) | 12345
    assert from_hex(to_hex(h)) == h and len(to_hex(h)) == 16


def test_index_finds_nearest_within_distance():
    idx = SimIndex(max_distance=3)
    base = simhash("Anthropic files for IPO with SEC, Goldman and Morgan Stanley lead")
    idx.add(base, "a")
    idx.add(simhash("Totally unrelated story about football"), "b")
    assert idx.find(base ^ 0b101) == "a"          # 距离 2
    assert idx.find(base ^ 0b1111) is None         # 距离 4
    assert idx.find(0) is None                     # 空文本不参与判重


def test_index_large_distance_falls_back_to_scan():
    idx = SimIndex(max_distance=6)
    idx.add(0xFFFF, "x")
    assert idx.find(0xFFFF ^ 0b111111) == "x"
