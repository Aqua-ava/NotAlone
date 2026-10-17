"""概览导航沿真实公开回复、实际 PG 快照与保存后依据读取验证。"""

import unittest

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OverviewReplyRetrievalHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    def test_confirmed_relationship_and_owner_facts_have_actual_saved_navigation_and_replay(self):
        contact, _, message = self.import_contact("合成关系经历：对方喜欢热茶。")
        relationship = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        owner = self.manual_owner("本人喜欢热茶。", category="preference")
        contact_overview = self.overview(contact)
        owner_overview = self._get(self.backend, "/api/memories/owner/overview")["overview"]
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "喜欢热茶，想聊热茶。")
        self.reply_model.plans.append({"text": "一起聊聊热茶吧。", "basis": "根据双方已保存的偏好。",
                                      "cite_kinds": ["confirmed_memory", "owner_memory"]})
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        material = {item["evidence_id"]: item for item in evidence["evidence"]}
        for memory, scope, revision in ((relationship, "contact", contact_overview["projection_revision"]),
                                       (owner, "owner", owner_overview["projection_revision"])):
            item = material[memory["memory_id"]]
            self.assertEqual(item["text"], memory["text"])
            self.assertTrue(item["cited"])
            self.assertEqual(item["navigation"], {"scope_kind": scope, "projection_revision": revision,
                "memory_id": memory["memory_id"], "memory_revision": memory["revision"],
                "provenance_kind": "source_supported" if scope == "contact" else "manual_entry"})
        receipt = evidence["retrieval"]
        self.assertEqual(receipt["retriever_version"], "lexical-v1")
        self.assertEqual(receipt["budgets"]["contact_memory"]["used_count"], 1)
        self.assertEqual(receipt["budgets"]["contact_memory"]["used_chars"], 7)
        self.assertEqual(receipt["budgets"]["owner_memory"]["used_count"], 1)
        self.assertEqual(receipt["budgets"]["owner_memory"]["used_chars"], 7)
        self.assertEqual(self.backend.request(path + "/replies", body), (200, turn))
        self.assertEqual(len(self.reply_model.payloads), 1)
        restarted = self._backend(self.owner_id)
        self.assertEqual(self._get(restarted, self.evidence_path(contact, turn)), evidence)
        self.assertEqual(restarted.request(path + "/replies", body), (200, turn))
        self.assertEqual(len(self.reply_model.payloads), 1)
