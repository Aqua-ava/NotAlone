"""反馈通过同范围安全投影核对原目标与当前合法底层版本。"""

import unittest
from uuid import uuid4

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_layered_correction_matrix as matrix_support


class LayeredCorrectionFeedbackHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    _prepare_scope = matrix_support.LayeredCorrectionMatrixHttpTest._prepare_scope
    _target_command = matrix_support.LayeredCorrectionMatrixHttpTest._target_command

    def _feedback_targets_and_actual_basis_are_reviewable(self, scope_kind):
        backend, path, memories, ready, primary, unrelated = self._prepare_scope(scope_kind)
        for memory in (primary, unrelated):
            current = self._get(backend, path)["layered_memory"]
            command = {**self._target_command(current, "scenario", memory["memory_id"]),
                "reason": "该合成主题总结含义有误。", "operation_id": str(uuid4())}
            self.assertEqual(backend.request(path + "/summary-error", command)[0], 200)
        current = self._get(backend, path)["layered_memory"]
        self.assertEqual(current["scope_kind"], scope_kind)
        feedback = current["feedback"]
        self.assertEqual({item.get("target_text") for item in feedback}, {primary["text"], unrelated["text"]},
            "同为第1项的多个反馈仍须能核对各自原整理内容")
        expected = {primary["memory_id"]: primary["revision"], unrelated["memory_id"]: unrelated["revision"]}
        for item in feedback:
            self.assertEqual({basis["memory_id"]: basis["revision"] for basis in item["basis"]}, expected)
            self.assertTrue(all(set(basis) == {"memory_id", "revision"} for basis in item["basis"]),
                "核对入口不得复制内部依赖、联系人来历或原话")
        return backend, path, memories, primary, unrelated

    def test_contact_can_distinguish_feedback_targets_and_review_actual_protected_versions(self):
        self._feedback_targets_and_actual_basis_are_reviewable("contact")

    def test_owner_can_distinguish_feedback_without_contact_origin_projection(self):
        self._feedback_targets_and_actual_basis_are_reviewable("owner")

    def _guard_keeps_only_legal_current_identity_without_rehydrating_text(self, scope_kind):
        backend, path, memories, primary, unrelated = self._feedback_targets_and_actual_basis_are_reviewable(scope_kind)
        status, result = self.backend.request(f"{memories}/{primary['memory_id']}/correct", {
            "revision": primary["revision"], "text": "同一手录链的合法当前合成版本。", "category": "common_fact"})
        self.assertEqual(status, 200, result)
        leaf = result["memory"]
        guarded = self._get(backend, path)["layered_memory"]
        for feedback in guarded["feedback"]:
            self.assertEqual(feedback["state"], "erased_guard")
            self.assertIsNone(feedback["target_text"])
            self.assertIsNone(feedback["reason"])
            self.assertEqual({item["memory_id"] for item in feedback["basis"]}, {leaf["memory_id"], unrelated["memory_id"]})
            self.assertNotIn("text", str(feedback["basis"]))
        self.assertEqual(self.backend.request(f"{memories}/{leaf['memory_id']}/delete", {})[0], 200)
        guarded = self._get(backend, path)["layered_memory"]
        for feedback in guarded["feedback"]:
            self.assertEqual(feedback["basis"], [{"memory_id": unrelated["memory_id"], "revision": unrelated["revision"]}])
        self.assertEqual(self.backend.request(f"{memories}/{unrelated['memory_id']}/delete", {})[0], 200)
        self.assertEqual(self._get(backend, path)["layered_memory"]["feedback"], [])

    def test_contact_guard_exposes_only_current_legal_identity_and_clears_after_last_leaf(self):
        self._guard_keeps_only_legal_current_identity_without_rehydrating_text("contact")

    def test_owner_guard_exposes_only_current_legal_identity_and_clears_after_last_leaf(self):
        self._guard_keeps_only_legal_current_identity_without_rehydrating_text("owner")
