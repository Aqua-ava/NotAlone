"""评测显式选择生产结构协议或旧十四槽；不改写实际模型输出。"""

from __future__ import annotations

from enum import StrEnum

from langchain_core.language_models import BaseChatModel

from . import adapters, grounded_adapter
from .models import ExtractionWindow
from .runtime import MemoryExtractionRuntime


class EvaluationExtractionMode(StrEnum):
    LEGACY_E14 = "legacy-e14"
    GROUNDED_V2 = "grounded-v2"


def extraction_contract(
    mode: EvaluationExtractionMode | str, window: ExtractionWindow,
) -> tuple[str, dict]:
    selected = EvaluationExtractionMode(mode)
    if selected is EvaluationExtractionMode.GROUNDED_V2:
        return grounded_adapter.GROUNDED_PROMPT, grounded_adapter.grounded_schema(window)
    return adapters.EXTRACTION_SYSTEM_PROMPT, adapters.EXTRACTION_SCHEMA


def extraction_tool_name(mode: EvaluationExtractionMode | str) -> str:
    return ("GroundedMemoryLabels" if EvaluationExtractionMode(mode) is
            EvaluationExtractionMode.GROUNDED_V2 else "MemoryExtractionOutput")


def extraction_runtime(
    mode: EvaluationExtractionMode | str, model: BaseChatModel,
) -> MemoryExtractionRuntime:
    if EvaluationExtractionMode(mode) is EvaluationExtractionMode.GROUNDED_V2:
        return grounded_adapter.GroundedExtractionRuntime(model=model)
    return adapters.LangChainExtractionRuntime(model=model)
