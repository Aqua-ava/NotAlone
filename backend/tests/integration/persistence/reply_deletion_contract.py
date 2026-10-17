"""来源删除必须清除回复副本，并阻止旧运行结果重新落库。"""

from __future__ import annotations

import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import psycopg

from notalone.memory import FactSubject, MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import ReplyContinuationError, ReplyStoreInvariantError
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
    RewriteDraft,
)
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import ReplyRequest, ValidatedReply
from notalone.scopes import ContactScope, VerifiedConversationScope
from tests.integration.persistence.concurrency import wait_for_blocked_operations


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL", "postgresql:///notalone_test"
)


class ReplyDeletionContract(unittest.TestCase):
    """两种真实来源共用的回复删除行为契约；夹具由子类提供。"""

    deletion_error: type[Exception]
    source_id: UUID

    def _prepare_reply(
        self,
        *,
        evidence: tuple[ContextEvidence, ...] | None = None,
        continued_from: UUID | None = None,
        scope: ContactScope | None = None,
        draft: str | None = None,
    ) -> tuple[ReplyRequest, ReplyContext, ValidatedReply]:
        scope = scope or self.scope
        command = GenerateReply(
            idempotency_key=uuid4(),
            scope=scope,
            conversation_binding_id=self.binding_id,
            content=RewriteDraft(draft_text=draft) if draft else ReplyToMessage(
                target_message_id=self.message_id,
                direction=ConfirmedDirection(
                    text="自然回应", source=DirectionSource.DIRECT_INPUT
                ),
            ),
            continued_from_candidate_id=continued_from,
        )
        started = self.store.start(command, self._verified_scope(scope))
        if evidence is None:
            evidence = (
                ContextEvidence(
                    evidence_id=self.message_id,
                    kind="message",
                    text=self.message_text,
                    scope=scope,
                    source_ids=(self.source_id,),
                ),
            )
        if started.continued_candidate is not None:
            evidence += (
                ContextEvidence(
                    evidence_id=started.continued_candidate.candidate_id,
                    kind="continued_candidate",
                    text=started.continued_candidate.text,
                    scope=scope,
                ),
            )
        context = ReplyContext(
            reply_request_id=started.request.request_id,
            command=command,
            scope=scope,
            current_text=draft or self.message_text,
            direction=(
                command.content.direction
                if isinstance(command.content, ReplyToMessage) else None
            ),
            evidence=evidence,
            skill_library_revision=0,
        )
        reply = ValidatedReply(
            candidates=(
                RuntimeCandidate(
                    text="合成候选回复", basis="引用合成资料",
                    citation_ids=(evidence[0].evidence_id,), risk_notes=(),
                ),
            ),
            used_skill=None,
        )
        return started.request, context, reply

    def _verified_scope(self, scope: ContactScope) -> VerifiedConversationScope:
        return VerifiedConversationScope(
            scope.owner_id, scope.contact_id, self.binding_id
        )

    def _delete_source(self) -> None:
        raise NotImplementedError

    def test_deleted_source_cannot_be_read_replayed_or_continued(self) -> None:
        request, context, reply = self._prepare_reply()
        saved = self.store.save(request, context, reply)

        self._delete_source()

        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(request.request_id, self.scope)
        with self.assertRaises(ReplyContinuationError):
            self._prepare_reply(continued_from=saved.candidates[0].candidate_id)
        # 删除清除原请求的规范化输入和 JSON 快照，而非仅隐藏证据行。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            remaining = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE id = %s",
                (request.request_id,),
            ).fetchone()[0]
        self.assertEqual(remaining, 0)
        # 失效键保留无正文凭证，旧键不能悄悄成为一次新生成。
        with self.assertRaises(ReplyStoreInvariantError):
            self.store.start(context.command, self._verified_scope(self.scope))

    def test_deletion_follows_multiple_explicit_candidate_continuations(self) -> None:
        original = self._prepare_reply()
        saved = self.store.save(*original)
        request_ids = [saved.reply_request_id]
        for _ in range(2):
            continued = self._prepare_reply(
                draft="请把上一条候选改得简短些",
                evidence=(ContextEvidence(
                    evidence_id=uuid4(), kind="user_draft",
                    text="请把上一条候选改得简短些", scope=self.scope,
                ),),
                continued_from=saved.candidates[0].candidate_id,
            )
            saved = self.store.save(*continued)
            request_ids.append(saved.reply_request_id)

        self._delete_source()

        for request_id in request_ids:
            with self.subTest(request_id=request_id):
                with self.assertRaises(ReplyStoreInvariantError):
                    self.store.read(request_id, self.scope)

    def test_in_flight_reply_cannot_restore_deleted_source(self) -> None:
        request, context, reply = self._prepare_reply()

        self._delete_source()

        with self.assertRaises(ReplyStoreInvariantError):
            self.store.save(request, context, reply)

    def test_owner_memory_reply_copies_are_cleared_in_other_contacts(self) -> None:
        candidate = PostgresMemoryStore(TEST_DATABASE_URL).create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(), scope=self.scope,
                text="合成本人资料", category=MemoryCategory.COMMON_FACT,
                subject=FactSubject.SELF, source_ids=(self.message_id,),
            )
        )
        memory = PostgresOwnerMemoryStore(TEST_DATABASE_URL).confirm_candidate(
            candidate=candidate
        )
        other_scope = self._new_contact(self.scope.owner_id)
        owner_evidence = (ContextEvidence(
            evidence_id=memory.memory_id, kind="owner_memory", text=memory.text,
            scope=other_scope, source_ids=memory.source_ids, revision=memory.revision,
            valid_at=memory.valid_at, invalid_at=memory.invalid_at, timing=memory.timing,
        ),)
        saved = self.store.save(*self._prepare_reply(
            scope=other_scope, evidence=owner_evidence, draft="参考本人资料改写",
        ))
        pending = self._prepare_reply(
            scope=other_scope, evidence=owner_evidence, draft="另一次本人资料改写",
        )
        unrelated = self.store.save(*self._prepare_reply(
            scope=other_scope, draft="独立合成草稿",
            evidence=(ContextEvidence(
                evidence_id=uuid4(), kind="user_draft", text="独立合成草稿",
                scope=other_scope,
            ),),
        ))

        self._delete_source()

        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(saved.reply_request_id, other_scope)
        with self.assertRaises(ReplyStoreInvariantError):
            self.store.save(*pending)
        self.assertEqual(
            self.store.read(unrelated.reply_request_id, other_scope).result,
            unrelated,
        )

    def _new_contact(self, owner_id: UUID) -> ContactScope:
        scope = ContactScope(owner_id, uuid4())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, '合成隔离联系人')",
                (scope.owner_id, scope.contact_id),
            )
        return scope

    def test_reply_cleanup_failure_rolls_back_source_deletion(self) -> None:
        request, context, reply = self._prepare_reply()
        saved = self.store.save(request, context, reply)
        trigger_name = "test_reply_deletion_" + uuid4().hex
        # 仅阻止当前合成用户的删除；其余并行测试不受影响。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            original_request = connection.execute(
                "SELECT state,context_snapshot FROM public.reply_request WHERE id=%s",
                (request.request_id,),
            ).fetchone()
            original_candidates = connection.execute(
                "SELECT id,candidate_text,message_group FROM public.reply_candidate "
                "WHERE reply_request_id=%s ORDER BY ordinal", (request.request_id,),
            ).fetchall()
            self.assertEqual([(row[0], row[1]) for row in original_candidates],
                             [(candidate.candidate_id, candidate.text) for candidate in saved.candidates])
            connection.execute(f"""
                CREATE FUNCTION public.{trigger_name}() RETURNS trigger
                LANGUAGE plpgsql AS $$ BEGIN
                    IF OLD.owner_id = '{self.scope.owner_id}'::uuid THEN
                        RETURN NULL;
                    END IF;
                    RETURN OLD;
                END $$
            """)
            connection.execute(f"""
                CREATE TRIGGER {trigger_name} BEFORE DELETE ON public.reply_request
                FOR EACH ROW EXECUTE FUNCTION public.{trigger_name}()
            """)
        try:
            with self.assertRaises(self.deletion_error):
                self._delete_source()
            # 来源故障状态可能关闭业务读取；直接核对事务回滚的实际正文与身份。
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                self.assertEqual(connection.execute(
                    "SELECT state,context_snapshot FROM public.reply_request WHERE id=%s",
                    (request.request_id,),
                ).fetchone(), original_request)
                self.assertEqual(connection.execute(
                    "SELECT id,candidate_text,message_group FROM public.reply_candidate "
                    "WHERE reply_request_id=%s ORDER BY ordinal", (request.request_id,),
                ).fetchall(), original_candidates)
        finally:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                connection.execute(
                    f"DROP TRIGGER {trigger_name} ON public.reply_request"
                )
                connection.execute(f"DROP FUNCTION public.{trigger_name}()")
        # 故障解除后原来源仍能重试删除，证明来源与回复副本一起回滚。
        self._delete_source()
        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(request.request_id, self.scope)

    def test_unrelated_replies_and_other_owner_runs_are_preserved(self) -> None:
        other_owner_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) "
                "VALUES (%s, '合成隔离用户')", (other_owner_id,),
            )
        self.addCleanup(self._delete_owner, other_owner_id)
        scopes = (
            self.scope,
            self._new_contact(self.scope.owner_id),
            self._new_contact(other_owner_id),
        )
        saved = []
        for scope in scopes:
            prepared = self._prepare_reply(
                scope=scope, draft="无关合成草稿",
                evidence=(ContextEvidence(
                    evidence_id=uuid4(), kind="user_draft", text="无关合成草稿",
                    scope=scope,
                ),),
            )
            saved.append((scope, self.store.save(*prepared)))
        pending = self._prepare_reply(
            scope=scopes[-1], draft="另一用户正在改写",
            evidence=(ContextEvidence(
                evidence_id=uuid4(), kind="user_draft", text="另一用户正在改写",
                scope=scopes[-1],
            ),),
        )

        self._delete_source()

        for scope, result in saved:
            self.assertEqual(
                self.store.read(result.reply_request_id, scope).result, result
            )
        self.assertIsNotNone(self.store.save(*pending))

    @staticmethod
    def _delete_owner(owner_id: UUID) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id = %s", (owner_id,))

    def test_concurrent_save_is_included_in_source_deletion(self) -> None:
        prepared = self._prepare_reply()
        with psycopg.connect(TEST_DATABASE_URL) as blocker:
            blocker.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"owner:{self.scope.owner_id}",),
            )
            blocker_pid = blocker.execute("SELECT pg_backend_pid()").fetchone()[0]
            with ThreadPoolExecutor(max_workers=2) as executor:
                try:
                    saving = executor.submit(self.store.save, *prepared)
                    waiting = wait_for_blocked_operations(
                        TEST_DATABASE_URL, {blocker_pid}, 1
                    )
                    deleting = executor.submit(self._delete_source)
                    wait_for_blocked_operations(
                        TEST_DATABASE_URL, {blocker_pid, *waiting}, 2
                    )
                finally:
                    blocker.commit()
                saving.result(timeout=10)
                deleting.result(timeout=10)
        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(prepared[0].request_id, self.scope)

    def test_owner_confirmation_and_source_deletion_do_not_deadlock(self) -> None:
        candidate = PostgresMemoryStore(TEST_DATABASE_URL).create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(), scope=self.scope,
                text="并发确认与删除的合成本人记忆",
                category=MemoryCategory.COMMON_FACT, subject=FactSubject.SELF,
                source_ids=(self.source_id,),
            )
        )
        owner_store = PostgresOwnerMemoryStore(TEST_DATABASE_URL)
        with psycopg.connect(TEST_DATABASE_URL) as blocker:
            blocker.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"owner:{self.scope.owner_id}",),
            )
            blocker_pid = blocker.execute("SELECT pg_backend_pid()").fetchone()[0]
            with ThreadPoolExecutor(max_workers=2) as executor:
                try:
                    confirming = executor.submit(
                        owner_store.confirm_candidate, candidate=candidate
                    )
                    waiting = wait_for_blocked_operations(
                        TEST_DATABASE_URL, {blocker_pid}, 1
                    )
                    deleting = executor.submit(self._delete_source)
                    wait_for_blocked_operations(
                        TEST_DATABASE_URL, {blocker_pid, *waiting}, 2
                    )
                finally:
                    blocker.commit()
                confirming.result(timeout=10)
                deleting.result(timeout=10)
        self.assertEqual(owner_store.list_active(self.scope.owner_id), ())
