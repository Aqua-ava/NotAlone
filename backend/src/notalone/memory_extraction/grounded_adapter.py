"""一次模型标注原文分句，再由程序编译；不允许模型直接改写候选正文。"""
from __future__ import annotations

from copy import deepcopy
from typing import Any
from collections.abc import Iterable
from langchain_core.language_models import BaseChatModel

from notalone.memory_extraction.errors import ExtractionInvalidOutputError, ExtractionRuntimeError
from notalone.memory_extraction.grounded import KINDS, OMISSIONS, SENSITIVITY, compile_labels, source_units, needs_reference, reference_choices
from notalone.memory_extraction.models import ExtractionWindow, MemoryTopic
from notalone.memory_extraction.runtime import ExtractionPayload
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.context import record
from notalone.memory_trace.transport import invoke_traced_model

GROUNDED_PROMPT = """对同一联系人的原文分句进行结构化标注。只返回工具结构，不改写正文。
units是按工具预设字段填写的对象，每个target字段必填，不再输出unit编号；context 仅供理解，不单独输出。不能删除分句来掩盖不知道或未决定。
kind 表示本句所保存的阶段：
event=已完成普通动作；relationship_event=本人已参与的关系经历（含收到邀请、借用、赠予）；
reported_event=第三方历史经历；third_party_fact=第三方身份资料；assessment=针对具体事项的一次评价；
preference=有来源的长期偏好；taboo=长期禁忌；state=当前知情、决策或持续期未知的状态；
momentary_state=正在等待、路上等当天瞬时状态；plan=尚未实现的计划；hypothesis=假设；
request=暂时关系要求；correction=窗内有明确先前主张的更正；unknown=无法判断。
不能独立成立的时间/话题前缀（例如“前年冬天，”或“他现在的情况，”）用prefix，和紧邻的同消息事实合并。
纯条件前件用condition，紧邻其后的同消息动作必须用plan或hypothesis，程序会合并并保留条件。
question/greeting/nonliteral/not_memory是明确不提取的原因；说话者不知道他人情况是state，不是not_memory。
已完成动作与当前状态分别标注。已收到邀约是relationship_event，不额外产生一条未来参与计划。
subject为资料归属self/contact/shared，不能把第三人身份改成用户或联系人；其资料依原说话人范围保存。
topic只用受控主题；亲属历史用family，职业/职业知情用work，课程报名用study，价格判断可用finance。
dependency只选一条理解本句不可缺少的原文分句编号；可以是context或另一target。
相连问答已足够时不再引用更早的历史；不需要补全人物/事项时用null。若一条依赖不足以消歧，unresolved=true。
不确定的第三人指代unresolved=true，身份明确则false；不能从亲属性别推测说话者性别。
sensitivity只标原文实际的敏感风险：financial=真实金钱风险，health=健康，commitment=明确承诺，other=其他明确敏感性。
普通借用物品、报价判断、收到娱乐邀请本身不是敏感性，取none。不要增加原文没有的风险。
confidence是模型对标签的把握，不能代替证据。程序只保证定位、引用、字段组合与时间计算，不认证你的语义判断。
"""


def _enum(values: Iterable[str]) -> dict[str, Any]:
    return {"type": "string", "enum": sorted(values)}


GROUNDED_SCHEMA: dict[str, Any] = {
    "title": "GroundedMemoryDraft",
    "description": "原文分句标注；每个target恰好一条，禁止自由正文和日期。",
    "type": "object", "additionalProperties": False,
    "properties": {"units": {"type": "array", "maxItems": 512, "items": {
        "type": "object", "additionalProperties": False,
        "properties": {
            "unit": {"type": "string", "description": "输入中target的分句编号。"},
            "kind": _enum({*KINDS, *OMISSIONS, "condition", "prefix"}),
            "subject": _enum({"self", "contact", "shared"}),
            "topic": _enum({value.value for value in MemoryTopic}),
            "dependency": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "unresolved": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "sensitivity": _enum(SENSITIVITY),
        },
        "required": ["unit", "kind", "subject", "topic", "dependency", "unresolved", "confidence", "sensitivity"],
    }}},
    "required": ["units"],
}



def grounded_schema(window: ExtractionWindow) -> dict[str, Any]:
    """模型只填写已命名的原文位置；编号和依赖取值由当前窗口提供。"""
    units = source_units(window)
    properties = {}
    for unit in units:
        if not unit.target:
            continue
        label = deepcopy(GROUNDED_SCHEMA["properties"]["units"]["items"])
        del label["properties"]["unit"]
        label["required"].remove("unit")
        choices = [other.id for other in units if other.id != unit.id]
        label["properties"]["dependency"] = {"enum": [None, *choices]}
        if needs_reference(unit):
            anchors = reference_choices(unit, units)
            branches: list[dict[str, Any]] = [
                {"properties": {"unresolved": {"const": True}}},
                {"properties": {"kind": _enum(OMISSIONS)}},
            ]
            if anchors:
                branches.append({"properties": {"dependency": _enum(anchors)}})
            label["anyOf"] = branches
            label["description"] = (
                "此原句含第三人指代：保存事实且unresolved=false时，dependency必须选择先前的独立依据。"
                "找不到可靠依据就unresolved=true；不能用后面的回答或另一个裸指代自证。"
            )
        properties[unit.id] = label
    return {
        "title": "GroundedMemoryLabels",
        "description": "填写程序指定的每个原文位置，不生成编号，不改写正文。",
        "type": "object", "additionalProperties": False,
        "properties": {"units": {
            "type": "object", "properties": properties,
            "required": list(properties), "additionalProperties": False,
        }},
        "required": ["units"],
    }


def grounded_input(window: ExtractionWindow) -> str:
    lines = []
    for unit in source_units(window):
        at = unit.message.occurred_at
        lines.append(f"[{unit.id}] [{'target' if unit.target else 'context'}] "
                     f"sender={unit.message.sender.value} occurred_at={at.isoformat() if at else 'unknown'} "
                     f"原文={unit.text}")
    return "\n".join(lines)


class GroundedExtractionRuntime:
    """生产与测试共用的单次结构提取接缝，保留原14槽下游接口。"""
    def __init__(self, *, model: BaseChatModel) -> None:
        self._model = model

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        try:
            response = invoke_traced_model(
                self._model, purpose="extraction", schema=grounded_schema(window),
                messages=[{"role": "system", "content": GROUNDED_PROMPT},
                          {"role": "user", "content": grounded_input(window)}],
            )
        except (ExtractionRuntimeError, TraceWriteError):
            raise
        except Exception:
            raise ExtractionRuntimeError("原文结构提取调用失败。") from None
        calls = getattr(response, "tool_calls", None)
        if not isinstance(calls, list) or len(calls) != 1 or calls[0].get("name") != "GroundedMemoryLabels":
            raise ExtractionInvalidOutputError("原文结构提取必须返回唯一的指定工具。")
        draft = calls[0].get("args")
        record("grounded_draft", {"protocol": "grounded-v2", "units": source_units(window), "draft": draft})
        try:
            payloads = compile_labels(window, draft)
        except ExtractionInvalidOutputError:
            record("grounded_compile", {"status": "rejected", "protocol": "grounded-v2"}, status="rejected")
            raise
        record("grounded_compile", {"protocol": "grounded-v2", "status": "compiled", "payloads": payloads})
        return payloads
