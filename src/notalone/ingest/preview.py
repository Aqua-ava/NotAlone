"""微信 JSONL 导入预览命令。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import ImportPreview
from notalone.ingest.validator import validate_records


def build_preview(path: Path) -> ImportPreview:
    """完整校验文件并构造不会写数据库的预览结果。"""
    document = read_jsonl(path)
    contact, kind_counts = validate_records(document.records)
    return ImportPreview(
        file_name=document.path.name,
        content_sha256=document.content_sha256,
        contact=contact,
        record_count=len(document.records),
        kind_counts=kind_counts,
    )


def format_preview(preview: ImportPreview, *, show_identifiers: bool = False) -> str:
    """输出不包含消息正文的预览摘要。"""
    kind_lines = "\n".join(
        f"  {kind}: {count}" for kind, count in preview.kind_counts
    )
    if show_identifiers:
        identity_lines = [
            f"文件：{preview.file_name}",
            f"联系人 ID：{preview.contact.contact_id}",
            f"展示名称：{preview.contact.display_name}",
        ]
    else:
        identity_lines = [
            "文件：已选择（名称默认隐藏）",
            "联系人 ID：已识别（默认隐藏）",
            "展示名称：已识别（默认隐藏）",
        ]
    return "\n".join(
        identity_lines
        + [
            "文件 SHA-256：已计算（值不输出）",
            f"展示名称变体：{preview.contact.display_name_variant_count}",
            f"消息总数：{preview.record_count}",
            "消息类型：",
            kind_lines,
            "解析结果：",
            "  候选联系人: 1",
            "  来源文件: 1",
            f"  消息: {preview.record_count}",
            "  owner: 不来自导出文件，正式导入时由应用账号提供",
            "校验结果：通过",
            "数据库写入：未执行",
        ]
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="预览微信单联系人 JSONL 导入")
    parser.add_argument("path", type=Path, help="待预览的 JSONL 文件")
    parser.add_argument(
        "--show-identifiers",
        action="store_true",
        help="在当前终端显示文件名、联系人 ID 和展示名称",
    )
    args = parser.parse_args(argv)

    try:
        preview = build_preview(args.path)
    except ImportPreviewError as error:
        print(f"导入预览失败：{error}", file=sys.stderr)
        return 1

    print(format_preview(preview, show_identifiers=args.show_identifiers))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
