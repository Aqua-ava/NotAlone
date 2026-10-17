"""旧回复 JSONB 不获得当前概览或时间证明；原快照仍可追溯与删除。"""

import unittest

import psycopg
from psycopg.types.json import Jsonb

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OverviewReplySnapshotCompatibilityHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    def test_absent_or_null_legacy_receipt_stays_unknown_after_current_overview_changes_and_restart(self):
        for mode in ("absent", "null"):
            with self.subTest(mode=mode):
                contact, _, _ = self.import_contact("合成旧快照联系人。")
                memory = self.manual_contact(contact, "对方喜欢热茶。", category="preference")
                self.activate_replies(contact)
                path = self.reply_path(contact)
                self.reply_model.plans.append({"text": "想聊聊热茶。", "basis": "按本次草稿。", "cite_kinds": ["confirmed_memory"]})
                status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "喜欢热茶，想聊热茶。"))
                self.assertEqual(status, 200, turn)
                with psycopg.connect(self.database_url) as connection:
                    snapshot = connection.execute("SELECT context_snapshot FROM public.reply_request WHERE id=%s", (turn["reply_request_id"],)).fetchone()[0]
                    snapshot.pop("retrieval")
                    snapshot.pop("navigation_dependency_ids")
                    if mode == "null":
                        snapshot["retrieval"] = None
                    for item in snapshot["evidence"]:
                        item.pop("navigation", None)
                        item.pop("timing", None)
                        item.pop("valid_at", None)
                        item.pop("invalid_at", None)
                    connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s",
                                       (Jsonb(snapshot), turn["reply_request_id"]))
                    connection.execute("UPDATE public.reply_context_evidence SET evidence_revision=NULL WHERE reply_request_id=%s",
                                       (turn["reply_request_id"],))
                status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{memory['memory_id']}/correct", {"text": "对方喜欢温茶。"})
                self.assertEqual(status, 200, corrected)
                current = self.overview(contact)
                self.assertIn(corrected["memory"]["memory_id"], str(current))
                restarted = self._backend(self.owner_id)
                saved = self._get(restarted, self.evidence_path(contact, turn))
                self.assertNotIn("retrieval", saved)
                self.assertTrue(all("navigation" not in item for item in saved["evidence"]))
                original = next(item for item in saved["evidence"] if item["evidence_id"] == memory["memory_id"])
                self.assertEqual(original["text"], "对方喜欢热茶。")
                self.assertEqual(original["timing"]["current_status"], "current_unverified")
                self.assertFalse(original["timing"]["source_time_complete"])
                self.assertNotIn("对方喜欢温茶。", str(saved))
                with psycopg.connect(self.database_url) as connection:
                    preserved = connection.execute("SELECT context_snapshot FROM public.reply_request WHERE id=%s", (turn["reply_request_id"],)).fetchone()[0]
                self.assertEqual(preserved, snapshot)
