"""待确认候选进入回复上下文的合成行为测试。

用户 2026-10-05 已确认产品语义：待确认候选可以参与候选回复，但必须
强制带「未确认」标注、不得写成确定事实；用户否决过的候选永久不再参与。
这些用例只使用合成消息、合成候选和合成来源。
"""

from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Iterable
from uuid import UUID

from notalone.memory import (
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
)
from notalone.reply.context import (
    PENDING_CANDIDATE_SELECTION_REASON,
    ContextEvidence,
    ReplyContext,
    ReplyContextInvariantError,
    RetrievalReplyContext,
    pending_candidate_selection_reason,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
    RewriteDraft,
)
from notalone.retrieval import (
    InMemoryRetrieval,
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
    RetrievedPendingCandidate,
)
from notalone.retrieval.lexical import RELEVANCE_THRESHOLD
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER_ID = UUID("77777777-7777-7777-7777-777777777777")
CONTACT_ID = UUID("88888888-8888-8888-8888-888888888888")
OTHER_CONTACT_ID = UUID("99999999-9999-9999-9999-999999999999")
BINDING_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
TARGET_MESSAGE_ID = UUID("bbbbbbbb-cccc-dddd-eeee-ffffffffffff")
SOURCE_ID = UUID("cccccccc-dddd-eeee-ffff-000000000000")
PENDING_ID = UUID("dddddddd-eeee-ffff-0000-111111111111")
SECOND_PENDING_ID = UUID("dddddddd-eeee-ffff-0000-222222222222")
THIRD_PENDING_ID = UUID("dddddddd-eeee-ffff-0000-333333333333")
FOURTH_PENDING_ID = UUID("dddddddd-eeee-ffff-0000-444444444444")


class MutableCandidateStore:
    """只暴露候选列表的合成 store，用于模拟生成前后的状态变化。"""

    def __init__(self, candidates: Iterable[MemoryCandidate] = ()) -> None:
        self.candidates = tuple(candidates)
        self.pending_lists = 0

    def list_pending_candidates(self, scope: ContactScope) -> tuple[MemoryCandidate, ...]:
        self.pending_lists += 1
        return tuple(
            candidate for candidate in self.candidates if candidate.scope == scope
        )

    def list_confirmed(self, scope: ContactScope) -> tuple[object, ...]:
        del scope
        return ()


