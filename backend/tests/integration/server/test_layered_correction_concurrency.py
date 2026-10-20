"""纠错在真实语义调用期间发生时，公开管理入口不得接受迟到结果。"""

import unittest
from uuid import uuid4

import psycopg

from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_profile_management as profile_support


class _Proposal:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self, *, profile=False):
        self.profile = profile
        self.hook = None
        self.inputs = []

    def propose(self, *, memories, budget, deadline, corrections=(), scenarios=()):
        deadline.check()
        self.inputs.append((memories, corrections))
        if self.hook:
            hook, self.hook = self.hook, None
            hook()
        items = [{"text": memory.text, "references": [
            {"memory_id": str(memory.memory_id), "revision": memory.revision}]}
            for memory in memories]
        if self.profile:
            return {"entries": [{**item, "temporal_status": "uncertain",
                "uncertainty": "当前状态按原资料保留，未额外核实。"} for item in items]}
        # 纠错后旧主题身份退休；独立重建使用新主题，不能隐式拼回旧正文。
        prefix = "corrected-concurrency-" if corrections else "concurrency-"
        return {"scenarios": [{"topic_key": prefix + item["references"][0]["memory_id"],
            "title": "已核对的补充资料" if corrections else "合成独立资料",
            "hint": "独立资料的原文背景。" if corrections else "分别保留的合成经历。",
            "paragraphs": [item]} for item in items]}


class _Verification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def __init__(self):
        self.hook = None
        self.inputs = []

    def verify(self, *, memories, proposal, deadline, corrections=(), scenarios=()):
        deadline.check()
        self.inputs.append((memories, corrections))
        if self.hook:
            hook, self.hook = self.hook, None
            hook()
        return True


class LayeredCorrectionConcurrencyHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def _new_feedback_during_call(self, scope_kind, phase, *, fact=False):
        contact, _, _ = self.import_contact("合成并发纠错范围。")
        owner = scope_kind == "owner"
        path = "/api/memories/owner/layered-memory" if owner else f"/api/contacts/{contact}/layered-memory"
        manual = "/api/memories/manual-owner" if owner else "/api/memories/manual-contact"
        fields = {} if owner else {"contact_id": contact}

        def add(text):
            status, result = self.backend.request(manual, {
                **fields, "text": text, "category": "common_fact"})
            self.assertEqual(status, 200, result)
            return result["memory"]

        original = add("本人完成过合成课程。" if owner else "双方共同完成过合成课程。")
        adapters = {"scenario_propose": _Proposal(), "scenario_verify": _Verification(),
            "profile_propose": _Proposal(profile=True), "profile_verify": _Verification()}
        backend = profile_support.LayeredProfileHttpTest.controlled(self,
            scenario_proposer=adapters["scenario_propose"], scenario_verifier=adapters["scenario_verify"],
            profile_proposer=adapters["profile_propose"], profile_verifier=adapters["profile_verify"])
        status, enabled = backend.request(path + "/enable", {
            "settings_generation": 0, "purpose_confirmed": True})
        self.assertEqual(status, 200, enabled)
        self.assertIsNotNone(enabled["layered_memory"]["profile"])
        added = add("本人有另一项合成经历。" if owner else "双方有另一项合成经历。")
        receipts = []

        def feedback():
            status, result = backend.request(path)
            current = result.get("layered_memory", {})
            target = next((doc for doc in current.get("scenarios", [])
                if any(ref["memory_id"] == original["memory_id"]
                    for item in doc["paragraphs"] for ref in item["references"])), None)
            if target is None:
                receipts.append((status, result, None))
                return
            command = {"settings_generation": current["settings_generation"],
                "organization_generation": current["organization_generation"],
                "target_kind": "scenario", "version_id": target["version_id"], "item_index": 0,
                "reason": "这项总结含义有误，正在执行的旧输入不得再发布。", "operation_id": str(uuid4())}
            if fact:
                command.pop("reason")
                command.pop("operation_id")
                command["memory_id"] = original["memory_id"]
            receipts.append((*backend.request(path + ("/fact-error" if fact else "/summary-error"), command), target["version_id"]))

        adapters[phase].hook = feedback
        status, result = backend.request(path + "/refresh", {
            "settings_generation": enabled["layered_memory"]["settings_generation"]})
        self.assertEqual(status, 200, result)
        self.assertEqual(len(receipts), 1, receipts)
        self.assertEqual(receipts[0][0], 200, receipts)
        self.assertIsNotNone(receipts[0][2], receipts)
        current = self._get(backend, path)["layered_memory"]
        # 被纠错的原场景来自首轮单条输入；增量整理不能把后来的独立资料追认成旧依据。
        self.assertEqual(current["protected_count"], 1, current)
        if fact:
            self.assertEqual(current["pending_fact_count"], 1)
            self.assertEqual(current["feedback"], [])
        self.assertNotIn(receipts[0][2], {doc["version_id"] for doc in current["scenarios"]})
        self.assertFalse(any(ref["memory_id"] == original["memory_id"]
            for doc in current["scenarios"] for item in doc["paragraphs"] for ref in item["references"]))
        self.assertFalse(any(ref["memory_id"] == original["memory_id"]
            for item in (current["profile"] or {}).get("entries", []) for ref in item["references"]))
        audit_versions = {doc["version_id"]: doc["paragraphs"] for doc in current["scenarios"]}
        fresh = add("本人有全新独立合成事实。" if owner else "双方有全新独立合成事实。")
        status, result = backend.request(path + "/refresh", {
            "settings_generation": current["settings_generation"]})
        self.assertEqual(status, 200, result)
        published = result["layered_memory"]
        references = {ref["memory_id"] for doc in published["scenarios"]
            for item in doc["paragraphs"] for ref in item["references"]}
        self.assertIn(fresh["memory_id"], references, published)
        self.assertLessEqual(references, {added["memory_id"], fresh["memory_id"]})
        self.assertIsNotNone(published["profile"], published)
        profile_inputs = {str(memory.memory_id) for memory in adapters['profile_propose'].inputs[-1][0]}
        self.assertIn(fresh['memory_id'], profile_inputs)
        self.assertNotIn(original['memory_id'], profile_inputs,
            "L3不能从可见引用独立但完整输入受保护的旧L2行重新读入旧事实")
        with psycopg.connect(self.database_url) as connection:
            manifests = connection.execute("SELECT b.input_manifest FROM public.scenario_document_version v "
                "JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE v.owner_id=%s AND v.id=ANY(%s::uuid[])",
                (self.owner_id, [doc['version_id'] for doc in published['scenarios']])).fetchall()
            self.assertNotIn(original['memory_id'], {item['memory_id'] for (manifest,) in manifests for item in manifest},
                "当前主题不能在同键合并时把受保护的隐藏实际输入拼回新批次")
            retained = connection.execute("SELECT id,paragraphs FROM public.scenario_document_version "
                "WHERE owner_id=%s AND id=ANY(%s::uuid[])", (self.owner_id, list(audit_versions))).fetchall()
            self.assertEqual({str(identifier): paragraphs for identifier, paragraphs in retained}, audit_versions,
                "撤下失效当前集合不能擦除既有审计正文")
        self.assertEqual(bool(adapters["scenario_propose"].inputs[-1][1]), not fact)
        self.assertNotIn(original["memory_id"], {str(memory.memory_id)
            for memory in adapters["scenario_propose"].inputs[-1][0]})

    def test_contact_feedback_after_scenario_verification_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "scenario_verify")

    def test_contact_feedback_during_scenario_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "scenario_propose")

    def test_contact_feedback_during_profile_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "profile_propose")

    def test_contact_feedback_after_profile_verification_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "profile_verify")

    def test_owner_feedback_during_scenario_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "scenario_propose")

    def test_owner_feedback_after_scenario_verification_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "scenario_verify")

    def test_owner_feedback_during_profile_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "profile_propose")

    def test_owner_feedback_after_profile_verification_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "profile_verify")

    def test_contact_fact_error_during_scenario_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "scenario_propose", fact=True)

    def test_contact_fact_error_after_scenario_verification_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "scenario_verify", fact=True)

    def test_contact_fact_error_during_profile_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "profile_propose", fact=True)

    def test_contact_fact_error_after_profile_verification_rejects_late_publish(self):
        self._new_feedback_during_call("contact", "profile_verify", fact=True)

    def test_owner_fact_error_during_scenario_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "scenario_propose", fact=True)

    def test_owner_fact_error_after_scenario_verification_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "scenario_verify", fact=True)

    def test_owner_fact_error_during_profile_proposal_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "profile_propose", fact=True)

    def test_owner_fact_error_after_profile_verification_rejects_late_publish(self):
        self._new_feedback_during_call("owner", "profile_verify", fact=True)
