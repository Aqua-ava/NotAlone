"""用户主动查看／删除完整敏感追踪的联系人范围 CLI。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from uuid import UUID

from notalone.application.contact_directory import ContactDirectory
from notalone.application.trace_service import TraceService
from notalone.persistence.contact_directory import PostgresContactDirectory
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.persistence.source_processing import (
    PostgresSourceProcessingStore,
)
from notalone.runtime_config import load_project_env
from notalone.scopes import ContactScope


def memory_trace_main(argv: list[str] | None = None) -> int:
    return _main("memory-traces", argv)


def source_trace_main(argv: list[str] | None = None) -> int:
    return _main("source-processing-traces", argv)


def _main(resource: str, argv: list[str] | None) -> int:
    load_project_env()
    parser = argparse.ArgumentParser(
        description="主动查看完整敏感追踪；删除只清追踪，不删除权威消息／记忆。"
    )
    parser.add_argument("--contact-id", required=True, type=UUID)
    actions = parser.add_subparsers(dest="action", required=True)
    listing = actions.add_parser("list", help="列出批次元数据。")
    listing.add_argument("--limit", type=int, default=100)
    listing.add_argument(
        "--before",
        type=UUID,
        help="上一页的 next_before，继续读取更旧的批次。",
    )
    for name in ("show", "delete"):
        action = actions.add_parser(
            name,
            help=(
                "查看完整正文。"
                if name == "show"
                else "手动删除该批追踪正文。"
            ),
        )
        action.add_argument("batch_id", type=UUID)
    finding = actions.add_parser("find", help="从权威记录反查批次或缺口。")
    finding.add_argument(
        "record_kind",
        choices=(
            ("candidate", "contact_memory", "owner_memory")
            if resource == "memory-traces"
            else (
                "message",
                "source_ref",
                "source_document",
                "local_wechat_observation",
            )
        ),
    )
    finding.add_argument("record_id", type=UUID)
    args = parser.parse_args(argv)
    try:
        database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
        scope = ContactScope(
            UUID(os.environ.get("NOTALONE_OWNER_ID", "")), args.contact_id
        )
        service = TraceService(
            contacts=ContactDirectory(PostgresContactDirectory(database_url)),
            extraction=PostgresExtractionTraceStore(database_url),
            processing=PostgresSourceProcessingStore(database_url),
        )
        if args.action == "list":
            payload = service.list_batches(
                scope, resource, limit=args.limit, before=args.before
            )
        elif args.action == "show":
            payload = service.get_batch(scope, resource, args.batch_id)
        elif args.action == "find":
            payload = service.find_record(
                scope, resource, args.record_kind, args.record_id
            )
        else:
            payload = service.delete_batch(scope, resource, args.batch_id)
    except LookupError:
        print("not_found：指定联系人范围内不存在该记录。", file=sys.stderr)
        return 1
    except (TypeError, ValueError):
        print("trace_request_invalid：配置或查询参数无效。", file=sys.stderr)
        return 2
    except Exception:
        print("trace_operation_failed：追踪读取或删除失败。", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0
