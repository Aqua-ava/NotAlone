"""唯一持久探索公开HTTP→既有生成链→实际隔离PostgreSQL。"""

import json
import unittest
from typing import Callable
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from langchain_core.messages import HumanMessage
from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope
from tests.integration.persistence.skill_fixture import insert_file_skill

from tests.fidelity_http_support import FidelityControlledModel, FidelityHttpFixture
from tests.integration.server.core_business_flow_support import ScriptedCoreModel, tool_response


class ExplorationControlledModel(FidelityControlledModel):
    selection_callback: Callable | None = None

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(message.content) for message in messages if isinstance(message, HumanMessage))
        if payload.get("input_mode") == "exploration_skill_selection":
            self.entered.set()
            self.wait_for_response()
            self.payloads.append(payload)
            if not self.plans or "select_skill" not in self.plans[0]:
                raise AssertionError("自动策略选择脚本耗尽，禁止额外模型调用。")
            version = self.plans.pop(0)["select_skill"]
            if self.selection_callback:
                self.selection_callback()
            self.responses.append(tool_response("ExplorationSkillSelection", {"version_id": version}))
            return ScriptedCoreModel._generate(self, messages, stop, run_manager, **kwargs)
        if payload.get("input_mode") != "direction_exploration":
            if self.plans and "read_skill" in self.plans[0]:
                self.payloads.append(payload)
                name = self.plans.pop(0)["read_skill"]
                self.responses.append(tool_response("read_file", {
                    "file_path": f"/notalone/reply-skills/{name}/SKILL.md",
                }))
                return ScriptedCoreModel._generate(self, messages, stop, run_manager, **kwargs)
            return super()._generate(messages, stop, run_manager, **kwargs)
        self.entered.set()
        self.wait_for_response()
        self.payloads.append(payload)
        if not self.plans or "explore" not in self.plans[0]:
            raise AssertionError("探索脚本耗尽，禁止额外模型调用。")
        plan = self.plans.pop(0)["explore"]
        if plan.get("fail"):
            raise RuntimeError("合成模型失败，不含私人正文。")
        ids = [payload["evidence"][0]["evidence_id"]] if payload["evidence"] else []
        options = plan.get("options", [
            {"intent": "只了解近况，不承诺见面。", "label": "了解近况", "reason": "想了解近况时适用。",
             "citation_ids": ids, "recommended": False, "pause": False},
            {"intent": "暂不联系。", "label": "暂不联系", "reason": "暂时没有联系目的时适用。",
             "citation_ids": [], "recommended": False, "pause": True},
        ])
        self.responses.append(tool_response("ExplorationOutput", {
            "understanding": plan.get("understanding", "这段合成资料允许不同的本次意愿。"),
            "ambiguities": plan.get("ambiguities", []), "citation_ids": ids, "options": options,
            "question": plan.get("question"), "current_step": "先了解近况，不推进其他约定。",
            "tradeoffs": ["简短表达可能只推进了解近况这一步。"],
        }))
        return ScriptedCoreModel._generate(self, messages, stop, run_manager, **kwargs)


