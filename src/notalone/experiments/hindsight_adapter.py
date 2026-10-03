"""在已确认 Context 接缝替换候选导航，保留本地权威回读。"""

from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass, replace
from datetime import datetime
from uuid import UUID

from notalone.experiments.hindsight_client import (
    HindsightFailure,
    RecallClient,
    RecallHit,
    bank_id_for,
    document_id_for,
)
from notalone.retrieval.lexical import MAX_QUERY_CHARS, build_query_tokens
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
)
from notalone.retrieval.ports import RetrievalPort
from notalone.scopes import ContactScope


@dataclass(frozen=True)
class AttemptDiagnostics:
    status: str = "not_called"
    candidates: int = 0
    selected_ids: tuple[UUID, ...] = ()
    rejected: tuple[tuple[str, str], ...] = ()
    error: str = ""
    scores: tuple[tuple[str, float, float], ...] = ()
    service_diagnostics: str = ""


class HindsightRetrieval:
    def __init__(
        self, *, local: RetrievalPort, client: RecallClient, tau: float
    ) -> None:
        if not math.isfinite(tau) or not 0 < tau <= 1:
            raise ValueError("tau 必须是独立校准的正归一化阈值。")
        self.local = local
        self.client = client
        self.tau = tau
        self.last_attempt = AttemptDiagnostics()

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        if query is None or memory_ids is not None:
            return self.local.search_confirmed_memories(
                scope=scope, query=query, limit=limit, memory_ids=memory_ids
            )
        if not 1 <= limit <= 20:
            raise ValueError("记忆 limit 超出预算。")
        if not build_query_tokens(query):
            self.last_attempt = AttemptDiagnostics(status="success")
            return ()
        normalized = unicodedata.normalize("NFKC", query).casefold()
        if len(normalized) > MAX_QUERY_CHARS:
            normalized = normalized[:100] + "\n" + normalized[-100:]
        try:
            batch = self.client.recall(bank_id=bank_id_for(scope), query=normalized)
            if batch.bank_id != bank_id_for(scope) or not batch.rerank_complete:
                raise HindsightFailure("bank 或重排完成性无法核对。")
            rejected: list[tuple[str, str]] = []
            grouped: dict[UUID, list[RecallHit]] = {}
            for hit in batch.hits:
                reason = ""
                try:
                    memory_id = UUID(hit.metadata["local_memory_id"])
                    revision = int(hit.metadata["revision"])
                    if (
                        hit.metadata.get("owner_id") != str(scope.owner_id)
                        or hit.metadata.get("contact_id") != str(scope.contact_id)
                        or hit.metadata.get("layer") != "confirmed_memory"
                    ):
                        reason = "scope_or_layer"
                    elif hit.document_id != document_id_for(memory_id) or revision < 1:
                        reason = "mapping"
                    elif (
                        not math.isfinite(hit.reranker)
                        or not 0 <= hit.reranker <= 1
                        or not math.isfinite(hit.final)
                    ):
                        reason = "score"
                    elif hit.reranker < self.tau:
                        reason = "below_tau"
                    if reason:
                        rejected.append((hit.unit_id, reason))
                        continue
                    grouped.setdefault(memory_id, []).append(hit)
                except (KeyError, ValueError, TypeError):
                    rejected.append((hit.unit_id, "mapping"))
            # 先核对当前 revision；旧 chunk 的高分不能提升新版本的排序。
            hydrated: list[tuple[float, RetrievedMemory]] = []
            for memory_id in grouped:
                local = self.local.search_confirmed_memories(
                    scope=scope, query=None, limit=20, memory_ids=(memory_id,)
                )
                if (
                    len(local) != 1
                    or local[0].scope != scope
                    or local[0].memory_id != memory_id
                    or local[0].status != "active"
                    or not local[0].source_ids
                ):
                    rejected.append((str(memory_id), "local_authority"))
                    continue
                memory = local[0]
                current_hits = [
                    hit
                    for hit in grouped[memory_id]
                    if int(hit.metadata["revision"]) == memory.revision
                ]
                if not current_hits:
                    rejected.append((str(memory_id), "revision"))
                    continue
                hydrated.append(
                    (
                        max(hit.final for hit in current_hits),
                        replace(memory, relevance_score=None, matched_terms=()),
                    )
                )
            hydrated.sort(key=lambda item: (-item[0], str(item[1].memory_id)))
            selected = [memory for _, memory in hydrated[:limit]]
            self.last_attempt = AttemptDiagnostics(
                "success",
                len(batch.hits),
                tuple(m.memory_id for m in selected),
                tuple(rejected),
                scores=tuple((h.unit_id, h.reranker, h.final) for h in batch.hits),
                service_diagnostics=batch.diagnostics,
            )
            return tuple(selected)
        except Exception as exc:
            self.last_attempt = AttemptDiagnostics(
                status="failure", error=f"{type(exc).__name__}: {exc}"
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
            owner_id=owner_id, query=query, limit=limit, memory_ids=memory_ids
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
