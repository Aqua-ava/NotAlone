"""记忆提取的内部错误类型。"""

from __future__ import annotations


class MemoryExtractionError(RuntimeError):
    """记忆提取链路的基础错误。"""


class ExtractionRuntimeError(MemoryExtractionError):
    """模型运行时未返回可解析的结构化事实。"""
