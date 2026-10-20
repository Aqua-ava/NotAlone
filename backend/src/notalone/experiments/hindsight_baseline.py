"""真实本地 Context 的实验装配、ID 计分与公开合成产物入口。"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import subprocess
from time import perf_counter
from typing import TypeVar
from uuid import UUID

from notalone.experiments.hindsight_dataset import (
    SyntheticDataset,
    SyntheticMemory,
    SyntheticQuery,
    build_dataset,
    canonical_json,
    dataset_documents,
    freeze_dataset,
    stable_id,
    validate_dataset,
)
from notalone.experiments.hindsight_metrics import (
    MemoryIdentity,
    QueryResult,
    SelectedMemory,
    grouped_summaries,
)
from notalone.memory import (
    AdoptionMethod,
    ConfirmedMemory,
    InMemoryMemoryStore,
    MemoryCategory,
)
from notalone.memory.models import ConfirmedMemoryStatus
from notalone.memory.timing import MemoryTiming
from notalone.reply.context import ReplyContext, RetrievalReplyContext
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
)
from notalone.retrieval.adapters import InMemoryRetrieval
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
    RetrievedPendingCandidate,
)
from notalone.retrieval.ports import RetrievalPort
from notalone.scopes import ContactScope, VerifiedConversationScope


@dataclass(slots=True)
class FixtureHandles:
    """实验拥有的合成快照与真实内存权威适配器，供 B 包装既有 Port。"""

    dataset: SyntheticDataset
    memory_store: InMemoryMemoryStore
    local_retrieval: InMemoryRetrieval


RetrievalFactory = Callable[[InMemoryRetrieval], RetrievalPort]
_ResultT = TypeVar("_ResultT")


class _ObservedRetrieval:
    """实验观察既有公共调用失败，防止 Context 的降级把它记成成功。"""

    def __init__(self, delegate: RetrievalPort) -> None:
        self.delegate = delegate
        self.failures: list[str] = []

    def _run(self, call: Callable[[], _ResultT]) -> _ResultT:
        try:
            return call()
        except Exception as exc:
            self.failures.append(type(exc).__name__)
            raise

    def search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
        message_ids: tuple[UUID, ...] | None = None,
        query: str | None = None,
        limit: int = 50,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        return self._run(
            lambda: self.delegate.search_messages(
                scope=scope,
                target_message_id=target_message_id,
                **({"message_ids": message_ids} if message_ids is not None else {}),
                query=query,
                limit=limit,
                occurred_after=occurred_after,
                occurred_before=occurred_before,
                timeout_ms=timeout_ms,
            )
        )

    def query_messages(
        self,
        *,
        scope: ContactScope,
        anchor_message_id: UUID | None = None,
        before: int = 3,
        after: int = 3,
        limit: int = 20,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        return self._run(
            lambda: self.delegate.query_messages(
                scope=scope,
                anchor_message_id=anchor_message_id,
                before=before,
                after=after,
                limit=limit,
                occurred_after=occurred_after,
                occurred_before=occurred_before,
                timeout_ms=timeout_ms,
            )
        )

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
        include_historical: bool = False,
    ) -> tuple[RetrievedMemory, ...]:
        return self._run(
            lambda: self.delegate.search_confirmed_memories(
                scope=scope,
                query=query,
                limit=limit,
                memory_ids=memory_ids,
                **({"include_historical": True} if include_historical else {}),
            )
        )

    def search_owner_memories(
        self,
        *,
        owner_id: UUID,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
        include_historical: bool = False,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        return self._run(
            lambda: self.delegate.search_owner_memories(
                owner_id=owner_id,
                query=query,
                limit=limit,
                memory_ids=memory_ids,
                **({"include_historical": True} if include_historical else {}),
            )
        )

    def search_pending_candidates(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 3,
        candidate_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedPendingCandidate, ...]:
        return self._run(
            lambda: self.delegate.search_pending_candidates(
                scope=scope,
                query=query,
                limit=limit,
                candidate_ids=candidate_ids,
            )
        )


def build_fixture(dataset: SyntheticDataset) -> FixtureHandles:
    """以固定 UUID 初始化已采纳快照；不验证自然抽取或采纳准确率。"""

    validate_dataset(dataset)
    contact_memories = {
        spec.memory_id: ConfirmedMemory(
            memory_id=spec.memory_id,
            scope=spec.scope,
            text=spec.text,
            category=MemoryCategory(spec.category),
            source_ids=spec.source_ids,
            source_candidate_id=None,
            adoption_method=AdoptionMethod(spec.adoption_method),
            confidence=spec.confidence,
            revision=spec.revision,
            status=ConfirmedMemoryStatus(spec.status),
            valid_at=spec.valid_at,
            invalid_at=spec.invalid_at,
            timing=MemoryTiming(recorded_at=dataset.query_timestamp),
        )
        for spec in dataset.memories
        if spec.layer == "contact"
    }
    store = InMemoryMemoryStore(_memories=contact_memories)
    owners = tuple(
        RetrievedOwnerMemory(
            memory_id=spec.memory_id,
            owner_id=spec.scope.owner_id,
            text=spec.text,
            category=spec.category,
            topic="other",
            source_ids=spec.source_ids,
            adoption_method=spec.adoption_method,
            revision=spec.revision,
            confidence=spec.confidence,
            status=spec.status,
            valid_at=spec.valid_at,
            invalid_at=spec.invalid_at,
            timing=MemoryTiming(recorded_at=dataset.query_timestamp),
        )
        for spec in dataset.memories
        if spec.layer == "owner"
    )
    local = InMemoryRetrieval(
        memory_store=store,
        owner_memories=owners,
        messages=tuple(
            RetrievedMessage(
                message_id=stable_id(f"query:{q.query_id}:message"),
                scope=q.scope,
                text=q.text,
                source_ids=(stable_id(f"query:{q.query_id}:source"),),
            )
            for q in dataset.queries
        ),
    )
    return FixtureHandles(dataset, store, local)


def memory_identity(spec: SyntheticMemory) -> MemoryIdentity:
    return MemoryIdentity(
        spec.layer,
        spec.scope.owner_id,
        spec.scope.contact_id if spec.layer == "contact" else None,
        spec.memory_id,
    )


def _selected(context: ReplyContext, layer: str) -> tuple[SelectedMemory, ...]:
    kind = "confirmed_memory" if layer == "contact" else "owner_memory"
    return tuple(
        SelectedMemory(
            MemoryIdentity(
                "contact" if layer == "contact" else "owner",
                item.scope.owner_id,
                item.scope.contact_id if layer == "contact" else None,
                item.evidence_id,
            ),
            item.text,
            item.source_ids,
            item.revision or 0,
            item.selection_reason,
        )
        for item in context.evidence
        if item.kind == kind
    )


def evaluate_query(
    fixture: FixtureHandles,
    query: SyntheticQuery,
    *,
    retrieval_factory: RetrievalFactory | None = None,
    before_validate: Callable[[FixtureHandles, ReplyContext], None] | None = None,
) -> QueryResult:
    """A 默认装配；B 只需包装 local_retrieval，不增加生产接口。"""

    binding_id = stable_id(f"query:{query.query_id}:binding")
    command = GenerateReply(
        idempotency_key=stable_id(f"query:{query.query_id}:request"),
        scope=query.scope,
        conversation_binding_id=binding_id,
        content=ReplyToMessage(
            stable_id(f"query:{query.query_id}:message"),
            ConfirmedDirection("自然回应当前问题", DirectionSource.DIRECT_INPUT),
        ),
    )
    identities = {m.memory_id: memory_identity(m) for m in fixture.dataset.memories}
    contact_gold = tuple(identities[m] for m in query.contact_gold)
    owner_gold = tuple(identities[m] for m in query.owner_gold)
    start_time = datetime.now(timezone.utc).isoformat()
    started = perf_counter()
    selected_contact: tuple[SelectedMemory, ...] = ()
    selected_owner: tuple[SelectedMemory, ...] = ()
    error = None
    status = "succeeded"
    try:
        retrieval = (
            fixture.local_retrieval
            if retrieval_factory is None
            else retrieval_factory(fixture.local_retrieval)
        )
        observed = _ObservedRetrieval(retrieval)
        builder = RetrievalReplyContext(
            retrieval=observed,
            skill_library_revision=0,
            id_factory=lambda: stable_id(f"query:{query.query_id}:context"),
        )
        context = builder.build(
            command=command,
            verified_scope=VerifiedConversationScope(
                query.scope.owner_id,
                query.scope.contact_id,
                binding_id,
            ),
        )
        if before_validate is not None:
            before_validate(fixture, context)
        builder.validate_current(context)
        if observed.failures:
            # 初检异常可能已被 Context 吞掉，整次实验仍须拒绝。
            status = "failed"
            error = ",".join(observed.failures)
        else:
            selected_contact = _selected(context, "contact")
            selected_owner = _selected(context, "owner")
    except Exception as exc:
        # 失败保持在分母中，整份快照拒绝；不保存异常携带的正文。
        status = "failed"
        error = type(exc).__name__
    elapsed_ms = (perf_counter() - started) * 1000
    selected_ids = [item.identity for item in (*selected_contact, *selected_owner)]
    return QueryResult(
        query.query_id,
        query.split,
        query.group,
        "failed" if status == "failed" else "succeeded",
        error,
        elapsed_ms,
        start_time,
        datetime.now(timezone.utc).isoformat(),
        contact_gold,
        owner_gold,
        selected_contact,
        selected_owner,
        over_budget=(
            len(selected_contact) > 5
            or sum(len(m.text) for m in selected_contact) > 600
            or len(selected_owner) > 3
            or sum(len(m.text) for m in selected_owner) > 240
        ),
        duplicate_ids=len(selected_ids) - len(set(selected_ids)),
        scope_violations=sum(
            item.identity.owner_id != query.scope.owner_id
            or (
                item.identity.layer == "contact"
                and item.identity.contact_id != query.scope.contact_id
            )
            for item in (*selected_contact, *selected_owner)
        ),
    )


def evaluate_dataset(
    dataset: SyntheticDataset,
    *,
    retrieval_factory: RetrievalFactory | None = None,
) -> tuple[QueryResult, ...]:
    """静态组共用一份内存快照；生命周期竞争用例由独立夹具执行。"""

    fixture = build_fixture(dataset)
    return tuple(
        evaluate_query(fixture, query, retrieval_factory=retrieval_factory)
        for query in dataset.queries
    )


def _provenance() -> dict[str, object]:
    root = Path(__file__).resolve().parents[3]
    modules = (
        "src/notalone/scopes.py",
        "src/notalone/memory/adapters.py",
        "src/notalone/memory/models.py",
        "src/notalone/memory/timing.py",
        "src/notalone/retrieval/lexical.py",
        "src/notalone/retrieval/ranking.py",
        "src/notalone/retrieval/adapters.py",
        "src/notalone/retrieval/models.py",
        "src/notalone/retrieval/ports.py",
        "src/notalone/retrieval/errors.py",
        "src/notalone/reply/context.py",
        "src/notalone/reply/interface.py",
        "src/notalone/reply/errors.py",
        "src/notalone/reply/risk.py",
        "src/notalone/experiments/hindsight_dataset.py",
        "src/notalone/experiments/hindsight_baseline.py",
        "src/notalone/experiments/hindsight_metrics.py",
    )
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    diff = subprocess.run(
        ["git", "diff", "HEAD", "--", *modules],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    return {
        "code_commit_at_run": commit,
        "participating_tracked_diff_sha256": hashlib.sha256(diff).hexdigest(),
        "new_modules_are_covered_by_file_hashes": True,
        "participating_module_sha256": {
            path: hashlib.sha256((root / path).read_bytes()).hexdigest()
            for path in modules
        },
        "baseline_arm": "A: unchanged InMemoryRetrieval + RetrievalReplyContext.build/validate_current",
        "no_external_requests": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="冻结公开合成资料并运行现行词法 Context 基线。"
    )
    parser.add_argument("--output", type=Path, default=Path("experiments/hindsight/v2"))
    parser.add_argument("--freeze-only", action="store_true")
    args = parser.parse_args()
    dataset = build_dataset()
    freeze_dataset(dataset, args.output)
    if args.freeze_only:
        print(f"已冻结 {dataset.dataset_id}：{args.output}")
        return 0
    results = evaluate_dataset(dataset)
    summaries = grouped_summaries(results)
    report = {
        "dataset_id": dataset.dataset_id,
        "dataset_hashes": {
            name: hashlib.sha256(content.encode()).hexdigest()
            for name, content in dataset_documents(dataset).items()
        },
        "provenance": _provenance(),
        "summaries": summaries,
        "results": [asdict(r) for r in results],
    }
    (args.output / "baseline-results.json").write_text(
        canonical_json(report), encoding="utf-8"
    )
    print(canonical_json(summaries))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
