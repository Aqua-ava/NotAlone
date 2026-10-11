"""重试读取后的来源竞态经真实 HTTP 验证；仅合成资料与隔离 PG。"""

from __future__ import annotations

import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import psycopg

from langchain_core.messages import HumanMessage
from tests.fidelity_http_support import FidelityControlledModel, FidelityHttpFixture


class CapturedPendingModel(FidelityControlledModel):
    """实际模型入口先保留合成输入观察，再走原受控响应门和清理协议。"""

    actual_payload: dict | None = None

    def _generate(self, messages, *args, **kwargs):
        self.actual_payload = next(json.loads(message.content) for message in messages
                                   if isinstance(message, HumanMessage))
        return super()._generate(messages, *args, **kwargs)


class AssistantRetrySourceGuardHttpTest(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    def _post(self, path: str, body: dict) -> dict:
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        return result

    def _get(self, path: str) -> dict:
        status, result = self.backend.request(path)
        self.assertEqual(status, 200, result)
        return result

    def _frame(self, path: str, result: dict) -> dict:
        versions = [self._get(path + f"/candidates/{item['candidate_id']}/versions")
                    for item in result["candidates"]]
        return {"session_id": result["session_id"], "candidate_group_id": result["reply_request_id"],
                "candidates": [{"number": item["candidate_number"], "candidate_id": item["candidate_id"],
                                "version_id": item["default_display_version_id"]} for item in versions]}

    def _interrupted_copy(self) -> tuple[str, str, str, dict, dict]:
        contact, target, source = self.prepare_contact(self.owner_id)
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        self.reply_model.plans.extend([
            {"text": "今晚不参加，谢谢邀请。", "basis": "按合成本次意愿表达。"},
            {"text": "谢谢邀请，今晚不参加。", "basis": "按合成本次意愿表达。"},
        ])
        original = self._post(path + "/replies", {
            "contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
            "content": {"type": "reply_to_message", "target_message_id": target, "direction": "拒绝邀约"},
        })
        continued = self._post(path + "/continue", {
            "idempotency_key": str(uuid4()), "expected_input_version_id": original["input_version_id"],
            "instruction": "第一条自然一点", "displayed_group": self._frame(path, original),
        })
        prepared = self._post(path + "/continue/prepare", {
            "idempotency_key": str(uuid4()), "expected_input_version_id": continued["input_version_id"],
            "instruction": "继续", "displayed_group": self._frame(path, continued),
        })
        self._post(path + "/interrupt", {
            "request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"],
        })
        observed = self._get(path)
        interrupted = next(turn for turn in observed["turns"] if turn["turn_id"] == prepared["turn_id"])
        self.assertEqual(interrupted["interruption_reason"], "app_quit")
        self.assertIsNone(interrupted["input"]["continued_from_candidate_id"])
        self.assertEqual(interrupted["input"]["content"], continued["effective_input"])
        self.assertEqual(interrupted["input"]["content"]["type"], "reply_to_message")
        self.assertEqual(interrupted["input"]["content"]["target_message_id"], target)
        self.assertEqual(interrupted["input"]["content"]["direction"], "拒绝邀约")
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        retry = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                 "expected_input_version_id": prepared["input_version_id"],
                 "content": interrupted["input"]["content"]}
        return contact, source, path, prepared, retry

    def test_source_pending_after_retry_read_rejects_prepare_without_changing_current_or_model(self):
        contact, source, path, prepared, retry = self._interrupted_copy()
        # 合成删除输入停在 worker 清理前；不通过内部表判断业务结果。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' "
                               "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                               (self.owner_id, contact, source))
        sources = self._get(f"/api/contacts/{contact}/sources")
        self.assertEqual(next(item for item in sources["sources"] if item["source_id"] == source)["status"],
                         "delete_requested")
        pending = self._get(path)
        self.assertEqual(pending["current_input_version_id"], prepared["input_version_id"])

        status, rejected = self.backend.request(path + "/replies/prepare", retry)

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected, {"error": "assistant_session_rejected", "reason": "source_unavailable"})
        self.assertEqual(self._get(path), pending)
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_fresh_retry_inherits_original_sources_before_model_and_physical_delete_erases_copy(self):
        contact, source, path, _, retry = self._interrupted_copy()
        prepared = self._post(path + "/replies/prepare", retry)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        restored = self._get(path)
        copy = next(turn for turn in restored["turns"] if turn["turn_id"] == prepared["turn_id"])
        self.assertEqual(copy["input"]["content"], retry["content"])

        independent = self._post(f"/api/contacts/{contact}/assistant-sessions", {})
        independent_path = f"/api/contacts/{contact}/assistant-sessions/{independent['session_id']}"
        self._post(independent_path + "/replies/prepare", {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "合成独立草稿，保留原意。"},
        })
        independent_before = self._get(independent_path)
        status, removal = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, removal)
        until = time.monotonic() + 10
        while time.monotonic() < until:
            state = next(item for item in self._get(f"/api/contacts/{contact}/sources")["sources"]
                         if item["source_id"] == source)
            self.assertNotEqual(state["task_status"], "failed", state)
            if state["status"] == "deleted" and state["task_status"] == "succeeded":
                break
            time.sleep(.02)
        else:
            self.fail("合成来源删除未在限定时间内完成。")

        deleted = self._get(path)
        copy_after = next(turn for turn in deleted["turns"] if turn["turn_id"] == prepared["turn_id"])
        self.assertEqual(copy_after["state"], "redacted")
        self.assertIsNone(copy_after["input"])
        self.assertIsNone(copy_after["reply"])
        self.assertIsNone(deleted["current_input_version_id"])
        self.assertEqual(self.backend.request(path + "/replies/prepare", retry)[0], 409)
        self.assertEqual(self.backend.request(path + "/replies", retry)[0], 409)
        self.assertEqual(self._get(independent_path), independent_before)
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def _interrupted_running_context_copy(self) -> tuple[str, str, str, dict, dict]:
        self.reply_model = CapturedPendingModel()
        self.reply_model.plans.extend([
            {"text": "合成已保存回应：今晚不参加。", "basis": "按合成当前意愿表达。"},
            {"text": "合成迟到旧候选", "basis": "保留合成原草稿表达。"},
        ])
        self.backend = self._backend(self.owner_id)
        contact, target, source = self.prepare_contact(self.owner_id)
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        original = self._post(path + "/replies", {
            "contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
            "content": {"type": "reply_to_message", "target_message_id": target, "direction": "拒绝邀约"},
        })
        self.reply_model.entered.clear()
        self.reply_model.actual_payload = None
        release = self.reply_model.pause_next_response()
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "rewrite_draft", "draft_text": "合成原草稿：今晚不参加，谢谢邀请。",
                            "user_instruction": "自然一点", "include_relationship_context": True}}
        prepared = self._post(path + "/replies/prepare", body)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body, timeout=20)
            try:
                self.assertTrue(self.reply_model.entered.wait(5), "原生成须真正进入模型接缝。")
                payload = self.reply_model.actual_payload
                self.assertTrue(any(item["reply_request_id"] == original["reply_request_id"]
                                    for item in payload["assistant_discussion"]["items"]),
                                "实际模型输入须使用合成原资料。")
                self._post(path + "/interrupt", {
                    "request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"],
                })
                observed = self._get(path)
                stopped = next(turn for turn in observed["turns"] if turn["turn_id"] == prepared["turn_id"])
                self.assertEqual(stopped["state"], "failed")
                self.assertEqual(stopped["interruption_reason"], "app_quit")
                self.assertEqual(stopped["input"]["content"], body["content"])
            finally:
                release.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        retry = {**body, "idempotency_key": str(uuid4()),
                 "expected_input_version_id": prepared["input_version_id"], "content": stopped["input"]["content"]}
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        return contact, source, path, prepared, retry

    def test_runtime_captured_source_pending_blocks_direct_draft_interrupted_retry(self):
        contact, source, path, prepared, retry = self._interrupted_running_context_copy()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' "
                               "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                               (self.owner_id, contact, source))
        before = self._get(path)
        self.assertEqual(before["current_input_version_id"], prepared["input_version_id"])
        self.assertEqual(before["turns"][-1]["state"], "unavailable")
        self.assertIsNone(before["turns"][-1]["input"])
        self.assertEqual(before["inputs"][-1]["state"], "unavailable")

        status, rejected = self.backend.request(path + "/replies/prepare", retry)

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected, {"error": "assistant_session_rejected", "reason": "source_unavailable"})
        self.assertEqual(self._get(path), before)
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_runtime_captured_source_physical_delete_erases_unfinished_input_and_retry_copy(self):
        contact, source, path, _, retry = self._interrupted_running_context_copy()
        self._post(path + "/replies/prepare", retry)
        status, removal = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, removal)
        until = time.monotonic() + 10
        while time.monotonic() < until:
            state = next(item for item in self._get(f"/api/contacts/{contact}/sources")["sources"]
                         if item["source_id"] == source)
            self.assertNotEqual(state["task_status"], "failed", state)
            if state["status"] == "deleted" and state["task_status"] == "succeeded":
                break
            time.sleep(.02)
        else:
            self.fail("实际捕获资料的删除未完成。")

        restored = self._get(path)
        self.assertTrue(all(turn["state"] == "redacted" and turn["input"] is None and turn["reply"] is None
                            for turn in restored["turns"]))
        self.assertIsNone(restored["current_input_version_id"])
        self.assertEqual(self.backend.request(path + "/replies/prepare", retry)[0], 409)
        self.assertEqual(len(self.reply_model.seen_calls), 2)


if __name__ == "__main__":
    unittest.main()