class PersistentExplorationHttpTest(FidelityHttpFixture, unittest.TestCase):
    reply_model_factory = ExplorationControlledModel

    def _prepare(self, scene="reply_to_message"):
        contact, target, source = self.prepare_contact(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {}, method="POST")
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        content = ({"type": "response_exploration", "target_message_id": target}
                   if scene == "reply_to_message" else {"type": "purpose_exploration", "purpose_hint": "想了解近况，但还没有明确目的。"})
        body = {"operation_key": str(uuid4()), "content": {**content, "skill_mode": "disabled"}}
        return path, body, source

    def _open(self, path, body):
        status, result = self.backend.request(path + "/explorations", body)
        self.assertEqual(status, 200, result)
        return result

    def _confirm(self, path, result, index=0):
        return self.backend.request(path + f"/explorations/{result['exploration_id']}/confirm", {"generate": True,
            "input_version_id": result["input_version_id"], "suggestion_id": result["options"][index]["suggestion_id"],
        })

    def _answer(self, path, result, answer="不承诺见面。", *, operation=None):
        return self.backend.request(path + f"/explorations/{result['exploration_id']}/answer", {"generate": True,
            "input_version_id": result["input_version_id"], "question_id": result["question_id"],
            "answer": answer, "operation_key": operation or str(uuid4()),
        })

    def _calls(self, mode):
        return [payload for payload in self.reply_model.payloads if payload.get("input_mode") == mode]

    def test_multi_source_memory_outside_generation_window_has_one_complete_dependency(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                self.reply_model.plans.clear()
                path, body, _ = self._prepare(scene)
                contact = UUID(path.split("/")[3])
                scope = ContactScope(self.owner_id, contact)
                sources = tuple(uuid4() for _ in range(21))
                with psycopg.connect(self.database_url) as connection:
                    for source in sources:
                        connection.execute("""INSERT INTO public.source_document
                            (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
                            VALUES (%s,%s,%s,'wechat_jsonl','multi-source-synthetic.jsonl',%s,0)""",
                            (source, self.owner_id, contact, uuid4().hex * 2))
                store = PostgresMemoryStore(self.database_url)
                candidate = store.create_candidate(MemoryCandidate(
                    candidate_id=uuid4(), scope=scope, text="仅用于理解的已确认资料标记。",
                    category=MemoryCategory.RECENT_STATE, source_ids=sources,
                ))
                memory = store.confirm(scope=scope, candidate_id=candidate.candidate_id,
                                       adoption_method=AdoptionMethod.MANUAL)
                self.reply_model.plans.append({"explore": {}})
                explored = self._open(path, body)
                material = next(item for item in explored["evidence"]
                                if item["evidence_id"] == str(memory.memory_id))
                self.assertEqual(set(material["source_ids"]), {str(source) for source in sources})
                self.reply_model.plans.append({"text": "只了解近况，不承诺见面。", "basis": "只表达已确认意愿。"})
                status, generated = self._confirm(path, explored)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["kind"], "generated")
                self.assertEqual(len(generated["turn"]["candidates"]), 1)
                request_id = generated["turn"]["reply_request_id"]
                with psycopg.connect(self.database_url) as connection:
                    count = connection.execute("""SELECT count(*) FROM public.reply_context_evidence
                        WHERE owner_id=%s AND contact_id=%s AND reply_request_id=%s AND evidence_id=%s""",
                        (self.owner_id, contact, UUID(request_id), memory.memory_id)).fetchone()[0]
                    self.assertEqual(count, 1)
                calls = len(self.reply_model.payloads)
                self.assertEqual(self._confirm(path, explored), (200, generated))
                self.assertEqual(len(self.reply_model.payloads), calls)
                status, receipt = self.backend.request(
                    f"/api/contacts/{contact}/sources/{sources[0]}", method="DELETE")
                self.assertEqual(status, 202, receipt)
                self.assertEqual(self._confirm(path, explored)[0], 409)
                self.assertEqual(len(self.reply_model.payloads), calls)

    def _skill(self, path):
        skill, version = uuid4(), uuid4()
        name = f"synthetic-strategy-{skill.hex[:8]}"
        contact = path.split("/")[3]
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.skill_library(owner_id,revision) VALUES (%s,1) ON CONFLICT DO NOTHING",
                               (self.owner_id,))
            insert_file_skill(connection, owner_id=self.owner_id, contact_id=contact,
                              skill_id=skill, version_id=version, name=name, description="合成沟通策略",
                              content="只辅助理解，保留用户本次意愿。")
        return str(skill), str(version), name

    def test_old_integer_endpoint_rejects_protocol_without_model_or_new_input(self):
        path, _, _ = self._prepare()
        before = self.backend.request(path)[1]["current_input_version_id"]
        status, result = self.backend.request("/api/reply/explore", {"input_version": 1})
        self.assertEqual(status, 409, result)
        self.assertEqual(result, {"error": "exploration_protocol_changed"})
        self.assertEqual(self.reply_model.payloads, [])
        saved = self.backend.request(path)[1]
        self.assertEqual(saved["current_input_version_id"], before)
        self.assertEqual(saved["turns"], [])
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute(
                "SELECT count(*) FROM public.assistant_session_input WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, path.split("/")[3]),
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_both_scenes_correct_without_confirming_then_generate_once_and_replay_across_reassembly(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            with self.subTest(scene=scene):
                path, body, _ = self._prepare(scene)
                self.reply_model.plans.extend([{"explore": {}}, {"explore": {"understanding": "合成纠正后的理解。"}},
                                              {"text": "最近过得怎么样？", "basis": "只表达本次明确目的。"}])
                first = self._open(path, body)
                self.assertEqual(self._backend(self.owner_id).request(path + "/explorations", body), (200, first))
                changed = {**body, "operation_key": str(uuid4()), "previous_id": first["exploration_id"],
                           "expected_input_version_id": first["input_version_id"],
                           "content": {**body["content"], "correction": "只谈近况。", "requirements": "保持简短。"}}
                corrected = self._open(path, changed)
                self.assertIsNone(corrected["confirmed_intent"])
                before = len(self._calls(scene))
                self.assertEqual(before, 0)
                status, generated = self._confirm(path, corrected)
                self.assertEqual(status, 200, generated)
                self.assertEqual(generated["kind"], "generated")
                self.assertEqual(generated["turn"]["state"], "completed")
                actual = self.reply_model.payloads[-1]
                self.assertEqual(actual["understanding_correction"], "只谈近况。")
                self.assertEqual(actual["user_instruction"], "保持简短。")
                self.assertEqual(actual["fidelity_contract"]["current_intent"]["text"], corrected["options"][0]["intent"])
                self.assertEqual(self._confirm(path, corrected), (200, generated))
                self.assertEqual(len(self._calls(scene)), before + 1)
                self.assertEqual(len(self.backend.request(path)[1]["inputs"]), 3)
                self.assertFalse(any(payload.get("style_references") for payload in self._calls("direction_exploration")))

    def test_answer_without_selected_intent_stays_in_exploration_for_both_scenes(self):
        question = {"text": "这次是否愿意承诺见面？", "impact": "commitment"}
        for scene in ("reply_to_message", "initiate_conversation"):
            path, body, _ = self._prepare(scene)
            self.reply_model.plans.extend([{"explore": {"question": question}}, {"explore": {}}])
            first = self._open(path, body)
            self.assertEqual(first["kind"], "clarification")
            status, answer = self._answer(path, first)
            self.assertEqual(status, 200, answer)
            self.assertEqual(answer["kind"], "directions")
            self.assertIsNone(answer["confirmed_intent"])
        self.assertEqual(len(self.reply_model.payloads), 4)
        self.assertEqual(self._calls("reply_to_message") + self._calls("initiate_conversation"), [])

    def test_answer_continues_only_actual_selection_and_keeps_same_generation_after_lost_response(self):
        question = {"text": "是否愿意承诺见面？", "impact": "commitment"}
        for scene in ("reply_to_message", "initiate_conversation"):
            path, body, _ = self._prepare(scene)
            self.reply_model.plans.extend([{"explore": {"question": question}}, {"explore": {}},
                                          {"text": "最近还好吗？", "basis": "不增加约定。"}])
            first = self._open(path, body)
            status, selected = self._confirm(path, first)
            self.assertEqual(status, 200, selected)
            self.assertEqual(selected["kind"], "clarification")
            key = str(uuid4())
            status, generated = self._answer(path, selected, operation=key)
            self.assertEqual(status, 200, generated)
            self.assertEqual(generated["kind"], "generated")
            self.assertEqual(self.reply_model.payloads[-1]["clarification_answer"], "不承诺见面。")
            count = len(self.reply_model.payloads)
            self.assertEqual(self._answer(path, selected, operation=key), (200, generated))
            self.assertEqual(len(self.reply_model.payloads), count)

    def test_pause_and_stop_reject_old_questions_and_confirmation_without_generation(self):
        path, body, _ = self._prepare()
        self.reply_model.plans.append({"explore": {"question": {"text": "是否承诺？", "impact": "commitment"}}})
        first = self._open(path, body)
        status, paused = self._confirm(path, first, 1)
        self.assertEqual(status, 200, paused)
        self.assertEqual(paused["kind"], "paused")
        self.assertEqual(self._answer(path, first)[0], 409)
        self.assertEqual(self._confirm(path, first)[0], 409)
        self.assertEqual(self._calls("reply_to_message"), [])

    def test_source_revocation_and_cross_owner_refuse_old_result_without_new_model_or_derived_turn(self):
        path, body, source = self._prepare()
        self.reply_model.plans.append({"explore": {}})
        first = self._open(path, body)
        self.assertEqual(self.other_backend.request(path + f"/explorations/{first['exploration_id']}")[0], 409)
        contact = path.split("/")[3]
        status, receipt = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, receipt)
        self.assertEqual(self._confirm(path, first)[0], 409)
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual(self.backend.request(path)[1]["turns"], [])

    def test_automatic_updates_are_bounded_and_cannot_resume_after_stop(self):
        path, body, _ = self._prepare()
        self.reply_model.plans.extend([{"explore": {}} for _ in range(4)])
        current = self._open(path, body)
        for _ in range(3):
            current = self._open(path, {**body, "operation_key": str(uuid4()), "automatic": True,
                                       "previous_id": current["exploration_id"], "expected_input_version_id": current["input_version_id"]})
        retry = {**body, "operation_key": str(uuid4()), "automatic": True,
                 "previous_id": current["exploration_id"], "expected_input_version_id": current["input_version_id"]}
        self.assertEqual(self.backend.request(path + "/explorations", retry)[0], 409)
        self.assertEqual(self.backend.request(path + f"/explorations/{current['exploration_id']}/stop",
                                            {"input_version_id": current["input_version_id"]})[0], 200)
        self.assertEqual(self.backend.request(path + "/explorations", retry)[0], 409)
        self.assertEqual(len(self.reply_model.payloads), 4)

    def test_failed_open_explicit_retry_reuses_actual_input_and_rejects_changed_same_key(self):
        path, body, _ = self._prepare()
        self.reply_model.plans.extend([{"explore": {"fail": True}}, {"explore": {}}])
        self.assertEqual(self.backend.request(path + "/explorations", body)[0], 409)
        before = self.backend.request(path)[1]
        self.assertEqual(len(before["inputs"]), 1)
        result = self._open(path, body)
        after = self.backend.request(path)[1]
        self.assertEqual(before["current_input_version_id"], result["input_version_id"])
        self.assertEqual(after["current_input_version_id"], before["current_input_version_id"])
        self.assertEqual(len(after["inputs"]), 1)
        changed = {**body, "content": {**body["content"], "correction": "改变同键正文。"}}
        self.assertEqual(self.backend.request(path + "/explorations", changed)[0], 409)
        self.assertEqual(len(self.reply_model.payloads), 2)

    def test_change_group_is_unselected_and_requires_distinct_intents(self):
        path, body, _ = self._prepare()
        self.reply_model.plans.append({"explore": {}})
        first = self._open(path, body)
        changed = {**body, "operation_key": str(uuid4()), "previous_id": first["exploration_id"],
                   "expected_input_version_id": first["input_version_id"], "change_group": True}
        self.reply_model.plans.append({"explore": {}})
        self.assertEqual(self.backend.request(path + "/explorations", changed)[0], 409)
        options = [{**option, "intent": "明确拒绝本次邀约。" if index == 0 else "只询问其他安排。"}
                   for index, option in enumerate(first["options"])]
        for option in options:
            option.pop("suggestion_id")
        self.reply_model.plans.append({"explore": {"options": options}})
        result = self._open(path, changed)
        self.assertIsNone(result["confirmed_intent"])
        self.assertEqual(self.reply_model.payloads[-1]["previous_intents"], [item["intent"] for item in first["options"]])
        self.assertEqual(self._confirm(path, first)[0], 409)
        self.assertEqual(self._calls("reply_to_message"), [])

    def test_user_skill_is_actually_loaded_as_same_version_and_disabled_never_autoloads(self):
        for mode in ("user", "disabled"):
            path, body, _ = self._prepare()
            _, version, name = self._skill(path)
            body["content"] = {**body["content"], "skill_mode": mode,
                               **({"skill_version_id": version} if mode == "user" else {})}
            self.reply_model.plans.append({"explore": {}})
            result = self._open(path, body)
            self.assertEqual(result["skill_version_id"], version if mode == "user" else None)
            if mode == "user":
                self.assertEqual(result["used_skill"]["version_number"], 1)
                self.assertEqual(self.reply_model.payloads[-1]["skill"]["version_id"], version)
                self.reply_model.plans.append({"read_skill": name})
            else:
                self.assertIsNone(self.reply_model.payloads[-1]["skill"])
            self.reply_model.plans.append({"text": "最近还好吗？", "basis": "只表达确认的意愿。"})
            status, generated = self._confirm(path, result)
            self.assertEqual(status, 200, generated)
            used = generated["turn"]["used_skill"]
            self.assertEqual(used["version_id"] if used else None, version if mode == "user" else None)
            self.assertEqual(self.reply_model.payloads[-1]["skill_selection"]["mode"], mode)

    def test_skill_revision_invalidates_old_options_but_explicit_disabled_refresh_keeps_actual_selection(self):
        path, body, _ = self._prepare()
        _, version, _ = self._skill(path)
        body["content"].update(skill_mode="user", skill_version_id=version)
        self.reply_model.plans.append({"explore": {"question": {"text": "是否承诺见面？", "impact": "commitment"}}})
        first = self._open(path, body)
        selected = self._confirm(path, first)[1]
        intent = selected["confirmed_intent"]
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
        self.assertEqual(self._confirm(path, first)[0], 409)
        self.assertEqual(self.backend.request(path + f"/explorations/{first['exploration_id']}")[0], 409)
        changed = {**body, "operation_key": str(uuid4()), "previous_id": first["exploration_id"],
                   "expected_input_version_id": first["input_version_id"],
                   "content": {**body["content"], "skill_mode": "disabled"}}
        changed["content"].pop("skill_version_id")
        self.reply_model.plans.append({"explore": {}})
        refreshed = self._open(path, changed)
        self.assertEqual(refreshed["confirmed_intent"], intent)
        self.assertIsNone(refreshed["used_skill"])
        self.assertEqual(self.reply_model.payloads[-1]["confirmed_intent"], intent)
        self.reply_model.plans.append({"text": "最近还好吗？", "basis": "只表达原确认意愿。"})
        status, generated = self.backend.request(path + f"/explorations/{refreshed['exploration_id']}/confirm", {"generate": True,
            "input_version_id": refreshed["input_version_id"], "direct_intent": intent,
        })
        self.assertEqual(status, 200, generated)
        self.assertIsNone(generated["turn"]["used_skill"])
        self.assertEqual(self.reply_model.payloads[-1]["skill_selection"], {"mode": "disabled"})

    def test_changed_current_input_and_late_model_cannot_publish_or_generate(self):
        path, body, _ = self._prepare()
        self.reply_model.plans.append({"explore": {}})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/explorations", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(3))
                current = self.backend.request(path)[1]["current_input_version_id"]
                status, _ = self.backend.request(path + "/inputs", {
                    "content": {"type": "response_exploration", "target_message_id": body["content"]["target_message_id"],
                                "correction": "后来的明确纠正。"}, "expected_input_version_id": current,
                })
                self.assertEqual(status, 200)
            finally:
                gate.set()
            self.assertEqual(pending.result(timeout=10)[0], 409)
        self.assertEqual(self.backend.request(path)[1]["turns"], [])
        self.assertEqual(self._calls("reply_to_message"), [])

    def test_public_body_and_cross_session_references_fail_before_model(self):
        path, body, _ = self._prepare()
        for extra in ({"confirmed_intent": "伪造确认。"}, {"answer": "伪造应答。"},
                      {"skill_mode": "user", "skill_version_id": str(uuid4())}, {"correction": 1}):
            changed = {**body, "content": {**body["content"], **extra}}
            self.assertIn(self.backend.request(path + "/explorations", changed)[0], (400, 409))
        self.assertEqual(self.reply_model.payloads, [])
        self.reply_model.plans.append({"explore": {}})
        first = self._open(path, body)
        wrong_path = path.rsplit("/", 1)[0] + "/" + str(uuid4())
        self.assertEqual(self._confirm(wrong_path, first)[0], 409)
        self.assertEqual(self._calls("reply_to_message"), [])

    def test_initiate_confirmed_suggestion_without_server_reference_is_rejected(self):
        path, _, _ = self._prepare("initiate_conversation")
        before = self.backend.request(path)[1]
        self.reply_model.plans.append({"text": "最近还好吗？", "basis": "合成未确认建议。"})
        status, result = self.backend.request(path + "/replies", {
            "idempotency_key": str(uuid4()), "contact_id": path.split("/")[3],
            "content": {"type": "initiate_conversation", "purpose": "模型猜出的目的。", "purpose_source": "confirmed_suggestion"},
        })
        self.assertEqual(status, 409, result)
        self.assertEqual(self.reply_model.payloads, [])
        self.assertEqual(self.backend.request(path)[1], before)

    def test_answer_with_remaining_ambiguity_does_not_generate_even_after_selection(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            path, body, _ = self._prepare(scene)
            self.reply_model.plans.extend([
                {"explore": {"question": {"text": "是否承诺见面？", "impact": "commitment"}}},
                {"explore": {"ambiguities": ["尚未说清本次希望推进的目的。"]}},
            ])
            first = self._open(path, body)
            status, selected = self._confirm(path, first)
            self.assertEqual(status, 200, selected)
            status, result = self._answer(path, selected)
            self.assertEqual(status, 200, result)
            self.assertEqual(result["kind"], "directions")
            self.assertTrue(result["ambiguities"])
            self.assertEqual(result["confirmed_intent"], selected["confirmed_intent"])
            self.assertEqual(self._calls(scene), [])

    def test_direct_intent_after_exploration_preserves_user_text_and_actual_reference(self):
        path, body, _ = self._prepare("initiate_conversation")
        self.reply_model.plans.extend([{"explore": {}}, {"text": "这次我先不约了。", "basis": "保留用户明确拒绝的目的。"}])
        result = self._open(path, body)
        intent = "明确拒绝，不因模型建议而改变。"
        status, generated = self.backend.request(path + f"/explorations/{result['exploration_id']}/confirm", {"generate": True,
            "input_version_id": result["input_version_id"], "direct_intent": intent,
        })
        self.assertEqual(status, 200, generated)
        actual = self.reply_model.payloads[-1]
        self.assertEqual(actual["purpose_source"], "direct_input")
        self.assertEqual(actual["fidelity_contract"]["current_intent"]["text"], intent)
        self.assertEqual(len(self.backend.request(path)[1]["turns"]), 1)

    def test_completed_confirmation_and_answer_replay_after_current_revision_and_ttl_change(self):
        for action in ("confirm", "answer"):
            path, body, source = self._prepare()
            question = {"text": "是否承诺见面？", "impact": "commitment"} if action == "answer" else None
            self.reply_model.plans.append({"explore": {"question": question}})
            first = self._open(path, body)
            if action == "confirm":
                self.reply_model.plans.append({"text": "最近还好吗？", "basis": "本次已确认意愿。"})
            status, selected = self._confirm(path, first)
            if action == "answer":
                self.assertEqual(status, 200, selected)
                key = str(uuid4())
                self.reply_model.plans.extend([{"explore": {}}, {"text": "最近还好吗？", "basis": "本次已确认意愿。"}])
                status, generated = self._answer(path, selected, operation=key)
            else:
                generated = selected
            self.assertEqual(status, 200, generated)
            status, newer = self.backend.request(path + "/inputs", {
                "expected_input_version_id": generated["turn"]["input_version_id"],
                "content": {"type": "response_exploration", "target_message_id": body["content"]["target_message_id"],
                            "correction": "后来的新讨论。"},
            })
            self.assertEqual(status, 200, newer)
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
                connection.execute("UPDATE public.reply_exploration SET root_created_at=now()-interval '16 minutes' WHERE contact_id=%s",
                                   (path.split("/")[3],))
            self.assertEqual(self.backend.request(path + f"/explorations/{first['exploration_id']}")[0], 409)
            before, calls = self.backend.request(path)[1], len(self.reply_model.payloads)
            retry = self._answer(path, selected, operation=key) if action == "answer" else self._confirm(path, first)
            self.assertEqual(retry, (200, generated))
            self.assertEqual(self.backend.request(path)[1], before)
            self.assertEqual(len(self.reply_model.payloads), calls)
            invalid = self._answer(path, selected, "改变旧回答。", operation=key) if action == "answer" else self._confirm(path, first, 1)
            self.assertEqual(invalid[0], 409)
            status, _ = self.backend.request(f"/api/contacts/{path.split('/')[3]}/sources/{source}", method="DELETE")
            self.assertEqual(status, 202)
            retry = self._answer(path, selected, operation=key) if action == "answer" else self._confirm(path, first)
            self.assertEqual(retry[0], 409)
            self.assertEqual(len(self.reply_model.payloads), calls)

    def test_revision_change_between_exploration_guard_and_base_context_never_calls_generation_model(self):
        from notalone.reply.context import RetrievalReplyContext

        path, body, _ = self._prepare()
        self.reply_model.plans.extend([{"explore": {}}, {"text": "最近还好吗？", "basis": "合成旧策略。"}])
        first = self._open(path, body)
        original = RetrievalReplyContext.build
        def changed(context, **kwargs):
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
            return original(context, **kwargs)
        with patch.object(RetrievalReplyContext, "build", changed):
            self.assertNotEqual(self._confirm(path, first)[0], 200)
        self.assertEqual(self._calls("reply_to_message"), [])

    def test_revision_change_after_model_before_actual_candidate_commit_saves_no_candidate(self):
        from notalone.persistence.reply_store import PostgresReplyStore

        path, body, _ = self._prepare()
        self.reply_model.plans.extend([{"explore": {}}, {"text": "最近还好吗？", "basis": "合成旧策略。"}])
        first = self._open(path, body)
        original = PostgresReplyStore.save
        def changed(store, *args, **kwargs):
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.skill_library SET revision=revision+1 WHERE owner_id=%s", (self.owner_id,))
            return original(store, *args, **kwargs)
        with patch.object(PostgresReplyStore, "save", changed):
            self.assertNotEqual(self._confirm(path, first)[0], 200)
        with psycopg.connect(self.database_url) as connection:
            count = connection.execute("SELECT count(*) FROM public.reply_candidate WHERE contact_id=%s",
                                       (path.split("/")[3],)).fetchone()[0]
        self.assertEqual(count, 0)

    def test_integer_suggestion_for_both_scenes_is_rejected_without_advancing_live_input(self):
        for scene in ("reply_to_message", "initiate_conversation"):
            path, body, _ = self._prepare(scene)
            self.reply_model.plans.append({"explore": {}})
            first = self._open(path, body)
            before = self.backend.request(path)[1]
            content = ({"type": scene, "target_message_id": body["content"]["target_message_id"],
                        "direction": "伪造旧整数建议。", "direction_source": "confirmed_suggestion"}
                       if scene == "reply_to_message" else {"type": scene, "purpose": "伪造旧整数建议。",
                                                              "purpose_source": "confirmed_suggestion"})
            status, result = self.backend.request(path + "/replies", {
                "contact_id": path.split("/")[3], "idempotency_key": str(uuid4()), "content": content,
                "suggestion": {"task_id": first["exploration_id"], "input_version": 1,
                               "suggestion_id": first["options"][0]["suggestion_id"]},
            })
            self.assertEqual(status, 400, result)
            self.assertEqual(self.backend.request(path)[1], before)
            self.assertEqual(self._calls(scene), [])

    def test_ttl_crossing_at_actual_save_erases_exploration_body_after_owner_transaction(self):
        from notalone.persistence.reply_store import PostgresReplyStore

        path, body, _ = self._prepare()
        self.reply_model.plans.extend([{"explore": {}}, {"text": "最近还好吗？", "basis": "合成旧任务。"}])
        first = self._open(path, body)
        original = PostgresReplyStore.save
        def expired(store, *args, **kwargs):
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.reply_exploration SET root_created_at=now()-interval '16 minutes' WHERE id=%s",
                                   (first["exploration_id"],))
            return original(store, *args, **kwargs)
        with patch.object(PostgresReplyStore, "save", expired):
            self.assertNotEqual(self._confirm(path, first)[0], 200)
        # 不调用B读入口，直接核对保存拒绝后的已提交清理。
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute("SELECT state,input_payload,result_payload,snapshots,intent_snapshots,selected_intent,source_ids "
                                     "FROM public.reply_exploration WHERE id=%s", (first["exploration_id"],)).fetchone()
            count = connection.execute("SELECT count(*) FROM public.reply_candidate WHERE contact_id=%s",
                                       (path.split("/")[3],)).fetchone()[0]
        self.assertEqual(row, ("expired", None, None, [], [], None, []))
        self.assertEqual(count, 0)
