"""JSONL 文件读取适配层。"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from notalone.ingest.errors import ImportPreviewError


@dataclass(frozen=True, slots=True)
class JsonlDocument:
    """完整读取并解析后的 JSONL 文档。"""

    path: Path
    content_sha256: str
    records: tuple[dict[str, Any], ...]


def read_jsonl(path: Path) -> JsonlDocument:
    """完整读取 JSONL；任一行失败时不返回部分结果。"""
    try:
        content = path.read_bytes()
    except OSError as error:
        raise ImportPreviewError("无法读取指定文件。") from error

    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ImportPreviewError("文件不是有效的 UTF-8 文本。") from error

    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            raise ImportPreviewError(f"第 {line_number} 行为空行。")
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ImportPreviewError(
                f"第 {line_number} 行不是有效 JSON。"
            ) from error
        if not isinstance(record, dict):
            raise ImportPreviewError(f"第 {line_number} 行必须是 JSON 对象。")
        records.append(record)

    if not records:
        raise ImportPreviewError("文件不包含任何消息记录。")

    return JsonlDocument(
        path=path,
        content_sha256=hashlib.sha256(content).hexdigest(),
        records=tuple(records),
    )
