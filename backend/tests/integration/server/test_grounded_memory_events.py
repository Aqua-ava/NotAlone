"""实际生产 builder 经公开导入、独立核验、保存、历史及删除的合成闭环。"""

import json
import psycopg
from datetime import datetime
from pathlib import Path
import unittest
from uuid import uuid4

from notalone.memory_extraction.dimensions import DimensionRelease
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.grounded_event_support import GroundedEventModel
from tests.integration.server import test_memory_event_updates as event_support


class GroundedMemoryEventsHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    extraction_model_factory = GroundedEventModel
    dimension_release = None
    delete_source = event_support.MemoryEventUpdatesHttpTest.delete_source

    def import_grounded(self, raw, *, kind="plan", stage="planned", period=True):
        self.extraction_model.proposals[raw] = {"kind": kind, "stage": stage, "period": period}
        path = Path(self.temporary.name) / f"grounded-event-{uuid4().hex}.jsonl"
        timestamp = datetime.fromisoformat("2026-08-01T10:00:00+08:00")
        locator = f"wxid_grounded_{uuid4().hex}"
        records = [{
            "id": {"local_id": number, "server_id_str": uuid4().hex, "talker": locator},
            "create_time": int(timestamp.timestamp()) + number,
            "is_from_me": number == 2, "kind": "text",
            "sender": "合成用户" if number == 2 else "合成事件联系人",
            "sender_wxid": f"wxid_synthetic_{self.backend.token}" if number == 2 else locator,
            "text": text, "time": timestamp.replace(second=number).strftime("%Y-%m-%d %H:%M:%S"),
            "time_iso": timestamp.replace(second=number).isoformat(),
        } for number, text in ((1, raw), (2, "收到。"))]
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records), encoding="utf-8")
        status, imported = self.backend.request("/api/imports/commit", {"path": str(path), "new_contact_name": "合成事件联系人"})
        self.assertEqual(status, 200, imported)
        self._wait_finished(self.backend, imported["contact_id"])
        prefix = f"/api/contacts/{imported['contact_id']}"
        return imported, prefix

    def test_default_builder_verifies_planned_event_without_turning_elapsed_time_into_occurrence(self):
        imported, prefix = self.import_grounded("🙂明天去看展。")
        self.assertEqual(self._get(self.backend, prefix + "/memory-candidates")["candidates"], [])
        candidate = self._get(self.backend, prefix + "/memories")["memories"][0]
        event = candidate["event"]
        self.assertEqual((event["stage"], event["stage_verified"], event["occurrence_verified"]), ("planned", True, True))
        self.assertEqual(event["occurrence_start"], "2026-08-02T00:00:00+08:00")
        self.assertEqual(candidate["timing"]["source_started_at"], "2026-08-01T10:00:01+08:00")
        self.assertEqual(candidate["text"], "联系人原话：“🙂明天去看展。”")
        self.assertEqual(event["stage_evidence"][0]["char_end"], 7)
        self.assertEqual(len(self.extraction_model.seen_calls), 2)
        restarted = self._backend(self.owner_id)
        saved = self._get(restarted, prefix + "/memories")["memories"][0]
        self.assertEqual(saved["event"], event)
        self.assertEqual(saved["adoption_method"], "auto")
        versions = self._get(restarted, prefix + f"/memories/{saved['memory_id']}/versions")["versions"]
        self.assertEqual(versions[0]["event"], event)
        source = self._get(self.backend, prefix + "/sources")["sources"][0]
        self.delete_source(imported["contact_id"], source["source_id"])
        self.assertEqual(self._get(restarted, prefix + "/memories")["memories"], [])

    def test_general_text_support_does_not_certify_event_even_with_synthetic_quality_release(self):
        self.dimension_release = DimensionRelease(gate_enabled=False)
        self.extraction_model.verify_events = False
        self.backend = self._backend(self.owner_id)
        imported, prefix = self.import_grounded("我已取件。", kind="event", stage="occurred", period=False)
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], [])
        self.assertEqual(self._get(self.backend, prefix + "/memory-candidates")["candidates"], [])
        with psycopg.connect(self.database_url) as connection:
            event, status, reason = connection.execute(
                "SELECT event,status,failure_reason FROM public.memory_candidate WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, imported['contact_id'])).fetchone()
        self.assertEqual((event["stage_verified"], event["occurrence_verified"]), (False, False))
        self.assertEqual(status, 'rejected')
        self.assertIsNotNone(reason)

    def test_independent_stage_and_time_verification_allows_synthetic_released_save(self):
        self.dimension_release = DimensionRelease(gate_enabled=False)
        self.backend = self._backend(self.owner_id)
        _, prefix = self.import_grounded("今天已取件。", kind="event", stage="occurred", period=True)
        saved = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.assertEqual(saved["event"]["stage"], "occurred")
        self.assertTrue(saved["event"]["stage_verified"])
        self.assertEqual(saved["event"]["occurrence_start"], "2026-08-01T00:00:00+08:00")
        self.assertTrue(saved["event"]["occurrence_verified"])
        self.assertEqual(saved["adoption_method"], "auto")
