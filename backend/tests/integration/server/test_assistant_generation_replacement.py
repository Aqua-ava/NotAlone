"""生成中显式替换经公开 HTTP、正式流程和隔离 PostgreSQL 验证。"""

from __future__ import annotations

import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field, PrivateAttr

from notalone.application.reply_service import ReplyService
from notalone.conversation.models import ConversationObservation
from notalone.persistence.assistant_discussion_reply_context import PostgresAssistantDiscussionContext
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository, PostgresConversationPort,
)
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import PostgresSkillPort
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import ReplyContext, RetrievalReplyContext
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.reply.generator import ReplyGenerator
from notalone.reply.input_budget import InputBudgetDecision
from notalone.reply.interface import ReplyGenerated
from notalone.reply.store import ReplyRequest, ValidatedReply
from notalone.scopes import VerifiedConversationScope
from notalone.server.app import create_app
from tests.input_budget_support import SyntheticBudgetModel, synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend, tool_response


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class ReplacementScriptedModel(SyntheticBudgetModel):
    """只阻塞旧模型响应，新调用独立返回；取消后旧供应商仍可能完成。"""

    seen_calls: list[list[BaseMessage]] = Field(default_factory=list)
    response_entered: object = None
    release_first_response: object = None
    _call_lock: Any = PrivateAttr(default_factory=threading.Lock)
    _response_gates: dict[int, tuple[threading.Event, threading.Event]] = PrivateAttr(default_factory=dict)
    _failed_calls: set[int] = PrivateAttr(default_factory=set)

    def __init__(self, responses: list[AIMessage]) -> None:
        super().__init__(responses=responses)
        self.response_entered = threading.Event()
        self.release_first_response = threading.Event()

    def pause_response(self, index: int) -> tuple[threading.Event, threading.Event]:
        entered, release = threading.Event(), threading.Event()
        with self._call_lock:
            self._response_gates[index] = (entered, release)
        return entered, release

    def fail_response(self, index: int) -> None:
        with self._call_lock:
            self._failed_calls.add(index)

    def _generate(
        self, messages: list[BaseMessage], stop: list[str] | None = None,
        run_manager: Any = None, **kwargs: Any,
    ) -> ChatResult:
        with self._call_lock:
            index = len(self.seen_calls)
            if index >= len(self.responses):
                raise AssertionError("合成替换模型脚本已耗尽，禁止额外调用。")
            response = self.responses[index]
            self.seen_calls.append(messages)
            self.record_model_payload(messages, kwargs)
            gates = ((self.response_entered, self.release_first_response) if index == 0
                     else self._response_gates.get(index))
            failed = index in self._failed_calls
        if gates is not None:
            gates[0].set()
            if not gates[1].wait(10):
                raise TimeoutError("合成响应未在约定时限内释放。")
        if failed:
            raise RuntimeError("合成模型受控失败。")
        return ChatResult(generations=[ChatGeneration(message=response)])


class SavedReplyBarrierStore(PostgresReplyStore):
    """真实 SAVE 提交后有限等待；只控制结果交给助手会话的时机。"""

    def __init__(self, database_url: str) -> None:
        super().__init__(database_url)
        self.paused_key: UUID | None = None
        self.saved_reply: ReplyGenerated | None = None
        self.saved_event = threading.Event()
        self.release_after_save = threading.Event()
        self.prepared_contexts: dict[UUID, tuple[ReplyRequest, ReplyContext]] = {}
        self.successful_saves: dict[UUID, tuple[ReplyRequest, ReplyContext, ValidatedReply]] = {}

    def prepare_context(self, request: ReplyRequest, context: ReplyContext) -> None:
        super().prepare_context(request, context)
        self.prepared_contexts[request.idempotency_key] = (request, context)

    def save(
        self, request: ReplyRequest, context: ReplyContext, reply: ValidatedReply,
    ) -> ReplyGenerated:
        result = super().save(request, context, reply)
        self.successful_saves[request.idempotency_key] = (request, context, reply)
        if request.idempotency_key == self.paused_key:
            self.saved_reply = result
            self.saved_event.set()
            if not self.release_after_save.wait(10):
                raise TimeoutError("真实已保存回复未在约定时限内交给助手会话。")
        return result


class AssistantGenerationReplacementHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定本票隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            database_name = connection.execute("SELECT current_database()").fetchone()[0]
        if not database_name.endswith("_test"):
            raise RuntimeError("替换 HTTP 验收只允许隔离 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id, self.contact_id, self.draft_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成 HTTP 替换用户')",
                (self.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, '合成 HTTP 替换联系人')", (self.owner_id, self.contact_id),
            )
            connection.execute("INSERT INTO public.skill_library (owner_id, revision) VALUES (%s, 0)",
                               (self.owner_id,))
        self.addCleanup(self._clean_owner)
        self.bindings = PostgresConversationBindingRepository(DATABASE_URL)
        self.binding = self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-http-replacement", conversation_locator=f"synthetic-{uuid4()}",
        )
        self.model = ReplacementScriptedModel([
            self._candidate("合成旧候选迟到"), self._candidate("合成新要求的有效候选"),
        ])
        budget_configuration = synthetic_budget_kwargs(self.model)
        self.input_counter = budget_configuration["input_token_counter"]
        self.input_profile = budget_configuration["input_budget_profile"]
        self.budget_decisions: list[InputBudgetDecision] = []
        self.reply_store = SavedReplyBarrierStore(DATABASE_URL)
        self.reply_service = self._reply_service_with_budget(budget_configuration)
        self.backend = HttpBackend(create_app(
            database_url=DATABASE_URL, owner_id=self.owner_id,
            token="synthetic-assistant-replacement-token", reply_service=self.reply_service,
        ), self.owner_id)
        self.addCleanup(self.backend.close)
        self.addCleanup(self.model.release_first_response.set)
        self.addCleanup(self.reply_store.release_after_save.set)

    def _reply_service_with_budget(self, budget_configuration: dict[str, Any]) -> ReplyService:
        retrieval = PostgresRetrieval(
            DATABASE_URL, memory_store=PostgresMemoryStore(DATABASE_URL),
            owner_memory_store=PostgresOwnerMemoryStore(DATABASE_URL),
        )
        return ReplyService(
            binding_lookup=lambda owner_id, contact_id: next((
                binding.as_domain() for binding in self.bindings.list_active_bindings(owner_id=owner_id)
                if binding.scope.contact_id == contact_id
            ), None),
            conversation_factory=lambda binding: PostgresConversationPort(
                DATABASE_URL, owner_id=self.owner_id,
                observation=ConversationObservation.confirmed(binding.binding_id),
            ),
            reply=ReplyGenerator(
                store=self.reply_store,
                context=PostgresAssistantDiscussionContext(
                    RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0,
                                          id_factory=lambda: self.draft_id),
                    database_url=DATABASE_URL,
                ),
                runtime=LangChainReplyRuntime(
                    model=self.model, skill_port=PostgresSkillPort(DATABASE_URL), retrieval=retrieval,
                    on_input_budget=self.budget_decisions.append,
                    **budget_configuration,
                ),
            ),
        )

    def _budget_backend(self, capacity: int) -> tuple[HttpBackend, Any]:
        configuration = synthetic_budget_kwargs(self.model, capacity=capacity)
        backend = HttpBackend(create_app(
            database_url=DATABASE_URL, owner_id=self.owner_id,
            token="synthetic-assistant-replacement-token",
            reply_service=self._reply_service_with_budget(configuration),
        ), self.owner_id)
        self.addCleanup(backend.close)
        return backend, configuration["input_token_counter"]

    def _clean_owner(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id = %s", (self.owner_id,))

    def _candidate(self, text: str) -> AIMessage:
        return tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": text, "basis": "保留本轮合成草稿原意。",
                            "citation_ids": [str(self.draft_id)], "risk_notes": []}],
            "used_skill_version_id": None,
        })

    def _body(self, *, draft: str, instruction: str) -> dict[str, Any]:
        return {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": draft, "user_instruction": instruction},
        }

    def _session_path(self) -> str:
        status, session = self.backend.request(
            f"/api/contacts/{self.contact_id}/assistant-session/default", {}, method="POST",
        )
        self.assertEqual(status, 200, session)
        return f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"

    def test_replacement_uses_the_waiting_request_key_and_rejects_the_late_old_response(self) -> None:
        status, session = self.backend.request(
            f"/api/contacts/{self.contact_id}/assistant-session/default", {}, method="POST",
        )
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        old_body = self._body(draft="合成原草稿", instruction="合成旧要求")
        new_body = self._body(draft="合成原草稿", instruction="合成新明确要求：更简洁")

        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5), "旧生成必须实际进入合成模型。")
                status, pending = self.backend.request(path)
                self.assertEqual(status, 200, pending)
                self.assertEqual(pending["turns"][0]["request_key"], old_body["idempotency_key"])
                self.assertEqual(pending["turns"][0]["state"], "running")
                status, replacement = self.backend.request(path + "/replace", {
                    "running_request_key": old_body["idempotency_key"], "replacement": new_body,
                })
                self.assertEqual(status, 200, replacement)
                self.assertEqual(replacement["candidates"][0]["text"], "合成新要求的有效候选")
            finally:
                self.model.release_first_response.set()
            late_status, late = running.result(timeout=10)
        self.assertNotEqual(late_status, 200, late)

        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], replacement["input_version_id"])
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[old_body["idempotency_key"]]["state"], "failed")
        self.assertIsNone(turns[old_body["idempotency_key"]]["reply"])
        self.assertEqual(turns[new_body["idempotency_key"]]["state"], "completed")
        self.assertEqual(turns[new_body["idempotency_key"]]["reply"]["candidates"][0]["text"],
                         "合成新要求的有效候选")
        self.assertEqual(len(self.model.seen_calls), 2)

    def test_same_new_key_replay_and_conflict_leave_the_later_running_generation_untouched(self) -> None:
        status, session = self.backend.request(
            f"/api/contacts/{self.contact_id}/assistant-session/default", {}, method="POST",
        )
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        old_body = self._body(draft="合成原草稿", instruction="合成旧要求")
        new_body = self._body(draft="合成原草稿", instruction="合成新要求")
        replacement_body = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                status, replacement = self.backend.request(path + "/replace", replacement_body)
                self.assertEqual(status, 200, replacement)
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)

        self.model.responses.append(self._candidate("合成后继生成的有效候选"))
        entered, release = self.model.pause_response(2)
        later_body = self._body(draft="合成后继草稿", instruction="合成后继要求")
        with ThreadPoolExecutor(max_workers=1) as pool:
            later = pool.submit(self.backend.request, path + "/replies", later_body)
            try:
                self.assertTrue(entered.wait(5))
                status, before = self.backend.request(path)
                self.assertEqual(status, 200, before)

                self.assertEqual(self.backend.request(path + "/replace", replacement_body), (200, replacement))
                conflicting = {**new_body, "content": {**new_body["content"], "draft_text": "同键不同合成正文"}}
                self.assertEqual(self.backend.request(path + "/replace", {
                    "running_request_key": old_body["idempotency_key"], "replacement": conflicting,
                }), (409, {"error": "assistant_session_input_conflict"}))
                status, after = self.backend.request(path)
                self.assertEqual(status, 200, after)
                self.assertEqual(after["current_input_version_id"], before["current_input_version_id"])
                current = next(turn for turn in after["turns"] if turn["request_key"] == later_body["idempotency_key"])
                self.assertEqual(current["state"], "running")
                self.assertEqual(len(self.model.seen_calls), 3)
            finally:
                release.set()
            status, saved = later.result(timeout=10)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["candidates"][0]["text"], "合成后继生成的有效候选")
        self.assertEqual(len(self.model.seen_calls), 3)

    def test_completed_reply_save_wins_even_before_assistant_turn_completion(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成已完成草稿", instruction="合成已完成要求")
        new_body = self._body(draft="合成替换草稿", instruction="不能取消已完成结果")
        replacement_body = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
        self.reply_store.paused_key = UUID(old_body["idempotency_key"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                self.model.release_first_response.set()
                self.assertTrue(self.reply_store.saved_event.wait(5))
                self.assertIsInstance(self.reply_store.saved_reply, ReplyGenerated)
                with psycopg.connect(DATABASE_URL) as connection:
                    receipt = connection.execute(
                        "SELECT request.id, request.state, turn.state "
                        "FROM public.reply_request AS request JOIN public.assistant_session_turn AS turn "
                        "ON request.owner_id = turn.owner_id AND request.contact_id = turn.contact_id "
                        "AND request.idempotency_key = turn.idempotency_key "
                        "WHERE turn.owner_id = %s AND turn.contact_id = %s AND turn.session_id = %s "
                        "AND turn.idempotency_key = %s",
                        (self.owner_id, self.contact_id, UUID(path.rsplit("/", 1)[-1]),
                         UUID(old_body["idempotency_key"])),
                    ).fetchone()
                self.assertEqual(receipt, (self.reply_store.saved_reply.reply_request_id, "completed", "running"))
                status, waiting = self.backend.request(path)
                self.assertEqual(status, 200, waiting)
                self.assertEqual(len(waiting["turns"]), 1)
                self.assertEqual(waiting["turns"][0]["state"], "running")
                self.assertIsNone(waiting["turns"][0]["reply"])
                self.assertEqual(self.backend.request(path + "/replace", replacement_body), (
                    409, {"error": "assistant_session_rejected", "reason": "generation_not_running"},
                ))
                self.assertEqual(len(self.model.seen_calls), 1)
            finally:
                self.model.release_first_response.set()
                self.reply_store.release_after_save.set()
            status, completed = running.result(timeout=10)
            self.assertEqual(status, 200, completed)
        self.assertEqual(self.backend.request(path + "/replace", replacement_body), (
            409, {"error": "assistant_session_rejected", "reason": "generation_not_running"},
        ))
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(saved["turns"][0]["state"], "completed")
        self.assertEqual(saved["turns"][0]["reply"]["reply_request_id"], completed["reply_request_id"])
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_invalid_replacement_bodies_leave_the_waiting_request_valid(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成等待草稿", instruction="合成等待要求")
        new_body = self._body(draft="合成替换草稿", instruction="合成替换要求")
        good = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
        malformed = (
            {}, {"replacement": new_body}, {**good, "extra": True},
            {**good, "running_request_key": 1}, {**good, "running_request_key": "not-a-uuid"},
            {**good, "replacement": []},
            {**good, "replacement": {**new_body, "idempotency_key": old_body["idempotency_key"]}},
            {**good, "replacement": {**new_body, "contact_id": str(uuid4())}},
            {**good, "replacement": {**new_body, "content": {"type": "unsupported"}}},
            {**good, "replacement": {**new_body, "expected_input_version_id": "not-a-uuid"}},
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                for index, body in enumerate(malformed):
                    with self.subTest(index=index):
                        self.assertEqual(self.backend.request(path + "/replace", body), (
                            400, {"error": "assistant_session_request_invalid"},
                        ))
                status, pending = self.backend.request(path)
                self.assertEqual(status, 200, pending)
                self.assertEqual(len(pending["turns"]), 1)
                self.assertEqual(pending["turns"][0]["state"], "running")
            finally:
                self.model.release_first_response.set()
            status, completed = running.result(timeout=10)
        self.assertEqual(status, 200, completed)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_other_owner_contact_session_and_unknown_old_key_cannot_replace_the_waiting_request(self) -> None:
        path = self._session_path()
        session_id = UUID(path.rsplit("/", 1)[1])
        other_contact, other_session = uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, '同名合成 HTTP 联系人')", (self.owner_id, other_contact),
            )
            connection.execute(
                "INSERT INTO public.assistant_session (id, owner_id, contact_id, is_default) "
                "VALUES (%s, %s, %s, false)", (other_session, self.owner_id, self.contact_id),
            )
        other_owner_id = uuid4()
        other_owner_backend = HttpBackend(create_app(
            database_url=DATABASE_URL, owner_id=other_owner_id, token="synthetic-foreign-replacement-token",
            reply_service=self.reply_service,
        ), other_owner_id)
        self.addCleanup(other_owner_backend.close)
        old_body = self._body(draft="合成范围草稿", instruction="合成范围要求")
        new_body = self._body(draft="合成替换草稿", instruction="合成替换要求")
        replacement = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
        other_path = f"/api/contacts/{self.contact_id}/assistant-sessions/{other_session}"
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                requests = (
                    (other_owner_backend, path, replacement),
                    (self.backend, f"/api/contacts/{other_contact}/assistant-sessions/{session_id}", {
                        **replacement, "replacement": {**new_body, "contact_id": str(other_contact)},
                    }),
                    (self.backend, other_path, replacement),
                    (self.backend, path, {**replacement, "running_request_key": str(uuid4())}),
                )
                for index, (backend, target, body) in enumerate(requests):
                    with self.subTest(index=index):
                        self.assertEqual(backend.request(target + "/replace", body), (404, {"error": "not_found"}))
                status, empty = self.backend.request(other_path)
                self.assertEqual(status, 200, empty)
                self.assertEqual(empty["turns"], [])
                self.assertIsNone(empty["current_input_version_id"])
            finally:
                self.model.release_first_response.set()
            status, completed = running.result(timeout=10)
        self.assertEqual(status, 200, completed)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_changed_current_input_rejects_replacement_without_appending_or_rewinding_input(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成旧草稿", instruction="合成旧要求")
        new_body = self._body(draft="合成替换草稿", instruction="合成替换要求")
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                status, current = self.backend.request(path + "/inputs", {
                    "content": {"type": "purpose_exploration", "purpose_hint": "合成新讨论已经生效"},
                })
                self.assertEqual(status, 200, current)
                self.assertEqual(self.backend.request(path + "/replace", {
                    "running_request_key": old_body["idempotency_key"], "replacement": new_body,
                }), (409, {"error": "assistant_session_rejected", "reason": "input_version_stale"}))
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], current["input_version_id"])
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(len(saved["inputs"]), 2)
        self.assertEqual(saved["inputs"][1]["content"]["purpose_hint"], "合成新讨论已经生效")
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_session_deleted_while_waiting_cannot_be_replaced_or_restored_by_late_response(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成删除草稿", instruction="合成删除要求")
        new_body = self._body(draft="合成替换草稿", instruction="合成替换要求")
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
                self.assertEqual(self.backend.request(path + "/replace", {
                    "running_request_key": old_body["idempotency_key"], "replacement": new_body,
                }), (404, {"error": "not_found"}))
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))
        new_path = self._session_path()
        self.assertNotEqual(new_path, path)
        self.assertEqual(self.backend.request(new_path)[1]["turns"], [])
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_replacement_keeps_valid_discussion_and_old_user_requirements_in_the_measured_model_input(self) -> None:
        path = self._session_path()
        discussion_marker = "合成先前讨论：保持含义明确"
        old_requirement = "合成旧兼容要求：保持措辞平静"
        status, discussion = self.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": discussion_marker},
        })
        self.assertEqual(status, 200, discussion)
        old_body = self._body(draft="合成原草稿", instruction=old_requirement)
        new_body = self._body(draft="合成原草稿", instruction="合成新要求：更简洁")
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                status, replacement = self.backend.request(path + "/replace", {
                    "running_request_key": old_body["idempotency_key"], "replacement": new_body,
                })
                self.assertEqual(status, 200, replacement)
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        old_turn = next(turn for turn in saved["turns"] if turn["request_key"] == old_body["idempotency_key"])
        self.assertEqual(old_turn["input"]["content"]["user_instruction"], old_requirement)
        self.assertEqual(old_turn["state"], "failed")
        model_payload = json.dumps(self.model.seen_model_payloads[1], ensure_ascii=False)
        measured_payload = json.dumps(self.input_counter.seen_payloads[-1], ensure_ascii=False)
        self.assertTrue(discussion_marker in model_payload, "有效先前讨论必须进入实际新模型输入。")
        self.assertTrue(discussion_marker in measured_payload, "有效先前讨论必须进入总预算计量。")
        self.assertTrue(old_requirement in model_payload, "取消后有效旧用户要求必须进入实际新模型输入。")
        self.assertTrue(old_requirement in measured_payload, "取消后有效旧用户要求必须进入总预算计量。")
        self.assertEqual(len(self.model.seen_calls), 2)

    def test_failed_replacement_retries_the_same_new_key_without_reviving_the_old_lease(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成原草稿", instruction="合成被替换要求")
        new_body = self._body(draft="合成新草稿", instruction="合成新要求需要失败后重试")
        replacement_body = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
        old_key, new_key = UUID(old_body["idempotency_key"]), UUID(new_body["idempotency_key"])
        self.model.fail_response(1)
        self.model.responses.append(self._candidate("合成同键重试成功候选"))
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                old_lease, old_context = self.reply_store.prepared_contexts[old_key]
                self.assertEqual(self.backend.request(path + "/replace", replacement_body), (
                    500, {"error": "reply_generation_failed"},
                ))
                self.assertEqual(len(self.model.seen_calls), 2)
                status, failed = self.backend.request(path)
                self.assertEqual(status, 200, failed)
                failed_turns = {turn["request_key"]: turn for turn in failed["turns"]}
                self.assertEqual(len(failed_turns), 2)
                self.assertEqual(failed_turns[new_body["idempotency_key"]]["state"], "failed")
                self.assertIsNone(failed_turns[new_body["idempotency_key"]]["reply"])
                expected = failed_turns[new_body["idempotency_key"]]["input_version_id"]
                self.assertEqual(failed["current_input_version_id"], expected)
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)

        verified = VerifiedConversationScope(self.owner_id, self.contact_id, self.binding.binding_id)
        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.start(old_context.command, verified)
        status, generated = self.backend.request(path + "/replace", replacement_body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["input_version_id"], expected)
        self.assertEqual(generated["candidates"][0]["text"], "合成同键重试成功候选")
        self.assertEqual(self.backend.request(path + "/replace", replacement_body), (200, generated))
        self.assertNotEqual(self.backend.request(path + "/replies", old_body)[0], 200)
        retry_lease, _, actual_reply = self.reply_store.successful_saves[new_key]
        self.assertEqual(retry_lease.attempt, 2)
        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.start(old_context.command, verified)
        with self.assertRaises(ReplyStoreInvariantError):
            self.reply_store.save(old_lease, old_context, actual_reply)
        old_stored = self.reply_store.read(old_lease.request_id, old_lease.scope)
        self.assertIsNone(old_stored.result)
        self.assertEqual(old_stored.attempts[0].failure_reason, "generation_replaced")
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], expected)
        self.assertEqual(len(saved["inputs"]), len(failed["inputs"]))
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[old_body["idempotency_key"]]["state"], "failed")
        self.assertIsNone(turns[old_body["idempotency_key"]]["reply"])
        self.assertEqual(turns[new_body["idempotency_key"]]["turn_id"],
                         failed_turns[new_body["idempotency_key"]]["turn_id"])
        self.assertEqual(turns[new_body["idempotency_key"]]["reply"]["candidates"], generated["candidates"])
        with psycopg.connect(DATABASE_URL) as connection:
            count = connection.execute(
                "SELECT count(*) FROM public.reply_candidate WHERE owner_id = %s AND contact_id = %s "
                "AND reply_request_id = %s",
                (self.owner_id, self.contact_id, retry_lease.request_id),
            ).fetchone()[0]
        self.assertEqual(count, 1)
        self.assertEqual(len(self.model.seen_calls), 3)

    def test_replacement_cumulative_budget_blocks_the_model_and_a_new_session_can_generate(self) -> None:
        path = self._session_path()
        discussion_marker = "合成完整旧讨论：" + "保留所有兼容要求。" * 80
        old_requirement = "合成旧 USER 要求：保持平静，不能丢失。"
        new_requirement = "合成预算失败 NEW USER 要求：表达更简洁。"
        status, discussion = self.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": discussion_marker},
        })
        self.assertEqual(status, 200, discussion)
        old_body = self._body(draft="合成旧原句：" + "今晚不参加，感谢邀请。" * 70,
                              instruction=old_requirement)
        old_body["expected_input_version_id"] = discussion["input_version_id"]
        new_body = self._body(draft="合成简短新原句。", instruction=new_requirement)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                capacity = 13000
                limited, counter = self._budget_backend(capacity)
                calls_before = len(self.model.seen_calls)
                status, blocked = limited.request(path + "/replace", {
                    "running_request_key": old_body["idempotency_key"], "replacement": new_body,
                })
                self.assertEqual(status, 409, blocked)
                self.assertEqual(blocked["error"], "input_budget_exceeded")
                self.assertEqual(blocked["input_budget"], self.budget_decisions[-1].to_payload())
                self.assertGreater(blocked["input_budget"]["total_tokens"], capacity)
                self.assertEqual(len(self.model.seen_calls), calls_before)
                measured = json.dumps(counter.seen_payloads[-1], ensure_ascii=False)
                self.assertIn(discussion_marker, measured)
                self.assertIn(old_requirement, measured)
                self.assertIn(new_requirement, measured)
                status, failed = limited.request(path)
                self.assertEqual(status, 200, failed)
                self.assertEqual(failed["inputs"][0]["content"]["purpose_hint"], discussion_marker)
                turns = {turn["request_key"]: turn for turn in failed["turns"]}
                self.assertEqual(turns[old_body["idempotency_key"]]["state"], "failed")
                self.assertEqual(turns[old_body["idempotency_key"]]["input"]["content"]["user_instruction"],
                                 old_requirement)
                failed_new = turns[new_body["idempotency_key"]]
                self.assertEqual(failed_new["state"], "failed")
                self.assertEqual(failed_new["input"]["content"]["user_instruction"], new_requirement)
                self.assertIsNone(failed_new["reply"])
                self.assertEqual(failed["current_input_version_id"], failed_new["input_version_id"])
                self.assertTrue(all(turn["reply"] is None for turn in failed["turns"]))
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        with psycopg.connect(DATABASE_URL) as connection:
            count = connection.execute(
                "SELECT count(*) FROM public.reply_candidate AS candidate JOIN public.reply_request AS request "
                "ON candidate.reply_request_id = request.id WHERE request.owner_id = %s "
                "AND request.contact_id = %s AND request.idempotency_key = %s",
                (self.owner_id, self.contact_id, UUID(new_body["idempotency_key"])),
            ).fetchone()[0]
        self.assertEqual(count, 0)
        status, session = limited.request(f"/api/contacts/{self.contact_id}/assistant-sessions", {})
        self.assertEqual(status, 200, session)
        new_path = f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"
        self.assertNotEqual(new_path, path)
        recovery_body = {**new_body, "idempotency_key": str(uuid4())}
        status, generated = limited.request(new_path + "/replies", recovery_body)
        self.assertEqual(status, 200, generated)
        self.assertLessEqual(generated["input_budget"]["total_tokens"], capacity)
        self.assertEqual(len(self.model.seen_calls), calls_before + 1)
        status, old_history = limited.request(path)
        self.assertEqual(status, 200, old_history)
        self.assertEqual(old_history["current_input_version_id"], failed_new["input_version_id"])
        self.assertEqual(old_history["turns"], failed["turns"])
