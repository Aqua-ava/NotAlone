"""已确认策略再次中断仍按原身份恢复，实际手工样本依赖不能丢。"""

from __future__ import annotations

import copy
import json
import os
import threading
import unittest
from pathlib import Path
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class AuthenticExpressionRepeatedConfirmedRecoveryTests(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.capture_rows = []

    @classmethod
    def tearDownClass(cls):
        try:
            if target := os.environ.get("NOTALONE_REPEATED_CONFIRMED_RECOVERY_CAPTURE"):
                Path(target).write_text(json.dumps({
                    "data_kind": "synthetic", "rows": cls.capture_rows,
                    "human_fidelity_pass": 0, "quality_verified": False,
                    "coverage": "真实HTTP重复准备中断及样本派生删除；不代表Host或原生退出",
                }, ensure_ascii=False, indent=2) + "\n")
        finally:
            super().tearDownClass()

    def test_response_repeated_prepared_recovery_keeps_confirmed_intent_and_sample_lineage(self):
        self._exercise("response_exploration")

    def test_proactive_repeated_prepared_recovery_keeps_confirmed_intent_and_sample_lineage(self):
        self._exercise("purpose_exploration")

    def _exercise(self, scene: str):
        contact, target, _ = self.prepare_contact(self.owner_id)
        samples = f"/api/contacts/{contact}/style-samples"
        sample = self._post(samples, {"idempotency_key": str(uuid4()), "text": "仅供说法参考的合成手工样本。",
                                      "origin": {"kind": "manual"}})["sample"]
        self.assertEqual(sample["source_ids"], [])
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        content = ({"type": scene, "target_message_id": target} if scene == "response_exploration" else
                   {"type": scene, "purpose_hint": "只了解合成近况，不承诺见面。"})
        self.reply_model.plans.append({"explore": {}})
        explored = self._post(path + "/explorations", {"operation_key": str(uuid4()),
            "content": {**content, "skill_mode": "disabled", "requirements": "不要承诺"}})
        action = path + f"/explorations/{explored['exploration_id']}"
        confirmation = {"generate": True, "input_version_id": explored["input_version_id"],
                        "suggestion_id": explored["options"][0]["suggestion_id"]}
        original = self._post(action + "/prepare-confirm", confirmation)["generation"]
        self.reply_model.entered.clear()
        gate = self.reply_model.pause_next_response()
        self.reply_model.plans.append({"text": "只了解合成近况。", "basis": "已确认本次意愿，手工样本仅作表达参考。"})
        returned = []
        worker = threading.Thread(target=lambda: returned.append(self.backend.request(action + "/confirm", confirmation)),
                                  daemon=True)
        worker.start()
        try:
            self.assertTrue(self.reply_model.entered.wait(5), "必须到达真实候选模型后才中断。")
            self._interrupt(path, original)
        finally:
            gate.set()
            worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(returned), 1)
        self.assertNotEqual(returned[0][0], 200, returned)
        self.assertEqual(len(self.reply_model.payloads), 2)
        references = self.reply_model.payloads[-1]["style_references"]
        self.assertEqual([item["sample_id"] for item in references], [sample["sample_id"]])
        self.assertTrue(all(item["weight"] == "low" and item["factual_role"] == "expression_reference" for item in references))

        first_body = self._retry_body(original)
        first = self._post(path + "/retry-interrupted/prepare", first_body)
        self._interrupt(path, first)
        before = self.backend.request(path)[1]
        self.assertEqual(before["current_input_version_id"], first["input_version_id"])
        first_turn = next(turn for turn in before["turns"] if turn["turn_id"] == first["turn_id"])
        self.assertIsInstance(first_turn["input"]["continuation"], dict)
        self.assertIsNone(first_turn["input"]["continuation"]["candidate_group_id"])
        second_body = self._retry_body(first)
        self.assertEqual(self.other_backend.request(path + "/retry-interrupted/prepare", second_body)[0], 404)
        status, second = self.backend.request(path + "/retry-interrupted/prepare", second_body)
        capture = {"case_id": scene + "-repeated-confirmed-recovery", "control_contract_completed": False,
                   "first_preparation": first, "before_second": before, "second_body": second_body,
                   "second_prepare_status": status, "second_prepare_response": second,
                   "actual_calls": len(self.reply_model.payloads), "actual_model_inputs": copy.deepcopy(self.reply_model.payloads),
                   "actual_model_outputs": [copy.deepcopy(message.tool_calls) for message in self.reply_model.responses]}
        self.capture_rows.append(capture)
        self.assertEqual(status, 200, second)
        self.assertEqual(set(second), {"session_id", "turn_id", "input_version_id", "request_key", "state"})
        self.assertNotEqual(second["turn_id"], first["turn_id"])
        self.assertEqual(len(self.reply_model.payloads), 2, "恢复准备不得自动调用候选模型。")
        self.reply_model.plans.append({"text": "只了解合成近况。", "basis": "按实际已确认身份继续，不增加见面承诺。"})
        result = self._post(path + "/retry-interrupted", second_body)
        saved = self.backend.request(path)[1]
        restored = next(turn for turn in saved["turns"] if turn["turn_id"] == second["turn_id"])
        self.assertEqual(result["restored_input"], restored["input"])
        field = "direction" if scene == "response_exploration" else "purpose"
        self.assertEqual(restored["input"]["content"][field], first_turn["input"]["content"][field])
        self.assertEqual(restored["input"]["content"][field + "_source"], "confirmed_suggestion")
        self.assertEqual(self.reply_model.payloads[-1]["fidelity_contract"]["current_intent"]["text"],
                         explored["options"][0]["intent"])
        self.assertEqual(self.backend.request(path + "/retry-interrupted", second_body), (200, result))
        self.assertEqual(len(self.reply_model.payloads), 3)
        independent = self._post(samples, {"idempotency_key": str(uuid4()), "text": "恢复后独立保存的另一合成手工表达。",
                                           "origin": {"kind": "manual"}})["sample"]
        self.assertEqual(self.backend.request(samples + "/" + sample["sample_id"], method="DELETE")[0], 200)
        erased = self._backend(self.owner_id).request(path)[1]
        self.assertIsNone(erased["current_input_version_id"])
        self.assertEqual(len(erased["turns"]), 3)
        self.assertTrue(all(turn["state"] == "redacted" and turn["input"] is None and turn["reply"] is None
                            for turn in erased["turns"]))
        self.assertEqual(self.backend.request(samples + "/" + independent["sample_id"])[1]["sample"], independent)
        self.assertNotEqual(self.backend.request(path + "/retry-interrupted", second_body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 3)
        capture.update(control_contract_completed=True, actual_calls=3,
                       actual_model_inputs=copy.deepcopy(self.reply_model.payloads), actual_output=result,
                       actual_model_outputs=[copy.deepcopy(message.tool_calls) for message in self.reply_model.responses],
                       deleted_projection=erased, prepare_model_delta=0, deletion_model_delta=0)

    def _post(self, path: str, body: dict) -> dict:
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        return result

    def _interrupt(self, path: str, receipt: dict):
        stopped = self._post(path + "/interrupt", {"request_key": receipt["request_key"],
                                                   "input_version_id": receipt["input_version_id"]})
        self.assertEqual(stopped["state"], "failed")
        self.assertEqual(stopped["interruption_reason"], "app_quit")

    @staticmethod
    def _retry_body(receipt: dict) -> dict:
        return {"original_turn_id": receipt["turn_id"], "original_input_version_id": receipt["input_version_id"],
                "request_key": str(uuid4())}
