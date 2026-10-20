"""时间依据经正式导入、回复及冻结恢复；夹具只含合成聊天。"""

import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4
from unittest.mock import patch

import psycopg
from psycopg.types.json import Jsonb

from tests.fidelity_http_support import FidelityControlledModel
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server import test_memory_event_updates as events
from notalone.memory_extraction.dimensions import DimensionRelease


class MemoryTemporalEvidenceHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = DimensionRelease()
    extraction_model_factory = events.EventScriptedModel
    reply_model_factory = FidelityControlledModel
    import_event = events.MemoryEventUpdatesHttpTest.import_event
    delete_source = events.MemoryEventUpdatesHttpTest.delete_source

    def _backend(self, owner_id):
        from notalone.tasks.worker import PostgresMemoryExtractionRunner
        def historical_runner(*args, **kwargs):
            return PostgresMemoryExtractionRunner(*args, **kwargs, automatic=False)
        with patch('tests.integration.server.core_business_flow_support.PostgresMemoryExtractionRunner', historical_runner):
            return super()._backend(owner_id)

    def plan(self, subject="contact"):
        imported = self.import_event(
            original="合成计划：在2026-08-05T09:00:00+08:00参加读书会。",
            claim="计划参加读书会。", when="2026-08-01T10:00:00+08:00", subject=subject,
            fact_overrides={"speech_act": "plan", "category": "common_fact"},
            event_spec={"stage": "planned", "occurrence_start": "2026-08-05T09:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        contact = imported["contact_id"]
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact),
            channel="wechat", account_scope=f"synthetic-{self.owner_id}",
            conversation_locator=f"synthetic-{contact}")
        candidate = self._get(self.backend, f"/api/contacts/{contact}/memory-candidates")["candidates"][0]
        return imported, candidate

    def generate(self, contact):
        self.reply_model.plans.append({"text": "读书会后来怎么样？", "basis": "不把过去计划当作完成。"})
        return self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft",
                "draft_text": "计划参加读书会。", "include_relationship_context": True}})

    def test_owner_and_pending_events_keep_original_times_and_legacy_reply_keeps_unknown(self):
        imported, pending = self.plan("self")
        contact = imported["contact_id"]
        status, reply = self.generate(contact)
        self.assertEqual(status, 200, reply)
        pending_input = next(item for item in self.reply_model.payloads[-1]["evidence"]
                             if item["kind"] == "pending_candidate")
        self.assertEqual(pending_input["event"], pending["event"])
        status, confirmed = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{pending['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, confirmed)
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        layered_backend = LayeredProfileHttpTest.controlled(self)
        layered_path = "/api/memories/owner/layered-memory"
        state = self._get(layered_backend, layered_path)["layered_memory"]
        status, result = layered_backend.request(layered_path + "/enable", {
            "settings_generation": state["settings_generation"], "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        layered = result["layered_memory"]
        for reference in (layered["scenarios"][0]["paragraphs"][0]["references"][0],
                          layered["profile"]["entries"][0]["references"][0]):
            self.assertEqual(reference["event"], pending["event"])
        projected = self.profile_proposer.inputs[0][0][0]["paragraphs"][0]["references"][0]["timing"]
        self.assertEqual(projected["event"]["stage"], "planned")
        self.assertEqual(projected["event"]["occurrence_start"], "2026-08-05T09:00:00+08:00")
        self.assertTrue(projected["event"]["stage_verified"])
        self.assertNotIn("message_id", json.dumps(projected))
        self.assertNotIn(imported["message"]["message_id"], json.dumps(projected))
        status, reply = self.generate(contact)
        self.assertEqual(status, 200, reply)
        current = next(item for item in self.reply_model.payloads[-1]["evidence"] if item["kind"] == "owner_memory")
        self.assertEqual(current["event"], pending["event"])
        self.assertEqual(current["timing"]["source_started_at"], "2026-08-01T10:00:00+08:00")
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        frozen = self._get(self._backend(self.owner_id), path)
        self.assertEqual(next(item for item in frozen["evidence"] if item["kind"] == "owner_memory")["event"], pending["event"])
        # 模拟升级前已保存快照；读取只保留原未知，不能借最新记忆补写。
        with psycopg.connect(self.database_url) as connection:
            snapshot = connection.execute("SELECT context_snapshot FROM public.reply_request WHERE id=%s",
                                          (reply["reply_request_id"],)).fetchone()[0]
            for item in snapshot["evidence"]:
                item.pop("event", None)
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s",
                               (Jsonb(snapshot), reply["reply_request_id"]))
        legacy = self._get(self._backend(self.owner_id), path)
        self.assertIsNone(next(item for item in legacy["evidence"] if item["kind"] == "owner_memory")["event"])
        self.delete_source(contact, imported["source"]["source_id"])
        self.assertEqual(self._backend(self.owner_id).request(path)[0], 404)

    def test_event_changed_during_generation_rejects_late_candidate(self):
        imported, pending = self.plan()
        contact = imported["contact_id"]
        status, confirmed = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{pending['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, confirmed)
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor() as executor:
            future = executor.submit(self.generate, contact)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                with psycopg.connect(self.database_url) as connection:
                    connection.execute("UPDATE public.confirmed_memory SET event=NULL WHERE id=%s",
                                       (confirmed["memory"]["memory_id"],))
            finally:
                gate.set()
            status, result = future.result(timeout=10)
        self.assertNotEqual(status, 200, result)
        self.assertNotIn("candidates", result)
