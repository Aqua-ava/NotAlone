"""JSONL 文件读取适配层。

这里仅负责文件 I/O、UTF-8 解码和逐行 JSON 解析，不判断联系人或消息业务规则。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from notalone.ingest.errors import ImportPreviewError


# 读取成功后把路径、指纹和全部记录捆绑成一个不可变结果。
@dataclass(frozen=True, slots=True)
class JsonlDocument:
    """完整读取并解析后的 JSONL 文档。"""

    path: Path
    content_sha256: str
    # tuple[dict[str, Any], ...] 表示“由任意多个字典组成的 tuple”。
    # str 是 JSON 对象的字段名；Any 表示不同字段的值类型可以不同。
    records: tuple[dict[str, Any], ...]


def read_jsonl(path: Path) -> JsonlDocument:
    """完整读取 JSONL；任一行失败时不返回部分结果。

    参数 ``path`` 是待读取文件的路径。成功时返回 ``JsonlDocument``；读取、编码或
    任一行 JSON 失败时抛出 ``ImportPreviewError``。
    """
    # 先读取原始 bytes，既便于严格按 UTF-8 解码，也能对原始文件计算稳定指纹。
    try:
        content = path.read_bytes()
    except OSError as error:
        raise ImportPreviewError("无法读取指定文件。") from error

    # JSONL 约定使用 UTF-8；不静默猜测其他编码，避免正文被错误解码后继续导入。
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ImportPreviewError("文件不是有效的 UTF-8 文本。") from error

    # 先在内存中收集所有记录。只有整份文件都通过，函数最后才返回结果。
    records: list[dict[str, Any]] = []
    # enumerate 同时给出序号和值；start=1 让序号与编辑器中的实际行号一致。
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            raise ImportPreviewError(f"第 {line_number} 行为空行。")
        # json.loads 把当前行的 JSON 文本转换成 Python 对象。
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ImportPreviewError(
                f"第 {line_number} 行不是有效 JSON。"
            ) from error
        # JSON 顶层也可能是数组、字符串或数字；本格式明确要求每行都是对象。
        if not isinstance(record, dict):
            raise ImportPreviewError(f"第 {line_number} 行必须是 JSON 对象。")
        records.append(record)

    if not records:
        raise ImportPreviewError("文件不包含任何消息记录。")

    return JsonlDocument(
        path=path,
        # hexdigest() 返回 64 位十六进制字符串，而不是原始二进制摘要。
        content_sha256=hashlib.sha256(content).hexdigest(),
        # 对外暴露 tuple，防止调用方对读取结果执行 append 或删除记录。
        records=tuple(records),
    )
