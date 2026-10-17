"""一位联系人的经历与变化概览，从公开 HTTP 观察实际资料与来源。"""

import unittest
import psycopg
from psycopg.types.json import Jsonb

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class ContactRelationshipOverviewHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_adopted_experience_and_manual_entry_are_traceable_with_unknown_current_state(self):
        contact, source, message = self.import_contact("合成经历：我去年毕业，现在在台北工作。")
        confirmed = self.confirm(contact, "对方去年毕业，现在在台北工作。", message)
        status, manual = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方去年初次相识。", "category": "common_fact",
        })
        self.assertEqual(status, 200, manual)

        overview = self.overview(contact)
        self.assertEqual(overview["version"], 1)
        self.assertEqual(overview["scope_kind"], "contact")
        self.assertEqual(overview["contact_id"], contact)
        self.assertGreater(overview["memory_revision"], 0)
        by_id = {item["memory"]["memory_id"]: item for item in overview["entries"]}
        self.assertEqual(set(by_id), {confirmed["memory_id"], manual["memory"]["memory_id"]})
        experience = by_id[confirmed["memory_id"]]
        self.assertEqual(experience["memory"]["text"], confirmed["text"])
        self.assertEqual(experience["memory"]["revision"], confirmed["revision"])
        self.assertEqual(experience["memory"]["adoption_method"], "manual")
        self.assertEqual(experience["memory"]["timing"]["current_status"], "current_unverified")
        self.assertEqual(experience["provenance"]["kind"], "source_supported")
        self.assertEqual(experience["provenance"]["references"][0]["source_id"], source)
        self.assertEqual(experience["provenance"]["references"][0]["message_id"], str(message))
        self.assertTrue(experience["is_latest"])
        self.assertEqual(experience["current_leaf"], {"memory_id": confirmed["memory_id"],
                                                       "revision": confirmed["revision"]})
        self.assertEqual(by_id[manual["memory"]["memory_id"]]["provenance"]["kind"], "manual_entry")
        self.assertEqual(by_id[manual["memory"]["memory_id"]]["memory"]["timing"]["current_status"], "stable")
        self.assertEqual(self.overview(contact)["projection_revision"], overview["projection_revision"])

    def test_correcting_an_underlying_claim_rebuilds_history_and_its_real_current_leaf(self):
        contact, source, message = self.import_contact("合成经历：对方去年在合成城市读书。")
        original = self.confirm(contact, "对方去年在合成城市读书。", message)
        before = self.overview(contact)
        correction_path = f"/api/contacts/{contact}/memories/{original['memory_id']}/correct"
        status, changed = self.backend.request(correction_path, {"text": "对方去年参加短期课程，并非在当地读书。"})
        self.assertEqual(status, 200, changed)
        # HTTP 是行为入口；补充核验旧投影已经物理清除，不能仅靠读取时隐藏。
        with psycopg.connect(self.database_url) as connection:
            remaining = connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0]
        self.assertEqual(remaining, 0)
        current = changed["memory"]
        rebuilt = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertNotEqual(rebuilt["projection_revision"], before["projection_revision"])
        self.assertGreater(rebuilt["memory_revision"], before["memory_revision"])
        self.assertEqual([entry["memory"]["memory_id"] for entry in rebuilt["entries"]],
                         [original["memory_id"], current["memory_id"]])
        old, new = rebuilt["entries"]
        self.assertEqual(old["memory"]["status"], "invalidated")
        self.assertEqual(new["memory"]["supersedes_memory_id"], original["memory_id"])
        self.assertFalse(old["is_latest"])
        self.assertTrue(new["is_latest"])
        self.assertEqual(old["current_leaf"], new["current_leaf"])
        self.assertEqual(new["current_leaf"], {"memory_id": current["memory_id"], "revision": current["revision"]})
        self.assertEqual(new["provenance"]["references"][0]["source_id"], source)
        versions = self.backend.request(f"/api/contacts/{contact}/memories/{new['current_leaf']['memory_id']}/versions")
        self.assertEqual(versions[0], 200, versions[1])
        self.assertEqual([row["memory_id"] for row in versions[1]["versions"]],
                         [current["memory_id"], original["memory_id"]])
        status, replay = self.backend.request(correction_path, {"text": current["text"]})
        self.assertEqual(status, 200, replay)
        self.assertEqual(replay["memory"]["memory_id"], current["memory_id"])
        self.assertEqual(self.overview(contact)["projection_revision"], rebuilt["projection_revision"])

    def test_changed_source_generation_cannot_rebuild_a_claim_with_new_reference_proof(self):
        contact, source, message = self.import_contact("合成经历：双方去年初次见面。")
        memory = self.confirm(contact, "双方去年初次见面。", message)
        before = self.overview(contact)
        self.assertEqual(len(before["entries"]), 1)
        # 只改变已导入的真实引用世代，不造来源、不改人工决定或旧证明。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message_source_ref SET raw_payload=raw_payload || %s "
                "WHERE owner_id=%s AND contact_id=%s AND message_id=%s",
                (Jsonb({"synthetic_generation": 2}), self.owner_id, contact, message))
        rebuilt = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertEqual(rebuilt["entries"], [])
        self.assertNotEqual(rebuilt["projection_revision"], before["projection_revision"])
        status, sources = self.backend.request(f"/api/contacts/{contact}/sources")
        self.assertEqual(status, 200, sources)
        self.assertEqual(next(item for item in sources["sources"] if item["source_id"] == source)["status"], "active")
        self.assertEqual(self.overview(contact)["entries"], [])
        with psycopg.connect(self.database_url) as connection:
            saved = connection.execute("SELECT manifest FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0]
        self.assertNotIn(memory["memory_id"], str(saved))

    def test_source_deletion_before_or_after_projection_preserves_independent_manual_and_other_contact(self):
        for build_first in (False, True):
            with self.subTest(build_first=build_first):
                contact, source, message = self.import_contact("合成待删经历：双方一起参加过合成课程。")
                memory = self.confirm(contact, "双方一起参加过合成课程。", message)
                status, independent = self.backend.request("/api/memories/manual-contact", {
                    "contact_id": contact, "text": "双方已明确交换联系方式。", "category": "common_fact",
                })
                self.assertEqual(status, 200, independent)
                other, _, other_message = self.import_contact("另一联系人的合成经历：已取得合成学位。")
                other_memory = self.confirm(other, "对方已取得合成学位。", other_message)
                other_before = self.overview(other)
                if build_first:
                    before = self.overview(contact)
                    self.assertEqual(len(before["entries"]), 2)
                self.delete_source(contact, source)
                # 真正来源清除后，权威投影没有被删资料身份或正文副本。
                with psycopg.connect(self.database_url) as connection:
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                        "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0], 0)
                rebuilt = self.overview(contact, backend=self._backend(self.owner_id))
                self.assertEqual([item["memory"]["memory_id"] for item in rebuilt["entries"]],
                                 [independent["memory"]["memory_id"]])
                self.assertNotIn(memory["memory_id"], str(rebuilt))
                self.assertNotIn("合成课程", str(rebuilt))
                self.delete_source(contact, source)
                self.assertEqual(self.overview(contact)["projection_revision"], rebuilt["projection_revision"])
                other_after = self.overview(other)
                self.assertEqual(other_after["projection_revision"], other_before["projection_revision"])
                self.assertEqual([item["memory"]["memory_id"] for item in other_after["entries"]], [other_memory["memory_id"]])
                with psycopg.connect(self.database_url) as connection:
                    manifests = connection.execute("SELECT manifest,source_ids,memory_ids FROM public.relationship_overview_projection "
                        "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchall()
                self.assertNotIn(source, str(manifests))
                self.assertNotIn(memory["memory_id"], str(manifests))

    def test_original_window_and_locator_or_content_generation_changes_cannot_rebind_old_proof(self):
        changes = (
            "UPDATE public.message SET text_content=text_content || '合成变更' WHERE owner_id=%s AND id=%s",
            "UPDATE public.message SET occurred_at=occurred_at + interval '1 second' WHERE owner_id=%s AND id=%s",
            "UPDATE public.message_source_ref SET source_locator=source_locator || ':changed' WHERE owner_id=%s AND message_id=%s",
            "UPDATE public.source_document SET content_sha256=repeat('a',64) WHERE owner_id=%s AND id=%s",
        )
        for statement in changes:
            with self.subTest(change=statement.split(" SET ")[1].split("=")[0]):
                contact, source, message = self.import_contact("合成原始窗口：双方曾共同参加课程。")
                memory = self.confirm(contact, "双方曾共同参加课程。", message)
                self.overview(contact)
                with psycopg.connect(self.database_url) as connection:
                    connection.execute(statement, (self.owner_id, source if "source_document SET" in statement else message))
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                        "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()[0], 0)
                rebuilt = self.overview(contact, backend=self._backend(self.owner_id))
                self.assertEqual(rebuilt["entries"], [])
                self.assertNotIn(memory["memory_id"], str(rebuilt))


if __name__ == "__main__":
    unittest.main()
