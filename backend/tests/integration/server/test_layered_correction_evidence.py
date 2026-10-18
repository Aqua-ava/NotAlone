"""新来源定位和旧版本包装不能把纠错依据伪装成独立新事实。"""

import unittest
from uuid import uuid4

import psycopg

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_memory_corrections as correction_support
from tests.integration.server import test_layered_profile_management as profile_support
from tests.integration.server import test_layered_correction_concurrency as adapters


class _RewrittenProposal(adapters._Proposal):
    def __init__(self, mode):
        super().__init__(profile=mode == "cross-layer")
        self.mode = mode

    def propose(self, *, memories, budget, deadline, corrections=(), scenarios=()):
        result = super().propose(memories=memories, budget=budget, deadline=deadline,
            corrections=corrections, scenarios=scenarios)
        text = "双方在合成学习方面有共同经历。"
        if self.profile:
            result["entries"][0]["text"] = text
        else:
            scenario = result["scenarios"][0]
            scenario["topic_key"] = "different-topic-" + self.mode
            scenario["paragraphs"][0]["text"] = text
            if self.mode == "split":
                scenario["paragraphs"].append({**scenario["paragraphs"][0], "text": "双方有合成课程交集。"})
            elif self.mode == "merge":
                scenario["paragraphs"][0]["text"] = text + "双方有合成课程交集。"
        return result


class LayeredCorrectionEvidenceHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def _prepare(self):
        contact, _, message = self.import_contact("合成旧规范消息的同一证据。")
        original = self.confirm(contact, "双方共同完成过合成课程。", message)
        proposal = adapters._Proposal()
        backend = profile_support.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=proposal, scenario_verifier=adapters._Verification(),
            profile_proposer=adapters._Proposal(profile=True), profile_verifier=adapters._Verification())
        path = f"/api/contacts/{contact}/layered-memory"
        status, result = backend.request(path + "/enable", {
            "settings_generation": 0, "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        ready = result["layered_memory"]
        command = correction_support.LayeredMemoryCorrectionHttpTest.summary_command(self, ready)
        status, result = backend.request(path + "/summary-error", command)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["layered_memory"]["scenarios"], [])
        return contact, message, original, backend, path, proposal

    def test_new_source_ref_for_the_same_canonical_message_does_not_release_protection(self):
        contact, message, _, backend, path, proposal = self._prepare()
        # 与既有多来源测试相同，只为同一规范消息装配第二个合法来源引用。
        alias = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.source_document "
                "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES(%s,%s,%s,'wechat_jsonl','synthetic-alias.jsonl',%s,1)",
                (alias, self.owner_id, contact, uuid4().hex * 2))
            connection.execute("INSERT INTO public.message_source_ref "
                "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES(%s,%s,%s,'source_document',%s,'synthetic:alias','{}'::jsonb)",
                (message, self.owner_id, contact, alias))
        messages = self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"]
        canonical = next(item for item in messages if item["text"] == "合成旧规范消息的同一证据。")
        self.assertEqual(canonical["message_id"], str(message))
        self.assertEqual(len(self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]), 2)
        self.confirm(contact, "双方在合成学习方面有共同经历。", message)
        status, result = backend.request(path + "/refresh", {"settings_generation": 1})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["layered_memory"]["scenarios"], [])
        self.assertIsNone(result["layered_memory"]["profile"])
        self.assertEqual(len(proposal.inputs), 1, "同一规范消息新增来源定位不能成为新语义输入")

    def test_old_l1_revision_chain_and_unrelated_new_fact_do_not_release_protection(self):
        contact, _, original, backend, path, proposal = self._prepare()
        status, result = self.backend.request(
            f"/api/contacts/{contact}/memories/{original['memory_id']}/correct", {
                "revision": original["revision"], "text": "双方在合成学习方面有共同经历。",
                "category": "common_fact"})
        self.assertEqual(status, 200, result)
        leaf = result["memory"]
        self.assertEqual(leaf["supersedes_memory_id"], original["memory_id"])
        status, added = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方另有独立合成运动经历。", "category": "common_fact"})
        self.assertEqual(status, 200, added)
        status, refreshed = backend.request(path + "/refresh", {"settings_generation": 1})
        self.assertEqual(status, 200, refreshed)
        current = refreshed["layered_memory"]
        self.assertEqual({ref["memory_id"] for doc in current["scenarios"]
            for item in doc["paragraphs"] for ref in item["references"]}, {added["memory"]["memory_id"]})
        self.assertNotIn(leaf["memory_id"], {str(memory.memory_id) for memory in proposal.inputs[-1][0]})
        self.assertTrue(proposal.inputs[-1][1])

    def _assert_rewritten_old_meaning_rejected(self, mode):
        contact, _, _, _, path, _ = self._prepare()
        status, added = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方另有独立合成运动经历。", "category": "common_fact"})
        self.assertEqual(status, 200, added)
        backend = profile_support.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=adapters._Proposal() if mode == "cross-layer" else _RewrittenProposal(mode),
            scenario_verifier=adapters._Verification(),
            profile_proposer=_RewrittenProposal(mode) if mode == "cross-layer" else adapters._Proposal(profile=True),
            profile_verifier=adapters._Verification())
        status, result = backend.request(path + "/refresh", {"settings_generation": 1})
        self.assertEqual(status, 200, result)
        current = result["layered_memory"]
        self.assertEqual(current["status"], "failed", current)
        self.assertEqual(current["error_code"], "profile_proposal_invalid" if mode == "cross-layer" else "proposal_invalid")
        self.assertIsNone(current["profile"])
        if mode != "cross-layer":
            self.assertEqual(current["scenarios"], [])
        status, fresh = self.backend.request("/api/memories/manual-contact", {
            "contact_id": contact, "text": "双方另有全新独立合成旅行经历。", "category": "common_fact"})
        self.assertEqual(status, 200, fresh)
        control = profile_support.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=adapters._Proposal(), scenario_verifier=adapters._Verification(),
            profile_proposer=adapters._Proposal(profile=True), profile_verifier=adapters._Verification())
        status, result = control.request(path + "/refresh", {"settings_generation": 1})
        self.assertEqual(status, 200, result)
        published = result["layered_memory"]
        self.assertEqual(published["status"], "ready", published)
        self.assertIsNotNone(published["profile"])
        self.assertEqual({ref["memory_id"] for doc in published["scenarios"]
            for item in doc["paragraphs"] for ref in item["references"]},
            {added["memory"]["memory_id"], fresh["memory"]["memory_id"]})

    def test_changed_topic_cannot_publish_reworded_old_meaning(self):
        self._assert_rewritten_old_meaning_rejected("rename")

    def test_split_paragraphs_cannot_publish_reworded_old_meaning(self):
        self._assert_rewritten_old_meaning_rejected("split")

    def test_merged_paragraph_cannot_publish_reworded_old_meaning(self):
        self._assert_rewritten_old_meaning_rejected("merge")

    def test_old_scenario_meaning_cannot_move_into_profile(self):
        self._assert_rewritten_old_meaning_rejected("cross-layer")
