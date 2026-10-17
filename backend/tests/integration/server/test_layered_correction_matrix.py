"""两类整理纠错的范围与层级矩阵，仅从公开 HTTP 观察资料变化。"""

import unittest
from uuid import uuid4

from notalone.memory.layered import OrganizationBudget
from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_profile_management as profile_support


class _SeparateScenarioProposal:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def propose(self, *, memories, budget, deadline, corrections=()):
        deadline.check()
        return {"scenarios": [
            {"topic_key": f"matrix-{index}", "title": f"合成主题{index}",
             "hint": "分别保留的独立合成经历。", "paragraphs": [
                 {"text": memory.text, "references": [
                     {"memory_id": str(memory.memory_id), "revision": memory.revision}]}]}
            for index, memory in enumerate(memories)
        ]}


class _LiteralProfileProposal:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def propose(self, *, scenarios, memories, budget, deadline, corrections=()):
        deadline.check()
        return {"entries": [
            {"text": memory.text, "temporal_status": "uncertain",
             "uncertainty": "仅保留原资料记载，当前情况未额外核实。",
             "references": [{"memory_id": str(memory.memory_id),
                             "revision": memory.revision}]}
            for memory in memories
        ]}


class _AcceptScenarioVerification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def verify(self, *, memories, proposal, deadline, corrections=()):
        deadline.check()
        return True


class _AcceptProfileVerification:
    timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

    def verify(self, *, scenarios, memories, proposal, deadline, corrections=()):
        deadline.check()
        return True


class LayeredCorrectionMatrixHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def _prepare_scope(self, scope_kind, *, corrected_leaf=False):
        if scope_kind == "contact":
            status, created = self.backend.request("/api/contacts", {
                "request_id": str(uuid4()), "display_name": "纠错矩阵合成联系人"})
            self.assertEqual(status, 201, created)
            contact_id = created["contact"]["contact_id"]
            status, result = self.backend.request(
                f"/api/contacts/{contact_id}/manual-confirmation", {})
            self.assertEqual(status, 200, result)
            layered_path = f"/api/contacts/{contact_id}/layered-memory"
            memories_path = f"/api/contacts/{contact_id}/memories"
            manual_path = "/api/memories/manual-contact"
            scope_fields = {"contact_id": contact_id}
            primary_text = "双方共同参加过合成课程。"
            unrelated_text = "双方另有独立合成练习经历。"
            current_text = "双方完成的是另一门合成课程。"
        else:
            layered_path = "/api/memories/owner/layered-memory"
            memories_path = "/api/memories/owner"
            manual_path = "/api/memories/manual-owner"
            scope_fields = {}
            primary_text = "本人完成过合成课程。"
            unrelated_text = "本人另有独立合成练习经历。"
            current_text = "本人完成的是另一门合成课程。"

        status, result = self.backend.request(manual_path, {
            **scope_fields, "text": primary_text, "category": "common_fact"})
        self.assertEqual(status, 200, result)
        primary = result["memory"]
        if corrected_leaf:
            status, result = self.backend.request(
                f"{memories_path}/{primary['memory_id']}/correct", {
                    "text": current_text, "category": "common_fact",
                    "revision": primary["revision"]})
            self.assertEqual(status, 200, result)
            current = result["memory"]
            self.assertNotEqual(current["memory_id"], primary["memory_id"])
            self.assertEqual(current["supersedes_memory_id"], primary["memory_id"])
            primary = current

        status, result = self.backend.request(manual_path, {
            **scope_fields, "text": unrelated_text, "category": "common_fact"})
        self.assertEqual(status, 200, result)
        unrelated = result["memory"]
        backend = profile_support.LayeredProfileHttpTest.controlled(
            self, scenario_proposer=_SeparateScenarioProposal(),
            scenario_verifier=_AcceptScenarioVerification(),
            profile_proposer=_LiteralProfileProposal(),
            profile_verifier=_AcceptProfileVerification(),
            budget=OrganizationBudget(max_model_calls=4, max_characters=12000))
        initial = self._get(backend, layered_path)["layered_memory"]
        status, result = backend.request(layered_path + "/enable", {
            "settings_generation": initial["settings_generation"],
            "purpose_confirmed": True})
        self.assertEqual(status, 200, result)
        ready = result["layered_memory"]
        self.assertEqual(len(ready["scenarios"]), 2, ready)
        self.assertIsNotNone(ready["profile"], ready)
        self.assertEqual(len(ready["profile"]["entries"]), 2, ready)
        return backend, layered_path, memories_path, ready, primary, unrelated

    def _target_command(self, ready, target_kind, memory_id):
        if target_kind == "scenario":
            target = next(doc for doc in ready["scenarios"]
                          if any(ref["memory_id"] == memory_id
                                 for paragraph in doc["paragraphs"]
                                 for ref in paragraph["references"]))
            items = target["paragraphs"]
        else:
            target = ready["profile"]
            items = target["entries"]
        index = next(index for index, item in enumerate(items)
                     if any(ref["memory_id"] == memory_id for ref in item["references"]))
        self.assertEqual({ref["memory_id"] for ref in items[index]["references"]},
                         {memory_id})
        return {"settings_generation": ready["settings_generation"],
                "organization_generation": ready["organization_generation"],
                "target_kind": target_kind, "version_id": target["version_id"],
                "item_index": index}

    def _memories(self, path):
        return {memory["memory_id"]: memory
                for memory in self._get(self.backend, path)["memories"]}

    def _assert_retracted_target(self, ready, current, target_kind, version_id):
        if target_kind == "scenario":
            retained = [doc for doc in ready["scenarios"]
                        if doc["version_id"] != version_id]
            self.assertEqual(len(retained), 1)
            self.assertEqual(current["scenarios"], retained)
            self.assertIsNone(current["profile"], "依赖被撤主题的画像也必须撤下")
        else:
            self.assertIsNone(current["profile"])
            self.assertEqual(current["scenarios"], ready["scenarios"])

    def _assert_summary_error(self, scope_kind, target_kind):
        backend, path, memories_path, ready, primary, unrelated = self._prepare_scope(scope_kind)
        before = self._memories(memories_path)
        self.assertEqual(set(before), {primary["memory_id"], unrelated["memory_id"]})
        command = {**self._target_command(ready, target_kind, primary["memory_id"]),
                   "reason": "该总结没有准确保留原资料的含义。",
                   "operation_id": str(uuid4())}
        status, result = backend.request(path + "/summary-error", command)
        self.assertEqual(status, 200, result)
        self._assert_retracted_target(
            ready, result["layered_memory"], target_kind, command["version_id"])
        current = self._get(backend, path)["layered_memory"]
        self._assert_retracted_target(ready, current, target_kind, command["version_id"])
        self.assertEqual(self._memories(memories_path), before,
                         "总结反馈不能改写、替代或删除正确底层记忆")

    def _assert_fact_error(self, scope_kind, target_kind):
        backend, path, memories_path, ready, primary, unrelated = self._prepare_scope(
            scope_kind, corrected_leaf=True)
        before = self._memories(memories_path)
        command = self._target_command(ready, target_kind, primary["memory_id"])
        status, rejected = backend.request(path + "/fact-error", {
            **command, "memory_id": unrelated["memory_id"]})
        self.assertEqual(status, 409, rejected)
        unchanged = self._get(backend, path)["layered_memory"]
        self.assertEqual(unchanged["scenarios"], ready["scenarios"])
        self.assertEqual(unchanged["profile"], ready["profile"])
        self.assertEqual(self._memories(memories_path), before)

        status, result = backend.request(path + "/fact-error", {
            **command, "memory_id": primary["memory_id"]})
        self.assertEqual(status, 200, result)
        selected = result["layered_memory"]["correction_target"]
        self.assertEqual(selected, {"memory_id": primary["memory_id"],
                                    "revision": primary["revision"]})
        self._assert_retracted_target(
            ready, result["layered_memory"], target_kind, command["version_id"])
        self.assertEqual(self._memories(memories_path), before,
                         "选择事实纠错只能导向底层入口，不能先改写事实")

        new_text = "本人只完成了合成课程的入门部分。" if scope_kind == "owner" else "双方只共同参加了合成课程的入门部分。"
        status, result = self.backend.request(
            f"{memories_path}/{selected['memory_id']}/correct", {
                "text": new_text, "category": "common_fact", "revision": selected["revision"]})
        self.assertEqual(status, 200, result)
        corrected = result["memory"]
        self.assertNotEqual(corrected["memory_id"], selected["memory_id"])
        self.assertEqual(corrected["supersedes_memory_id"], selected["memory_id"])
        self.assertEqual(corrected["revision"], selected["revision"] + 1)
        self.assertEqual(corrected["text"], new_text)
        current = self._memories(memories_path)
        self.assertEqual(set(current), {corrected["memory_id"], unrelated["memory_id"]})
        self.assertEqual(current[unrelated["memory_id"]], before[unrelated["memory_id"]])
        versions = self._get(
            self.backend, f"{memories_path}/{corrected['memory_id']}/versions")["versions"]
        self.assertEqual(versions[0]["memory_id"], corrected["memory_id"])
        self.assertIn(primary["memory_id"], {version["memory_id"] for version in versions})

    def test_contact_scenario_summary_error_preserves_l1_and_independent_topic(self):
        self._assert_summary_error("contact", "scenario")

    def test_contact_profile_summary_error_preserves_l1_and_scenarios(self):
        self._assert_summary_error("contact", "profile")

    def test_owner_scenario_summary_error_preserves_l1_and_independent_topic(self):
        self._assert_summary_error("owner", "scenario")

    def test_owner_profile_summary_error_preserves_l1_and_scenarios(self):
        self._assert_summary_error("owner", "profile")

    def test_contact_scenario_fact_error_rejects_uncited_memory_and_corrects_current_leaf(self):
        self._assert_fact_error("contact", "scenario")

    def test_contact_profile_fact_error_rejects_uncited_memory_and_corrects_current_leaf(self):
        self._assert_fact_error("contact", "profile")

    def test_owner_scenario_fact_error_rejects_uncited_memory_and_corrects_current_leaf(self):
        self._assert_fact_error("owner", "scenario")

    def test_owner_profile_fact_error_rejects_uncited_memory_and_corrects_current_leaf(self):
        self._assert_fact_error("owner", "profile")
