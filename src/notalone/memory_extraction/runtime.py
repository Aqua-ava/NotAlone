"""记忆提取运行时的内部契约。"""

from __future__ import annotations

from typing import Any, Protocol, TypeAlias

from notalone.memory_extraction.models import ExtractionWindow

# 运行时返回未经外壳校验的原始候选；字段级解析与拒绝由确定性外壳逐条执行。
ExtractionPayload: TypeAlias = tuple[dict[str, Any], ...]


class MemoryExtractionRuntime(Protocol):
    """把一个消息窗口蒸馏为结构化事实候选的模型运行时 seam。"""

    def extract(self, window: ExtractionWindow) -> ExtractionPayload: ...