class RecordingPendingRetrieval:
    """记录待确认候选查询的合成检索适配器。"""

    def __init__(
        self,
        *,
        messages: tuple[RetrievedMessage, ...] = (),
        memories: tuple[RetrievedMemory, ...] = (),
        owner_memories: tuple[RetrievedOwnerMemory, ...] = (),
        pending: tuple[RetrievedPendingCandidate, ...] = (),
    ) -> None:
        self.messages = messages
        self.memories = memories
        self.owner_memories = owner_memories
        self.pending = pending
        self.pending_calls = 0
        self.pending_queries: list[str | None] = []
        self.pending_ids: list[tuple[UUID, ...] | None] = []
        self.fail_pending = False
        self.ignore_pending_scope = False

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
        del scope, target_message_id, query, limit
        del occurred_after, occurred_before, timeout_ms
        return self.messages

    def query_messages(self, **_: object) -> tuple[RetrievedMessage, ...]:
        raise AssertionError("回复上下文不应调用消息顺序查询。")

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        del scope, query, limit
        return tuple(
            memory
            for memory in self.memories
            if memory_ids is None or memory.memory_id in memory_ids
        )

    def search_owner_memories(
        self,
        *,
        owner_id: UUID,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        del query, limit
        return tuple(
            memory
            for memory in self.owner_memories
            if memory.owner_id == owner_id
            and (memory_ids is None or memory.memory_id in memory_ids)
        )

    def search_pending_candidates(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 3,
        candidate_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedPendingCandidate, ...]:
        self.pending_calls += 1
        self.pending_queries.append(query)
        self.pending_ids.append(candidate_ids)
        if self.fail_pending:
            raise RuntimeError("synthetic pending retrieval failure")
        return tuple(
            candidate
            for candidate in self.pending
            if (self.ignore_pending_scope or candidate.scope == scope)
            and (candidate_ids is None or candidate.candidate_id in candidate_ids)
        )[:limit]


class LegacyPendinglessRetrieval:
    """故意不实现协议声明的待确认候选轨，用于验证失败关闭。"""

    def __init__(self, *, messages: tuple[RetrievedMessage, ...] = ()) -> None:
        self.messages = messages

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
        del scope, target_message_id, query, limit
        del occurred_after, occurred_before, timeout_ms
        return self.messages

    def query_messages(self, **_: object) -> tuple[RetrievedMessage, ...]:
        raise AssertionError("回复上下文不应调用消息顺序查询。")

    def search_confirmed_memories(self, **_: object) -> tuple[RetrievedMemory, ...]:
        return ()

    def search_owner_memories(
        self,
        **_: object,
    ) -> tuple[RetrievedOwnerMemory, ...]:
        return ()


class PendingCandidateContextTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.verified_scope = VerifiedConversationScope(
            OWNER_ID,
            CONTACT_ID,
            BINDING_ID,
        )

    def _message(self, text: str = "最近在忙什么？") -> RetrievedMessage:
        return RetrievedMessage(
            TARGET_MESSAGE_ID,
            self.scope,
            text,
            source_ids=(SOURCE_ID,),
            occurred_at=datetime(2026, 9, 20, tzinfo=timezone.utc),
        )

    def _pending(
        self,
        candidate_id: UUID = PENDING_ID,
        text: str = "对方下个月准备换工作",
        *,
        scope: ContactScope | None = None,
        score: float | None = None,
        matched_terms: tuple[str, ...] = (),
        confidence: float = 1.0,
        risk_flags: tuple[str, ...] = (),
    ) -> RetrievedPendingCandidate:
        return RetrievedPendingCandidate(
            candidate_id=candidate_id,
            scope=scope or self.scope,
            text=text,
            category="preference",
            source_ids=(SOURCE_ID,),
            topic="work",
            confidence=confidence,
            risk_flags=risk_flags,
            relevance_score=score,
            matched_terms=matched_terms,
        )

    def _reply_command(self) -> GenerateReply:
        return GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222222"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(
                TARGET_MESSAGE_ID,
                ConfirmedDirection("关心一下近况", DirectionSource.DIRECT_INPUT),
            ),
        )

    def _rewrite_command(self, *, background: bool) -> GenerateReply:
        return GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222223"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="最近在忙什么？",
                include_relationship_context=background,
            ),
        )

    def _context(self, retrieval: object, **kwargs: object) -> RetrievalReplyContext:
        return RetrievalReplyContext(
            retrieval=retrieval,  # type: ignore[arg-type]
            skill_library_revision=1,
            **kwargs,  # type: ignore[arg-type]
        )

    def test_pending_candidate_evidence_carries_unconfirmed_label(self) -> None:
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            pending=(self._pending(),),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message", "pending_candidate"),
        )
        evidence = result.evidence[1]
        self.assertEqual(evidence.status, "pending")
        self.assertEqual(evidence.evidence_id, PENDING_ID)
        self.assertIsNone(evidence.revision)
        self.assertIn("未确认", evidence.selection_reason)
        self.assertIn("不得当作事实", evidence.selection_reason)
        self.assertEqual(retrieval.pending_queries, ["最近在忙什么？"])

    def test_pending_selection_reason_records_score_and_matched_terms(self) -> None:
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            pending=(self._pending(score=0.42, matched_terms=("换工作",)),),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        reason = result.evidence[1].selection_reason
        self.assertIn("0.42", reason)
        self.assertIn("换工作", reason)
        self.assertIn("未确认", reason)

    def test_pending_selection_reason_carries_confidence_and_risk_flags(self) -> None:
        """票 02 验收第 2 条：为什么待确认必须进入回复侧，而不只是检索侧。"""

        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            pending=(
                self._pending(
                    confidence=0.62,
                    risk_flags=("low_confidence", "needs_user_confirmation"),
                ),
            ),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        reason = result.evidence[1].selection_reason
        self.assertTrue(reason.startswith(PENDING_CANDIDATE_SELECTION_REASON))
        self.assertIn("0.62", reason)
        self.assertIn("low_confidence", reason)
        self.assertIn("needs_user_confirmation", reason)
        # 分类与主题同样并入理由，方便人工核对这条候选的类型。
        self.assertIn("preference", reason)
        self.assertIn("work", reason)

    def test_pending_selection_reason_marks_missing_risk_flags(self) -> None:
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            pending=(self._pending(),),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        reason = result.evidence[1].selection_reason
        self.assertIn("置信度 1.00", reason)
        self.assertIn("风险标记 无", reason)

    def test_pending_candidate_budget_is_independent_from_confirmed_memory(
        self,
    ) -> None:
        memories = tuple(
            RetrievedMemory(
                UUID(f"10000000-0000-0000-0000-00000000001{index}"),
                self.scope,
                "对方喜欢徒步",
                "preference",
                (SOURCE_ID,),
                "auto",
                1,
                relevance_score=0.9,
            )
            for index in range(6)
        )
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            memories=memories,
            pending=(
                self._pending(PENDING_ID),
                self._pending(SECOND_PENDING_ID, "对方正在考虑养猫"),
                self._pending(THIRD_PENDING_ID, "对方想换个城市"),
                self._pending(FOURTH_PENDING_ID, "对方在学吉他"),
            ),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            len([item for item in result.evidence if item.kind == "confirmed_memory"]),
            5,
        )
        self.assertEqual(
            len([item for item in result.evidence if item.kind == "pending_candidate"]),
            3,
        )

    def test_pending_candidate_char_budget_stops_before_oversized_candidate(
        self,
    ) -> None:
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            pending=(
                self._pending(PENDING_ID, "甲" * 200, score=0.9),
                self._pending(SECOND_PENDING_ID, "乙" * 200, score=0.8),
                self._pending(THIRD_PENDING_ID, "丙" * 200, score=0.7),
            ),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(
                item.evidence_id
                for item in result.evidence
                if item.kind == "pending_candidate"
            ),
            (PENDING_ID,),
        )

    def test_below_threshold_pending_candidate_is_not_injected(self) -> None:
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            pending=(self._pending(score=RELEVANCE_THRESHOLD / 2),),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message",),
        )

    def test_rewrite_without_background_never_queries_or_injects_pending(
        self,
    ) -> None:
        retrieval = RecordingPendingRetrieval(pending=(self._pending(),))

        result = self._context(retrieval).build(
            command=self._rewrite_command(background=False),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(retrieval.pending_calls, 0)
        self.assertEqual(tuple(item.kind for item in result.evidence), ("user_draft",))
        self.assertFalse(result.has_unauthorized_history())

    def test_rewrite_with_background_injects_pending_candidate(self) -> None:
        retrieval = RecordingPendingRetrieval(pending=(self._pending(),))

        result = self._context(retrieval).build(
            command=self._rewrite_command(background=True),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(retrieval.pending_calls, 1)
        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("user_draft", "pending_candidate"),
        )

    def test_unauthorized_history_counts_pending_candidate(self) -> None:
        retrieval = RecordingPendingRetrieval()
        command = self._rewrite_command(background=False)
        built = self._context(retrieval).build(
            command=command,
            verified_scope=self.verified_scope,
        )
        forged = ReplyContext(
            reply_request_id=built.reply_request_id,
            command=command,
            scope=self.scope,
            current_text=built.current_text,
            direction=None,
            evidence=built.evidence
            + (
                ContextEvidence(
                    evidence_id=PENDING_ID,
                    kind="pending_candidate",
                    text="对方下个月准备换工作",
                    scope=self.scope,
                    source_ids=(SOURCE_ID,),
                    selection_reason="未确认候选、仅供参考、不得当作事实。",
                    status="pending",
                ),
            ),
            skill_library_revision=1,
        )

        self.assertTrue(forged.has_unauthorized_history())
        with self.assertRaises(ReplyContextInvariantError):
            self._context(retrieval).validate_current(forged)

    def test_pending_evidence_order_follows_confirmed_and_owner_memory(self) -> None:
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            memories=(
                RetrievedMemory(
                    UUID("10000000-0000-0000-0000-000000000020"),
                    self.scope,
                    "对方喜欢徒步",
                    "preference",
                    (SOURCE_ID,),
                    "auto",
                    1,
                    relevance_score=0.9,
                ),
            ),
            owner_memories=(
                RetrievedOwnerMemory(
                    UUID("10000000-0000-0000-0000-000000000021"),
                    OWNER_ID,
                    "我喜欢徒步",
                    "preference",
                    "sports",
                    (SOURCE_ID,),
                    "manual",
                    1,
                    relevance_score=0.9,
                ),
            ),
            pending=(self._pending(),),
        )

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message", "confirmed_memory", "owner_memory", "pending_candidate"),
        )

    def test_pending_retrieval_failure_falls_back_to_other_evidence(self) -> None:
        retrieval = RecordingPendingRetrieval(messages=(self._message(),))
        retrieval.fail_pending = True

        result = self._context(retrieval).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(tuple(item.kind for item in result.evidence), ("message",))

    def test_foreign_scope_pending_candidate_is_rejected(self) -> None:
        retrieval = RecordingPendingRetrieval(
            messages=(self._message(),),
            pending=(
                self._pending(
                    scope=ContactScope(OWNER_ID, OTHER_CONTACT_ID),
                ),
            ),
        )
        retrieval.ignore_pending_scope = True

        with self.assertRaises(ReplyContextInvariantError):
            self._context(retrieval).build(
                command=self._reply_command(),
                verified_scope=self.verified_scope,
            )

    def test_adapter_without_pending_track_fails_closed(self) -> None:
        """协议声明的待确认候选轨缺失时必须失败关闭，不能静默当成没有候选。"""

        retrieval = LegacyPendinglessRetrieval(messages=(self._message(),))

        with self.assertRaises(ReplyContextInvariantError):
            self._context(retrieval).build(
                command=self._reply_command(),
                verified_scope=self.verified_scope,
            )


