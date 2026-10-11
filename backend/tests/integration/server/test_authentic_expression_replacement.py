"""当前意图替换与样本删除沿正式 HTTP 组合验证，仅替换模型。"""

import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from langchain_core.messages import HumanMessage

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.core_business_flow_support import tool_response
from tests.integration.server.test_assistant_generation_replacement import ReplacementScriptedModel


class AuthenticExpressionReplacementTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = staticmethod(lambda: ReplacementScriptedModel([]))

    def _release_response_gates(self):
        self.reply_model.release_first_response.set()
        for gate in self.extraction_model.response_gates.values():
            gate.set()

    def test_new_intent_replaces_pending_reply_and_sample_delete_erases_both_turns(self):
        contact, target, _ = self.prepare_contact(self.owner_id)
        status, sample = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": "合成表达参考：可以呀。", "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, sample)
        sample_id = sample["sample"]["sample_id"]
        session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})[1]
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        old = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
               "content": {"type": "reply_to_message", "target_message_id": target, "direction": "这次同意参加。"}}
        new = {**old, "idempotency_key": str(uuid4()), "content": {
            **old["content"], "direction": "改为明确拒绝这次邀请，不增加时间或其他承诺。",
        }}
        for text in ("可以呀，这次参加。", "这次不参加。"):
            self.reply_model.responses.append(tool_response("ReplyRuntimeOutput", {
                "candidates": [{"text": text, "basis": "仅表达当前明确方向。",
                                "citation_ids": [target], "risk_notes": []}], "used_skill_version_id": None,
            }))
        self.addCleanup(self.reply_model.release_first_response.set)
        replacement = {"running_request_key": old["idempotency_key"], "replacement": new}
        with ThreadPoolExecutor(max_workers=2) as pool:
            late = pool.submit(self.backend.request, path + "/replies", old)
            try:
                self.assertTrue(self.reply_model.response_entered.wait(5))
                replacing = pool.submit(self.backend.request, path + "/replace", replacement)
                # 正式模型优先级串行运行；先观察新输入已领取，再释放旧供应商响应。
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    pending = self._get(self.backend, path)
                    if any(turn["request_key"] == new["idempotency_key"] for turn in pending["turns"]):
                        break
                    time.sleep(0.01)
                else:
                    self.fail("替换必须在旧模型返回前领取新的真实输入。")
            finally:
                self.reply_model.release_first_response.set()
            self.assertNotEqual(late.result(timeout=10)[0], 200)
            status, generated = replacing.result(timeout=10)
            self.assertEqual(status, 200, generated)
        self.assertEqual(generated["candidates"][0]["text"], "这次不参加。")
        self.assertEqual(generated["context_receipt"]["style_sample_ids"], [sample_id])
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        payload = next(json.loads(message.content) for message in self.reply_model.seen_calls[1]
                       if isinstance(message, HumanMessage))
        self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], new["content"]["direction"])
        self.assertEqual([item["sample_id"] for item in payload["style_references"]], [sample_id])
        rebuilt = self._backend(self.owner_id)
        saved = self._get(rebuilt, path)
        self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
        turns = {turn["request_key"]: turn for turn in saved["turns"]}
        self.assertEqual(turns[old["idempotency_key"]]["state"], "failed")
        self.assertIsNone(turns[old["idempotency_key"]]["reply"])
        self.assertEqual(turns[new["idempotency_key"]]["state"], "completed")
        self.assertEqual(rebuilt.request(path + "/replace", replacement), (200, generated))
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        self.assertEqual(rebuilt.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")[0], 200)
        erased = self._get(self._backend(self.owner_id), path)
        self.assertIsNone(erased["current_input_version_id"])
        self.assertEqual(len(erased["turns"]), 2)
        for turn in erased["turns"]:
            self.assertEqual(turn["state"], "redacted")
            self.assertIsNone(turn["input"])
            self.assertIsNone(turn["reply"])
        self.assertNotEqual(rebuilt.request(path + "/replace", replacement)[0], 200)
        self.assertNotEqual(rebuilt.request(path + "/replies", old)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
