"""合并与纠错通过正式导入、独立模型核验和版本读取闭环验收。"""
import json
import unittest

from tests.integration.server import test_memory_event_updates as events
from tests.integration.server import test_memory_timeline as timeline


class TimelineMergeModel(timeline.TimelineModel):
    merged_text: str | None = None
    merge_verification_requests: list[dict] = []

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        names = [item["function"]["name"] for item in kwargs.get("tools", [])]
        index = len(self.seen_calls)
        if names == ["BatchMemoryAdjudicationOutput"] and self.merged_text:
            rows = json.loads(str(messages[-1].content))
            original = self.responses[index].tool_calls[0]["args"]
            self.responses[index] = events.tool_response("MemoryAdjudicationOutput", {
                **original, "merged_memory_ids": [item["memory_id"] for item in rows[0]["similar"]],
                "merged_text": self.merged_text,
            })
        if names == ["SourceVerificationOutput"] and index >= len(self.responses):
            payload = json.loads(str(messages[-1].content))
            self.merge_verification_requests = [*self.merge_verification_requests, payload]
            self.responses.append(events.tool_response(names[0], {"results": [
                {"candidate_index": item["candidate_index"], "verdict": "supported", "issues": [],
                 "evidence": [{"message_id": source["message_id"], "quote": source["text"]}
                              for source in payload["messages"]
                              if source["message_id"] in item["source_message_ids"]]}
                for item in payload["candidates"]]}))
        return super()._generate(messages, stop, run_manager, **kwargs)


class MemoryTimelineMergeHttpTest(events.CoreBusinessFlowFixture, unittest.TestCase):
    dimension_release = events.DimensionRelease(gate_enabled=False)
    extraction_model_factory = TimelineMergeModel
    import_event = events.MemoryEventUpdatesHttpTest.import_event

    def two_parents(self):
        first = self.import_event(original="我喜欢喝无糖茶。", claim="联系人喜欢喝无糖茶。",
                                  when="2030-04-01T10:00:00+08:00")
        self.extraction_model.relation_kind = "supplement"
        second = self.import_event(original="我喝茶时不加冰。", claim="联系人喝茶时不加冰。",
                                   when="2030-04-02T10:00:00+08:00", contact_id=first["contact_id"])
        path = f"/api/contacts/{first['contact_id']}/memories"
        parents = self._get(self.backend, path)["memories"]
        self.assertEqual(len(parents), 2)
        self.assertTrue(all(item["status"] == "active" for item in parents))
        self.extraction_model.relation_kind = None
        return first, second, path, parents

    def test_supported_supplement_merge_reverifies_combined_text_and_preserves_two_parent_versions(self):
        first, second, path, parents = self.two_parents()
        merged_text = "联系人喜欢喝无糖茶，喝茶时不加冰。"
        self.extraction_model.merged_text = merged_text
        self.extraction_model.relation_kind = "supplement"
        third = self.import_event(original="我喝茶仍然要无糖，也不要加冰。", claim="联系人喝茶要无糖且不加冰。",
                                  when="2030-04-03T10:00:00+08:00", contact_id=first["contact_id"], action="merge")
        reopened = self._backend(self.owner_id)
        memories = self._get(reopened, path)["memories"]
        active = [item for item in memories if item["status"] == "active"]
        self.assertEqual([item["text"] for item in active], [merged_text], memories)
        current = active[0]
        evolution = current["evolution"]
        self.assertEqual(evolution["kind"], "supplement")
        self.assertTrue(evolution["source_supported"])
        self.assertFalse(evolution["claim_changed"])
        self.assertEqual({(item["memory_id"], item["revision"]) for item in evolution["related_versions"]},
                         {(item["memory_id"], item["revision"]) for item in parents})
        sources = {item["message"]["message_id"] for item in (first, second, third)}
        self.assertEqual(set(current["source_ids"]), sources)
        self.assertEqual(set(evolution["evidence_message_ids"]), sources)
        self.assertNotIn("proof", evolution)
        requests = self.extraction_model.merge_verification_requests
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["candidates"][0]["text"], merged_text)
        self.assertEqual(set(requests[0]["candidates"][0]["source_message_ids"]), sources)
        history = self._get(reopened, f"{path}/{current['memory_id']}/versions")["versions"]
        self.assertEqual({item["memory_id"] for item in history}, {current["memory_id"], *(item["memory_id"] for item in parents)})
        self.assertTrue(all(item["status"] == "invalidated" for item in history if item["memory_id"] != current["memory_id"]))

    def test_merge_without_relation_proof_stays_pending_and_preserves_both_active_parents(self):
        first, _, path, parents = self.two_parents()
        self.extraction_model.merged_text = "联系人喜欢喝无糖茶，喝茶时不加冰。"
        third = self.import_event(original="我喝茶仍然要无糖，也不要加冰。", claim="联系人喝茶要无糖且不加冰。",
                                  when="2030-04-03T10:00:00+08:00", contact_id=first["contact_id"], action="merge")
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, path)["memories"], parents)
        pending = self._get(reopened, path.replace("/memories", "/memory-candidates"))["candidates"]
        self.assertEqual([item["text"] for item in pending], ["联系人喝茶要无糖且不加冰。"])
        self.assertIsNone(pending[0]["evolution"])
        self.assertEqual(pending[0]["source_ids"], [third["message"]["message_id"]])
        self.assertEqual(self.extraction_model.merge_verification_requests, [])

    def test_supported_error_correction_update_exposes_retirement_reason_and_version_evidence(self):
        first = self.import_event(original="我住在蓝海小区。", claim="联系人住在蓝海小区。",
                                  when="2030-05-01T10:00:00+08:00")
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.extraction_model.relation_kind = "error_correction"
        self.extraction_model.relation_claim_changed = True
        corrected = self.import_event(original="我昨天说错了，我住在青山小区，一直没有搬家。", claim="联系人住在青山小区。",
                                      when="2030-05-02T10:00:00+08:00", contact_id=first["contact_id"],
                                      action="update", replaced_id=old["memory_id"])
        reopened = self._backend(self.owner_id)
        memories = self._get(reopened, path)["memories"]
        active = [item for item in memories if item["status"] == "active"]
        self.assertEqual([item["text"] for item in active], ["联系人住在青山小区。"])
        current = active[0]
        evolution = current["evolution"]
        self.assertEqual(evolution["kind"], "error_correction")
        self.assertTrue(evolution["source_supported"])
        self.assertTrue(evolution["claim_changed"])
        self.assertFalse(evolution["condition_changed"])
        self.assertEqual(evolution["related_versions"], [{"memory_id": old["memory_id"], "revision": old["revision"]}])
        self.assertEqual(set(evolution["evidence_message_ids"]), {first["message"]["message_id"], corrected["message"]["message_id"]})
        self.assertNotIn("proof", evolution)
        history = self._get(reopened, f"{path}/{current['memory_id']}/versions")["versions"]
        self.assertEqual([item["text"] for item in history], [current["text"], old["text"]])
        self.assertEqual(history[0]["evolution"], evolution)
        self.assertEqual(history[1]["status"], "invalidated")
        self.assertEqual(history[1]["retirement_reason"], "error_correction")
        self.assertIsNotNone(history[1]["retired_at"])
