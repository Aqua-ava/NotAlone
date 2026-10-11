"""显式替换的低层事务接缝；仅使用隔离 PostgreSQL 与合成输入。"""

from __future__ import annotations

import os
import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.application.reply_service import ReplyServiceRequest
from notalone.application.assistant_session_service import (
    AssistantSessionNotFound, AssistantSessionPersistenceError, AssistantSessionRejected, AssistantTurn,
)
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.interface import ContextReceipt, GenerateReply, ReplyGenerated, RewriteDraft
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import ReplyAttemptState, ReplyRequest, ReplyRequestState, ValidatedReply
from notalone.scopes import ContactScope, VerifiedConversationScope


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class AssistantGenerationReplacementTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定本票隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("替换请求验收只允许隔离 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成替换用户')",
                (self.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, '合成替换联系人')",
                (self.owner_id, self.contact_id),
            )
        self.addCleanup(self._clean_owner)
        binding = PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-replacement-account", conversation_locator=f"synthetic-{uuid4()}",
        )
        self.binding_id = binding.binding_id
        self.session_store = PostgresAssistantSessionStore(DATABASE_URL)
        self.reply_store = PostgresReplyStore(DATABASE_URL)
        self.session_id = self.session_store.default(self.scope)
        self.verified_scope = VerifiedConversationScope(self.owner_id, self.contact_id, self.binding_id)

    def _clean_owner(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id = %s", (self.owner_id,))

    def _reserve(
        self, text: str = "合成旧草稿", *, include_relationship_context: bool = False,
    ) -> tuple[ReplyServiceRequest, AssistantTurn, GenerateReply]:
        request = ReplyServiceRequest(idempotency_key=uuid4(), content=RewriteDraft(
            draft_text=text, include_relationship_context=include_relationship_context,
        ))
        turn_id = self.session_store.reserve(self.scope, self.session_id, request)
        turn = next(item for item in self.session_store.read(self.scope, self.session_id) if item.turn_id == turn_id)
        command = request.build_command(owner_id=self.owner_id, contact_id=self.contact_id,
                                        binding_id=self.binding_id)
        if command is None:
            raise AssertionError("合成草稿必须生成有效回复命令。")
        return request, turn, command

    def _start(
        self, command: GenerateReply, extra_evidence: tuple[ContextEvidence, ...] = (),
    ) -> tuple[ReplyRequest, ReplyContext, ValidatedReply]:
        if not isinstance(command.content, RewriteDraft):
            raise AssertionError("此夹具只用于合成草稿。")
        started = self.reply_store.start(command, self.verified_scope)
        draft_id = uuid4()
        context = ReplyContext(
            reply_request_id=started.request.request_id, command=command, scope=self.scope,
            current_text=command.content.draft_text, direction=None, skill_library_revision=0,
            evidence=(ContextEvidence(evidence_id=draft_id, kind="user_draft",
                                      text=command.content.draft_text, scope=self.scope,
                                      selection_reason="用户本轮合成草稿"), *extra_evidence),
        )
        self.reply_store.prepare_context(started.request, context)
        reply = ValidatedReply(candidates=(RuntimeCandidate(
            text="合成旧响应晚到", basis="本轮草稿", citation_ids=(draft_id,), risk_notes=(),
        ),), used_skill=None)
        return started.request, context, reply

    def _source(self) -> tuple[UUID, UUID]:
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-replacement.jsonl', %s, 1)",
                (source_id, self.owner_id, self.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message (id, owner_id, contact_id, speaker, message_type, text_content) "
                "VALUES (%s, %s, %s, 'contact', 'text', '合成本轮上下文')",
                (message_id, self.owner_id, self.contact_id),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)",
                (message_id, self.owner_id, self.contact_id, source_id, str(message_id)),
            )
        return source_id, message_id

    def _invalidate(self, turn_id: UUID, input_version_id: UUID) -> bool:
        from notalone.persistence.assistant_generation_replacement import invalidate_running_generation
        with psycopg.connect(DATABASE_URL) as connection:
            return invalidate_running_generation(
                connection, self.scope, self.session_id, turn_id, input_version_id,
            )

    def test_invalidating_a_running_generation_rejects_late_save_and_preserves_discussion(self) -> None:
        discussion = self.session_store.record_discussion_input(
            self.scope, self.session_id,
            {"type": "purpose_exploration", "purpose_hint": "合成独立讨论继续保留"},
        )
        _, turn, command = self._reserve()
        lease, context, reply = self._start(command)

        self._invalidate(turn.turn_id, turn.input_version_id)

        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.save(lease, context, reply)
        saved = self.session_store.read_session(self.scope, self.session_id)
        self.assertEqual(saved.turns[0].state, "failed")
        self.assertIsNone(saved.turns[0].reply)
        self.assertEqual(saved.turns[0].input["content"]["draft_text"], "合成旧草稿")
        self.assertEqual(saved.inputs[0].input_version_id, discussion)
        self.assertEqual(saved.inputs[0].content["purpose_hint"], "合成独立讨论继续保留")
        stored = self.reply_store.read(lease.request_id, self.scope)
        self.assertEqual(stored.state, ReplyAttemptState.FAILED)
        self.assertIsNone(stored.result)
        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.start(command, self.verified_scope)

    def test_repeating_controlled_invalidation_keeps_the_same_failed_attempt(self) -> None:
        _, turn, command = self._reserve()
        lease, _, _ = self._start(command)

        self.assertTrue(self._invalidate(turn.turn_id, turn.input_version_id))
        self.assertFalse(self._invalidate(turn.turn_id, turn.input_version_id))

        stored = self.reply_store.read(lease.request_id, self.scope)
        self.assertEqual(len(stored.attempts), 1)
        self.assertEqual(stored.attempts[0].failure_reason, "generation_replaced")
        self.assertEqual(stored.state, ReplyAttemptState.FAILED)

    def test_retried_current_lease_is_invalidated_without_overwriting_failed_history(self) -> None:
        request, turn, command = self._reserve()
        first_lease, _, _ = self._start(command)
        self.reply_store.fail(first_lease, reason="synthetic_model_failed")
        self.session_store.fail(self.scope, turn.turn_id)
        self.assertEqual(self.session_store.reserve(self.scope, self.session_id, request), turn.turn_id)
        lease, context, reply = self._start(command)
        self.assertEqual(lease.attempt, 2)

        self.assertTrue(self._invalidate(turn.turn_id, turn.input_version_id))

        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.save(lease, context, reply)
        stored = self.reply_store.read(lease.request_id, self.scope)
        self.assertEqual(len(stored.attempts), 2)
        self.assertEqual(stored.attempts[0].failure_reason, "synthetic_model_failed")
        self.assertEqual(stored.attempts[1].failure_reason, "generation_replaced")
        self.assertEqual(stored.state, ReplyAttemptState.FAILED)

    def test_reserved_turn_is_invalidated_before_a_late_reply_start(self) -> None:
        _, turn, command = self._reserve()

        self.assertTrue(self._invalidate(turn.turn_id, turn.input_version_id))

        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.start(command, self.verified_scope)
        saved = self.session_store.read(self.scope, self.session_id)[0]
        self.assertEqual(saved.state, "failed")
        self.assertIsNone(saved.reply)
        self.assertEqual(saved.input["content"]["draft_text"], "合成旧草稿")

    def test_session_completion_cannot_accept_a_late_uncommitted_reply(self) -> None:
        _, turn, command = self._reserve()
        lease, context, _ = self._start(command)
        self._invalidate(turn.turn_id, turn.input_version_id)
        claimed_reply = ReplyGenerated(
            reply_request_id=lease.request_id, candidates=(),
            context_receipt=ContextReceipt(tuple(item.evidence_id for item in context.evidence)),
            used_skill=None,
        )

        with self.assertRaises(AssistantSessionPersistenceError):
            self.session_store.complete(self.scope, self.session_id, turn.turn_id, claimed_reply)

        saved = self.session_store.read(self.scope, self.session_id)[0]
        self.assertEqual(saved.state, "failed")
        self.assertIsNone(saved.reply)

    def test_completed_reply_wins_before_or_after_session_completion(self) -> None:
        for complete_session_first in (False, True):
            with self.subTest(complete_session_first=complete_session_first):
                _, turn, command = self._reserve()
                lease, context, reply = self._start(command)
                saved_reply = self.reply_store.save(lease, context, reply)
                if complete_session_first:
                    self.session_store.complete(self.scope, self.session_id, turn.turn_id, saved_reply)

                with self.assertRaises(AssistantSessionRejected) as rejected:
                    self._invalidate(turn.turn_id, turn.input_version_id)
                self.assertEqual(rejected.exception.reason, "generation_not_running")

                completed = self.session_store.complete(self.scope, self.session_id, turn.turn_id, saved_reply)
                self.assertEqual(completed.state, "completed")
                self.assertEqual(completed.reply, saved_reply)
                replay = self.reply_store.start(command, self.verified_scope)
                self.assertEqual(replay.state, ReplyRequestState.REPLAYED)
                self.assertEqual(replay.result, saved_reply)

    def test_invalidation_uses_the_callers_transaction_and_rolls_back_as_a_whole(self) -> None:
        from notalone.persistence.assistant_generation_replacement import invalidate_running_generation
        _, turn, command = self._reserve()
        lease, context, reply = self._start(command)

        with self.assertRaisesRegex(RuntimeError, "synthetic_transaction_aborted"):
            with psycopg.connect(DATABASE_URL) as connection:
                self.assertTrue(invalidate_running_generation(
                    connection, self.scope, self.session_id, turn.turn_id, turn.input_version_id,
                ))
                raise RuntimeError("synthetic_transaction_aborted")

        self.assertEqual(self.session_store.read(self.scope, self.session_id)[0].state, "running")
        self.assertEqual(self.reply_store.start(command, self.verified_scope).state, ReplyRequestState.IN_PROGRESS)
        saved_reply = self.reply_store.save(lease, context, reply)
        completed = self.session_store.complete(self.scope, self.session_id, turn.turn_id, saved_reply)
        self.assertEqual(completed.reply, saved_reply)

    def test_foreign_scope_session_turn_and_stale_input_cannot_revoke_the_current_lease(self) -> None:
        from notalone.persistence.assistant_generation_replacement import invalidate_running_generation
        _, turn, command = self._reserve()
        lease, context, reply = self._start(command)
        cases = (
            (ContactScope(uuid4(), self.contact_id), self.session_id, turn.turn_id, turn.input_version_id),
            (ContactScope(self.owner_id, uuid4()), self.session_id, turn.turn_id, turn.input_version_id),
            (self.scope, uuid4(), turn.turn_id, turn.input_version_id),
            (self.scope, self.session_id, uuid4(), turn.input_version_id),
            (self.scope, self.session_id, turn.turn_id, uuid4()),
        )

        for scope, session_id, turn_id, input_version_id in cases:
            with self.subTest(scope=scope, session_id=session_id, turn_id=turn_id):
                with self.assertRaises((AssistantSessionNotFound, AssistantSessionRejected)):
                    with psycopg.connect(DATABASE_URL) as connection:
                        invalidate_running_generation(connection, scope, session_id, turn_id, input_version_id)

        self.assertEqual(self.reply_store.start(command, self.verified_scope).state, ReplyRequestState.IN_PROGRESS)
        saved_reply = self.reply_store.save(lease, context, reply)
        completed = self.session_store.complete(self.scope, self.session_id, turn.turn_id, saved_reply)
        self.assertEqual(completed.reply, saved_reply)

    def test_unrelated_tombstones_do_not_prove_controlled_replacement(self) -> None:
        for started_reply in (False, True):
            with self.subTest(started_reply=started_reply):
                request, turn, command = self._reserve()
                if started_reply:
                    lease, _, _ = self._start(command)
                    self.reply_store.fail(lease, reason="synthetic_model_failed")
                self.session_store.fail(self.scope, turn.turn_id)
                with psycopg.connect(DATABASE_URL) as connection:
                    connection.execute(
                        "INSERT INTO public.reply_invalidated_key (owner_id, contact_id, idempotency_key) "
                        "VALUES (%s, %s, %s)",
                        (self.owner_id, self.contact_id, request.idempotency_key),
                    )

                with self.assertRaises(AssistantSessionRejected) as rejected:
                    self._invalidate(turn.turn_id, turn.input_version_id)
                self.assertEqual(rejected.exception.reason, "request_deleted")

                if started_reply:
                    stored = self.reply_store.read(lease.request_id, self.scope)
                    self.assertEqual(stored.attempts[0].failure_reason, "synthetic_model_failed")
                with self.assertRaises(ReplyStoreInvariantError):
                    self.reply_store.start(command, self.verified_scope)

    def _assert_source_input_erased(self, turn_id: UUID, input_version_id: UUID) -> None:
        # 同时核验物理正文清除及 CURRENT 失效，不能只用读取层遮挡。
        with psycopg.connect(DATABASE_URL) as connection:
            actual = connection.execute(
                "SELECT session.current_input_version_id, input.state, input.content, "
                "input.dependency_ids, turn.input_payload FROM public.assistant_session AS session "
                "JOIN public.assistant_session_input AS input ON input.session_id = session.id "
                "AND input.owner_id = session.owner_id AND input.contact_id = session.contact_id "
                "JOIN public.assistant_session_turn AS turn ON turn.id = input.turn_id "
                "AND turn.owner_id = input.owner_id AND turn.contact_id = input.contact_id "
                "WHERE session.owner_id = %s AND session.contact_id = %s AND session.id = %s "
                "AND turn.id = %s AND input.id = %s",
                (self.owner_id, self.contact_id, self.session_id, turn_id, input_version_id),
            ).fetchone()
        self.assertEqual(actual, (None, "redacted", None, [], None))

    def test_pending_context_source_is_rejected_and_actual_deletion_cannot_be_replayed(self) -> None:
        source_id, message_id = self._source()
        _, turn, command = self._reserve(include_relationship_context=True)
        lease, context, reply = self._start(command, extra_evidence=(ContextEvidence(
            evidence_id=message_id, kind="message", text="合成本轮上下文", scope=self.scope,
            source_ids=(source_id,), selection_reason="本轮实际采用的合成上下文",
        ),))
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.source_document SET status = 'delete_requested' WHERE id = %s",
                               (source_id,))

        with self.assertRaises(AssistantSessionRejected) as rejected:
            self._invalidate(turn.turn_id, turn.input_version_id)
        self.assertEqual(rejected.exception.reason, "source_unavailable")
        self.assertEqual(self.reply_store.read(lease.request_id, self.scope).state, ReplyAttemptState.RUNNING)
        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.save(lease, context, reply)

        deletion = PostgresSourceDeletionRepository(DATABASE_URL)
        deletion.delete_source(owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=source_id)
        deletion.verify_deleted(owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=source_id)
        saved = self.session_store.read(self.scope, self.session_id)[0]
        self.assertEqual(saved.state, "redacted")
        self.assertIsNone(saved.input)
        with self.assertRaises(AssistantSessionRejected) as rejected:
            self._invalidate(turn.turn_id, turn.input_version_id)
        self.assertEqual(rejected.exception.reason, "input_version_stale")
        self._assert_source_input_erased(turn.turn_id, turn.input_version_id)
        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.start(command, self.verified_scope)

    def test_source_deletion_after_controlled_replacement_is_not_a_successful_replay(self) -> None:
        source_id, message_id = self._source()
        _, turn, command = self._reserve(include_relationship_context=True)
        self._start(command, extra_evidence=(ContextEvidence(
            evidence_id=message_id, kind="message", text="合成本轮上下文", scope=self.scope,
            source_ids=(source_id,), selection_reason="本轮实际采用的合成上下文",
        ),))
        self.assertTrue(self._invalidate(turn.turn_id, turn.input_version_id))
        PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=source_id,
        )

        with self.assertRaises(AssistantSessionRejected) as rejected:
            self._invalidate(turn.turn_id, turn.input_version_id)
        self.assertEqual(rejected.exception.reason, "input_version_stale")
        self._assert_source_input_erased(turn.turn_id, turn.input_version_id)
        saved = self.session_store.read(self.scope, self.session_id)[0]
        self.assertEqual(saved.state, "redacted")
        self.assertIsNone(saved.input)
        self.assertIsNone(saved.reply)

    def test_deleted_session_cannot_be_restored_by_invalidation_or_a_late_start(self) -> None:
        request, turn, command = self._reserve()
        self._start(command)
        self.session_store.delete(self.scope, self.session_id)

        with self.assertRaises(AssistantSessionNotFound):
            self._invalidate(turn.turn_id, turn.input_version_id)
        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.start(command, self.verified_scope)
        new_session_id = self.session_store.default(self.scope)
        self.assertNotEqual(new_session_id, self.session_id)
        with self.assertRaises(AssistantSessionRejected) as rejected:
            self.session_store.reserve(self.scope, new_session_id, request)
        self.assertEqual(rejected.exception.reason, "request_deleted")
        self.assertEqual(self.session_store.read(self.scope, new_session_id), ())

    def test_new_current_input_cannot_be_changed_by_replaying_old_invalidation(self) -> None:
        _, turn, command = self._reserve()
        self._start(command)
        self._invalidate(turn.turn_id, turn.input_version_id)
        new_version = self.session_store.record_discussion_input(
            self.scope, self.session_id,
            {"type": "purpose_exploration", "purpose_hint": "合成新讨论已经生效"},
            expected_input_version_id=turn.input_version_id,
        )

        with self.assertRaises(AssistantSessionRejected) as rejected:
            self._invalidate(turn.turn_id, turn.input_version_id)
        self.assertEqual(rejected.exception.reason, "input_version_stale")
        saved = self.session_store.read_session(self.scope, self.session_id)
        self.assertEqual(saved.current_input_version_id, new_version)
        self.assertEqual(saved.inputs[1].content["purpose_hint"], "合成新讨论已经生效")
        self.assertIsNone(saved.turns[0].reply)

    def test_missing_current_attempt_rolls_back_key_turn_and_request_invalidation(self) -> None:
        _, turn, command = self._reserve()
        lease, _, _ = self._start(command)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.reply_attempt WHERE reply_request_id = %s AND number = %s",
                               (lease.request_id, lease.attempt))

        with self.assertRaises(AssistantSessionPersistenceError):
            self._invalidate(turn.turn_id, turn.input_version_id)

        stored = self.reply_store.read(lease.request_id, self.scope)
        self.assertEqual(stored.state, ReplyAttemptState.RUNNING)
        self.assertEqual(stored.request, lease)
        self.assertEqual(self.session_store.read(self.scope, self.session_id)[0].state, "running")
        self.assertEqual(self.reply_store.start(command, self.verified_scope).state, ReplyRequestState.IN_PROGRESS)
