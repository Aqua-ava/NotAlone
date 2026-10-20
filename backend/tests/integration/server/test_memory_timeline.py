"""正式导入与读取边界验证有据时间线，不以模型脚本证明现实真伪。"""
import json
import unittest
from tests.integration.server import test_memory_event_updates as event_support


class TimelineModel(event_support.EventScriptedModel):
    relation_kind: str | None = None
    relation_claim_changed: bool = False
    relation_condition_changed: bool = False

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        names = [item["function"]["name"] for item in kwargs.get("tools", [])]
        content = str(messages[-1].content)
        index = len(self.seen_calls)
        if names == ["BatchMemoryAdjudicationOutput"] and self.relation_kind:
            rows = json.loads(content)
            call = self.responses[index].tool_calls[0]
            decisions = []
            for row in rows:
                original = call["args"]
                evidence = [{"message_id": source["message_id"], "quote": source["text"]}
                            for value in [row["candidate"], *row["similar"]] for source in value["sources"]]
                decisions.append({**original, "candidate_index": row["candidate_index"],
                    "relation": {"kind": self.relation_kind, "explanation": {"historical_supplement": "后来的表述补充了更早的居住经历。", "unresolved_conflict": "两条来源说法不同，尚无充分依据判断变化或纠错。", "state_change": "来源说明同一事项的状态发生变化。", "error_correction": "来源明确纠正此前的表述。", "supplement": "来源补充同一事项的其他细节。"}[self.relation_kind],
                                 "related_memory_ids": [item["memory_id"] for item in row["similar"]],
                                 "evidence": evidence, "claim_changed": self.relation_claim_changed, "condition_changed": self.relation_condition_changed}})
            self.responses[index] = event_support.tool_response(names[0], {"decisions": decisions})
        if names == ["MemoryRelationVerificationOutput"]:
            entries = json.loads(content)
            self.responses.insert(index, event_support.tool_response(names[0], {"results": [
                {"candidate_index": row["candidate_index"], "verdict": "supported",
                 "same_subject_and_matter": True, "claim_changed": row["relation"]["claim_changed"],
                 "condition_changed": row["relation"]["condition_changed"], "evidence": row["relation"]["evidence"]}
                for row in entries]}))
        return super()._generate(messages, stop, run_manager, **kwargs)


