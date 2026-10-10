"""单次纠正、表达要求与澄清答案通过既有HTTP生成链，不改确认立场。"""

import unittest
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class ExplorationGenerationFieldsHttpTest(FidelityHttpFixture, unittest.TestCase):
    def _body(self, scene):
        contact, target, _ = self.prepare_contact(self.owner_id, history=scene == "reply_to_message")
        content = ({"type": scene, "target_message_id": target, "direction": "婉拒这次邀请。"}
                   if scene == "reply_to_message" else {"type": scene, "purpose": "只了解近况，不安排见面。"})
        return {"contact_id": contact, "idempotency_key": str(uuid4()), "content": content, "skill_disabled": True}

    def test_both_scenes_deliver_user_fields_without_replacing_current_intent_and_replay_persistently(self):
        fields = {"understanding_correction": "只是合成近况话题，不承诺时间。",
                  "user_instruction": "用简短自然的句子。", "clarification_answer": "不承诺见面。"}
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                body = self._body(scene)
                body["content"].update(fields)
                status, session = self.backend.request(
                    f"/api/contacts/{body['contact_id']}/assistant-session/default", {}, method="POST",
                )
                self.assertEqual(status, 200, session)
                path = f"/api/contacts/{body['contact_id']}/assistant-sessions/{session['session_id']}"
                self.reply_model.plans.append({"text": "今天怎么样？", "basis": "按本次明确意图表达。"})
                status, reply = self.backend.request(path + "/replies", body)
                self.assertEqual(status, 200, reply)
                payload = self.reply_model.payloads[-1]
                for key, value in fields.items():
                    self.assertEqual(payload.get(key), value)
                primary = "confirmed_direction" if scene == "reply_to_message" else "confirmed_purpose"
                self.assertEqual(payload["fidelity_contract"]["current_intent"], {
                    "source": primary, "text": body["content"]["direction" if scene == "reply_to_message" else "purpose"],
                })
                self.assertFalse(any(item["text"] in fields.values() for item in payload["evidence"]))
                calls = len(self.reply_model.payloads)
                reopened = self._backend(self.owner_id)
                self.assertEqual(reopened.request(path + "/replies", body), (200, reply))
                saved = reopened.request(path)[1]
                for field, value in fields.items():
                    self.assertEqual(saved["turns"][0]["input"]["content"][field], value)
                for key in fields:
                    changed = {**body, "content": {**body["content"], key: "不同的合成本次声明。"}}
                    self.assertEqual(reopened.request(path + "/replies", changed)[0], 409)
                self.assertEqual(len(self.reply_model.payloads), calls)

    def test_invalid_once_only_fields_are_rejected_before_any_model_call(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            body = self._body(scene)
            for field in ("understanding_correction", "user_instruction", "clarification_answer"):
                for value in (True, [], "甲" * 4097):
                    with self.subTest(scene=scene, field=field, value_type=type(value).__name__):
                        self.assertEqual(self.backend.request("/api/reply/generate", {
                            **body, "content": {**body["content"], field: value},
                        })[0], 400)
        self.assertEqual(self.reply_model.payloads, [])
