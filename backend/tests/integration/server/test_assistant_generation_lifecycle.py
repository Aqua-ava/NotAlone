"""显式退出经公开 HTTP 与正式迁移后的隔离 PostgreSQL 验证。"""

from __future__ import annotations

import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.application.assistant_session_service import AssistantSessionService
from notalone.application.skill_service import LedgerService
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.fidelity_http_support import FidelityControlledModel
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend
from tests.integration.server.test_assistant_generation_prepare import (
    AssistantCompletionBarrierStore, LatePreparedModel,
)


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class AssistantGenerationInterruptionHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定本票隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("退出 HTTP 验收只允许隔离 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id, self.other_owner_id, self.contact_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            for owner_id in (self.owner_id, self.other_owner_id):
                connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '合成 HTTP 退出用户')", (owner_id,))
            connection.execute("INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, '合成 HTTP 退出联系人')", (self.owner_id, self.contact_id))
        self.addCleanup(self._clean_owner)
        self.binding = PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-http-interruption", conversation_locator=f"synthetic-{uuid4()}",
        )
        self.model = FidelityControlledModel()
        self.backend = self._backend()

    def _backend(
        self, *, owner_id: UUID | None = None,
        completion_barrier: AssistantCompletionBarrierStore | None = None,
        capacity: int = 100000,
        output_reserve: int = 4096,
    ) -> HttpBackend:
        current_owner = owner_id or self.owner_id
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.model):
            reply_service = build_reply_service(
                database_url=DATABASE_URL, owner_id=current_owner,
                **synthetic_budget_kwargs(self.model, capacity=capacity, output_reserve=output_reserve),
            )
        backend = HttpBackend(create_app(
            database_url=DATABASE_URL, owner_id=current_owner,
            token="synthetic-interruption-http-token", reply_service=reply_service,
            ledger_service=LedgerService(ledger=PostgresOutboundLedger(DATABASE_URL)),
            assistant_sessions=(AssistantSessionService(
                store=completion_barrier, reply=reply_service,
                catalog=PostgresAssistantSessionCatalog(DATABASE_URL),
            ) if completion_barrier is not None else None),
        ), current_owner)
        self.addCleanup(backend.close)
        return backend

    def _clean_owner(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id = ANY(%s::uuid[])", ([self.owner_id, self.other_owner_id],))

    def _session_path(self) -> str:
        status, default = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-session/default", {}, method="POST")
        self.assertEqual(status, 200, default)
        return f"/api/contacts/{self.contact_id}/assistant-sessions/{default['session_id']}"

    def _body(self, draft: str = "合成公开退出前草稿") -> dict:
        return {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": draft,
                            "user_instruction": "合成公开退出要求"}}

    def _prepare(self, path: str, body: dict) -> dict:
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        return prepared

    @staticmethod
    def _interruption_body(prepared: dict) -> dict:
        return {"request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"]}

    def test_reserved_generation_is_interrupted_and_restores_without_a_model(self) -> None:
        path = self._session_path()
        body = self._body()
        prepared = self._prepare(path, body)

        status, interrupted = self.backend.request(path + "/interrupt", self._interruption_body(prepared), method="POST")

        self.assertEqual(status, 200, interrupted)
        self.assertEqual(interrupted, {**prepared, "state": "failed", "interruption_reason": "app_quit"})
        reopened = self._backend()
        status, restored = reopened.request(path, method="GET")
        self.assertEqual(status, 200, restored)
        self.assertEqual(restored["turns"][0]["interruption_reason"], "app_quit")
        self.assertEqual(restored["turns"][0]["input"]["content"]["draft_text"], "合成公开退出前草稿")
        self.assertIsNone(restored["turns"][0]["reply"])
        self.assertEqual(self.model.seen_calls, [])
        self.assertEqual(reopened.request("/api/ledger/summary")[1]["total_calls"], 0)

    def test_reliable_failed_generation_is_terminal_without_app_quit_reclassification(self) -> None:
        path = self._session_path()
        body = self._body()
        prepared = self._prepare(path, body)
        limited = self._backend(capacity=1000, output_reserve=100)
        status, failed = limited.request(path + "/replies", body)
        self.assertEqual(status, 409, failed)
        self.assertEqual(failed["error"], "input_budget_exceeded")
        actual_failed = {**prepared, "state": "failed"}
        self.assertEqual(limited.request(path + "/replies/prepare", body), (200, actual_failed))
        before = limited.request(path)[1]
        self.assertEqual(before["turns"][0]["state"], "failed")
        self.assertIsNone(before["turns"][0]["interruption_reason"])
        interruption = self._interruption_body(prepared)
        wrong_input = {**interruption, "input_version_id": str(uuid4())}
        self.assertEqual(limited.request(path + "/interrupt", wrong_input)[0], 409)
        other = self._backend(owner_id=self.other_owner_id)
        self.assertEqual(other.request(path + "/interrupt", interruption)[0], 404)

        status, terminal = limited.request(path + "/interrupt", interruption)

        self.assertEqual(status, 200, terminal)
        self.assertEqual(terminal, {**actual_failed, "interruption_reason": None})
        self.assertEqual(limited.request(path + "/interrupt", interruption), (200, terminal))
        self.assertEqual(limited.request(path)[1], before)
        self.assertEqual(limited.request(path + "/replies/prepare", body), (200, actual_failed))
        self.assertEqual(self.model.seen_calls, [])

    def test_prepare_budget_failure_can_retry_same_key_before_quit(self) -> None:
        path = self._session_path()
        body = self._body("合成预算恢复前保留的原草稿")
        limited = self._backend(capacity=1000, output_reserve=100)
        status, rejected = limited.request(path + "/replies/prepare", body)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        failed = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(self.model.seen_calls, [])

        prepared = self._prepare(path, body)
        self.assertEqual(prepared["turn_id"], failed["turn_id"])
        self.assertEqual(prepared["input_version_id"], failed["input_version_id"])
        self.assertEqual(prepared["request_key"], body["idempotency_key"])
        self.model.plans.append({"text": "合成预算恢复后同键完成", "basis": "保留合成原草稿原意。"})
        status, completed = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, completed)
        self.assertEqual(completed["turn_id"], failed["turn_id"])
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_prepare_budget_failure_without_request_quit_preserves_failure_and_fences_key(self) -> None:
        path = self._session_path()
        body = self._body("合成预算失败退出后不可迟到执行的原草稿")
        limited = self._backend(capacity=1000, output_reserve=100)
        status, rejected = limited.request(path + "/replies/prepare", body)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "input_budget_exceeded")
        before = self.backend.request(path)[1]
        failed = before["turns"][0]
        self.assertEqual(failed["state"], "failed")
        self.assertIsNone(failed["interruption_reason"])
        self.assertNotIn("generation_active", failed, "缺少 C 请求不能冒充普遍的无租约读取证明。")
        interruption = {"request_key": failed["request_key"], "input_version_id": failed["input_version_id"]}
        self.assertEqual(self.backend.request(path + "/interrupt", {
            **interruption, "input_version_id": str(uuid4()),
        }), (409, {"error": "assistant_session_rejected", "reason": "input_version_stale"}))
        self.assertEqual(self._backend(owner_id=self.other_owner_id).request(path + "/interrupt", interruption),
                         (404, {"error": "not_found"}))
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT (SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND contact_id=%s "
                "AND idempotency_key=%s), (SELECT count(*) FROM public.reply_invalidated_key WHERE owner_id=%s "
                "AND contact_id=%s AND idempotency_key=%s)",
                (self.owner_id, self.contact_id, UUID(body["idempotency_key"]),
                 self.owner_id, self.contact_id, UUID(body["idempotency_key"])),
            ).fetchone(), (0, 0))

        status, terminal = self.backend.request(path + "/interrupt", interruption)

        self.assertEqual(status, 200, terminal)
        self.assertEqual(terminal, {"session_id": before["session_id"], "turn_id": failed["turn_id"],
                         **interruption, "state": "failed", "interruption_reason": None})
        self.assertEqual(self.backend.request(path + "/interrupt", interruption), (200, terminal))
        self.assertEqual(self.backend.request(path)[1], before)
        for suffix in ("/replies/prepare", "/replies"):
            self.assertEqual(self.backend.request(path + suffix, body),
                             (409, {"error": "assistant_session_rejected", "reason": "request_deleted"}))
        self.assertEqual(self.model.seen_calls, [])
        self.assertEqual(self.backend.request("/api/ledger/summary")[1]["total_calls"], 0)
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT (SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND contact_id=%s "
                "AND idempotency_key=%s), (SELECT count(*) FROM public.reply_invalidated_key WHERE owner_id=%s "
                "AND contact_id=%s AND idempotency_key=%s)",
                (self.owner_id, self.contact_id, UUID(body["idempotency_key"]),
                 self.owner_id, self.contact_id, UUID(body["idempotency_key"])),
            ).fetchone(), (0, 1))
        fresh_body = self._body("合成退出后显式新键草稿")
        fresh = self._prepare(path, fresh_body)
        self.assertNotEqual(fresh["request_key"], failed["request_key"])
        self.model.plans.append({"text": "合成退出后新键完成", "basis": "保留合成新草稿原意。"})
        self.assertEqual(self.backend.request(path + "/replies", fresh_body)[0], 200)
        self.assertEqual(self.backend.request(path + "/interrupt", interruption), (200, terminal))
        self.assertEqual(self.backend.request(path)[1]["current_input_version_id"], fresh["input_version_id"])
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_expired_request_reports_no_running_generation(self) -> None:
        moment = [datetime.now(timezone.utc)]
        self.model = LatePreparedModel()
        with patch("notalone.server.reply_wiring.PostgresReplyStore", side_effect=lambda url:
                   PostgresReplyStore(url, clock=lambda: moment[0])):
            self.backend = self._backend()
        path = self._session_path()
        body = self._body()
        self._prepare(path, body)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body, timeout=20)
            try:
                self.assertTrue(self.model.response_entered.wait(5), "合成请求必须实际进入模型。")
                moment[0] += timedelta(minutes=2)
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        turn = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(turn["state"], "failed")
        self.assertIs(turn.get("generation_active"), False, "当前 expired 请求与 attempt 已无运行租约。")

    def test_historical_failed_turn_with_actual_running_retry_is_interrupted_as_app_quit(self) -> None:
        self.model = LatePreparedModel()
        self.backend = self._backend()
        path = self._session_path()
        body = self._body()
        prepared = self._prepare(path, body)
        limited = self._backend(capacity=1000, output_reserve=100)
        self.assertEqual(limited.request(path + "/replies", body)[0], 409)
        self.assertEqual(limited.request(path + "/replies/prepare", body), (200, {**prepared, "state": "failed"}))

        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body, timeout=20)
            try:
                self.assertTrue(self.model.response_entered.wait(5), "同键重试须实际进入模型。")
                old_turn = self.backend.request(path)[1]["turns"][0]
                self.assertEqual(old_turn["state"], "failed")
                self.assertIs(old_turn.get("generation_active"), True)
                self.assertIsNone(old_turn["interruption_reason"])
                self.assertEqual(self.backend.request(path + "/replies/prepare", body), (200, prepared))

                status, stopped = self.backend.request(path + "/interrupt", self._interruption_body(prepared))

                self.assertEqual(status, 200, stopped)
                self.assertEqual(stopped, {**prepared, "state": "failed", "interruption_reason": "app_quit"})
                self.assertEqual(len(self.model.seen_calls), 1)
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        after = self.backend.request(path)[1]["turns"][0]
        self.assertEqual(after["state"], "failed")
        self.assertEqual(after["interruption_reason"], "app_quit")
        self.assertIsNone(after["reply"])

    def test_reliable_saved_result_wins_quit_after_the_current_input_advances(self) -> None:
        barrier = AssistantCompletionBarrierStore(DATABASE_URL)
        self.backend = self._backend(completion_barrier=barrier)
        path = self._session_path()
        old_body = self._body()
        prepared = self._prepare(path, old_body)
        self.model.plans.append({"text": "合成退出前已可靠保存的候选", "basis": "保留合成草稿原意。"})
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body, timeout=20)
            try:
                self.assertTrue(barrier.entered.wait(5), "候选必须先实际保存再暂停 A 完成关联。")
                newer = self._prepare(path, self._body("合成完成后独立新输入"))
                self.assertNotEqual(newer["input_version_id"], prepared["input_version_id"])
                status, completed = self.backend.request(path + "/interrupt", self._interruption_body(prepared))
                self.assertEqual(status, 200, completed)
                self.assertEqual(completed, {**prepared, "state": "completed", "interruption_reason": None})
            finally:
                barrier.release.set()
            status, result = running.result(timeout=10)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["turn_id"], prepared["turn_id"])
        self.assertEqual(result["candidates"][0]["text"], "合成退出前已可靠保存的候选")
        reopened = self._backend()
        status, saved = reopened.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], newer["input_version_id"])
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        self.assertEqual(turns[prepared["request_key"]]["state"], "completed")
        self.assertIsNone(turns[prepared["request_key"]]["interruption_reason"])
        self.assertEqual(turns[newer["request_key"]]["state"], "running")
        self.assertEqual(len(self.model.seen_calls), 1)
        self.assertEqual(reopened.request(path + "/interrupt", self._interruption_body(prepared)),
                         (200, completed))

    def test_quit_invalidates_running_generation_and_late_response_cannot_replace_explicit_retry(self) -> None:
        self.model = LatePreparedModel()
        self.backend = self._backend()
        path = self._session_path()
        old_body = self._body()
        prepared = self._prepare(path, old_body)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body, timeout=20)
            try:
                self.assertTrue(self.model.response_entered.wait(5), "原生成必须真实进入可控模型。")
                interruption_body = self._interruption_body(prepared)
                status, interrupted = self.backend.request(path + "/interrupt", interruption_body)
                self.assertEqual(status, 200, interrupted)
                self.assertEqual(interrupted, {**prepared, "state": "failed", "interruption_reason": "app_quit"})
                self.assertEqual(self.backend.request(path + "/interrupt", interruption_body), (200, interrupted))
                for suffix in ("/replies/prepare", "/replies"):
                    self.assertEqual(self.backend.request(path + suffix, old_body), (
                        409, {"error": "assistant_session_rejected", "reason": "generation_interrupted"},
                    ))
                self.assertNotEqual(self.backend.request("/api/reply/generate", old_body)[0], 200)
                self.assertEqual(len(self.model.seen_calls), 1)
                reopened = self._backend()
                saved = reopened.request(path)[1]
                self.assertEqual(saved["turns"][0]["state"], "failed")
                self.assertEqual(saved["turns"][0]["interruption_reason"], "app_quit")
                self.assertEqual(len(self.model.seen_calls), 1, "恢复必须保持零额外模型调用。")
                fresh_body = {**old_body, "idempotency_key": str(uuid4()),
                              "expected_input_version_id": prepared["input_version_id"]}
                status, retry = reopened.request(path + "/replies/prepare", fresh_body)
                self.assertEqual(status, 200, retry)
                status, generated = reopened.request(path + "/replies", fresh_body)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["input_version_id"], retry["input_version_id"])
                self.assertEqual(generated["candidates"][0]["text"], "合成有效新候选")
            finally:
                self.model.release_first_response.set()
            late_status, late = running.result(timeout=10)
        self.assertNotEqual(late_status, 200, late)
        status, saved = reopened.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], retry["input_version_id"])
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        self.assertEqual(turns[prepared["request_key"]]["state"], "failed")
        self.assertEqual(turns[prepared["request_key"]]["interruption_reason"], "app_quit")
        self.assertIsNone(turns[prepared["request_key"]]["reply"])
        self.assertEqual(turns[retry["request_key"]]["state"], "completed")
        self.assertEqual(len(self.model.seen_calls), 2)
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT request.state, attempt.state, attempt.failure_reason, "
                "(SELECT count(*) FROM public.reply_candidate WHERE reply_request_id=request.id) "
                "FROM public.reply_request AS request JOIN public.reply_attempt AS attempt "
                "ON attempt.reply_request_id=request.id AND attempt.number=request.attempt "
                "WHERE request.owner_id=%s AND request.contact_id=%s AND request.idempotency_key=%s",
                (self.owner_id, self.contact_id, UUID(prepared["request_key"])),
            ).fetchone(), ("failed", "failed", "app_quit", 0))

    def test_replayed_interruption_preserves_a_newer_independent_prepared_input(self) -> None:
        path = self._session_path()
        prepared = self._prepare(path, self._body())
        interruption_body = self._interruption_body(prepared)
        status, interrupted = self.backend.request(path + "/interrupt", interruption_body)
        self.assertEqual(status, 200, interrupted)
        newer = self._prepare(path, self._body("合成中断后独立新草稿"))

        self.assertEqual(self._backend().request(path + "/interrupt", interruption_body), (200, interrupted))

        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], newer["input_version_id"])
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        self.assertEqual(turns[prepared["request_key"]]["state"], "failed")
        self.assertEqual(turns[newer["request_key"]]["state"], "running")
        self.assertEqual(self.model.seen_calls, [])

    def test_interruption_failure_rolls_back_request_attempt_and_key_invalidation(self) -> None:
        self.model = LatePreparedModel()
        self.backend = self._backend()
        path = self._session_path()
        body = self._body()
        prepared = self._prepare(path, body)
        trigger_name = "synthetic_quit_failure_" + uuid4().hex
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS "
                "$$ BEGIN RAISE EXCEPTION '合成退出故障'; END $$"
            ).format(sql.Identifier(trigger_name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {} BEFORE UPDATE ON public.assistant_session_turn "
                "FOR EACH ROW WHEN (NEW.id = {} AND NEW.interruption_reason = 'app_quit') "
                "EXECUTE FUNCTION {}()"
            ).format(sql.Identifier(trigger_name), sql.Literal(UUID(prepared["turn_id"])),
                     sql.Identifier(trigger_name)))
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body, timeout=20)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                self.assertEqual(self.backend.request(path + "/interrupt", self._interruption_body(prepared)),
                                 (503, {"error": "assistant_session_save_failed"}))
                status, saved = self.backend.request(path)
                self.assertEqual(status, 200, saved)
                self.assertEqual(saved["turns"][0]["state"], "running")
                self.assertIsNone(saved["turns"][0]["interruption_reason"])
                self.assertEqual(saved["current_input_version_id"], prepared["input_version_id"])
                with psycopg.connect(DATABASE_URL) as connection:
                    self.assertEqual(connection.execute(
                        "SELECT request.state, attempt.state, attempt.failure_reason, "
                        "(SELECT count(*) FROM public.reply_invalidated_key WHERE owner_id=%s "
                        "AND contact_id=%s AND idempotency_key=%s) "
                        "FROM public.reply_request AS request JOIN public.reply_attempt AS attempt "
                        "ON attempt.reply_request_id=request.id AND attempt.number=request.attempt "
                        "WHERE request.owner_id=%s AND request.contact_id=%s AND request.idempotency_key=%s",
                        (self.owner_id, self.contact_id, UUID(prepared["request_key"]),
                         self.owner_id, self.contact_id, UUID(prepared["request_key"])),
                    ).fetchone(), ("running", "running", None, 0))
            finally:
                with psycopg.connect(DATABASE_URL) as connection:
                    connection.execute(sql.SQL("DROP TRIGGER {} ON public.assistant_session_turn").format(sql.Identifier(trigger_name)))
                    connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(trigger_name)))
                self.model.release_first_response.set()
            status, completed = running.result(timeout=10)
        self.assertEqual(status, 200, completed)
        self.assertEqual(completed["turn_id"], prepared["turn_id"])
        self.assertEqual(self._backend().request(path)[1]["turns"][0]["state"], "completed")
        self.assertEqual(len(self.model.seen_calls), 1)

    def test_interruption_rejects_foreign_scope_wrong_identity_and_body_fields_without_writes(self) -> None:
        path = self._session_path()
        prepared = self._prepare(path, self._body())
        interruption_body = self._interruption_body(prepared)
        before = self.backend.request(path)
        for body in ({}, {**interruption_body, "draft_text": "合成禁止退出正文"},
                     {**interruption_body, "request_key": "invalid"},
                     {**interruption_body, "input_version_id": None}):
            with self.subTest(body=sorted(body)):
                self.assertEqual(self.backend.request(path + "/interrupt", body), (
                    400, {"error": "assistant_session_request_invalid"},
                ))
        self.assertEqual(self.backend.request(path + "/interrupt", method="GET"),
                         (405, {"error": "method_not_allowed"}))
        self.assertEqual(self.backend.request(path + "/interrupt", {
            **interruption_body, "input_version_id": str(uuid4()),
        }), (409, {"error": "assistant_session_rejected", "reason": "input_version_stale"}))
        self.assertEqual(self.backend.request(path + "/interrupt", {
            **interruption_body, "request_key": str(uuid4()),
        }), (404, {"error": "not_found"}))
        self.assertEqual(self._backend(owner_id=self.other_owner_id).request(path + "/interrupt", interruption_body),
                         (404, {"error": "not_found"}))
        other_contact_id = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.contact (owner_id,id,display_name) "
                               "VALUES (%s,%s,'合成独立退出联系人')", (self.owner_id, other_contact_id))
        foreign_contact_path = path.replace(str(self.contact_id), str(other_contact_id))
        self.assertEqual(self.backend.request(foreign_contact_path + "/interrupt", interruption_body),
                         (404, {"error": "not_found"}))
        status, other_session = self.backend.request(f"/api/contacts/{self.contact_id}/assistant-sessions", {})
        self.assertEqual(status, 200, other_session)
        foreign_session_path = path.rsplit("/", 1)[0] + "/" + other_session["session_id"]
        self.assertEqual(self.backend.request(foreign_session_path + "/interrupt", interruption_body),
                         (404, {"error": "not_found"}))
        self.assertEqual(self.backend.request(path), before)
        self.assertEqual(self.model.seen_calls, [])
        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.reply_invalidated_key WHERE owner_id=%s "
                "AND contact_id=%s AND idempotency_key=%s",
                (self.owner_id, self.contact_id, UUID(prepared["request_key"])),
            ).fetchone()[0], 0)

    def test_source_and_session_deletion_cannot_recover_an_interrupted_request(self) -> None:
        path = self._session_path()
        source_id, target_id = uuid4(), uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.source_document "
                               "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                               "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-quit.jsonl',%s,1)",
                               (source_id, self.owner_id, self.contact_id, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message "
                               "(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                               "VALUES (%s,%s,%s,'contact','text','合成退出来源消息',now())",
                               (target_id, self.owner_id, self.contact_id))
            connection.execute("INSERT INTO public.message_source_ref "
                               "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                               "VALUES (%s,%s,%s,'source_document',%s,'synthetic:quit','{}'::jsonb)",
                               (target_id, self.owner_id, self.contact_id, source_id))
        body = {"contact_id": str(self.contact_id), "idempotency_key": str(uuid4()),
                "skill_disabled": True, "content": {"type": "reply_to_message",
                "target_message_id": str(target_id), "direction": "合成退出前回应来源消息。"}}
        prepared = self._prepare(path, body)
        self.assertEqual(self.backend.request(path + "/interrupt", self._interruption_body(prepared))[0], 200)
        unrelated = self._prepare(path, self._body("合成无关可保留的独立草稿"))
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
            self.fail("合成退出来源应在限定时间内经实际删除 Worker 清理。")
        self.assertEqual(self._backend().request(path + "/interrupt", self._interruption_body(prepared)), (
            409, {"error": "assistant_session_rejected", "reason": "source_deleted"},
        ))
        saved = self.backend.request(path)[1]
        self.assertEqual(saved["current_input_version_id"], unrelated["input_version_id"])
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        erased = turns[prepared["request_key"]]
        self.assertEqual(erased["state"], "redacted")
        self.assertIsNone(erased["interruption_reason"])
        self.assertIsNone(erased["input"])
        self.assertIsNone(erased["reply"])
        self.assertEqual(turns[unrelated["request_key"]]["input"]["content"]["draft_text"],
                         "合成无关可保留的独立草稿")
        self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        reopened = self._backend()
        self.assertEqual(reopened.request(path), (404, {"error": "not_found"}))
        self.assertEqual(reopened.request(path + "/interrupt", self._interruption_body(prepared)),
                         (404, {"error": "not_found"}))
        self.assertNotEqual(reopened.request("/api/reply/generate", body)[0], 200)
        self.assertEqual(self.model.seen_calls, [])

    def test_quit_stops_an_actual_older_pending_generation_without_rewinding_a_newer_input(self) -> None:
        self.model = LatePreparedModel()
        self.backend = self._backend()
        path = self._session_path()
        old_body = self._body()
        prepared = self._prepare(path, old_body)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", old_body, timeout=20)
            try:
                self.assertTrue(self.model.response_entered.wait(5))
                newer_body = self._body("合成退出时已有的独立后继输入")
                newer = self._prepare(path, newer_body)
                status, interrupted = self.backend.request(path + "/interrupt", self._interruption_body(prepared))
                self.assertEqual(status, 200, interrupted)
                self.assertEqual(interrupted, {**prepared, "state": "failed", "interruption_reason": "app_quit"})
                saved = self._backend().request(path)[1]
                self.assertEqual(saved["current_input_version_id"], newer["input_version_id"])
                turns = {turn["request_key"]: turn for turn in saved["turns"]}
                self.assertEqual(turns[prepared["request_key"]]["state"], "failed")
                self.assertEqual(turns[newer["request_key"]]["state"], "running")
                self.assertIsNone(turns[newer["request_key"]]["interruption_reason"])
            finally:
                self.model.release_first_response.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        self.assertEqual(self.backend.request(path + "/interrupt", self._interruption_body(prepared)),
                         (200, interrupted))
        status, result = self.backend.request(path + "/replies", newer_body)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["input_version_id"], newer["input_version_id"])
        self.assertEqual(result["candidates"][0]["text"], "合成有效新候选")
        self.assertEqual(len(self.model.seen_calls), 2)


if __name__ == "__main__":
    unittest.main()
