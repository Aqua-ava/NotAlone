"""本人稳定资料概览，沿真实用户 HTTP 操作验证。"""

import unittest
from uuid import UUID

from notalone.memory.models import FactSubject

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class OwnerMemoryOverviewHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def owner_overview(self, *, backend=None):
        status, result = (backend or self.backend).request("/api/memories/owner/overview")
        self.assertEqual(status, 200, result)
        return result["overview"]

    def add_owner(self, text, *, category="common_fact"):
        status, result = self.backend.request("/api/memories/manual-owner", {
            "text": text, "category": category,
        })
        self.assertEqual(status, 200, result)
        return result["memory"]

    def import_self(self, text, *, contact_id=None):
        contact, source, _ = self.import_contact(
            "合成联系人私密资料：对方最近在安排合成行程。", contact_id=contact_id, owner_text=text,
        )
        messages = self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"]
        message = next(item for item in messages if item["text"] == text)
        self.assertEqual(message["speaker"], "user")
        return contact, source, UUID(message["message_id"])

    def test_owner_can_view_stable_manual_facts_and_explicit_preferences_without_contact_facts(self):
        fact = self.add_owner("本人已毕业。")
        preference = self.add_owner("本人偏好热茶。", category="preference")
        contact, _, _ = self.import_contact("合成联系人私密资料：对方拥有合成学位。")
        status, other = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "对方拥有合成学位。", "category": "common_fact",
        })
        self.assertEqual(status, 200, other)
        self.add_owner("本人最近正在赶工。", category="recent_state")
        overview = self.owner_overview()
        self.assertEqual(overview["version"], 1)
        self.assertEqual(overview["scope_kind"], "owner")
        self.assertIsNone(overview["contact_id"])
        self.assertGreater(overview["memory_revision"], 0)
        entries = overview["entries"]
        self.assertEqual([entry["memory"]["memory_id"] for entry in entries],
                         [fact["memory_id"], preference["memory_id"]])
        for entry in entries:
            self.assertEqual(entry["memory"]["level"], "owner")
            self.assertEqual(entry["memory"]["timing"]["current_status"], "stable")
            self.assertEqual(entry["provenance"]["kind"], "manual_entry")
            self.assertIsNone(entry["memory"]["source_candidate_id"])
            self.assertEqual(entry["current_leaf"], {
                "memory_id": entry["memory"]["memory_id"], "revision": entry["memory"]["revision"],
            })
            self.assertTrue(entry["is_latest"])
            self.assertEqual(entry["provenance"]["references"], [{
                "source_id": str(self.owner_id), "source_kind": "manual", "message_id": None,
                "source_ref_id": None, "locator": None, "contact_id": None,
            }])
        self.assertNotIn(other["memory"]["memory_id"], str(overview))
        self.assertNotIn("合成联系人", str(overview))
        self.assertEqual(self.owner_overview()["projection_revision"], overview["projection_revision"])
        self.assertEqual(self.owner_overview()["built_at"], overview["built_at"])

    def test_confirmed_self_claim_uses_its_real_source_without_contact_body_or_locator(self):
        contact, source, message = self.import_self("本人已毕业。")
        memory = self.confirm(contact, "本人已毕业。", message, subject=FactSubject.SELF)
        messages = self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"]
        contact_message = next(item for item in messages if item["speaker"] == "contact")
        contact_memory = self.confirm(contact, "对方正在安排合成行程。", UUID(contact_message["message_id"]))
        overview = self.owner_overview()
        self.assertEqual(len(overview["entries"]), 1)
        entry = overview["entries"][0]
        self.assertEqual(entry["memory"], memory)
        self.assertEqual(entry["provenance"]["kind"], "source_supported")
        self.assertEqual(entry["provenance"]["references"], [{
            "source_id": source, "source_kind": "source_document", "message_id": str(message),
            "source_ref_id": entry["provenance"]["references"][0]["source_ref_id"],
            "locator": None, "contact_id": contact,
        }])
        self.assertNotIn(contact_memory["memory_id"], str(overview))
        self.assertNotIn("对方正在", str(overview))
        status, versions = self.backend.request(f"/api/memories/owner/{memory['memory_id']}/versions")
        self.assertEqual(status, 200, versions)
        self.assertEqual(versions["versions"][0]["memory_id"], memory["memory_id"])

    def test_conflicting_saved_preferences_and_taboo_remain_separate_without_inference(self):
        first = self.add_owner("本人偏好热茶。", category="preference")
        second = self.add_owner("本人偏好冷茶。", category="preference")
        taboo = self.add_owner("本人不接受合成夜间来电。", category="taboo")
        self.assertEqual({entry["memory"]["memory_id"] for entry in self.owner_overview()["entries"]},
                         {first["memory_id"], second["memory_id"], taboo["memory_id"]})

    def test_collection_revision_counts_filtered_owner_changes_while_source_changes_only_projection(self):
        contact, source, message = self.import_self("本人偏好热茶。")
        self.confirm(contact, "本人偏好热茶。", message, subject=FactSubject.SELF,
                     category="preference")
        before = self.owner_overview()
        excluded = self.add_owner("本人最近忙于合成项目。", category="recent_state")
        filtered = self.owner_overview()
        self.assertEqual(filtered["entries"], before["entries"])
        self.assertEqual(filtered["memory_revision"], before["memory_revision"] + 1)
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET content_sha256=%s WHERE owner_id=%s AND id=%s",
                               ("a" * 64, self.owner_id, source))
        withdrawn = self.owner_overview()
        self.assertEqual(withdrawn["memory_revision"], filtered["memory_revision"])
        self.assertNotEqual(withdrawn["projection_revision"], filtered["projection_revision"])
        self.assertEqual(withdrawn["entries"], [])
        self.assertNotIn(excluded["memory_id"], str(withdrawn))
