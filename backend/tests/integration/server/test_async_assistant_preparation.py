"""异步准备经真实 HTTP 与 PostgreSQL 验证最终事务及中断竞态。"""

import json
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import psycopg

from notalone.persistence.assistant_prepared_context import PreparedAssistantContext
from tests.integration.server import test_assistant_generation_prepare as preparation_support


class AsyncAssistantPreparationHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        preparation_support.AssistantGenerationPrepareHttpTest.setUpClass()

    def setUp(self):
        self.fixture = preparation_support.AssistantGenerationPrepareHttpTest("runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.path = self.fixture._session_path()
        self.body = self.fixture._body()

    def request(self, method, path, body=None, *, asynchronous=False):
        headers = {"Authorization": f"Bearer {self.fixture.backend.token}", "Content-Type": "application/json"}
        if asynchronous:
            headers["Prefer"] = "respond-async"
        request = Request(self.fixture.backend.base_url + path, method=method, headers=headers,
                          data=None if body is None else json.dumps(body).encode())
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def terminal(self, path):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status, payload = self.request("GET", path)
            if status != 202:
                return status, payload
        self.fail("异步准备未在有界时段内结算。")

    def _late_write(self, action, *, expected_state="failed"):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = PreparedAssistantContext.fit_budget

        def pause_before_writer(context_store, context, *, validate):
            context = original(context_store, context, validate=validate)
            entered.set()
            if not release.wait(15):
                raise TimeoutError("合成准备写入屏障未释放。")
            return context

        with patch.object(PreparedAssistantContext, "fit_budget", pause_before_writer):
            status, pending = self.request("POST", self.path + "/replies/prepare", self.body, asynchronous=True)
            self.assertEqual(status, 202, pending)
            status_path = self.path + "/replies/prepare/status/" + pending["preparation_id"]
            self.assertTrue(entered.wait(5))
            status, session = self.request("GET", self.path)
            self.assertEqual(status, 200, session)
            turn = next(item for item in session["turns"] if item["request_key"] == self.body["idempotency_key"])
            action(status_path, turn)
            release.set()
            outcome = self.terminal(status_path)
        with psycopg.connect(preparation_support.DATABASE_URL) as connection:
            stored = connection.execute(
                "SELECT state, prepared_context, interruption_reason FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                (self.fixture.owner_id, self.fixture.contact_id, self.body["idempotency_key"]),
            ).fetchone()
        self.assertEqual(stored[0], expected_state)
        self.assertIsNone(stored[1])
        self.assertEqual(self.fixture.model.seen_calls, [])
        return outcome, stored

    def test_cancel_rejects_late_material_and_explicit_same_key_retry_revalidates(self):
        def cancel(path, turn):
            self.assertEqual(self.request("DELETE", path)[0], 202)

        outcome, stored = self._late_write(cancel)
        self.assertEqual(outcome, (409, {"error": "assistant_preparation_cancelled"}))
        status, pending = self.request("POST", self.path + "/replies/prepare", self.body, asynchronous=True)
        self.assertEqual(status, 202, pending)
        status, receipt = self.terminal(self.path + "/replies/prepare/status/" + pending["preparation_id"])
        self.assertEqual(status, 200, receipt)
        self.assertEqual(receipt["request_key"], self.body["idempotency_key"])
        self.assertEqual(self.fixture.model.seen_calls, [])

    def test_original_exit_interruption_blocks_material_even_without_async_cancellation(self):
        def interrupt(path, turn):
            status, receipt = self.request("POST", self.path + "/interrupt", {
                "request_key": turn["request_key"], "input_version_id": turn["input_version_id"],
                "reason": "app_quit",
            })
            self.assertEqual(status, 200, receipt)
            self.assertEqual(receipt["interruption_reason"], "app_quit")

        outcome, stored = self._late_write(interrupt)
        self.assertNotEqual(outcome[0], 200, outcome)
        self.assertEqual(stored[2], "app_quit")

    def test_deadline_rejects_late_material_and_settles_reserved_turn(self):
        def exceed_deadline(path, turn):
            self.assertFalse(threading.Event().wait(1.05))

        with patch("notalone.server.assistant_preparation_jobs.PREPARATION_BUDGET_SECONDS", 1):
            outcome, stored = self._late_write(exceed_deadline)
        self.assertEqual(outcome, (504, {"error": "assistant_preparation_timeout"}))

    def test_committed_preparation_wins_before_later_cancel_without_rewinding_turn(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = PreparedAssistantContext.prepare

        def pause_after_commit(context_store, **kwargs):
            original(context_store, **kwargs)
            entered.set()
            if not release.wait(15):
                raise TimeoutError("合成已提交准备屏障未释放。")

        with patch.object(PreparedAssistantContext, "prepare", pause_after_commit):
            status, pending = self.request("POST", self.path + "/replies/prepare", self.body, asynchronous=True)
            self.assertEqual(status, 202, pending)
            status_path = self.path + "/replies/prepare/status/" + pending["preparation_id"]
            self.assertTrue(entered.wait(5))
            self.assertEqual(self.request("DELETE", status_path)[0], 202)
            release.set()
            status, receipt = self.terminal(status_path)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(receipt["state"], "running")
        stored = self.request("GET", self.path)[1]["turns"][0]
        self.assertEqual(stored["turn_id"], receipt["turn_id"])
        self.assertEqual(stored["state"], "running")
        self.assertEqual(self.fixture.model.seen_calls, [])

    def test_source_deletion_before_final_writer_keeps_late_material_erased(self):
        source_id, target_id = uuid4(), uuid4()
        with psycopg.connect(preparation_support.DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.source_document "
                               "(id, owner_id, contact_id, source_type, file_name, content_sha256, record_count) "
                               "VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic-async.jsonl', %s, 1)",
                               (source_id, self.fixture.owner_id, self.fixture.contact_id, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message "
                               "(id, owner_id, contact_id, speaker, message_type, text_content, occurred_at) "
                               "VALUES (%s, %s, %s, 'contact', 'text', '合成异步来源消息', now())",
                               (target_id, self.fixture.owner_id, self.fixture.contact_id))
            connection.execute("INSERT INTO public.message_source_ref "
                               "(message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) "
                               "VALUES (%s, %s, %s, 'source_document', %s, 'synthetic:async', '{}'::jsonb)",
                               (target_id, self.fixture.owner_id, self.fixture.contact_id, source_id))
        self.body = {**self.body, "skill_disabled": True, "content": {"type": "reply_to_message",
                     "target_message_id": str(target_id), "direction": "合成明确回应来源。"}}

        def delete_source(path, turn):
            status, payload = self.request("DELETE", f"/api/contacts/{self.fixture.contact_id}/sources/{source_id}")
            self.assertEqual(status, 202, payload)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status, payload = self.request("GET", f"/api/contacts/{self.fixture.contact_id}/sources")
                self.assertEqual(status, 200, payload)
                source = next(item for item in payload["sources"] if item["source_id"] == str(source_id))
                if source["status"] == "deleted":
                    return
                self.assertNotEqual(source["task_status"], "failed", source)
            self.fail("来源删除未在有界时间内结算。")

        outcome, stored = self._late_write(delete_source, expected_state="redacted")
        self.assertNotEqual(outcome[0], 200, outcome)
