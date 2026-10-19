"""手录更正的事务中间态不能解除同一依据链的整理保护。"""

import unittest
from uuid import uuid4

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_profile_management as profile_support
from tests.integration.server import test_layered_correction_concurrency as adapters


class LayeredCorrectionManualHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def _assert_manual_chain_stays_protected(self, scope_kind, target_kind):
        owner = scope_kind == "owner"
        fields = {}
        if owner:
            path = "/api/memories/owner/layered-memory"
            memories = "/api/memories/owner"
            manual = "/api/memories/manual-owner"
        else:
            status, result = self.backend.request("/api/contacts", {
                "request_id": str(uuid4()), "display_name": "纯手录纠错合成联系人"})
            self.assertEqual(status, 201, result)
            contact = result["contact"]["contact_id"]
            path = f"/api/contacts/{contact}/layered-memory"
            memories = f"/api/contacts/{contact}/memories"
            manual = "/api/memories/manual-contact"
            fields["contact_id"] = contact
        status, result = self.backend.request(manual, {
            **fields, "text": "合成课程是一次共同经历。", "category": "common_fact"})
        self.assertEqual(status, 200, result)
        original = result["memory"]
        proposal = adapters._Proposal()
        backend = profile_support.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=proposal, scenario_verifier=adapters._Verification(),
            profile_proposer=adapters._Proposal(profile=True),
            profile_verifier=adapters._Verification())
        status, result = backend.request(path + "/enable", {
            "settings_generation": 0, "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        ready = result["layered_memory"]
        target = ready["scenarios"][0] if target_kind == "scenario" else ready["profile"]
        status, result = backend.request(path + "/summary-error", {
            "settings_generation": ready["settings_generation"],
            "organization_generation": ready["organization_generation"],
            "target_kind": target_kind, "version_id": target["version_id"],
            "item_index": 0, "reason": "这项总结含义有误。", "operation_id": str(uuid4())})
        self.assertEqual(status, 200, result)
        feedback_id = result["layered_memory"]["feedback"][0]["id"]
        revision = result["layered_memory"]["correction_revision"]
        status, result = self.backend.request(f"{memories}/{original['memory_id']}/correct", {
            "revision": original["revision"], "text": "共同经历包括一次合成课程。",
            "category": "common_fact"})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["memory"]["supersedes_memory_id"], original["memory_id"])
        leaf = result["memory"]
        current = self._get(backend, path)["layered_memory"]
        self.assertEqual(current["protected_count"], 1, "同一手录链换措辞不能解除整理纠错保护")
        self.assertEqual([item["id"] for item in current["feedback"]], [feedback_id])
        # ADR-071/084：记忆更正保留原反馈审计；真实删除才清正文。
        self.assertEqual(current["correction_revision"], revision)
        self.assertEqual(current["feedback"][0]["state"], "active")
        self.assertEqual(current["feedback"][0]["reason"], "这项总结含义有误。")
        status, result = self.backend.request(f"{memories}/{leaf['memory_id']}/correct", {
            "revision": leaf["revision"], "text": "共同经历包括一次合成课程。",
            "category": "relationship_note"})
        self.assertEqual(status, 200, result)
        leaf = result["memory"]
        self.assertEqual(self._get(backend, path)["layered_memory"]["protected_count"], 1)
        status, result = backend.request(path + "/refresh", {
            "settings_generation": ready["settings_generation"]})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["layered_memory"]["scenarios"], [] if target_kind == 'scenario' else ready['scenarios'])
        self.assertIsNone(result["layered_memory"]["profile"])
        from notalone.scopes import ContactScope, OwnerScope
        from uuid import UUID
        scope = OwnerScope(self.owner_id) if owner else ContactScope(self.owner_id, UUID(contact))
        self.assertIsNone(self.service.capture(scope), "画像反馈保留L2审计，但旧手录链不得重返生成")
        self.assertEqual(len(proposal.inputs), 1, "受保护的后继版本不能重新送入整理模型")
        revision = result["layered_memory"]["correction_revision"]
        status, result = self.backend.request(f"{memories}/{leaf['memory_id']}/delete", {})
        self.assertEqual(status, 200, result)
        erased = self._get(backend, path)["layered_memory"]
        self.assertEqual(erased["feedback"], [], "最后合法手录叶删除后不能凭失效墓碑保留保护")
        self.assertEqual(erased["protected_count"], 0)
        self.assertGreater(erased["correction_revision"], revision)

    def test_contact_manual_correction_preserves_scenario_feedback(self):
        self._assert_manual_chain_stays_protected("contact", "scenario")

    def test_owner_manual_correction_preserves_scenario_feedback(self):
        self._assert_manual_chain_stays_protected("owner", "scenario")

    def test_contact_manual_correction_preserves_profile_feedback(self):
        self._assert_manual_chain_stays_protected("contact", "profile")

    def test_owner_manual_correction_preserves_profile_feedback(self):
        self._assert_manual_chain_stays_protected("owner", "profile")
