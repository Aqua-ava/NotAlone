"""原用户稿和已确认策略均通过身份恢复，不重建另一组生成状态。"""

import unittest
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class AssistantInterruptedAuthorityModesHttpTests(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    def _session(self):
        contact, target, _ = self.prepare_contact(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        return contact, target, f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"

    def _retry(self, path, original):
        status, stopped = self.backend.request(path + "/interrupt", {
            "request_key": original["request_key"], "input_version_id": original["input_version_id"],
        })
        self.assertEqual(status, 200, stopped)
        self.assertEqual(stopped["interruption_reason"], "app_quit")
        saved = self.backend.request(path)[1]
        turn = next(item for item in saved["turns"] if item["turn_id"] == original["turn_id"])
        retry = {"original_turn_id": original["turn_id"], "original_input_version_id": original["input_version_id"],
                 "request_key": str(uuid4())}
        calls = len(self.reply_model.payloads)
        status, receipt = self.backend.request(path + "/retry-interrupted/prepare", retry)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(set(receipt), {"session_id", "turn_id", "input_version_id", "request_key", "state"})
        self.assertNotEqual(receipt["turn_id"], original["turn_id"])
        self.assertEqual(len(self.reply_model.payloads), calls)
        self.assertEqual(self.backend.request(path + "/retry-interrupted/prepare", retry), (200, receipt))
        self.reply_model.plans.append({"text": "合成恢复候选，保留本次拒绝。", "basis": "沿服务器保存的当前意愿。"})
        status, result = self.backend.request(path + "/retry-interrupted", retry)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["turn_id"], receipt["turn_id"])
        self.assertEqual(result["restored_input"]["content"].get("user_instruction"), turn["input"]["content"].get("user_instruction"))
        self.assertEqual(self.backend.request(path + "/retry-interrupted", retry), (200, result))
        self.assertEqual(len(self.reply_model.payloads), calls + 1)
        self.assertEqual(next(item for item in self.backend.request(path)[1]["turns"]
                              if item["turn_id"] == original["turn_id"]), turn)
        return turn, result, self.reply_model.payloads[-1]

    def test_original_user_draft_and_exact_single_requirements_are_restored(self):
        contact, _, path = self._session()
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "rewrite_draft", "draft_text": "合成原用户稿：本次不参加。",
                            "user_instruction": "自然一点;  保留原分隔和空格。"}}
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.assertEqual(self.reply_model.payloads, [])
        turn, result, payload = self._retry(path, prepared)
        self.assertEqual(result["restored_input"]["content"], turn["input"]["content"])
        self.assertEqual(payload["draft_text"], body["content"]["draft_text"])

    def test_confirmed_response_and_proactive_restore_the_actual_selected_strategy(self):
        for scene in ("response_exploration", "purpose_exploration"):
            with self.subTest(scene=scene):
                _, target, path = self._session()
                content = ({"type": scene, "target_message_id": target} if scene == "response_exploration" else
                           {"type": scene, "purpose_hint": "合成当前目的：不作未来安排。"})
                self.reply_model.plans.append({"explore": {}})
                status, explored = self.backend.request(path + "/explorations", {
                    "operation_key": str(uuid4()), "content": {**content, "skill_mode": "disabled", "requirements": "保留本次合成意愿"},
                })
                self.assertEqual(status, 200, explored)
                action = path + f"/explorations/{explored['exploration_id']}"
                status, prepared = self.backend.request(action + "/prepare-confirm", {"generate": True,
                    "input_version_id": explored["input_version_id"], "suggestion_id": explored["options"][0]["suggestion_id"],
                })
                self.assertEqual(status, 200, prepared)
                turn, result, payload = self._retry(path, prepared["generation"])
                field = "direction" if scene == "response_exploration" else "purpose"
                self.assertEqual(result["restored_input"]["content"][field], turn["input"]["content"][field])
                self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], turn["input"]["content"][field])
                self.assertEqual(result["restored_input"]["content"][field + "_source"], "confirmed_suggestion")
                self.assertNotEqual(result["restored_input"]["content"]["suggestion"]["task_id"], explored["exploration_id"])