class PendingCandidateRevalidationTest(unittest.TestCase):
    """快照生成后候选状态变化必须拒绝本轮，而不是继续使用旧快照。"""

    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.verified_scope = VerifiedConversationScope(
            OWNER_ID,
            CONTACT_ID,
            BINDING_ID,
        )
        self.store = MutableCandidateStore()

    def _candidate(self, **overrides: object) -> MemoryCandidate:
        values: dict[str, object] = {
            "candidate_id": PENDING_ID,
            "scope": self.scope,
            "text": "对方下个月准备换工作",
            "category": MemoryCategory.PREFERENCE,
            "source_ids": (SOURCE_ID,),
        }
        values.update(overrides)
        return MemoryCandidate(**values)  # type: ignore[arg-type]

    def _retrieval(self) -> InMemoryRetrieval:
        return InMemoryRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    self.scope,
                    "他下个月准备换工作吗？",
                    source_ids=(SOURCE_ID,),
                ),
            ),
            memory_store=self.store,  # type: ignore[arg-type]
        )

    def _build(self):
        context = RetrievalReplyContext(
            retrieval=self._retrieval(),
            skill_library_revision=1,
        )
        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222224"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(
                TARGET_MESSAGE_ID,
                ConfirmedDirection("关心一下近况", DirectionSource.DIRECT_INPUT),
            ),
        )
        built = context.build(
            command=command,
            verified_scope=self.verified_scope,
        )
        return context, built

    def test_current_snapshot_passes_revalidation(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()
        self.assertEqual(
            tuple(item.kind for item in built.evidence),
            ("message", "pending_candidate"),
        )

        context.validate_current(built)

    def test_confirmed_candidate_no_longer_participates(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = (
            self._candidate(status=MemoryCandidateStatus.CONFIRMED),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_rejected_candidate_never_participates_again(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = (
            self._candidate(status=MemoryCandidateStatus.REJECTED),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_invalidated_candidate_no_longer_participates(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = (
            self._candidate(status=MemoryCandidateStatus.INVALIDATED),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_candidate_out_of_scope_no_longer_participates(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = (
            self._candidate(scope=ContactScope(OWNER_ID, OTHER_CONTACT_ID)),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_candidate_expired_between_build_and_validation_is_rejected(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = (
            self._candidate(
                invalid_at=datetime.now(timezone.utc) - timedelta(minutes=1),
            ),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_candidate_text_change_is_rejected(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = (self._candidate(text="对方其实已经辞职了"),)

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_forged_confirmed_annotation_is_rejected(self) -> None:
        """状态仍是 pending、理由却写成「已确认」的伪造标注必须被拒绝。"""

        self.store.candidates = (self._candidate(),)
        context, built = self._build()
        forged = replace(
            built,
            evidence=tuple(
                replace(item, selection_reason="已确认、可以当作事实。")
                if item.kind == "pending_candidate"
                else item
                for item in built.evidence
            ),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(forged)

    def test_stale_reason_without_candidate_details_is_rejected(self) -> None:
        """理由必须与重新读取到的候选一致，不能只剩下拼接用的常量前缀。"""

        self.store.candidates = (self._candidate(),)
        context, built = self._build()
        assert_stale = replace(
            built,
            evidence=tuple(
                replace(
                    item,
                    selection_reason=PENDING_CANDIDATE_SELECTION_REASON,
                )
                if item.kind == "pending_candidate"
                else item
                for item in built.evidence
            ),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(assert_stale)

    def test_reason_follows_candidate_confidence_change(self) -> None:
        """候选置信度变化后，旧快照的理由不再匹配，必须拒绝本轮。"""

        self.store.candidates = (self._candidate(),)
        context, built = self._build()
        self.assertIn("置信度 1.00", built.evidence[1].selection_reason)

        self.store.candidates = (self._candidate(confidence=0.31),)

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_candidate_source_change_is_rejected(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = (
            self._candidate(source_ids=(UUID(int=1),)),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_removed_candidate_is_rejected(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        self.store.candidates = ()

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(built)

    def test_revalidation_asks_only_for_snapshot_candidates(self) -> None:
        self.store.candidates = (self._candidate(),)
        context, built = self._build()

        context.validate_current(built)

        # build 与 validate_current 各读一次候选列表，且快照复验仍按候选 ID 收窄。
        self.assertEqual(self.store.pending_lists, 2)


if __name__ == "__main__":
    unittest.main()
