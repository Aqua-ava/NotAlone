"""导入预览错误。

单独定义异常类型后，命令行入口可以只捕获“预期内的导入错误”，而不会把编程错误也
伪装成普通文件错误。
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any


class ImportPreviewError(ValueError):
    """可安全展示、且不包含消息正文的导入错误。

    继承 ``ValueError`` 表示输入内容不符合约定。抛出这个异常时，消息只能包含行号、
    字段名和错误类别，不能拼接原始 JSON 或聊天正文。
    """

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        error_code: str = "input_invalid",
        fields: tuple[str, ...] = (),
        rule: str = "unspecified",
    ) -> None:
        super().__init__(message)
        line = re.search(r"第 (\d+) 行", message)
        self.details = details or {
            "capture_layer": "metadata_only",
            "record_text": None,
            "parsed": None,
            "capture_status": "withheld_unverified_input",
            "stage": "validation",
            "locator": f"jsonl:{line.group(1)}" if line else "document",
            "error_code": error_code,
            "fields": list(fields),
            "rule": "jsonl.validation." + rule,
            "failed_at": datetime.now(timezone.utc).isoformat(),
            "outcome": "input_rejected",
        }
