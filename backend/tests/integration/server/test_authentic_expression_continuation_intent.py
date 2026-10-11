"""具名续改只选择表达参考，不能用旧AI说法替代本次明确意愿。"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class AuthenticExpressionContinuationIntentTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.capture_rows = []

    @classmethod
    def tearDownClass(cls):
        try:
            if target := os.environ.get("NOTALONE_CONTINUATION_INTENT_CAPTURE"):
                Path(target).write_text(json.dumps({
                    "data_kind": "synthetic",
                    "data_version": "authentic-continuation-current-intent-v1",
                    "entry_point": "http",
                    "human_pass_count": 0,
                    "quality_verified": False,
                    "rows": cls.capture_rows,
                }, ensure_ascii=False, indent=2) + "\n")
        finally:
            super().tearDownClass()

    def test_numbered_response_continuation_preserves_current_decline_not_old_ai_acceptance(self):
        self._exercise("response")

    def test_numbered_proactive_continuation_preserves_current_purpose_not_old_ai_acceptance(self):
        self._exercise("proactive")

    def test_numbered_draft_continuation_preserves_user_sentence_not_old_ai_acceptance(self):
        self._exercise("draft")

    def _exercise(self, mode: str) -> None:
        contact, target, _ = self.prepare_contact(self.owner_id, history=mode != "draft")
        intent = "本次明确拒绝，不参加也不作未来承诺。"
        if mode == "response":
            content = {"type": "reply_to_message", "target_message_id": target, "direction": intent}
            intent_field = "confirmed_direction"
        elif mode == "proactive":
            content = {"type": "initiate_conversation", "purpose": intent}
            intent_field = "confirmed_purpose"
        else:
            content = {"type": "rewrite_draft", "draft_text": intent, "include_relationship_context": False}
            intent_field = "draft_text"
        content["user_instruction"] = "不要承诺"
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        old_messages = ("我会参加。", "明晚七点我陪你去合成海边。")
        self.reply_model.plans.append({
            "text": "\n\n".join(old_messages), "messages": list(old_messages),
            "basis": "故意错误合成夹具；不得把旧AI候选升级成本次意愿。",
        })
        status, generated = self.backend.request(path + "/replies", {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "skill_disabled": True, "content": content,
        })
        self.assertEqual(status, 200, generated)
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual(self.reply_model.payloads[0]["fidelity_contract"]["current_intent"]["text"], intent)
        candidate = generated["candidates"][0]
        status, history = self.backend.request(path + f"/candidates/{candidate['candidate_id']}/versions")
        self.assertEqual(status, 200, history)
        command = {
            "idempotency_key": str(uuid4()), "expected_input_version_id": generated["input_version_id"],
            "instruction": "第一条自然一点",
            "displayed_group": {
                "session_id": session["session_id"], "candidate_group_id": generated["reply_request_id"],
                "candidates": [{"number": history["candidate_number"], "candidate_id": history["candidate_id"],
                                "version_id": history["default_display_version_id"]}],
            },
        }
        status, receipt = self.backend.request(path + "/continue/prepare", command)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(set(receipt), {"session_id", "request_key", "input_version_id", "turn_id", "state"})
        self.assertEqual(receipt["request_key"], command["idempotency_key"])
        self.assertEqual(receipt["state"], "running")
        self.assertEqual(len(self.reply_model.payloads), 1, "准备不得进入模型。")
        self.reply_model.plans.append({
            "text": "这次不参加。\n\n谢谢邀请。", "messages": ["这次不参加。", "谢谢邀请。"],
            "basis": "独立合成输出计划；不向模型发送期望或评分。",
        })
        started = time.perf_counter()
        status, result = self.backend.request(path + "/continue", command)
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.assertEqual(status, 200, result)
        self.assertEqual(len(self.reply_model.payloads), 2)
        payload = self.reply_model.payloads[-1]
        self.capture_rows.append({
            "case_id": f"{mode}-numbered-current-intent", "contact_id": contact,
            "command": command, "receipt": receipt, "model_inputs": list(self.reply_model.payloads),
            "output": result, "call_count": 2, "latency_ms": elapsed_ms,
        })
        self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], intent,
                         "编号选中的旧AI说法不能替代当前明确拒绝或用户原句。")
        self.assertEqual(payload[intent_field], intent)
        self.assertEqual(payload["user_instruction"], "不要承诺；自然一点")
        self.assertEqual(result["effective_input"]["type"], content["type"])
        reference = payload["continuation_reference"]
        self.assertFalse(reference["is_current_draft"])
        self.assertEqual([message["text"] for message in reference["messages"]], list(old_messages))
        self.assertEqual(reference["version_id"], history["default_display_version_id"])
        self.assertEqual(self.backend.request(path + "/continue", command), (200, result))
        self.assertEqual(len(self.reply_model.payloads), 2, "同键重放不得调用模型。")
        saved = self._get(self._backend(self.owner_id), path)
        self.assertEqual(saved["current_input_version_id"], receipt["input_version_id"])
        self.assertEqual(saved["turns"][-1]["input"]["content"], result["effective_input"])
        self.assertEqual(saved["turns"][-1]["input"]["continuation"]["effective_intent"]["source"],
                         "direction" if mode == "response" else "purpose" if mode == "proactive" else "draft_text")


if __name__ == "__main__":
    unittest.main()
