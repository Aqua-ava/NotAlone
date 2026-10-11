"""实际 HTTP 中断后明确重试与表达参考组合；不运行真实宿主退出。"""

import json
import unittest
from concurrent.futures import ThreadPoolExecutor

import psycopg
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server import test_persistent_reply_exploration as exploration_support
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class InterruptibleExplorationModel(ExplorationControlledModel):
    def wait_for_response(self) -> None:
        # read_skill 也沿既有模型门等待，让测试只在实际生成已进入后发起中断。
        gate = self.response_gates.get(len(self.seen_calls))
        if gate is not None and not gate.is_set():
            self.entered.set()
        super().wait_for_response()


class AuthenticExpressionReconfirmationTests(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = InterruptibleExplorationModel

    def _interrupted(self, scene):
        path, body, source = exploration_support.PersistentExplorationHttpTest._prepare(self, scene)
        _, version, name = exploration_support.PersistentExplorationHttpTest._skill(self, path)
        body["content"].update(skill_mode="user", skill_version_id=version)
        self.reply_model.plans.append({"explore": {}})
        parent = exploration_support.PersistentExplorationHttpTest._open(self, path, body)
        confirmation = {"input_version_id": parent["input_version_id"],
                        "suggestion_id": parent["options"][0]["suggestion_id"]}
        unused_candidate = {"text": "最近还好吗？", "basis": "只了解近况，不增加见面承诺。"}
        self.reply_model.plans.extend([{"read_skill": name}, unused_candidate])
        self.reply_model.entered.clear()
        gate = self.reply_model.pause_next_response()
        endpoint = path + f"/explorations/{parent['exploration_id']}/confirm"
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, endpoint, confirmation, timeout=20)
            try:
                self.assertTrue(self.reply_model.entered.wait(5), "生成必须先真实进入受控模型。")
                before = self._get(self.backend, path)
                self.assertEqual(len(before["turns"]), 1)
                turn = before["turns"][0]
                self.assertEqual(turn["input"]["content"]["suggestion"]["task_id"], parent["exploration_id"])
                self.assertEqual(turn["state"], "running")
                actual = self.reply_model.payloads[-1]
                self.assertEqual([item["sample_id"] for item in actual["style_references"]], [self.sample_id])
                interruption = {"request_key": turn["request_key"], "input_version_id": turn["input_version_id"]}
                status, receipt = self.backend.request(path + "/interrupt", interruption)
                self.assertEqual(status, 200, receipt)
                self.assertEqual(receipt, {"session_id": parent["session_id"], "turn_id": turn["turn_id"],
                    **interruption, "state": "failed", "interruption_reason": "app_quit"})
                self.assertEqual(self.backend.request(path + "/interrupt", interruption), (200, receipt))
                interrupted = self._get(self.backend, path)
                self.assertEqual(interrupted["current_input_version_id"], turn["input_version_id"])
                self.assertEqual(interrupted["turns"][0]["interruption_reason"], "app_quit")
                self.assertIsNone(interrupted["turns"][0]["reply"])
            finally:
                gate.set()
            late_status, late = pending.result(timeout=10)
        self.assertNotEqual(late_status, 200, late)
        # HTTP 只持久化失效；供应商迟到工作允许结束，真实宿主停止不由本夹具代替。
        with psycopg.connect(self.database_url) as connection:
            state = connection.execute(
                "SELECT request.state, attempt.state, attempt.failure_reason, "
                "(SELECT count(*) FROM public.reply_candidate WHERE reply_request_id=request.id) "
                "FROM public.reply_request AS request JOIN public.reply_attempt AS attempt "
                "ON attempt.reply_request_id=request.id AND attempt.number=request.attempt "
                "WHERE request.owner_id=%s AND request.contact_id=%s AND request.idempotency_key=%s",
                (self.owner_id, path.split("/")[3], turn["request_key"]),
            ).fetchone()
        self.assertEqual(state, ("failed", "failed", "app_quit", 0))
        self.reply_model.plans.clear()
        calls = len(self.reply_model.payloads)
        rebuilt = self._backend(self.owner_id)
        restored = self._get(rebuilt, path)
        self.assertEqual(restored, interrupted)
        self.assertEqual(rebuilt.request(path + "/interrupt", interruption), (200, receipt))
        content = dict(turn["input"]["content"])
        reference = content.pop("suggestion")
        old_request = {**turn["input"], "content": content, "suggestion": reference,
                       "contact_id": path.split("/")[3], "idempotency_key": turn["request_key"],
                       "expected_input_version_id": turn["input_version_id"]}
        for suffix in ("/replies/prepare", "/replies"):
            self.assertEqual(rebuilt.request(path + suffix, old_request), (
                409, {"error": "assistant_session_rejected", "reason": "generation_interrupted"},
            ))
        self.assertEqual(self._get(rebuilt, path), restored)
        self.assertEqual(len(self.reply_model.payloads), calls, "恢复与中断重放不能调用模型。")
        return path, parent, restored["turns"][0], confirmation, source

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
                path, parent, old_turn, confirmation, _ = self._interrupted(scene)
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
                    self.assertIsNone(turn["interruption_reason"])
                self.assertEqual(rebuilt.request(path + "/interrupt", {
                    "request_key": old_turn["request_key"], "input_version_id": old_turn["input_version_id"],
                }), (409, {"error": "assistant_session_rejected", "reason": "source_deleted"}))
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
