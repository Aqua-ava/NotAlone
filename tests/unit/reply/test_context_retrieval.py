"""Reply Context 与 Retrieval 边界的合成行为测试。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass
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
    RetrievedMessage,
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
    def __init__(self, messages: tuple[RetrievedMessage, ...] = ()) -> None:
        self.messages = messages
        self.message_calls = 0
        self.memory_calls = 0
        self.fail_memory = False

    def search_messages(self, **kwargs: object) -> tuple[RetrievedMessage, ...]:
        del kwargs
        self.message_calls += 1
        return self.messages

    def search_confirmed_memories(self, **kwargs: object) -> tuple[object, ...]:
        del kwargs
        self.memory_calls += 1
        if self.fail_memory:
            raise RuntimeError("synthetic memory retrieval failure")
        return ()


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
                    "周末一起走走吗？",
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
        self.assertEqual(result.current_text, "周末一起走走吗？")
        self.assertEqual(
            tuple(item.kind for item in result.evidence),
            ("message", "message", "confirmed_memory"),
        )
        self.assertTrue(all(item.scope == self.scope for item in result.evidence))
        self.assertEqual(result.skill_library_revision, 7)

    def test_current_l2_directory_narrows_l1_before_context_assembly(self) -> None:
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
            tuple(item.evidence_id for item in result.evidence if item.kind == "confirmed_memory"),
            (memory.memory_id,),
        )
        self.assertEqual(index.calls, [(self.scope, None, 20)])
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
                draft_text="我明天有空",
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
                draft_text="我明天有空",
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


if __name__ == "__main__":
    unittest.main()
