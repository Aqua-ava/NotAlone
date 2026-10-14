"""存在表达样本时沿唯一UUID探索、真实Skill Tool及生成删除链验证。"""

from __future__ import annotations

import json
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class AuthenticExpressionSkillExplorationTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = ExplorationControlledModel

    def setUp(self) -> None:
        self.budget_counters = []
        super().setUp()

    def _backend(self, owner_id):
        def configured(model):
            configuration = synthetic_budget_kwargs(model)
            self.budget_counters.append(configuration["input_token_counter"])
            return configuration

        # 保留真实生产builder，仅观察显式合成计量器的最终出站输入。
        with patch("tests.integration.server.core_business_flow_support.synthetic_budget_kwargs",
                   side_effect=configured):
            return super()._backend(owner_id)

    def test_response_exploration_excludes_samples_and_actual_skill_generation_deletion_is_bounded(self):
        self._exercise("reply_to_message")

    def test_proactive_exploration_excludes_samples_and_actual_skill_generation_deletion_is_bounded(self):
        self._exercise("initiate_conversation")

    def _exercise(self, scene: str) -> None:
        contact, target, source = self.prepare_contact(self.owner_id)
        samples = {}
        for index in range(7):
            text = f"合成旧表达{index}：当然答应，明晚七点陪你去合成海边。"
            status, saved = self.backend.request(f"/api/contacts/{contact}/style-samples", {
                "idempotency_key": str(uuid4()), "text": text, "origin": {"kind": "manual"},
            })
            self.assertEqual(status, 200, saved)
            samples[saved["sample"]["sample_id"]] = text
        skill, version = uuid4(), uuid4()
        name = f"synthetic-fidelity-{skill.hex[:8]}"
        skill_text = "合成Skill专用标记：只辅助简短说法，当前拒绝优先，不新增约定。"
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
            connection.execute("""INSERT INTO public.reply_skill(id,owner_id,contact_id,name,description)
                VALUES (%s,%s,%s,%s,'合成表达策略')""", (skill, self.owner_id, contact, name))
            connection.execute("""INSERT INTO public.reply_skill_version
                (id,skill_id,version_number,name,description,content,enabled,is_current,status)
                VALUES (%s,%s,1,%s,'合成表达策略',%s,true,true,'active')""", (version, skill, name, skill_text))
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        content = ({"type": "response_exploration", "target_message_id": target} if scene == "reply_to_message" else
                   {"type": "purpose_exploration", "purpose_hint": "想简短回复这次合成邀请，但还没有确认意愿。"})
        correction, requirements = "这是合成邀请，没有已确认约定。", "保持简短，不新增感受。"
        body = {"operation_key": str(uuid4()), "content": {
            **content, "correction": correction, "requirements": requirements,
            "skill_mode": "user", "skill_version_id": str(version),
        }}
        intent = "拒绝这次合成邀请，不新增时间地点或陪同承诺。"
        options = [
            {"intent": intent, "label": "简短拒绝", "reason": "保留本次意愿。", "citation_ids": [],
             "recommended": False, "pause": False},
            {"intent": "暂不联系。", "label": "暂不联系", "reason": "尚未希望联系时适用。", "citation_ids": [],
             "recommended": False, "pause": True},
        ]
        self.reply_model.plans.extend([
            {"explore": {"options": options, "question": {"text": "是否承诺见面或陪同？", "impact": "commitment"}}},
            {"explore": {"options": options}},
            {"read_skill": name},
            {"text": "这次不参加。\n\n谢谢你邀请。", "messages": ["这次不参加。", "谢谢你邀请。"],
             "basis": "当前拒绝优先，只参考说法，不承接旧样本的约定。"},
        ])
        status, opened = self.backend.request(path + "/explorations", body)
        self.assertEqual(status, 200, opened)
        self.assertEqual(opened["kind"], "clarification")
        self.assertEqual(opened["used_skill"]["version_number"], 1)
        self.assertEqual(opened["skill_version_id"], str(version))
        self.assertIsNone(opened["confirmed_intent"])
        self.assertEqual(len(self.reply_model.payloads), 1)
        status, selected = self.backend.request(path + f"/explorations/{opened['exploration_id']}/confirm", {"generate": True,
            "input_version_id": opened["input_version_id"], "suggestion_id": opened["options"][0]["suggestion_id"],
        })
        self.assertEqual(status, 200, selected)
        self.assertEqual(selected["kind"], "clarification")
        self.assertEqual(selected["confirmed_intent"], intent)
        self.assertEqual(len(self.reply_model.payloads), 1)
        answer = {"generate": True, "input_version_id": selected["input_version_id"], "question_id": selected["question_id"],
                  "answer": "不陪同，不承诺见面、时间或地点。", "operation_key": str(uuid4())}
        answer_path = path + f"/explorations/{selected['exploration_id']}/answer"
        status, generated = self.backend.request(answer_path, answer)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["kind"], "generated")
        self.assertEqual(len(self.reply_model.payloads), 4)
        exploration = [payload for payload in self.reply_model.payloads if payload["input_mode"] == "direction_exploration"]
        self.assertEqual(len(exploration), 2)
        self.assertEqual(len(self.reply_model.seen_model_payloads), 4)
        for payload in exploration:
            self.assertFalse(payload.get("style_references"))
            self.assertEqual(payload["skill"]["version_id"], str(version))
            encoded = json.dumps(payload, ensure_ascii=False)
            self.assertTrue(all(sample_id not in encoded and text not in encoded for sample_id, text in samples.items()))
        for actual_request in self.reply_model.seen_model_payloads[:2]:
            encoded = json.dumps(actual_request, ensure_ascii=False)
            self.assertTrue(all(sample_id not in encoded and text not in encoded for sample_id, text in samples.items()))
        turn = generated["turn"]
        self.assertEqual(turn["state"], "completed")
        self.assertEqual(turn["used_skill"]["version_id"], str(version))
        self.assertEqual(turn["used_skill"]["load_state"], "loaded")
        final = self.reply_model.payloads[-1]
        self.assertEqual(final["fidelity_contract"]["current_intent"]["text"], intent)
        self.assertEqual(final["understanding_correction"], correction)
        self.assertEqual(final["user_instruction"], requirements)
        self.assertEqual(final["clarification_answer"], answer["answer"])
        self.assertEqual(final["skill_selection"], {"mode": "user", "version_id": str(version)})
        references = final["style_references"]
        self.assertEqual(len(references), 5)
        self.assertLessEqual(sum(len(reference["text"]) for reference in references), 600)
        used = {reference["sample_id"] for reference in references}
        self.assertLessEqual(used, samples.keys())
        for reference in references:
            self.assertEqual(reference["text"], samples[reference["sample_id"]])
            self.assertEqual((reference["factual_role"], reference["weight"]), ("expression_reference", "low"))
        self.assertEqual(set(turn["context_receipt"]["style_sample_ids"]), used)
        self.assertTrue(used.isdisjoint(turn["context_receipt"]["evidence_ids"]))
        self.assertTrue(all(item["text"] not in samples.values() for item in final["evidence"]))
        messages = turn["candidates"][0]["messages"]
        self.assertEqual([message["text"] for message in messages], ["这次不参加。", "谢谢你邀请。"])
        self.assertEqual(len({UUID(message["message_id"]) for message in messages}), 2)
        self.assertTrue(any(message.type == "tool" and skill_text in str(message.content)
                            for message in self.reply_model.seen_calls[-1]))
        measured = [payload for counter in self.budget_counters for payload in counter.seen_payloads
                    if any(message.get("role") == "user" and isinstance(message.get("content"), str)
                           and json.loads(message["content"]).get("input_mode") == scene
                           for message in payload["messages"])]
        self.assertEqual(measured, self.reply_model.seen_model_payloads[2:])
        self.assertEqual(len(measured), 2)
        self.assertTrue(all(payload["max_tokens"] == 4096 for payload in measured))
        current = self._get(self.backend, path)
        reopened = self._backend(self.owner_id)
        self.assertEqual(reopened.request(answer_path, answer), (200, generated))
        self.assertEqual(self._get(reopened, path), current)
        self.assertEqual(len(self.reply_model.payloads), 4)
        self.assertEqual(len(current["turns"]), 1)
        self.assertEqual(current["turns"][0]["reply"]["candidates"][0]["messages"], messages)

        removed = sorted(used)[0]
        self.assertEqual(reopened.request(f"/api/contacts/{contact}/style-samples/{removed}", method="DELETE")[0], 200)
        after = self._get(self._backend(self.owner_id), path)
        self.assertEqual(after["turns"][0]["state"], "redacted")
        self.assertIsNone(after["turns"][0]["input"])
        self.assertIsNone(after["turns"][0]["reply"])
        self.assertNotEqual(reopened.request(answer_path, answer)[0], 200)
        self.assertNotEqual(reopened.request(f"/api/contacts/{contact}/replies/{turn['reply_request_id']}/evidence")[0], 200)
        self.assertEqual({item["sample_id"] for item in self._get(reopened, f"/api/contacts/{contact}/style-samples")["samples"]},
                         samples.keys() - {removed})
        raw = next(item for item in self._get(reopened, f"/api/contacts/{contact}/sources")["sources"] if item["source_id"] == source)
        self.assertEqual(raw["status"], "active")
        self.assertEqual(len(self.reply_model.payloads), 4)


if __name__ == "__main__":
    unittest.main()
