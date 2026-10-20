"""同一本人事实的日期精度与适用条件贯穿正式提取、整理和冻结依据。"""
import json
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

from notalone.memory_extraction.dimensions import DimensionRelease
from tests.fidelity_http_support import FidelityControlledModel
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server import test_memory_conditions as conditions
from tests.integration.server import test_memory_date_precision as precision
from tests.integration.server import test_layered_profile_management as layered


class MemoryTemporalCombinationHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = DimensionRelease()
    extraction_model_factory = precision.DirectEventModel
    reply_model_factory = FidelityControlledModel
    import_condition = conditions.MemoryConditionsHttpTest.import_condition
    delete_source = conditions.MemoryConditionsHttpTest.delete_source

    def _backend(self, owner_id):
        from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
        from notalone.tasks.worker import PostgresMemoryExtractionRunner

        def runner(*args, **kwargs):
            return PostgresMemoryExtractionRunner(*args, **kwargs, automatic=False)

        with patch("tests.integration.server.core_business_flow_support.LangChainExtractionRuntime", DirectExtractionRuntime), patch(
                "tests.integration.server.core_business_flow_support.PostgresMemoryExtractionRunner", runner):
            return super()._backend(owner_id)

    def test_same_owner_fact_keeps_year_precision_and_condition_through_reply_recovery(self):
        imported = self.import_condition(
            original="去年出差期间不便通话。", claim="去年出差期间不便通话。",
            when="2026-01-01T00:30:00+08:00", subject="self",
            fact_overrides={"category": "taboo"},
            event_spec={"version": 2, "stage": "occurred", "occurrence_precision": "year",
                        "occurrence_expression": "去年", "occurrence_start": "2025-01-01T00:00:00+08:00",
                        "occurrence_end": "2026-01-01T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"})
        contact = imported["contact_id"]
        candidate = self._get(self.backend, f"/api/contacts/{contact}/memory-candidates")["candidates"][0]
        self.assertEqual(candidate["event"]["occurrence_precision"], "year")
        self.assertTrue(candidate["event"]["occurrence_verified"])
        self.assertTrue(candidate["conditions"]["items"][0]["source_supported"])
        status, confirmed = self.backend.request(
            f"/api/contacts/{contact}/memory-candidates/{candidate['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, confirmed)
        memory = self._get(self.backend, "/api/memories/owner")["memories"][0]
        for key in ("event", "conditions"):
            self.assertEqual(memory[key], candidate[key])
        self.assertIsNone(memory["invalid_at"])

        layered_backend = layered.LayeredProfileHttpTest.controlled(self)
        layered_path = "/api/memories/owner/layered-memory"
        state = self._get(layered_backend, layered_path)["layered_memory"]
        status, result = layered_backend.request(layered_path + "/enable", {
            "settings_generation": state["settings_generation"], "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        document = result["layered_memory"]
        for ref in (document["scenarios"][0]["paragraphs"][0]["references"][0],
                    document["profile"]["entries"][0]["references"][0]):
            for key in ("event", "conditions"):
                self.assertEqual(ref[key], memory[key])
        safe = self.profile_proposer.inputs[0][0][0]["paragraphs"][0]["references"][0]["timing"]
        self.assertEqual(safe["event"]["occurrence_precision"], "year")
        self.assertEqual(safe["conditions"]["items"][0], {"text": "出差期间", "source_supported": True})
        self.assertNotIn(imported["message"]["message_id"], json.dumps(safe))
        self.assertNotIn("char_start", json.dumps(safe))

        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(contact), channel="wechat",
            account_scope=f"synthetic-{self.owner_id}", conversation_locator=f"synthetic-{contact}")
        self.reply_model.plans.append({"text": "方便时我们再联系。", "basis": "去年出差期间的情况，当前未知。"})
        status, reply = self.backend.request("/api/reply/generate", {"contact_id": contact,
            "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft",
                "draft_text": "出差期间不便通话。", "include_relationship_context": True}})
        self.assertEqual(status, 200, reply)
        model_item = next(item for item in self.reply_model.payloads[-1]["evidence"] if item["kind"] == "owner_memory")
        path = f"/api/contacts/{contact}/replies/{reply['reply_request_id']}/evidence"
        restored = self._get(self._backend(self.owner_id), path)
        saved_item = next(item for item in restored["evidence"] if item["kind"] == "owner_memory")
        for key in ("event", "conditions"):
            self.assertEqual(model_item[key], memory[key])
            self.assertEqual(saved_item[key], memory[key])
        self.delete_source(contact, imported["source"]["source_id"])
        self.assertEqual(self._backend(self.owner_id).request(path)[0], 404)
