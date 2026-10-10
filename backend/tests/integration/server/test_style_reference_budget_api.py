"""有界样本仍计入完整HTTP生成请求预算；只计量已声明的合成协议。"""

from __future__ import annotations

import json
import unittest
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.reply.input_budget import BudgetState
from tests.fidelity_http_support import FidelityHttpFixture
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class StyleReferenceBudgetApiTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = ExplorationControlledModel

    def setUp(self) -> None:
        self.budget_capacity, self.unknown_profile = 100000, False
        self.budget_records = []
        super().setUp()

    def _backend(self, owner_id):
        def configured(model):
            configuration = synthetic_budget_kwargs(model, capacity=self.budget_capacity)
            if self.unknown_profile:
                configuration["input_budget_profile"] = replace(configuration["input_budget_profile"],
                                                               context_window_tokens=None)
            decisions = []
            configuration["on_input_budget"] = decisions.append
            self.budget_records.append((configuration["input_token_counter"], decisions))
            return configuration

        with patch("tests.integration.server.core_business_flow_support.synthetic_budget_kwargs",
                   side_effect=configured):
            return super()._backend(owner_id)

    def _contact_body(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        return contact, {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                         "content": {"type": "initiate_conversation", "purpose": "拒绝本次合成邀约，不新增安排。"}}

    def _samples(self, contact):
        samples = {}
        for index in range(7):
            text = f"合成预算表达{index}：当然答应，明晚七点陪你去合成海边。"
            status, saved = self.backend.request(f"/api/contacts/{contact}/style-samples", {
                "idempotency_key": str(uuid4()), "text": text, "origin": {"kind": "manual"},
            })
            self.assertEqual(status, 200, saved)
            samples[saved["sample"]["sample_id"]] = text
        return samples

    def _output(self):
        return {"text": "这次不参加。", "basis": "当前拒绝优先，不扩写旧样本的承诺。"}

    def _references(self, measured, samples, intent):
        payload = next(json.loads(message["content"]) for message in measured["messages"]
                       if message.get("role") == "user")
        self.assertEqual(payload["fidelity_contract"]["current_intent"]["text"], intent)
        references = payload["style_references"]
        self.assertEqual(len(references), 5)
        self.assertLessEqual(sum(len(reference["text"]) for reference in references), 600)
        for reference in references:
            self.assertEqual(reference["text"], samples[reference["sample_id"]])
            self.assertEqual((reference["factual_role"], reference["weight"]), ("expression_reference", "low"))
        self.assertEqual(measured["max_tokens"], 4096)
        self.assertIn("ReplyRuntimeOutput", {tool["function"]["name"] for tool in measured["tools"]})
        return payload

    def test_samples_cross_total_limit_before_call_then_same_capacity_without_samples_allows_warning(self):
        contact, body = self._contact_body()
        self.reply_model.plans.append(self._output())
        self.assertEqual(self.backend.request("/api/reply/generate", body)[0], 200)
        baseline = next(decisions[0] for _, decisions in self.budget_records if decisions)
        self.assertIsInstance(baseline.total_tokens, int)
        samples = self._samples(contact)
        self.budget_capacity = baseline.total_tokens + 1
        limited = self._backend(self.owner_id)
        self.reply_model.plans.append(self._output())
        status, rejected = limited.request("/api/reply/generate", {**body, "idempotency_key": str(uuid4())})
        self.assertEqual((status, rejected), (502, {"error": "reply_budget_exceeded"}))
        counter, decisions = self.budget_records[-1]
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual(len(counter.seen_payloads), 1)
        self.assertEqual(decisions[0].state, BudgetState.EXCEEDED)
        self.assertGreater(decisions[0].total_tokens, self.budget_capacity)
        self._references(counter.seen_payloads[0], samples, body["content"]["purpose"])
        for sample_id in samples:
            self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")[0], 200)
        status, accepted = limited.request("/api/reply/generate", {**body, "idempotency_key": str(uuid4())})
        self.assertEqual(status, 200, accepted)
        self.assertEqual(accepted["context_receipt"]["style_sample_ids"], [])
        self.assertEqual(decisions[-1].state, BudgetState.WARNING)
        self.assertEqual(decisions[-1].total_tokens, baseline.total_tokens)
        self.assertEqual(len(self.reply_model.payloads), 2)
        self.assertEqual(counter.seen_payloads[-1], self.reply_model.seen_model_payloads[-1])

    def test_unknown_complete_measurement_with_samples_blocks_call_and_candidate_save(self):
        contact, body = self._contact_body()
        self._samples(contact)
        self.unknown_profile = True
        unavailable = self._backend(self.owner_id)
        self.reply_model.plans.append(self._output())
        self.assertEqual(unavailable.request("/api/reply/generate", body), (502, {"error": "reply_budget_exceeded"}))
        counter, decisions = self.budget_records[-1]
        self.assertEqual(self.reply_model.payloads, [])
        self.assertEqual(counter.seen_payloads, [])
        self.assertEqual(decisions[0].state, BudgetState.UNAVAILABLE)
        self.assertEqual(decisions[0].reason, "model_capability_unknown")
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s",
                                                (self.owner_id, contact)).fetchone()[0], 0)

    def test_actual_skill_tool_rechecks_whole_style_request_before_next_model_call(self):
        contact, body = self._contact_body()
        samples = self._samples(contact)
        skill, version = uuid4(), uuid4()
        name = f"synthetic-budget-{skill.hex[:8]}"
        content = "合成策略只辅助简短表达，不提供新事实或约定。" * 180
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
            connection.execute("""INSERT INTO public.reply_skill(id,owner_id,contact_id,name,description)
                VALUES (%s,%s,%s,%s,'合成预算策略')""", (skill, self.owner_id, contact, name))
            connection.execute("""INSERT INTO public.reply_skill_version
                (id,skill_id,version_number,name,description,content,enabled,is_current,status)
                VALUES (%s,%s,1,%s,'合成预算策略',%s,true,true,'active')""", (version, skill, name, content))
        body = {key: value for key, value in body.items() if key != "skill_disabled"}
        body["skill_version_id"] = str(version)
        self.reply_model.plans.extend([{"read_skill": name}, self._output()])
        status, generated = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["used_skill"]["version_id"], str(version))
        baseline = next(decisions for _, decisions in self.budget_records if decisions)
        self.assertEqual(len(baseline), 2)
        self.assertGreater(baseline[1].total_tokens, baseline[0].total_tokens + 100)
        self.budget_capacity = baseline[0].total_tokens + 100
        limited = self._backend(self.owner_id)
        self.reply_model.plans.extend([{"read_skill": name}, self._output()])
        status, rejected = limited.request("/api/reply/generate", {**body, "idempotency_key": str(uuid4())})
        self.assertEqual((status, rejected), (502, {"error": "reply_budget_exceeded"}))
        self.assertEqual(len(self.reply_model.payloads), 3)
        counter, decisions = self.budget_records[-1]
        self.assertEqual([decision.state for decision in decisions], [BudgetState.WARNING, BudgetState.EXCEEDED])
        self.assertEqual(len(counter.seen_payloads), 2)
        self.assertEqual(counter.seen_payloads[0], self.reply_model.seen_model_payloads[-1])
        for measured in counter.seen_payloads:
            self._references(measured, samples, body["content"]["purpose"])
        self.assertTrue(any(message.get("role") == "tool" and content in message.get("content", "")
                            for message in counter.seen_payloads[-1]["messages"]))
        self.assertEqual(len(self.reply_model.plans), 1)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s",
                                                (self.owner_id, contact)).fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
