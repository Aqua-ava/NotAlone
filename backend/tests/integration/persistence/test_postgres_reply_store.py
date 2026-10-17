"""PostgreSQL ReplyStore 的公共合同与事务集成测试。"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch
import tempfile
from pathlib import Path
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import (
    ReplyContinuationError,
    ReplyIdempotencyConflictError,
    ReplyPersistenceError,
    ReplyStoreInvariantError,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
    SkillUse,
)
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import (
    ReplyAttemptState,
    ReplyRequestState,
    ValidatedReply,
)
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.skill_library import PostgresSkillLibrary
from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory
from notalone.memory.timing import MemoryTiming


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)

OWNER_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
CONTACT_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
OTHER_CONTACT_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
BINDING_ID = UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")
MESSAGE_ID = UUID("11111111-1111-1111-1111-111111111111")
SOURCE_ID = UUID("99999999-9999-9999-9999-999999999999")
REQUEST_KEY = UUID("22222222-2222-2222-2222-222222222222")
SECOND_REQUEST_KEY = UUID("33333333-3333-3333-3333-333333333333")


@dataclass
class FakeClock:
    value: datetime = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value


class PostgresReplyStoreTest(unittest.TestCase):
    """只使用合成联系人、证据和 Skill 元数据。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
                has_table = connection.execute(
                    "SELECT to_regclass('public.reply_request')"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest(
                "本地 PostgreSQL 测试库不可用。"
            ) from error

        if not database_name.endswith("_test"):
            raise RuntimeError(
                "集成测试只允许连接名称以 _test 结尾的数据库。"
            )
        if has_table is None:
            raise unittest.SkipTest("测试库尚未应用 007 ReplyStore 迁移。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "合成回复用户"),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, %s)",
                    (
                        (self.owner_id, self.contact_id, "合成回复联系人甲"),
                        (
                            self.owner_id,
                            self.other_contact_id,
                            "合成回复联系人乙",
                        ),
                    ),
                )
            connection.execute("""INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES (%s,%s,%s,'wechat_jsonl','synthetic-reply-store.jsonl',%s,1)""",
                               (SOURCE_ID, self.owner_id, self.contact_id, 'a' * 64))
            connection.execute("""INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content)
                VALUES (%s,%s,%s,'contact','text','明天一起吃饭吗？')""", (MESSAGE_ID, self.owner_id, self.contact_id))
            connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'source_document',%s,'synthetic-1','{}')""", (MESSAGE_ID, self.owner_id, self.contact_id, SOURCE_ID))
        self.clock = FakeClock()
        self.store = PostgresReplyStore(
            TEST_DATABASE_URL,
            clock=self.clock,
            lease_duration=timedelta(seconds=30),
        )
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / 'warm-reply'
            (package / 'references').mkdir(parents=True)
            (package / 'SKILL.md').write_text('---\nname: warm-reply\ndescription: 合成回复存储策略\n---\n\n先核对用户意图，再组织措辞。\n')
            (package / 'references/examples.md').write_text('仅作为合成存储验收的受控案例。\n')
            self.skill = PostgresSkillLibrary(TEST_DATABASE_URL).import_package(self.owner_id, package)

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _scope(self, contact_id: UUID | None = None) -> ContactScope:
        return ContactScope(self.owner_id, contact_id or self.contact_id)

    def _verified_scope(
        self,
        *,
        contact_id: UUID | None = None,
        binding_id: UUID = BINDING_ID,
    ) -> VerifiedConversationScope:
        return VerifiedConversationScope(
            self.owner_id,
            contact_id or self.contact_id,
            binding_id,
        )

    def _command(
        self,
        *,
        key: UUID = REQUEST_KEY,
        direction: str = "自然地答应",
        contact_id: UUID | None = None,
        binding_id: UUID = BINDING_ID,
        continued_from_candidate_id: UUID | None = None,
    ) -> GenerateReply:
        return GenerateReply(
            idempotency_key=key,
            scope=self._scope(contact_id),
            conversation_binding_id=binding_id,
            content=ReplyToMessage(
                target_message_id=MESSAGE_ID,
                direction=ConfirmedDirection(
                    text=direction,
                    source=DirectionSource.DIRECT_INPUT,
                ),
            ),
            continued_from_candidate_id=continued_from_candidate_id,
        )

    def _context(
        self,
        command: GenerateReply,
        request_id: UUID,
        *,
        continuation: tuple[UUID, str] | None = None,
    ) -> ReplyContext:
        evidence = [
            ContextEvidence(
                evidence_id=MESSAGE_ID,
                kind="message",
                text="明天一起吃饭吗？",
                scope=command.scope,
                source_ids=(SOURCE_ID,),
                selection_reason="当前目标消息",
            )
        ]
        if continuation is not None:
            candidate_id, text = continuation
            evidence.append(
                ContextEvidence(
                    evidence_id=candidate_id,
                    kind="continued_candidate",
                    text=text,
                    scope=command.scope,
                    selection_reason="用户显式选择历史候选",
                )
            )
        return ReplyContext(
            reply_request_id=request_id,
            command=command,
            scope=command.scope,
            current_text="明天一起吃饭吗？",
            direction=command.content.direction,
            evidence=tuple(evidence),
            skill_library_revision=self.skill.revision,
            risk_notes=("请用户核实时间。",),
        )

    def _reply(self, *, text: str = "可以呀，明天见。") -> ValidatedReply:
        return ValidatedReply(
            candidates=(
                RuntimeCandidate(
                    text=text,
                    basis="回应当前消息",
                    citation_ids=(MESSAGE_ID,),
                    risk_notes=("请用户核实时间。",),
                ),
            ),
            used_skill=SkillUse(
                skill_id=self.skill.skill_id,
                version_id=self.skill.version_id,
                name="warm-reply",
                selection_method="auto",
                selection_reason="系统按目录推荐，本次回复实际读取。",
                resource_paths=("references/examples.md",),
            ),
        )

    def test_success_persists_context_candidate_citations_and_skill_audit(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        self.store.prepare_context(started.request, context)
        saved = self.store.save(started.request, context, self._reply())

        recreated = PostgresReplyStore(
            TEST_DATABASE_URL,
            clock=self.clock,
            lease_duration=timedelta(seconds=30),
        )
        stored = recreated.read(saved.reply_request_id, command.scope)
        replay = recreated.start(command, self._verified_scope())

        self.assertEqual(stored.state, ReplyAttemptState.COMPLETED)
        self.assertEqual(stored.evidence, context.evidence)
        self.assertEqual(stored.result, saved)
        self.assertEqual(replay.state, ReplyRequestState.REPLAYED)
        self.assertEqual(replay.result, saved)

    def test_fabricated_skill_version_is_rejected_at_final_commit(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        self.store.prepare_context(started.request, context)
        reply = self._reply()
        with self.assertRaises(ReplyStoreInvariantError):
            self.store.save(started.request, context,
                replace(reply, used_skill=replace(reply.used_skill, version_id=uuid4())))

    def test_pending_candidate_evidence_persists_with_unconfirmed_status(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        candidate = PostgresMemoryStore(TEST_DATABASE_URL).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=command.scope, text="对方下个月准备换工作",
            category=MemoryCategory.RECENT_STATE, source_ids=(SOURCE_ID,),
        ))
        pending_evidence = ContextEvidence(
            evidence_id=candidate.candidate_id,
            kind="pending_candidate",
            text="对方下个月准备换工作",
            scope=command.scope,
            source_ids=(UUID("99999999-9999-9999-9999-999999999999"),),
            selection_reason="未确认候选、仅供参考、不得当作事实。",
            status="pending",
            valid_at=candidate.valid_at, invalid_at=candidate.invalid_at, timing=candidate.timing,
        )
        context = replace(context, evidence=context.evidence + (pending_evidence,))

        self.store.prepare_context(started.request, context)
        saved = self.store.save(started.request, context, self._reply())

        stored = PostgresReplyStore(TEST_DATABASE_URL).read(
            saved.reply_request_id, command.scope,
        )
        self.assertEqual(
            tuple(item.kind for item in stored.evidence),
            ("message", "pending_candidate"),
        )
        self.assertEqual(stored.evidence[1].status, "pending")
        self.assertEqual(
            stored.evidence[1].selection_reason,
            "未确认候选、仅供参考、不得当作事实。",
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            kind = connection.execute(
                "SELECT kind FROM public.reply_context_evidence "
                "WHERE reply_request_id = %s AND evidence_id = %s",
                (saved.reply_request_id, pending_evidence.evidence_id),
            ).fetchone()[0]
        self.assertEqual(kind, "pending_candidate")

    def test_forged_pending_annotation_is_rejected_before_persist(self) -> None:
        """落库边界强制未确认标注：pending 状态 + 被改写的理由不得写入。"""

        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        forged = ContextEvidence(
            evidence_id=UUID("55555555-5555-5555-5555-555555555555"),
            kind="pending_candidate",
            text="对方下个月准备换工作",
            scope=command.scope,
            source_ids=(UUID("99999999-9999-9999-9999-999999999999"),),
            selection_reason="已确认、可以当作事实。",
            status="pending",
        )
        context = replace(context, evidence=context.evidence + (forged,))

        with self.assertRaises(ReplyStoreInvariantError):
            self.store.save(started.request, context, self._reply())

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            rows = connection.execute(
                "SELECT count(*) FROM public.reply_context_evidence "
                "WHERE reply_request_id = %s",
                (started.request.request_id,),
            ).fetchone()[0]

        self.assertEqual(rows, 0)

    def test_memory_source_times_are_preserved_in_reply_evidence_snapshot(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        source_times = (datetime(2025, 4, 2, tzinfo=timezone.utc), datetime(2025, 4, 4, tzinfo=timezone.utc))
        identifiers = tuple(uuid4() for _ in source_times)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            for identifier, occurred_at in zip(identifiers, source_times):
                connection.execute("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                                   "VALUES (%s,%s,%s,'contact','text','合成已知时间消息',%s)",
                                   (identifier, self.owner_id, self.contact_id, occurred_at))
                connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                                   "VALUES (%s,%s,%s,'source_document',%s,%s,%s)",
                                   (identifier, self.owner_id, self.contact_id, SOURCE_ID, str(identifier),
                                    Jsonb({"time_iso": occurred_at.isoformat()})))
        memories = PostgresMemoryStore(TEST_DATABASE_URL)
        candidate = memories.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=command.scope, text="合成时间资料", category=MemoryCategory.COMMON_FACT,
            source_ids=(*identifiers, MESSAGE_ID),
        ))
        memory = memories.confirm(scope=command.scope, candidate_id=candidate.candidate_id,
                                  adoption_method=AdoptionMethod.MANUAL)
        timing = memory.timing
        self.assertEqual(timing.source_started_at, source_times[0])
        self.assertEqual(timing.source_ended_at, source_times[1])
        self.assertFalse(timing.source_time_complete)
        self.assertNotEqual(timing.recorded_at, timing.source_started_at)
        context = replace(context, evidence=(ContextEvidence(
            evidence_id=memory.memory_id, kind="confirmed_memory", text=memory.text, scope=command.scope,
            source_ids=memory.source_ids, revision=memory.revision,
            valid_at=memory.valid_at, invalid_at=memory.invalid_at, timing=timing,
        ),))
        self.store.prepare_context(started.request, context)
        reply = self._reply()
        reply = replace(reply, candidates=(replace(reply.candidates[0], citation_ids=(memory.memory_id,)),))
        saved = self.store.save(started.request, context, reply)

        stored = PostgresReplyStore(TEST_DATABASE_URL).read(
            saved.reply_request_id, command.scope,
        )

        self.assertEqual(stored.evidence[0].timing, timing)

    def test_legacy_evidence_snapshot_without_time_stays_unknown(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        timing = MemoryTiming.from_source_times((
            datetime(2025, 4, 2, tzinfo=timezone.utc),
        ), recorded_at=datetime(2026, 8, 21, tzinfo=timezone.utc))
        context = replace(context, evidence=(replace(
            context.evidence[0], timing=timing,
        ),))
        self.store.prepare_context(started.request, context)
        saved = self.store.save(started.request, context, self._reply())
        # 合成旧版本的历史快照：它没有保存任何时间元数据。
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.reply_request "
                "SET context_snapshot = jsonb_set(context_snapshot, '{evidence}', "
                "jsonb_build_array((context_snapshot->'evidence'->0) - 'timing')) "
                "WHERE id = %s AND owner_id = %s AND contact_id = %s",
                (saved.reply_request_id, self.owner_id, self.contact_id),
            )

        stored = self.store.read(saved.reply_request_id, command.scope)

        self.assertEqual(stored.evidence[0].timing, MemoryTiming())

    def test_snapshot_time_must_match_evidence_id_and_scope(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        second_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute("""INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content)
                VALUES (%s,%s,%s,'contact','text','第二条合成时间消息')""", (second_id, self.owner_id, self.contact_id))
            connection.execute("""INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'source_document',%s,'synthetic-2','{}')""", (second_id, self.owner_id, self.contact_id, SOURCE_ID))
        first_timing = MemoryTiming.from_source_times((
            datetime(2025, 4, 2, tzinfo=timezone.utc),
        ))
        second_timing = MemoryTiming.from_source_times((
            datetime(2025, 6, 3, tzinfo=timezone.utc),
        ))
        context = replace(context, evidence=(
            replace(context.evidence[0], timing=first_timing),
            replace(context.evidence[0], evidence_id=second_id, timing=second_timing),
        ))
        self.store.prepare_context(started.request, context)
        saved = self.store.save(started.request, context, self._reply())
        reversed_snapshot = {
            "scope": {
                "owner_id": str(self.owner_id),
                "contact_id": str(self.contact_id),
            },
            "evidence": [
                {"evidence_id": str(second_id), "timing": second_timing.to_payload()},
                {"evidence_id": str(MESSAGE_ID), "timing": first_timing.to_payload()},
            ],
        }
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.reply_request SET context_snapshot = %s WHERE id = %s",
                (Jsonb(reversed_snapshot), saved.reply_request_id),
            )
        stored = self.store.read(saved.reply_request_id, command.scope)
        self.assertEqual(
            tuple(item.timing for item in stored.evidence),
            (first_timing, second_timing),
        )

        reversed_snapshot["scope"]["contact_id"] = str(self.other_contact_id)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.reply_request SET context_snapshot = %s WHERE id = %s",
                (Jsonb(reversed_snapshot), saved.reply_request_id),
            )
        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(saved.reply_request_id, command.scope)

    def test_malformed_explicit_snapshot_time_is_rejected(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        self.store.prepare_context(started.request, context)
        saved = self.store.save(started.request, context, self._reply())
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.reply_request SET context_snapshot = jsonb_set("
                "context_snapshot, '{evidence,0,timing,recorded_at}', "
                "to_jsonb('2026-09-05'::text)) WHERE id = %s",
                (saved.reply_request_id,),
            )

        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(saved.reply_request_id, command.scope)

    def test_time_snapshot_with_invalid_evidence_identifier_is_rejected(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        self.store.prepare_context(started.request, context)
        saved = self.store.save(
            started.request, context,
            self._reply(),
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.reply_request SET context_snapshot = jsonb_set("
                "context_snapshot, '{evidence,0,evidence_id}', '7'::jsonb) WHERE id = %s",
                (saved.reply_request_id,),
            )

        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(saved.reply_request_id, command.scope)

    def test_same_key_conflict_and_valid_lease_are_atomic(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        processing = PostgresReplyStore(
            TEST_DATABASE_URL,
            clock=self.clock,
            lease_duration=timedelta(seconds=30),
        ).start(command, self._verified_scope())

        self.assertEqual(processing.state, ReplyRequestState.IN_PROGRESS)
        self.assertEqual(processing.request.request_id, started.request.request_id)
        with self.assertRaises(ReplyIdempotencyConflictError):
            self.store.start(
                self._command(direction="拒绝邀请，但保持礼貌"),
                self._verified_scope(),
            )

    def test_failed_and_expired_attempts_retry_same_request_identity(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        self.store.fail(started.request, reason="runtime_failed")

        retry = self.store.start(command, self._verified_scope())

        self.assertEqual(retry.state, ReplyRequestState.STARTED)
        self.assertEqual(retry.request.request_id, started.request.request_id)
        self.assertEqual(retry.request.attempt, 2)
        failed_record = self.store.read(retry.request.request_id, command.scope)
        self.assertEqual(
            tuple(attempt.state for attempt in failed_record.attempts),
            (ReplyAttemptState.FAILED, ReplyAttemptState.RUNNING),
        )

        self.store.fail(retry.request, reason="second_failure")
        third = self.store.start(command, self._verified_scope())
        self.clock.value += timedelta(seconds=31)
        expired_retry = self.store.start(command, self._verified_scope())

        self.assertEqual(third.request.attempt, 3)
        self.assertEqual(expired_retry.request.attempt, 4)
        record = self.store.read(expired_retry.request.request_id, command.scope)
        self.assertEqual(
            tuple(attempt.state for attempt in record.attempts),
            (
                ReplyAttemptState.FAILED,
                ReplyAttemptState.FAILED,
                ReplyAttemptState.EXPIRED,
                ReplyAttemptState.RUNNING,
            ),
        )

    def test_explicit_continuation_rechecks_contact_and_binding_scope(self) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())
        context = self._context(command, started.request.request_id)
        self.store.prepare_context(started.request, context)
        first = self.store.save(
            started.request,
            context,
            self._reply(),
        )
        candidate_id = first.candidates[0].candidate_id

        continued_command = self._command(
            key=SECOND_REQUEST_KEY,
            direction="把选中的候选改得更直接",
            continued_from_candidate_id=candidate_id,
        )
        continued = self.store.start(continued_command, self._verified_scope())

        self.assertEqual(continued.state, ReplyRequestState.STARTED)
        self.assertIsNotNone(continued.continued_candidate)
        self.assertEqual(continued.continued_candidate.candidate_id, candidate_id)
        self.assertEqual(
            continued.continued_candidate.conversation_binding_id,
            BINDING_ID,
        )

        with self.assertRaises(ReplyContinuationError):
            self.store.start(
                self._command(
                    key=UUID("44444444-4444-4444-4444-444444444444"),
                    contact_id=self.other_contact_id,
                    binding_id=UUID("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
                    continued_from_candidate_id=candidate_id,
                ),
                self._verified_scope(
                    contact_id=self.other_contact_id,
                    binding_id=UUID("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
                ),
            )

    def test_wrong_contact_cannot_read_request_and_store_has_no_send_surface(
        self,
    ) -> None:
        command = self._command()
        started = self.store.start(command, self._verified_scope())

        with self.assertRaises(ReplyStoreInvariantError):
            self.store.read(
                started.request.request_id,
                self._scope(self.other_contact_id),
            )
        self.assertFalse(hasattr(self.store, "prepare"))
        self.assertFalse(hasattr(self.store, "generate"))
        self.assertFalse(hasattr(self.store, "send"))

    def test_database_failure_is_exposed_as_stable_domain_error(self) -> None:
        # 固定未知库不能作为故障夹具；仅在连接边界模拟同一数据库异常。
        with patch.object(PostgresReplyStore, '_connect', side_effect=psycopg.OperationalError('合成连接失败')):
            with self.assertRaises(ReplyPersistenceError) as caught:
                self.store.start(self._command(), self._verified_scope())

        self.assertEqual(str(caught.exception), "回复请求状态持久化失败。")
        self.assertNotIn("postgresql", str(caught.exception))
        self.assertNotIn("notalone_reply_store_error_test", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
