"""生成准备凭证经真实 HTTP 与正式迁移的隔离 PostgreSQL 验证。"""

from __future__ import annotations

import json
import os
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field, PrivateAttr

from notalone.application.assistant_session_service import AssistantSessionService
from notalone.application.memory_service import MemoryService
from notalone.application.skill_service import LedgerService
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.fidelity_http_support import FidelityControlledModel
from tests.input_budget_support import SyntheticBudgetModel, synthetic_budget_kwargs
from tests.reply_review_support import synthetic_review
from tests.integration.server.core_business_flow_support import HttpBackend, tool_response
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
RECEIPT_KEYS = {"session_id", "turn_id", "request_key", "input_version_id", "state"}


class LatePreparedModel(SyntheticBudgetModel):
    """旧供应商响应可在替换后返回；两次生成分别取脚本，复核独立计量。"""

    seen_calls: list[list[BaseMessage]] = Field(default_factory=list)
    response_entered: object = None
    review_calls: int = 0
    release_first_response: object = None
    second_response_entered: object = None
    release_second_response: object = None
    _call_lock: Any = PrivateAttr(default_factory=threading.Lock)
    _generation_calls: int = PrivateAttr(default=0)

    def __init__(self) -> None:
        super().__init__(responses=[])
        self.response_entered = threading.Event()
        self.release_first_response = threading.Event()
        self.second_response_entered = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(message.content) for message in messages if isinstance(message, HumanMessage))
        review = [tool.get('function', {}).get('name') for tool in kwargs.get('tools', [])] == ['ReplyFidelityReview']
        with self._call_lock:
            index = self._generation_calls
            if review:
                if self.review_calls >= self._generation_calls:
                    raise AssertionError('复核不能多于实际生成调用。')
                self.review_calls += 1
            else:
                if index >= 2:
                    raise AssertionError("合成迟到脚本已耗尽，禁止额外生成调用。")
                self._generation_calls += 1
            self.seen_calls.append(messages)
            self.record_model_payload(messages, kwargs)
        if review:
            return ChatResult(generations=[ChatGeneration(message=tool_response(
                'ReplyFidelityReview', synthetic_review(payload)))])
        if index == 0:
            self.response_entered.set()
            if not self.release_first_response.wait(20):
                raise TimeoutError("合成旧供应商响应未在有限时间内释放。")
        if index == 1 and self.release_second_response is not None:
            self.second_response_entered.set()
            if not self.release_second_response.wait(20):
                raise TimeoutError('合成新attempt响应未在有限时间内释放。')
        primary = next(item for item in payload["evidence"] if item["kind"] == "user_draft")
        response = tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": "合成迟到旧候选" if index == 0 else "合成有效新候选",
                            "basis": "保留本轮合成草稿原意。", "citation_ids": [primary["evidence_id"]],
                            "risk_notes": []}], "used_skill_version_id": None,
        })
        return ChatResult(generations=[ChatGeneration(message=response)])


def assert_generation_review_calls(test, model, *, generation: int, review: int) -> None:
    """总调用包含实际生成与复核，并核对每次绑定的供应商工具。"""
    test.assertEqual(len(model.seen_calls), generation + review)
    test.assertEqual(len(model.seen_model_payloads), generation + review)
    tools = [[tool.get('function', {}).get('name') for tool in payload.get('tools', [])]
             for payload in model.seen_model_payloads]
    test.assertEqual(sum('ReplyRuntimeOutput' in names for names in tools), generation)
    test.assertEqual(tools.count(['ReplyFidelityReview']), review)


class AssistantCompletionBarrierStore(PostgresAssistantSessionStore):
    """仅暂停实际 A complete 调用；C 已真实保存，释放后仍走唯一完成 writer。"""

    def __init__(self, database_url: str) -> None:
        super().__init__(database_url)
        self.entered = threading.Event()
        self.release = threading.Event()

    def complete(self, scope, session_id, turn_id, reply):
        self.entered.set()
        if not self.release.wait(20):
            raise TimeoutError("实际助手完成写入未在有限时段内释放。")
        return super().complete(scope, session_id, turn_id, reply)


class AssistantGenerationPrepareHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定本票隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            database_name = connection.execute("SELECT current_database()").fetchone()[0]
        if not database_name.endswith("_test"):
            raise RuntimeError("准备 HTTP 验收只允许隔离 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id, self.other_owner_id, self.contact_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            for owner_id in (self.owner_id, self.other_owner_id):
                connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '合成准备用户')",
                                   (owner_id,))
            connection.execute("INSERT INTO public.contact (owner_id, id, display_name) "
                               "VALUES (%s, %s, '合成准备联系人')", (self.owner_id, self.contact_id))
        self.addCleanup(self._clean_owner)
        self.bindings = PostgresConversationBindingRepository(DATABASE_URL)
        self.binding = self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-http-prepare", conversation_locator=f"synthetic-{uuid4()}",
        )
        self.model = FidelityControlledModel()
        self.backend = self._backend()

    def _clean_owner(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id = ANY(%s::uuid[])",
                               ([self.owner_id, self.other_owner_id],))

    def _backend(
        self, *, capacity: int = 100000, output_reserve: int = 4096, owner_id: UUID | None = None,
        completion_barrier: AssistantCompletionBarrierStore | None = None,
    ) -> HttpBackend:
        current_owner = owner_id or self.owner_id
        # 仅替换外部模型边界，保留正式回复、探索、预算与存储装配。
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.model):
            reply_service = build_reply_service(
                database_url=DATABASE_URL, owner_id=current_owner,
                **synthetic_budget_kwargs(self.model, capacity=capacity, output_reserve=output_reserve),
            )
        backend = HttpBackend(create_app(
            database_url=DATABASE_URL, owner_id=current_owner,
            token="synthetic-assistant-prepare-token", reply_service=reply_service,
            memory_service=MemoryService(contact_memory=PostgresMemoryStore(DATABASE_URL),
                                         owner_memory=PostgresOwnerMemoryStore(DATABASE_URL)),
            ledger_service=LedgerService(ledger=PostgresOutboundLedger(DATABASE_URL)),
            assistant_sessions=(AssistantSessionService(
                store=completion_barrier, reply=reply_service,
                catalog=PostgresAssistantSessionCatalog(DATABASE_URL),
            ) if completion_barrier is not None else None),
        ), current_owner)
        self.addCleanup(backend.close)
        return backend

    def _session_path(self) -> str:
        status, session = self.backend.request(
            f"/api/contacts/{self.contact_id}/assistant-session/default", {}, method="POST",
        )
        self.assertEqual(status, 200, session)
        return f"/api/contacts/{self.contact_id}/assistant-sessions/{session['session_id']}"

    def _body(self, *, draft: str = "合成可恢复草稿") -> dict:
        return {
            "contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": draft,
                        "user_instruction": "合成准备要求"},
        }

    def _generation_metadata(self, body: dict) -> tuple[dict, dict]:
        """只读实际 A/C 身份与行版本，证明领取回放没有另写执行状态。"""

        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            scope = (self.owner_id, self.contact_id, UUID(body["idempotency_key"]))
            turn = connection.execute(
                "SELECT id, input_version_id, reply_request_id, state, xmin::text AS row_version "
                "FROM public.assistant_session_turn WHERE owner_id = %s AND contact_id = %s "
                "AND idempotency_key = %s", scope,
            ).fetchone()
            request = connection.execute(
                "SELECT id, state, attempt, xmin::text AS row_version FROM public.reply_request "
                "WHERE owner_id = %s AND contact_id = %s AND idempotency_key = %s", scope,
            ).fetchone()
        self.assertIsNotNone(turn)
        self.assertIsNotNone(request)
        return turn, request

    def test_prepare_returns_only_actual_metadata_and_restores_without_a_model(self) -> None:
        path = self._session_path()
        body = self._body()

        status, receipt = self.backend.request(path + "/replies/prepare", body)

        self.assertEqual(status, 200, receipt)
        self.assertEqual(set(receipt), RECEIPT_KEYS)
        self.assertEqual(receipt["session_id"], path.rsplit("/", 1)[1])
        self.assertEqual(receipt["request_key"], body["idempotency_key"])
        self.assertEqual(receipt["state"], "running")
        for key in ("session_id", "turn_id", "request_key", "input_version_id"):
            UUID(receipt[key])
        reopened = self._backend()
        read_status, saved = reopened.request(path)
        self.assertEqual(read_status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], receipt["input_version_id"])
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(saved["turns"][0]["turn_id"], receipt["turn_id"])
        self.assertEqual(saved["turns"][0]["state"], "running")
        self.assertEqual(saved["turns"][0]["input"]["content"]["draft_text"], "合成可恢复草稿")
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(self.model.seen_calls, [])
        ledger_status, ledger = reopened.request("/api/ledger/summary")
        self.assertEqual(ledger_status, 200, ledger)
        self.assertEqual(ledger["total_calls"], 0)

    def _old_prepared_format(self, body: dict, *, revision: object = None) -> None:
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            from psycopg.types.json import Jsonb
            row = connection.execute(
                "SELECT id,prepared_context FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                (self.owner_id, self.contact_id, UUID(body["idempotency_key"])),
            ).fetchone()
            payload = row["prepared_context"]
            if revision is None:
                payload["version"] = 1
                payload.pop("schema_revision", None)
            else:
                payload["schema_revision"] = revision
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context=%s WHERE id=%s",
                               (Jsonb(payload), row["id"]))

    def test_v2_prepare_restart_executes_frozen_current_status_without_refetching(self) -> None:
        status, memory = self.backend.request("/api/memories/manual-contact", {
            "contact_id": str(self.contact_id), "text": "合成加班：最近在加班。", "category": "recent_state",
        })
        self.assertEqual(status, 200, memory)
        path, body = self._session_path(), self._body(draft="合成加班，最近还忙吗？")
        body["content"]["include_relationship_context"] = True
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(self.model.seen_calls, [])
        self.model.plans.append({"text": "最近还忙吗？", "basis": "只询问近况，不把过去当作现在。"})

        status, generated = self._backend().request(path + "/replies", body)

        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], receipt["turn_id"])
        memories = [item for item in self.model.payloads[-1]["evidence"] if item["kind"] == "confirmed_memory"]
        self.assertEqual(len(memories), 1)
        self.assertEqual(memories[0]["timing"]["current_status"], "current_unverified")
        self.assertIn("不能证明状态现在仍成立", memories[0]["timing"]["current_status_reason"])

    def test_old_preparation_without_c_is_sealed_and_requires_explicit_reprepare(self) -> None:
        path, body = self._session_path(), self._body()
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self._old_prepared_format(body)

        status, rejected = self._backend().request(path + "/replies/prepare", body)

        self.assertEqual((status, rejected), (409, {"error": "assistant_session_rejected",
            "reason": "prepared_context_reprepare_required"}))
        saved = self.backend.request(path)[1]
        turn = saved["turns"][0]
        self.assertEqual((turn["turn_id"], turn["input_version_id"], turn["request_key"]),
                         (receipt["turn_id"], receipt["input_version_id"], receipt["request_key"]))
        self.assertEqual(turn["input"]["content"]["draft_text"], "合成可恢复草稿")
        self.assertEqual((turn["state"], turn["generation_active"], turn["requires_reprepare"]),
                         ("failed", False, True))
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 409)
        self.assertEqual(len(self.backend.request(path)[1]["turns"]), 1)
        self.assertEqual(self.model.seen_calls, [])

    def test_explicit_format_check_returns_original_identity_without_generating(self) -> None:
        path, body = self._session_path(), self._body()
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self._old_prepared_format(body)
        identity = {"request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"]}

        status, checked = self.backend.request(path + "/preparation-format", identity)

        self.assertEqual((status, checked), (200, {**receipt, "state": "failed",
                                                 "format_status": "reprepare_required"}))
        self.assertEqual(self.backend.request(path + "/preparation-format", identity), (status, checked))
        self.assertEqual(self.model.seen_calls, [])
        edited = self._body(draft="合成保留用户修改后的草稿")
        self.assertEqual(self.backend.request(path + "/replies/prepare", edited)[0], 200)
        self.assertEqual(self.model.seen_calls, [])

    def test_old_format_running_generation_keeps_its_lease_until_original_completion(self) -> None:
        path, body = self._session_path(), self._body()
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self.model.plans.append({"text": "合成原任务候选", "basis": "保留合成草稿原意。"})
        release = self.model.pause_next_response()
        self.addCleanup(release.set)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.entered.wait(5))
                self._old_prepared_format(body)
                before = self._generation_metadata(body)
                self.assertEqual(self.backend.request(path + "/replies/prepare", body), (409,
                    {"error": "assistant_session_rejected", "reason": "prepared_context_generation_running"}))
                self.assertEqual(self.backend.request(path + "/preparation-format", {
                    "request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"]}),
                    (200, {**receipt, "format_status": "generation_running"}))
                self.assertEqual(self._generation_metadata(body), before)
                self.assertEqual(self.backend.request(path)[1]["turns"][0]["generation_active"], True)
            finally:
                release.set()
            self.assertEqual(running.result(timeout=10)[0], 200)
        assert_generation_review_calls(self, self.model, generation=1, review=0)
        self.assertEqual(self.backend.request(path + "/replies/prepare", body),
                         (200, {**receipt, "state": "completed"}))

    def test_old_format_failed_c_seals_original_key_without_another_attempt(self) -> None:
        path, body = self._session_path(), self._body()
        self.assertEqual(self.backend.request(path + "/replies/prepare", body)[0], 200)
        limited = self._backend(capacity=1000, output_reserve=100)
        self.assertEqual(limited.request(path + "/replies", body)[0], 409)
        self._old_prepared_format(body, revision=0)
        before = self._generation_metadata(body)

        self.assertEqual(self.backend.request(path + "/replies/prepare", body),
                         (409, {"error": "assistant_session_rejected", "reason": "prepared_context_reprepare_required"}))

        self.assertEqual(self._generation_metadata(body)[1], before[1])
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 409)
        self.assertEqual(self._generation_metadata(body)[1]["attempt"], 1)
        self.assertEqual(self.model.seen_calls, [])

    def test_old_format_unknown_terminal_is_retained_without_sealing_or_releasing(self) -> None:
        path, body = self._session_path(), self._body()
        self.assertEqual(self.backend.request(path + "/replies/prepare", body)[0], 200)
        limited = self._backend(capacity=1000, output_reserve=100)
        self.assertEqual(limited.request(path + "/replies", body)[0], 409)
        self._old_prepared_format(body)
        before = self._generation_metadata(body)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.reply_attempt WHERE reply_request_id=%s", (before[1]["id"],))

        self.assertEqual(self.backend.request(path + "/replies/prepare", body),
                         (409, {"error": "assistant_session_rejected", "reason": "prepared_context_generation_unconfirmed"}))

        self.assertEqual(self._generation_metadata(body), before)
        turn = self.backend.request(path)[1]["turns"][0]
        self.assertNotIn("generation_active", turn)
        self.assertEqual(turn["requires_reprepare"], True)
        self.assertEqual(self.model.seen_calls, [])

    def test_old_format_reliably_expired_c_is_sealed_without_retrying_the_attempt(self) -> None:
        clock = {"now": datetime.now(timezone.utc)}
        with patch("notalone.server.reply_wiring.PostgresReplyStore", side_effect=lambda url, **kwargs:
                   PostgresReplyStore(url, clock=lambda: clock["now"], **kwargs)):
            self.backend = self._backend()
        path, body = self._session_path(), self._body(draft="合成过期任务原编辑")
        status, receipt = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, receipt)
        self.model.plans.append({"text": "合成过期晚返回", "basis": "保留原输入。"})
        release = self.model.pause_next_response()
        self.addCleanup(release.set)
        with ThreadPoolExecutor(max_workers=1) as pool:
            late = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.entered.wait(5))
                clock["now"] += timedelta(seconds=31)
            finally:
                release.set()
            self.assertNotEqual(late.result(timeout=10)[0], 200)
        # 状态来自真实生成的过期处理，仅替换时钟；没有直接改写 request/attempt 状态。
        before = self._generation_metadata(body)
        self.assertEqual(before[1]["state"], "expired")
        self._old_prepared_format(body)
        identity = {"request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"]}

        self.assertEqual(self.backend.request(path + "/preparation-format", identity),
            (200, {**receipt, "state": "failed", "format_status": "reprepare_required"}))

        self.assertEqual(self._generation_metadata(body)[1], before[1])
        saved = self.backend.request(path)[1]
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(saved["turns"][0]["input"]["content"]["draft_text"], "合成过期任务原编辑")
        self.assertEqual(saved["turns"][0]["generation_active"], False)
        self.assertEqual(self.backend.request(path + "/replies", body)[0], 409)
        self.assertEqual(self._generation_metadata(body)[1]["attempt"], 1)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_old_running_format_can_only_reprepare_after_confirmed_interruption(self) -> None:
        path, body = self._session_path(), self._body()
        receipt = self.backend.request(path + "/replies/prepare", body)[1]
        self.model.plans.append({"text": "合成旧任务晚返回", "basis": "保留原输入。"})
        release = self.model.pause_next_response()
        self.addCleanup(release.set)
        identity = {"request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"]}
        with ThreadPoolExecutor(max_workers=1) as pool:
            late = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.entered.wait(5))
                self._old_prepared_format(body)
                self.assertEqual(self.backend.request(path + "/interrupt", identity),
                    (200, {**receipt, "state": "failed", "interruption_reason": "app_quit"}))
                self.assertEqual(self.backend.request(path + "/preparation-format", identity),
                    (200, {**receipt, "state": "failed", "format_status": "reprepare_required"}))
            finally:
                release.set()
            self.assertNotEqual(late.result(timeout=10)[0], 200)
        old = self.backend.request(path)[1]["turns"][0]
        self.assertIsNone(old["reply"])
        self.assertEqual(old["generation_active"], False)
        self.assertEqual(old["input"]["content"]["draft_text"], body["content"]["draft_text"])
        fresh = self._body(draft="合成明确新准备")
        self.assertEqual(self.backend.request(path + "/replies/prepare", fresh)[0], 200)
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_same_key_replays_actual_completed_state_and_generates_only_once(self) -> None:
        path = self._session_path()
        body = self._body()
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, prepared))
        self.assertEqual(self.model.seen_calls, [])
        self.model.plans.append({"text": "合成一次生成候选", "basis": "保留合成草稿原意。"})

        status, generated = self.backend.request(path + "/replies", body)

        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["input_version_id"], prepared["input_version_id"])
        self.assertEqual(generated["turn_id"], prepared["turn_id"])
        completed_receipt = {**prepared, "state": "completed"}
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, completed_receipt))
        next_body = self._body(draft="合成后继草稿")
        status, next_receipt = self.backend.request(path + "/replies/prepare", next_body)
        self.assertEqual(status, 200, next_receipt)
        self.assertEqual(next_receipt["state"], "running")
        self.assertNotEqual(next_receipt["input_version_id"], prepared["input_version_id"])
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, completed_receipt))
        changed = {**body, "content": {**body["content"], "draft_text": "合成同键不同草稿"}}
        self.assertEqual(self.backend.request(path + "/replies/prepare", changed), (
            409, {"error": "assistant_session_input_conflict"},
        ))
        self.assertEqual(self.backend.request(path)[1]["current_input_version_id"], next_receipt["input_version_id"])
        self.assertEqual(self.backend.request(path + "/replies", body), (200, generated))
        assert_generation_review_calls(self, self.model, generation=1, review=0)

    def test_invalidated_old_key_cannot_prepare_or_generate_but_explicit_fresh_retry_can(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成失效旧输入")
        status, old_receipt = self.backend.request(path + "/replies/prepare", old_body)
        self.assertEqual(status, 200, old_receipt)
        new_body = self._body(draft="合成明确替换新输入")
        status, new_receipt = self.backend.request(path + "/replace/prepare", {
            "running_request_key": old_body["idempotency_key"], "replacement": new_body,
        })
        self.assertEqual(status, 200, new_receipt)

        self.assertEqual(self.backend.request(path + "/replies/prepare", old_body), (
            409, {"error": "assistant_session_rejected", "reason": "request_deleted"},
        ))
        self.assertEqual(self.backend.request(path + "/replies", old_body), (
            409, {"error": "assistant_session_rejected", "reason": "request_deleted"},
        ))
        self.assertEqual(self.backend.request(path)[1]["current_input_version_id"], new_receipt["input_version_id"])
        retry_body = {**old_body, "idempotency_key": str(uuid4())}
        status, retry = self.backend.request(path + "/replies/prepare", retry_body)
        self.assertEqual(status, 200, retry)
        self.assertEqual(retry["state"], "running")
        self.assertNotEqual(retry["request_key"], old_receipt["request_key"])
        self.assertNotEqual(retry["input_version_id"], old_receipt["input_version_id"])
        self.assertEqual(self.model.seen_calls, [])
        self.model.plans.append({"text": "合成用户明确新键重试候选", "basis": "保留合成重试草稿原意。"})
        status, generated = self.backend.request(path + "/replies", retry_body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], retry["turn_id"])
        assert_generation_review_calls(self, self.model, generation=1, review=0)
        self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 1)

    def test_real_exploration_confirmation_and_prepare_share_canonical_input_without_extra_model_calls(self) -> None:
        self.model = ExplorationControlledModel()
        self.backend = self._backend()
        path = self._session_path()
        self.model.plans.append({"explore": {}})
        status, explored = self.backend.request(path + "/explorations", {
            "operation_key": str(uuid4()), "content": {"type": "purpose_exploration",
            "purpose_hint": "合成探索：了解近况但没有安排见面。", "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200, explored)
        self.assertEqual(explored["kind"], "directions")
        confirmation = {"generate": True, "input_version_id": explored["input_version_id"],
                        "suggestion_id": explored["options"][0]["suggestion_id"]}
        self.model.plans.append({"text": "合成近况询问候选", "basis": "只表达本次已确认意愿。"})
        self.model.entered.clear()
        release = self.model.pause_next_response()
        self.addCleanup(release.set)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request,
                path + f"/explorations/{explored['exploration_id']}/confirm", confirmation)
            try:
                self.assertTrue(self.model.entered.wait(5), "真实 B 确认应沿原生成链抵达模型边界。")
                saved = self.backend.request(path)[1]
                self.assertEqual(len(saved["turns"]), 1)
                turn = saved["turns"][0]
                content = dict(turn["input"]["content"])
                reference = content.pop("suggestion")
                body = {**turn["input"], "content": content, "suggestion": reference,
                        "contact_id": str(self.contact_id), "idempotency_key": turn["request_key"],
                        "expected_input_version_id": explored["input_version_id"]}
                status, prepared = self.backend.request(path + "/replies/prepare", body)
                self.assertEqual(status, 200, prepared)
                self.assertEqual(set(prepared), RECEIPT_KEYS)
                self.assertEqual(prepared["turn_id"], turn["turn_id"])
                self.assertEqual(prepared["input_version_id"], turn["input_version_id"])
                self.assertEqual(prepared["state"], "running")
                self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, prepared))
                conflicting = {**body, "content": {**content, "user_instruction": "合成不同的本次要求"}}
                self.assertEqual(self.backend.request(path + "/replies/prepare", conflicting), (
                    409, {"error": "assistant_session_input_conflict"},
                ))
                self.assertEqual(len(self.model.payloads), 1)
                self.assertEqual(self.backend.request(path)[1]["current_input_version_id"], turn["input_version_id"])
            finally:
                release.set()
            status, completed = running.result(timeout=10)
        self.assertEqual(status, 200, completed)
        self.assertEqual(completed["kind"], "generated")
        self.assertEqual(completed["turn"]["turn_id"], prepared["turn_id"])
        self.assertEqual(self._backend().request(path + "/replies/prepare", body), (
            200, {**prepared, "state": "completed"},
        ))
        self.assertEqual(len(self.model.payloads), 2)
        self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 2)

    def test_replace_prepare_invalidates_the_old_input_without_a_model_and_new_key_generates_once(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成原输入草稿")
        status, old_receipt = self.backend.request(path + "/replies/prepare", old_body)
        self.assertEqual(status, 200, old_receipt)
        new_body = self._body(draft="合成明确替换后的草稿")
        replacement = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}

        status, prepared = self.backend.request(path + "/replace/prepare", replacement)

        self.assertEqual(status, 200, prepared)
        self.assertEqual(set(prepared), RECEIPT_KEYS)
        self.assertEqual(prepared["state"], "running")
        self.assertEqual(prepared["session_id"], old_receipt["session_id"])
        self.assertEqual(prepared["request_key"], new_body["idempotency_key"])
        self.assertNotEqual(prepared["input_version_id"], old_receipt["input_version_id"])
        self.assertNotEqual(prepared["turn_id"], old_receipt["turn_id"])
        saved = self.backend.request(path)[1]
        self.assertEqual(saved["current_input_version_id"], prepared["input_version_id"])
        states = {turn["request_key"]: turn["state"] for turn in saved["turns"]}
        self.assertEqual(states, {old_body["idempotency_key"]: "failed", new_body["idempotency_key"]: "running"})
        self.assertEqual(self.backend.request(path + "/replace/prepare", replacement), (200, prepared))
        self.assertEqual(self.model.seen_calls, [])
        self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 0)
        self.model.plans.append({"text": "合成替换后唯一候选", "basis": "保留合成替换草稿原意。"})
        status, generated = self.backend.request(path + "/replies", new_body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], prepared["turn_id"])
        self.assertEqual(self.backend.request(path + "/replace/prepare", replacement), (
            200, {**prepared, "state": "completed"},
        ))
        self.assertEqual(self.backend.request(path + "/replies", new_body), (200, generated))
        assert_generation_review_calls(self, self.model, generation=1, review=0)

    def _unreserved_prepare_rejection(self, path, body, status, payload):
        key = body.get("replacement", body)["idempotency_key"]
        parts = path.strip("/").split("/")
        self.assertEqual(self.backend.request(path, body), (status, {**payload, "no_generation": {
            "contact_id": parts[2], "session_id": parts[4], "request_key": key, "state": "not_reserved",
        }}))

    def test_replace_prepare_strict_protocol_and_guard_failures_preserve_the_old_running_input(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成守卫旧输入")
        status, old_receipt = self.backend.request(path + "/replies/prepare", old_body)
        self.assertEqual(status, 200, old_receipt)
        new_body = self._body(draft="合成应被拒绝的新输入")
        replacement = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
        before = self.backend.request(path)[1]
        self.assertEqual(self.backend.request(path + "/replace/prepare", method="GET"), (
            405, {"error": "method_not_allowed"},
        ))
        invalid_cases = ({}, {**replacement, "extra": "unknown"},
                         {**replacement, "running_request_key": 7},
                         {**replacement, "replacement": {}},
                         {**replacement, "replacement": {**new_body, "contact_id": str(uuid4())}},
                         {**replacement, "replacement": old_body})
        for invalid in invalid_cases:
            with self.subTest(fields=set(invalid)):
                self.assertEqual(self.backend.request(path + "/replace/prepare", invalid), (
                    400, {"error": "assistant_session_request_invalid"},
                ))
        unavailable = {**new_body, "content": {"type": "reply_to_message",
                       "target_message_id": str(uuid4()), "direction": "合成明确回应。"}}
        self._unreserved_prepare_rejection(path + "/replace/prepare", {
            **replacement, "replacement": unavailable,
        }, 409, {"error": "assistant_session_rejected", "reason": "target_message_unavailable"})
        self._unreserved_prepare_rejection(path + "/replace/prepare", {
            **replacement, "replacement": {**new_body, "idempotency_key": str(uuid4()), "expected_input_version_id": str(uuid4())},
        }, 409, {"error": "assistant_session_input_conflict"})
        self._unreserved_prepare_rejection(path + "/replace/prepare", {
            **replacement, "running_request_key": str(uuid4()), "replacement": {**new_body, "idempotency_key": str(uuid4())},
        }, 404, {"error": "not_found"})
        self.assertEqual(self._backend(owner_id=self.other_owner_id).request(path + "/replace/prepare", replacement), (
            404, {"error": "not_found"},
        ))
        status, other_session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-sessions", {})
        self.assertEqual(status, 200, other_session)
        other_path = path.rsplit("/", 1)[0] + f"/{other_session['session_id']}"
        self._unreserved_prepare_rejection(other_path + "/replace/prepare",
            {**replacement, "replacement": {**new_body, "idempotency_key": str(uuid4())}}, 404, {"error": "not_found"})
        self.assertEqual(self.backend.request(other_path)[1]["turns"], [])
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(before["current_input_version_id"], old_receipt["input_version_id"])
        self.assertEqual(before["turns"][0]["state"], "running")
        self.assertEqual(self.model.seen_calls, [])

    def test_replace_prepare_failed_replay_keeps_its_state_without_rewinding_later_input(self) -> None:
        path = self._session_path()
        old_body, new_body = self._body(draft="合成预算替换旧稿"), self._body(draft="合成超限替换新稿")
        self.assertEqual(self.backend.request(path + "/replies/prepare", old_body)[0], 200)
        replacement = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
        status, prepared = self.backend.request(path + "/replace/prepare", replacement)
        self.assertEqual(status, 200, prepared)
        limited = self._backend(capacity=1000, output_reserve=100)

        status, rejected = limited.request(path + "/replies", new_body)

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        failed_receipt = {**prepared, "state": "failed"}
        self.assertEqual(limited.request(path + "/replace/prepare", replacement), (200, failed_receipt))
        next_body = self._body(draft="合成预算拒绝后的新输入")
        status, next_receipt = self.backend.request(path + "/replies/prepare", next_body)
        self.assertEqual(status, 200, next_receipt)
        self.assertEqual(self._backend().request(path + "/replace/prepare", replacement), (200, failed_receipt))
        changed = {**replacement, "replacement": {**new_body, "content": {
            **new_body["content"], "draft_text": "合成同键不同替换正文",
        }}}
        self.assertEqual(self.backend.request(path + "/replace/prepare", changed), (
            409, {"error": "assistant_session_input_conflict"},
        ))
        self.assertEqual(self.backend.request(path)[1]["current_input_version_id"], next_receipt["input_version_id"])
        self.assertEqual(self.model.seen_calls, [])
        ledger = self.backend.request("/api/ledger/summary")[1]
        self.assertEqual(ledger["total_calls"], 0)
        self.assertEqual(ledger["outcome_counts"], {})

    def test_completed_generation_wins_before_replace_prepare_without_new_input_or_extra_model(self) -> None:
        path = self._session_path()
        old_body = self._body(draft="合成已完成原稿")
        status, old_receipt = self.backend.request(path + "/replies/prepare", old_body)
        self.assertEqual(status, 200, old_receipt)
        self.model.plans.append({"text": "合成已可靠完成候选", "basis": "保留合成原稿原意。"})
        status, completed = self.backend.request(path + "/replies", old_body)
        self.assertEqual(status, 200, completed)
        before = self.backend.request(path)[1]

        self._unreserved_prepare_rejection(path + "/replace/prepare", {
            "running_request_key": old_body["idempotency_key"], "replacement": self._body(draft="合成过晚替换"),
        }, 409, {"error": "assistant_session_rejected", "reason": "generation_not_running"})

        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(self.backend.request(path + "/replies/prepare", old_body), (
            200, {**old_receipt, "state": "completed"},
        ))
        self.assertEqual(self.backend.request(path + "/replies", old_body), (200, completed))
        assert_generation_review_calls(self, self.model, generation=1, review=0)

    def test_replace_prepare_beats_the_late_old_model_result_in_public_saved_candidates(self) -> None:
        self.model = LatePreparedModel()
        self.backend = self._backend()
        self.addCleanup(self.model.release_first_response.set)
        path = self._session_path()
        old_body, new_body = self._body(draft="合成等待中旧稿"), self._body(draft="合成生效新稿")
        status, old_receipt = self.backend.request(path + "/replies/prepare", old_body)
        self.assertEqual(status, 200, old_receipt)
        with ThreadPoolExecutor(max_workers=1) as pool:
            old_running = pool.submit(self.backend.request, path + "/replies", old_body, timeout=30)
            try:
                self.assertTrue(self.model.response_entered.wait(5), "旧生成应真实进入合成供应商边界。")
                replacement = {"running_request_key": old_body["idempotency_key"], "replacement": new_body}
                status, new_receipt = self.backend.request(path + "/replace/prepare", replacement)
                self.assertEqual(status, 200, new_receipt)
                self.assertEqual(new_receipt["state"], "running")
                self.assertEqual(len(self.model.seen_calls), 1)
                status, generated = self.backend.request(path + "/replies", new_body)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["turn_id"], new_receipt["turn_id"])
                self.assertEqual(generated["candidates"][0]["text"], "合成有效新候选")
                self.assertEqual(self.backend.request(path + "/replace/prepare", replacement), (
                    200, {**new_receipt, "state": "completed"},
                ))
            finally:
                self.model.release_first_response.set()
            late_status, late_result = old_running.result(timeout=30)
        self.assertNotEqual(late_status, 200, late_result)
        saved = self._backend().request(path)[1]
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        self.assertEqual(saved["current_input_version_id"], new_receipt["input_version_id"])
        self.assertEqual(turns[old_body["idempotency_key"]]["state"], "failed")
        self.assertIsNone(turns[old_body["idempotency_key"]]["reply"])
        self.assertEqual(turns[new_body["idempotency_key"]]["state"], "completed")
        self.assertEqual(turns[new_body["idempotency_key"]]["reply"]["candidates"][0]["text"], "合成有效新候选")
        assert_generation_review_calls(self, self.model, generation=2, review=0)
        self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 2)

    def test_source_and_session_deletion_reject_prepared_recovery_with_zero_model_calls(self) -> None:
        path = self._session_path()
        source_id, target_id = uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.source_document "
                               "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                               "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-prepare.jsonl', %s, 1)",
                               (source_id, self.owner_id, self.contact_id, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message "
                               "(id, owner_id, contact_id, speaker, message_type, text_content, occurred_at) "
                               "VALUES (%s, %s, %s, 'contact', 'text', '合成准备来源消息', now())",
                               (target_id, self.owner_id, self.contact_id))
            connection.execute("INSERT INTO public.message_source_ref "
                               "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                               "VALUES (%s, %s, %s, 'source_document', %s, 'synthetic:prepare', '{}'::jsonb)",
                               (target_id, self.owner_id, self.contact_id, source_id))
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "skill_disabled": True, "content": {"type": "reply_to_message",
                "target_message_id": str(target_id), "direction": "合成明确回应来源消息。"}}
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        status, deleting = self.backend.request(f"/api/contacts/{self.contact_id}/sources/{source_id}", method="DELETE")
        self.assertEqual(status, 202, deleting)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status, sources = self.backend.request(f"/api/contacts/{self.contact_id}/sources")
            self.assertEqual(status, 200, sources)
            source = next(item for item in sources["sources"] if item["source_id"] == str(source_id))
            if source["status"] == "deleted":
                break
            self.assertNotEqual(source["task_status"], "failed", source)
            time.sleep(0.02)
        else:
            self.fail("合成来源应在限定时间内公开可见地删除。")
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (
            409, {"error": "assistant_session_rejected", "reason": "source_deleted"},
        ))
        saved = self._backend().request(path)[1]
        self.assertEqual(saved["turns"][0]["turn_id"], prepared["turn_id"])
        self.assertEqual(saved["turns"][0]["state"], "redacted")
        self.assertIsNone(saved["turns"][0]["input"])
        self.assertIsNone(saved["turns"][0]["reply"])
        self._unreserved_prepare_rejection(path + "/replies/prepare", {
            **body, "idempotency_key": str(uuid4()),
        }, 409, {"error": "assistant_session_rejected", "reason": "target_message_unavailable"})
        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self._unreserved_prepare_rejection(path + "/replies/prepare", body, 404, {"error": "not_found"})
        self.assertEqual(self.model.seen_calls, [])

    def test_failed_prepare_replay_does_not_restart_or_rewind_and_fresh_retry_can_generate(self) -> None:
        path = self._session_path()
        body = self._body()
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        limited = self._backend(capacity=1000, output_reserve=100)

        status, rejected = limited.request(path + "/replies", body)

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        failed_receipt = {**prepared, "state": "failed"}
        self.assertEqual(limited.request(path + "/replies/prepare", body), (200, failed_receipt))
        next_body = self._body(draft="合成后继输入")
        status, next_receipt = self.backend.request(path + "/replies/prepare", next_body)
        self.assertEqual(status, 200, next_receipt)
        self.assertEqual(self._backend().request(path + "/replies/prepare", body), (200, failed_receipt))
        saved = self.backend.request(path)[1]
        self.assertEqual(saved["current_input_version_id"], next_receipt["input_version_id"])
        old_turn = next(turn for turn in saved["turns"] if turn["request_key"] == body["idempotency_key"])
        self.assertEqual(old_turn["state"], "failed")
        self.assertIsNone(old_turn["reply"])
        self.assertEqual(self.model.seen_calls, [])
        retry_body = self._body()
        status, retry_receipt = self.backend.request(path + "/replies/prepare", retry_body)
        self.assertEqual(status, 200, retry_receipt)
        self.assertEqual(retry_receipt["state"], "running")
        self.assertNotEqual(retry_receipt["turn_id"], prepared["turn_id"])
        self.model.plans.append({"text": "合成显式重试候选", "basis": "保留合成草稿原意。"})
        status, generated = self.backend.request(path + "/replies", retry_body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], retry_receipt["turn_id"])
        assert_generation_review_calls(self, self.model, generation=1, review=0)

    def test_prepare_reports_the_actual_running_retry_without_rewriting_the_failed_turn(self) -> None:
        self.model = LatePreparedModel()
        self.backend = self._backend()
        path = self._session_path()
        body = self._body()
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        limited = self._backend(capacity=1000, output_reserve=100)
        status, rejected = limited.request(path + "/replies", body)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        failed_turn, failed_request = self._generation_metadata(body)
        self.assertEqual(failed_turn["state"], "failed")
        self.assertEqual(failed_request["state"], "failed")
        self.assertEqual(self.model.seen_calls, [])

        with ThreadPoolExecutor(max_workers=1) as generation_pool:
            retry = generation_pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.response_entered.wait(5), "同键重试须实际进入模型。")
                before = self.backend.request(path)[1]
                actual_turn, actual_request = self._generation_metadata(body)
                self.assertEqual(actual_turn["state"], "failed")
                self.assertIsNone(actual_turn["reply_request_id"])
                self.assertEqual(actual_request["id"], failed_request["id"])
                self.assertEqual(actual_request["attempt"], 2)
                self.assertEqual(actual_request["state"], "running")
                self.assertEqual(len(self.model.seen_calls), 1)

                self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, prepared))

                self.assertEqual(self.backend.request(path)[1], before)
                self.assertEqual(self._generation_metadata(body), (actual_turn, actual_request))
                self.assertEqual(len(self.model.seen_calls), 1)
            finally:
                self.model.release_first_response.set()
            status, generated = retry.result(timeout=10)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], prepared["turn_id"])
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (
            200, {**prepared, "state": "completed"},
        ))
        assert_generation_review_calls(self, self.model, generation=1, review=0)

    def test_prepare_reports_canonical_completion_before_the_session_turn_is_completed(self) -> None:
        completion = AssistantCompletionBarrierStore(DATABASE_URL)
        self.addCleanup(completion.release.set)
        self.backend = self._backend(completion_barrier=completion)
        path = self._session_path()
        body = self._body()
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.model.plans.append({"text": "合成可靠保存候选", "basis": "保留合成草稿原意。"})

        with ThreadPoolExecutor(max_workers=1) as generation_pool:
            generation = generation_pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(completion.entered.wait(5), "唯一 C.save 须真实提交后到达 A.complete。")
                before = self.backend.request(path)[1]
                actual_turn, actual_request = self._generation_metadata(body)
                self.assertEqual(actual_turn["state"], "running")
                self.assertEqual(actual_turn["reply_request_id"], actual_request["id"])
                self.assertEqual(actual_request["state"], "completed")
                assert_generation_review_calls(self, self.model, generation=1, review=0)

                self.assertEqual(self.backend.request(path + "/replies/prepare", body), (
                    200, {**prepared, "state": "completed"},
                ))

                self.assertEqual(self.backend.request(path)[1], before)
                self.assertEqual(self._generation_metadata(body), (actual_turn, actual_request))
                assert_generation_review_calls(self, self.model, generation=1, review=0)
            finally:
                completion.release.set()
            status, generated = generation.result(timeout=10)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], prepared["turn_id"])
        self.assertEqual(generated["reply_request_id"], str(actual_request["id"]))
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (
            200, {**prepared, "state": "completed"},
        ))
        assert_generation_review_calls(self, self.model, generation=1, review=0)
        self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 1)

    def test_expired_attempt_cannot_borrow_a_new_attempt_lease_for_late_candidate(self) -> None:
        clock = {'now': datetime.now(timezone.utc)}
        self.model = LatePreparedModel()
        self.model.release_second_response = threading.Event()
        self.addCleanup(self.model.release_first_response.set)
        self.addCleanup(self.model.release_second_response.set)
        with patch('notalone.server.reply_wiring.PostgresReplyStore', side_effect=lambda url, **kwargs:
                   PostgresReplyStore(url, clock=lambda: clock['now'], **kwargs)):
            self.backend = self._backend()
        path, body = self._session_path(), self._body(draft='合成同键原稿')
        self.assertEqual(self.backend.request(path + '/replies/prepare', body)[0], 200)
        with ThreadPoolExecutor(max_workers=2) as pool:
            old = pool.submit(self.backend.request, path + '/replies', body)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                clock['now'] += timedelta(seconds=31)
                newer = pool.submit(self.backend.request, path + '/replies', body)
                self.assertTrue(self.model.second_response_entered.wait(5))
                with psycopg.connect(DATABASE_URL) as connection:
                    self.assertEqual(connection.execute(
                        'SELECT attempt,state FROM public.reply_request WHERE owner_id=%s AND contact_id=%s '
                        'AND idempotency_key=%s',
                        (self.owner_id, self.contact_id, UUID(body['idempotency_key'])),
                    ).fetchone(), (2, 'running'))
                # 新租约仍活动时释放旧响应，才能证明是attempt身份拦截而非完成状态拦截。
                self.model.release_first_response.set()
                self.assertNotEqual(old.result(timeout=10)[0], 200)
                assert_generation_review_calls(self, self.model, generation=2, review=0)
            finally:
                self.model.release_first_response.set()
                self.model.release_second_response.set()
            status, current = newer.result(timeout=10)
        self.assertEqual(status, 200, current)
        self.assertEqual(current['candidates'][0]['text'], '合成有效新候选')
        assert_generation_review_calls(self, self.model, generation=2, review=0)
        self.assertEqual(self.backend.request(path + '/replies', body), (200, current))
        with psycopg.connect(DATABASE_URL) as connection:
            attempts = connection.execute(
                'SELECT attempt.number, attempt.state FROM public.reply_attempt AS attempt '
                'JOIN public.reply_request AS request ON request.id=attempt.reply_request_id '
                'WHERE request.owner_id=%s AND request.contact_id=%s AND request.idempotency_key=%s '
                'ORDER BY attempt.number',
                (self.owner_id, self.contact_id, UUID(body['idempotency_key'])),
            ).fetchall()
        self.assertEqual(attempts, [(1, 'expired'), (2, 'completed')])

    def test_interrupt_after_generation_blocks_candidate_before_save(self) -> None:
        path, body = self._session_path(), self._body(draft='合成生成后保存前取消原稿')
        status, prepared = self.backend.request(path + '/replies/prepare', body)
        self.assertEqual(status, 200, prepared)
        self.model.plans.append({'text': '合成原稿候选', 'basis': '保留合成原稿原意。'})
        entered, release = threading.Event(), threading.Event()
        original_generate = type(self.model)._generate

        def generate(model, *args, **kwargs):
            result = original_generate(model, *args, **kwargs)
            entered.set()
            if not release.wait(10):
                raise TimeoutError('合成生成响应门未释放。')
            return result

        with patch.object(type(self.model), '_generate', generate), ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + '/replies', body)
            try:
                self.assertTrue(entered.wait(5), '模型已生成候选，但尚未返回持久化链。')
                assert_generation_review_calls(self, self.model, generation=1, review=0)
                status, stopped = self.backend.request(path + '/interrupt', {
                    'request_key': prepared['request_key'], 'input_version_id': prepared['input_version_id'],
                })
                self.assertEqual(status, 200, stopped)
                self.assertEqual(stopped['interruption_reason'], 'app_quit')
            finally:
                release.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        assert_generation_review_calls(self, self.model, generation=1, review=0)
        self.assertEqual(self.backend.request('/api/ledger/summary')[1]['total_calls'], 1)
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                'SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s',
                (self.owner_id,),
            ).fetchone()[0], 0)

    def test_confirmed_exploration_completed_metadata_survives_later_current_before_a_completion(self) -> None:
        self.model = ExplorationControlledModel()
        completion = AssistantCompletionBarrierStore(DATABASE_URL)
        self.addCleanup(completion.release.set)
        # B 的既有生成适配器延迟构造 A store；注入的仍是实际 PG writer，仅暂停 complete。
        completion_wiring = patch("notalone.server.reply_wiring.PostgresAssistantSessionStore", return_value=completion)
        completion_wiring.start()
        self.addCleanup(completion_wiring.stop)
        self.backend = self._backend(completion_barrier=completion)
        path = self._session_path()
        self.model.plans.append({"explore": {}})
        status, explored = self.backend.request(path + "/explorations", {
            "operation_key": str(uuid4()), "content": {"type": "purpose_exploration",
            "purpose_hint": "合成已确认询问近况。", "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200, explored)
        self.model.plans.append({"text": "合成已保存近况候选", "basis": "只表达已确认意愿。"})
        with ThreadPoolExecutor(max_workers=1) as generation_pool:
            generation = generation_pool.submit(self.backend.request,
                path + f"/explorations/{explored['exploration_id']}/confirm", {"generate": True,
                    "input_version_id": explored["input_version_id"],
                    "suggestion_id": explored["options"][0]["suggestion_id"],
                })
            try:
                self.assertTrue(completion.entered.wait(5), "真实 B 确认结果须先经 C.save 再到 A.complete。")
                saved = self.backend.request(path)[1]
                turn = saved["turns"][0]
                content = dict(turn["input"]["content"])
                reference = content.pop("suggestion")
                body = {**turn["input"], "content": content, "suggestion": reference,
                        "contact_id": str(self.contact_id), "idempotency_key": turn["request_key"],
                        "expected_input_version_id": explored["input_version_id"]}
                status, completed_receipt = self.backend.request(path + "/replies/prepare", body)
                self.assertEqual(status, 200, completed_receipt)
                self.assertEqual(completed_receipt["state"], "completed")
                actual_turn, actual_request = self._generation_metadata(body)
                self.assertEqual(actual_turn["state"], "running")
                self.assertEqual(actual_request["state"], "completed")
                self.assertEqual(actual_turn["reply_request_id"], actual_request["id"])
                status, successor = self.backend.request(path + "/inputs", {
                    "content": {"type": "purpose_exploration", "purpose_hint": "合成后继独立目的。"},
                })
                self.assertEqual(status, 200, successor)
                before = self.backend.request(path)[1]
                self.assertEqual(before["current_input_version_id"], successor["input_version_id"])
                self.assertEqual(self._generation_metadata(body), (actual_turn, actual_request))

                self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, completed_receipt))

                self.assertEqual(self.backend.request(path)[1], before)
                self.assertEqual(self._generation_metadata(body), (actual_turn, actual_request))
                conflicting = {**body, "skill_disabled": False, "skill_version_id": str(uuid4())}
                self.assertEqual(self.backend.request(path + "/replies/prepare", conflicting), (
                    409, {"error": "assistant_session_input_conflict"},
                ))
                self.assertEqual(self._generation_metadata(body), (actual_turn, actual_request))
                self.assertEqual(len(self.model.payloads), 2)
                self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 2)
            finally:
                completion.release.set()
            # 这里只核验无正文 prepare；原长调用完成顺序由 17 的独立真实用例继续验证。
            generation.result(timeout=10)

    def test_prepare_requires_post_and_a_reply_request_without_saving_invalid_input(self) -> None:
        path = self._session_path()

        self.assertEqual(self.backend.request(path + "/replies/prepare", method="GET"), (
            405, {"error": "method_not_allowed"},
        ))
        for invalid in ({}, {"request_key": str(uuid4()), "input_version_id": str(uuid4())},
                        {**self._body(), "contact_id": str(uuid4())},
                        {**self._body(), "content": {"type": "unknown_mode", "text": "合成无效输入"}}):
            with self.subTest(fields=set(invalid)):
                self.assertEqual(self.backend.request(path + "/replies/prepare", invalid), (
                    400, {"error": "assistant_session_request_invalid"},
                ))
        saved = self.backend.request(path)[1]
        self.assertEqual(saved["turns"], [])
        self.assertEqual(saved["inputs"], [])
        self.assertIsNone(saved["current_input_version_id"])
        self.assertEqual(self.model.seen_calls, [])

    def test_prepare_rejects_rescoped_requests_and_revoked_bindings_without_new_input(self) -> None:
        path = self._session_path()
        body = self._body()
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        other_owner = self._backend(owner_id=self.other_owner_id)
        self.assertEqual(other_owner.request(path + "/replies/prepare", body), (404, {"error": "not_found"}))
        missing_session_path = path.rsplit("/", 1)[0] + f"/{uuid4()}"
        self.assertEqual(self.backend.request(missing_session_path + "/replies/prepare", body), (
            404, {"error": "not_found"},
        ))
        other_contact_id = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.contact (id, owner_id, display_name) "
                               "VALUES (%s, %s, '合成隔离联系人')", (other_contact_id, self.owner_id))
        self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=other_contact_id, channel="wechat",
            account_scope="synthetic-http-prepare-other", conversation_locator=f"synthetic-{uuid4()}",
        )
        rescoped_path = path.replace(str(self.contact_id), str(other_contact_id))
        self._unreserved_prepare_rejection(rescoped_path + "/replies/prepare", {
            **body, "contact_id": str(other_contact_id),
        }, 404, {"error": "not_found"})
        status, other_session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-sessions", {})
        self.assertEqual(status, 200, other_session)
        other_session_path = path.rsplit("/", 1)[0] + f"/{other_session['session_id']}"
        self.assertEqual(self.backend.request(other_session_path + "/replies/prepare", body), (
            409, {"error": "assistant_session_input_conflict"},
        ))
        before = self.backend.request(path)[1]
        self.bindings.revoke_binding(owner_id=self.owner_id, contact_id=self.contact_id,
                                     binding_id=self.binding.binding_id)
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (
            409, {"error": "assistant_session_rejected", "reason": "no_active_binding"},
        ))
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(self.model.seen_calls, [])

    def test_running_prepare_race_keeps_one_identity_and_one_model_call(self) -> None:
        path = self._session_path()
        body = self._body()
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.model.plans.append({"text": "合成延迟候选", "basis": "保留合成草稿原意。"})
        release = self.model.pause_next_response()
        self.addCleanup(release.set)
        with ThreadPoolExecutor(max_workers=1) as generation_pool:
            running = generation_pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.model.entered.wait(5), "生成应实际抵达合成模型边界。")
                with ThreadPoolExecutor(max_workers=4) as preparation_pool:
                    replays = list(preparation_pool.map(
                        lambda _: self.backend.request(path + "/replies/prepare", body), range(4),
                    ))
                self.assertEqual(replays, [(200, prepared)] * 4)
                self.assertEqual(self.backend.request(path + "/replies", body), (
                    409, {"error": "assistant_session_in_progress"},
                ))
                saved = self.backend.request(path)[1]
                self.assertEqual(len(saved["turns"]), 1)
                self.assertEqual(len(saved["inputs"]), 1)
                self.assertEqual(saved["current_input_version_id"], prepared["input_version_id"])
                self.assertEqual(saved["turns"][0]["state"], "running")
            finally:
                release.set()
            status, generated = running.result(timeout=10)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["turn_id"], prepared["turn_id"])
        self.assertEqual(self.backend.request(path + "/replies/prepare", body), (
            200, {**prepared, "state": "completed"},
        ))
        assert_generation_review_calls(self, self.model, generation=1, review=0)
        self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 1)


if __name__ == "__main__":
    unittest.main()
