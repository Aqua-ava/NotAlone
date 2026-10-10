"""中央历史依赖：真实A读取、C持久化和删除，全部使用隔离合成资料。"""

from __future__ import annotations

import json
import unittest
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.style_sample_service import SaveStyleSample
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.reply_discussion_dependencies import reply_style_sample_dependencies
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.style_sample_store import PostgresStyleSampleStore
from notalone.persistence.style_sample_store import require_reply_sources_current
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import ValidatedReply
from notalone.scopes import ContactScope, VerifiedConversationScope
from tests.integration.persistence import test_assistant_discussion_context as support


class ReplyDiscussionDependenciesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        support.AssistantDiscussionContextTest.setUpClass()

    def setUp(self) -> None:
        # 共用A正式夹具的范围和真实公开存储入口，不复刻其读取或codec。
        self.fixture = support.AssistantDiscussionContextTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.samples = PostgresStyleSampleStore(support.DATABASE_URL)
        self.store = PostgresReplyStore(support.DATABASE_URL)

    def _seed_history(self, *, source=None):
        old = self.samples.save(self.fixture.scope, SaveStyleSample(
            uuid4(), "合成旧样本：说话轻一点。", "manual",
        ))
        self.fixture._complete("旧轮合成明确意愿。", source=source,
                               style_references=self.samples.select_references(self.fixture.scope))
        current = tuple(self.samples.save(self.fixture.scope, SaveStyleSample(
            uuid4(), f"合成新的第{number}条独立参考。", "manual",
        )) for number in range(5))
        references = self.samples.select_references(self.fixture.scope)
        self.assertEqual({item.sample_id for item in references}, {item.sample_id for item in current})
        self.assertNotIn(old.sample_id, {item.sample_id for item in references})
        return old, current, references

    def _prepare(self, references=(), *, relationship=True):
        fixture = self.fixture
        service_request, turn_id = fixture._reserve("本次明确拒绝邀约。", relationship=relationship)
        discussion = fixture._read(service_request)
        command = service_request.build_command(owner_id=fixture.owner_id, contact_id=fixture.contact_id,
                                                binding_id=fixture.binding_id)
        started = self.store.start(command, VerifiedConversationScope(
            fixture.owner_id, fixture.contact_id, fixture.binding_id,
        ))
        draft_id = uuid4()
        context = ReplyContext(
            reply_request_id=started.request.request_id, command=command, scope=fixture.scope,
            current_text="本次明确拒绝邀约。", direction=None, skill_library_revision=0,
            evidence=(ContextEvidence(evidence_id=draft_id, kind="user_draft", text="本次明确拒绝邀约。",
                                      scope=fixture.scope, selection_reason="当前合成意愿"),),
            style_references=references, assistant_discussion=discussion,
        )
        self.store.prepare_context(started.request, context)
        return service_request, turn_id, started.request, context

    def _save(self, prepared):
        _, turn_id, request, context = prepared
        result = self.store.save(request, context, ValidatedReply(
            candidates=(RuntimeCandidate(text="谢谢邀请，这次不去了。", basis="遵循当前拒绝。",
                                         citation_ids=(context.evidence[0].evidence_id,), risk_notes=()),),
            used_skill=None,
        ))
        self.fixture.sessions.complete(self.fixture.scope, self.fixture.session_id, turn_id, result)
        return result

    def _row(self, request_id):
        with psycopg.connect(support.DATABASE_URL) as connection:
            return connection.execute(
                "SELECT context_snapshot FROM public.reply_request WHERE id=%s", (request_id,),
            ).fetchone()

    def _assert_erased_turn(self, prepared):
        with psycopg.connect(support.DATABASE_URL) as connection:
            row = connection.execute(
                "SELECT turn.state,turn.input_payload,turn.reply_request_id,input.state,input.content "
                "FROM public.assistant_session_turn AS turn "
                "JOIN public.assistant_session_input AS input ON input.id=turn.input_version_id "
                "WHERE turn.id=%s", (prepared[1],),
            ).fetchone()
        self.assertEqual(row, ("redacted", None, None, "redacted", None))

    def test_historical_manual_sample_is_captured_separately_from_current_five(self):
        old, current, references = self._seed_history()
        prepared = self._prepare(references)
        metadata = self._row(prepared[2].request_id)[0] or {}
        self.assertEqual(metadata.get("assistant_discussion_style_sample_ids"), [str(old.sample_id)])
        self.assertNotIn(old.text, json.dumps(metadata, ensure_ascii=False))
        self.assertNotIn("旧轮合成明确意愿。", json.dumps(metadata, ensure_ascii=False))
        result = self._save(prepared)
        self.assertEqual(set(result.context_receipt.style_sample_ids), {item.sample_id for item in current})
        self.assertEqual(self._row(result.reply_request_id)[0]["assistant_discussion_style_sample_ids"],
                         [str(old.sample_id)])

    def test_deleting_history_only_manual_sample_physically_erases_new_candidate_and_derived_sample(self):
        old, current, references = self._seed_history()
        prepared = self._prepare(references)
        result = self._save(prepared)
        derived = self.samples.save(self.fixture.scope, SaveStyleSample(
            uuid4(), result.candidates[0].text, "candidate", result.candidates[0].candidate_id,
        ))
        independent = self.samples.save(self.fixture.scope, SaveStyleSample(
            uuid4(), "始终独立的合成手写参考。", "manual",
        ))
        self.samples.delete(self.fixture.scope, old.sample_id)
        self.assertIsNone(self._row(result.reply_request_id))
        remaining = {item.sample_id for item in self.samples.list(self.fixture.scope)}
        self.assertNotIn(derived.sample_id, remaining)
        self.assertEqual(remaining, {independent.sample_id, *(item.sample_id for item in current)})
        with psycopg.connect(support.DATABASE_URL) as connection:
            turn = connection.execute(
                "SELECT state,input_payload,reply_request_id FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                (self.fixture.owner_id, self.fixture.contact_id, prepared[0].idempotency_key),
            ).fetchone()
            self.assertEqual(turn, ("redacted", None, None))
        self._assert_erased_turn(prepared)

    def test_pending_same_key_without_reply_foreign_key_is_erased_and_late_save_rejected(self):
        old, _, references = self._seed_history()
        prepared = self._prepare(references)
        with psycopg.connect(support.DATABASE_URL) as connection:
            self.assertIsNone(connection.execute(
                "SELECT reply_request_id FROM public.assistant_session_turn WHERE id=%s", (prepared[1],),
            ).fetchone()[0])
        self.samples.delete(self.fixture.scope, old.sample_id)
        self.assertIsNone(self._row(prepared[2].request_id))
        self._assert_erased_turn(prepared)
        with self.assertRaises(ReplyStoreInvariantError):
            self._save(prepared)

    def test_new_current_input_blocks_save_but_keeps_completed_history_read_and_replay(self):
        _, _, references = self._seed_history()
        prepared = self._prepare(references)
        result = self._save(prepared)
        new_input = self.fixture._discussion("后来当前输入已改口。")
        self.assertEqual(self.store.read(result.reply_request_id, self.fixture.scope).result, result)
        replay = self.store.start(prepared[3].command, VerifiedConversationScope(
            self.fixture.owner_id, self.fixture.contact_id, self.fixture.binding_id,
        ))
        self.assertEqual(replay.result, result)
        self.assertEqual(self.fixture.sessions.read_session(self.fixture.scope, self.fixture.session_id)
                         .current_input_version_id, new_input)
        # 一轮仍运行的旧快照在current改变后不得提交，与已完成结果HISTORY读取分开。
        pending = self._prepare(references)
        self.fixture._discussion("再次明确改口。")
        with self.assertRaises(ReplyStoreInvariantError):
            self._save(pending)

    def test_save_cannot_drop_prepared_discussion_or_replace_actual_sample_metadata(self):
        old, _, references = self._seed_history()
        prepared = self._prepare(references)
        altered = (*prepared[:3], replace(prepared[3], assistant_discussion=None))
        with self.assertRaises(ReplyStoreInvariantError):
            self._save(altered)
        payload = self._row(prepared[2].request_id)[0]
        self.assertEqual(payload["assistant_discussion_style_sample_ids"], [str(old.sample_id)])
        payload["assistant_discussion_style_sample_ids"] = []
        with psycopg.connect(support.DATABASE_URL) as connection:
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s",
                               (Jsonb(payload), prepared[2].request_id))
        with self.assertRaises(ReplyStoreInvariantError):
            self._save(prepared)

    def test_history_only_raw_source_is_captured_before_save_and_delete_erases_derivatives(self):
        source_id, message_id = self.fixture._source()
        _, current, references = self._seed_history(source=(source_id, message_id))
        unrelated_id, _ = self.fixture._source()
        prepared = self._prepare(references)
        with psycopg.connect(support.DATABASE_URL) as connection:
            actual = connection.execute(
                "SELECT source_id FROM public.reply_original_source_use WHERE reply_request_id=%s",
                (prepared[2].request_id,),
            ).fetchall()
        self.assertEqual(actual, [(source_id,)])
        result = self._save(prepared)
        self.fixture._delete_source(source_id)
        self.assertIsNone(self._row(result.reply_request_id))
        self._assert_erased_turn(prepared)
        self.assertTrue({item.sample_id for item in current} <=
                        {item.sample_id for item in self.samples.list(self.fixture.scope)})
        with psycopg.connect(support.DATABASE_URL) as connection:
            self.assertEqual(connection.execute("SELECT status FROM public.source_document WHERE id=%s",
                                                (unrelated_id,)).fetchone(), ("active",))

    def test_style_dependency_port_includes_history_and_rejects_other_owner_contact(self):
        old, current, references = self._seed_history()
        prepared = self._prepare(references)
        with psycopg.connect(support.DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.fixture.owner_id)
            self.assertEqual(set(reply_style_sample_dependencies(connection, self.fixture.scope,
                                                                 prepared[2].request_id)),
                             {old.sample_id, *(item.sample_id for item in current)})
            for scope in (ContactScope(self.fixture.owner_id, self.fixture.other_contact_id),
                          ContactScope(self.fixture.other_owner_id, self.fixture.contact_id)):
                with self.subTest(scope=scope), self.assertRaises(ReplyStoreInvariantError):
                    reply_style_sample_dependencies(connection, scope, prepared[2].request_id)

    def test_explicit_sample_survives_session_delete_and_keeps_history_sample_delete_path(self):
        old, current, references = self._seed_history()
        prepared = self._prepare(references)
        result = self._save(prepared)
        derived = self.samples.save(self.fixture.scope, SaveStyleSample(
            uuid4(), result.candidates[0].text, "candidate", result.candidates[0].candidate_id,
        ))
        self.fixture.sessions.delete(self.fixture.scope, self.fixture.session_id)
        self.assertIsNone(self._row(result.reply_request_id))
        self.assertEqual(self.samples.read(self.fixture.scope, derived.sample_id).text, derived.text)
        self.assertEqual({item.sample_id for item in self.samples.list(self.fixture.scope)},
                         {old.sample_id, derived.sample_id, *(item.sample_id for item in current)})
        self.samples.delete(self.fixture.scope, old.sample_id)
        self.assertEqual({item.sample_id for item in self.samples.list(self.fixture.scope)},
                         {item.sample_id for item in current})

    def test_history_raw_deleted_during_generation_erases_pending_input_and_blocks_late_save(self):
        source_id, message_id = self.fixture._source()
        _, _, references = self._seed_history(source=(source_id, message_id))
        prepared = self._prepare(references)
        self.fixture._delete_source(source_id)
        self.assertIsNone(self._row(prepared[2].request_id))
        self._assert_erased_turn(prepared)
        with self.assertRaises(ReplyStoreInvariantError):
            self._save(prepared)

    def test_nested_history_validation_does_not_repeat_requests_or_outlive_one_read(self):
        _, _, references = self._seed_history()
        first = self._prepare(references)
        self._save(first)
        second = self._prepare(references)
        result = self._save(second)
        from notalone.persistence import assistant_discussion_context as history

        real_guard = history.require_assistant_discussion_available
        validated = []

        def observe(connection, scope, snapshot):
            validated.append(snapshot.request_key)
            return real_guard(connection, scope, snapshot)

        with psycopg.connect(support.DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.fixture.owner_id)
            with patch.object(history, "require_assistant_discussion_available", side_effect=observe):
                require_reply_sources_current(connection, owner_id=self.fixture.owner_id,
                                              request_id=result.reply_request_id)
            # 嵌套C→A→C共享本轮校验，不能因全部前史反复展开而放大数据库读取。
            self.assertEqual(len(validated), len(set(validated)))
            connection.execute("UPDATE public.style_sample SET status='deleted',final_text=NULL,deleted_at=now() WHERE id=%s",
                               (references[0].sample_id,))
            # 同一个连接上的下一次读取仍必须重新核验删除，不保留跨调用结果缓存。
            with self.assertRaises(ReplyStoreInvariantError):
                require_reply_sources_current(connection, owner_id=self.fixture.owner_id,
                                              request_id=result.reply_request_id)


if __name__ == "__main__":
    unittest.main()
