"""微信单联系人 JSONL 正式导入命令。"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Protocol, Sequence
from uuid import UUID

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import ImportBatch
from notalone.ingest.normalizer import normalize_document
from notalone.persistence.postgres_repository import (
    ImportPersistenceError,
    ImportResult,
    PostgresIngestRepository,
)


class ContactConfirmationError(ValueError):
    """文件联系人与用户确认的联系人不一致。"""


def _parse_owner_id(value: str) -> UUID:
    """解析 owner UUID；错误消息不回显原始输入。"""

    try:
        return UUID(value)
    except ValueError:
        raise argparse.ArgumentTypeError("必须是有效 UUID。") from None


class IngestRepository(Protocol):
    """正式导入所需的最小持久化接口。"""

    def import_document(
        self,
        *,
        owner_id: UUID,
        document: ImportBatch,
    ) -> ImportResult: ...


def import_file(
    *,
    path: Path,
    owner_id: UUID,
    confirmed_contact_id: str,
    repository: IngestRepository,
) -> ImportResult:
    """校验、确认联系人后，把一份 JSONL 批次交给持久化层。"""

    document = read_jsonl(path)
    batch = normalize_document(document)
    if batch.contact.contact_id != confirmed_contact_id:
        raise ContactConfirmationError("已确认联系人不一致，未执行数据库写入。")
    return repository.import_document(owner_id=owner_id, document=batch)


def main(argv: Sequence[str] | None = None) -> int:
    """解析正式导入参数并返回命令行退出码。"""

    parser = argparse.ArgumentParser(description="导入微信单联系人 JSONL")
    parser.add_argument("path", type=Path, help="待导入的 JSONL 文件")
    parser.add_argument(
        "--owner-id",
        required=True,
        type=_parse_owner_id,
        help="已存在的 NotAlone owner UUID",
    )
    parser.add_argument(
        "--contact-id",
        required=True,
        help="用户在预览后确认的联系人 ID",
    )
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    if not database_url:
        print(
            "导入配置错误：缺少 NOTALONE_DATABASE_URL。",
            file=sys.stderr,
        )
        return 2

    repository = PostgresIngestRepository(database_url)
    try:
        result = import_file(
            path=args.path,
            owner_id=args.owner_id,
            confirmed_contact_id=args.contact_id,
            repository=repository,
        )
    except (
        ContactConfirmationError,
        ImportPreviewError,
        ImportPersistenceError,
    ) as error:
        print(f"导入失败：{error}", file=sys.stderr)
        return 1

    if result.outcome == "already_imported":
        print(f"文件已导入；未重复写入。消息：{result.message_count}")
    else:
        print(f"导入完成。消息：{result.message_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
