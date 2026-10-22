"""公开方向探索按对话自动加载；精确范围、重试及来源门禁保持。"""

import json
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.persistence.skill_fixture import insert_file_skill
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class AutomaticExplorationSkillHttpTest(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    def _prepare(self):
        contact, target, source = self.prepare_contact(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/explorations"
        skill, version = uuid4(), uuid4()
        name = "synthetic-auto-" + skill.hex[:8]
        text = "合成私有策略正文：只帮助厘清邀约，不替用户决定立场。"
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
            insert_file_skill(connection, owner_id=self.owner_id, contact_id=contact,
                              skill_id=skill, version_id=version, name=name,
                              description="适用于当前收到邀请的沟通情境", content=text)
        body = {"operation_key": str(uuid4()), "content": {"type": "response_exploration", "target_message_id": target}}
        return path, body, str(version), name, text, source

    def test_current_dialogue_selects_metadata_then_loads_one_skill_without_manual_input(self):
        path, body, version, _, text, _ = self._prepare()
        self.reply_model.plans.extend([{"select_skill": version}, {"explore": {}}])
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["used_skill"]["version_id"], version)
        self.assertEqual(result["used_skill"]["selection_method"], "auto")
        self.assertEqual(len(self.reply_model.payloads), 2)
        selection, exploration = self.reply_model.payloads
        self.assertNotIn(text, json.dumps(selection, ensure_ascii=False))
        self.assertEqual(set(selection["skills"][0]), {"version_id", "name", "description"})
        self.assertEqual(exploration["skill"]["content"], text)
        self.assertNotIn("skill_scene", exploration)
        status, replay = self.backend.request(path, body)
        self.assertEqual(status, 200, replay)
        self.assertEqual(replay, result)
        self.assertEqual(len(self.reply_model.payloads), 2)

    def test_failed_exploration_retries_the_frozen_skill_or_none_without_selecting_again(self):
        for use_skill in (True, False):
            with self.subTest(use_skill=use_skill):
                path, body, version, _, _, _ = self._prepare()
                self.reply_model.plans.extend([{"select_skill": version if use_skill else None}, {"explore": {"fail": True}}])
                status, _ = self.backend.request(path, body)
                self.assertEqual(status, 409)
                with psycopg.connect(self.database_url) as connection:
                    first = connection.execute("SELECT id,input_version_id,skill_version_id,input_payload "
                        "FROM public.reply_exploration WHERE operation_key=%s", (body["operation_key"],)).fetchone()
                self.assertTrue(first[3]["skill_selection_complete"])
                self.assertEqual(str(first[2]) if first[2] else None, version if use_skill else None)
                before = len(self.reply_model.payloads)
                self.reply_model.plans.append({"explore": {}})
                status, result = self.backend.request(path, body)
                self.assertEqual(status, 200, result)
                self.assertEqual(result["exploration_id"], str(first[0]))
                self.assertEqual(result["input_version_id"], str(first[1]))
                self.assertEqual(len(self.reply_model.payloads), before + 1)
                self.assertEqual(result["skill_version_id"], version if use_skill else None)

    def test_confirmed_generation_keeps_automatic_provenance_for_the_fixed_skill(self):
        for number in (1, 2):
            with self.subTest(version=number):
                path, body, version, name, text, _ = self._prepare()
                if number == 2:
                    latest = uuid4()
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute("UPDATE public.reply_skill_version SET is_current=false WHERE id=%s", (version,))
                        skill_id = connection.execute("SELECT skill_id FROM public.reply_skill_version WHERE id=%s", (version,)).fetchone()[0]
                        insert_file_skill(connection, owner_id=self.owner_id, skill_id=skill_id,
                                          version_id=latest, name=name, content=text,
                                          description="适用于当前收到邀请的沟通情境", version_number=2, create_skill=False)
                        connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
                    version = str(latest)
                self.reply_model.plans.extend([{"select_skill": version}, {"explore": {}}, {"read_skill": name},
                                              {"text": "谢谢邀请，这次不参加。", "basis": "依据当前用户确认的拒绝意愿。"}])
                status, explored = self.backend.request(path, body)
                self.assertEqual(status, 200, explored)
                status, generated = self.backend.request(path + f"/{explored['exploration_id']}/confirm", {
                    "generate": True, "input_version_id": explored["input_version_id"], "direct_intent": "拒绝本次邀请。",
                })
                self.assertEqual(status, 200, generated)
                with psycopg.connect(self.database_url) as connection:
                    used = connection.execute("SELECT skill_version_id,skill_selection_method FROM public.reply_request "
                        "WHERE id=%s", (generated["turn"]["reply_request_id"],)).fetchone()
                self.assertEqual(used, (UUID(version), "auto"))

    def test_invalid_session_or_deleted_input_cannot_call_the_selection_model(self):
        path, body, _, _, _, source = self._prepare()
        wrong = path.replace(path.split("/")[5], str(uuid4()))
        self.assertEqual(self.backend.request(wrong, body)[0], 409)
        self.assertEqual(self.reply_model.payloads, [])
        contact = path.split("/")[3]
        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")[0], 202)
        self.assertEqual(self.backend.request(path, body)[0], 409)
        self.assertEqual(self.reply_model.payloads, [])

    def test_unknown_version_is_rejected_before_strategy_text_or_exploration(self):
        path, body, _, _, text, _ = self._prepare()
        self.reply_model.plans.append({"select_skill": str(uuid4())})
        status, _ = self.backend.request(path, body)
        self.assertEqual(status, 409)
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertNotIn(text, json.dumps(self.reply_model.payloads, ensure_ascii=False))

    def test_foreign_contact_strategy_is_absent_from_automatic_directory(self):
        path, body, version, _, text, _ = self._prepare()
        other, _, _ = self.prepare_contact(self.owner_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.reply_skill SET contact_id=%s WHERE id="
                               "(SELECT skill_id FROM public.reply_skill_version WHERE id=%s)", (other, version))
        self.reply_model.plans.append({"explore": {}})
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        self.assertIsNone(result["used_skill"])
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertNotIn(text, json.dumps(self.reply_model.payloads, ensure_ascii=False))

    def test_revision_change_or_stop_after_selection_prevents_loading_and_second_call(self):
        for mutation in ("revision", "stop", "source"):
            with self.subTest(mutation=mutation):
                path, body, version, _, text, source = self._prepare()
                self.reply_model.plans.append({"select_skill": version})

                def invalidate():
                    if mutation == "source":
                        contact = path.split("/")[3]
                        self.assertEqual(self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")[0], 202)
                        return
                    with psycopg.connect(self.database_url) as connection:
                        if mutation == "revision":
                            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
                        else:
                            task = connection.execute("SELECT id,input_version_id FROM public.reply_exploration WHERE operation_key=%s", (body["operation_key"],)).fetchone()
                    if mutation == "stop":
                        status, result = self.backend.request(path + f"/{task[0]}/stop", {"input_version_id": str(task[1])})
                        self.assertEqual(status, 200, result)

                self.reply_model.selection_callback = invalidate
                before = len(self.reply_model.payloads)
                status, _ = self.backend.request(path, body)
                self.assertEqual(status, 409)
                self.assertEqual(len(self.reply_model.payloads), before + 1)
                self.assertNotIn(text, json.dumps(self.reply_model.payloads[-1], ensure_ascii=False))
                self.reply_model.selection_callback = None

    def test_selection_budget_rejection_has_no_actual_call_or_outbound_record(self):
        path, body, _, _, _, _ = self._prepare()
        with patch("tests.fidelity_http_support.synthetic_budget_kwargs",
                   side_effect=lambda model: synthetic_budget_kwargs(model, capacity=500, output_reserve=100)):
            limited = self._backend(self.owner_id)
        status, result = limited.request(path, body)
        self.assertEqual(status, 409, result)
        self.assertEqual(result["input_budget"]["state"], "exceeded")
        self.assertEqual(self.reply_model.payloads, [])
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.outbound_ledger_entry WHERE owner_id=%s", (self.owner_id,)).fetchone()[0]
        self.assertEqual(count, 0)
