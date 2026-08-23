"""记忆提取与记忆管理的命令入口。"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4

from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort
from notalone.memory.models import (
    AdoptionMethod,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.adoption import AdoptionStats, MemoryAdoption
from notalone.memory_extraction.flow import ExtractionFlow, ExtractionOutcome
from notalone.memory_extraction.models import ExtractionWindow
from notalone.scopes import ContactScope


EXTRACTION_BATCH_SIZE = 500


@dataclass(frozen=True, slots=True)
class ExtractionRunStats:
    """一次提取命令的聚合统计。"""

    batches: int = 0
    extracted: int = 0
    adopted: int = 0
    updated: int = 0
    pending: int = 0
    skipped_duplicate: int = 0
    skipped_deleted: int = 0
    rejected_by_contract: int = 0
    failed_batches: int = 0


def run_extraction(
    *,
    scope: ContactScope,
    messages: tuple,
    watermark_message_id: UUID | None,
    runtime,
    memory_port,
    owner_memory_port,
    adjudication_runtime=None,
    ledger: OutboundLedgerPort | None = None,
    watermark_port=None,
    batch_size: int = EXTRACTION_BATCH_SIZE,
    provider: str = "deepseek",
    model_name: str | None = None,
) -> ExtractionRunStats:
    """按水位分批串行提取并采纳；每批后推进水位。"""

    if watermark_message_id is not None:
        positions = [
            index
            for index, message in enumerate(messages)
            if message.message_id == watermark_message_id
        ]
        start = positions[0] + 1 if positions else 0
    else:
        start = 0
    pending_messages = messages[start:]

    adoption = MemoryAdoption(
        memory_port=memory_port,
        owner_memory_port=owner_memory_port,
        adjudication_runtime=adjudication_runtime,
        ledger=ledger,
    )
    flow = ExtractionFlow(runtime=runtime)

    batches = extracted = adopted = updated = pending = 0
    duplicate = deleted = rejected = failed = 0
    for offset in range(0, len(pending_messages), batch_size):
        batch = pending_messages[offset : offset + batch_size]
        window = ExtractionWindow(
            owner_id=scope.owner_id,
            contact_id=scope.contact_id,
            messages=tuple(batch),
        )
        started_ns = time.perf_counter()
        outcome: ExtractionOutcome = flow.run(window)
        batches += 1
        if outcome.failure_reason is None:
            extracted += len(outcome.accepted)
            stats: AdoptionStats = adoption.adopt(scope, outcome)
            adopted += stats.adopted
            updated += stats.updated
            pending += stats.pending
            duplicate += stats.skipped_duplicate
            deleted += stats.skipped_deleted
            rejected += stats.rejected_by_contract
            _record_extraction_ledger(
                ledger,
                scope,
                LedgerOutcome.SUCCEEDED,
                started_ns,
                provider=provider,
                model_name=model_name,
            )
        else:
            failed += 1
            _record_extraction_ledger(
                ledger,
                scope,
                LedgerOutcome.RUN_FAILED,
                started_ns,
                provider=provider,
                model_name=model_name,
            )
        if watermark_port is not None:
            watermark_port.set(scope, batch[-1].message_id)
    return ExtractionRunStats(
        batches=batches,
        extracted=extracted,
        adopted=adopted,
        updated=updated,
        pending=pending,
        skipped_duplicate=duplicate,
        skipped_deleted=deleted,
        rejected_by_contract=rejected,
        failed_batches=failed,
    )


def _record_extraction_ledger(
    ledger: OutboundLedgerPort | None,
    scope: ContactScope,
    outcome: LedgerOutcome,
    started_ns: float,
    *,
    provider: str,
    model_name: str | None,
) -> None:
    if ledger is None:
        return
    entry = LedgerEntry(
        entry_id=uuid4(),
        owner_id=scope.owner_id,
        contact_id=scope.contact_id,
        provider=provider,
        model_name=model_name or "unreported",
        input_tokens=None,
        output_tokens=None,
        latency_ms=int((time.perf_counter() - started_ns) * 1000),
        outcome=outcome,
        called_at=datetime.now(timezone.utc),
    )
    ledger.record(entry)


def _fail(message: str) -> int:
    print(message)
    return 1


def extract_main(argv: list[str] | None = None) -> int:
    """提取命令入口：自动全量/增量，断点续跑，输出纯统计。"""

    parser = argparse.ArgumentParser(
        prog="notalone-extract-memory",
        description="对已确认联系人执行记忆提取（自动全量或增量）。",
    )
    parser.add_argument("--contact-id", required=True, type=UUID)
    parser.add_argument(
        "--batch-size",
        type=int,
        default=EXTRACTION_BATCH_SIZE,
        help="单批消息窗口上限（默认 500）。",
    )
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url:
        return _fail("缺少 NOTALONE_DATABASE_URL 环境变量。")
    if not owner_id:
        return _fail("缺少 NOTALONE_OWNER_ID 环境变量。")
    try:
        owner_uuid = UUID(owner_id)
    except ValueError:
        return _fail("NOTALONE_OWNER_ID 不是合法 UUID。")

    from notalone.memory_extraction.adapters import LangChainExtractionRuntime
    from notalone.memory_extraction.adjudication_adapters import (
        LangChainAdjudicationRuntime,
    )
    from notalone.memory_extraction.cli_support import (
        build_extraction_components,
        load_contact_messages,
    )

    scope = ContactScope(owner_uuid, args.contact_id)
    try:
        components = build_extraction_components(database_url)
        messages = load_contact_messages(scope, database_url)
    except Exception:
        return _fail("记忆提取准备失败：数据库不可用或联系人不存在。")
    if not messages:
        print("batches=0 extracted=0 adopted=0 updated=0 pending=0")
        return 0

    watermark_message_id = components.watermark.get(scope)
    stats = run_extraction(
        scope=scope,
        messages=messages,
        watermark_message_id=watermark_message_id,
        runtime=LangChainExtractionRuntime(
            model=components.model
        ),
        memory_port=components.memory_store,
        owner_memory_port=components.owner_store,
        adjudication_runtime=LangChainAdjudicationRuntime(
            model=components.model
        ),
        ledger=components.ledger,
        watermark_port=components.watermark,
        batch_size=args.batch_size,
        model_name=components.model_name,
    )
    print(
        f"batches={stats.batches} extracted={stats.extracted}"
        f" adopted={stats.adopted} updated={stats.updated}"
        f" pending={stats.pending} duplicate={stats.skipped_duplicate}"
        f" deleted_skip={stats.skipped_deleted}"
        f" rejected={stats.rejected_by_contract}"
        f" failed_batches={stats.failed_batches}"
    )
    return 0 if stats.failed_batches == 0 else 1



def memory_add_main(argv: list[str] | None = None) -> int:
    """手动录入记忆：标记 manual，支持联系人级与 owner 级。"""

    parser = argparse.ArgumentParser(
        prog="notalone-memory-add", description="手动录入一条记忆（manual）。"
    )
    parser.add_argument("--text", required=True)
    parser.add_argument(
        "--category",
        required=True,
        choices=[item.value for item in MemoryCategory],
    )
    parser.add_argument(
        "--topic", default="other",
        choices=[item.value for item in MemoryTopic],
    )
    parser.add_argument("--contact-id", type=UUID, default=None)
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url or not owner_id:
        return _fail("缺少 NOTALONE_DATABASE_URL 或 NOTALONE_OWNER_ID。")
    owner_uuid = UUID(owner_id)

    from notalone.memory.models import (
        ConfirmedMemoryStatus,
        MemoryCandidate,
        OwnerMemory,
    )
    from notalone.memory_extraction.cli_support import (
        contact_exists,
        owner_exists,
    )
    from notalone.persistence import (
        PostgresMemoryStore,
        PostgresOwnerMemoryStore,
    )

    if not owner_exists(owner_uuid, database_url):
        return _fail("owner 不存在。")
    if args.contact_id is not None:
        scope = ContactScope(owner_uuid, args.contact_id)
        if not contact_exists(scope, database_url):
            return _fail("联系人不存在。")
        store = PostgresMemoryStore(database_url)
        candidate = store.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=scope,
                text=args.text,
                category=MemoryCategory(args.category),
                topic=MemoryTopic(args.topic),
                source_ids=(args.contact_id,),
            )
        )
        store.confirm(
            scope=scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        print("status=confirmed level=contact")
    else:
        owner_store = PostgresOwnerMemoryStore(database_url)
        owner_store.create(
            OwnerMemory(
                memory_id=uuid4(),
                owner_id=owner_uuid,
                text=args.text,
                category=MemoryCategory(args.category),
                topic=MemoryTopic(args.topic),
                source_ids=(owner_uuid,),
                adoption_method=AdoptionMethod.MANUAL,
                status=ConfirmedMemoryStatus.ACTIVE,
            )
        )
        print("status=confirmed level=owner")
    return 0


def memory_list_main(argv: list[str] | None = None) -> int:
    """列出记忆：只输出状态、分类、主题与采纳标记，不输出正文。"""

    parser = argparse.ArgumentParser(
        prog="notalone-memory-list", description="列出记忆的状态概览。"
    )
    parser.add_argument("--contact-id", type=UUID, default=None)
    parser.add_argument("--owner", action="store_true")
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url or not owner_id:
        return _fail("缺少 NOTALONE_DATABASE_URL 或 NOTALONE_OWNER_ID。")
    owner_uuid = UUID(owner_id)

    from notalone.persistence import (
        PostgresMemoryStore,
        PostgresOwnerMemoryStore,
    )

    if args.contact_id is not None:
        scope = ContactScope(owner_uuid, args.contact_id)
        memories = PostgresMemoryStore(database_url).list_confirmed(scope)
        for memory in memories:
            print(
                f"memory_id={memory.memory_id}"
                f" category={memory.category.value}"
                f" topic={memory.topic.value}"
                f" adoption={memory.adoption_method.value}"
                f" revision={memory.revision}"
            )
        print(f"total={len(memories)}")
    elif args.owner:
        memories = PostgresOwnerMemoryStore(database_url).list_active(owner_uuid)
        for memory in memories:
            print(
                f"memory_id={memory.memory_id}"
                f" category={memory.category.value}"
                f" topic={memory.topic.value}"
                f" adoption={memory.adoption_method.value}"
                f" revision={memory.revision}"
            )
        print(f"total={len(memories)}")
    else:
        return _fail("需要 --contact-id 或 --owner 之一。")
    return 0


def memory_delete_main(argv: list[str] | None = None) -> int:
    """软删除一条记忆（保留删除指纹）。"""

    parser = argparse.ArgumentParser(
        prog="notalone-memory-delete", description="软删除一条记忆。"
    )
    parser.add_argument("--memory-id", required=True, type=UUID)
    parser.add_argument("--contact-id", type=UUID, default=None)
    parser.add_argument("--owner", action="store_true")
    args = parser.parse_args(argv)

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url or not owner_id:
        return _fail("缺少 NOTALONE_DATABASE_URL 或 NOTALONE_OWNER_ID。")
    owner_uuid = UUID(owner_id)

    from notalone.persistence import (
        PostgresMemoryStore,
        PostgresOwnerMemoryStore,
    )

    if args.contact_id is not None:
        scope = ContactScope(owner_uuid, args.contact_id)
        PostgresMemoryStore(database_url).delete(
            scope=scope, memory_id=args.memory_id
        )
        print("status=deleted level=contact")
    elif args.owner:
        PostgresOwnerMemoryStore(database_url).delete(
            owner_uuid, args.memory_id
        )
        print("status=deleted level=owner")
    else:
        return _fail("需要 --contact-id 或 --owner 之一。")
    return 0
