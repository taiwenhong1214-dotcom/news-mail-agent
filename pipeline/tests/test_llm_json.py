from nma.llm import extract_groups, extract_json_items, truncate, validate_scores

GOOD = {"id": 1, "score": 8, "category": "云原生", "summary_zh": "K8s 1.36 发布", "reason": "重要版本"}


def test_plain_object_with_items():
    assert extract_json_items('{"items": [{"id": 1}, {"id": 2}]}') == [{"id": 1}, {"id": 2}]


def test_bare_list():
    assert extract_json_items('[{"id": 1}, {"id": 2}]') == [{"id": 1}, {"id": 2}]


def test_code_fence_and_chatter():
    text = '好的，结果如下：\n```json\n{"items": [{"id": 1}, {"id": 2}]}\n```\n希望有帮助'
    assert len(extract_json_items(text)) == 2


def test_chatter_without_fence_prefers_largest():
    text = '注意 {"note": "x"} 结果：[{"id": 1}, {"id": 2}, {"id": 3}] 完'
    assert [x["id"] for x in extract_json_items(text)] == [1, 2, 3]


def test_trailing_commas():
    assert len(extract_json_items('{"items": [{"id": 1,}, {"id": 2},],}')) == 2


def test_truncated_output_rescues_complete_objects():
    text = '{"items": [{"id": 1, "score": 7}, {"id": 2, "score": 5}, {"id": 3, "sco'
    assert [x["id"] for x in extract_json_items(text)] == [1, 2]


def test_braces_inside_strings():
    text = '[{"id": 1, "summary_zh": "包含 } 和 ] 的字符串"}]'
    assert extract_json_items(text)[0]["summary_zh"] == "包含 } 和 ] 的字符串"


def test_garbage_returns_empty():
    for bad in ("", "   ", "抱歉，我无法完成", "null", "42", '"string"', "{not json"):
        assert extract_json_items(bad) == []


def test_single_object():
    assert extract_json_items('{"id": 5, "score": 3}') == [{"id": 5, "score": 3}]


def test_validate_scores_filters_and_normalizes():
    items = [
        GOOD,
        {"id": "2", "score": "11", "category": "未知分类", "summary_zh": "x" * 100, "reason": "r" * 50},
        {"id": 3, "score": "abc", "summary_zh": "s"},       # 分数非法
        {"id": 4, "score": 5, "summary_zh": ""},            # 摘要为空
        {"id": 99, "score": 5, "summary_zh": "s"},          # 不在本批
        {"id": 1, "score": 2, "summary_zh": "重复 id"},      # 重复，保留第一个
        {"score": 5, "summary_zh": "无 id"},
        {"id": 5, "score": float("nan"), "summary_zh": "s"},
        {"id": 6, "score": -3, "category": "云原生", "summary_zh": "负分"},
    ]
    out = validate_scores(items, {1, 2, 3, 4, 5, 6}, ["云原生", "国际"], {2: "国际"})
    assert set(out) == {1, 2, 6}
    assert out[1]["score"] == 8.0 and out[1]["category"] == "云原生"
    assert out[2]["score"] == 10.0                 # 截到上限
    assert out[2]["category"] == "国际"             # 非法分类 → 回退到分组
    assert len(out[2]["summary_zh"]) <= 61 and len(out[2]["reason"]) <= 31
    assert out[6]["score"] == 0.0


def test_truncate():
    assert truncate("  a\n b  ", 10) == "a b"
    assert truncate("abcdef", 3) == "abc…"
    assert truncate(None, 3) == ""


def test_extract_groups():
    valid = {1, 2, 3, 4, 5}
    assert extract_groups('{"groups": [[1, 2], [3, 4, 5]]}', valid) == [[1, 2], [3, 4, 5]]
    # 代码块包裹、字符串 id、非法 id、重复 id、单元素组
    text = '```json\n{"groups": [["1", 2, 99], [2, 3], [4], [5, 5]]}\n```'
    assert extract_groups(text, valid) == [[1, 2]]
    assert extract_groups("没有分组", valid) == []
    assert extract_groups('{"groups": "bad"}', valid) == []
    assert extract_groups("[[1, 3]]", valid) == [[1, 3]]
