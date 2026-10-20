"""完整有效讨论经实际生产装配进入模型与总预算，不复制历史正文。"""

from __future__ import annotations

import json
import unittest
from uuid import UUID, uuid4

from notalone.persistence.assistant_candidate_versions import (
    EditAssistantCandidate, PostgresAssistantCandidateVersions,
)
from notalone.reply.interface import CandidateMessage
from notalone.scopes import ContactScope

from tests.integration.server import test_assistant_input_budget as metadata_fixture


class AssistantDiscussionBudgetHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        metadata_fixture.AssistantInputBudgetHttpTest.setUpClass()

    def setUp(self) -> None:
        self.fixture = metadata_fixture.AssistantInputBudgetHttpTest()
        self.addCleanup(self._release_fixture)
        self.fixture.setUp()

    def _release_fixture(self) -> None:
        if not self.fixture.doCleanups():
            raise RuntimeError("合成预算HTTP夹具清理失败。")

    @staticmethod
    def _model_request(actual: dict) -> dict:
        return json.loads(next(message["content"] for message in actual["messages"]
                               if message["role"] == "user"))

    def _discussion(self, backend, path: str, marker: str) -> dict:
        status, created = backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": marker},
        })
        self.assertEqual(status, 200, created)
        return created

    def _generate(self, backend, contact_id: str, path: str, *, draft: str,
                  expected: str, instruction: str | None = None,
                  candidate: str | None = None) -> tuple[int, dict, dict]:
        body = self.fixture._body(contact_id, draft)
        body["expected_input_version_id"] = expected
        if instruction is not None:
            body["content"]["user_instruction"] = instruction
        self.fixture._plan(candidate or draft)
        status, response = backend.request(path + "/replies", body)
        return status, response, body

    def test_public_discussion_enters_the_actual_model_request_as_complete_non_fact_reference(self):
        contact_id, path = self.fixture._session(self.fixture.backend)
        marker = "合成有效讨论：措辞平静，保持明确含义。"
        status, discussion = self.fixture.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": marker},
        })
        self.assertEqual(status, 200, discussion)
        draft = "今晚不参加，祝活动顺利。"
        body = self.fixture._body(contact_id, draft)
        body["expected_input_version_id"] = discussion["input_version_id"]
        self.fixture._plan(draft)

        status, generated = self.fixture.backend.request(path + "/replies", body)

        self.assertEqual(status, 200, generated)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), 1)
        actual = self.fixture.reply_model.seen_model_payloads[0]
        request = self._model_request(actual)
        self.assertIn("assistant_discussion", request)
        history = request["assistant_discussion"]
        self.assertEqual(history["factual_role"], "assistant_discussion_reference")
        self.assertEqual(history["weight"], "low")
        self.assertIn("以当前意愿为准", history["notice"])
        self.assertIn("不代表用户采用或发送", history["notice"])
        self.assertEqual(len(history["items"]), 1)
        item = history["items"][0]
        self.assertEqual(item["kind"], "discussion_input")
        self.assertEqual(item["role"], "user")
        self.assertEqual(item["input_version_id"], discussion["input_version_id"])
        self.assertEqual(json.loads(item["text"])["purpose_hint"], marker)
        self.assertEqual(generated["input_budget"]["state"], "ready")

    def test_all_prior_user_and_candidate_version_text_is_measured_without_promoting_selection_to_sent(self):
        counters = []
        backend, decisions = self.fixture._budget_backend(self.fixture.owner_id, counters=counters)
        contact_id, path = self.fixture._session(backend)
        marker = "合成旧讨论：保持明确表达。"
        discussion = self._discussion(backend, path, marker)
        old_instruction = "合成兼容要求：保持措辞平静。"
        old_candidate = "合成旧 AI 候选：可以，我愿意参加。"
        status, first, _ = self._generate(
            backend, contact_id, path, draft="可以，我愿意参加。",
            expected=discussion["input_version_id"], instruction=old_instruction,
            candidate=old_candidate,
        )
        self.assertEqual(status, 200, first)
        current = "谢谢邀请，这次不参加。"

        status, second, _ = self._generate(
            backend, contact_id, path, draft=current,
            expected=first["input_version_id"], instruction="合成当前表达要求：更简洁。",
        )

        self.assertEqual(status, 200, second)
        actual = self.fixture.reply_model.seen_model_payloads
        self.assertEqual(counters[0].seen_payloads, actual)
        request = self._model_request(actual[-1])
        self.assertEqual(request["draft_text"], current)
        self.assertEqual(request["fidelity_contract"]["current_intent"]["text"], current)
        items = request["assistant_discussion"]["items"]
        self.assertEqual([item["kind"] for item in items],
                         ["discussion_input", "generation_input", "candidate_version"])
        self.assertIn(marker, items[0]["text"])
        self.assertEqual(json.loads(items[1]["text"])["content"]["user_instruction"], old_instruction)
        candidate = items[2]
        self.assertEqual(candidate["candidate_id"], first["candidates"][0]["candidate_id"])
        self.assertEqual(candidate["role"], "assistant_candidate")
        self.assertTrue(candidate["is_default_display"])
        self.assertFalse(candidate["is_explicitly_selected"])
        self.assertFalse(candidate["is_sent"])
        self.assertEqual(candidate["candidate_number"], 1)
        self.assertEqual(candidate["version_number"], 0)
        self.assertIsNone(candidate["parent_version_id"])
        self.assertEqual(json.loads(candidate["text"])["messages"][0]["text"], old_candidate)
        self.assertNotIn(second["input_version_id"], {item["input_version_id"] for item in items})
        self.assertGreater(decisions[-1].total_tokens, decisions[0].total_tokens + 500)
        calls = len(actual)
        status, saved = backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["reply"]["input_budget"], first["input_budget"])
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)

    def test_cumulative_limit_blocks_the_next_model_but_keeps_complete_history_readable(self):
        marker = "合成已授权完整讨论：" + "保留所有兼容要求。" * 80
        old_draft = "合成旧原句：" + "今晚不参加，感谢邀请。" * 70
        instruction = "合成兼容要求：保持平静，不能省略。"
        baseline, baseline_decisions = self.fixture._budget_backend(self.fixture.owner_id)
        contact_id, path = self.fixture._session(baseline)
        first_input = self._discussion(baseline, path, marker)
        status, completed, _ = self._generate(
            baseline, contact_id, path, draft=old_draft,
            expected=first_input["input_version_id"], instruction=instruction,
        )
        self.assertEqual(status, 200, completed)
        capacity = max(item.total_tokens for item in baseline_decisions) + 100
        counters = []
        limited, decisions = self.fixture._budget_backend(
            self.fixture.owner_id, capacity=capacity, counters=counters,
        )
        contact_id, path = self.fixture._session(limited)
        first_input = self._discussion(limited, path, marker)
        status, first, _ = self._generate(
            limited, contact_id, path, draft=old_draft,
            expected=first_input["input_version_id"], instruction=instruction,
        )
        self.assertEqual(status, 200, first)
        self.assertEqual(first["input_budget"]["state"], "warning")
        calls_before = len(self.fixture.reply_model.seen_model_payloads)
        # 首轮窗口容纳完整生成；新增完整讨论使下一轮生成本身超过窗口。
        added_text = "新增合成完整讨论：" + "继续保留原始要求。" * 1000
        added = self._discussion(limited, path, added_text)

        status, blocked, new_body = self._generate(
            limited, contact_id, path, draft="合成新的简短原句。",
            expected=added["input_version_id"], instruction="保留兼容要求。",
        )

        self.assertEqual(status, 409, blocked)
        self.assertEqual(blocked["error"], "input_budget_exceeded")
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls_before)
        self.assertEqual(blocked["input_budget"], decisions[-1].to_payload())
        self.assertGreater(decisions[-1].total_tokens, capacity)
        attempted = self._model_request(counters[0].seen_payloads[-1])
        self.assertIn(marker, attempted["assistant_discussion"]["items"][0]["text"])
        self.assertIn(added_text, attempted["assistant_discussion"]["items"][-1]["text"])
        self.assertEqual(json.loads(attempted["assistant_discussion"]["items"][1]["text"])
                         ["content"]["draft_text"], old_draft)
        self.assertEqual(json.loads(attempted["assistant_discussion"]["items"][2]["text"])
                         ["messages"][0]["text"], old_draft)
        measures_before = len(counters[0].seen_payloads)
        status, saved = limited.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["inputs"][0]["content"]["purpose_hint"], marker)
        self.assertEqual(saved["turns"][0]["input"]["content"]["draft_text"], old_draft)
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], first["candidates"])
        self.assertEqual(saved["turns"][1]["input"]["content"]["draft_text"],
                         new_body["content"]["draft_text"])
        self.assertIsNone(saved["turns"][1]["reply"])
        self.assertEqual(len(counters[0].seen_payloads), measures_before)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls_before)

    def test_blocked_user_requirements_remain_in_the_next_complete_request_without_failed_ai(self):
        blocked_backend, _ = self.fixture._budget_backend(self.fixture.owner_id, capacity=101)
        contact_id, path = self.fixture._session(blocked_backend)
        body = self.fixture._body(contact_id, "合成失败旧原句：今晚不参加。")
        old_requirement = "合成失败 USER 要求：保持清晰和平静，不能丢弃。"
        body["content"]["user_instruction"] = old_requirement
        status, blocked = blocked_backend.request(path + "/replies", body)
        self.assertEqual(status, 409, blocked)
        self.assertEqual(self.fixture.reply_model.seen_model_payloads, [])
        status, old_saved = blocked_backend.request(path)
        self.assertEqual(status, 200, old_saved)
        expected = old_saved["current_input_version_id"]
        counters = []
        valid, decisions = self.fixture._budget_backend(self.fixture.owner_id, counters=counters)

        status, generated, _ = self._generate(
            valid, contact_id, path, draft="合成当前原句：感谢邀请，这次不参加。",
            expected=expected, instruction="表达更简洁。",
        )

        self.assertEqual(status, 200, generated)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), 1)
        self.assertEqual(self.fixture.reply_model.review_calls, 0)
        self.assertEqual(counters[0].seen_payloads, self.fixture.reply_model.seen_model_payloads)
        items = self._model_request(counters[0].seen_payloads[0])["assistant_discussion"]["items"]
        self.assertEqual([item["kind"] for item in items], ["generation_input"])
        self.assertEqual(json.loads(items[0]["text"])["content"]["user_instruction"], old_requirement)
        self.assertEqual(json.loads(items[0]["text"])["content"]["draft_text"], body["content"]["draft_text"])
        self.assertEqual(generated["input_budget"], decisions[-1].to_payload())
        status, saved = valid.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "failed")
        self.assertEqual(saved["turns"][0]["input"]["content"]["user_instruction"], old_requirement)
        self.assertIsNone(saved["turns"][0]["reply"])

    def test_each_actual_tool_round_retains_and_measures_the_original_complete_discussion(self):
        counters = []
        backend, decisions = self.fixture._budget_backend(self.fixture.owner_id, counters=counters)
        contact_id, path = self.fixture._session(backend)
        marker = "合成原始讨论不可摘要：" + "保持所有用户要求。" * 100
        discussion = self._discussion(backend, path, marker)
        self.fixture._tool_source(contact_id)
        draft = "合成当前原句：今晚不参加。"
        body = self.fixture._body(contact_id, draft)
        body["expected_input_version_id"] = discussion["input_version_id"]
        body["content"]["include_relationship_context"] = True
        self.fixture._plan(draft)
        self.fixture.reply_model.search_next = True

        status, generated = backend.request(path + "/replies", body)

        self.assertEqual(status, 200, generated)
        actual = self.fixture.reply_model.seen_model_payloads
        self.assertEqual(len(actual), 2)
        self.assertEqual(counters[0].seen_payloads, actual)
        histories = [self._model_request(payload)["assistant_discussion"] for payload in actual]
        self.assertEqual(histories[0], histories[1])
        self.assertEqual(json.loads(histories[1]["items"][0]["text"])["purpose_hint"], marker)
        self.assertGreater(decisions[-1].total_tokens, decisions[0].total_tokens)
        self.assertEqual(generated["input_budget"], decisions[-1].to_payload())

    def test_legacy_global_request_has_no_assistant_anchor_and_keeps_its_own_input(self):
        backend, _ = self.fixture._budget_backend(self.fixture.owner_id)
        contact_id, path = self.fixture._session(backend)
        marker = "合成某会话讨论不得进入独立全局生成。"
        self._discussion(backend, path, marker)
        body = self.fixture._body(contact_id, "合成独立旧端点原句。")
        self.fixture._plan(body["content"]["draft_text"])

        status, generated = backend.request("/api/reply/generate", body)

        self.assertEqual(status, 200, generated)
        request = self._model_request(self.fixture.reply_model.seen_model_payloads[0])
        self.assertNotIn("assistant_discussion", request)
        self.assertNotIn(marker, json.dumps(request, ensure_ascii=False))
        self.assertEqual(request["draft_text"], body["content"]["draft_text"])

    def test_completed_replay_after_new_current_input_keeps_saved_receipt_without_new_model(self):
        backend, decisions = self.fixture._budget_backend(self.fixture.owner_id)
        contact_id, path = self.fixture._session(backend)
        discussion = self._discussion(backend, path, "合成初始讨论。")
        status, first, original_body = self._generate(
            backend, contact_id, path, draft="合成原句：今晚不参加。",
            expected=discussion["input_version_id"],
        )
        self.assertEqual(status, 200, first)
        status, latest = backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "合成更新后的明确讨论。"},
            "expected_input_version_id": first["input_version_id"],
        })
        self.assertEqual(status, 200, latest)
        unknown, new_decisions = self.fixture._budget_backend(self.fixture.owner_id, unknown=True)

        self.assertEqual(unknown.request(path + "/replies", original_body), (200, first))

        status, saved = unknown.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], latest["input_version_id"])
        self.assertEqual(saved["turns"][0]["reply"]["input_budget"], first["input_budget"])
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), 1)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(new_decisions, [])

    def test_other_scope_cannot_read_discussion_and_own_new_contact_does_not_inherit_it(self):
        backend, _ = self.fixture._budget_backend(self.fixture.owner_id)
        contact_id, path = self.fixture._session(backend)
        marker = "合成甲联系人独有讨论，不能进入乙。"
        self._discussion(backend, path, marker)
        self.assertEqual(self.fixture.other_backend.request(path), (404, {"error": "not_found"}))
        second_contact, second_path = self.fixture._session(backend)
        body = self.fixture._body(second_contact, "合成乙联系人原句。")
        self.fixture._plan(body["content"]["draft_text"])

        status, generated = backend.request(second_path + "/replies", body)

        self.assertEqual(status, 200, generated)
        request = self._model_request(self.fixture.reply_model.seen_model_payloads[0])
        self.assertEqual(request["assistant_discussion"]["items"], [])
        self.assertNotIn(marker, json.dumps(request, ensure_ascii=False))
        swapped_path = path.replace(contact_id, second_contact)
        self.assertEqual(backend.request(swapped_path), (404, {"error": "not_found"}))
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), 1)

    def test_deleted_history_cannot_reappear_in_a_new_default_session_or_model_request(self):
        backend, _ = self.fixture._budget_backend(self.fixture.owner_id)
        contact_id, path = self.fixture._session(backend)
        marker = "合成已删除讨论，不可恢复到新默认会话。"
        discussion = self._discussion(backend, path, marker)
        status, first, old_body = self._generate(
            backend, contact_id, path, draft="合成删除前旧原句。",
            expected=discussion["input_version_id"],
        )
        self.assertEqual(status, 200, first)
        self.assertEqual(backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(backend.request(path), (404, {"error": "not_found"}))
        self.assertEqual(backend.request(path + "/replies", old_body), (404, {"error": "not_found"}))
        status, default = backend.request(f"/api/contacts/{contact_id}/assistant-session/default", {})
        self.assertEqual(status, 200, default)
        new_path = f"/api/contacts/{contact_id}/assistant-sessions/{default['session_id']}"
        self.assertNotEqual(new_path, path)
        body = self.fixture._body(contact_id, "合成删除后新原句。")
        self.fixture._plan(body["content"]["draft_text"])

        status, generated = backend.request(new_path + "/replies", body)

        self.assertEqual(status, 200, generated)
        request = self._model_request(self.fixture.reply_model.seen_model_payloads[-1])
        self.assertEqual(request["assistant_discussion"]["items"], [])
        self.assertNotIn(marker, json.dumps(request, ensure_ascii=False))
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), 2)

    def test_all_actual_candidate_versions_and_explicit_selection_are_preserved_as_unsent(self):
        backend, _ = self.fixture._budget_backend(self.fixture.owner_id)
        contact_id, path = self.fixture._session(backend)
        discussion = self._discussion(backend, path, "合成保留修改痕迹的讨论。")
        original_text = "合成原候选，保持平静。"
        status, first, _ = self._generate(
            backend, contact_id, path, draft=original_text,
            expected=discussion["input_version_id"],
        )
        self.assertEqual(status, 200, first)
        scope = ContactScope(self.fixture.owner_id, UUID(contact_id))
        session_id = UUID(path.rsplit("/", 1)[-1])
        candidate_id = UUID(first["candidates"][0]["candidate_id"])
        versions = PostgresAssistantCandidateVersions(self.fixture.database_url)
        original = versions.read(scope, session_id, candidate_id).versions[0]
        edited_text = "合成用户编辑后的候选，更明确。"
        edited = versions.edit(scope, session_id, candidate_id, EditAssistantCandidate(
            edit_key=uuid4(), parent_version_id=original.version_id,
            messages=(CandidateMessage(original.messages[0].message_id, edited_text),),
            requirements="合成编辑要求，不能抹去。",
        )).versions[-1]
        versions.select(scope, session_id, candidate_id, original.version_id, uuid4())

        status, generated, _ = self._generate(
            backend, contact_id, path, draft="合成新原句，以当前明确要求为准。",
            expected=first["input_version_id"],
        )

        self.assertEqual(status, 200, generated)
        items = self._model_request(self.fixture.reply_model.seen_model_payloads[-1])[
            "assistant_discussion"]["items"]
        candidates = [item for item in items if item["kind"] == "candidate_version"]
        self.assertEqual([item["version_id"] for item in candidates],
                         [str(original.version_id), str(edited.version_id)])
        self.assertEqual([json.loads(item["text"])["messages"][0]["text"] for item in candidates],
                         [original_text, edited_text])
        self.assertEqual(candidates[1]["parent_version_id"], str(original.version_id))
        self.assertEqual(json.loads(candidates[1]["text"])["requirements"], "合成编辑要求，不能抹去。")
        self.assertTrue(candidates[0]["is_explicitly_selected"])
        self.assertFalse(candidates[0]["is_default_display"])
        self.assertFalse(candidates[1]["is_explicitly_selected"])
        self.assertTrue(candidates[1]["is_default_display"])
        self.assertTrue(all(item["is_sent"] is False for item in candidates))



if __name__ == "__main__":
    unittest.main()
