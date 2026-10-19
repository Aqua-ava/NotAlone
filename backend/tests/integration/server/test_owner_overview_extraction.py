"""历史人工审核夹具经真实提取 Worker 保留本人概览的来源和版本。"""

from datetime import datetime
import unittest

import psycopg

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_owner_memory_overview as owner_support


class OwnerOverviewExtractionHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    owner_overview = owner_support.OwnerMemoryOverviewHttpTest.owner_overview
    add_owner = owner_support.OwnerMemoryOverviewHttpTest.add_owner
    _wait_finished = CoreBusinessFlowFixture._wait_finished

    def extract_self(self, original, *, contact_id=None, action="keep", replaced_id=None):
        self.extraction_model.proposals[original] = {"kind": "preference"}
        self.extraction_model.adjudication = {"action": action, "replaced_memory_id": replaced_id}
        contact, source, message = self.import_contact(
            "合成联系人私密回应：对方计划合成行程。", contact_id=contact_id,
            owner_text=original, when=datetime.fromisoformat(
                "2026-08-02T10:00:00+08:00" if contact_id else "2026-08-01T10:00:00+08:00"),
        )
        self._wait_finished(self.backend, contact)
        return {"contact_id": contact, "source": {"source_id": source},
                "message": {"message_id": str(message)}}

    def confirm_extracted(self, contact):
        candidates = self._get(self.backend, f"/api/contacts/{contact}/memory-candidates")["candidates"]
        self.assertEqual(len(candidates), 1, candidates)
        candidate = candidates[0]
        status, result = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{candidate['candidate_id']}/confirm", {},
        )
        self.assertEqual(status, 200, result)
        return candidate, result["memory"]

    def test_full_original_worker_window_is_checked_without_exposing_contact_context(self):
        self.activate_historical_review_worker()
        imported = self.extract_self("本人偏好热茶。")
        contact = imported["contact_id"]
        self.assertEqual(self.owner_overview()["entries"], [])
        candidate, memory = self.confirm_extracted(contact)
        before = self.owner_overview()
        self.assertEqual(before["entries"][0]["memory"]["memory_id"], memory["memory_id"])
        self.assertEqual(before["entries"][0]["memory"]["adoption_method"], "manual")
        self.assertNotIn("对方计划合成行程", str(before))
        self.assertTrue(all(ref["locator"] is None for ref in before["entries"][0]["provenance"]["references"]))
        with psycopg.connect(self.database_url) as connection:
            original = connection.execute("SELECT dimension_evidence,correction_evidence FROM public.memory_candidate "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, candidate["candidate_id"])).fetchone()
            self.assertEqual(len(original[0]["messages"]), 2)
            self.assertEqual(len(original[1]["message_ids"]), 2)
            connection.execute("UPDATE public.message SET text_content='合成联系人私密回应已修订。' "
                "WHERE owner_id=%s AND contact_id=%s AND id<>%s",
                (self.owner_id, contact, imported["message"]["message_id"]))
        rebuilt = self.owner_overview(backend=self._backend(self.owner_id))
        self.assertEqual(rebuilt["entries"], [])
        self.assertNotEqual(rebuilt["projection_revision"], before["projection_revision"])
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT dimension_evidence,correction_evidence FROM public.memory_candidate "
                "WHERE owner_id=%s AND id=%s", (self.owner_id, candidate["candidate_id"])).fetchone(), original)

    def test_explicit_self_update_preserves_original_versions_and_source_deletion_beats_recovery(self):
        self.activate_historical_review_worker()
        first = self.extract_self("本人偏好热茶。")
        contact = first["contact_id"]
        _, old = self.confirm_extracted(contact)
        independent = self.add_owner("本人偏好使用纸质书。", category="preference")
        second = self.extract_self("本人偏好温茶。", contact_id=contact, action="update", replaced_id=old["memory_id"])
        pending = self._get(self.backend, f"/api/contacts/{contact}/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1, pending)
        candidate = pending[0]
        before = self.owner_overview()
        self.assertNotIn("本人偏好温茶", str(before))
        status, applied = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{candidate['candidate_id']}/apply-update", {
                "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
                "correction_decision_ids": [item["decision_id"] for item in candidate.get("correction_review", [])],
            },
        )
        self.assertEqual(status, 200, applied)
        current = applied["memory"]
        after = self.owner_overview(backend=self._backend(self.owner_id))
        by_id = {entry["memory"]["memory_id"]: entry for entry in after["entries"]}
        self.assertEqual(set(by_id), {old["memory_id"], current["memory_id"], independent["memory_id"]})
        self.assertEqual(by_id[old["memory_id"]]["current_leaf"], by_id[current["memory_id"]]["current_leaf"])
        self.assertIsNotNone(by_id[current["memory_id"]]["memory"]["version_evidence"])
        self.assertTrue(by_id[current["memory_id"]]["memory"]["version_evidence_source_current"])
        self.assertEqual({ref["source_id"] for ref in by_id[current["memory_id"]]["provenance"]["references"]},
                         {first["source"]["source_id"], second["source"]["source_id"]})
        self.assertNotIn("私密回应", str(after))
        self.delete_source(contact, first["source"]["source_id"])
        recovered = self.owner_overview(backend=self._backend(self.owner_id))
        self.assertEqual([entry["memory"]["memory_id"] for entry in recovered["entries"]], [independent["memory_id"]])
        self.assertEqual(self.backend.request(f"/api/memories/owner/{current['memory_id']}/versions")[0], 404)
        self.assertEqual(self.backend.request(f"/api/memories/owner/{current['memory_id']}/revert-auto-update", {
            "expected_revision": current["revision"],
        })[0], 404)
