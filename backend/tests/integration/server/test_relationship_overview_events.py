"""计划与实际进展经原 E/V/Worker 及人工操作进入概览，不扩大自动采纳。"""

import unittest
import copy
import psycopg
from psycopg.types.json import Jsonb

from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class RelationshipOverviewEventsHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    _wait_finished = CoreBusinessFlowFixture._wait_finished

    def test_used_owner_context_revision_changes_projection_without_creating_owner_overview(self):
        status, saved = self.backend.request("/api/memories/manual-owner", {
            "text": "我希望保留明确的活动安排。", "category": "preference",
        })
        self.assertEqual(status, 200, saved)
        owner_memory = saved["memory"]
        self.activate_event_worker()
        imported = self.import_event(
            original="合成计划：对方计划参加下个月的读书会。",
            claim="对方计划参加读书会。", when="2026-08-04T10:00:00+08:00",
            fact_overrides={"speech_act": "plan"},
            event_spec={"stage": "planned"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "uncertain"},
        )
        contact = imported["contact_id"]
        candidate = self._get(self.backend, f"/api/contacts/{contact}/memory-candidates")["candidates"][0]
        status, confirmed = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{candidate['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, confirmed)
        before = self.overview(contact)
        with psycopg.connect(self.database_url) as connection:
            dependencies, manifest = connection.execute("SELECT source_ids,manifest FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND contact_id=%s", (self.owner_id, contact)).fetchone()
        self.assertIn(owner_memory["memory_id"], {str(item) for item in dependencies})
        context = manifest["memories"][0]["context_records"]
        self.assertIn(owner_memory["memory_id"], {item["memory_id"] for item in context})
        self.assertNotIn(owner_memory["text"], str(manifest))
        for forbidden in ("body", "raw_payload"):
            contaminated = copy.deepcopy(manifest)
            contaminated["memories"][0]["context_records"][0][forbidden] = "合成禁止投影的本人正文。"
            with self.assertRaises(psycopg.errors.CheckViolation), psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.relationship_overview_projection SET manifest=%s "
                    "WHERE owner_id=%s AND contact_id=%s", (Jsonb(contaminated), self.owner_id, contact))
        status, corrected = self.backend.request(f"/api/memories/owner/{owner_memory['memory_id']}/correct", {
            "text": "我希望先核实活动时间，再保留活动安排。",
        })
        self.assertEqual(status, 200, corrected)
        rebuilt = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertEqual([entry["memory"]["memory_id"] for entry in rebuilt["entries"]],
                         [confirmed["memory"]["memory_id"]])
        self.assertNotEqual(rebuilt["projection_revision"], before["projection_revision"])
        self.assertEqual(rebuilt["memory_revision"], before["memory_revision"])
        self.assertNotIn(owner_memory["text"], str(rebuilt))
        self.assertNotIn(corrected["memory"]["text"], str(rebuilt))
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND scope_kind='owner'", (self.owner_id,)).fetchone()[0], 0)

    def test_plan_and_source_verified_completion_form_traceable_manual_versions_without_time_inference(self):
        self.activate_event_worker()
        first = self.import_event(
            original="合成计划：明天参加读书会。",
            claim="计划参加读书会。", when="2026-08-04T10:00:00+08:00",
            fact_overrides={"speech_act": "plan"},
            event_spec={"stage": "planned", "occurrence_start": "2026-08-05T00:00:00+08:00",
                        "occurrence_end": "2026-08-06T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        contact = first["contact_id"]
        prefix = f"/api/contacts/{contact}"
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(self.overview(contact)["entries"], [])
        status, confirmed = self.backend.request(prefix + f"/memory-candidates/{pending[0]['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, confirmed)
        old = confirmed["memory"]
        plan = self.overview(contact)["entries"][0]
        self.assertEqual(plan["memory"]["event"]["stage"], "planned")
        self.assertTrue(plan["memory"]["event"]["stage_verified"])
        self.assertEqual(plan["memory"]["adoption_method"], "manual")
        # 原文的相对日编译成适用日；当前已过该日，但计划阶段不能因此变成发生。
        self.assertEqual(plan["memory"]["timing"]["current_status"], "historical")
        self.assertEqual(plan["memory"]["event"]["stage"], "planned")

        second = self.import_event(
            original="合成经历：今天已参加读书会。",
            claim="已参加读书会。", when="2026-08-05T12:00:00+08:00", contact_id=contact,
            action="update", replaced_id=old["memory_id"],
            event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T00:00:00+08:00",
                        "occurrence_end": "2026-08-06T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        self.assertEqual([entry["memory"]["memory_id"] for entry in self.overview(contact)["entries"]], [old["memory_id"]])
        status, applied = self.backend.request(prefix + f"/memory-candidates/{pending[0]['candidate_id']}/apply-update", {
            "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
            "correction_decision_ids": [item["decision_id"] for item in pending[0].get("correction_review", [])],
        })
        self.assertEqual(status, 200, applied)
        current = applied["memory"]
        models_before = len(self.extraction_model.seen_calls)
        timeline = self.overview(contact, backend=self._backend(self.owner_id))
        self.assertEqual(len(timeline["entries"]), 2)
        historic, latest = timeline["entries"]
        self.assertEqual((historic["memory"]["event"]["stage"], latest["memory"]["event"]["stage"]),
                         ("planned", "occurred"))
        self.assertFalse(historic["is_latest"])
        self.assertEqual(historic["current_leaf"], latest["current_leaf"])
        self.assertEqual(latest["memory"]["memory_id"], current["memory_id"])
        self.assertEqual(latest["memory"]["adoption_method"], "manual")
        self.assertEqual(latest["memory"]["event"]["occurrence_start"], "2026-08-05T00:00:00+08:00")
        # 更新保留旧、新参与来源；来源范围不等于活动发生时间。
        self.assertEqual(latest["memory"]["timing"]["source_started_at"], "2026-08-04T10:00:00+08:00")
        self.assertEqual(latest["memory"]["timing"]["source_ended_at"], "2026-08-05T12:00:00+08:00")
        self.assertEqual({ref["source_id"] for ref in latest["provenance"]["references"]},
                         {first["source"]["source_id"], second["source"]["source_id"]})
        self.assertEqual(len(self.extraction_model.seen_calls), models_before)
        trace = self._get(self.backend, prefix + f"/memory-traces/records/contact_memory/{current['memory_id']}")
        self.assertEqual(trace["availability"], "recorded")
        self.assertTrue(trace["record_exists"])
        self.assertTrue(trace["batches"])
        self.delete_source(contact, first["source"]["source_id"])
        self.assertEqual(self.overview(contact, backend=self._backend(self.owner_id))["entries"], [])
        self.assertEqual(self.backend.request(prefix + f"/memories/{current['memory_id']}/versions")[0], 404)


if __name__ == "__main__":
    unittest.main()
