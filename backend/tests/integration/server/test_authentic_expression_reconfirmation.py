"""明确重试与表达参考组合；中断凭证复用 B 的合成适配，非 A 中断验收。"""

import json
import unittest

import psycopg
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server import test_exploration_reconfirmation as reconfirmation_support
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class AuthenticExpressionReconfirmationTests(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel
    _interrupted = reconfirmation_support.ExplorationReconfirmationHttpTest._interrupted

    def prepare_contact(self, owner_id, *, history=True):
        prepared = super().prepare_contact(owner_id, history=history)
        status, sample = self.backend.request(f"/api/contacts/{prepared[0]}/style-samples", {
            "idempotency_key": str(uuid4()), "text": "合成独立表达参考：好呀，一定见面。",
            "origin": {"kind": "manual"},
        })
        self.assertEqual(status, 200, sample)
        self.sample_id = sample["sample"]["sample_id"]
        return prepared

    def test_reconfirmed_skill_keeps_current_intent_and_sample_deletion_blocks_recovery(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                start = len(self.reply_model.payloads)
                path, parent, old_turn, confirmation, _ = self._interrupted(scene, user_skill=True)
                sample_id = self.sample_id
                exploration = [payload for payload in self.reply_model.payloads[start:]
                               if payload.get("input_mode") == "direction_exploration"]
                self.assertEqual(len(exploration), 1)
                self.assertNotIn(sample_id, json.dumps(exploration, ensure_ascii=False))
                self.assertNotIn("合成独立表达参考", json.dumps(exploration, ensure_ascii=False))
                calls = len(self.reply_model.payloads)
                endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
                request = {**confirmation, "request_key": str(uuid4()),
                           "expected_input_version_id": old_turn["input_version_id"]}
                status, receipt = self.backend.request(endpoint, request)
                self.assertEqual(status, 200, receipt)
                self.assertEqual(len(self.reply_model.payloads), calls)
                self.assertEqual(receipt["skill_version_id"], parent["skill_version_id"])
                content = dict(old_turn["input"]["content"])
                content.pop("suggestion")
                body = {**old_turn["input"], "content": content, "contact_id": path.split("/")[3],
                        "idempotency_key": receipt["request_key"],
                        "expected_input_version_id": receipt["input_version_id"],
                        "suggestion": {"task_id": receipt["exploration_id"],
                                       "input_version": receipt["input_version_id"],
                                       "suggestion_id": receipt["suggestion_id"]}}
                self.reply_model.plans.extend([{"read_skill": parent["used_skill"]["name"]},
                    {"text": "最近还好吗？", "basis": "仅了解近况，不增加见面承诺。"}])
                status, generated = self.backend.request(path + "/replies", body)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["context_receipt"]["style_sample_ids"], [sample_id])
                self.assertEqual(generated["used_skill"]["version_id"], receipt["skill_version_id"])
                self.assertEqual(len(self.reply_model.payloads), calls + 2)
                actual = self.reply_model.payloads[-1]
                self.assertEqual(actual["fidelity_contract"]["current_intent"]["text"], "只了解近况，不承诺见面。")
                self.assertEqual([item["sample_id"] for item in actual["style_references"]], [sample_id])
                rebuilt = self._backend(self.owner_id)
                self.assertEqual(rebuilt.request(path + "/replies", body), (200, generated))
                self.assertEqual(len(self.reply_model.payloads), calls + 2)
                self.assertEqual(rebuilt.request(f"/api/contacts/{body['contact_id']}/style-samples/{sample_id}",
                                                 method="DELETE")[0], 200)
                restored = self._get(self._backend(self.owner_id), path)
                self.assertIsNone(restored["current_input_version_id"])
                for turn in restored["turns"]:
                    self.assertEqual(turn["state"], "redacted")
                    self.assertIsNone(turn["input"])
                    self.assertIsNone(turn["reply"])
                self.assertNotEqual(rebuilt.request(path + "/replies", body)[0], 200)
                # 真实新生成键沿旧 B 引用请求；CURRENT 已清空，不能重新激活历史讨论输入。
                fresh_generation = {**body, "idempotency_key": str(uuid4())}
                # HTTP 的空 expected 以省略字段表示；显式 null 会在解析层拒绝。
                fresh_generation.pop("expected_input_version_id")
                self.assertEqual(rebuilt.request(path + "/replies", fresh_generation),
                                 (409, {"error": "assistant_session_rejected", "reason": "input_version_stale"}))
                # 样本只参与生成；无样本依赖的 B 讨论回执允许只读重放，不能推进当前指针。
                self.assertEqual(rebuilt.request(endpoint, request), (200, receipt))
                self.assertNotEqual(rebuilt.request(endpoint, {**request, "request_key": str(uuid4())})[0], 200)
                with psycopg.connect(self.database_url) as connection:
                    rows = connection.execute(
                        "SELECT id,input_type,state,content FROM public.assistant_session_input "
                        "WHERE owner_id=%s AND contact_id=%s AND session_id=%s",
                        (self.owner_id, body["contact_id"], parent["session_id"]),
                    ).fetchall()
                inputs = {str(row[0]): row[1:] for row in rows}
                for input_id in (parent["input_version_id"], receipt["input_version_id"]):
                    kind, state, content = inputs[input_id]
                    self.assertNotEqual(kind, "generation")
                    self.assertEqual(state, "active")
                    self.assertNotIn(sample_id, json.dumps(content))
                    self.assertNotIn("合成独立表达参考", json.dumps(content, ensure_ascii=False))
                for input_id in (old_turn["input_version_id"], generated["input_version_id"]):
                    self.assertEqual(inputs[input_id], ("generation", "redacted", None))
                self.assertEqual(self._get(rebuilt, path), restored)
                self.assertEqual(len(self.reply_model.payloads), calls + 2)
