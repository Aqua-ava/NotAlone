"""微信单联系人 JSONL 正式导入命令。"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, Sequence
from uuid import UUID

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportBatch,
    ImportConfirmationRequest,
    NewContactSelection,
)
from notalone.ingest.normalizer import normalize_document
from notalone.persistence.postgres_repository import (
    ImportPersistenceError,
    ImportResult,
    PostgresIngestRepository,
)
from notalone.persistence.source_processing import SourceProcessingWriteError
from notalone.runtime_config import load_project_env, persist_owner_id
from notalone.scopes import ContactScope
from notalone.source_processing.models import ProcessingRecord
from notalone.source_processing.rule_capture import capture_execution


class ContactConfirmationError(ValueError):
    """文件联系人与用户确认的联系人不一致。"""


def _parse_uuid(value: str) -> UUID:
    """解析 UUID；错误消息不回显原始输入。"""

    try:
        return UUID(value)
    except ValueError:
        raise argparse.ArgumentTypeError("必须是有效 UUID。") from None


def _parse_contact_name(value: str) -> str:
    """解析新联系人展示名称；错误消息不回显原始输入。"""

    display_name = value.strip()
    if not display_name:
        raise argparse.ArgumentTypeError("联系人名称不能为空。")
    return display_name


class IngestRepository(Protocol):
    """正式导入所需的最小持久化接口。"""

    def import_document(
        self,
        *,
        owner_id: UUID | None,
        initialize_owner: bool = False,
        initialize_first_owner_identity: bool = False,
        document: ImportBatch,
        confirmation: ImportConfirmationRequest,
    ) -> ImportResult: ...


def import_file(
    *,
    path: Path,
    owner_id: UUID | None,
    initialize_owner: bool = False,
    initialize_first_owner_identity: bool = False,
    confirmation: ImportConfirmationRequest,
    repository: IngestRepository,
) -> ImportResult:
    """校验、确认联系人后，把一份 JSONL 批次交给持久化层。"""

    try:
        document = read_jsonl(path)
        batch = normalize_document(document)
    except ImportPreviewError as error:
        _record_input_failure(
            repository, owner_id, confirmation, error.details
        )
        raise
    started_at = datetime.now(timezone.utc)
    try:
        return repository.import_document(
            owner_id=owner_id,
            initialize_owner=initialize_owner,
            initialize_first_owner_identity=initialize_first_owner_identity,
            document=batch,
            confirmation=confirmation,
        )
    except ImportPersistenceError as error:
        commit_unknown = type(error) is ImportPersistenceError
        _record_input_failure(
            repository,
            owner_id,
            confirmation,
            {
                "capture_layer": "metadata_only",
                "capture_status": "withheld_failed_attempt",
                "record_text": None,
                "parsed": None,
                "locator": "document",
                "stage": "import_persistence",
                "import_persistence": capture_execution(
                    started_at, __file__, status="failed"
                ),
                "error_code": "import_rejected",
                "error_category": type(error).__name__,
                "outcome": (
                    "import_outcome_unknown"
                    if commit_unknown
                    else "input_rejected"
                ),
                "business_commit_status": (
                    "unknown" if commit_unknown else "not_committed"
                ),
            },
        )
        raise


def _record_input_failure(
    repository: IngestRepository,
    owner_id: UUID | None,
    confirmation: ImportConfirmationRequest,
    details: dict[str, Any],
) -> None:
    """只能关联到既有确认联系人；未验证范围不持久化输入或假定位。"""

    record_failure = getattr(repository, "record_input_failure", None)
    if (
        owner_id is not None
        and isinstance(confirmation.selection, ExistingContactSelection)
        and callable(record_failure)
    ):
        record_failure(
            scope=ContactScope(owner_id, confirmation.selection.contact_id),
            record=ProcessingRecord.capture(details["locator"], details),
        )


def main(argv: Sequence[str] | None = None) -> int:
    """解析正式导入参数并返回命令行退出码。"""

    parser = argparse.ArgumentParser(description="导入微信单联系人 JSONL")
    parser.add_argument("path", type=Path, help="待导入的 JSONL 文件")
    contact_selection = parser.add_mutually_exclusive_group(required=True)
    contact_selection.add_argument(
        "--contact-id",
        type=_parse_uuid,
        help="用户在预览后选择的 NotAlone 联系人 UUID",
    )
    contact_selection.add_argument(
        "--new-contact-name",
        type=_parse_contact_name,
        help="用户在预览后确认的新联系人展示名称",
    )
    parser.add_argument(
        "--initialize-owner",
        action="store_true",
        help="首次导入或显式恢复 owner 微信身份；成功后保存内部 owner UUID",
    )
    args = parser.parse_args(argv)

    env_path = load_project_env()
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    if not database_url:
        print(
            "导入配置错误：缺少 NOTALONE_DATABASE_URL。",
            file=sys.stderr,
        )
        return 2
    owner_id_value = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if owner_id_value:
        try:
            owner_id = UUID(owner_id_value)
        except ValueError:
            print(
                "导入配置错误：NOTALONE_OWNER_ID 不是有效 UUID。",
                file=sys.stderr,
            )
            return 2
    elif args.initialize_owner:
        owner_id = None
    else:
        print(
            "导入配置错误：缺少 NOTALONE_OWNER_ID；首次导入请加 --initialize-owner。",
            file=sys.stderr,
        )
        return 2

    repository = PostgresIngestRepository(database_url)
    selection = (
        ExistingContactSelection(contact_id=args.contact_id)
        if args.contact_id is not None
        else NewContactSelection(display_name=args.new_contact_name)
    )
    try:
        result = import_file(
            path=args.path,
            owner_id=owner_id,
            initialize_owner=args.initialize_owner,
            confirmation=ImportConfirmationRequest(selection=selection),
            repository=repository,
        )
    except (
        ContactConfirmationError,
        ImportPreviewError,
        ImportPersistenceError,
        SourceProcessingWriteError,
    ) as error:
        print(f"导入失败：{error}", file=sys.stderr)
        return 1

    if args.initialize_owner and not owner_id_value:
        if result.owner_id is None:
            print("导入完成，但未得到可保存的 owner UUID。", file=sys.stderr)
            return 2
        try:
            persist_owner_id(result.owner_id, env_path)
        except OSError:
            print(
                "导入完成，但 owner UUID 未能写入本地 .env。",
                file=sys.stderr,
            )
            return 2

    if result.outcome == "already_imported":
        print(f"文件已导入；未重复写入。消息：{result.message_count}")
    else:
        print(f"导入完成。消息：{result.message_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
