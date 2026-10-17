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
    GROUNDED_V3 = "grounded-v3"
    GROUNDED_V4 = "grounded-v4"

    @property
    def is_grounded(self) -> bool:
        return self is not EvaluationExtractionMode.LEGACY_E14


def extraction_contract(
    mode: EvaluationExtractionMode | str, window: ExtractionWindow,
    *, prompt_profile: str = "default",
) -> tuple[str, dict]:
    selected = EvaluationExtractionMode(mode)
    if (type(prompt_profile) is not str
            or selected is not EvaluationExtractionMode.GROUNDED_V4 and prompt_profile != "default"):
        raise ValueError("提取提示profile只适用于显式v4。")
    if selected is EvaluationExtractionMode.GROUNDED_V4:
        return grounded_adapter.grounded_v4_prompt(prompt_profile), grounded_adapter.grounded_schema_v4(window)
    if selected is EvaluationExtractionMode.GROUNDED_V3:
        return grounded_adapter.GROUNDED_V3_PROMPT, grounded_adapter.grounded_schema_v3(window)
    if selected is EvaluationExtractionMode.GROUNDED_V2:
        return grounded_adapter.GROUNDED_V2_PROMPT, grounded_adapter.grounded_schema(window)
    return adapters.EXTRACTION_SYSTEM_PROMPT, adapters.EXTRACTION_SCHEMA


def extraction_tool_name(mode: EvaluationExtractionMode | str) -> str:
    if EvaluationExtractionMode(mode) is EvaluationExtractionMode.GROUNDED_V4:
        return "GroundedMemoryLabelsV4"
    if EvaluationExtractionMode(mode) is EvaluationExtractionMode.GROUNDED_V3:
        return "GroundedMemoryLabelsV3"
    return ("GroundedMemoryLabels" if EvaluationExtractionMode(mode) is
            EvaluationExtractionMode.GROUNDED_V2 else "MemoryExtractionOutput")


def extraction_runtime(
    mode: EvaluationExtractionMode | str, model: BaseChatModel,
    *, prompt_profile: str = "default",
) -> MemoryExtractionRuntime:
    selected = EvaluationExtractionMode(mode)
    if (type(prompt_profile) is not str
            or selected is not EvaluationExtractionMode.GROUNDED_V4 and prompt_profile != "default"):
        raise ValueError("提取提示profile只适用于显式v4。")
    if selected is EvaluationExtractionMode.GROUNDED_V4:
        return grounded_adapter.GroundedV4ExtractionRuntime(model=model, prompt_profile=prompt_profile)
    if selected is EvaluationExtractionMode.GROUNDED_V3:
        return grounded_adapter.GroundedV3ExtractionRuntime(model=model)
    if selected is EvaluationExtractionMode.GROUNDED_V2:
        return grounded_adapter.GroundedV2ExtractionRuntime(model=model)
    return adapters.LangChainExtractionRuntime(model=model)
