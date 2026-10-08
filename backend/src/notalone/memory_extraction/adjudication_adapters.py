"""写入裁决的 LangChain 结构化输出 adapter。"""

from __future__ import annotations

from typing import Any

from langchain_core.language_models import BaseChatModel

from notalone.memory_extraction.adjudication import (
    AdjudicationAction,
    AdjudicationDecision,
    SimilarMemory,
)
from notalone.memory_extraction.errors import (
    ExtractionInvalidOutputError,
    ExtractionRuntimeError,
)


ADJUDICATION_SYSTEM_PROMPT = """你裁决一条新的记忆事实与已有相似记忆的关系，四选一：
add    = 全新事实，与旧记忆无关。
update = 新旧是同一事件的演变，新事实取代旧记忆（例：旧的"在减肥"，新的"开始增肌"）。
noop   = 新旧说的是同一件事，没有新信息。
keep   = 相关但不同的事实，两条都应保留（例："不吃香菜"与"在减肥"）。
选 update 时必须给出被取代旧记忆的 memory_id。只输出裁决结果。"""

ADJUDICATION_SCHEMA: dict[str, Any] = {
    "title": "MemoryAdjudicationOutput",
    "description": "记忆写入裁决结果；必须以结构化工具调用返回。",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {
            "description": "裁决动作四选一。",
            "type": "string",
            "enum": [item.value for item in AdjudicationAction],
        },
        "replaced_memory_id": {
            "description": "仅 update 时填写被取代旧记忆的 memory_id，其余为 null。",
            "anyOf": [{"type": "string"}, {"type": "null"}],
        },
    },
    "required": ["action", "replaced_memory_id"],
}


class LangChainAdjudicationRuntime:
    """把候选与相似旧记忆交模型裁决；解析失败视为运行失败。"""

    __slots__ = ("_model",)

    def __init__(self, *, model: BaseChatModel) -> None:
        if model is None:
            raise TypeError("必须显式注入模型。")
        self._model = model

    def adjudicate(
        self, *, candidate_text: str, similar: tuple[SimilarMemory, ...]
    ) -> AdjudicationDecision:
        try:
            bound = self._model.bind_tools([ADJUDICATION_SCHEMA])
            message = bound.invoke(
                [
                    {"role": "system", "content": ADJUDICATION_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": _adjudication_text(candidate_text, similar),
                    },
                ]
            )
        except ExtractionRuntimeError:
            raise
        except Exception as error:
            raise ExtractionRuntimeError("裁决模型调用失败。") from error
        tool_calls = getattr(message, "tool_calls", None)
        if not tool_calls:
            raise ExtractionInvalidOutputError("裁决模型未返回结构化结果。")
        args = tool_calls[0].get("args")
        if not isinstance(args, dict) or "action" not in args:
            raise ExtractionInvalidOutputError("裁决模型未返回结构化结果。")
        try:
            action = AdjudicationAction(args["action"])
        except ValueError as error:
            raise ExtractionInvalidOutputError("裁决动作非法。") from error
        replaced_raw = args.get("replaced_memory_id")
        replaced = None
        if replaced_raw is not None:
            from uuid import UUID

            try:
                replaced = UUID(str(replaced_raw))
            except ValueError as error:
                raise ExtractionInvalidOutputError("被取代记忆 ID 非法。") from error
        usage = getattr(message, "usage_metadata", None) or {}
        return AdjudicationDecision(
            action=action,
            replaced_memory_id=replaced,
            model_name=getattr(self._model, "model_name", None),
            input_tokens=usage.get("input_tokens")
            if isinstance(usage, dict)
            else None,
            output_tokens=usage.get("output_tokens")
            if isinstance(usage, dict)
            else None,
        )


def _adjudication_text(
    candidate_text: str, similar: tuple[SimilarMemory, ...]
) -> str:
    lines = [f"新事实：{candidate_text}", "", "已有相似记忆："]
    for item in similar:
        lines.append(f"- [memory_id={item.memory_id}] {item.text}")
    return "\n".join(lines)
