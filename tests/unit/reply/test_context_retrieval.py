"""Reply Context 与 Retrieval 边界的合成行为测试。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass, replace
from datetime import datetime
from uuid import UUID

from notalone.memory import (
    AdoptionMethod,
    InMemoryMemoryStore,
    MemoryCandidate,
    MemoryCategory,
)
from notalone.reply.context import (
    ReplyContext,
    ReplyContextInvariantError,
    RetrievalReplyContext,
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
)
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER_ID = UUID("77777777-7777-7777-7777-777777777777")
CONTACT_ID = UUID("88888888-8888-8888-8888-888888888888")
OTHER_CONTACT_ID = UUID("99999999-9999-9999-9999-999999999999")
BINDING_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
TARGET_MESSAGE_ID = UUID("bbbbbbbb-cccc-dddd-eeee-ffffffffffff")
SOURCE_ID = UUID("cccccccc-dddd-eeee-ffff-000000000000")
CANDIDATE_ID = UUID("dddddddd-eeee-ffff-0000-111111111111")


def _ids() -> list[UUID]:
    return [
        UUID("10000000-0000-0000-0000-000000000001"),
        UUID("10000000-0000-0000-0000-000000000002"),
        UUID("10000000-0000-0000-0000-000000000003"),
    ]


class RecordingRetrieval:
    def __init__(
        self,
        messages: tuple[RetrievedMessage, ...] = (),
        memories: tuple[RetrievedMemory, ...] = (),
        owner_memories: tuple[RetrievedOwnerMemory, ...] = (),
    ) -> None:
        self.messages = messages
        self.memories = memories
        self.owner_memories = owner_memories
        self.message_calls = 0
        self.memory_calls = 0
        self.owner_calls = 0
        self.memory_queries: list[str | None] = []
        self.owner_queries: list[str | None] = []
        self.fail_memory = False

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
        del scope
        del target_message_id, query, limit, occurred_after, occurred_before
        del timeout_ms
        self.message_calls += 1
        return self.messages

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
        del scope
        del anchor_message_id, before, after, limit
        del occurred_after, occurred_before, timeout_ms
        raise AssertionError("回复上下文不应调用消息顺序查询。")

    def search_confirmed_memories(
        self,
        *,
        scope: ContactScope,
        query: str | None = None,
        limit: int = 20,
        memory_ids: tuple[UUID, ...] | None = None,
    ) -> tuple[RetrievedMemory, ...]:
        del scope, limit
        self.memory_calls += 1
        self.memory_queries.append(query)
        if self.fail_memory:
            raise RuntimeError("synthetic memory retrieval failure")
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
        del limit
        self.owner_calls += 1
        self.owner_queries.append(query)
        if self.fail_memory:
            raise RuntimeError("synthetic memory retrieval failure")
        return tuple(
            memory
            for memory in self.owner_memories
            if memory.owner_id == owner_id
            and (memory_ids is None or memory.memory_id in memory_ids)
        )


class RecordingMemoryIndex:
    def __init__(
        self,
        memory_ids: tuple[UUID, ...] | None,
        revisions: tuple[int, int | None] | None = None,
    ) -> None:
        self.memory_ids = memory_ids
        self.revisions = revisions
        self.calls: list[tuple[ContactScope, str | None, int]] = []

    def locate_memory_ids(
        self,
        scope: ContactScope,
        *,
        query: str | None = None,
        limit: int = 20,
    ) -> tuple[UUID, ...] | None:
        self.calls.append((scope, query, limit))
        return self.memory_ids

    def revision_snapshot(
        self,
        scope: ContactScope,
    ) -> tuple[int, int | None] | None:
        del scope
        return self.revisions


class ContextRetrievalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.verified_scope = VerifiedConversationScope(
            OWNER_ID,
            CONTACT_ID,
            BINDING_ID,
        )

    def _reply_command(self) -> GenerateReply:
        return GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222222"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(
                TARGET_MESSAGE_ID,
                ConfirmedDirection("温柔地回复", DirectionSource.DIRECT_INPUT),
            ),
        )

    def _retrieval(self) -> InMemoryRetrieval:
        memory_store = InMemoryMemoryStore()
        memory_store.create_candidate(
            MemoryCandidate(
                CANDIDATE_ID,
                self.scope,
                "对方喜欢徒步",
                MemoryCategory.PREFERENCE,
                (SOURCE_ID,),
            )
        )
        memory_store.confirm(
            scope=self.scope,
            candidate_id=CANDIDATE_ID,
            adoption_method=AdoptionMethod.MANUAL,
        )
        return InMemoryRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    self.scope,
                    "周末一起去徒步吗？",
                ),
                RetrievedMessage(
                    UUID("ffffffff-0000-1111-2222-333333333333"),
                    self.scope,
                    "最近天气不错",
                ),
            ),
            memory_store=memory_store,
        )

    def test_reply_context_selects_scoped_messages_and_confirmed_memories(self) -> None:
        ids = iter(_ids())
        context = RetrievalReplyContext(
            retrieval=self._retrieval(),
            skill_library_revision=7,
            id_factory=lambda: next(ids),
        )

        result = context.build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertIsInstance(result, ReplyContext)
        self.assertEqual(result.current_text, "周末一起去徒步吗？")
        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message", "message", "confirmed_memory"),
        )
        self.assertTrue(all(item.scope == self.scope for item in result.evidence))
        self.assertEqual(result.skill_library_revision, 7)

    def test_directory_only_provides_revision_snapshot(self) -> None:
        retrieval = self._retrieval()
        memory = retrieval.memory_store.list_confirmed(self.scope)[0]
        index = RecordingMemoryIndex((memory.memory_id,), revisions=(4, 4))

        result = RetrievalReplyContext(
            retrieval=retrieval,
            memory_index=index,
            skill_library_revision=7,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(
                item.evidence_id
                for item in result.evidence
                if item.kind == "confirmed_memory"
            ),
            (memory.memory_id,),
        )
        self.assertEqual(index.calls, [])
        self.assertEqual(result.memory_revision, 4)
        self.assertEqual(result.index_revision, 4)

    def test_memory_retrieval_failure_falls_back_to_messages(self) -> None:
        retrieval = RecordingRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    self.scope,
                    "当前合成消息",
                ),
            )
        )
        retrieval.fail_memory = True

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(result.current_text, "当前合成消息")
        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message",),
        )

    def test_rewrite_without_explicit_background_does_not_query_memory(self) -> None:
        retrieval = RecordingRetrieval()
        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222223"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="我明天有空",
                user_instruction="更自然一点",
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(command=command, verified_scope=self.verified_scope)

        self.assertEqual(retrieval.message_calls, 0)
        self.assertEqual(retrieval.memory_calls, 0)
        self.assertEqual(retrieval.owner_calls, 0)
        self.assertEqual(tuple(item.kind for item in result.evidence), ("user_draft",))

    def test_rewrite_can_opt_in_to_one_time_contact_background(self) -> None:
        retrieval = RecordingRetrieval()
        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222224"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="我明天有空",
                user_instruction="结合联系人背景，更自然一点",
                include_relationship_context=True,
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(command=command, verified_scope=self.verified_scope)

        self.assertEqual(retrieval.message_calls, 0)
        self.assertEqual(retrieval.memory_calls, 1)
        self.assertEqual(tuple(item.kind for item in result.evidence), ("user_draft",))

    def test_context_rejects_foreign_retrieval_result_instead_of_filtering_it(
        self,
    ) -> None:
        foreign_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        retrieval = RecordingRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    foreign_scope,
                    "另一联系人的合成消息",
                ),
            )
        )

        with self.assertRaises(ReplyContextInvariantError):
            RetrievalReplyContext(
                retrieval=retrieval,
                skill_library_revision=1,
                id_factory=iter(_ids()).__next__,
            ).build(
                command=self._reply_command(),
                verified_scope=self.verified_scope,
            )

    def test_context_attaches_deterministic_risk_hints_without_blocking(self) -> None:
        base = self._reply_command()
        command = GenerateReply(
            idempotency_key=base.idempotency_key,
            scope=base.scope,
            conversation_binding_id=base.conversation_binding_id,
            content=ReplyToMessage(
                TARGET_MESSAGE_ID,
                ConfirmedDirection(
                    "先核实转账，再温柔地回复",
                    DirectionSource.DIRECT_INPUT,
                ),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=self._retrieval(),
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(command=command, verified_scope=self.verified_scope)

        self.assertEqual(result.risk_notes, ("请核实转账相关内容。",))

    def test_current_validation_rejects_message_after_source_is_deleted(self) -> None:
        retrieval = InMemoryRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    self.scope,
                    "当前消息",
                    source_ids=(SOURCE_ID,),
                ),
            )
        )
        context = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
        )
        result = context.build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        retrieval.messages = (
            RetrievedMessage(
                TARGET_MESSAGE_ID,
                self.scope,
                "当前消息",
                source_ids=(SOURCE_ID,),
                status="deleted",
            ),
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)

    def test_current_validation_rejects_message_without_source(self) -> None:
        retrieval = InMemoryRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    self.scope,
                    "当前消息",
                ),
            )
        )
        context = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
        )
        result = context.build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)

    def test_current_validation_rejects_invalidated_memory(self) -> None:
        retrieval = self._retrieval()
        memory = retrieval.memory_store.list_confirmed(self.scope)[0]
        context = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
        )
        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222226"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="周末一起去徒步吗？",
                include_relationship_context=True,
            ),
        )
        result = context.build(
            command=command,
            verified_scope=self.verified_scope,
        )

        retrieval.memory_store.invalidate(
            scope=self.scope,
            memory_id=memory.memory_id,
        )

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)

    def test_current_validation_rechecks_memory_and_skill_revisions(self) -> None:
        retrieval = self._retrieval()
        memory = retrieval.memory_store.list_confirmed(self.scope)[0]
        index = RecordingMemoryIndex((memory.memory_id,), revisions=(4, 4))
        skill_revision = [7]
        context = RetrievalReplyContext(
            retrieval=retrieval,
            memory_index=index,
            skill_library_revision=7,
            skill_revision_reader=lambda scope: skill_revision[0],
            id_factory=iter(_ids()).__next__,
        )
        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222225"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="周末一起去徒步吗？",
                include_relationship_context=True,
            ),
        )
        result = context.build(
            command=command,
            verified_scope=self.verified_scope,
        )
        context.validate_current(result)

        index.revisions = (5, 4)
        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)

        index.revisions = (4, 4)
        skill_revision[0] = 8
        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)

    def test_build_stamps_current_skill_revision_when_reader_available(self) -> None:
        # 装配层在进程启动后读取一次 revision，skill 库随后可能变化。
        # build 必须盖章"当下"的 revision，而不是启动时的旧值；否则
        # 任何 skill 变更都会让后续所有请求在 validate_current 失败。
        retrieval = self._retrieval()
        memory = retrieval.memory_store.list_confirmed(self.scope)[0]
        index = RecordingMemoryIndex((memory.memory_id,), revisions=(4, 4))
        skill_revision = [7]
        context = RetrievalReplyContext(
            retrieval=retrieval,
            memory_index=index,
            skill_library_revision=7,
            skill_revision_reader=lambda scope: skill_revision[0],
            id_factory=iter(_ids()).__next__,
        )
        skill_revision[0] = 8

        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222226"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="周末一起去徒步吗？",
                include_relationship_context=True,
            ),
        )
        built = context.build(
            command=command,
            verified_scope=self.verified_scope,
        )

        self.assertEqual(built.skill_library_revision, 8)
        context.validate_current(built)

    def _memory(
        self,
        memory_id: UUID,
        text: str,
        *,
        score: float,
        matched_terms: tuple[str, ...] = (),
        adoption_method: str = "auto",
        confidence: float = 1.0,
    ) -> RetrievedMemory:
        return RetrievedMemory(
            memory_id=memory_id,
            scope=self.scope,
            text=text,
            category="preference",
            source_ids=(SOURCE_ID,),
            adoption_method=adoption_method,
            revision=1,
            confidence=confidence,
            relevance_score=score,
            matched_terms=matched_terms,
        )

    def test_memory_query_uses_pending_message_text(self) -> None:
        retrieval = RecordingRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    self.scope,
                    "周末一起去徒步吗？",
                ),
            ),
            memories=(
                self._memory(
                    UUID("10000000-0000-0000-0000-000000000010"),
                    "对方喜欢徒步",
                    score=0.8,
                    matched_terms=("徒步",),
                ),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(retrieval.memory_queries, ["周末一起去徒步吗？"])
        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message", "confirmed_memory"),
        )

    def test_rewrite_memory_query_uses_draft_text(self) -> None:
        retrieval = RecordingRetrieval(
            memories=(
                self._memory(
                    UUID("10000000-0000-0000-0000-000000000011"),
                    "对方喜欢徒步",
                    score=0.8,
                ),
            )
        )
        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222227"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="周末一起去徒步吗？",
                include_relationship_context=True,
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(command=command, verified_scope=self.verified_scope)

        self.assertEqual(retrieval.memory_queries, ["周末一起去徒步吗？"])
        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("user_draft", "confirmed_memory"),
        )

    def test_below_threshold_memory_is_not_injected(self) -> None:
        retrieval = RecordingRetrieval(
            messages=(
                RetrievedMessage(TARGET_MESSAGE_ID, self.scope, "周末一起去徒步吗？"),
            ),
            memories=(
                self._memory(
                    UUID("10000000-0000-0000-0000-000000000012"),
                    "对方喜欢徒步",
                    score=0.1,
                ),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message",),
        )

    def test_memory_char_budget_stops_before_oversized_memory(self) -> None:
        retrieval = RecordingRetrieval(
            messages=(
                RetrievedMessage(TARGET_MESSAGE_ID, self.scope, "周末一起去徒步吗？"),
            ),
            memories=(
                self._memory(UUID("10000000-0000-0000-0000-000000000013"), "加" * 250, score=0.9),
                self._memory(UUID("10000000-0000-0000-0000-000000000014"), "班" * 250, score=0.8),
                self._memory(UUID("10000000-0000-0000-0000-000000000015"), "好" * 200, score=0.7),
                self._memory(UUID("10000000-0000-0000-0000-000000000016"), "猫" * 10, score=0.6),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            memory_char_budget=600,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(item.evidence_id for item in result.evidence if item.kind == "confirmed_memory"),
            (
                UUID("10000000-0000-0000-0000-000000000013"),
                UUID("10000000-0000-0000-0000-000000000014"),
            ),
        )

    def test_memory_limit_caps_selected_items(self) -> None:
        retrieval = RecordingRetrieval(
            messages=(
                RetrievedMessage(TARGET_MESSAGE_ID, self.scope, "周末一起去徒步吗？"),
            ),
            memories=tuple(
                self._memory(
                    UUID(f"10000000-0000-0000-0000-00000000002{index}"),
                    "对方喜欢徒步",
                    score=0.9 - index * 0.1,
                )
                for index in range(3)
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            memory_limit=2,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            len([item for item in result.evidence if item.kind == "confirmed_memory"]),
            2,
        )

    def test_selection_reason_records_score_and_matched_terms(self) -> None:
        retrieval = RecordingRetrieval(
            messages=(
                RetrievedMessage(TARGET_MESSAGE_ID, self.scope, "周末一起去徒步吗？"),
            ),
            memories=(
                self._memory(
                    UUID("10000000-0000-0000-0000-000000000017"),
                    "对方喜欢徒步",
                    score=0.42,
                    matched_terms=("徒步", "步"),
                ),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        reason = next(
            item.selection_reason
            for item in result.evidence
            if item.kind == "confirmed_memory"
        )
        self.assertIn("0.42", reason)
        self.assertIn("徒步", reason)
        self.assertIn("步", reason)

    def _owner_memory(
        self,
        memory_id: UUID,
        text: str,
        *,
        score: float,
        matched_terms: tuple[str, ...] = (),
    ) -> RetrievedOwnerMemory:
        return RetrievedOwnerMemory(
            memory_id=memory_id,
            owner_id=OWNER_ID,
            text=text,
            category="preference",
            topic="work",
            source_ids=(SOURCE_ID,),
            adoption_method="manual",
            revision=1,
            relevance_score=score,
            matched_terms=matched_terms,
        )

    def _owner_retrieval(
        self,
        owner_memories: tuple[RetrievedOwnerMemory, ...],
        *,
        memories: tuple[RetrievedMemory, ...] = (),
    ) -> RecordingRetrieval:
        return RecordingRetrieval(
            messages=(
                RetrievedMessage(
                    TARGET_MESSAGE_ID,
                    self.scope,
                    "周末一起去徒步吗？",
                    source_ids=(SOURCE_ID,),
                ),
            ),
            memories=memories,
            owner_memories=owner_memories,
        )

    def test_owner_memory_follows_contact_memory_in_evidence(self) -> None:
        retrieval = self._owner_retrieval(
            (
                self._owner_memory(
                    UUID("10000000-0000-0000-0000-000000000030"),
                    "我喜欢周末徒步",
                    score=0.7,
                    matched_terms=("周末", "徒步"),
                ),
            ),
            memories=(
                self._memory(
                    UUID("10000000-0000-0000-0000-000000000031"),
                    "对方喜欢徒步",
                    score=0.8,
                ),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message", "confirmed_memory", "owner_memory"),
        )
        owner_evidence = next(
            item
            for item in result.evidence
            if item.kind == "owner_memory"
        )
        self.assertEqual(owner_evidence.scope, self.scope)
        self.assertIn("本人", owner_evidence.selection_reason)
        self.assertEqual(retrieval.owner_queries, ["周末一起去徒步吗？"])

    def test_owner_memory_uses_independent_item_budget(self) -> None:
        retrieval = self._owner_retrieval(
            tuple(
                self._owner_memory(
                    UUID(f"10000000-0000-0000-0000-00000000004{index}"),
                    "我喜欢周末徒步",
                    score=0.7,
                )
                for index in range(4)
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            len([item for item in result.evidence if item.kind == "owner_memory"]),
            3,
        )

    def test_owner_memory_uses_independent_char_budget(self) -> None:
        retrieval = self._owner_retrieval(
            (
                self._owner_memory(
                    UUID("10000000-0000-0000-0000-000000000050"),
                    "甲" * 100,
                    score=0.9,
                ),
                self._owner_memory(
                    UUID("10000000-0000-0000-0000-000000000051"),
                    "乙" * 100,
                    score=0.8,
                ),
                self._owner_memory(
                    UUID("10000000-0000-0000-0000-000000000052"),
                    "丙" * 100,
                    score=0.7,
                ),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            len([item for item in result.evidence if item.kind == "owner_memory"]),
            2,
        )

    def test_below_threshold_owner_memory_is_not_injected(self) -> None:
        retrieval = self._owner_retrieval(
            (
                self._owner_memory(
                    UUID("10000000-0000-0000-0000-000000000053"),
                    "我喜欢周末徒步",
                    score=0.1,
                ),
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message",),
        )

    def test_rewrite_opt_in_injects_both_memory_kinds(self) -> None:
        retrieval = self._owner_retrieval(
            (
                self._owner_memory(
                    UUID("10000000-0000-0000-0000-000000000054"),
                    "我喜欢周末徒步",
                    score=0.7,
                ),
            ),
            memories=(
                self._memory(
                    UUID("10000000-0000-0000-0000-000000000055"),
                    "对方喜欢徒步",
                    score=0.8,
                ),
            ),
        )
        command = GenerateReply(
            idempotency_key=UUID("eeeeeeee-ffff-0000-1111-222222222228"),
            scope=self.scope,
            conversation_binding_id=BINDING_ID,
            content=RewriteDraft(
                draft_text="周末一起去徒步吗？",
                include_relationship_context=True,
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(command=command, verified_scope=self.verified_scope)

        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("user_draft", "confirmed_memory", "owner_memory"),
        )

    def test_contact_and_owner_budgets_do_not_share(self) -> None:
        retrieval = self._owner_retrieval(
            tuple(
                self._owner_memory(
                    UUID(f"10000000-0000-0000-0000-00000000006{index}"),
                    "我喜欢周末徒步",
                    score=0.7,
                )
                for index in range(3)
            ),
            memories=tuple(
                self._memory(
                    UUID(f"10000000-0000-0000-0000-00000000007{index}"),
                    "对方喜欢徒步",
                    score=0.8,
                )
                for index in range(6)
            ),
        )

        result = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        ).build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )

        self.assertEqual(
            len([item for item in result.evidence if item.kind == "confirmed_memory"]),
            5,
        )
        self.assertEqual(
            len([item for item in result.evidence if item.kind == "owner_memory"]),
            3,
        )

    def test_current_validation_rejects_owner_memory_revision_change(self) -> None:
        memory = self._owner_memory(
            UUID("10000000-0000-0000-0000-000000000057"),
            "我喜欢周末徒步",
            score=0.7,
        )
        retrieval = self._owner_retrieval((memory,))
        context = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        )
        result = context.build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )
        context.validate_current(result)

        retrieval.owner_memories = (replace(memory, revision=2),)

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)

    def test_current_validation_rejects_deleted_owner_memory(self) -> None:
        retrieval = self._owner_retrieval(
            (
                self._owner_memory(
                    UUID("10000000-0000-0000-0000-000000000056"),
                    "我喜欢周末徒步",
                    score=0.7,
                ),
            ),
        )
        context = RetrievalReplyContext(
            retrieval=retrieval,
            skill_library_revision=1,
            id_factory=iter(_ids()).__next__,
        )
        result = context.build(
            command=self._reply_command(),
            verified_scope=self.verified_scope,
        )
        context.validate_current(result)

        retrieval.owner_memories = ()

        with self.assertRaises(ReplyContextInvariantError):
            context.validate_current(result)


if __name__ == "__main__":
    unittest.main()
