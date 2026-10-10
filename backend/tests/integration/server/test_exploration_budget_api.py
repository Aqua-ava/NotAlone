"""两场景探索在公开HTTP按实际完整请求拒绝未知与超限能力。"""

import json
import unittest
from dataclasses import replace
from unittest.mock import patch
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class ExplorationBudgetApiTest(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = ExplorationControlledModel

    def setUp(self):
        self.capacity, self.unknown = 100000, False
        self.records = []
        super().setUp()

    def _backend(self, owner_id):
        def configured(model):
            configuration = synthetic_budget_kwargs(model, capacity=self.capacity)
            if self.unknown:
                configuration["input_budget_profile"] = replace(configuration["input_budget_profile"],
                                                                context_window_tokens=None)
            decisions = []
            configuration["on_input_budget"] = decisions.append
            self.records.append((configuration["input_token_counter"], decisions))
            return configuration

        with patch("tests.integration.server.core_business_flow_support.synthetic_budget_kwargs", side_effect=configured):
            return super()._backend(owner_id)

    def _request(self, scene):
        contact, target, _ = self.prepare_contact(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        content = ({"type": "response_exploration", "target_message_id": target} if scene == "reply_to_message" else
                   {"type": "purpose_exploration", "purpose_hint": "合成目的仍需明确。"})
        return contact, f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/explorations", {
            "operation_key": str(uuid4()), "content": {**content, "skill_mode": "disabled"},
        }

    def test_unknown_capability_is_public_metadata_without_model_call_or_candidate(self):
        self.unknown = True
        unavailable = self._backend(self.owner_id)
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                contact, path, body = self._request(scene)
                self.reply_model.plans.append({"explore": {}})
                status, rejected = unavailable.request(path, body)
                self.assertEqual(status, 409, rejected)
                self.assertEqual(rejected["error"], "exploration_rejected")
                metadata = rejected["input_budget"]
                self.assertEqual(metadata["state"], "unavailable")
                self.assertFalse(metadata["allowed"])
                self.assertIsNone(metadata["input_tokens"])
                self.assertEqual(self.reply_model.payloads, [])
                self.assertNotIn("合成", json.dumps(rejected, ensure_ascii=False))
                with psycopg.connect(self.database_url) as connection:
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s",
                                                        (self.owner_id, contact)).fetchone()[0], 0)
        counter, decisions = self.records[-1]
        self.assertEqual(counter.seen_payloads, [])
        self.assertEqual(len(decisions), 2)

    def test_changed_exploration_rechecks_complete_input_before_another_model_call(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                self.capacity = 100000
                known = self._backend(self.owner_id)
                _, path, body = self._request(scene)
                self.reply_model.plans.append({"explore": {}})
                status, first = known.request(path, body)
                self.assertEqual(status, 200, first)
                baseline = self.records[-1][1][0]
                self.capacity = baseline.total_tokens + 1
                limited = self._backend(self.owner_id)
                before = len(self.reply_model.payloads)
                changed = {**body, "operation_key": str(uuid4()), "previous_id": first["exploration_id"],
                           "expected_input_version_id": first["input_version_id"],
                           "content": {**body["content"], "requirements": "合成新增的本次要求。" * 100}}
                status, rejected = limited.request(path, changed)
                self.assertEqual(status, 409, rejected)
                metadata = rejected["input_budget"]
                self.assertEqual(metadata["state"], "exceeded")
                self.assertGreater(metadata["total_tokens"], self.capacity)
                self.assertEqual(metadata["output_reserve_tokens"], 4096)
                self.assertEqual(len(self.reply_model.payloads), before)
                counter, decisions = self.records[-1]
                self.assertEqual(len(decisions), 1)
                actual = counter.seen_payloads[0]
                payload = json.loads(next(message["content"] for message in actual["messages"]
                                          if message["role"] == "user"))
                self.assertEqual(payload["requirements"], changed["content"]["requirements"])
                self.assertEqual(actual["max_tokens"], 4096)
                self.assertEqual([tool["function"]["name"] for tool in actual["tools"]], ["ExplorationOutput"])

    def test_full_static_skill_is_counted_before_first_exploration_call(self):
        contact, path, body = self._request("initiate_conversation")
        self.reply_model.plans.append({"explore": {}})
        status, first = self.backend.request(path, body)
        self.assertEqual(status, 200, first)
        baseline = next(decisions[0] for _, decisions in self.records if decisions)
        skill, version = uuid4(), uuid4()
        content = "合成静态策略只辅助方法，不确定用户意愿。" * 3500
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
            connection.execute("INSERT INTO public.reply_skill(id,owner_id,contact_id,name,description) VALUES (%s,%s,%s,'synthetic-full-budget-skill','合成策略')",
                               (skill, self.owner_id, contact))
            connection.execute("""INSERT INTO public.reply_skill_version
                (id,skill_id,version_number,name,description,content,enabled,is_current,status)
                VALUES (%s,%s,1,'synthetic-full-budget-skill','合成策略',%s,true,true,'active')""",
                               (version, skill, content))
        self.capacity = baseline.total_tokens + 1
        limited = self._backend(self.owner_id)
        body = {**body, "operation_key": str(uuid4()), "content": {
            **body["content"], "skill_mode": "user", "skill_version_id": str(version),
        }}
        status, rejected = limited.request(path, body)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["input_budget"]["state"], "exceeded")
        self.assertEqual(len(self.reply_model.payloads), 1)
        actual = self.records[-1][0].seen_payloads[0]
        payload = json.loads(next(message["content"] for message in actual["messages"] if message["role"] == "user"))
        self.assertEqual(payload["skill"]["content"], content)
        self.assertEqual(payload["skill"]["version_id"], str(version))
        self.assertNotIn(content, json.dumps(rejected, ensure_ascii=False))
