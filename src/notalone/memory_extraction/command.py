"""记忆提取与记忆管理的命令入口。"""

from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field
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
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionFlow, ExtractionOutcome
from notalone.memory_extraction.models import (
    ExtractionFailureKind,
    ExtractionWindow,
    MAX_TARGET_MESSAGES_PER_WINDOW,
)
from notalone.memory_extraction.recovery import (
    FailureRange,
    record_batch_failure,
)
from notalone.memory_extraction.runtime import (
    ExtractionPayload,
    MemoryExtractionRuntime,
)
from notalone.memory_extraction.verification import SourceVerificationRuntime
from notalone.runtime_config import load_project_env
from notalone.scopes import ContactScope


EXTRACTION_BATCH_SIZE = MAX_TARGET_MESSAGES_PER_WINDOW
MAX_CONTEXT_MESSAGES_PER_SIDE = 20
EXTRACTION_CONTEXT_BEFORE = MAX_CONTEXT_MESSAGES_PER_SIDE
EXTRACTION_CONTEXT_AFTER = MAX_CONTEXT_MESSAGES_PER_SIDE


@dataclass(slots=True)
class _TimedExtractionRuntime:
    """只测量首次提取调用，避免核验和采纳耗时重复进入其台账。"""

    runtime: MemoryExtractionRuntime
    called_at: datetime = field(init=False)
    latency_ms: int = field(init=False)

    def __post_init__(self) -> None:
        if self.runtime is None:
            raise TypeError("ExtractionFlow 必须显式注入运行时。")

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        self.called_at = datetime.now(timezone.utc)
        started = time.perf_counter()
        try:
            return self.runtime.extract(window)
        finally:
            self.latency_ms = max(0, int((time.perf_counter() - started) * 1000))


@dataclass(frozen=True, slots=True)
class ExtractionRunStats:
    """一次提取命令的聚合统计。"""

    batches: int = 0
    processed_messages: int = 0
    extracted: int = 0
    adopted: int = 0
    updated: int = 0
    pending: int = 0
    skipped_duplicate: int = 0
    skipped_deleted: int = 0
    rejected_by_contract: int = 0
    failed_batches: int = 0
    skipped_batches: int = 0
    skipped_non_memory: int = 0
    skipped_ranges: tuple[FailureRange, ...] = ()


