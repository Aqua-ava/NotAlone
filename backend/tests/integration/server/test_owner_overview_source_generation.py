"""本人概览只沿完整原来源世代；旧 NULL 不从新引用补证。"""

import unittest

import psycopg
from psycopg.types.json import Jsonb

from notalone.memory.models import FactSubject
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_owner_memory_overview as owner_support


class OwnerOverviewSourceGenerationHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    owner_overview = owner_support.OwnerMemoryOverviewHttpTest.owner_overview
    add_owner = owner_support.OwnerMemoryOverviewHttpTest.add_owner
    import_self = owner_support.OwnerMemoryOverviewHttpTest.import_self

    def test_original_ref_message_body_and_source_fingerprint_changes_withdraw_old_self_claim(self):
        for mutation in ("ref", "body", "source"):
            with self.subTest(mutation=mutation):
                contact, source, message = self.import_self("本人已毕业。")
                memory = self.confirm(contact, "本人已毕业。", message, subject=FactSubject.SELF)
                before = self.owner_overview()
                self.assertIn(memory["memory_id"], str(before))
                with psycopg.connect(self.database_url) as connection:
                    if mutation == "ref":
                        connection.execute("UPDATE public.message_source_ref SET raw_payload=raw_payload || %s "
                                           "WHERE owner_id=%s AND message_id=%s",
                                           (Jsonb({"synthetic_generation": 2}), self.owner_id, message))
                    elif mutation == "body":
                        connection.execute("UPDATE public.message SET text_content='本人尚未毕业。' "
                                           "WHERE owner_id=%s AND id=%s", (self.owner_id, message))
                    elif mutation == "source":
                        connection.execute("UPDATE public.source_document SET content_sha256=%s "
                                           "WHERE owner_id=%s AND id=%s", ("a" * 64, self.owner_id, source))
                rebuilt = self.owner_overview(backend=self._backend(self.owner_id))
                self.assertNotIn(memory["memory_id"], str(rebuilt))
                self.assertNotEqual(rebuilt["projection_revision"], before["projection_revision"])
                self.assertNotIn("本人已毕业", str(rebuilt))
                self.delete_source(contact, source)

    def test_unknown_original_window_remains_unknown_without_filling_nullable_fields(self):
        contact, _, message = self.import_self("本人偏好热茶。")
        memory = self.confirm(contact, "本人偏好热茶。", message, subject=FactSubject.SELF,
                              category="preference")
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL "
                               "WHERE owner_id=%s AND id=%s", (self.owner_id, memory["source_candidate_id"]))
        overview = self.owner_overview(backend=self._backend(self.owner_id))
        entry = overview["entries"][0]
        self.assertEqual(entry["provenance"]["kind"], "unknown")
        self.assertIsNone(entry["memory"]["event"])
        self.assertIsNone(entry["memory"]["version_evidence"])
        with psycopg.connect(self.database_url) as connection:
            raw = connection.execute("SELECT correction_evidence,dimension_evidence,event FROM public.memory_candidate "
                                     "WHERE owner_id=%s AND id=%s", (self.owner_id, memory["source_candidate_id"])).fetchone()
            manifest = connection.execute("SELECT manifest FROM public.relationship_overview_projection "
                                          "WHERE owner_id=%s AND scope_kind='owner'", (self.owner_id,)).fetchone()[0]
        self.assertEqual(raw, (None, None, None))
        self.assertFalse(manifest["memories"][0]["original_known"])
        self.assertNotIn(memory["text"], str(manifest))
        self.assertNotIn("text_content", str(manifest))

    def test_changed_candidate_subject_cannot_move_contact_facts_into_owner_overview(self):
        contact, _, message = self.import_self("本人已毕业。")
        memory = self.confirm(contact, "本人已毕业。", message, subject=FactSubject.SELF)
        self.assertEqual(len(self.owner_overview()["entries"]), 1)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET subject='contact' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, memory["source_candidate_id"]))
        self.assertEqual(self.owner_overview(backend=self._backend(self.owner_id))["entries"], [])

    def test_corrected_owner_leaf_does_not_bypass_the_original_self_subject(self):
        contact, _, message = self.import_self("本人偏好热茶。")
        original = self.confirm(contact, "本人偏好热茶。", message, subject=FactSubject.SELF,
                                category="preference")
        status, corrected = self.backend.request(f"/api/memories/owner/{original['memory_id']}/correct", {
            "text": "本人偏好温茶。",
        })
        self.assertEqual(status, 200, corrected)
        self.assertEqual(len(self.owner_overview()["entries"]), 2)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET subject='contact' WHERE owner_id=%s AND id=%s",
                               (self.owner_id, original["source_candidate_id"]))
        self.assertEqual(self.owner_overview(backend=self._backend(self.owner_id))["entries"], [])
