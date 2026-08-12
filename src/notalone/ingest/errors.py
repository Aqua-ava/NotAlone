"""导入预览错误。"""

from __future__ import annotations


class ImportPreviewError(ValueError):
    """可安全展示、且不包含消息正文的导入错误。"""
