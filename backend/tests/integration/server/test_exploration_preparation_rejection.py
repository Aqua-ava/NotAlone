"""已确认策略的准备拒绝证明必须绑定原公开命令，不猜服务器执行键。"""

import unittest
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class ExplorationPreparationRejectionHttpTests(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    def _open(self, *, question=False):
        contact, _, _ = self.prepare_contact(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        operation = str(uuid4())
        self.reply_model.plans.append({"explore": {"question": {"text": "是否安排见面？", "impact": "commitment"}} if question else {}})
        status, explored = self.backend.request(path + "/explorations", {
            "operation_key": operation, "content": {"type": "purpose_exploration", "purpose_hint": "只了解合成近况。",
                                                       "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200, explored)
        return contact, path, explored, operation

    def _confirmation(self, explored):
        return {"input_version_id": explored["input_version_id"], "suggestion_id": explored["options"][0]["suggestion_id"]}

    def test_confirm_prepare_rejection_proves_actual_key_and_binds_original_command(self):
        contact, path, explored, operation = self._open()
        action = path + f"/explorations/{explored['exploration_id']}"
        command = self._confirmation(explored)
        before = self.backend.request(path)[1]
        # 合成输入设置原无正文失效屏障；不读私表结果作为验收输出或猜实际生成键。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) "
                "SELECT owner_id,contact_id,request_key FROM public.reply_exploration "
                "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                (self.owner_id, UUID(contact), UUID(explored["exploration_id"])),
            )
        status, result = self.backend.request(action + "/prepare-confirm", command)
        self.assertEqual(status, 409, result)
        self.assertEqual(set(result), {"error", "reason", "no_generation", "exploration_preparation"})
        self.assertEqual(result["reason"], "request_deleted")
        proof = result["no_generation"]
        self.assertEqual(set(proof), {"contact_id", "session_id", "request_key", "state"})
        self.assertEqual(proof["contact_id"], contact)
        self.assertEqual(proof["session_id"], explored["session_id"])
        self.assertEqual(proof["state"], "not_reserved")
        self.assertEqual(str(UUID(proof["request_key"])), proof["request_key"])
        self.assertNotEqual(proof["request_key"], operation)
        self.assertEqual(result["exploration_preparation"], {
            "exploration_id": explored["exploration_id"], "input_version_id": explored["input_version_id"],
            "action": "prepare-confirm", "operation_key": None,
        })
        self.assertEqual(self.backend.request(action + "/prepare-confirm", command), (409, result))
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(len(self.reply_model.payloads), 1)
        rejected = self.backend.request(action + "/confirm", command)
        self.assertNotEqual(rejected[0], 200)
        self.assertNotIn("no_generation", rejected[1])
        self.assertNotIn("no_generation", self.other_backend.request(action + "/prepare-confirm", command)[1])
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_existing_actual_generation_does_not_get_a_confirmed_zero_reservation_proof(self):
        _, path, explored, _ = self._open()
        action = path + f"/explorations/{explored['exploration_id']}"
        command = self._confirmation(explored)
        status, prepared = self.backend.request(action + "/prepare-confirm", command)
        self.assertEqual(status, 200, prepared)
        receipt = prepared["generation"]
        status, interrupted = self.backend.request(path + "/interrupt", {
            "request_key": receipt["request_key"], "input_version_id": receipt["input_version_id"],
        })
        self.assertEqual(status, 200, interrupted)
        before = self.backend.request(path)[1]
        status, rejected = self.backend.request(action + "/prepare-confirm", command)
        self.assertEqual(status, 409, rejected)
        self.assertNotIn("no_generation", rejected)
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_answer_proof_binds_operation_after_actual_exploration_without_candidate_generation(self):
        _, path, explored, _ = self._open(question=True)
        action = path + f"/explorations/{explored['exploration_id']}"
        status, confirmed = self.backend.request(action + "/prepare-confirm", self._confirmation(explored))
        self.assertEqual(status, 200, confirmed)
        self.assertEqual(confirmed["kind"], "clarification")
        operation = str(uuid4())
        # 仅给本合成应答的新 B task 设置既有失效键输入，不读取私表作为业务输出。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL("""CREATE FUNCTION synthetic_answer_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.operation_key = {} THEN
                        INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key)
                        VALUES(NEW.owner_id,NEW.contact_id,NEW.request_key);
                    END IF;
                    RETURN NEW;
                END $$""").format(sql.Literal(UUID(operation))))
            connection.execute("CREATE TRIGGER synthetic_answer_barrier AFTER INSERT ON public.reply_exploration "
                               "FOR EACH ROW EXECUTE FUNCTION synthetic_answer_barrier()")
        body = {"input_version_id": explored["input_version_id"], "question_id": explored["question_id"],
                "answer": "本次不安排见面。", "operation_key": operation}
        self.reply_model.plans.append({"explore": {}})
        status, rejected = self.backend.request(action + "/prepare-answer", body)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["reason"], "request_deleted")
        self.assertEqual(rejected["exploration_preparation"], {
            "exploration_id": explored["exploration_id"], "input_version_id": explored["input_version_id"],
            "action": "prepare-answer", "operation_key": operation,
        })
        self.assertNotEqual(rejected["no_generation"]["request_key"], operation)
        self.assertEqual(len(self.reply_model.payloads), 2, "只发生两次实际B探索，不发生候选生成。")
        before = self.backend.request(path)[1]
        self.assertEqual(before["turns"], [])
        self.assertEqual(self.backend.request(action + "/prepare-answer", body), (409, rejected))
        status, execution = self.backend.request(action + "/answer", body)
        self.assertNotEqual(status, 200)
        self.assertNotIn("no_generation", execution)
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(len(self.reply_model.payloads), 2)
