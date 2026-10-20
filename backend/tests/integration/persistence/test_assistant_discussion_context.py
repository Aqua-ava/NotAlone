"""同连接讨论读取与保存前来源复验；全部夹具为隔离库合成资料。"""

from __future__ import annotations

import json
import os
import unittest
from dataclasses import FrozenInstanceError, asdict, replace
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.assistant_discussion_context import (
    read_assistant_discussion_in_transaction,
    require_assistant_discussion_current,
)
from notalone.persistence.assistant_candidate_versions import (
    EditAssistantCandidate, PostgresAssistantCandidateVersions, edit_candidate_version,
)
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.assistant_discussion import DiscussionDependencies
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.reply.interface import CandidateMessage, RewriteDraft
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import ValidatedReply


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class AssistantDiscussionContextTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供本地隔离PG测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("讨论上下文仅使用自有_test数据库。")

    def setUp(self) -> None:
        self.owner_id, self.other_owner_id = uuid4(), uuid4()
        self.contact_id, self.other_contact_id = uuid4(), uuid4()
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(DATABASE_URL) as connection:
            for owner_id in (self.owner_id, self.other_owner_id):
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成讨论用户')",
                                   (owner_id,))
                connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES (%s,0)",
                                   (owner_id,))
            for contact_id in (self.contact_id, self.other_contact_id):
                connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'同名合成联系人')",
                                   (self.owner_id, contact_id))
        self.addCleanup(self._clean_owners)
        self.binding_id = PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-discussion", conversation_locator=f"synthetic-{uuid4()}",
        ).binding_id
        self.sessions = PostgresAssistantSessionStore(DATABASE_URL)
        self.session_id = self.sessions.default(self.scope)

    def _clean_owners(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=ANY(%s::uuid[])",
                               ([self.owner_id, self.other_owner_id],))

    def _discussion(self, text="不使用夸张承诺。", *, dependencies=()):
        return self.sessions.record_discussion_input(
            self.scope, self.session_id,
            {"type": "purpose_exploration", "purpose_hint": "合成邀请", "requirements": text},
            verified_dependencies=dependencies,
        )

    def _reserve(self, draft="最新明确意愿。", *, relationship=False):
        request = ReplyServiceRequest(idempotency_key=uuid4(),
                                      content=RewriteDraft(draft, include_relationship_context=relationship))
        turn_id = self.sessions.reserve(self.scope, self.session_id, request)
        return request, turn_id

    def _read(self, request, *, scope=None):
        selected_scope = scope or self.scope
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=selected_scope.owner_id)
            return read_assistant_discussion_in_transaction(connection, selected_scope, request.idempotency_key)

    def _require(self, context, *, scope=None):
        selected_scope = scope or self.scope
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=selected_scope.owner_id)
            return require_assistant_discussion_current(connection, selected_scope, context.snapshot)

    def _source(self, *, contact_id=None):
        source_id, message_id = uuid4(), uuid4()
        selected_contact = contact_id or self.contact_id
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("""
                INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                VALUES (%s,%s,%s,'wechat_jsonl','synthetic-discussion.jsonl',%s,1)
            """, (source_id, self.owner_id, selected_contact, uuid4().hex * 2))
            connection.execute("""
                INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content)
                VALUES (%s,%s,%s,'contact','text','合成来源原话。')
            """, (message_id, self.owner_id, selected_contact))
            connection.execute("""
                INSERT INTO public.message_source_ref
                  (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
                VALUES (%s,%s,%s,'source_document',%s,'synthetic:1','{}')
            """, (message_id, self.owner_id, selected_contact, source_id))
        return source_id, message_id

    def _delete_source(self, source_id):
        return PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.owner_id, contact_id=self.contact_id, source_document_id=source_id,
        )

    def _complete(self, draft="旧轮用户意愿。", *, parts=("明天见。", "路上注意安全。"),
                  source=None):
        request, turn_id = self._reserve(draft, relationship=bool(source))
        command = request.build_command(owner_id=self.owner_id, contact_id=self.contact_id,
                                        binding_id=self.binding_id)
        store = PostgresReplyStore(DATABASE_URL)
        started = store.start(command, VerifiedConversationScope(
            self.owner_id, self.contact_id, self.binding_id,
        ))
        draft_id = uuid4()
        evidence = (ContextEvidence(evidence_id=draft_id, kind="user_draft", text=draft,
                                    scope=self.scope, selection_reason="本次合成草稿"),)
        if source is not None:
            source_id, message_id = source
            evidence += (ContextEvidence(evidence_id=message_id, kind="message", text="合成来源原话。",
                                         source_ids=(source_id,), scope=self.scope,
                                         selection_reason="本次实际合成来源"),)
        context = ReplyContext(
            reply_request_id=started.request.request_id, command=command, scope=self.scope,
            current_text=draft, direction=None, skill_library_revision=0,
            evidence=evidence,
        )
        store.prepare_context(started.request, context)
        result = store.save(started.request, context, ValidatedReply(
            candidates=(RuntimeCandidate(text="\n\n".join(parts), messages=parts,
                                         basis="保留本次草稿原意。", citation_ids=(draft_id,), risk_notes=()),),
            used_skill=None,
        ))
        self.sessions.complete(self.scope, self.session_id, turn_id, result)
        return result.candidates[0], result.reply_request_id, turn_id

    def test_current_request_uses_real_input_uuid_and_keeps_prior_discussion_once(self):
        discussion_id = self._discussion()
        request, turn_id = self._reserve()
        context = self._read(request)
        self.assertIsNotNone(context)
        self.assertEqual(context.session_id, self.session_id)
        self.assertEqual(context.current_input_version_id,
                         self.sessions.read_session(self.scope, self.session_id).current_input_version_id)
        self.assertEqual([(item.kind, item.input_version_id) for item in context.items],
                         [("discussion_input", discussion_id)])
        self.assertEqual(json.loads(context.items[0].text)["requirements"], "不使用夸张承诺。")
        self.assertNotIn("最新明确意愿。", "".join(item.text for item in context.items))
        self.assertEqual(context.snapshot.current_turn_id, turn_id)
        dependencies = self._require(context)
        self.assertEqual(dependencies.source_ids, ())

    def test_completed_generation_keeps_all_candidate_versions_and_explicit_choice_separate(self):
        candidate, reply_request_id, turn_id = self._complete()
        adapter = PostgresAssistantCandidateVersions(DATABASE_URL)
        edited = adapter.edit(self.scope, self.session_id, candidate.candidate_id,
                              EditAssistantCandidate(
                                  uuid4(), candidate.candidate_id,
                                  tuple(CandidateMessage(message.message_id, text)
                                        for message, text in zip(candidate.message_group, ("明天见呀。", "慢慢来。"))),
                                  "不要催促对方。",
                              ))
        adapter.select(self.scope, self.session_id, candidate.candidate_id, candidate.candidate_id, uuid4())
        request, _ = self._reserve()
        context = self._read(request)
        self.assertEqual([item.kind for item in context.items],
                         ["generation_input", "candidate_version", "candidate_version"])
        original, newest = context.items[1:]
        self.assertEqual(original.turn_id, turn_id)
        self.assertEqual(original.reply_request_id, reply_request_id)
        self.assertEqual(original.version_id, candidate.candidate_id)
        self.assertTrue(original.is_explicitly_selected)
        self.assertFalse(original.is_default_display)
        self.assertEqual(newest.version_id, edited.default_display_version_id)
        self.assertTrue(newest.is_default_display)
        self.assertFalse(newest.is_explicitly_selected)
        self.assertEqual(json.loads(newest.text)["requirements"], "不要催促对方。")
        self.assertEqual([message["text"] for message in json.loads(newest.text)["messages"]],
                         ["明天见呀。", "慢慢来。"])
        self.assertIn("低权重", context.notice)
        self.assertIn("不是关系事实", context.notice)
        self._require(context)

    def test_historical_generation_returns_actual_raw_and_message_dependencies(self):
        source_id, message_id = self._source()
        self._complete(source=(source_id, message_id))
        request, _ = self._reserve()
        context = self._read(request)
        dependencies = self._require(context)
        self.assertEqual(set(dependencies.source_ids), {source_id, message_id})

    def test_source_deleted_before_read_omits_affected_history_and_keeps_unrelated_discussion(self):
        source_id, message_id = self._source()
        self._discussion("来源依赖的旧讨论。", dependencies=(message_id,))
        self._complete("来源依赖的旧轮。", source=(source_id, message_id))
        independent_id = self._discussion("仍有效的独立要求。")
        request, _ = self._reserve()
        self._delete_source(source_id)
        context = self._read(request)
        self.assertEqual([(item.kind, item.input_version_id) for item in context.items],
                         [("discussion_input", independent_id)])
        self.assertNotIn("来源依赖的旧", "".join(item.text for item in context.items))
        self.assertEqual(self._require(context).source_ids, ())

    def test_source_deleted_after_read_rejects_snapshot_before_candidate_save(self):
        source_id, message_id = self._source()
        self._complete(source=(source_id, message_id))
        request, _ = self._reserve()
        context = self._read(request)
        self.assertIn(source_id, self._require(context).source_ids)
        self._delete_source(source_id)
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(context)



    def test_owner_contact_and_same_contact_session_boundaries_do_not_inherit_other_discussion(self):
        self._discussion("原会话独立要求。")
        request, _ = self._reserve()
        context = self._read(request)
        other_scope = ContactScope(self.owner_id, self.other_contact_id)
        foreign_scope = ContactScope(self.other_owner_id, self.contact_id)
        for scope in (other_scope, foreign_scope):
            with self.subTest(scope=scope):
                self.assertIsNone(self._read(request, scope=scope))
                with self.assertRaises(ReplyStoreInvariantError):
                    self._require(context, scope=scope)
        old_session = self.session_id
        # 只准备独立会话身份，不借用尚未正式交付的 10 新开实现。
        self.session_id = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.assistant_session (id,owner_id,contact_id,is_default) "
                "VALUES (%s,%s,%s,FALSE)",
                (self.session_id, self.owner_id, self.contact_id),
            )
        self._discussion("其他会话的独立要求。")
        other_request, _ = self._reserve()
        other_context = self._read(other_request)
        self.assertNotIn("原会话独立要求。", "".join(item.text for item in other_context.items))
        original = self._read(request)
        self.assertEqual(original.session_id, old_session)
        self.assertNotIn("其他会话的独立要求。", "".join(item.text for item in original.items))
        self._require(context)

    def test_new_user_input_rejects_old_request_on_read_and_before_save(self):
        self._discussion()
        request, _ = self._reserve()
        context = self._read(request)
        self._discussion("最新改口要求。")
        for operation in (lambda: self._read(request), lambda: self._require(context)):
            with self.subTest(operation=operation):
                with self.assertRaises(ReplyStoreInvariantError):
                    operation()

    def test_failed_and_running_user_inputs_remain_history_without_ai_candidates(self):
        independent_id = self._discussion("有效讨论仍保留。")
        _, failed_turn = self._reserve("失败生成的正文。")
        self.sessions.fail(self.scope, failed_turn)
        _, running_turn = self._reserve("早期仍运行的正文。")
        request, _ = self._reserve()
        context = self._read(request)
        self.assertEqual(context.items[0].input_version_id, independent_id)
        self.assertEqual([(item.kind, item.turn_id) for item in context.items[1:]],
                         [("generation_input", failed_turn), ("generation_input", running_turn)])
        self.assertEqual([json.loads(item.text)["content"]["draft_text"] for item in context.items[1:]],
                         ["失败生成的正文。", "早期仍运行的正文。"])
        self._require(context)

    def test_used_history_body_change_with_same_identity_is_rejected_and_not_logged(self):
        discussion_id = self._discussion("合成私密正文不能出现在诊断中。")
        request, _ = self._reserve()
        context = self._read(request)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_input SET content=jsonb_set(content,'{requirements}',%s) "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (Jsonb("同一身份的替换正文。"), self.owner_id, self.contact_id, discussion_id),
            )
        with self.assertRaises(ReplyStoreInvariantError) as caught:
            self._require(context)
        for value in (repr(context), repr(context.items), repr(context.snapshot),
                      json.dumps(asdict(context.snapshot), default=str), str(caught.exception)):
            self.assertNotIn("合成私密正文", value)
            self.assertNotIn("替换正文", value)
        with self.assertRaises(FrozenInstanceError):
            context.current_input_version_id = uuid4()
        with self.assertRaises(FrozenInstanceError):
            context.items[0].text = "不能改写历史运行输入。"

    def test_later_unused_candidate_version_does_not_invalidate_used_history(self):
        candidate, _, _ = self._complete()
        request, _ = self._reserve()
        context = self._read(request)
        edited = PostgresAssistantCandidateVersions(DATABASE_URL).edit(
            self.scope, self.session_id, candidate.candidate_id,
            EditAssistantCandidate(
                uuid4(), candidate.candidate_id,
                tuple(CandidateMessage(message.message_id, "稍后新增的有效版本。")
                      for message in candidate.message_group), "新增而未使用的修改要求。",
            ),
        )
        self.assertNotIn(edited.default_display_version_id,
                         [item.version_id for item in context.items])
        self._require(context)
        self.assertIn(edited.default_display_version_id,
                      [item.version_id for item in self._read(request).items])

    def test_unproven_other_contact_source_is_omitted_from_historical_discussion(self):
        source_id, message_id = self._source(contact_id=self.other_contact_id)
        discussion_id = self._discussion("来源归属被损坏的讨论。")
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_input SET dependency_ids=%s "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                ([source_id, message_id], self.owner_id, self.contact_id, discussion_id),
            )
        request, _ = self._reserve()
        context = self._read(request)
        self.assertEqual(context.items, ())
        self.assertEqual(self._require(context).source_ids, ())

    def test_same_connection_reads_uncommitted_version_and_caller_rollback_keeps_no_copy(self):
        candidate, _, _ = self._complete()
        request, _ = self._reserve()
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            edited = edit_candidate_version(connection, self.scope, self.session_id, candidate.candidate_id,
                                            EditAssistantCandidate(
                                                uuid4(), candidate.candidate_id,
                                                tuple(CandidateMessage(message.message_id, "尚未提交的合成修改。")
                                                      for message in candidate.message_group),
                                            ))
            context = read_assistant_discussion_in_transaction(connection, self.scope, request.idempotency_key)
            self.assertIn(edited.default_display_version_id, [item.version_id for item in context.items])
            require_assistant_discussion_current(connection, self.scope, context.snapshot)
            self.assertEqual(connection.execute("SELECT 1").fetchone(), (1,))
            connection.rollback()
        reopened = PostgresAssistantCandidateVersions(DATABASE_URL).read(
            self.scope, self.session_id, candidate.candidate_id,
        )
        self.assertEqual([version.version_number for version in reopened.versions], [0])
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(context)
        restored = self.sessions.read_session(self.scope, self.session_id)
        self.assertTrue(all(item.content is None for item in restored.inputs if item.type == "generation"))

    def test_owner_memory_proves_cross_contact_sources_and_expiration_rejects_used_snapshot(self):
        source_id, message_id = self._source(contact_id=self.other_contact_id)
        memory_id = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("""
                INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method)
                VALUES (%s,%s,'合成本人偏好。','preference',%s,'auto')
            """, (memory_id, self.owner_id, [message_id]))
        discussion_id = self._discussion("通过真实本人记忆支持的讨论。", dependencies=(memory_id,))
        request, _ = self._reserve()
        context = self._read(request)
        self.assertEqual([item.input_version_id for item in context.items], [discussion_id])
        self.assertEqual(set(self._require(context).source_ids), {source_id, message_id, memory_id})
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.owner_memory SET invalid_at=now() WHERE owner_id=%s AND id=%s",
                               (self.owner_id, memory_id))
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(context)
        self.assertEqual(self._read(request).items, ())

    def test_full_long_discussion_and_candidate_group_are_never_summarized_or_truncated(self):
        requirements = tuple(f"第{number}项：" + "完整要求" * 1000 for number in range(5))
        identifiers = [self._discussion(text) for text in requirements]
        parts = ("合成第一条。" + "甲" * 8000, "合成第二条。" + "乙" * 8000)
        self._complete(parts=parts)
        request, _ = self._reserve()
        context = self._read(request)
        discussion = [item for item in context.items if item.kind == "discussion_input"]
        self.assertEqual([item.input_version_id for item in discussion], identifiers)
        self.assertEqual([json.loads(item.text)["requirements"] for item in discussion], list(requirements))
        candidate = next(item for item in context.items if item.kind == "candidate_version")
        self.assertEqual([message["text"] for message in json.loads(candidate.text)["messages"]], list(parts))
        self.assertEqual(len(context.snapshot.records), 7)
        self._require(context)

    def test_same_current_uuid_cannot_hide_body_change_or_revoked_binding(self):
        self._discussion()
        request, turn_id = self._reserve()
        context = self._read(request)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_turn SET input_payload=jsonb_set(input_payload,'{content,draft_text}',%s) "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (Jsonb("同一当前UUID的正文变化。"), self.owner_id, self.contact_id, turn_id),
            )
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(context)
        fresh = self._read(request)
        self.assertEqual(fresh.current_input_version_id, context.current_input_version_id)
        PostgresConversationBindingRepository(DATABASE_URL).revoke_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, binding_id=self.binding_id,
        )
        with self.assertRaises(ReplyStoreInvariantError):
            self._read(request)
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(fresh)

    def test_used_candidate_deleted_after_read_is_rejected_by_public_snapshot_contract(self):
        candidate, _, _ = self._complete()
        request, _ = self._reserve()
        context = self._read(request)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s AND id=%s",
                               (self.owner_id, self.contact_id, candidate.candidate_id))
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(context)

    def test_immutable_context_snapshot_and_dependencies_reject_mutable_containers(self):
        self._discussion()
        request, _ = self._reserve()
        context = self._read(request)
        for construction in (
            lambda: replace(context, items=list(context.items)),
            lambda: replace(context.snapshot, records=list(context.snapshot.records)),
            lambda: DiscussionDependencies(source_ids=[uuid4()]),
        ):
            with self.subTest(construction=construction):
                with self.assertRaises(TypeError):
                    construction()

    def test_unproven_other_contact_source_does_not_make_legacy_generation_or_candidates_usable(self):
        source_id, message_id = self._source(contact_id=self.other_contact_id)
        _, _, historical_turn = self._complete()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET dependency_ids=%s "
                               "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                               ([source_id, message_id], self.owner_id, self.contact_id, historical_turn))
        request, _ = self._reserve()
        context = self._read(request)
        self.assertEqual(context.items, ())
        self.assertEqual(self._require(context).source_ids, ())

    def _available_snapshot(self, snapshot, *, scope=None):
        from notalone.persistence.assistant_discussion_context import require_assistant_discussion_available

        selected_scope = scope or self.scope
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=selected_scope.owner_id)
            return require_assistant_discussion_available(connection, selected_scope, snapshot)

    def test_completed_capture_remains_available_after_new_discussion_and_generation_without_pointer_rollback(self):
        from notalone.reply.assistant_discussion import (
            discussion_snapshot_from_payload, discussion_snapshot_to_payload,
        )

        history_id = self._discussion("甲之前仍有效的合成要求。")
        request, turn_id = self._reserve("甲的本次明确输入。")
        command = request.build_command(owner_id=self.owner_id, contact_id=self.contact_id,
                                        binding_id=self.binding_id)
        store = PostgresReplyStore(DATABASE_URL)
        started = store.start(command, VerifiedConversationScope(self.owner_id, self.contact_id, self.binding_id))
        capture = self._read(request)
        draft_id = uuid4()
        reply_context = ReplyContext(
            reply_request_id=started.request.request_id, command=command, scope=self.scope,
            current_text="甲的本次明确输入。", direction=None, skill_library_revision=0,
            evidence=(ContextEvidence(draft_id, "user_draft", "甲的本次明确输入。", self.scope,
                                      selection_reason="本次合成草稿"),),
        )
        store.prepare_context(started.request, reply_context)
        result = store.save(started.request, reply_context, ValidatedReply(
            (RuntimeCandidate(text="甲已完成的合成候选。", basis="保留草稿原意。",
                              citation_ids=(draft_id,), risk_notes=()),), None,
        ))
        self.sessions.complete(self.scope, self.session_id, turn_id, result)
        discussion_id = self._discussion("乙的新讨论要求。")
        self.assertEqual(self._available_snapshot(capture.snapshot), DiscussionDependencies())
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(capture)
        self.assertEqual(self.sessions.read_session(self.scope, self.session_id).current_input_version_id, discussion_id)
        self._reserve("乙的新生成输入。")
        latest = self.sessions.read_session(self.scope, self.session_id).current_input_version_id
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            persisted = connection.execute("SELECT %s::jsonb", (Jsonb(discussion_snapshot_to_payload(capture.snapshot)),)).fetchone()[0]
            reconstructed = discussion_snapshot_from_payload(persisted)
            self.assertEqual(reconstructed, capture.snapshot)
            from notalone.persistence.assistant_discussion_context import require_assistant_discussion_available

            self.assertEqual(require_assistant_discussion_available(connection, self.scope, reconstructed),
                             DiscussionDependencies())
        self.assertEqual([record.input_version_id for record in reconstructed.records], [history_id])
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(capture)
        self.assertEqual(self.sessions.read_session(self.scope, self.session_id).current_input_version_id, latest)

    def _assert_snapshot_rejected_by_both(self, snapshot, *, scope=None):
        from notalone.persistence.assistant_discussion_context import require_assistant_discussion_available

        selected_scope = scope or self.scope
        for guard in (require_assistant_discussion_current, require_assistant_discussion_available):
            with self.subTest(guard=guard.__name__):
                with psycopg.connect(DATABASE_URL) as connection:
                    lock_owner_scope(connection, owner_id=selected_scope.owner_id)
                    with self.assertRaises(ReplyStoreInvariantError):
                        guard(connection, selected_scope, snapshot)
                    self.assertEqual(connection.execute("SELECT 1").fetchone(), (1,))

    def test_available_and_current_both_reject_deleted_captured_raw_input_and_version(self):
        for removed_kind in ("raw", "input", "version"):
            with self.subTest(removed_kind=removed_kind):
                if removed_kind == "raw":
                    source_id, message_id = self._source()
                    self._complete(source=(source_id, message_id))
                elif removed_kind == "input":
                    input_id = self._discussion("单独删除的历史输入。")
                else:
                    candidate, _, _ = self._complete()
                    history = PostgresAssistantCandidateVersions(DATABASE_URL).edit(
                        self.scope, self.session_id, candidate.candidate_id,
                        EditAssistantCandidate(uuid4(), candidate.candidate_id,
                                               tuple(CandidateMessage(message.message_id, "可删除的合成编辑版。")
                                                     for message in candidate.message_group)),
                    )
                    version_id = history.default_display_version_id
                request, _ = self._reserve()
                capture = self._read(request)
                self._require(capture)
                self._available_snapshot(capture.snapshot)
                if removed_kind == "raw":
                    self._delete_source(source_id)
                else:
                    with psycopg.connect(DATABASE_URL) as connection:
                        if removed_kind == "input":
                            connection.execute("DELETE FROM public.assistant_session_input "
                                               "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                               (self.owner_id, self.contact_id, input_id))
                        else:
                            connection.execute("DELETE FROM public.assistant_candidate_version "
                                               "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                               (self.owner_id, self.contact_id, version_id))
                self._assert_snapshot_rejected_by_both(capture.snapshot)

    def test_available_validates_anchor_scope_hash_version_and_session_without_active_binding(self):
        source_id, message_id = self._source()
        historical_candidate, _, _ = self._complete(source=(source_id, message_id))
        _, _, anchor_id = self._complete("已完成的甲输入。")
        turns = self.sessions.read_session(self.scope, self.session_id).turns
        request = ReplyServiceRequest(idempotency_key=next(turn.request_key for turn in turns if turn.turn_id == anchor_id),
                                      content=RewriteDraft("已完成的甲输入。"))
        capture = self._read(request)
        self._available_snapshot(capture.snapshot)
        for scope in (ContactScope(self.owner_id, self.other_contact_id),
                      ContactScope(self.other_owner_id, self.contact_id)):
            self._assert_snapshot_rejected_by_both(capture.snapshot, scope=scope)
        self._assert_snapshot_rejected_by_both(replace(capture.snapshot, current_payload_sha256="0" * 64))
        record = next(record for record in capture.snapshot.records if record.kind == "candidate_version")
        for forged_record in (replace(record, payload_sha256="0" * 64), replace(record, version_id=uuid4())):
            forged = replace(capture.snapshot, records=tuple(forged_record if item == record else item
                                                            for item in capture.snapshot.records))
            self._assert_snapshot_rejected_by_both(forged)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.assistant_session_turn WHERE owner_id=%s AND contact_id=%s AND id=%s",
                               (self.owner_id, self.contact_id, anchor_id))
        self._assert_snapshot_rejected_by_both(capture.snapshot)

        _, _, new_anchor = self._complete("已完成的乙输入。")
        turns = self.sessions.read_session(self.scope, self.session_id).turns
        request = ReplyServiceRequest(idempotency_key=next(turn.request_key for turn in turns if turn.turn_id == new_anchor),
                                      content=RewriteDraft("已完成的乙输入。"))
        available_capture = self._read(request)
        expected = self._require(available_capture)
        PostgresConversationBindingRepository(DATABASE_URL).revoke_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, binding_id=self.binding_id,
        )
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(available_capture)
        edited = PostgresAssistantCandidateVersions(DATABASE_URL).edit(
            self.scope, self.session_id, historical_candidate.candidate_id,
            EditAssistantCandidate(uuid4(), historical_candidate.candidate_id,
                                   tuple(CandidateMessage(message.message_id, "后续未使用的有效版本。")
                                         for message in historical_candidate.message_group)),
        )
        self.assertNotIn(edited.default_display_version_id, [record.version_id for record in available_capture.snapshot.records])
        self.assertEqual(self._available_snapshot(available_capture.snapshot), expected)
        self.sessions.delete(self.scope, self.session_id)
        self._assert_snapshot_rejected_by_both(available_capture.snapshot)

    def test_failed_and_reserve_only_user_requirements_remain_complete_without_ai_candidates(self):
        expected = []
        for state in ("failed", "reserve_only", "failed_reserve_only"):
            draft = f"{state}的完整合成草稿。" + "兼容历史要求" * 1500
            instruction = f"{state}的一次性要求。" + "不要删去前文" * 1000
            request = ReplyServiceRequest(idempotency_key=uuid4(), content=RewriteDraft(
                draft, user_instruction=instruction,
            ))
            turn_id = self.sessions.reserve(self.scope, self.session_id, request)
            command = request.build_command(owner_id=self.owner_id, contact_id=self.contact_id,
                                            binding_id=self.binding_id)
            if state == "failed":
                store = PostgresReplyStore(DATABASE_URL)
                started = store.start(command, VerifiedConversationScope(
                    self.owner_id, self.contact_id, self.binding_id,
                ))
                store.fail(started.request, reason="synthetic_failed_generation")
            if state != "reserve_only":
                self.sessions.fail(self.scope, turn_id)
            with psycopg.connect(DATABASE_URL) as connection:
                stored = connection.execute(
                    "SELECT input_version_id,input_payload FROM public.assistant_session_turn "
                    "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                    (self.owner_id, self.contact_id, turn_id),
                ).fetchone()
                request_count = connection.execute(
                    "SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND contact_id=%s "
                    "AND idempotency_key=%s",
                    (self.owner_id, self.contact_id, request.idempotency_key),
                ).fetchone()[0]
            self.assertEqual(request_count, 1 if state == "failed" else 0)
            expected.append((stored[0], stored[1]))
        request, _ = self._reserve("最新明确输入继续独立提供。")
        context = self._read(request)
        self.assertEqual([item.input_version_id for item in context.items], [item[0] for item in expected])
        self.assertTrue(all(json.loads(item.text) == stored[1] for item, stored in zip(context.items, expected)),
                        "历史用户输入的完整载荷必须保留。")
        self.assertTrue(all(item.kind == "generation_input" for item in context.items))
        self.assertEqual(len(context.snapshot.records), 3)
        self.assertEqual(self._require(context), DiscussionDependencies())
        self.assertEqual(self._available_snapshot(context.snapshot), DiscussionDependencies())
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_id),
            ).fetchone()[0], 0)

    def _prepare_uncompleted_generation(self, *, source=None):
        draft = "失败后仍有效的合成用户要求。"
        request, turn_id = self._reserve(draft, relationship=bool(source))
        command = request.build_command(owner_id=self.owner_id, contact_id=self.contact_id,
                                        binding_id=self.binding_id)
        store = PostgresReplyStore(DATABASE_URL)
        started = store.start(command, VerifiedConversationScope(self.owner_id, self.contact_id, self.binding_id))
        evidence = (ContextEvidence(uuid4(), "user_draft", draft, self.scope,
                                    selection_reason="本次合成用户要求"),)
        if source is not None:
            source_id, message_id = source
            evidence += (ContextEvidence(message_id, "message", "合成来源原话。", self.scope,
                                         source_ids=(source_id,), selection_reason="本次实际合成来源"),)
        context = ReplyContext(reply_request_id=started.request.request_id, command=command, scope=self.scope,
                               current_text=draft, direction=None, skill_library_revision=0,
                               evidence=evidence)
        store.prepare_context(started.request, context)
        return request, turn_id, store, started.request, context

    def test_failed_user_input_returns_real_prepared_sources_and_source_deletion_rejects_both_guards(self):
        source_id, message_id = self._source()
        _, turn_id, store, lease, _ = self._prepare_uncompleted_generation(source=(source_id, message_id))
        store.fail(lease, reason="synthetic_failed_generation")
        self.sessions.fail(self.scope, turn_id)
        request, _ = self._reserve()
        capture = self._read(request)
        self.assertEqual(len(capture.items), 1)
        self.assertEqual(capture.items[0].kind, "generation_input")
        self.assertEqual(capture.items[0].reply_request_id, lease.request_id)
        self.assertEqual(self._require(capture).source_ids, (source_id,))
        self.assertEqual(self._available_snapshot(capture.snapshot).source_ids, (source_id,))
        self._delete_source(source_id)
        self._assert_snapshot_rejected_by_both(capture.snapshot)
        self.assertEqual(self._read(request).items, ())


    def test_reserve_only_message_input_keeps_actual_turn_sources_and_deleted_body_is_omitted(self):
        from notalone.reply.interface import ConfirmedDirection, DirectionSource, ReplyToMessage

        source_id, message_id = self._source()
        previous = ReplyServiceRequest(idempotency_key=uuid4(), content=ReplyToMessage(
            message_id, ConfirmedDirection("保留此前合成回应要求。", DirectionSource.DIRECT_INPUT),
            user_instruction="这条只预留的要求也不能静默删去。",
        ))
        previous_turn = self.sessions.reserve(self.scope, self.session_id, previous)
        request, _ = self._reserve()
        capture = self._read(request)
        self.assertEqual([(item.kind, item.turn_id, item.reply_request_id) for item in capture.items],
                         [("generation_input", previous_turn, None)])
        self.assertEqual(json.loads(capture.items[0].text)["content"]["user_instruction"],
                         "这条只预留的要求也不能静默删去。")
        dependencies = DiscussionDependencies(tuple(sorted((source_id, message_id))))
        self.assertEqual(self._require(capture), dependencies)
        self.assertEqual(self._available_snapshot(capture.snapshot), dependencies)
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_id),
            ).fetchone()[0], 0)
        self._delete_source(source_id)
        self._assert_snapshot_rejected_by_both(capture.snapshot)
        self.assertEqual(self._read(request).items, ())

    def test_replaced_failed_terminal_keeps_user_input_without_reviving_old_key_or_candidates(self):
        from notalone.persistence.reply_sources import invalidate_reply_keys

        previous, turn_id, store, lease, _ = self._prepare_uncompleted_generation()
        store.fail(lease, reason="generation_replaced")
        self.sessions.fail(self.scope, turn_id)
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            invalidate_reply_keys(connection, owner_id=self.owner_id, request_ids=[lease.request_id])
        original = next(turn.input for turn in self.sessions.read_session(self.scope, self.session_id).turns
                        if turn.turn_id == turn_id)
        request, _ = self._reserve("替换后的当前明确要求。")
        capture = self._read(request)
        self.assertEqual([(item.kind, item.turn_id) for item in capture.items], [("generation_input", turn_id)])
        self.assertTrue(json.loads(capture.items[0].text) == original, "替换只能失效旧生成，不能删去有效用户要求。")
        self.assertEqual(self._require(capture), DiscussionDependencies())
        self.assertEqual(self._available_snapshot(capture.snapshot), DiscussionDependencies())
        command = previous.build_command(owner_id=self.owner_id, contact_id=self.contact_id,
                                         binding_id=self.binding_id)
        with self.assertRaises(ReplyStoreInvariantError):
            store.start(command, VerifiedConversationScope(self.owner_id, self.contact_id, self.binding_id))
        self.assertEqual(self.sessions.read_session(self.scope, self.session_id).turns[0].state, "failed")
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_id),
            ).fetchone()[0], 0)

    def test_failed_user_input_content_change_with_same_uuid_rejects_both_guards(self):
        _, turn_id = self._reserve("不可在捕获后静默改写的合成要求。")
        self.sessions.fail(self.scope, turn_id)
        request, _ = self._reserve()
        capture = self._read(request)
        self.assertEqual(len(capture.items), 1)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_turn SET input_payload=jsonb_set(input_payload,'{content,draft_text}',%s) "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (Jsonb("同一历史UUID的另一个合成要求。"), self.owner_id, self.contact_id, turn_id),
            )
        self._assert_snapshot_rejected_by_both(capture.snapshot)

    def test_completed_reply_before_session_completion_keeps_only_user_input_as_history(self):
        _, turn_id, store, lease, reply_context = self._prepare_uncompleted_generation()
        result = store.save(lease, reply_context, ValidatedReply((RuntimeCandidate(
            text="已在C保存但尚未完成A会话的合成AI候选。", basis="本次合成用户要求。",
            citation_ids=(reply_context.evidence[0].evidence_id,), risk_notes=(),
        ),), None))
        self.assertEqual(len(result.candidates), 1)
        request, _ = self._reserve()
        capture = self._read(request)
        self.assertEqual([(item.kind, item.turn_id, item.reply_request_id) for item in capture.items],
                         [("generation_input", turn_id, result.reply_request_id)])
        self.assertNotIn("已在C保存但尚未完成A会话的合成AI候选。", capture.items[0].text)
        self.assertEqual(self._require(capture), DiscussionDependencies())
        self.assertEqual(self._available_snapshot(capture.snapshot), DiscussionDependencies())

    def test_running_user_input_failure_does_not_invalidate_unchanged_used_requirements(self):
        _, turn_id, store, lease, _ = self._prepare_uncompleted_generation()
        request, _ = self._reserve()
        capture = self._read(request)
        self.assertEqual([(item.kind, item.turn_id) for item in capture.items], [("generation_input", turn_id)])
        store.fail(lease, reason="synthetic_later_failure")
        self.sessions.fail(self.scope, turn_id)
        self.assertEqual(self._require(capture), DiscussionDependencies())
        self.assertEqual(self._available_snapshot(capture.snapshot), DiscussionDependencies())
        self.assertEqual(self._read(request).snapshot, capture.snapshot)

    def test_failed_own_anchor_keeps_valid_capture_during_same_key_retry_and_rejects_deleted_source(self):
        self._discussion("失败重试仍保留的兼容要求。")
        source_id, message_id = self._source()
        request, turn_id, store, lease, reply_context = self._prepare_uncompleted_generation(
            source=(source_id, message_id),
        )
        capture = self._read(request)
        store.fail(lease, reason="synthetic_failed_generation")
        self.sessions.fail(self.scope, turn_id)
        self.assertEqual(self._available_snapshot(capture.snapshot), DiscussionDependencies())
        self.assertEqual(self._require(capture), DiscussionDependencies())
        self.assertEqual(self.sessions.reserve(self.scope, self.session_id, request), turn_id)
        restarted = store.start(reply_context.command, VerifiedConversationScope(
            self.owner_id, self.contact_id, self.binding_id,
        ))
        self.assertEqual(restarted.request.request_id, lease.request_id)
        self.assertEqual(restarted.request.attempt, 2)
        store.prepare_context(restarted.request, reply_context)
        self.assertEqual(self.sessions.read_session(self.scope, self.session_id).turns[0].state, "failed")
        self.assertEqual(self._available_snapshot(capture.snapshot), DiscussionDependencies())
        self.assertEqual(self._require(capture), DiscussionDependencies())
        self._discussion("重试之后另一个明确输入。")
        self.assertEqual(self._available_snapshot(capture.snapshot), DiscussionDependencies())
        with self.assertRaises(ReplyStoreInvariantError):
            self._require(capture)
        self._delete_source(source_id)
        self._assert_snapshot_rejected_by_both(capture.snapshot)
        state = self.sessions.read_session(self.scope, self.session_id)
        self.assertEqual(next(turn for turn in state.turns if turn.turn_id == turn_id).state, "redacted")
