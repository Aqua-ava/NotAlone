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

    def test_corrected_layered_input_preserves_audit_and_blocks_reuse(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        memory = ready["profile"]["entries"][0]["references"][0]["memory_id"]
        self.reply_model.plans.append({"text": "打个招呼。", "basis": "按草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "打个招呼。"))
        self.assertEqual(status, 200, turn)
        status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{memory}/correct",
            {"text": "双方没有共同参加课程。", "change_kind": "error_correction"})
        self.assertEqual(status, 200, corrected)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(evidence["layered_context"]["profile_version_id"], ready["profile"]["version_id"])
        self.assertIn("memory_generation_forbidden", [item["reason"] for item in evidence["basis_changes"]])
        continued = self.rewrite_body(contact, "继续打个招呼。")
        continued["continued_from_candidate_id"] = turn["candidates"][0]["candidate_id"]
        self.assertNotEqual(self.backend.request(path + "/replies", continued)[0], 200)
        self.reply_model.plans.append({"text": "全新问候。", "basis": "按新草稿。"})
        status, fresh = self.backend.request(path + "/replies", self.rewrite_body(contact, "全新问候。"))
        self.assertEqual(status, 200, fresh)
        fresh_evidence = self._get(self.backend, self.evidence_path(contact, fresh))
        self.assertIsNone(fresh_evidence["layered_context"])
        self.assertEqual(len(self.reply_model.payloads), 2)

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

    def test_failed_profile_omits_affected_background_but_retains_legal_directory_and_l1(self):
        from notalone.reply.layered_context import LayeredReplyBudget
        from tests.integration.server.test_layered_profile_management import ProfileVerification
        contact, _, message = self.import_contact("双方共同参加过合成课程。")
        self.confirm(contact, "双方共同参加过课程。", message)
        management = self.controlled(profile_verifier=ProfileVerification(False))
        failed = self.enable(management, contact)
        self.assertEqual(failed["status"], "failed")
        self.assertIsNone(failed["profile"])
        self.assertTrue(failed["scenarios"])
        self.layered_reply_options = {"layered_memory": self.service,
            "layered_reply_budget": LayeredReplyBudget(4, 4, 4000)}
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "聊聊课程。", "basis": "按草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "聊聊共同课程。"))
        self.assertEqual(status, 200, turn)
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(saved["layered_context"]["profile_entries"], [])
        self.assertIsNone(saved["layered_context"]["profile_version_id"])
        self.assertEqual(saved["layered_context"]["directory"][0]["version_id"], failed["scenarios"][0]["version_id"])
        self.assertTrue(any(item["kind"] == "confirmed_memory" for item in saved["evidence"]))

    def test_explicit_prepare_then_generate_restores_the_exact_layered_input(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        body = self.rewrite_body(contact, "聊聊共同参加的课程。")
        status, prepared = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, prepared)
        self.reply_model.plans.append({"text": "聊聊课程。", "basis": "按草稿。"})
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(saved["layered_context"]["profile_version_id"], ready["profile"]["version_id"])

    def test_prepared_material_payload_must_match_its_frozen_snapshot(self):
        import json
        import psycopg
        from psycopg.types.json import Jsonb
        contact, _, _, _, path = self.prepare_layered_reply()
        body = self.rewrite_body(contact, "损坏快照不得进入模型。")
        self.assertEqual(self.backend.request(path + "/replies/prepare", body)[0], 200)
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute("SELECT prepared_context FROM public.assistant_session_turn "
                "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                (self.owner_id, contact, body["idempotency_key"])).fetchone()
            encoded = row[0]
            fields = encoded["context"]["layered_context"]["fields"]
            material = json.loads(fields["payload_json"])
            material["read_policy"] = "damaged-but-valid-json"
            fields["payload_json"] = json.dumps(material, ensure_ascii=False)
            connection.execute("UPDATE public.assistant_session_turn SET prepared_context=%s "
                "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                (Jsonb(encoded), self.owner_id, contact, body["idempotency_key"]))
        self.assertNotEqual(self.backend.request(path + "/replies", body)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), 0)

    def test_independent_review_receives_exact_frozen_background_for_past_facts(self):
        import json
        from langchain_core.messages import HumanMessage
        from notalone.reply.layered_context import LayeredReplyBudget
        contact, _, _ = self.import_contact("今天阳光明媚。")
        self.manual_contact(contact, "双方共同参加过课程。")
        management = self.controlled()
        ready = self.enable(management, contact)
        self.layered_reply_options = {"layered_memory": self.service,
            "layered_reply_budget": LayeredReplyBudget(4, 4, 4000)}
        self.activate_replies(contact)
        self.reply_model.plans.append({"text": "你好，想起以前一起学习的时光。", "basis": "背景记录共同学习经历。"})
        body = self.rewrite_body(contact, "你好。")
        body["content"]["user_instruction"] = "请自然表达，允许联系合法背景。"
        def faithful_review(payload, report):
            self.assertNotIn("学习经历", str(payload["evidence"]))
            material = payload.get("layered_context", {})
            supported = "双方有共同学习经历" in str(material.get("profile_entries", []))
            report["reviews"]["candidate_1"]["checks"]["facts"]["result"]["status"] = "supported" if supported else "unknown"
            return report
        self.reply_model.review_transform = faithful_review
        status, turn = self.backend.request(self.reply_path(contact) + "/replies", body)
        self.assertEqual(status, 200, turn)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        generation, review = self.reply_model.seen_calls
        system = next(str(item.content) for item in generation if isinstance(item, SystemMessage))
        sent, _ = json.JSONDecoder().raw_decode(system[system.index("{", system.index("<relationship_background>")):])
        payload = next(json.loads(item.content) for item in review if isinstance(item, HumanMessage))
        self.assertEqual(payload["layered_context"], sent)
        self.assertEqual(sent["profile_version_id"], ready["profile"]["version_id"])
        self.assertNotIn("dependency_ids", str(sent))
        self.assertNotIn("paragraphs", str(sent))

    def test_review_accepts_only_actual_profile_text_as_layered_fact_source_path(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        body = self.rewrite_body(contact, "你好。")
        body["content"]["user_instruction"] = "自然表达。"
        self.reply_model.plans.append({"text": "我们从来没有共同学习过。", "basis": "合成矛盾事实。"})
        def contradicting_fact(payload, report):
            report["reviews"]["candidate_1"]["checks"]["facts"]["result"] = {
                "status": "violation", "violation": {"category": "unsupported_fact",
                "candidate_path": "/text", "candidate_quote": "从来没有共同学习过",
                "source_path": "/layered_context/profile_entries/0/text",
                "source_quote": ready["profile"]["entries"][0]["text"]}}
            return report
        self.reply_model.review_transform = contradicting_fact
        self.assertEqual(self.backend.request(path + "/replies", body),
            (409, {"error": "reply_candidates_rejected"}))

    def test_review_budget_failure_preserves_frozen_input_and_stops_before_send(self):
        contact, _, _, _, path = self.prepare_layered_reply()
        decisions = []
        self.layered_reply_options["on_input_budget"] = decisions.append
        self.backend = self._backend(self.owner_id)
        body = self.rewrite_body(contact, "你好。")
        body["content"]["user_instruction"] = "自然表达。"
        self.reply_model.plans.append({"text": "你好，想起共同学习的时光。", "basis": "按背景。"})
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        review_total = decisions[-1].total_tokens
        self.assertGreater(review_total, max(item.total_tokens for item in decisions[:-1]))
        self.reply_capacity = review_total - 1
        self.backend = self._backend(self.owner_id)
        status, session = self.backend.request(f"/api/contacts/{contact}/assistant-sessions", {}, method="POST")
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        next_body = self.rewrite_body(contact, "你好。")
        next_body["content"]["user_instruction"] = "自然表达。"
        self.reply_model.plans.append({"text": "你好，想起共同学习的时光。", "basis": "按背景。"})
        before = len(self.reply_model.seen_calls)
        status, result = self.backend.request(path + "/replies", next_body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(len(self.reply_model.seen_calls) - before, 1)
        self.assertIn("双方有共同学习经历", str(self.reply_model.seen_calls[-1]))
        self.assertGreater(decisions[-1].total_tokens, self.reply_capacity)

    def test_review_rejects_directory_and_background_as_current_intent_sources(self):
        contact, _, _, ready, path = self.prepare_layered_reply()
        for category, source_path, quote in (
            ("facts", "/layered_context/directory/0/title", ready["scenarios"][0]["title"]),
            ("instruction", "/layered_context/profile_entries/0/text", ready["profile"]["entries"][0]["text"]),
        ):
            with self.subTest(category=category):
                body = self.rewrite_body(contact, "你好。")
                body["content"]["user_instruction"] = "自然表达。"
                self.reply_model.plans.append({"text": "你好。", "basis": "合成。"})
                def invalid_source(payload, report):
                    report["reviews"]["candidate_1"]["checks"][category]["result"] = {
                        "status": "violation", "violation": {
                        "category": "unsupported_fact" if category == "facts" else "unmet_instruction",
                        "candidate_path": "/text", "candidate_quote": "你好",
                        "source_path": source_path, "source_quote": quote}}
                    return report
                self.reply_model.review_transform = invalid_source
                self.assertEqual(self.backend.request(path + "/replies", body),
                    (500, {"error": "reply_generation_failed"}))

    def test_disabling_frozen_background_before_review_prevents_review_send(self):
        from concurrent.futures import ThreadPoolExecutor
        contact, _, management, ready, path = self.prepare_layered_reply()
        body = self.rewrite_body(contact, "你好。")
        body["content"]["user_instruction"] = "自然表达。"
        self.reply_model.plans.append({"text": "你好，想起共同学习的时光。", "basis": "按背景。"})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, result = management.request(f"/api/contacts/{contact}/layered-memory/disable",
                    {"settings_generation": ready["settings_generation"]})
                self.assertEqual(status, 200, result)
                gate.set()
                self.assertNotEqual(pending.result(timeout=10)[0], 200)
            finally:
                gate.set()
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(self.reply_model.review_calls, 0)

    def test_owner_lifecycle_is_isolated_from_contact_layered_reply(self):
        contact, _, management, _, path = self.prepare_layered_reply()
        status, _ = self.backend.request('/api/memories/manual-owner',
            {'text': '本人近期合成计划。', 'category': 'recent_state'})
        self.assertEqual(status, 200)
        owner_path = '/api/memories/owner/layered-memory'
        status, result = management.request(owner_path + '/enable',
            {'settings_generation': 0, 'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        self.assertTrue(result['layered_memory']['scenarios'])
        self.reply_model.plans.append({'text': '聊聊课程。', 'basis': '按本次草稿。'})
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '聊聊课程。'))
        self.assertEqual(status, 200, turn)
        saved = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(saved['layered_context']['scope_kind'], 'contact')
        self.assertNotIn('本人近期合成计划', str(saved['layered_context']))
        generation = result['layered_memory']['settings_generation']
        for action in ('disable', 'enable', 'delete'):
            command = {'settings_generation': generation}
            if action == 'enable': command['purpose_confirmed'] = True
            status, result = management.request(owner_path + '/' + action, command)
            self.assertEqual(status, 200, result)
            generation = result['layered_memory']['settings_generation']
            self.assertEqual(self._get(self.backend, self.evidence_path(contact, turn)), saved)

    def test_withdrawing_scenario_erases_dependent_layered_reply_copies(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        self.reply_model.plans.append({'text': '聊聊课程。', 'basis': '按本次草稿。'})
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '聊聊课程。'))
        self.assertEqual(status, 200, turn)
        status, result = management.request(f'/api/contacts/{contact}/layered-memory/withdraw-scenario',
            {'settings_generation': ready['settings_generation'],
             'organization_generation': ready['organization_generation'],
             'scenario_version_id': ready['scenarios'][0]['version_id']})
        self.assertEqual(status, 200, result)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, turn))[0], 200)

    def test_owner_fact_erasure_cleans_l1_reply_copy_without_erasing_contact_layers(self):
        contact, _, management, ready, path = self.prepare_layered_reply()
        status, memory = self.backend.request('/api/memories/manual-owner',
            {'text': '本人也参加合成课程。', 'category': 'common_fact'})
        self.assertEqual(status, 200, memory)
        memory_id = memory['memory']['memory_id']
        self.reply_model.plans.append({'text': '聊聊课程。', 'basis': '按本次草稿。'})
        status, turn = self.backend.request(path + '/replies', self.rewrite_body(contact, '聊聊课程。'))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertIn(memory_id, [item['evidence_id'] for item in evidence['evidence']])
        status, deleted = self.backend.request('/api/memories/owner/' + memory_id + '/delete', {})
        self.assertEqual(status, 200, deleted)
        self.assertNotEqual(self.backend.request(self.evidence_path(contact, turn))[0], 200)
        current = self._get(management, f'/api/contacts/{contact}/layered-memory')['layered_memory']
        self.assertEqual(current['profile']['version_id'], ready['profile']['version_id'])
