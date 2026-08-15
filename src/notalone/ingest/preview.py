"""微信 JSONL 导入预览命令。

这里负责串联读取与校验，并把结构化预览转换成终端文字；它不连接数据库。
"""

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
    # 第一步只负责读文件、计算指纹并逐行解析 JSON。
    document = read_jsonl(path)
    # 第二步校验每条记录和整份文件，返回候选联系人及消息类型统计。
    channel_identity, kind_counts = validate_records(document.records)
    # 使用关键字参数构造数据类，字段来源比按位置传参更清楚。
    return ImportPreview(
        file_name=document.path.name,
        content_sha256=document.content_sha256,
        channel_identity=channel_identity,
        record_count=len(document.records),
        kind_counts=kind_counts,
    )


def format_preview(preview: ImportPreview, *, show_identifiers: bool = False) -> str:
    """把结构化预览转换成不包含消息正文的字符串。

    ``preview: ImportPreview`` 是参数类型标注，``-> str`` 是返回类型标注。参数列表中的
    ``*`` 表示后面的 ``show_identifiers`` 只能按名字传递：
    ``format_preview(preview, show_identifiers=True)`` 合法，而
    ``format_preview(preview, True)`` 不合法。默认值 ``False`` 表示隐藏身份信息。
    """
    # 生成式逐个取出 (kind, count) 并格式化；join 用换行符连接所有字符串。
    kind_lines = "\n".join(
        f"  {kind}: {count}" for kind, count in preview.kind_counts
    )
    # 只有调用方明确要求时，才把文件名、联系人 ID 和昵称放进输出。
    if show_identifiers:
        identity_lines = [
            f"文件：{preview.file_name}",
            f"微信渠道 ID：{preview.channel_identity.external_id}",
            f"来源展示名称：{preview.channel_identity.observed_name}",
        ]
    else:
        identity_lines = [
            "文件：已选择（名称默认隐藏）",
            "微信渠道 ID：已识别（默认隐藏）",
            "来源展示名称：已识别（默认隐藏）",
        ]
    # identity_lines + [...] 先拼成一个字符串列表，再由 join 组成最终多行字符串。
    return "\n".join(
        identity_lines
        + [
            "文件 SHA-256：已计算（值不输出）",
            f"展示名称变体：{preview.channel_identity.observed_name_variant_count}",
            f"消息总数：{preview.record_count}",
            "消息类型：",
            kind_lines,
            "解析结果：",
            "  渠道身份候选: 1",
            "  来源文件: 1",
            f"  消息: {preview.record_count}",
            "  owner: 不来自导出文件，正式导入时由应用账号提供",
            "校验结果：通过",
            "数据库写入：未执行",
        ]
    )


def main(argv: Sequence[str] | None = None) -> int:
    """解析命令行参数、执行预览并返回进程退出码。

    ``Sequence[str] | None`` 表示参数可以是一串字符串，也可以是 ``None``。真实命令行
    运行时传 ``None``，argparse 会读取系统参数；测试则可以直接传入字符串列表。
    """
    # ArgumentParser 负责生成 --help，并把命令行文本解析成 Python 值。
    parser = argparse.ArgumentParser(description="预览微信单联系人 JSONL 导入")
    parser.add_argument("path", type=Path, help="待预览的 JSONL 文件")
    parser.add_argument(
        "--show-identifiers",
        action="store_true",
        help="在当前终端显示文件名、联系人 ID 和展示名称",
    )
    args = parser.parse_args(argv)

    # 只捕获预期的导入错误；真正的编程错误继续暴露，便于及时修复。
    try:
        preview = build_preview(args.path)
    except ImportPreviewError as error:
        print(f"导入预览失败：{error}", file=sys.stderr)
        return 1

    print(format_preview(preview, show_identifiers=args.show_identifiers))
    # 0 是命令行程序约定的成功退出码；上面的失败分支返回 1。
    return 0


if __name__ == "__main__":
    # 直接执行模块时，把 main() 的整数返回值交给操作系统作为退出码。
    raise SystemExit(main())
