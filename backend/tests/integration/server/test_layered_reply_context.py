"""联系人分层资料沿公开HTTP、真实隔离PG及实际模型输入验证。"""

import unittest
from datetime import datetime, timezone
from langchain_core.messages import SystemMessage

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture
from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest


class LayeredReplyHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    controlled = LayeredProfileHttpTest.controlled
    read = LayeredProfileHttpTest.read
    enable = LayeredProfileHttpTest.enable

    def test_reply_uses_frozen_background_directory_and_preserves_l1(self):
        contact, _, message = self.import_contact("双方共同参加过合成课程。")
        memory = self.confirm(contact, "双方共同参加过课程。", message)
        backend = self.controlled()
        ready = self.enable(backend, contact)
        from notalone.reply.layered_context import LayeredReplyBudget
        self.layered_reply_options = {"layered_memory": self.service,
            "layered_reply_budget": LayeredReplyBudget(4, 4, 4000)}
        self.activate_replies(contact)
        self.reply_model.plans.append({"text": "还记得一起上课的时光。", "basis": "共同经历。",
                                      "cite_kinds": ["confirmed_memory"]})
        path = self.reply_path(contact)
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊共同参加的课程。"))
        self.assertEqual(status, 200, turn)
        system = "\n".join(str(message.content) for call in self.reply_model.seen_calls
                           for message in call if isinstance(message, SystemMessage))
        self.assertIn("双方有共同学习经历", system)
        self.assertIn(ready["profile"]["version_id"], system)
        self.assertNotIn("paragraphs", system)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(evidence["layered_context"]["profile_version_id"], ready["profile"]["version_id"])
        self.assertEqual(evidence["layered_context"]["directory"][0]["version_id"], ready["scenarios"][0]["version_id"])
        self.assertIn(memory["memory_id"], [item["evidence_id"] for item in evidence["evidence"]])
        self.assertEqual(evidence["retrieval"]["budgets"]["contact_memory"]["limit"], 5)

    def prepare_layered_reply(self):
        contact, source, message = self.import_contact("双方共同参加过合成课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        self.layered_source_message = message
        backend = self.controlled()
        ready = self.enable(backend, contact)
        from notalone.reply.layered_context import LayeredReplyBudget
        self.layered_reply_options = {"layered_memory": self.service,
            "layered_reply_budget": LayeredReplyBudget(4, 4, 4000)}
        self.activate_replies(contact)
        return contact, source, backend, ready, self.reply_path(contact)

    def test_delete_results_erases_layered_reply_copies_and_reopen_cannot_replay_old_input(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        body = self.rewrite_body(contact, "聊聊共同参加的课程。")
        self.reply_model.plans.append({"text": "聊聊课程吧。", "basis": "按本次草稿。"})
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        status, disabled = management.request(f"/api/contacts/{contact}/layered-memory/delete",
            {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, disabled)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, turn))[0], 200)
        self.assertNotIn("聊聊共同参加的课程", str(self._get(self.backend, path)))
        self.enable(management, contact)
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_disabled_scope_preserves_history_but_rejects_prepared_aba_and_new_reply_uses_l1(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        self.reply_model.plans.append({"text": "聊聊课程。", "basis": "按本次草稿。"})
        status, completed = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊共同课程。"))
        self.assertEqual(status, 200, completed)
        saved = self._get(self.backend, self.evidence_path(contact, completed))
        body = self.rewrite_body(contact, "再聊共同课程。")
        self.assertEqual(self.backend.request(path + "/replies/prepare", body)[0], 200)
        status, disabled = management.request(f"/api/contacts/{contact}/layered-memory/disable",
            {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, disabled)
        self.assertEqual(self._get(self.backend, self.evidence_path(contact, completed)), saved)
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.enable(management, contact)
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_correcting_uncited_input_erases_prepared_and_completed_layered_copies(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        memory = ready["profile"]["entries"][0]["references"][0]["memory_id"]
        self.reply_model.plans.append({"text": "聊聊课程。", "basis": "按草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊课程。"))
        self.assertEqual(status, 200, turn)
        status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{memory}/correct", {"text": "双方没有共同参加课程。"})
        self.assertEqual(status, 200, corrected)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, turn))[0], 200)

    def test_full_request_capacity_omits_new_layers_without_cutting_user_or_l1(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        decisions = []
        self.layered_reply_options["on_input_budget"] = decisions.append
        self.backend = self._backend(self.owner_id)
        body = self.rewrite_body(contact, "我想聊聊共同参加的课程。")
        self.assertEqual(self.backend.request(path + "/replies/prepare", body)[0], 200)
        self.assertTrue(decisions)
        self.reply_capacity = decisions[-1].total_tokens - 500
        self.backend = self._backend(self.owner_id)
        # 新会话没有旧讨论内容；相同当前输入与L1，仅新增资料占用使容量不足。
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-sessions", {}, method="POST")
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        self.reply_model.plans.append({"text": "我想聊聊共同参加的课程。", "basis": "按本次草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, body["content"]["draft_text"]))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertIsNone(evidence["layered_context"])
        self.assertEqual(evidence["layered_status"], "budget_omitted")
        self.assertEqual(self.reply_model.payloads[-1]["draft_text"], body["content"]["draft_text"])
        self.assertTrue(any(item["kind"] == "confirmed_memory" for item in evidence["evidence"]))

    def test_hidden_organization_input_source_delete_erases_all_used_copies(self):
        contact, source, message = self.import_contact("双方共同参加过课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        _, hidden_source, hidden_message = self.import_contact("另有合成材料记录分开练习。", contact_id=contact,
            when=datetime(2024, 2, 1, tzinfo=timezone.utc))
        hidden = self.confirm(contact, "双方曾分开练习。", hidden_message)
        management = self.controlled()
        ready = self.enable(management, contact)
        all_inputs = self.profile_proposer.inputs[0][1]
        self.assertEqual(len(all_inputs), 2)
        cited = {ref["memory_id"] for entry in ready["profile"]["entries"] for ref in entry["references"]}
        # 选择真实未被画像引用的另一输入及其来源，而不是按脚本排列猜测。
        if hidden["memory_id"] in cited:
            removed_source = source
        else:
            removed_source = hidden_source
        from notalone.reply.layered_context import LayeredReplyBudget
        self.layered_reply_options = {"layered_memory": self.service,
            "layered_reply_budget": LayeredReplyBudget(4, 4, 4000)}
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "你好。", "basis": "按草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "你好。"))
        self.assertEqual(status, 200, turn)
        body = self.rewrite_body(contact, "准备另一轮你好。")
        self.assertEqual(self.backend.request(path + "/replies/prepare", body)[0], 200)
        self.delete_source(contact, removed_source)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, turn))[0], 200)
        self.assertNotIn("准备另一轮你好", str(self._get(self.backend, path)))
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_disable_between_tool_rounds_prevents_the_next_actual_model_send(self):
        from concurrent.futures import ThreadPoolExecutor
        contact, _, management, ready, path = self.prepare_layered_reply()
        self.reply_model.plans.extend([
            {"history": {"name": "conversation_search", "args": {"query": "课程", "top_k": 2}}},
            {"text": "不应发起第二次模型请求。", "basis": "不得提交。"},
        ])
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", self.rewrite_body(contact, "聊聊课程。"))
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, disabled = management.request(f"/api/contacts/{contact}/layered-memory/disable",
                    {"settings_generation": ready["settings_generation"]})
                self.assertEqual(status, 200, disabled)
                gate.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                gate.set()
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(len(self.reply_model.plans), 1)
        self.assertNotIn("不应发起第二次", str(self._get(self.backend, path)))

    def test_legacy_prepared_schema_is_rejected_without_resigning_layered_fields(self):
        import psycopg
        contact, _, _, _, path = self.prepare_layered_reply()
        body = self.rewrite_body(contact, "旧快照不能补签。")
        self.assertEqual(self.backend.request(path + "/replies/prepare", body)[0], 200)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context="
                "jsonb_set(prepared_context #- '{context,layered_context}', '{schema_revision}', '5') "
                "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                (self.owner_id, contact, body["idempotency_key"]))
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), 0)

    def test_final_writer_rechecks_disabled_generation_after_model_validation(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from unittest.mock import patch
        from notalone.persistence.reply_store import PostgresReplyStore

        class CommitBarrierStore(PostgresReplyStore):
            def save(self, request, context, reply):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("合成writer边界未释放。")
                return super().save(request, context, reply)

        contact, _, management, ready, path = self.prepare_layered_reply()
        entered, release = Event(), Event()
        store = CommitBarrierStore(self.database_url, layered_memory=self.service,
            layered_budget=self.layered_reply_options["layered_reply_budget"])
        with patch("notalone.server.reply_wiring.PostgresReplyStore", return_value=store):
            self.backend = self._backend(self.owner_id)
        self.reply_model.plans.append({"text": "提交前停用不得保存。", "basis": "按草稿。"})
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", self.rewrite_body(contact, "聊聊课程。"))
            try:
                self.assertTrue(entered.wait(5))
                status, disabled = management.request(f"/api/contacts/{contact}/layered-memory/disable",
                    {"settings_generation": ready["settings_generation"]})
                self.assertEqual(status, 200, disabled)
                release.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                release.set()
        self.assertNotIn("提交前停用不得保存", str(self._get(self.backend, path)))

    def test_unavailable_or_unqualified_layers_leave_l1_and_owner_context_unchanged(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        for mode in ("quality_closed", "not_allowed", "unavailable"):
            with self.subTest(mode=mode):
                if mode == "quality_closed":
                    options = self.layered_reply_options
                    self.layered_reply_options = {}
                elif mode == "not_allowed":
                    self.layered_reply_options = options
                else:
                    status, result = management.request(f"/api/contacts/{contact}/layered-memory/disable",
                        {"settings_generation": ready["settings_generation"]})
                    self.assertEqual(status, 200, result)
                self.backend = self._backend(self.owner_id)
                self.reply_model.plans.append({"text": "聊聊课程。", "basis": "按草稿。"})
                status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊共同课程。",
                    include_context=mode != "not_allowed"))
                self.assertEqual(status, 200, turn)
                saved = self._get(self.backend, self.evidence_path(contact, turn))
                self.assertIsNone(saved["layered_context"])
                self.assertEqual(saved["layered_status"], mode)
                if mode != "not_allowed":
                    self.assertTrue(any(item["kind"] == "confirmed_memory" for item in saved["evidence"]))

    def test_rejecting_pending_candidate_with_shared_source_cleans_derived_reply(self):
        from uuid import UUID, uuid4
        from notalone.memory.models import MemoryCandidate, MemoryCategory
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.scopes import ContactScope
        contact, _, management, ready, path = self.prepare_layered_reply()
        candidate = PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=ContactScope(self.owner_id, UUID(contact)),
            text="合成待确认参考：双方共同参加过课程。", category=MemoryCategory.COMMON_FACT,
            source_ids=(self.layered_source_message,)))
        status, refreshed = management.request(f"/api/contacts/{contact}/layered-memory/refresh",
            {"settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, refreshed)
        self.reply_model.plans.append({"text": "聊聊课程。", "basis": "按草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "你好。"))
        self.assertEqual(status, 200, turn)
        self.assertIsNotNone(self._get(self.backend, self.evidence_path(contact, turn))["layered_context"])
        status, rejected = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{candidate.candidate_id}/discard", {})
        self.assertEqual(status, 200, rejected)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, turn))[0], 200)
