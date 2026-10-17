"""实际回复输入的独立预算与未知、空、不可用状态。"""

import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.memory.models import FactSubject, MemoryCandidate, MemoryCategory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.scopes import ContactScope
from tests.integration.server import test_relationship_overview_lifecycle as lifecycle_faults
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OverviewReplyBudgetsHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    _install_fault = lifecycle_faults.RelationshipOverviewLifecycleHttpTest._install_fault
    _remove_fault = lifecycle_faults.RelationshipOverviewLifecycleHttpTest._remove_fault

    def test_unavailable_projection_allows_generic_reply_and_does_not_backfill_saved_evidence_after_recovery(self):
        contact, _, _ = self.import_contact("合成原话未用于此回复。")
        self.manual_contact(contact, "对方喜欢热茶。", category="preference")
        self.manual_owner("本人喜欢热茶。", category="preference")
        self._install_fault("relationship_overview_projection", "INSERT OR UPDATE")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "想聊聊热茶。", "basis": "仅保留本次草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "喜欢热茶，想聊热茶。"))
        self.assertEqual(status, 200, turn)
        evidence_path = self.evidence_path(contact, turn)
        saved = self._get(self.backend, evidence_path)
        self.assertEqual(saved["retrieval"]["status"], "unavailable")
        self.assertEqual(saved["retrieval"]["overview_revisions"], {"contact": None, "owner": None})
        self.assertEqual([item["kind"] for item in saved["evidence"]], ["user_draft"])
        self.assertEqual([item["status"] for item in saved["retrieval"]["queries"]], ["failed", "failed", "empty"])
        self._remove_fault("relationship_overview_projection")
        self.assertEqual(len(self.overview(contact)["entries"]), 1)
        restarted = self._backend(self.owner_id)
        self.assertEqual(self._get(restarted, evidence_path), saved)
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_null_original_proof_stays_unknown_and_is_not_rebuilt_from_current_references(self):
        contact, _, message = self.import_contact("合成原话：对方喜欢热茶。", owner_text="本人喜欢热茶。")
        relationship = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        messages = self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"]
        own_message = next(item for item in messages if item["speaker"] == "user")
        own = self.confirm(contact, "本人喜欢热茶。", UUID(own_message["message_id"]),
                           category="preference", subject=FactSubject.SELF)
        candidate_ids = [self.overview(contact)["entries"][0]["memory"]["source_candidate_id"],
                         self._get(self.backend, "/api/memories/owner/overview")["overview"]["entries"][0]["memory"]["source_candidate_id"]]
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                               (self.owner_id, candidate_ids))
        self.assertEqual(self.overview(contact)["entries"][0]["provenance"]["kind"], "unknown")
        self.assertEqual(self._get(self.backend, "/api/memories/owner/overview")["overview"]["entries"][0]["provenance"]["kind"], "unknown")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "想聊聊热茶。", "basis": "保留本次草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "喜欢热茶，想聊热茶。"))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(evidence["retrieval"]["status"], "empty")
        self.assertEqual([item["kind"] for item in evidence["evidence"]], ["user_draft"])
        self.assertNotIn(relationship["memory_id"], str(self.reply_model.payloads))
        self.assertNotIn(own["memory_id"], str(self.reply_model.payloads))
        with psycopg.connect(self.database_url) as connection:
            remaining = connection.execute("SELECT correction_evidence FROM public.memory_candidate WHERE owner_id=%s AND id=ANY(%s::uuid[])",
                (self.owner_id, candidate_ids)).fetchall()
        self.assertEqual(remaining, [(None,), (None,)])

    def test_original_window_and_empty_runtime_queries_share_three_calls_and_keep_actual_raw_evidence(self):
        contact, _, message = self.import_contact("合成原话：双方去年喝过热茶。")
        memory = self.confirm(contact, "双方去年喝过热茶。", message)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.extend([
            {"history": {"name": "conversation_search", "args": {"query": f"无匹配合成词{number}", "top_k": 8}}}
            for number in range(3)
        ] + [{"text": "想聊聊过去喝茶的经历。", "basis": "只保留已有原话与草稿。"}])
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "双方去年喝过热茶，想聊热茶。"))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        receipt = evidence["retrieval"]
        queries = [item for item in receipt["queries"] if item["purpose"] == "source_window"]
        self.assertEqual([item["status"] for item in queries], ["succeeded", "empty", "empty", "budget_exceeded"])
        self.assertTrue(all(item["evidence_ids"] == [] for item in queries[1:]))
        raw = [item for item in evidence["evidence"] if item["kind"] == "message"]
        self.assertEqual({item["text"] for item in raw}, {"合成原话：双方去年喝过热茶。", "好的，合成资料已核对。"})
        self.assertTrue(all("navigation" not in item for item in raw))
        self.assertEqual(receipt["status"], "budget_exhausted")
        self.assertEqual(receipt["budgets"]["source_messages"]["used_calls"], 3)
        self.assertEqual(receipt["budgets"]["source_messages"]["used_count"], 2)
        # 两条合成正文分别 14/11 字符，沿既有 ceil(chars/4) 口径为 4+3。
        self.assertEqual(receipt["budgets"]["source_messages"]["used_tokens"], 7)
        self.assertTrue(receipt["budgets"]["source_messages"]["exhausted"])
        self.assertIn(memory["memory_id"], str(evidence))
        self.assertEqual(len(self.reply_model.payloads), 4)

    def test_empty_recall_does_not_claim_nonexistence_and_rewrite_without_background_has_no_receipt(self):
        contact, _, _ = self.import_contact("合成聊天未采纳为资料。")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "谢谢你的分享。", "basis": "保留用户草稿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "谢谢你的分享。"))
        self.assertEqual(status, 200, turn)
        first = self._get(self.backend, self.evidence_path(contact, turn))
        self.assertEqual(first["retrieval"]["status"], "empty")
        self.assertEqual([item["status"] for item in first["retrieval"]["queries"]], ["empty", "empty", "empty"])
        self.assertEqual([item["kind"] for item in first["evidence"]], ["user_draft"])
        self.manual_contact(contact, "对方喜欢热茶。", category="preference")
        self.reply_model.plans.append({"text": "想聊热茶。", "basis": "仅保留用户草稿。"})
        status, second_turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "想聊热茶。", include_context=False))
        self.assertEqual(status, 200, second_turn)
        second = self._get(self.backend, self.evidence_path(contact, second_turn))
        self.assertNotIn("retrieval", second)
        self.assertTrue(all("navigation" not in item for item in second["evidence"]))
        self.assertEqual([item["kind"] for item in second["evidence"]], ["user_draft"])
        self.assertEqual(self.reply_model.payloads[-1]["evidence"][0]["text"], "想聊热茶。")

    def test_contact_owner_and_unconfirmed_references_have_independent_final_input_budgets(self):
        contact, _, message = self.import_contact("合成原话：想聊热茶偏好。")
        relationships = [self.manual_contact(contact, f"对方喜欢热茶偏好第{number}种。", category="preference")
                         for number in range(6)]
        owners = [self.manual_owner(f"本人喜欢热茶偏好第{number}种。", category="preference") for number in range(4)]
        pending = [PostgresMemoryStore(self.database_url).create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=ContactScope(self.owner_id, UUID(contact)),
            text=f"对方可能喜欢热茶偏好第{number}种。", category=MemoryCategory.PREFERENCE, source_ids=(message,),
        )) for number in range(4)]
        other, _, other_message = self.import_contact("另一联系人原话：喜欢热茶偏好。")
        foreign = self.confirm(other, "另一联系人喜欢热茶偏好。", other_message, category="preference")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "聊聊热茶偏好吧。", "basis": "保留本次草稿意愿。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "喜欢热茶偏好，想聊热茶偏好。"))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        receipt = evidence["retrieval"]
        self.assertEqual(receipt["status"], "budget_exhausted")
        for kind, budget_key, count, legal_ids in (
            ("confirmed_memory", "contact_memory", 5, {item["memory_id"] for item in relationships}),
            ("owner_memory", "owner_memory", 3, {item["memory_id"] for item in owners}),
            ("pending_candidate", "pending_candidate", 3, {str(item.candidate_id) for item in pending}),
        ):
            selected = [item for item in evidence["evidence"] if item["kind"] == kind]
            self.assertEqual(len(selected), count)
            self.assertTrue({item["evidence_id"] for item in selected} <= legal_ids)
            budget = receipt["budgets"][budget_key]
            self.assertEqual(budget["used_count"], count)
            self.assertEqual(budget["used_chars"], sum(len(item["text"]) for item in selected))
            self.assertTrue(budget["exhausted"])
        for item in evidence["evidence"]:
            if item["kind"] == "pending_candidate":
                self.assertEqual(item["snapshot_status"], "pending")
                self.assertTrue(item["selection_reason"].startswith("未确认候选、仅供参考、不得当作事实。"))
                self.assertNotIn("navigation", item)
        self.assertNotIn(foreign["memory_id"], str(evidence))
        self.assertNotIn("另一联系人", str(self.reply_model.payloads))
