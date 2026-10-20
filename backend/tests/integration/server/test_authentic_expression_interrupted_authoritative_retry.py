"""中断恢复只提交真实身份；完整编号参考、累积要求和删除沿 A 唯一 authority。"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class AuthenticExpressionInterruptedAuthoritativeRetryTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.capture_rows = []

    @classmethod
    def tearDownClass(cls):
        try:
            if target := os.environ.get("NOTALONE_AUTHORITATIVE_INTERRUPTED_RETRY_CAPTURE"):
                Path(target).write_text(json.dumps({
                    "data_kind": "synthetic", "rows": cls.capture_rows,
                    "coverage": "真实身份恢复 HTTP；不代表宿主退出或真人表达质量",
                    "quality_verified": False, "human_fidelity_pass": 0,
                }, ensure_ascii=False, indent=2) + "\n")
        finally:
            super().tearDownClass()

    def test_numbered_draft_restores_selected_complete_reference_by_identity_only(self):
        self._exercise("draft", large=False)

    def test_numbered_response_restores_more_than_4096_accumulated_requirements(self):
        self._exercise("response", large=True)

    def test_numbered_proactive_restores_more_than_4096_accumulated_requirements(self):
        self._exercise("proactive", large=True)


    def test_raw_source_delete_erases_authoritative_numbered_retry_before_model(self):
        self._exercise("response", large=True, removal="source")

    def _exercise(self, mode: str, *, large: bool, removal: str | None = None) -> None:
        contact, target, source = self.prepare_contact(self.owner_id, history=mode != "draft")
        intent = "明确拒绝本次合成邀请，不增加任何未来约定。"
        content = {"type": "reply_to_message", "target_message_id": target, "direction": intent} if mode == "response" else (
            {"type": "initiate_conversation", "purpose": intent} if mode == "proactive" else
            {"type": "rewrite_draft", "draft_text": intent, "include_relationship_context": True})
        content["user_instruction"] = "自然一点"
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        self.reply_model.plans.append({
            "text": "我会参加。\n\n明晚七点我陪你去合成海边。",
            "messages": ["我会参加。", "明晚七点我陪你去合成海边。"],
            "basis": "故意错误的旧AI合成计划，不能替代当前拒绝。",
        })
        original = self._post(path + "/replies", {
            "contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True, "content": content,
        })
        self.assertEqual(len(self.reply_model.payloads), 1)
        if mode == "draft":
            self.assertEqual(self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"], [])

        candidate = original["candidates"][0]
        versions_path = path + f"/candidates/{candidate['candidate_id']}/versions"
        history = self._get(self.backend, versions_path)
        base_version = history["versions"][0]
        edited_messages = [{"message_id": message["message_id"], "text": text} for message, text in zip(
            base_version["messages"], ["我已经答应。", "明晚七点我陪你去合成海边。"], strict=True)]
        selected_requirements = "😀" * 4096 if large else "不要承诺"
        edited = self._post(versions_path, {"edit_key": str(uuid4()), "parent_version_id": base_version["version_id"],
                                          "messages": edited_messages, "requirements": selected_requirements})
        selected_version_id = edited["default_display_version_id"]
        self._post(path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate["candidate_id"], "version_id": selected_version_id,
        })
        command = {
            "idempotency_key": str(uuid4()), "expected_input_version_id": original["input_version_id"],
            "instruction": "第一条简短一点",
            "displayed_group": {"session_id": session["session_id"], "candidate_group_id": original["reply_request_id"],
                                "candidates": [{"number": history["candidate_number"], "candidate_id": candidate["candidate_id"],
                                                "version_id": selected_version_id}]},
            "requirement_changes": [{"action": "keep", "previous": selected_requirements}],
        }
        prepared = self._post(path + "/continue/prepare", command)
        self._assert_receipt(prepared, session["session_id"], command["idempotency_key"])
        self.assertEqual(len(self.reply_model.payloads), 1, "编号准备不能自动调用模型。")
        stopped = self._post(path + "/interrupt", {
            "request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"],
        })
        self.assertEqual(stopped["state"], "failed")
        self.assertEqual(stopped["interruption_reason"], "app_quit")
        before = self._get(self._backend(self.owner_id), path)
        interrupted = next(turn for turn in before["turns"] if turn["turn_id"] == prepared["turn_id"])
        original_input = interrupted["input"]
        self.assertEqual(before["current_input_version_id"], prepared["input_version_id"])
        self.assertEqual(original_input["continued_from_candidate_id"], candidate["candidate_id"])
        self.assertEqual(original_input["continuation"]["version_id"], selected_version_id)
        requirements = ["自然一点", selected_requirements, "简短一点"]
        self.assertEqual(original_input["continuation"]["effective_requirements"], requirements)
        self.assertEqual(original_input["content"]["user_instruction"], "；".join(requirements))
        if large:
            self.assertGreater(len(original_input["content"]["user_instruction"]), 4096)
        self.assertNotEqual(self.backend.request(path + "/continue", command)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)

        retry = {"original_turn_id": interrupted["turn_id"], "original_input_version_id": interrupted["input_version_id"],
                 "request_key": str(uuid4())}
        capture = {"case_id": f"{mode}-authoritative-retry-{removal or 'complete'}", "command": command,
                   "original_preparation": prepared, "original_input": original_input, "retry_body": retry,
                   "actual_model_inputs": list(self.reply_model.payloads), "control_contract_completed": False}
        self.capture_rows.append(capture)
        retry_path = path + "/retry-interrupted"
        self.assertEqual(self.other_backend.request(retry_path + "/prepare", retry)[0], 404)
        for invalid in ({**retry, "request_key": str(uuid4()), "content": original_input["content"]},
                        {**retry, "request_key": prepared["request_key"]},
                        {**retry, "request_key": str(uuid4()), "original_turn_id": original["turn_id"]}):
            self.assertNotEqual(self.backend.request(retry_path + "/prepare", invalid)[0], 200)
            self.assertEqual(self._get(self.backend, path), before)
            self.assertEqual(len(self.reply_model.payloads), 1)

        copied = self._post(retry_path + "/prepare", retry)
        self._assert_receipt(copied, session["session_id"], retry["request_key"])
        self.assertNotEqual(copied["turn_id"], prepared["turn_id"])
        self.assertNotEqual(copied["input_version_id"], prepared["input_version_id"])
        self.assertEqual(self.backend.request(retry_path + "/prepare", retry), (200, copied))
        self.assertEqual(len(self.reply_model.payloads), 1)
        after = self._get(self._backend(self.owner_id), path)
        copy = next(turn for turn in after["turns"] if turn["turn_id"] == copied["turn_id"])
        self.assertEqual(copy["state"], "running")
        restored_input = {**original_input, "continuation": {
            **original_input["continuation"],
            "recovery": {"original_turn_id": retry["original_turn_id"],
                         "original_input_version_id": retry["original_input_version_id"]},
        }}
        self.assertEqual(copy["input"], restored_input, "原输入全文保持，仅附严格两UUID恢复来历。")
        self.assertEqual(after["current_input_version_id"], copied["input_version_id"])
        self.assertEqual(next(turn for turn in after["turns"] if turn["turn_id"] == prepared["turn_id"]), interrupted)
        self.assertNotEqual(self.backend.request(retry_path + "/prepare", {**retry, "original_turn_id": original["turn_id"]})[0], 200)
        self.assertEqual(self._get(self.backend, path), after)
        capture.update(copy_receipt=copied, copy_projection=after)

        if removal:
            self._delete_source(contact, source)
            redacted = self._get(self._backend(self.owner_id), path)
            self.assertIsNone(redacted["current_input_version_id"])
            for turn in redacted["turns"]:
                self.assertEqual(turn["state"], "redacted")
                self.assertIsNone(turn["input"])
                self.assertIsNone(turn["reply"])
            self.assertNotEqual(self.backend.request(retry_path + "/prepare", retry)[0], 200)
            self.assertNotEqual(self.backend.request(retry_path, retry)[0], 200)
            self.assertNotEqual(self.backend.request(path + "/continue", command)[0], 200)
            self.assertEqual(self.backend.request(versions_path)[0], 404)
            self.assertEqual(len(self.reply_model.payloads), 1, "删除、重建及拒绝不能调用模型。")
            capture.update(deleted_projection=redacted, actual_calls=1, prepare_model_delta=0, deletion_model_delta=0,
                           control_contract_completed=True)
            return

        self.reply_model.plans.append({
            "text": "本次不参加。\n\n谢谢邀请。", "messages": ["本次不参加。", "谢谢邀请。"],
            "basis": "独立合成模型输出计划，不接收期望或评分。",
        })
        result = self._post(retry_path, retry)
        self.assertEqual(len(self.reply_model.payloads), 2)
        payload = self.reply_model.payloads[-1]
        self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], intent)
        self.assertEqual(payload["user_instruction"], "；".join(requirements))
        reference = payload["continuation_reference"]
        self.assertEqual(reference["version_id"], selected_version_id)
        self.assertFalse(reference["is_current_draft"])
        self.assertEqual(reference["weight"], "low")
        self.assertEqual([message["text"] for message in reference["messages"]], [item["text"] for item in edited_messages])
        self.assertEqual(self.backend.request(retry_path, retry), (200, result))
        self.assertEqual(len(self.reply_model.payloads), 2, "原身份及同新键的实际重放不得重复模型。")
        completed = self._get(self._backend(self.owner_id), path)
        restored = next(turn for turn in completed["turns"] if turn["turn_id"] == copied["turn_id"])
        self.assertEqual(restored["state"], "completed")
        self.assertEqual(restored["input"], restored_input)
        self.assertEqual(result["restored_input"], restored["input"])
        self.assertEqual(completed["current_input_version_id"], copied["input_version_id"])
        self.assertEqual(next(turn for turn in completed["turns"] if turn["turn_id"] == prepared["turn_id"]), interrupted)
        capture.update(actual_model_inputs=list(self.reply_model.payloads), actual_calls=2,
                       actual_output=result, completed_projection=completed, prepare_model_delta=0,
                       control_contract_completed=True)

    def _post(self, path: str, body: dict) -> dict:
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, {"path": path, "actual": result})
        return result


    def _assert_receipt(self, receipt: dict, session_id: str, key: str) -> None:
        self.assertEqual(set(receipt), {"session_id", "turn_id", "input_version_id", "request_key", "state"})
        self.assertEqual(receipt["session_id"], session_id)
        self.assertEqual(receipt["request_key"], key)
        self.assertEqual(receipt["state"], "running")

    def _delete_source(self, contact: str, source: str | None) -> None:
        self.assertIsNotNone(source)
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")[0], 202)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            item = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
                        if item["source_id"] == source)
            self.assertNotEqual(item["task_status"], "failed", item)
            if item["status"] == "deleted" and item["task_status"] == "succeeded":
                return
            time.sleep(.02)
        self.fail("合成来源删除未在限定时间内完成。")


if __name__ == "__main__":
    unittest.main()
