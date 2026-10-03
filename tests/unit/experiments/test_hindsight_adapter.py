"""在真实 Context 接缝验证语义候选和本地权威边界。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from uuid import uuid4

from notalone.experiments.hindsight_adapter import HindsightRetrieval
from notalone.experiments.hindsight_client import RecallBatch, RecallHit, bank_id_for
from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
)
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from notalone.retrieval.lexical import build_query_tokens, score_tokens
from notalone.scopes import ContactScope, VerifiedConversationScope


class SyntheticRecall:
    """只替代外部 Hindsight，不替代本地检索和 Context。"""

    def __init__(self, hits: tuple[RecallHit, ...], complete: bool = True) -> None:
        self.hits = hits
        self.complete = complete

    def recall(self, *, bank_id: str, query: str) -> RecallBatch:
        del query
        return RecallBatch(bank_id, self.hits, self.complete)


class HindsightContextTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(uuid4(), uuid4())
        self.binding = uuid4()
        self.message_id = uuid4()
        self.source_id = uuid4()
        self.query = "牛奶喝完肚子难受，晚餐能换一道吗"
        self.store = InMemoryMemoryStore()
        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=self.scope,
            text="对方乳糖不耐受",
            category=MemoryCategory.PREFERENCE,
            source_ids=(self.source_id,),
            confidence=0.83,
        )
        self.store.create_candidate(candidate)
        self.memory = self.store.confirm(
            scope=self.scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.AUTO,
        )
        self.local = InMemoryRetrieval(
            messages=(
                RetrievedMessage(
                    self.message_id,
                    self.scope,
                    self.query,
                    source_ids=(self.source_id,),
                ),
            ),
            memory_store=self.store,
        )

    def _hit(self, *, reranker: float = 0.91) -> RecallHit:
        return RecallHit(
            "external-unit",
            "external-chunk",
            f"memory-{self.memory.memory_id}",
            {
                "local_memory_id": str(self.memory.memory_id),
                "owner_id": str(self.scope.owner_id),
                "contact_id": str(self.scope.contact_id),
                "layer": "confirmed_memory",
                "revision": "1",
            },
            reranker,
            0.92,
        )

    def _context(self, hits: tuple[RecallHit, ...], complete: bool = True):
        adapter = HindsightRetrieval(
            local=self.local, client=SyntheticRecall(hits, complete), tau=0.5
        )
        context = RetrievalReplyContext(retrieval=adapter, skill_library_revision=0)
        result = context.build(
            command=GenerateReply(
                idempotency_key=uuid4(),
                scope=self.scope,
                conversation_binding_id=self.binding,
                content=ReplyToMessage(
                    self.message_id,
                    ConfirmedDirection("询问晚餐替换", DirectionSource.DIRECT_INPUT),
                ),
            ),
            verified_scope=VerifiedConversationScope(
                self.scope.owner_id, self.scope.contact_id, self.binding
            ),
        )
        context.validate_current(result)
        return result, adapter

    def test_semantic_hit_enters_context_using_local_authority(self) -> None:
        self.assertLess(
            score_tokens(build_query_tokens(self.query), self.memory.text).score, 0.15
        )
        context, adapter = self._context((self._hit(),))
        memories = tuple(
            item for item in context.evidence if item.kind == "confirmed_memory"
        )
        self.assertEqual(tuple(item.text for item in memories), ("对方乳糖不耐受",))
        hydrated = adapter.search_confirmed_memories(
            scope=self.scope, query=self.query
        )[0]
        self.assertEqual(hydrated.confidence, 0.83)
        self.assertEqual(hydrated.adoption_method, "auto")
        self.assertEqual(memories[0].source_ids, (self.source_id,))
        self.assertEqual(adapter.last_attempt.status, "success")

    def test_low_score_does_not_use_empty_local_score_to_inject(self) -> None:
        context, adapter = self._context((self._hit(reranker=0.2),))
        self.assertEqual(
            tuple(e for e in context.evidence if e.kind == "confirmed_memory"), ()
        )
        self.assertEqual(
            adapter.last_attempt.rejected, (("external-unit", "below_tau"),)
        )

    def test_chunks_are_deduplicated_and_stale_revision_is_rejected(self) -> None:
        hit = self._hit()
        context, _ = self._context((hit, replace(hit, unit_id="second-chunk")))
        self.assertEqual(
            len(tuple(e for e in context.evidence if e.kind == "confirmed_memory")), 1
        )
        stale = replace(hit, metadata={**hit.metadata, "revision": "2"})
        context, adapter = self._context((stale,))
        self.assertEqual(
            tuple(e for e in context.evidence if e.kind == "confirmed_memory"), ()
        )
        self.assertEqual(
            adapter.last_attempt.rejected, ((str(self.memory.memory_id), "revision"),)
        )

    def test_stale_high_score_chunk_cannot_promote_current_revision(self) -> None:
        candidate = MemoryCandidate(
            candidate_id=uuid4(),
            scope=self.scope,
            text="对方用豆奶煮粥",
            category=MemoryCategory.PREFERENCE,
            source_ids=(self.source_id,),
            confidence=0.9,
        )
        self.store.create_candidate(candidate)
        other = self.store.confirm(
            scope=self.scope, candidate_id=candidate.candidate_id
        )
        valid = replace(self._hit(), final=0.6)
        stale = replace(
            valid,
            unit_id="stale",
            final=0.99,
            metadata={**valid.metadata, "revision": "2"},
        )
        other_hit = replace(
            valid,
            unit_id="other",
            document_id=f"memory-{other.memory_id}",
            final=0.7,
            metadata={**valid.metadata, "local_memory_id": str(other.memory_id)},
        )
        adapter = HindsightRetrieval(
            local=self.local, client=SyntheticRecall((valid, stale, other_hit)), tau=0.5
        )
        result = adapter.search_confirmed_memories(scope=self.scope, query=self.query)
        self.assertEqual(
            tuple(m.memory_id for m in result), (other.memory_id, self.memory.memory_id)
        )

    def test_context_empty_fallback_keeps_failed_rerank_diagnostic(self) -> None:
        context, adapter = self._context((self._hit(),), complete=False)
        self.assertEqual(
            tuple(e for e in context.evidence if e.kind == "confirmed_memory"), ()
        )
        self.assertEqual(adapter.last_attempt.status, "failure")

    def test_authority_revalidation_survives_unavailable_external_service(self) -> None:
        adapter = HindsightRetrieval(
            local=self.local, client=SyntheticRecall((), complete=False), tau=0.5
        )
        result = adapter.search_confirmed_memories(
            scope=self.scope, query=None, memory_ids=(self.memory.memory_id,)
        )
        self.assertEqual(tuple(m.memory_id for m in result), (self.memory.memory_id,))
        self.assertEqual(adapter.last_attempt.status, "not_called")


if __name__ == "__main__":
    unittest.main()