class MemoryTimelineHttpTest(event_support.CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = event_support.DimensionRelease(gate_enabled=False)
    extraction_model_factory = TimelineModel
    import_event = event_support.MemoryEventUpdatesHttpTest.import_event
    delete_source = event_support.MemoryEventUpdatesHttpTest.delete_source

    def test_adjudication_receives_each_versions_bounded_original_evidence(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。",
                                  when="2030-04-01T10:00:00+08:00")
        self.import_event(original="我去年住在甲地。", claim="联系人去年住在甲地。",
                          when="2030-05-01T10:00:00+08:00", contact_id=first["contact_id"])
        payloads = []
        for call in self.extraction_model.seen_calls:
            try:
                payload = json.loads(str(call[-1].content))
            except (ValueError, TypeError):
                continue
            if isinstance(payload, list) and payload and "similar" in payload[0]:
                payloads.append(payload)
        self.assertTrue(payloads)
        entry = payloads[-1][0]
        self.assertIn("candidate", entry)
        self.assertEqual(entry["candidate"]["sources"][0]["text"], "我去年住在甲地。")
        previous = entry["similar"][0]
        self.assertEqual(previous["revision"], 1)
        self.assertEqual(previous["sources"][0]["text"], "我目前住在乙地。")
        self.assertEqual(previous["sources"][0]["occurred_at"], "2030-04-01T10:00:00+08:00")
        self.assertIn("event", previous)
        self.assertIn("conditions", previous)
        self.assertNotIn("raw_payload", json.dumps(entry))
        self.assertNotIn("owner_id", json.dumps(entry))

    def test_later_recollection_without_relation_proof_does_not_replace_current_state(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。",
                                  when="2030-04-01T10:00:00+08:00")
        prefix = f"/api/contacts/{first['contact_id']}"
        previous = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.import_event(original="我去年住在甲地。", claim="联系人去年住在甲地。",
                          when="2030-05-01T10:00:00+08:00", contact_id=first["contact_id"],
                          action="update", replaced_id=previous["memory_id"])
        current = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual([row["text"] for row in current if row["status"] == "active"], ["联系人目前住在乙地。"])
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual([row["text"] for row in pending], ["联系人去年住在甲地。"])

    def test_historical_supplement_is_visible_with_its_actual_sources(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。",
                                  when="2030-04-01T10:00:00+08:00")
        self.extraction_model.relation_kind = "historical_supplement"
        second = self.import_event(original="我去年住在甲地。", claim="联系人去年住在甲地。",
                                  when="2030-05-01T10:00:00+08:00", contact_id=first["contact_id"])
        rows = self._get(self.backend, f"/api/contacts/{first['contact_id']}/memories")["memories"]
        history = next(row for row in rows if row["text"] == "联系人去年住在甲地。")
        self.assertEqual(history["evolution"]["kind"], "historical_supplement")
        self.assertTrue(history["evolution"]["source_supported"])
        self.assertIn(second["message"]["message_id"], history["evolution"]["evidence_message_ids"])
        self.assertFalse(history["evolution"]["claim_changed"])

    def test_independently_supported_wrong_update_cannot_replace_newer_event_with_earlier_recollection(self):
        verification = {"stage_verdict": "supported", "occurrence_verdict": "supported"}
        first = self.import_event(original="我2030年住在乙地。", claim="联系人2030年住在乙地。",
            when="2030-04-01T10:00:00+08:00", event_spec={"version": 2, "stage": "occurred",
                "occurrence_precision": "year", "occurrence_expression": "2030年",
                "occurrence_start": "2030-01-01T00:00:00+08:00", "occurrence_end": "2031-01-01T00:00:00+08:00"},
            event_verification=verification)
        prefix = f"/api/contacts/{first['contact_id']}"
        previous = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        self.import_event(original="我去年住在甲地。", claim="联系人2029年住在甲地。",
            when="2030-05-01T10:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=previous["memory_id"],
            event_spec={"version": 2, "stage": "occurred", "occurrence_precision": "year", "occurrence_expression": "去年",
                "occurrence_start": "2029-01-01T00:00:00+08:00", "occurrence_end": "2030-01-01T00:00:00+08:00"},
            event_verification=verification)
        rows = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual([(row["text"], row["status"]) for row in rows], [("联系人2030年住在乙地。", "active")])
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(pending[0]["text"], "联系人2029年住在甲地。")

    def test_conflict_is_projected_on_current_fact_and_removed_with_counter_source(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。",
                                  when="2030-04-01T10:00:00+08:00")
        self.extraction_model.relation_kind = "unresolved_conflict"
        second = self.import_event(original="我目前住在甲地。", claim="联系人目前住在甲地。",
                                  when="2030-04-01T11:00:00+08:00", contact_id=first["contact_id"])
        prefix = f"/api/contacts/{first['contact_id']}"
        rows = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["evolution"]["kind"], "unresolved_conflict")
        self.assertIn(second["message"]["message_id"], rows[0]["evolution"]["evidence_message_ids"])
        self.delete_source(first["contact_id"], second["source"]["source_id"])
        rows = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual(rows[0]["text"], "联系人目前住在乙地。")
        self.assertIsNone(rows[0]["evolution"])

    def test_earlier_new_import_is_processed_once_and_cannot_replace_later_statement(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。",
                                  when="2030-04-01T10:00:00+08:00")
        prefix = f"/api/contacts/{first['contact_id']}"
        previous = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        second = self.import_event(original="我目前住在甲地。", claim="联系人目前住在甲地。",
            when="2029-04-01T10:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=previous["memory_id"])
        rows = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual([(row["text"], row["status"]) for row in rows], [("联系人目前住在乙地。", "active")])
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(pending[0]["text"], "联系人目前住在甲地。")
        self.assertFalse(pending[0]["evolution"]["source_supported"])
        calls = len(self.extraction_model.seen_calls)
        from pathlib import Path
        status, replay = self.backend.request("/api/imports/commit", {
            "path": str(Path(self.temporary.name) / second["source"]["file_name"]), "contact_id": first["contact_id"]})
        self.assertEqual(status, 200, replay)
        from tests.integration.server.background_task_wait import wait_for_task
        state = wait_for_task(self.backend, {**replay, "contact_id": first["contact_id"]}, "succeeded")
        self.assertEqual(state["status"], "succeeded")
        self.assertEqual(len(self.extraction_model.seen_calls), calls)
        self.assertEqual(len(self._get(self.backend, prefix + "/memory-candidates")["candidates"]), 1)

    def test_condition_change_does_not_certify_revocation_of_original_claim(self):
        from tests.integration.server.test_memory_conditions import MemoryConditionsHttpTest
        first = MemoryConditionsHttpTest.import_condition(self,
            original="出差期间不便通话。", claim="出差期间不便通话。", when="2030-04-01T10:00:00+08:00")
        prefix = f"/api/contacts/{first['contact_id']}"
        old = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_condition_changed = True
        self.import_event(original="出差结束。", claim="出差期间不便通话的限制已经解除。", when="2030-04-02T10:00:00+08:00",
            contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"])
        rows = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual([(row["memory_id"], row["status"]) for row in rows], [(old["memory_id"], "active")])
        self.assertEqual(rows[0]["conditions"], old["conditions"])
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertFalse(pending[0]["evolution"]["claim_changed"])
        self.assertTrue(pending[0]["evolution"]["condition_changed"])

    def test_deleting_relation_parent_erases_derived_history_and_its_candidate(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。",
                                  when="2030-04-01T10:00:00+08:00")
        prefix = f"/api/contacts/{first['contact_id']}"
        parent = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.extraction_model.relation_kind = "historical_supplement"
        self.import_event(original="我去年住在甲地。", claim="联系人去年住在甲地。",
                          when="2030-05-01T10:00:00+08:00", contact_id=first["contact_id"])
        self.assertEqual(len(self._get(self.backend, prefix + "/memories")["memories"]), 2)
        status, body = self.backend.request(prefix + f"/memories/{parent['memory_id']}/delete", {})
        self.assertEqual(status, 200, body)
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], [])
        self.assertEqual(self._get(self.backend, prefix + "/memory-candidates")["candidates"], [])
