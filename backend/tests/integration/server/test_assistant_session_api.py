"""合成会话经公开 HTTP、真实回复流程及隔离 PostgreSQL 的可靠保存。"""

from __future__ import annotations

import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg
from psycopg import sql
from langchain_core.messages import AIMessage

from notalone.application.reply_service import ReplyService
from notalone.application.memory_service import MemoryService
from notalone.conversation.models import ConversationObservation
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.generator import ReplyGenerator
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import HttpBackend, ScriptedCoreModel
from tests.integration.persistence.concurrency import wait_for_blocked_operations
from tests.input_budget_support import synthetic_budget_kwargs


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class SessionScriptedModel(ScriptedCoreModel):
    response_entered: object = None

    def __init__(self) -> None:
        super().__init__()
        self.response_entered = threading.Event()

    def wait_for_response(self) -> None:
        if len(self.seen_calls) in self.response_gates:
            self.response_entered.set()
        super().wait_for_response()


class AssistantSessionHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("会话验收只允许隔离 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        self.draft_id = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成会话用户')",
                (self.owner_id,),
            )
            for contact_id in (self.contact_id, self.other_contact_id):
                connection.execute(
                    "INSERT INTO public.contact (owner_id, id, display_name) "
                    "VALUES (%s, %s, '同名合成联系人')",
                    (self.owner_id, contact_id),
                )
            connection.execute(
                "INSERT INTO public.skill_library (owner_id, revision) VALUES (%s, 0)",
                (self.owner_id,),
            )
        self.bindings = PostgresConversationBindingRepository(DATABASE_URL)
        self.binding = self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id,
            channel="wechat", account_scope="synthetic-session-account",
            conversation_locator=f"synthetic-{uuid4()}",
        )
        self.model = SessionScriptedModel()
        self.model.responses = [AIMessage(
            content="", tool_calls=[{
                "name": "ReplyRuntimeOutput", "id": "synthetic-session-reply",
                "args": {
                    "candidates": [{"text": "明天见。", "basis": "保留本次草稿原意。",
                                    "citation_ids": [str(self.draft_id)], "risk_notes": []}],
                    "used_skill_version_id": None,
                },
            }],
        )]
        retrieval = PostgresRetrieval(DATABASE_URL, memory_store=PostgresMemoryStore(DATABASE_URL),
                                      owner_memory_store=PostgresOwnerMemoryStore(DATABASE_URL))
        generator = ReplyGenerator(
            store=PostgresReplyStore(DATABASE_URL),
            context=RetrievalReplyContext(
                retrieval=retrieval, skill_library_revision=0,
                id_factory=lambda: self.draft_id,
            ),
            runtime=LangChainReplyRuntime(
                model=self.model, skill_port=PostgresSkillPort(DATABASE_URL),
                retrieval=retrieval,
                **synthetic_budget_kwargs(self.model),
            ),
        )
        self.reply_service = ReplyService(
            binding_lookup=lambda owner_id, contact_id: next((
                item.as_domain()
                for item in self.bindings.list_active_bindings(owner_id=owner_id)
                if item.scope.contact_id == contact_id
            ), None),
            conversation_factory=lambda binding: PostgresConversationPort(
                DATABASE_URL, owner_id=self.owner_id,
                observation=ConversationObservation.confirmed(binding.binding_id),
            ),
            reply=generator,
        )
        self.backend = self._backend()
        self.addCleanup(self._clean_owner)
        self.addCleanup(self.backend.close)

    def _clean_owner(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id = %s", (self.owner_id,))

    def _backend(self, *, owner_id=None) -> HttpBackend:
        owner_id = owner_id or self.owner_id
        return HttpBackend(create_app(
            database_url=DATABASE_URL, owner_id=owner_id,
            memory_service=MemoryService(contact_memory=PostgresMemoryStore(DATABASE_URL),
                                         owner_memory=PostgresOwnerMemoryStore(DATABASE_URL)),
            token="synthetic-assistant-session-token", reply_service=self.reply_service,
        ), owner_id)

    def _default(self, *, contact_id=None) -> tuple[int, dict]:
        return self.backend.request(
            f"/api/contacts/{contact_id or self.contact_id}/assistant-session/default",
            {}, method="POST",
        )

    def _path(self, session_id, *, contact_id=None) -> str:
        return f"/api/contacts/{contact_id or self.contact_id}/assistant-sessions/{session_id}"

    def _body(self, *, key=None, draft="明天见", contact_id=None) -> dict:
        return {"idempotency_key": str(key or uuid4()),
                "contact_id": str(contact_id or self.contact_id),
                "content": {"type": "rewrite_draft", "draft_text": draft}}

    def _source(self, text: str) -> tuple[str, str]:
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1)",
                (source_id, self.owner_id, self.contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message "
                "(id, owner_id, contact_id, speaker, message_type, text_content, occurred_at) "
                "VALUES (%s, %s, %s, 'contact', 'text', %s, now())",
                (message_id, self.owner_id, self.contact_id, text),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)",
                (message_id, self.owner_id, self.contact_id, source_id, str(message_id)),
            )
        return str(source_id), str(message_id)

    def _candidate(self, *citations: str) -> AIMessage:
        return AIMessage(content="", tool_calls=[{
            "name": "ReplyRuntimeOutput", "id": f"synthetic-{uuid4()}",
            "args": {"candidates": [{"text": "好的，明天见。", "basis": "依据本次合成资料。",
                                     "citation_ids": list(citations), "risk_notes": []}],
                     "used_skill_version_id": None},
        }])

    def _delete_source(self, source_id: str) -> None:
        path = f"/api/contacts/{self.contact_id}/sources/{source_id}"
        status, task = self.backend.request(path, method="DELETE")
        self.assertEqual(status, 202, task)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status, payload = self.backend.request(f"/api/contacts/{self.contact_id}/sources")
            self.assertEqual(status, 200, payload)
            source = next(item for item in payload["sources"] if item["source_id"] == source_id)
            if source["status"] == "deleted":
                return
            self.assertNotEqual(source["task_status"], "failed", source)
            time.sleep(0.02)
        self.fail("合成来源删除未在限定时间完成。")

    def test_default_session_saves_one_discussion_and_same_candidates(self) -> None:
        status, session = self._default()
        self.assertEqual(status, 200, session)
        path = self._path(session["session_id"])
        status, turn = self.backend.request(path + "/replies", self._body())
        self.assertEqual(status, 200, turn)
        self.assertEqual(turn["state"], "completed")
        self.assertEqual(turn["candidates"][0]["text"], "明天见。")
        saved = self.backend.request(path)[1]["turns"]
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["turn_id"], turn["turn_id"])
        self.assertEqual(saved[0]["input"]["content"]["draft_text"], "明天见")
        self.assertEqual(saved[0]["reply"]["candidates"], turn["candidates"])
        self.assertEqual(self._default()[1]["session_id"], session["session_id"])
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_same_key_replays_without_duplicate_and_changed_input_conflicts(self) -> None:
        status, session = self._default()
        self.assertEqual(status, 200, session)
        path = self._path(session["session_id"])
        body = self._body()
        status, first = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, first)
        self.assertEqual(self.backend.request(path + "/replies", body), (200, first))
        self.assertEqual(len(self.backend.request(path)[1]["turns"]), 1)
        conflicting = {**body, "content": {"type": "rewrite_draft", "draft_text": "改为拒绝"}}
        self.assertEqual(self.backend.request(path + "/replies", conflicting),
                         (409, {"error": "assistant_session_input_conflict"}))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_explicit_no_skill_survives_saved_input_and_same_key_replay(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        body = {**self._body(), "skill_disabled": True}
        status, first = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, first)
        saved_input = self.backend.request(path)[1]["turns"][0]["input"]
        self.assertIs(saved_input.get("skill_disabled"), True)
        self.assertIsNone(saved_input["skill_version_id"])
        self.assertEqual(self.backend.request(path + "/replies", body), (200, first))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_proactive_purpose_is_saved_without_a_fake_source_dependency(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        purpose = "问问近况，暂不作见面承诺。"
        body = {**self._body(), "content": {"type": "initiate_conversation", "purpose": purpose}}
        status, first = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, first)
        saved = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(saved["state"], "completed")
        self.assertEqual(saved["input"]["content"]["purpose"], purpose)
        self.assertNotIn("target_message_id", saved["input"]["content"])
        self.assertEqual(self.backend.request(path + "/replies", body), (200, first))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_legacy_original_source_snapshot_missing_masks_only_affected_turn(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        _, target_id = self._source("合成历史消息。")
        self.model.responses = [self._candidate(target_id), self._candidate(str(self.draft_id))]
        body = {**self._body(), "content": {"type": "reply_to_message", "target_message_id": target_id,
                  "direction": "只回应这条合成消息。"}}
        status, affected = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, affected)
        self.assertEqual(self.backend.request(path + "/replies", self._body())[0], 200)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.reply_original_source_use WHERE reply_request_id=%s",
                               (affected["reply_request_id"],))
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "unavailable")
        self.assertIsNone(saved["turns"][0]["input"])
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(saved["turns"][1]["state"], "completed")
        self.assertEqual(saved["turns"][1]["input"]["content"]["draft_text"], "明天见")
        self.assertEqual(len(self.model.seen_calls), 2)

    def test_memory_message_with_two_sources_masks_only_pending_source_turn(self) -> None:
        first_source, message_id = self._source("明天一起散步，我希望表达轻松自然。")
        other_source, _ = self._source("第二份独立合成来源。")
        status, memory = self.backend.request("/api/memories/manual-owner", {
            "text": "明天一起散步，我希望表达轻松自然。", "category": "preference", "topic": "other",
        })
        self.assertEqual(status, 200, memory)
        memory_id = memory["memory"]["memory_id"]
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.message_source_ref "
                "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,%s,'{}'::jsonb)",
                (message_id,self.owner_id,self.contact_id,other_source,str(uuid4())))
            connection.execute("UPDATE public.owner_memory SET adoption_method='auto', source_ids=%s::uuid[] "
                               "WHERE owner_id=%s AND id=%s", ([message_id],self.owner_id,memory_id))
        _, session = self._default()
        path = self._path(session["session_id"])
        body = self._body(draft="明天一起散步，我希望表达轻松自然。")
        body["content"]["include_relationship_context"] = True
        self.model.responses = [self._candidate(memory_id,str(self.draft_id)), self._candidate(str(self.draft_id))]
        status, affected = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, affected)
        evidence = self.backend.request(
            f"/api/contacts/{self.contact_id}/replies/{affected['reply_request_id']}/evidence")[1]
        self.assertTrue(any(item["evidence_id"] == memory_id for item in evidence["evidence"]))
        self.assertEqual(self.backend.request(path + "/replies", self._body())[0], 200)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE id=%s", (first_source,))
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "unavailable")
        self.assertIsNone(saved["turns"][0]["input"])
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(saved["turns"][1]["state"], "completed")
        self.assertEqual(len(self.model.seen_calls), 2)

    def test_source_used_only_as_context_erases_dependent_turn_and_preserves_unrelated_input(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        _, independent = self.backend.request(path + "/replies", self._body())
        _, target_id = self._source("明天一起散步？")
        context_source, _ = self._source("明天合成天气晴朗。")
        self.model.responses.append(self._candidate(target_id))
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": target_id,
                            "direction": "轻松答应"}}
        status, dependent = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, dependent)
        self._delete_source(context_source)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], independent["candidates"])
        removed = saved["turns"][1]
        self.assertEqual(removed["state"], "redacted")
        self.assertIsNone(removed["input"])
        self.assertIsNone(removed["reply"])
        self.assertEqual(removed["placeholder"], "相关来源已删除")
        self.assertEqual(self.backend.request(path + "/replies", body),
                         (409, {"error": "assistant_session_rejected", "reason": "source_deleted"}))
        self.assertEqual(len(self.model.seen_calls), 2)

    def test_manual_owner_memory_sentinel_is_not_a_chat_source_and_deletion_erases_discussion(self) -> None:
        text = "明天一起散步，我说话希望轻松自然。"
        status, saved_memory = self.backend.request("/api/memories/manual-owner", {
            "text": text, "category": "preference", "topic": "other",
        })
        self.assertEqual(status, 200, saved_memory)
        memory_id = saved_memory["memory"]["memory_id"]
        self.assertEqual(saved_memory["memory"]["source_ids"], [str(self.owner_id)])
        _, session = self._default()
        path = self._path(session["session_id"])
        body = self._body(draft=text)
        body["content"]["include_relationship_context"] = True
        status, reply = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)
        evidence = self.backend.request(
            f"/api/contacts/{self.contact_id}/replies/{reply['reply_request_id']}/evidence",
        )[1]
        self.assertTrue(any(item["kind"] == "owner_memory" and item["evidence_id"] == memory_id
                            for item in evidence["evidence"]))
        self.assertEqual(self.backend.request(path)[1]["turns"][0]["state"], "completed")
        status, removed = self.backend.request(f"/api/memories/owner/{memory_id}/delete", {})
        self.assertEqual(status, 200, removed)
        turn = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(turn["state"], "redacted")
        self.assertIsNone(turn["input"])
        self.assertIsNone(turn["reply"])
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_auto_owner_memory_cannot_claim_the_manual_owner_sentinel(self) -> None:
        text = "明天一起散步，我希望表达轻松自然。"
        status, memory = self.backend.request("/api/memories/manual-owner", {
            "text": text, "category": "preference", "topic": "other",
        })
        self.assertEqual(status, 200, memory)
        _, session = self._default()
        path = self._path(session["session_id"])
        body = self._body(draft=text)
        body["content"]["include_relationship_context"] = True
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 200)
        # 模拟旧资料错误声称自动来源；owner 伪引用只允许实际手工记忆。
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.owner_memory SET adoption_method='auto' "
                               "WHERE owner_id=%s AND id=%s",
                               (self.owner_id, memory["memory"]["memory_id"]))
        turn = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(turn["state"], "unavailable")
        self.assertIsNone(turn["input"])
        self.assertIsNone(turn["reply"])
        self.assertEqual(self.backend.request(path + "/replies", body),
                         (409, {"error": "assistant_session_rejected", "reason": "source_unavailable"}))
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_owner_memory_deletion_preserves_an_unrelated_running_draft(self) -> None:
        status, memory = self.backend.request("/api/memories/manual-owner", {
            "text": "无关的手工本人资料。", "category": "common_fact", "topic": "other",
        })
        self.assertEqual(status, 200, memory)
        _, session = self._default()
        path = self._path(session["session_id"])
        gate = self.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", self._body())
            try:
                self.assertTrue(self.model.response_entered.wait(timeout=3))
                status, removed = self.backend.request(
                    f"/api/memories/owner/{memory['memory']['memory_id']}/delete", {},
                )
                self.assertEqual(status, 200, removed)
            finally:
                gate.set()
            self.assertEqual(pending.result(timeout=5)[0], 200)
        self.assertEqual(self.backend.request(path)[1]["turns"][0]["state"], "completed")
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_owner_memory_delete_rejects_a_chat_source_id_without_erasing_discussion(self) -> None:
        source_id, message_id = self._source("明天合成时间再确认？")
        self.model.responses = [self._candidate(message_id)]
        _, session = self._default()
        path = self._path(session["session_id"])
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": message_id,
                            "direction": "说明稍后确认"}}
        status, reply = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)
        status, _ = self.backend.request(f"/api/memories/owner/{source_id}/delete", {})
        self.assertNotEqual(status, 200)
        turn = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(turn["state"], "completed")
        self.assertEqual(turn["reply"]["candidates"], reply["candidates"])
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_concurrent_same_key_is_visible_as_in_progress_without_failing_running_turn(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        body = self._body()
        gate = self.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                self.assertEqual(self.backend.request(path + "/replies", body),
                                 (409, {"error": "assistant_session_in_progress"}))
                saved = self.backend.request(path)[1]
                self.assertEqual(saved["turns"][0]["state"], "running")
            finally:
                gate.set()
            self.assertEqual(running.result(timeout=10)[0], 200)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_database_save_failure_is_visible_and_retry_reuses_saved_reply(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        body = self._body()
        name = f"synthetic_session_fault_{uuid4().hex}"
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS "
                "'BEGIN RAISE EXCEPTION ''synthetic_save_failure''; END;'"
            ).format(name=sql.Identifier(name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {name} BEFORE UPDATE OF state ON public.assistant_session_turn "
                "FOR EACH ROW WHEN (NEW.owner_id = {owner}::uuid AND NEW.state = 'completed') "
                "EXECUTE FUNCTION public.{name}()"
            ).format(name=sql.Identifier(name), owner=sql.Literal(str(self.owner_id))))
        try:
            self.assertEqual(self.backend.request(path + "/replies", body),
                             (503, {"error": "assistant_session_save_failed"}))
            saved = self.backend.request(path)[1]["turns"]
            self.assertEqual(saved[0]["state"], "failed")
            self.assertIsNone(saved[0]["reply"])
            version = saved[0]["input_version_id"]
        finally:
            with psycopg.connect(DATABASE_URL) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.assistant_session_turn")
                                   .format(name=sql.Identifier(name)))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()")
                                   .format(name=sql.Identifier(name)))
        status, retried = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, retried)
        self.assertEqual(retried["input_version_id"], version)
        self.assertEqual(len(self.backend.request(path)[1]["turns"]), 1)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_binding_revoked_during_model_call_prevents_candidate_commit(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        body = self._body()
        gate = self.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                self.bindings.revoke_binding(
                    owner_id=self.owner_id, contact_id=self.contact_id,
                    binding_id=self.binding.binding_id,
                )
            finally:
                gate.set()
            self.assertEqual(running.result(timeout=10)[0], 503)
        saved = self.backend.request(path)[1]["turns"]
        self.assertEqual(saved[0]["state"], "failed")
        self.assertIsNone(saved[0]["reply"])
        # 合成宿主重新确认同一个绑定；若旧候选曾落库，此处会重放而不调用模型。
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.conversation_binding SET status = 'active', revoked_at = NULL "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s",
                (self.owner_id, self.contact_id, self.binding.binding_id),
            )
        self.model.responses.append(self._candidate(str(self.draft_id)))
        status, retried = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, retried)
        self.assertEqual(retried["candidates"][0]["text"], "好的，明天见。")
        self.assertEqual(len(self.model.seen_calls), 2)

    def test_source_deleted_during_model_call_cannot_restore_turn_or_candidates(self) -> None:
        source_id, target_id = self._source("合成邀请明天见面。")
        self.model.responses = [self._candidate(target_id)]
        _, session = self._default()
        path = self._path(session["session_id"])
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": target_id,
                            "direction": "轻松答应"}}
        gate = self.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                self._delete_source(source_id)
            finally:
                gate.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "redacted")
        self.assertIsNone(saved["turns"][0]["input"])
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(self.backend.request(path + "/replies", body),
                         (409, {"error": "assistant_session_rejected", "reason": "source_deleted"}))

    def test_owner_contact_scope_and_missing_binding_do_not_generate(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        other_owner = self._backend(owner_id=uuid4())
        self.addCleanup(other_owner.close)
        self.assertEqual(other_owner.request(path), (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(self._path(session["session_id"], contact_id=self.other_contact_id)),
                         (404, {"error": "not_found"}))
        self.assertEqual(self._default(contact_id=self.other_contact_id),
                         (409, {"error": "assistant_session_rejected", "reason": "no_active_binding"}))
        self.assertEqual(self.backend.request(path + "/replies", self._body(contact_id=self.other_contact_id))[0], 400)
        self.assertEqual(len(self.model.seen_calls), 0)

    def test_contact_erasure_removes_session_and_all_generated_records(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        status, turn = self.backend.request(path + "/replies", self._body())
        self.assertEqual(status, 200, turn)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.contact WHERE owner_id = %s AND id = %s",
                (self.owner_id, self.contact_id),
            )
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        evidence = f"/api/contacts/{self.contact_id}/replies/{turn['reply_request_id']}/evidence"
        self.assertEqual(self.backend.request(evidence)[0], 404)

    def test_existing_standalone_request_is_not_inferred_into_default_session(self) -> None:
        body = self._body()
        status, _ = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200)
        _, session = self._default()
        path = self._path(session["session_id"])
        self.assertEqual(self.backend.request(path)[1]["turns"], [])
        self.assertEqual(self.backend.request(path + "/replies", body),
                         (409, {"error": "assistant_session_input_conflict"}))
        self.assertEqual(len(self.model.seen_calls), 1)
        self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.other_contact_id,
            channel="wechat", account_scope="synthetic-session-account",
            conversation_locator=f"synthetic-{uuid4()}",
        )
        status, other = self._default(contact_id=self.other_contact_id)
        self.assertEqual(status, 200, other)
        self.assertNotEqual(other["session_id"], session["session_id"])

    def test_existing_candidate_continuation_inherits_all_source_dependencies(self) -> None:
        source_id, target_id = self._source("合成来源约定明天见面。")
        self.model.responses = [self._candidate(target_id)]
        _, session = self._default()
        path = self._path(session["session_id"])
        status, original = self.backend.request(path + "/replies", {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "reply_to_message", "target_message_id": target_id,
                        "direction": "轻松答应"},
        })
        self.assertEqual(status, 200, original)
        candidate_id = original["candidates"][0]["candidate_id"]
        self.model.responses.append(self._candidate(candidate_id))
        continued = {**self._body(draft="请把选中候选写得更轻松"),
                     "continued_from_candidate_id": candidate_id}
        status, reply = self.backend.request(path + "/replies", continued)
        self.assertEqual(status, 200, reply)
        self._delete_source(source_id)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual([turn["state"] for turn in saved["turns"]], ["redacted", "redacted"])
        self.assertTrue(all(turn["input"] is None and turn["reply"] is None for turn in saved["turns"]))
        self.assertEqual(self.backend.request(path + "/replies", continued)[0], 409)

    def test_deletion_requested_hides_dependent_text_before_cleanup_and_keeps_unrelated_turn(self) -> None:
        _, session = self._default()
        path = self._path(session["session_id"])
        _, independent = self.backend.request(path + "/replies", self._body())
        source_id, target_id = self._source("合成来源仍在等待删除。")
        self.model.responses.append(self._candidate(target_id))
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": target_id,
                            "direction": "自然回应"}}
        status, reply = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)
        # 数据库边界模拟已请求删除、Worker 尚未清除或失败后的等待窗口。
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.source_document SET status = 'delete_requested' "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s",
                (self.owner_id, self.contact_id, source_id),
            )
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], independent["candidates"])
        unavailable = saved["turns"][1]
        self.assertEqual(unavailable["state"], "unavailable")
        self.assertIsNone(unavailable["input"])
        self.assertIsNone(unavailable["reply"])
        self.assertEqual(unavailable["placeholder"], "相关来源不可用")

    def test_source_invalidated_between_model_validation_and_commit_rejects_late_candidate(self) -> None:
        source_id, target_id = self._source("合成提交竞态来源。")
        self.model.responses = [self._candidate(target_id)]
        _, session = self._default()
        path = self._path(session["session_id"])
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": target_id,
                            "direction": "自然回应"}}
        gate = self.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                with psycopg.connect(DATABASE_URL) as connection:
                    lock_owner_scope(connection, owner_id=self.owner_id)
                    connection.execute(
                        "UPDATE public.source_document SET status = 'delete_requested' "
                        "WHERE owner_id = %s AND contact_id = %s AND id = %s",
                        (self.owner_id, self.contact_id, source_id),
                    )
                    holder = connection.execute("SELECT pg_backend_pid()").fetchone()[0]
                    gate.set()
                    # 独立连接仍见旧 active；只用数据库锁边界安排提交等待窗口。
                    wait_for_blocked_operations(DATABASE_URL, {holder}, 1)
                status, reply = running.result(timeout=10)
                self.assertNotEqual(status, 200, reply)
            finally:
                gate.set()
        saved = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(saved["state"], "unavailable")
        self.assertIsNone(saved["reply"])

    def test_same_key_replay_does_not_return_source_pending_deletion(self) -> None:
        source_id, target_id = self._source("合成重放来源。")
        self.model.responses = [self._candidate(target_id)]
        _, session = self._default()
        path = self._path(session["session_id"])
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": target_id,
                            "direction": "自然回应"}}
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 200)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.source_document SET status = 'delete_requested' "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s",
                (self.owner_id, self.contact_id, source_id),
            )
        self.assertEqual(self.backend.request(path + "/replies", body),
                         (409, {"error": "assistant_session_rejected", "reason": "source_unavailable"}))
        self.assertEqual(len(self.model.seen_calls), 1)

    def _attach_source(self, source_id: str, message_id: str) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                "VALUES (%s, %s, %s, 'source_document', %s, %s, '{}'::jsonb)",
                (message_id, self.owner_id, self.contact_id, source_id, f"shared-{message_id}"),
            )

    def test_inactive_alternate_source_is_not_used_or_attached_to_new_discussion(self) -> None:
        _, target_id = self._source("合成消息仍由有效来源支持。")
        inactive_source, _ = self._source("合成停用来源的其他消息。")
        self._attach_source(inactive_source, target_id)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.source_document SET status = 'delete_requested' "
                "WHERE owner_id = %s AND contact_id = %s AND id = %s",
                (self.owner_id, self.contact_id, inactive_source),
            )
        self.model.responses = [self._candidate(target_id)]
        _, session = self._default()
        path = self._path(session["session_id"])
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": target_id,
                            "direction": "自然回应"}}
        status, reply = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)
        self._delete_source(inactive_source)
        saved = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(saved["state"], "completed")
        self.assertEqual(saved["reply"]["candidates"], reply["candidates"])

    def test_candidate_continuation_does_not_inherit_source_attached_after_original_generation(self) -> None:
        _, target_id = self._source("合成原始候选只用早期来源。")
        self.model.responses = [self._candidate(target_id)]
        _, session = self._default()
        path = self._path(session["session_id"])
        status, original = self.backend.request(path + "/replies", {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "reply_to_message", "target_message_id": target_id,
                        "direction": "自然回应"},
        })
        self.assertEqual(status, 200, original)
        later_source, _ = self._source("合成后来增加的独立来源。")
        self._attach_source(later_source, target_id)
        candidate_id = original["candidates"][0]["candidate_id"]
        self.model.responses.append(self._candidate(candidate_id))
        status, continued = self.backend.request(path + "/replies", {
            **self._body(draft="把选中候选稍作润色"), "continued_from_candidate_id": candidate_id,
        })
        self.assertEqual(status, 200, continued)
        self._delete_source(later_source)
        turns = self.backend.request(path)[1]["turns"]
        self.assertEqual([turn["state"] for turn in turns], ["completed", "completed"])
        self.assertEqual(turns[1]["reply"]["candidates"], continued["candidates"])


if __name__ == "__main__":
    unittest.main()
