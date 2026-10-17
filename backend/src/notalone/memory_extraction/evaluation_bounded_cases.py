"""原03有限真实15窗的公开合成输入；不调用模型、数据库或预算。"""
from __future__ import annotations

from typing import Any

from notalone.memory_extraction.evaluation_cases import EvaluationCase, ExpectedDestination

BOUNDED_RUNTIME_PLAN = "bounded-runtime15-v1"
BOUNDED_RUNTIME_REQUEST_LIMIT = 30
BOUNDED_RUNTIME_REFERENCE_PATH = (
    ".scratch/memory-accuracy-next/bounded-runtime-real15-reference-20261017.json"
)
BOUNDED_RUNTIME_ANNOTATION_PATH = (
    ".scratch/memory-accuracy-next/bounded-runtime-real15-plan-20261017.md"
)
BOUNDED_RUNTIME_DIMENSIONS = (
    "subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported",
)
BOUNDED_RUNTIME_CONTENT_FIELDS = (
    "sender", "text", "occurred_at", "message_type", "text_representation",
)

# 顺序即唯一正式执行顺序；最后一项只是原matcher的先验名义去向。
# 正式质量只按已封存RAW/FULL及九键Gold逐轴生成，不能用该名义值代签。
_SOURCE_ROWS = (
    ("P01", "作者刚刚到家", "observation", (("contact", "我刚刚到家。"),),
     None, "author_arrival", "auto"),
    ("P02", "跨消息明确指称借用", "observation", (
        ("contact", "这里的“她”指我哥。"),
        ("contact", "我姐前天把她的雨伞借给我了。")),
     None, "kin_lend", "auto"),
    ("P03", "异方同动词完成问答", "jsonl", (
        ("self", "你已到学校了吗？"), ("contact", "我已经到了。")),
     None, "completed_qa", "auto"),
    ("P04", "两角色目录内唯一指称", "observation", (
        ("contact", "这里提到我姐和我同事。"),
        ("contact", "这里的“她”指我同事。"),
        ("contact", "我姐昨天把她的书借给我了。")),
     None, "two_roles", "auto"),
    ("P05", "亲友提出请托的转述表示", "observation", (
        ("contact", "我姐昨天让我明天帮她顶个班。这里的“她”指我同事。"),),
     None, "reported_request", "pending"),
    ("P06", "本人收到请托的参与表示", "observation", (
        ("self", "我哥前天让我后天帮他顶个班。这里的“他”指我同事。"),),
     None, "received_request", "auto"),
    ("P07", "晴天条件及只约数量", "observation", (
        ("contact", "如果天晴，我计划明天只跑约3公里。"),),
     None, "conditional_plan", "pending"),
    ("N01", "声明作者与事件作者不同", "jsonl", (
        ("self", "这里的“她”指我哥。"),
        ("contact", "我姐前天把她的雨伞借给我了。")),
     {"from": "P02", "variable": "首条声明actual sender由contact改为self"},
     "unknown_cross_author", "pending"),
    ("N02", "声明出现在事件之后", "observation", (
        ("contact", "我姐前天把她的雨伞借给我了。"),
        ("contact", "这里的“她”指我哥。")),
     {"from": "P02", "variable": "声明与事件的时间顺序交换，原句不改"},
     "unknown_late_identity", "pending"),
    ("N03", "同代词竞争声明", "observation", (
        ("contact", "这里提到我姐和我同事。"),
        ("contact", "这里的“她”指我同事。这里的“她”指我姐。"),
        ("contact", "我姐昨天把她的书借给我了。")),
     {"from": "P04", "variable": "只增加一条同代词竞争声明"},
     "unknown_competition", "pending"),
    ("N04", "声明代词不匹配事件", "observation", (
        ("contact", "这里的“他”指我哥。"),
        ("contact", "我姐前天把她的雨伞借给我了。")),
     {"from": "P02", "variable": "仅声明的代词由她改为他"},
     "unknown_pronoun", "pending"),
    ("N05", "完整原消息有未覆盖尾句", "observation", (
        ("contact", "我刚刚到家。谢谢。"),),
     {"from": "P01", "variable": "仅追加完整礼貌尾句，不能裁掉"},
     "unknown_tail", "auto"),
    ("N06", "问答由同一作者发出", "observation", (
        ("contact", "你已到学校了吗？"), ("contact", "我已经到了。")),
     {"from": "P03", "variable": "只将问题actual sender由self改为contact"},
     "unknown_same_author_qa", "pending"),
    ("N07", "问答动词逐字不匹配", "jsonl", (
        ("self", "你已到学校了吗？"), ("contact", "我已经抵达了。")),
     {"from": "P03", "variable": "仅答案动词由到改为抵达"},
     "unknown_verb_qa", "pending"),
    ("N08", "跑步条件天气超出正证词法", "observation", (
        ("contact", "如果下雨，我计划明天只跑约3公里。"),),
     {"from": "P07", "variable": "仅条件天气由天晴改为下雨"},
     "unknown_weather", "pending"),
)

# Gold内容摘要只含messages五字段和target_indices；其余元数据单独冻结。
# 时间按数组位置递增，N02的顺序控制因而也在正式loader顺序中成立。
BOUNDED_RUNTIME_INPUTS: tuple[dict[str, Any], ...] = tuple({
    "id": identifier,
    "case_name": f"原03有限真实15/{identifier}/{name}",
    "source_route": route,
    "messages": tuple({
        "sender": sender, "text": text,
        "occurred_at": f"2030-01-02T20:{index:02d}:00+08:00",
        "message_type": "text", "text_representation": "text",
    } for index, (sender, text) in enumerate(messages)),
    "target_indices": tuple(range(len(messages))),
    "control": control,
    "delivery_goal": delivery_goal,
} for identifier, name, route, messages, control, delivery_goal, _ in _SOURCE_ROWS)

BOUNDED_RUNTIME_CASES: tuple[EvaluationCase, ...] = tuple(EvaluationCase(
    name=source["case_name"], dimension="bounded-runtime",
    messages=tuple((message["sender"], message["text"]) for message in source["messages"]),
    targets=source["target_indices"], expect=ExpectedDestination(row[-1]),
    note="仅本场固定公开输入；matcher原结果不作为正式逐轴质量。",
    expect_subject="self" if source["id"] == "P06" else "contact",
) for source, row in zip(BOUNDED_RUNTIME_INPUTS, _SOURCE_ROWS, strict=True))
