"""已选方向继续改表达要求，原确认意愿仍是当前真实意愿。"""

import unittest
import time
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class ConfirmedStrategyContinuationHttpTests(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    def test_both_confirmed_scenes_continue_requirements_and_numbered_reference_without_changing_intent(self):
        for scene in ("response_exploration", "purpose_exploration"):
            with self.subTest(scene=scene):
                self.reply_model.payloads.clear()
                self.reply_model.plans.clear()
                contact, target, source = self.prepare_contact(self.owner_id)
                status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
                self.assertEqual(status, 200, session)
                path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
                content = ({"type": scene, "target_message_id": target} if scene == "response_exploration" else
                           {"type": scene, "purpose_hint": "本次仅了解合成近况。"})
                self.reply_model.plans.append({"explore": {}})
                status, explored = self.backend.request(path + "/explorations", {
                    "operation_key": str(uuid4()), "content": {**content, "skill_mode": "disabled", "requirements": "不要承诺"},
                })
                self.assertEqual(status, 200, explored)
                confirmation = {"generate": True, "input_version_id": explored["input_version_id"],
                                "suggestion_id": explored["options"][0]["suggestion_id"]}
                self.reply_model.plans.append({"text": "最近还好吗？\n\n只了解近况。", "basis": "原合成已确认方向。",
                                              "messages": ["最近还好吗？", "只了解近况。"]})
                status, generated = self.backend.request(path + f"/explorations/{explored['exploration_id']}/confirm", confirmation)
                self.assertEqual(status, 200, generated)
                original = generated["turn"]
                candidate = original["candidates"][0]
                status, versions = self.backend.request(path + f"/candidates/{candidate['candidate_id']}/versions")
                self.assertEqual(status, 200, versions)
                version = versions["versions"][0]
                command = {"idempotency_key": str(uuid4()), "expected_input_version_id": original["input_version_id"],
                           "instruction": "第一条简短一点", "displayed_group": {
                               "session_id": session["session_id"], "candidate_group_id": original["reply_request_id"],
                               "candidates": [{"number": 1, "candidate_id": candidate["candidate_id"], "version_id": version["version_id"]}],
                           }}
                before = self.backend.request(path)[1]
                self.reply_model.plans.append({"text": "最近好吗？", "basis": "只改变当前表达要求。"})
                status, prepared = self.backend.request(path + "/continue/prepare", command)
                self.assertEqual(status, 200, prepared)
                self.assertEqual(len(self.reply_model.payloads), 2)
                status, continued = self.backend.request(path + "/continue", command)
                self.assertEqual(status, 200, continued)
                self.assertEqual(continued["turn_id"], prepared["turn_id"])
                self.assertEqual(len(self.reply_model.payloads), 3)
                payload = self.reply_model.payloads[-1]
                self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], explored["options"][0]["intent"])
                self.assertEqual(payload["user_instruction"], "不要承诺；简短一点")
                self.assertEqual(payload["continuation_reference"]["version_id"], version["version_id"])
                self.assertEqual([item["text"] for item in payload["continuation_reference"]["messages"]],
                                 [item["text"] for item in version["messages"]])
                self.assertFalse(payload["continuation_reference"]["is_current_draft"])
                saved = self.backend.request(path)[1]
                self.assertEqual(saved["turns"][0], before["turns"][0])
                field = "direction_source" if scene == "response_exploration" else "purpose_source"
                self.assertEqual(saved["turns"][1]["input"]["content"][field], "confirmed_suggestion")
                self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
                self.assertEqual(len(self.reply_model.payloads), 3)
                # 下一轮仍只有原保存身份；中断恢复不重新伪确认原已完成 B 任务。
                followup = {**command, "idempotency_key": str(uuid4()),
                            "expected_input_version_id": continued["input_version_id"], "instruction": "自然一点"}
                status, held = self.backend.request(path + "/continue/prepare", followup)
                self.assertEqual(status, 200, held)
                status, stopped = self.backend.request(path + "/interrupt", {
                    "request_key": held["request_key"], "input_version_id": held["input_version_id"],
                })
                self.assertEqual(status, 200, stopped)
                self.assertEqual(stopped["interruption_reason"], "app_quit")
                retry = {"original_turn_id": held["turn_id"], "original_input_version_id": held["input_version_id"],
                         "request_key": str(uuid4())}
                status, reprepared = self.backend.request(path + "/retry-interrupted/prepare", retry)
                self.assertEqual(status, 200, reprepared)
                self.assertEqual(len(self.reply_model.payloads), 3)
                self.reply_model.plans.append({"text": "最近还好吗？", "basis": "继续原已确认意愿和表达要求。"})
                status, recovered = self.backend.request(path + "/retry-interrupted", retry)
                self.assertEqual(status, 200, recovered)
                self.assertEqual(recovered["turn_id"], reprepared["turn_id"])
                self.assertEqual(self.reply_model.payloads[-1]["user_instruction"], "不要承诺；简短一点；自然一点")
                self.assertEqual(self.reply_model.payloads[-1]["fidelity_contract"]["current_intent"]["text"], explored["options"][0]["intent"])
                self.assertEqual(recovered["restored_input"]["content"][field], "confirmed_suggestion")
                self.assertEqual(len(self.reply_model.payloads), 4)
                status, rejected = self.other_backend.request(path + "/retry-interrupted/prepare", retry)
                self.assertNotEqual(status, 200)
                self.assertNotIn("no_generation", rejected)
                status, deletion = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
                self.assertEqual(status, 202, deletion)
                deadline = time.monotonic() + 10
                deleted = False
                while time.monotonic() < deadline:
                    source_item = next(item for item in self.backend.request(f"/api/contacts/{contact}/sources")[1]["sources"]
                                       if item["source_id"] == source)
                    self.assertNotEqual(source_item["task_status"], "failed", source_item)
                    if source_item["status"] == "deleted" and source_item["task_status"] == "succeeded":
                        deleted = True
                        break
                    time.sleep(.02)
                self.assertTrue(deleted)
                erased = self.backend.request(path)[1]
                self.assertIsNone(erased["current_input_version_id"])
                self.assertTrue(all(turn["state"] == "redacted" and turn["input"] is None and turn["reply"] is None
                                    for turn in erased["turns"]))
                for endpoint, body in (("/continue", command), ("/retry-interrupted", retry),
                                       ("/continue/prepare", {**followup, "idempotency_key": str(uuid4())})):
                    self.assertNotEqual(self.backend.request(path + endpoint, body)[0], 200)
                self.assertEqual(self.backend.request(path)[1], erased)
                self.assertEqual(len(self.reply_model.payloads), 4)
                self.reply_model.payloads.clear()
                self.reply_model.plans.clear()