def run_extraction(
    *,
    scope: ContactScope,
    messages: tuple,
    watermark_message_id: UUID | None,
    runtime,
    memory_port,
    owner_memory_port,
    verification_runtime: SourceVerificationRuntime | None = None,
    adjudication_runtime=None,
    ledger: OutboundLedgerPort | None = None,
    watermark_port=None,
    batch_size: int = EXTRACTION_BATCH_SIZE,
    context_before: int = EXTRACTION_CONTEXT_BEFORE,
    context_after: int = EXTRACTION_CONTEXT_AFTER,
    provider: str = "deepseek",
    model_name: str | None = None,
) -> ExtractionRunStats:
    """按水位分批串行提取并采纳；输出不可用的批次连续失败后跳过。"""

    if (
        not isinstance(batch_size, int)
        or not 0 < batch_size <= EXTRACTION_BATCH_SIZE
    ):
        raise ValueError(
            f"单次模型调用最多处理 {EXTRACTION_BATCH_SIZE} 条目标消息。"
        )
    if (
        not isinstance(context_before, int)
        or not 0 <= context_before <= MAX_CONTEXT_MESSAGES_PER_SIDE
    ):
        raise ValueError(
            "前置上下文条数必须在 0 到 "
            f"{MAX_CONTEXT_MESSAGES_PER_SIDE} 之间。"
        )
    if (
        not isinstance(context_after, int)
        or not 0 <= context_after <= MAX_CONTEXT_MESSAGES_PER_SIDE
    ):
        raise ValueError(
            "后置上下文条数必须在 0 到 "
            f"{MAX_CONTEXT_MESSAGES_PER_SIDE} 之间。"
        )

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
    timed_runtime = _TimedExtractionRuntime(runtime)
    flow = ExtractionFlow(
        runtime=timed_runtime, verification_runtime=verification_runtime,
    )

    batches = processed_messages = extracted = adopted = updated = pending = 0
    duplicate = deleted = rejected = failed = skipped = 0
    skipped_non_memory = 0
    skipped_ranges: list[FailureRange] = []
    for offset in range(0, len(pending_messages), batch_size):
        batch = pending_messages[offset : offset + batch_size]
        processed_messages += len(batch)
        absolute_start = start + offset
        absolute_end = absolute_start + len(batch)
        context_start = max(0, absolute_start - context_before)
        context_end = min(len(messages), absolute_end + context_after)
        window = ExtractionWindow(
            owner_id=scope.owner_id,
            contact_id=scope.contact_id,
            messages=tuple(messages[context_start:context_end]),
            target_message_ids=tuple(message.message_id for message in batch),
        )
        adoption_stats = AdoptionStats()
        extraction_completed = False
        try:
            outcome: ExtractionOutcome = flow.run(window)
            extraction_completed = outcome.extraction_completed
            if outcome.failure_reason is None:
                adoption_stats = adoption.adopt(scope, outcome)
        except ExtractionRuntimeError as error:
            # 写入裁决等批次级模型调用失败：与提取失败同一策略，
            # 分类后计数或停止，不让整轮无记录地中断。失败发生在采纳
            # 阶段，必须保留 flow 已给出的本批统计，不能用一个空 outcome
            # 覆盖掉已通过的提取与拒绝计数。
            preserved_rejections = outcome.rejected_count
            outcome = ExtractionOutcome(
                accepted=(),
                rejected_count=preserved_rejections,
                failure_reason=str(error),
                failure_kind=error.failure_kind,
                extraction_completed=extraction_completed,
            )
        batches += 1
        _record_extraction_ledger(
            ledger,
            scope,
            (
                LedgerOutcome.SUCCEEDED
                if outcome.extraction_completed else LedgerOutcome.RUN_FAILED
            ),
            latency_ms=timed_runtime.latency_ms,
            called_at=timed_runtime.called_at,
            provider=provider,
            model_name=model_name,
        )
        if outcome.failure_reason is None:
            extracted += len(outcome.accepted)
            adopted += adoption_stats.adopted
            updated += adoption_stats.updated
            pending += adoption_stats.pending
            duplicate += adoption_stats.skipped_duplicate
            deleted += adoption_stats.skipped_deleted
            rejected += adoption_stats.rejected_by_contract
            skipped_non_memory += adoption_stats.skipped_non_memory
            if watermark_port is not None:
                watermark_port.set(scope, batch[-1].message_id)
            continue
        # 失败批次里已经由 flow 判定为契约拒绝的候选仍要计数，
        # 这样采纳阶段失败不会让本批统计凭空归零。
        rejected += outcome.rejected_count
        if (
            outcome.failure_kind is ExtractionFailureKind.INVALID_OUTPUT
            and watermark_port is not None
        ):
            failure_range = FailureRange(
                from_message_id=batch[0].message_id,
                to_message_id=batch[-1].message_id,
                code=outcome.failure_kind,
            )
            previous = watermark_port.get_failure(scope)
            state, reached = record_batch_failure(
                previous,
                failure_range=failure_range,
            )
            if reached:
                watermark_port.mark_skipped(scope, failure_range)
                skipped += 1
                skipped_ranges.append(failure_range)
                continue
            watermark_port.save_failure(scope, state)
        failed += 1
        break
    return ExtractionRunStats(
        batches=batches,
        processed_messages=processed_messages,
        extracted=extracted,
        adopted=adopted,
        updated=updated,
        pending=pending,
        skipped_duplicate=duplicate,
        skipped_deleted=deleted,
        rejected_by_contract=rejected,
        failed_batches=failed,
        skipped_batches=skipped,
        skipped_non_memory=skipped_non_memory,
        skipped_ranges=tuple(skipped_ranges),
    )


def _record_extraction_ledger(
    ledger: OutboundLedgerPort | None,
    scope: ContactScope,
    outcome: LedgerOutcome,
    *,
    latency_ms: int,
    called_at: datetime,
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
        latency_ms=latency_ms,
        outcome=outcome,
        called_at=called_at,
    )
    ledger.record(entry)


