"""记忆提取的 LangChain 结构化输出运行时 adapter。"""

from __future__ import annotations

from typing import Any

from langchain_core.language_models import BaseChatModel

from notalone.memory.models import MemoryCategory
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.models import ExtractionWindow, MemoryTopic
from notalone.memory_extraction.runtime import ExtractionPayload


EXTRACTION_SYSTEM_PROMPT = """你从一位联系人的聊天消息窗口中提取长期关系事实。
必须结合上下文理解语气：反讽、玩笑、抱怨不能按字面理解，如"你可真行啊"不是赞赏。
每条事实必须标注主体：这件事是谁的（self=用户本人，contact=联系人，shared=双方共同），
消息的发送者标注是判断依据，不得把用户自己说的内容记成联系人的事。
只提取值得跨对话长期记住的关系事实；负例——以下内容不产生任何事实：
寒暄（"吃了吗""在吗"）、纯表情或语气词、一次性安排的细节、无法确认的猜测。
媒体占位文本（如"[图片]""[语音]"）只能推断发送行为偏好，不得推测消息内容。
每条事实的 source_message_ids 只能填写输入中标注的 message_id，没有引用不得产出事实。
"""

EXTRACTION_SCHEMA: dict[str, Any] = {
    "title": "MemoryExtractionOutput",
    "description": "从消息窗口提取的关系事实列表；必须以结构化工具调用返回。",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "facts": {
            "description": (
                "事实对象数组。每项必须是对象并包含全部字段；"
                "没有可提取的事实时为空数组；禁止使用字符串代替对象。"
            ),
            "type": "array",
            "items": {
                "type": "object",
                "description": "一条带来源的关系事实。",
                "additionalProperties": False,
                "properties": {
                    "text": {
                        "description": "事实文本，例：他不爱发语音，爱直接打电话。",
                        "type": "string",
                    },
                    "category": {
                        "description": "五类分类之一。",
                        "type": "string",
                        "enum": [item.value for item in MemoryCategory],
                    },
                    "subject": {
                        "description": (
                            "事实主体：self（用户）、contact（联系人）、shared（共同）。"
                        ),
                        "type": "string",
                        "enum": ["self", "contact", "shared"],
                    },
                    "topic": {
                        "description": "受控主题，只用于缩小后续裁决范围。",
                        "type": "string",
                        "enum": [item.value for item in MemoryTopic],
                    },
                    "source_message_ids": {
                        "description": (
                            "支持该事实的消息 ID 数组，只能填输入中的 message_id。"
                        ),
                        "type": "array",
                        "minItems": 1,
                        "items": {"type": "string"},
                    },
                    "confidence": {
                        "description": "置信度，0 到 1 之间的小数。",
                        "type": "number",
                    },
                    "risk_flags": {
                        "description": (
                            "风险标记数组（转账/借款/健康/承诺/见面等），可为空。"
                        ),
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "valid_at": {
                        "description": "事实生效时间（ISO 8601），可为空。",
                        "anyOf": [{"type": "string"}, {"type": "null"}],
                    },
                    "invalid_at": {
                        "description": "事实失效时间（ISO 8601），可为空。",
                        "anyOf": [{"type": "string"}, {"type": "null"}],
                    },
                },
                "required": [
                    "text",
                    "category",
                    "subject",
                    "topic",
                    "source_message_ids",
                    "confidence",
                    "risk_flags",
                    "valid_at",
                    "invalid_at",
                ],
            },
        }
    },
    "required": ["facts"],
}


class LangChainExtractionRuntime:
    """把消息窗口交给模型，返回未经外壳校验的原始事实候选。"""

    __slots__ = ("_model",)

    def __init__(self, *, model: BaseChatModel) -> None:
        if model is None:
            raise TypeError("必须显式注入模型。")
        self._model = model

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        bound = self._model.bind_tools([EXTRACTION_SCHEMA])
        message = bound.invoke(
            [
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                {"role": "user", "content": _window_text(window)},
            ]
        )
        tool_calls = getattr(message, "tool_calls", None)
        if not tool_calls:
            raise ExtractionRuntimeError("模型未返回可解析的结构化事实。")
        args = tool_calls[0].get("args")
        facts_payload = args.get("facts") if isinstance(args, dict) else None
        if not isinstance(facts_payload, list):
            raise ExtractionRuntimeError("模型未返回可解析的结构化事实。")
        return tuple(
            item if isinstance(item, dict) else {"_invalid": item}
            for item in facts_payload
        )


def _window_text(window: ExtractionWindow) -> str:
    lines = [
        f"{index + 1}. [message_id={message.message_id}] "
        f"sender={message.sender.value}: {message.text}"
        for index, message in enumerate(window.messages)
    ]
    return "\n".join(lines)
