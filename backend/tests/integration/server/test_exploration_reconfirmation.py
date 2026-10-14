"""明确重试沿公开 HTTP 复验原意愿；退出事件只替换为合成宿主凭证。"""

from contextlib import nullcontext
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.application.assistant_session_service import AssistantSessionPersistenceError

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server import test_persistent_reply_exploration as exploration_support
from tests.integration.server.test_persistent_reply_exploration import ExplorationControlledModel


class ExplorationReconfirmationHttpTest(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    def _interrupted(self, scene="reply_to_message", *, direct=False, invalidate=True, user_skill=False, saved_reply=False,
                     clarified=False):
        contact, target, source = self.prepare_contact(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        content = ({"type": "response_exploration", "target_message_id": target}
                   if scene == "reply_to_message" else {"type": "purpose_exploration", "purpose_hint": "想了解合成近况。"})
        content = {**content, "skill_mode": "disabled"}
        question = {"text": "这次是否承诺见面？", "impact": "commitment"}
        plans = [{"explore": {"question": question} if clarified else {}}]
        if clarified:
            plans.append({"explore": {}})
        if user_skill:
            _, version, name = exploration_support.PersistentExplorationHttpTest._skill(self, path)
            content.update(skill_mode="user", skill_version_id=version)
            plans.append({"read_skill": name})
        self.reply_model.plans.extend([*plans, {"text": "最近还好吗？" if saved_reply else "", "basis": "仅表达已确认合成意愿。"}])
        status, parent = self.backend.request(path + "/explorations", {
            "operation_key": str(uuid4()), "content": content,
        })
        self.assertEqual(status, 200, parent)
        confirmation = {"generate": True, "input_version_id": parent["input_version_id"],
                        **({"direct_intent": "只关心合成近况，不增加安排承诺。"} if direct else
                           {"suggestion_id": parent["options"][0]["suggestion_id"]})}
        confirm_path = path + f"/explorations/{parent['exploration_id']}/confirm"
        failure = (patch("notalone.persistence.assistant_session_store.PostgresAssistantSessionStore.complete",
                         side_effect=AssistantSessionPersistenceError("合成助手投影写入失败。"))
                   if saved_reply else nullcontext())
        with failure:
            status, selected = self.backend.request(confirm_path, confirmation)
            if clarified:
                self.assertEqual(status, 200, selected)
                self.assertEqual(selected["kind"], "clarification")
                self.assertEqual(self.backend.request(path + f"/explorations/{parent['exploration_id']}/answer", {"generate": True,
                    "input_version_id": parent["input_version_id"], "question_id": selected["question_id"],
                    "answer": "不承诺见面。", "operation_key": str(uuid4()),
                })[0], 503)
            else:
                self.assertEqual(status, 503, selected)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "failed")
        turn = saved["turns"][0]
        if clarified:
            original_selection = confirmation["suggestion_id"]
            reference = turn["input"]["content"]["suggestion"]
            status, parent = self.backend.request(path + f"/explorations/{reference['task_id']}")
            self.assertEqual(status, 200, parent)
            self.assertEqual(reference["suggestion_id"], original_selection)
            self.assertNotIn(original_selection, {option["suggestion_id"] for option in parent["options"]})
            confirmation = {"generate": True, "input_version_id": reference["input_version"], "suggestion_id": original_selection}
        # A17 正式中断接口尚未消费；仅适配合成宿主的旧键失效事件，不改正文或输入指针。
        if invalidate:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) "
                                   "VALUES (%s,%s,%s)", (self.owner_id, contact, turn["request_key"]))
        return path, parent, turn, confirmation, source

    @staticmethod
    def _request(turn, confirmation):
        return {**{key: value for key, value in confirmation.items() if key != "generate"}, "request_key": str(uuid4()), "expected_input_version_id": turn["input_version_id"]}

    def _unchanged(self, path, endpoint, request, expected=409):
        before = self.backend.request(path)[1]
        calls = len(self.reply_model.payloads)
        status, _ = self.backend.request(endpoint, request)
        self.assertEqual(status, expected)
        self.assertEqual(self.backend.request(path)[1], before)
        self.assertEqual(len(self.reply_model.payloads), calls)

    def test_explicit_fresh_key_confirms_new_identity_without_model_and_uses_existing_generation(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                path, parent, old_turn, confirmation, _ = self._interrupted(scene)
                request = {**{key: value for key, value in confirmation.items() if key != "generate"}, "request_key": str(uuid4()),
                           "expected_input_version_id": old_turn["input_version_id"]}
                endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
                before = len(self.reply_model.payloads)
                status, receipt = self.backend.request(endpoint, request)
                self.assertEqual(status, 200, receipt)
                self.assertEqual(set(receipt), {"kind", "session_id", "exploration_id", "input_version_id",
                                               "request_key", "suggestion_id", "direction_source",
                                               "skill_version_id", "skill_library_revision"})
                self.assertEqual(receipt["kind"], "confirmed")
                self.assertEqual(receipt["request_key"], request["request_key"])
                self.assertEqual(receipt["direction_source"], "confirmed_suggestion")
                self.assertIsNone(receipt["skill_version_id"])
                for field in ("exploration_id", "input_version_id", "suggestion_id"):
                    old = confirmation[field] if field == "suggestion_id" else parent[field]
                    self.assertNotEqual(receipt[field], old)
                self.assertEqual(len(self.reply_model.payloads), before)
                self.assertEqual(self._backend(self.owner_id).request(endpoint, request), (200, receipt))
                self.assertEqual(len(self.backend.request(path)[1]["inputs"]), 3)
                payload = old_turn["input"]
                content = dict(payload["content"])
                content.pop("suggestion")
                body = {**payload, "content": content, "contact_id": path.split("/")[3],
                        "idempotency_key": receipt["request_key"],
                        "expected_input_version_id": receipt["input_version_id"],
                        "suggestion": {"task_id": receipt["exploration_id"],
                                       "input_version": receipt["input_version_id"],
                                       "suggestion_id": receipt["suggestion_id"]}}
                self.reply_model.plans.append({"text": "最近还好吗？", "basis": "只延续明确合成意愿。"})
                status, generated = self.backend.request(path + "/replies", body)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["state"], "completed")
                self.assertEqual(len(self.reply_model.payloads), before + 1)
                self.assertEqual(self.backend.request(path + "/replies", body), (200, generated))
                self.assertEqual(self.backend.request(path + f"/explorations/{parent['exploration_id']}/confirm",
                                                      confirmation)[0], 409)
                self.assertEqual(len(self.reply_model.payloads), before + 1)
                with psycopg.connect(self.database_url) as connection:
                    rows = connection.execute("SELECT id,request_key,root_created_at FROM public.reply_exploration "
                                              "WHERE id IN (%s,%s) ORDER BY id",
                                              (parent["exploration_id"], receipt["exploration_id"])).fetchall()
                self.assertEqual(len(rows), 2)
                self.assertEqual(rows[0][2], rows[1][2])
                self.assertIn(old_turn["request_key"], {str(row[1]) for row in rows})

    def test_reconfirmation_keeps_direct_input_and_rejects_a_changed_intent_or_source(self):
        path, parent, turn, confirmation, _ = self._interrupted(direct=True)
        endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
        request = self._request(turn, confirmation)
        self._unchanged(path, endpoint, {**request, "direct_intent": "改为承诺见面。"})
        wrong_source = dict(request)
        wrong_source.pop("direct_intent")
        wrong_source["suggestion_id"] = parent["options"][0]["suggestion_id"]
        self._unchanged(path, endpoint, wrong_source)
        calls = len(self.reply_model.payloads)
        status, receipt = self.backend.request(endpoint, request)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(receipt["direction_source"], "direct_input")
        self.assertEqual(len(self.reply_model.payloads), calls)
        self.assertEqual(self.backend.request(endpoint, request), (200, receipt))
        self._unchanged(path, endpoint, {**request, "direct_intent": "改变同键意愿。"})

    def test_fresh_key_requires_actual_interruption_and_exact_current_input(self):
        path, parent, turn, confirmation, _ = self._interrupted(invalidate=False)
        endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
        request = self._request(turn, confirmation)
        self._unchanged(path, endpoint, request)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) "
                               "VALUES (%s,%s,%s)", (self.owner_id, path.split("/")[3], turn["request_key"]))
        for changed in ({"request_key": turn["request_key"]}, {"expected_input_version_id": parent["input_version_id"]},
                        {"input_version_id": str(uuid4())}, {"suggestion_id": parent["options"][1]["suggestion_id"]}):
            with self.subTest(changed=tuple(changed)):
                self._unchanged(path, endpoint, {**request, **changed})
        self.reply_model.plans.append({"explore": {}})
        status, _ = self.backend.request(path + "/explorations", {
            "operation_key": str(uuid4()), "expected_input_version_id": turn["input_version_id"],
            "content": {"type": "purpose_exploration", "purpose_hint": "另一个当前任务。", "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200)
        self._unchanged(path, endpoint, request)

    def test_cross_scope_and_strict_json_fail_without_a_new_input_or_model(self):
        path, parent, turn, confirmation, _ = self._interrupted()
        endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
        request = self._request(turn, confirmation)
        calls = len(self.reply_model.payloads)
        self.assertEqual(self.other_backend.request(endpoint, request)[0], 409)
        other_contact, _, _ = self.prepare_contact(self.owner_id)
        other_path = endpoint.replace(path.split("/")[3], str(other_contact))
        self.assertEqual(self.backend.request(other_path, request)[0], 409)
        wrong_session = endpoint.replace(parent["session_id"], str(uuid4()))
        self.assertEqual(self.backend.request(wrong_session, request)[0], 409)
        for changed in ({"unexpected": True}, {"request_key": "bad"}, {"expected_input_version_id": None}):
            self._unchanged(path, endpoint, {**request, **changed}, 400)
        self._unchanged(path, endpoint, {**request, "direct_intent": "同时给出两种选择。"})
        self.assertEqual(len(self.reply_model.payloads), calls)

    def test_source_delete_rejects_original_and_replayed_reconfirmation_and_physically_clears_both(self):
        path, parent, turn, confirmation, source = self._interrupted()
        endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
        request = self._request(turn, confirmation)
        status, receipt = self.backend.request(endpoint, request)
        self.assertEqual(status, 200, receipt)
        calls = len(self.reply_model.payloads)
        status, _ = self.backend.request(f"/api/contacts/{path.split('/')[3]}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202)
        self.assertEqual(self.backend.request(endpoint, request)[0], 409)
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute("SELECT state,input_payload,result_payload,selected_intent FROM public.reply_exploration "
                                      "WHERE id IN (%s,%s)", (parent["exploration_id"], receipt["exploration_id"])).fetchall()
        self.assertEqual(rows, [("redacted", None, None, None), ("redacted", None, None, None)])
        self.assertEqual(len(self.reply_model.payloads), calls)

    def test_reconfirmation_never_renews_original_ttl_or_uses_a_changed_skill_catalog(self):
        for invalidation in ("ttl", "catalog"):
            with self.subTest(invalidation=invalidation):
                path, parent, turn, confirmation, _ = self._interrupted()
                endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
                request = self._request(turn, confirmation)
                calls = len(self.reply_model.payloads)
                with psycopg.connect(self.database_url) as connection:
                    if invalidation == "ttl":
                        connection.execute("UPDATE public.reply_exploration SET root_created_at=clock_timestamp()-interval '16 minutes' "
                                           "WHERE id=%s", (parent["exploration_id"],))
                    else:
                        connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
                self.assertEqual(self.backend.request(endpoint, request)[0], 409)
                self.assertEqual(len(self.backend.request(path)[1]["inputs"]), 2)
                self.assertEqual(len(self.reply_model.payloads), calls)

    def test_explicit_skill_stays_on_actual_version_and_disabled_version_cannot_reconfirm(self):
        path, parent, turn, confirmation, _ = self._interrupted(user_skill=True)
        endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
        request = self._request(turn, confirmation)
        calls = len(self.reply_model.payloads)
        status, receipt = self.backend.request(endpoint, request)
        self.assertEqual(status, 200, receipt)
        self.assertEqual(receipt["skill_version_id"], parent["skill_version_id"])
        self.assertEqual(receipt["skill_library_revision"], parent["skill_library_revision"])
        self.assertEqual(len(self.reply_model.payloads), calls)
        payload = turn["input"]
        content = dict(payload["content"])
        content.pop("suggestion")
        body = {**payload, "content": content, "contact_id": path.split("/")[3],
                "idempotency_key": receipt["request_key"], "expected_input_version_id": receipt["input_version_id"],
                "suggestion": {"task_id": receipt["exploration_id"], "input_version": receipt["input_version_id"],
                               "suggestion_id": receipt["suggestion_id"]}}
        self.reply_model.plans.extend([{"read_skill": parent["used_skill"]["name"]},
                                       {"text": "最近还好吗？", "basis": "保留明确意愿与实际策略版本。"}])
        status, generated = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["used_skill"]["version_id"], receipt["skill_version_id"])
        self.assertEqual(len(self.reply_model.payloads), calls + 2)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.reply_skill_version SET enabled=false WHERE id=%s", (parent["skill_version_id"],))
        self._unchanged(path, endpoint, request)

    def test_saved_reply_wins_over_failed_assistant_projection_and_cannot_create_a_second_confirmation(self):
        path, parent, turn, confirmation, _ = self._interrupted(saved_reply=True)
        with psycopg.connect(self.database_url) as connection:
            state = connection.execute("SELECT state FROM public.reply_request WHERE owner_id=%s AND contact_id=%s "
                                       "AND idempotency_key=%s", (self.owner_id, path.split("/")[3], turn["request_key"])).fetchone()
        self.assertEqual(state, ("completed",))
        self._unchanged(path, path + f"/explorations/{parent['exploration_id']}/reconfirm", self._request(turn, confirmation))

    def test_clarification_keeps_original_selection_when_new_options_have_other_identities(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                path, parent, turn, confirmation, _ = self._interrupted(scene, clarified=True)
                endpoint = path + f"/explorations/{parent['exploration_id']}/reconfirm"
                request = self._request(turn, confirmation)
                with psycopg.connect(self.database_url) as connection:
                    original = connection.execute(
                        "SELECT result_payload,selected_intent,selection_id,request_key,root_created_at "
                        "FROM public.reply_exploration WHERE id=%s", (parent["exploration_id"],),
                    ).fetchone()
                calls = len(self.reply_model.payloads)
                status, receipt = self.backend.request(endpoint, request)
                self.assertEqual(status, 200, receipt)
                self.assertEqual(receipt["direction_source"], "confirmed_suggestion")
                self.assertNotEqual(receipt["suggestion_id"], confirmation["suggestion_id"])
                self.assertEqual(len(self.reply_model.payloads), calls)
                self.assertEqual(self.backend.request(endpoint, request), (200, receipt))
                with psycopg.connect(self.database_url) as connection:
                    unchanged = connection.execute(
                        "SELECT result_payload,selected_intent,selection_id,request_key,root_created_at "
                        "FROM public.reply_exploration WHERE id=%s", (parent["exploration_id"],),
                    ).fetchone()
                    renewed = connection.execute(
                        "SELECT selected_intent,root_created_at FROM public.reply_exploration WHERE id=%s",
                        (receipt["exploration_id"],),
                    ).fetchone()
                self.assertEqual(unchanged, original)
                self.assertEqual(renewed, (original[1], original[4]))
                payload = turn["input"]
                content = dict(payload["content"])
                content.pop("suggestion")
                body = {**payload, "content": content, "contact_id": path.split("/")[3],
                        "idempotency_key": receipt["request_key"],
                        "expected_input_version_id": receipt["input_version_id"],
                        "suggestion": {"task_id": receipt["exploration_id"],
                                       "input_version": receipt["input_version_id"],
                                       "suggestion_id": receipt["suggestion_id"]}}
                self.reply_model.plans.append({"text": "最近还好吗？", "basis": "只了解近况，不增加约定。"})
                status, generated = self.backend.request(path + "/replies", body)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["state"], "completed")
                self.assertEqual(self.reply_model.payloads[-1]["clarification_answer"], "不承诺见面。")
                self.assertEqual(self.reply_model.payloads[-1]["fidelity_contract"]["current_intent"]["text"], original[1])
                self.assertEqual(len(self.reply_model.payloads), calls + 1)
