"""原 PostgreSQL＋pgvector 隔离实验的候选导航适配器。

向量索引只返回候选身份；正文、来源、状态和版本始终从本地权威检索端口回读。
该模块不参与正式回复装配。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Protocol
from uuid import UUID

from notalone.retrieval.lexical import build_query_tokens
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
    RetrievedPendingCandidate,
)
from notalone.retrieval.ports import RetrievalPort
from notalone.scopes import ContactScope


@dataclass(frozen=True, slots=True)
class VectorHit:
    """向量候选的最小身份与分数契约。"""

    memory_id: UUID
    scope: ContactScope
    revision: int
    similarity: float


class VectorCandidateClient(Protocol):
    """只负责向量候选导航，不返回关系事实正文。"""

    def search(
        self,
        *,
        scope: ContactScope,
        query: str,
        limit: int,
    ) -> tuple[VectorHit, ...]: ...


@dataclass(frozen=True, slots=True)
class VectorAttemptDiagnostics:
    status: str = "not_called"
    candidates: int = 0
    selected_ids: tuple[UUID, ...] = ()
    rejected: tuple[tuple[str, str], ...] = ()
    error: str = ""


class PgVectorCandidateRetrieval:
    """实验性 RetrievalPort：向量导航后回读本地权威记忆。"""

    def __init__(
        self,
        *,
        local: RetrievalPort,
        client: VectorCandidateClient,
        tau: float,
        candidate_limit: int = 20,
    ) -> None:
        if isinstance(tau, bool) or not isinstance(tau, (int, float)) or not math.isfinite(tau) or not 0.0 < tau <= 1.0:
            raise ValueError("向量相似度阈值必须是 0 到 1 之间的有限值。")
        if (
            not isinstance(candidate_limit, int)
            or isinstance(candidate_limit, bool)
            or not 1 <= candidate_limit <= 100
        ):
            raise ValueError("向量候选预算无效。")
        self.local = local
        self.client = client
        self.tau = tau
        self.candidate_limit = candidate_limit
        self.last_attempt = VectorAttemptDiagnostics()

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        if query is None or memory_ids is not None:
            self.last_attempt = VectorAttemptDiagnostics(status="delegated")
            return self.local.search_confirmed_memories(
                scope=scope, query=query, limit=limit, memory_ids=memory_ids
            )
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 20
        ):
            raise ValueError("记忆 limit 超出预算。")
        if not build_query_tokens(query):
            self.last_attempt = VectorAttemptDiagnostics(status="success")
            return ()

        try:
            raw_hits = self.client.search(
                scope=scope,
                query=query,
                limit=self.candidate_limit,
            )
            rejected: list[tuple[str, str]] = []
            if not isinstance(raw_hits, tuple):
                raise TypeError("向量候选必须是 tuple")
            if len(raw_hits) > self.candidate_limit:
                rejected.append(("<overflow>", "candidate_limit"))
            hits = raw_hits[: self.candidate_limit]
            grouped: dict[UUID, list[VectorHit]] = {}
            for raw_hit in hits:
                key = str(getattr(raw_hit, "memory_id", "<unknown>"))
                reason = ""
                if not isinstance(raw_hit, VectorHit):
                    reason = "mapping"
                elif not isinstance(raw_hit.memory_id, UUID):
                    reason = "mapping"
                elif not isinstance(raw_hit.scope, ContactScope):
                    reason = "scope"
                elif raw_hit.scope != scope:
                    reason = "scope"
                elif (
                    not isinstance(raw_hit.revision, int)
                    or isinstance(raw_hit.revision, bool)
                    or raw_hit.revision < 1
                ):
                    reason = "revision"
                elif (
                    isinstance(raw_hit.similarity, bool)
                    or not isinstance(raw_hit.similarity, (int, float))
                    or not math.isfinite(raw_hit.similarity)
                    or not 0.0 <= raw_hit.similarity <= 1.0
                ):
                    reason = "score"
                elif raw_hit.similarity < self.tau:
                    reason = "below_tau"
                if reason:
                    rejected.append((key, reason))
                    continue
                grouped.setdefault(raw_hit.memory_id, []).append(raw_hit)

            hydrated: list[tuple[float, RetrievedMemory]] = []
            for memory_id, memory_hits in grouped.items():
                local_rows = self.local.search_confirmed_memories(
                    scope=scope,
                    query=None,
                    limit=20,
                    memory_ids=(memory_id,),
                )
                if (
                    len(local_rows) != 1
                    or local_rows[0].scope != scope
                    or local_rows[0].memory_id != memory_id
                    or local_rows[0].status != "active"
                    or not local_rows[0].source_ids
                    or (
                        local_rows[0].valid_at is not None
                        and datetime.now(timezone.utc) < local_rows[0].valid_at
                    )
                    or (
                        local_rows[0].invalid_at is not None
                        and datetime.now(timezone.utc) >= local_rows[0].invalid_at
                    )
                ):
                    rejected.append((str(memory_id), "local_authority"))
                    continue
                memory = local_rows[0]
                current_hits = [
                    hit for hit in memory_hits if hit.revision == memory.revision
                ]
                if not current_hits:
                    rejected.append((str(memory_id), "revision"))
                    continue
                hydrated.append(
                    (
                        max(hit.similarity for hit in current_hits),
                        replace(memory, relevance_score=None, matched_terms=()),
                    )
                )

            hydrated.sort(key=lambda item: (-item[0], str(item[1].memory_id)))
            selected = tuple(memory for _, memory in hydrated[:limit])
            self.last_attempt = VectorAttemptDiagnostics(
                status="success",
                candidates=len(raw_hits),
                selected_ids=tuple(memory.memory_id for memory in selected),
                rejected=tuple(rejected),
            )
            return selected
        except Exception as exc:
            self.last_attempt = VectorAttemptDiagnostics(
                status="failure",
                error=f"{type(exc).__name__}: {exc}",
            )
            raise

    def search_owner_memories(
        self,
        *,
        owner_id: UUID,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        return self.local.search_owner_memories(
            owner_id=owner_id,
            query=query,
            limit=limit,
            memory_ids=memory_ids,
        )

    def search_pending_candidates(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 3,
        candidate_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedPendingCandidate, ...]:
        """向量导航不覆盖待确认候选轨：直接委托本地权威 Port。"""

        return self.local.search_pending_candidates(
            scope=scope,
            query=query,
            limit=limit,
            candidate_ids=candidate_ids,
        )

    def search_messages(
        self,
        *,
        scope: ContactScope,
        target_message_id: UUID | None = None,
        query: str | None = None,
        limit: int = 50,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        timeout_ms: int | None = None,
    ) -> tuple[RetrievedMessage, ...]:
        return self.local.search_messages(
            scope=scope,
            target_message_id=target_message_id,
            query=query,
            limit=limit,
            occurred_after=occurred_after,
            occurred_before=occurred_before,
            timeout_ms=timeout_ms,
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
        return self.local.query_messages(
            scope=scope,
            anchor_message_id=anchor_message_id,
            before=before,
            after=after,
            limit=limit,
            occurred_after=occurred_after,
            occurred_before=occurred_before,
            timeout_ms=timeout_ms,
        )
