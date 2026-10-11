"""重试读取后的来源竞态经真实 HTTP 验证；仅合成资料与隔离 PG。"""

from __future__ import annotations

import time
import unittest
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture


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
        self.assertEqual(interrupted["input"]["content"]["type"], "rewrite_draft")
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


if __name__ == "__main__":
    unittest.main()
