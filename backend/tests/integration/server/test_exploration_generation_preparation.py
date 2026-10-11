"""方向确认的准备回执沿公开 HTTP 和 A 唯一生成领取，不提前调用候选模型。"""

import unittest
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


RECEIPT_KEYS = {"session_id", "turn_id", "request_key", "input_version_id", "state"}


class ExplorationGenerationPreparationHttpTest(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    def _open(self, scene, *, plan=None):
        contact, target, source = self.prepare_contact(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        content = ({"type": "response_exploration", "target_message_id": target}
                   if scene == "reply_to_message" else {"type": "purpose_exploration", "purpose_hint": "想了解合成近况。"})
        self.reply_model.plans.append({"explore": plan or {}})
        status, explored = self.backend.request(path + "/explorations", {
            "operation_key": str(uuid4()), "content": {**content, "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200, explored)
        return path, explored, source

    @staticmethod
    def _confirmation(explored, index=0):
        return {"input_version_id": explored["input_version_id"],
                "suggestion_id": explored["options"][index]["suggestion_id"]}

    def test_both_scene_confirmations_prepare_actual_identity_before_the_candidate_model(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                path, explored, _ = self._open(scene)
                action = path + f"/explorations/{explored['exploration_id']}"
                confirmation = self._confirmation(explored)
                before_calls = len(self.reply_model.payloads)

                status, result = self.backend.request(action + "/prepare-confirm", confirmation)

                self.assertEqual(status, 200, result)
                self.assertEqual(set(result), {"kind", "exploration_id", "generation"})
                self.assertEqual(result["kind"], "prepared")
                self.assertEqual(result["exploration_id"], explored["exploration_id"])
                receipt = result["generation"]
                self.assertEqual(set(receipt), RECEIPT_KEYS)
                self.assertEqual(receipt["state"], "running")
                self.assertEqual(receipt["session_id"], explored["session_id"])
                self.assertNotEqual(receipt["input_version_id"], explored["input_version_id"])
                self.assertEqual(len(self.reply_model.payloads), before_calls)
                saved = self.backend.request(path)[1]
                self.assertEqual(saved["current_input_version_id"], receipt["input_version_id"])
                self.assertEqual(len(saved["turns"]), 1)
                turn = saved["turns"][0]
                for field in ("turn_id", "request_key", "input_version_id", "state"):
                    self.assertEqual(turn[field], receipt[field])
                self.assertEqual(self._backend(self.owner_id).request(action + "/prepare-confirm", confirmation),
                                 (200, result))
                self.assertEqual(len(self.reply_model.payloads), before_calls)

                self.reply_model.plans.append({"text": "最近过得怎么样？", "basis": "只延续这次明确意愿。"})
                status, generated = self.backend.request(action + "/confirm", confirmation)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["kind"], "generated")
                for field in ("turn_id", "input_version_id"):
                    self.assertEqual(generated["turn"][field], receipt[field])
                self.assertEqual(self.backend.request(path)[1]["turns"][0]["request_key"], receipt["request_key"])
                self.assertEqual(len(self.reply_model.payloads), before_calls + 1)
                self.assertEqual(self.backend.request(action + "/confirm", confirmation), (200, generated))
                self.assertEqual(self.backend.request(action + "/prepare-confirm", confirmation),
                                 (200, {**result, "generation": {**receipt, "state": "completed"}}))
                self.assertEqual(len(self.reply_model.payloads), before_calls + 1)

    def test_answer_only_prepares_when_the_server_already_has_a_clear_confirmed_intent(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            for confirmed, clear in ((False, True), (True, False), (True, True)):
                with self.subTest(scene=scene, confirmed=confirmed, clear=clear):
                    question = {"text": "这次是否安排见面？", "impact": "commitment"}
                    path, explored, _ = self._open(scene, plan={"question": question})
                    action = path + f"/explorations/{explored['exploration_id']}"
                    if confirmed:
                        status, pending = self.backend.request(action + "/prepare-confirm", self._confirmation(explored))
                        self.assertEqual(status, 200, pending)
                        self.assertEqual(pending["kind"], "clarification")
                        self.assertEqual(self.backend.request(path)[1]["turns"], [])
                    request = {"input_version_id": explored["input_version_id"], "question_id": explored["question_id"],
                               "answer": "不安排见面，只了解近况。", "operation_key": str(uuid4())}
                    plan = {} if clear else {"question": question, "ambiguities": ["尚未确定联系的具体目的。"]}
                    self.reply_model.plans.append({"explore": plan})
                    before_calls = len(self.reply_model.payloads)
                    status, prepared = self.backend.request(action + "/prepare-answer", request)
                    self.assertEqual(status, 200, prepared)
                    self.assertEqual(len(self.reply_model.payloads), before_calls + 1)
                    saved = self.backend.request(path)[1]
                    if not (confirmed and clear):
                        self.assertEqual(prepared["kind"], "directions" if clear else "clarification")
                        self.assertEqual(saved["turns"], [])
                        if not confirmed:
                            self.assertIsNone(prepared["confirmed_intent"])
                        self.assertEqual(self.backend.request(action + "/prepare-answer", request), (200, prepared))
                        self.assertEqual(len(self.reply_model.payloads), before_calls + 1)
                        continue
                    self.assertEqual(set(prepared), {"kind", "exploration_id", "generation"})
                    self.assertEqual(prepared["kind"], "prepared")
                    self.assertNotEqual(prepared["exploration_id"], explored["exploration_id"])
                    receipt = prepared["generation"]
                    self.assertEqual(set(receipt), RECEIPT_KEYS)
                    self.assertEqual(saved["session_id"], receipt["session_id"])
                    turn = saved["turns"][0]
                    for field in ("turn_id", "request_key", "input_version_id", "state"):
                        self.assertEqual(turn[field], receipt[field])
                    content = turn["input"]["content"]
                    self.assertEqual(content["clarification_answer"], request["answer"])
                    self.assertEqual(content["suggestion"]["task_id"], prepared["exploration_id"])
                    self.assertEqual(content["suggestion"]["suggestion_id"], self._confirmation(explored)["suggestion_id"])
                    self.assertEqual(self._backend(self.owner_id).request(action + "/prepare-answer", request), (200, prepared))
                    self.assertEqual(len(self.reply_model.payloads), before_calls + 1)
                    self.reply_model.plans.append({"text": "最近还好吗？", "basis": "只延续服务器已确认的意愿。"})
                    status, generated = self.backend.request(action + "/answer", request)
                    self.assertEqual(status, 200, generated)
                    self.assertEqual(generated["turn"]["turn_id"], receipt["turn_id"])
                    self.assertEqual(len(self.reply_model.payloads), before_calls + 2)
                    self.assertEqual(self.backend.request(action + "/prepare-answer", request),
                                     (200, {**prepared, "generation": {**receipt, "state": "completed"}}))
                    self.assertEqual(len(self.reply_model.payloads), before_calls + 2)

    def test_prepared_interruption_and_source_deletion_refuse_the_old_execution_without_a_model(self):
        for source_deleted in (False, True):
            with self.subTest(source_deleted=source_deleted):
                path, explored, source = self._open("reply_to_message")
                action = path + f"/explorations/{explored['exploration_id']}"
                confirmation = {"input_version_id": explored["input_version_id"], "direct_intent": "只了解近况，不安排见面。"}
                status, prepared = self.backend.request(action + "/prepare-confirm", confirmation)
                self.assertEqual(status, 200, prepared)
                receipt = prepared["generation"]
                before_calls = len(self.reply_model.payloads)
                if source_deleted:
                    status, deleted = self.backend.request(f"/api/contacts/{path.split('/')[3]}/sources/{source}", method="DELETE")
                    self.assertEqual(status, 202, deleted)
                else:
                    status, interrupted = self.backend.request(path + "/interrupt", {
                        "request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"],
                    })
                    self.assertEqual(status, 200, interrupted)
                    self.assertEqual(interrupted, {**receipt, "state": "failed", "interruption_reason": "app_quit"})
                for endpoint in ("prepare-confirm", "confirm"):
                    status, rejected = self.backend.request(action + "/" + endpoint, confirmation)
                    self.assertEqual(status, 409, rejected)
                self.assertEqual(len(self.reply_model.payloads), before_calls)
                if source_deleted:
                    continue
                status, reconfirmed = self.backend.request(action + "/reconfirm", {
                    **confirmation, "expected_input_version_id": receipt["input_version_id"], "request_key": str(uuid4()),
                })
                self.assertEqual(status, 200, reconfirmed)
                retry_action = path + f"/explorations/{reconfirmed['exploration_id']}"
                retry_confirmation = {"input_version_id": reconfirmed["input_version_id"],
                                      "direct_intent": confirmation["direct_intent"]}
                status, retry = self.backend.request(retry_action + "/prepare-confirm", retry_confirmation)
                self.assertEqual(status, 200, retry)
                self.assertNotEqual(retry["generation"]["turn_id"], receipt["turn_id"])
                self.assertEqual(retry["generation"]["request_key"], reconfirmed["request_key"])
                self.assertEqual(len(self.reply_model.payloads), before_calls)

    def test_completed_preparation_replay_does_not_rewind_a_later_current_input(self):
        path, explored, _ = self._open("initiate_conversation")
        action = path + f"/explorations/{explored['exploration_id']}"
        confirmation = self._confirmation(explored)
        status, prepared = self.backend.request(action + "/prepare-confirm", confirmation)
        self.assertEqual(status, 200, prepared)
        self.reply_model.plans.append({"text": "最近怎么样？", "basis": "只表达这次已确认意愿。"})
        status, completed = self.backend.request(action + "/confirm", confirmation)
        self.assertEqual(status, 200, completed)
        self.reply_model.plans.append({"explore": {}})
        status, newer = self.backend.request(path + "/explorations", {
            "operation_key": str(uuid4()), "expected_input_version_id": prepared["generation"]["input_version_id"],
            "content": {"type": "purpose_exploration", "purpose_hint": "另一个合成任务。", "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200, newer)
        before = self.backend.request(path)[1]
        before_calls = len(self.reply_model.payloads)
        self.assertEqual(self._backend(self.owner_id).request(action + "/prepare-confirm", confirmation),
                         (200, {**prepared, "generation": {**prepared["generation"], "state": "completed"}}))
        self.assertEqual(self.backend.request(action + "/confirm", confirmation), (200, completed))
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(before["current_input_version_id"], newer["input_version_id"])
        self.assertEqual(len(self.reply_model.payloads), before_calls)

    def test_preparation_rejects_cross_scope_and_extra_fields_without_receiving_generation(self):
        path, explored, _ = self._open("reply_to_message")
        endpoint = path + f"/explorations/{explored['exploration_id']}/prepare-confirm"
        confirmation = self._confirmation(explored)
        before = self.backend.request(path)[1]
        before_calls = len(self.reply_model.payloads)
        self.assertEqual(self.other_backend.request(endpoint, confirmation)[0], 409)
        self.assertEqual(self.backend.request(endpoint.replace(explored["session_id"], str(uuid4())), confirmation)[0], 409)
        for extra in ({"request_key": str(uuid4())}, {"prepare_only": True}, {"input_version_id": None}):
            self.assertEqual(self.backend.request(endpoint, {**confirmation, **extra})[0], 400)
        self.assertEqual(self.backend.request(endpoint, confirmation, method="GET")[0], 405)
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(len(self.reply_model.payloads), before_calls)