def _fail(message: str) -> int:
    print(message)
    return 1


class OwnerConfigError(ValueError):
    """owner 环境变量不可用；入口负责转成稳定退出码与文案。"""


def _owner_uuid_from_env(owner_id: str) -> UUID:
    """解析已确认的 owner 配置；非法值给出稳定错误而不是裸 traceback。"""

    try:
        return UUID(owner_id)
    except ValueError:
        raise OwnerConfigError("NOTALONE_OWNER_ID 不是合法 UUID。") from None


def extract_main(argv: list[str] | None = None) -> int:
    """提取命令入口：自动全量/增量，断点续跑，输出统计与跳过区间。"""

    load_project_env()
    parser = argparse.ArgumentParser(
        prog="notalone-extract-memory",
        description="对已确认联系人执行记忆提取（自动全量或增量）。",
    )
    parser.add_argument("--contact-id", required=True, type=UUID)
    parser.add_argument(
        "--batch-size",
        type=int,
        default=EXTRACTION_BATCH_SIZE,
        help=(
            "单次模型调用的目标消息上限（默认 20）；"
            "同一联系人前后各补充最多 20 条上下文。"
        ),
    )
    args = parser.parse_args(argv)
    if not 0 < args.batch_size <= EXTRACTION_BATCH_SIZE:
        return _fail(
            f"--batch-size 必须在 1 到 {EXTRACTION_BATCH_SIZE} 之间。"
        )

    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_id = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url:
        return _fail("缺少 NOTALONE_DATABASE_URL 环境变量。")
    if not owner_id:
        return _fail("缺少 NOTALONE_OWNER_ID 环境变量。")
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

    from notalone.memory_extraction.adapters import LangChainExtractionRuntime
    from notalone.memory_extraction.adjudication_adapters import (
        LangChainAdjudicationRuntime,
    )
    from notalone.memory_extraction.cli_support import (
        build_extraction_components,
        contact_exists,
        load_contact_messages,
    )
    from notalone.memory_extraction.verification_adapters import (
        LangChainSourceVerificationRuntime,
    )

    scope = ContactScope(owner_uuid, args.contact_id)
    try:
        components = build_extraction_components(database_url)
    except Exception:
        return _fail("记忆提取准备失败：数据库不可用。")
    try:
        if not contact_exists(scope, database_url):
            return _fail("联系人不存在或不在当前用户范围内。")
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
        verification_runtime=LangChainSourceVerificationRuntime(
            model=components.model, ledger=components.ledger,
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
        f" skipped_non_memory={stats.skipped_non_memory}"
        f" failed_batches={stats.failed_batches}"
        f" skipped_batches={stats.skipped_batches}"
    )
    for skipped_range in stats.skipped_ranges:
        print(
            f"skipped_range from={skipped_range.from_message_id}"
            f" to={skipped_range.to_message_id}"
            f" code={skipped_range.code.value}"
        )
    return 0 if stats.failed_batches == 0 else 1



def memory_add_main(argv: list[str] | None = None) -> int:
    """手动录入记忆：标记 manual，支持联系人级与 owner 级。"""

    load_project_env()
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
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

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
        # 手动录入不依赖提取来源：走 manual 来源 + 候选路径（迁移 025）。
        candidate = store.create_manual_candidate(
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

    load_project_env()
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
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

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
        owner_memories = PostgresOwnerMemoryStore(database_url).list_active(owner_uuid)
        for owner_memory in owner_memories:
            print(
                f"memory_id={owner_memory.memory_id}"
                f" category={owner_memory.category.value}"
                f" topic={owner_memory.topic.value}"
                f" adoption={owner_memory.adoption_method.value}"
                f" revision={owner_memory.revision}"
            )
        print(f"total={len(owner_memories)}")
    else:
        return _fail("需要 --contact-id 或 --owner 之一。")
    return 0


def memory_delete_main(argv: list[str] | None = None) -> int:
    """软删除一条记忆（保留删除指纹）。"""

    load_project_env()
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
    try:
        owner_uuid = _owner_uuid_from_env(owner_id)
    except OwnerConfigError as error:
        return _fail(str(error))

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
