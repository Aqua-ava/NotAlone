"""实际 HTTP 中断后明确重试与选定Skill组合；不运行真实宿主退出。"""

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
            pending = pool.submit(self.backend.request, endpoint, {**confirmation, "generate": True}, timeout=20)
            try:
                self.assertTrue(self.reply_model.entered.wait(5), "生成必须先真实进入受控模型。")
                before = self._get(self.backend, path)
                self.assertEqual(len(before["turns"]), 1)
                turn = before["turns"][0]
                self.assertEqual(turn["input"]["content"]["suggestion"]["task_id"], parent["exploration_id"])
                self.assertEqual(turn["state"], "running")
                actual = self.reply_model.payloads[-1]
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


    def test_reconfirmed_skill_keeps_current_intent_and_selected_version(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                start = len(self.reply_model.payloads)
                path, parent, old_turn, confirmation, _ = self._interrupted(scene)
                exploration = [payload for payload in self.reply_model.payloads[start:]
                               if payload.get("input_mode") == "direction_exploration"]
                self.assertEqual(len(exploration), 1)
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
                self.assertEqual(generated["used_skill"]["version_id"], receipt["skill_version_id"])
                self.assertEqual(len(self.reply_model.payloads), calls + 2)
                actual = self.reply_model.payloads[-1]
                self.assertEqual(actual["fidelity_contract"]["current_intent"]["text"], "只了解近况，不承诺见面。")
                rebuilt = self._backend(self.owner_id)
                self.assertEqual(rebuilt.request(path + "/replies", body), (200, generated))
                self.assertEqual(len(self.reply_model.payloads), calls + 2)
