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
                    "relation": {"kind": self.relation_kind, "explanation": {"historical_supplement": "后来的表述补充了更早的居住经历。", "unresolved_conflict": "两条来源说法不同，尚无充分依据判断变化或纠错。", "state_change": "来源说明同一事项的状态发生变化。", "error_correction": "来源明确纠正此前的表述。", "supplement": "来源补充同一事项的其他细节。", "independent": "两条来源涉及同一联系人不同事项，可分别保留。"}[self.relation_kind],
                                 "related_memory_ids": [item["memory_id"] for item in row["similar"]],
                                 "evidence": evidence, "claim_changed": self.relation_claim_changed, "condition_changed": self.relation_condition_changed}})
            self.responses[index] = event_support.tool_response(names[0], {"decisions": decisions})
        if names == ["MemoryRelationVerificationOutput"]:
            entries = json.loads(content)
            self.responses.insert(index, event_support.tool_response(names[0], {"results": [
                {"candidate_index": row["candidate_index"], "verdict": "supported",
                 "same_subject_and_matter": row["relation"]["kind"] != "independent", "claim_changed": row["relation"]["claim_changed"],
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
        from notalone.persistence.outbound_ledger import PostgresOutboundLedger
        ledger = PostgresOutboundLedger(self.database_url)
        before_calls = ledger.summarize_by_owner(self.owner_id).total_calls
        self.extraction_model.relation_kind = "historical_supplement"
        second = self.import_event(original="我去年住在甲地。", claim="联系人去年住在甲地。",
                                  when="2030-05-01T10:00:00+08:00", contact_id=first["contact_id"])
        rows = self._get(self.backend, f"/api/contacts/{first['contact_id']}/memories")["memories"]
        history = next(row for row in rows if row["text"] == "联系人去年住在甲地。")
        self.assertEqual(history["evolution"]["kind"], "historical_supplement")
        self.assertTrue(history["evolution"]["source_supported"])
        self.assertIn(second["message"]["message_id"], history["evolution"]["evidence_message_ids"])
        self.assertFalse(history["evolution"]["claim_changed"])
        self.assertEqual(ledger.summarize_by_owner(self.owner_id).total_calls - before_calls, 4)
        from uuid import UUID
        from notalone.scopes import ContactScope
        from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
        traces = PostgresExtractionTraceStore(self.database_url)
        scope = ContactScope(self.owner_id, UUID(first["contact_id"]))
        detail = traces.get_batch(scope, UUID(traces.list_batches(scope)[0]["trace_id"]))
        calls = detail["calls"]
        self.assertEqual({call["purpose"] for call in calls},
                         {"extraction", "verification", "adjudication", "relation_verification"})
        self.assertEqual(len({call["ledger_entry_id"] for call in calls}), 4)
        self.assertTrue(all(call["ledger_commit_status"] == "committed" for call in calls))

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

    def test_later_clarification_can_replace_fact_with_projected_conflict(self):
        first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。",
                                  when="2030-04-01T10:00:00+08:00")
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.extraction_model.relation_kind = "unresolved_conflict"
        self.import_event(original="我现在住在甲地。", claim="联系人现在住在甲地。",
                          when="2030-04-02T10:00:00+08:00", contact_id=first["contact_id"])
        self.assertEqual(self._get(self.backend, path)["memories"][0]["evolution"]["kind"], "unresolved_conflict")
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        self.import_event(original="澄清一下，我确实已从乙地搬到甲地，现在住甲地。", claim="联系人已从乙地搬到甲地。",
                          when="2030-04-03T10:00:00+08:00", contact_id=first["contact_id"],
                          action="update", replaced_id=old["memory_id"])
        active = [row for row in self._get(self.backend, path)["memories"] if row["status"] == "active"]
        self.assertEqual([row["text"] for row in active], ["联系人已从乙地搬到甲地。"])
        self.assertEqual(active[0]["evolution"]["kind"], "state_change")

    def test_plan_can_be_rescheduled_earlier_by_newer_supported_statement(self):
        first = self.import_event(original="读书会计划8月5日举行。", claim="读书会计划8月5日举行。",
            when="2030-08-01T10:00:00+08:00",
            event_spec={"stage": "planned", "occurrence_start": "2030-08-05T00:00:00+08:00", "occurrence_end": "2030-08-06T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"})
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        self.import_event(original="原定8月5日的同一场读书会提前到8月4日。", claim="同一场读书会改期到8月4日。",
            when="2030-08-02T10:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
            event_spec={"stage": "rescheduled", "occurrence_start": "2030-08-04T00:00:00+08:00", "occurrence_end": "2030-08-05T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"})
        active = [row for row in self._get(self.backend, path)["memories"] if row["status"] == "active"]
        self.assertEqual([row["text"] for row in active], ["同一场读书会改期到8月4日。"])
        self.assertEqual(active[0]["event"]["stage"], "rescheduled")

    def test_same_condition_with_new_evidence_does_not_require_condition_change(self):
        from tests.integration.server.test_memory_conditions import MemoryConditionsHttpTest
        first = MemoryConditionsHttpTest.import_condition(self,
            original="出差期间不便通话。", claim="出差期间不便通话。", when="2030-04-01T10:00:00+08:00")
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        MemoryConditionsHttpTest.import_condition(self,
            original="我现在出差期间也可以通话了，原先的不便已经改变。", claim="出差期间可以通话。",
            when="2030-04-02T10:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"])
        active = [row for row in self._get(self.backend, path)["memories"] if row["status"] == "active"]
        self.assertEqual([row["text"] for row in active], ["出差期间可以通话。"])
        self.assertFalse(active[0]["evolution"]["condition_changed"])
        self.assertNotEqual(active[0]["conditions"]["items"][0]["evidence"], old["conditions"]["items"][0]["evidence"])

    def test_unknown_relation_add_or_keep_does_not_publish_alongside_existing_fact(self):
        for action in ("add", "keep"):
            with self.subTest(action=action):
                first = self.import_event(original="我目前住在乙地。", claim="联系人目前住在乙地。", when="2030-04-01T10:00:00+08:00")
                path = f"/api/contacts/{first['contact_id']}"
                self.import_event(original="我住在甲地。", claim="联系人住在甲地。", when="2030-04-02T10:00:00+08:00", contact_id=first["contact_id"], action=action)
                self.assertEqual([item["text"] for item in self._get(self.backend, path + "/memories")["memories"]], ["联系人目前住在乙地。"])
                self.assertEqual([item["text"] for item in self._get(self.backend, path + "/memory-candidates")["candidates"]], ["联系人住在甲地。"])

    def test_independently_supported_new_matter_keeps_only_its_own_claim_sources(self):
        first = self.import_event(original="八月那场读书会在甲地。", claim="八月那场读书会在甲地。", when="2030-04-01T10:00:00+08:00")
        self.extraction_model.relation_kind = "independent"
        second = self.import_event(original="九月另外一场读书会在乙地。", claim="九月另一场读书会在乙地。", when="2030-04-02T10:00:00+08:00", contact_id=first["contact_id"], action="add")
        rows = self._get(self.backend, f"/api/contacts/{first['contact_id']}/memories")["memories"]
        self.assertEqual(len(rows), 2)
        new = next(row for row in rows if row["text"] == "九月另一场读书会在乙地。")
        self.assertEqual(new["source_ids"], [second["message"]["message_id"]])
        self.assertEqual(new["evolution"]["kind"], "independent")
        self.assertTrue(new["evolution"]["source_supported"])

    def test_newer_cancellation_does_not_need_an_occurrence_date(self):
        first = self.import_event(original="读书会计划8月5日举行。", claim="读书会计划8月5日举行。",
            when="2030-08-01T10:00:00+08:00", event_spec={"stage": "planned", "occurrence_start": "2030-08-05T00:00:00+08:00", "occurrence_end": "2030-08-06T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"})
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        self.import_event(original="刚才安排的那次读书会取消了。", claim="原计划的读书会已取消。",
            when="2030-08-02T10:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
            event_spec={"stage": "cancelled"}, event_verification={"stage_verdict": "supported", "occurrence_verdict": "uncertain"})
        active = [row for row in self._get(self.backend, path)["memories"] if row["status"] == "active"]
        self.assertEqual([row["text"] for row in active], ["原计划的读书会已取消。"])
        self.assertIsNone(active[0]["event"]["occurrence_start"])

    def test_owner_l2_l3_actual_payloads_redact_evolution_source_and_version_ids(self):
        import time
        from langchain_core.messages import AIMessage
        from notalone.memory.layered import OrganizationBudget
        from notalone.memory.organization_deadline import OrganizationCallDeadline
        from notalone.memory.organization_sdk import DeepSeekOrganizationProposal
        from tests.integration.server.test_layered_memory_management import ControlledProposal
        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        class AllMemories(ControlledProposal):
            def propose(inner, *, memories, budget, deadline):
                inner.inputs.append(memories)
                return {"scenarios": [{"topic_key": "learning", "title": "本人学习经历", "hint": "本人已经叙述的经历",
                    "paragraphs": [{"text": item.text, "references": [{"memory_id": str(item.memory_id), "revision": item.revision}]} for item in memories]}]}
        first = self.import_event(original="我曾完成乙课程。", claim="本人曾完成乙课程。", when="2030-04-01T10:00:00+08:00", subject="self", fact_overrides={"category": "common_fact"})
        self.extraction_model.relation_kind = "historical_supplement"
        second = self.import_event(original="我更早还学完过甲课程。", claim="本人更早完成过甲课程。", when="2030-04-02T10:00:00+08:00", subject="self", contact_id=first["contact_id"], fact_overrides={"category": "common_fact"})
        backend = LayeredProfileHttpTest.controlled(self, scenario_proposer=AllMemories())
        path = "/api/memories/owner/layered-memory"
        state = self._get(backend, path)["layered_memory"]
        status, result = backend.request(path + "/enable", {"settings_generation": state["settings_generation"], "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["layered_memory"]["status"], "ready", result)
        class RecordingModel:
            def bind(inner, **kwargs): return inner
            def invoke(inner, messages):
                inner.payload = json.loads(messages[-1].content)
                return AIMessage(content='{}', response_metadata={"finish_reason": "stop"})
        payloads = []
        contexts, memories = self.profile_proposer.inputs[0]
        self.assertTrue(contexts)
        for layer, inputs, scenarios in (("l2", self.scenario_proposer.inputs[0], ()), ("l3", memories, contexts)):
            model = RecordingModel()
            budget = OrganizationBudget()
            DeepSeekOrganizationProposal(model, layer=layer, budget=budget, transport=None).propose(
                memories=inputs, scenarios=scenarios, budget=budget, deadline=OrganizationCallDeadline(time.monotonic() + 5))
            payloads.append(model.payload)
        allowed = {"kind", "explanation", "source_supported", "claim_changed", "condition_changed"}
        def check(value):
            if isinstance(value, dict):
                if value.get("evolution"):
                    self.assertEqual(set(value["evolution"]), allowed)
                for child in value.values(): check(child)
            elif isinstance(value, list):
                for child in value: check(child)
        for payload in payloads:
            rendered = json.dumps(payload, ensure_ascii=False)
            self.assertIn("historical_supplement", rendered)
            for message in (first["message"], second["message"]):
                self.assertNotIn(message["message_id"], rendered)
            check(payload)

    def test_earlier_imported_cancellation_cannot_override_newer_plan(self):
        first = self.import_event(original="已经重新安排，读书会计划8月5日举行。", claim="读书会计划8月5日举行。",
            when="2030-08-03T10:00:00+08:00", event_spec={"stage": "planned", "occurrence_start": "2030-08-05T00:00:00+08:00", "occurrence_end": "2030-08-06T00:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"})
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.extraction_model.relation_kind = "state_change"
        self.extraction_model.relation_claim_changed = True
        self.import_event(original="之前那次读书会取消了。", claim="读书会已取消。",
            when="2030-08-02T10:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
            event_spec={"stage": "cancelled"}, event_verification={"stage_verdict": "supported", "occurrence_verdict": "uncertain"})
        active = [row for row in self._get(self.backend, path)["memories"] if row["status"] == "active"]
        self.assertEqual([row["memory_id"] for row in active], [old["memory_id"]])
        pending = self._get(self.backend, f"/api/contacts/{first['contact_id']}/memory-candidates")["candidates"]
        self.assertEqual([row["text"] for row in pending], ["读书会已取消。"])
