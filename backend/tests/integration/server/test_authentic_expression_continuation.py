"""有界样本、真实候选版本与A唯一续写入口的组合；仅替换模型。"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class AuthenticExpressionContinuationTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.capture_rows = []

    @classmethod
    def tearDownClass(cls):
        try:
            if path := os.environ.get("NOTALONE_TYPED_FIDELITY_CAPTURE"):
                Path(path).write_text(json.dumps({
                    "data_kind": "synthetic", "data_version": "authentic-typed-continuation-http-v2",
                    "entry_point": "http", "rows": cls.capture_rows,
                    "coverage": {
                        "interface": "A唯一 /continue；公开版本读取、编辑和选择；真实HTTP与隔离PG",
                        "scope": "回应与主动各覆盖样本删除和原始来源删除，不代表页面或真实App",
                        "semantic_review": "故意错误合成响应独立标注，真人审阅0",
                    },
                }, ensure_ascii=False, indent=2) + "\n")
        finally:
            super().tearDownClass()

    def test_response_typed_edited_group_is_erased_with_sample_but_independent_discussion_remains(self):
        self._exercise("response", "sample")

    def test_response_typed_edited_group_is_erased_with_raw_source_but_manual_sample_remains(self):
        self._exercise("response", "source")

    def test_proactive_typed_edited_group_is_erased_with_sample_but_independent_discussion_remains(self):
        self._exercise("proactive", "sample")

    def test_proactive_typed_edited_group_is_erased_with_raw_source_but_manual_sample_remains(self):
        self._exercise("proactive", "source")

    def _exercise(self, mode: str, removal: str) -> None:
        contact, target, source = self.prepare_contact(self.owner_id)
        samples_path = f"/api/contacts/{contact}/style-samples"
        status, sample = self.backend.request(samples_path, {
            "idempotency_key": str(uuid4()),
            "text": "合成旧表达：我总是答应，明晚七点陪你去合成海边。",
            "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, sample)
        sample_id = sample["sample"]["sample_id"]
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        discussion_body = {"content": {
            "type": "purpose_exploration", "purpose_hint": "与本次生成无关的合成讨论。", "skill_mode": "disabled",
        }}
        status, discussion = self.backend.request(path + "/inputs", discussion_body)
        self.assertEqual(status, 200, discussion)
        before_inputs = self._get(self.backend, path)["inputs"]
        independent_discussion = next(item["content"] for item in before_inputs
                                      if item["input_version_id"] == discussion["input_version_id"])
        intent = "明确拒绝本次合成邀请，不增加约定。"
        content = {"type": "reply_to_message", "target_message_id": target, "direction": intent} if mode == "response" else {
            "type": "initiate_conversation", "purpose": intent,
        }
        content.update({
            "understanding_correction": "这只是合成邀约，不是已确认约定。",
            "user_instruction": "不要承诺", "clarification_answer": "不陪同，不承诺时间或地点。",
        })
        ordinary = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                    "expected_input_version_id": discussion["input_version_id"], "content": content}
        generated = self._capture_reply(path + "/replies", ordinary, contact, mode, removal, "current", (
            "这次不参加。", "谢谢你邀请。",
        ), "保留本次拒绝，表达样本仅供说法参考。", sample_id, intent)

        candidate_id = generated["candidates"][0]["candidate_id"]
        versions_path = path + f"/candidates/{candidate_id}/versions"
        status, history = self.backend.request(versions_path)
        self.assertEqual(status, 200, history)
        original = history["versions"][0]
        edited_messages = [{"message_id": message["message_id"], "text": text}
                           for message, text in zip(original["messages"], ("这次不参加。", "谢谢。"), strict=True)]
        edit_body = {"edit_key": str(uuid4()), "parent_version_id": original["version_id"],
                     "messages": edited_messages, "requirements": "不要承诺"}
        status, edited = self.backend.request(versions_path, edit_body)
        self.assertEqual(status, 200, edited)
        displayed = edited["default_display_version_id"]
        selection = {"selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": displayed}
        self.assertEqual(self.backend.request(path + "/selections", selection)[0], 200)
        frame = self._frame(session["session_id"], generated, edited)
        typed = {"idempotency_key": str(uuid4()), "expected_input_version_id": generated["input_version_id"],
                 "instruction": "第一条自然一点", "displayed_group": frame}
        continued = self._capture_reply(path + "/continue", typed, contact, mode, removal, "edited", (
            "这次不参加。", "谢谢你。",
        ), "保留当前明确拒绝与不要承诺，只调整说法。", sample_id, intent)
        payload = self.reply_model.payloads[-1]
        self.assertEqual(payload["confirmed_direction" if mode == "response" else "confirmed_purpose"], intent)
        self.assertEqual(continued["effective_input"]["type"], content["type"])
        self.assertEqual(payload["user_instruction"], "不要承诺；自然一点")
        self.assertEqual(continued["continuation"]["version_id"], displayed)
        self.assertEqual(continued["continuation"]["candidate_id"], candidate_id)
        self.assertEqual(payload["continuation_reference"]["version_id"], displayed)
        self.assertFalse(payload["continuation_reference"]["is_current_draft"])
        self.assertEqual([item["text"] for item in payload["continuation_reference"]["messages"]],
                         ["这次不参加。", "谢谢。"])
        self.assertEqual(payload["continuation_reference"]["weight"], "low")
        self.assertEqual(payload["continuation_reference"]["factual_role"], "previous_assistant_candidate")

        status, continued_history = self.backend.request(
            path + f"/candidates/{continued['candidates'][0]['candidate_id']}/versions")
        self.assertEqual(status, 200, continued_history)
        unsupported = {"idempotency_key": str(uuid4()), "expected_input_version_id": continued["input_version_id"],
                       "instruction": "第一条简短一点",
                       "displayed_group": self._frame(session["session_id"], continued, continued_history)}
        failed_semantics = self._capture_reply(path + "/continue", unsupported, contact, mode, removal, "unsupported", (
            "这次不参加。", "那就明晚七点我陪你去合成海边。",
        ), "沿旧样本安排未来陪同。", sample_id, intent)
        self.assertEqual(self.reply_model.payloads[-1]["confirmed_direction" if mode == "response" else "confirmed_purpose"], intent)
        self.assertEqual([item["text"] for item in self.reply_model.payloads[-1]["continuation_reference"]["messages"]],
                         ["这次不参加。", "谢谢你。"])
        self.assertEqual(self.reply_model.payloads[-1]["user_instruction"], "不要承诺；自然一点；简短一点")
        self.assertEqual(failed_semantics["continuation"]["effective_requirements"], ["不要承诺", "自然一点", "简短一点"])
        turns = self._get(self._backend(self.owner_id), path)["turns"]
        self.assertEqual(len(turns), 3)
        self.assertEqual(turns[1]["input"]["continuation"], continued["continuation"])
        self.assertEqual(turns[2]["input"]["continuation"], failed_semantics["continuation"])

        # 同一联系人来源只承担这一组的真实依赖；独立手写样本保留自己的删除意图。
        self._remove_reference(contact, source, sample_id, removal)
        rebuilt = self._backend(self.owner_id)
        recovered = self._get(rebuilt, path)
        self.assertEqual(len(recovered["turns"]), 3)
        self.assertTrue(all(turn["state"] == "redacted" and turn["input"] is None and turn["reply"] is None
                            for turn in recovered["turns"]))
        inputs = {item["input_version_id"]: item for item in recovered["inputs"]}
        self.assertEqual(inputs[discussion["input_version_id"]]["state"], "active")
        self.assertEqual(inputs[discussion["input_version_id"]]["content"], independent_discussion)
        self.assertIsNone(recovered["current_input_version_id"])
        for route, body, result in (("replies", ordinary, generated), ("continue", typed, continued),
                                    ("continue", unsupported, failed_semantics)):
            self.assertNotEqual(rebuilt.request(path + "/" + route, body)[0], 200)
            self.assertNotEqual(rebuilt.request(
                f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence")[0], 200)
            self.assertEqual(rebuilt.request(path + f"/candidates/{result['candidates'][0]['candidate_id']}/versions")[0], 404)
        self.assertEqual(rebuilt.request(versions_path, edit_body)[0], 404)
        self.assertEqual(rebuilt.request(path + "/selections", selection)[0], 404)
        self.assertNotEqual(rebuilt.request(path + "/continue", {
            **unsupported, "idempotency_key": str(uuid4()),
        })[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 3)

    @staticmethod
    def _frame(session_id: str, result: dict, history: dict) -> dict:
        return {"session_id": session_id, "candidate_group_id": result["reply_request_id"], "candidates": [{
            "number": history["candidate_number"], "candidate_id": history["candidate_id"],
            "version_id": history["default_display_version_id"],
        }]}

    def _capture_reply(self, path: str, body: dict, contact: str, mode: str, removal: str, stage: str,
                       messages: tuple[str, ...], basis: str, sample_id: str, intent: str) -> dict:
        self.reply_model.plans.append({"text": "\n\n".join(messages), "messages": list(messages), "basis": basis})
        before = len(self.reply_model.payloads)
        started = time.perf_counter()
        status, result = self.backend.request(path, body)
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.assertEqual(status, 200, result)
        self.assertEqual(len(self.reply_model.payloads), before + 1)
        payload = self.reply_model.payloads[-1]
        self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], intent)
        self.assertEqual([sample["sample_id"] for sample in payload["style_references"]], [sample_id])
        self.assertEqual(result["context_receipt"]["style_sample_ids"], [sample_id])
        self.assertNotIn(sample_id, result["context_receipt"]["evidence_ids"])
        self.assertEqual([item["text"] for item in result["candidates"][0]["messages"]], list(messages))
        self.assertEqual(self._backend(self.owner_id).request(path, body), (200, result))
        self.assertEqual(len(self.reply_model.payloads), before + 1)
        system = "\n".join(str(message.content) for message in self.reply_model.seen_calls[-1] if message.type == "system")
        self.capture_rows.append({
            "case_id": f"{mode}-typed-{removal}-{stage}", "owner_id": str(self.owner_id), "contact_id": contact,
            "payload": payload, "model_inputs": [payload], "system_prompt": system, "output": result,
            "latency_ms": elapsed_ms, "call_count": 1,
        })
        return result

    def _remove_reference(self, contact: str, source: str, sample_id: str, removal: str) -> None:
        if removal == "sample":
            self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")[0], 200)
            state = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
                         if item["source_id"] == source)
            self.assertEqual(state["status"], "active")
            self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}")[0], 410)
            return
        status, receipt = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, receipt)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
                         if item["source_id"] == source)
            self.assertNotEqual(state["task_status"], "failed", state)
            if state["status"] == "deleted" and state["task_status"] == "succeeded":
                break
            time.sleep(.02)
        else:
            self.fail("合成原始来源删除尚未完成。")
        self.assertEqual(self._get(self.backend, f"/api/contacts/{contact}/style-samples/{sample_id}")["sample"]["sample_id"], sample_id)


if __name__ == "__main__":
    unittest.main()
