from nma.news.prefilter import build_rules, check

CFG = {
    "title": {"min_len": 8, "max_len": 100},
    "block": ["sponsored", "优惠券"],
    "ad_patterns": [r"(?i)\b\d+% off\b"],
    "require_any": {"my-jobs": ["hiring", "job", "招聘"]},
}


def test_title_length():
    r = build_rules(CFG)
    assert check("short", "", "devops", r) == "title_too_short"
    assert check("x" * 101, "", "devops", r) == "title_too_long"


def test_block_words_case_insensitive_and_muted():
    r = build_rules(CFG, muted_words=["crypto"])
    assert check("Sponsored: great tool for you", "", "devops", r) == "block:sponsored"
    assert check("双十一优惠券大放送啦啦啦", "", "devops", r) == "block:优惠券"
    assert check("Crypto market crashes again today", "", "finance", r) == "block:crypto"


def test_word_boundary_for_english():
    r = build_rules({"require_any": {"my-jobs": ["job"]}})
    assert check("Malaysia jobs report shows growth", "", "my-jobs", r) is None
    assert check("Enjoy the weekend in Penang today", "", "my-jobs", r) == "no_required_keyword"


def test_ad_pattern_and_require_any():
    r = build_rules(CFG)
    assert check("Get 50% off all cloud plans today", "", "devops", r) == "ad_pattern"
    assert check("Grab is hiring 500 engineers in KL", "", "my-jobs", r) is None
    assert check("Weather in KL will be sunny tomorrow", "summary", "my-jobs", r) == "no_required_keyword"
    assert check("Weather in KL will be sunny tomorrow", "", "devops", r) is None
    assert check("某公司宣布在吉隆坡扩张业务", "将招聘 300 人", "my-jobs", r) is None


def test_block_title_only_applies_to_its_group_and_title():
    r = build_rules({"block_title": {"games": ["guide:", "podcast", "how to get"]}})
    assert check("Guide: 13 PS5 games coming out next week", "", "games", r) == "title_block:guide:"
    assert check("Podcast: PlayStation's live service era", "", "games", r) == "title_block:podcast"
    assert check("GTA 6: how to get the Cheetah early", "", "games", r) == "title_block:how to get"
    # 只看标题：摘要里顺带提到不算；其他分组不受影响
    assert check("Ubisoft closes Toronto studio", "said on its podcast", "games", r) is None
    assert check("Podcast: Kubernetes 1.36 deep dive", "", "devops", r) is None
    # "guide:" 带冒号，guidelines 不会命中
    assert check("Steam updates content guidelines for AI games", "", "games", r) is None
