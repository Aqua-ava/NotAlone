"""公开 HTTP 区分纠正错误与记录变化，旧调用默认纠错。"""

import unittest

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class MemoryRetirementHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_explicit_state_change_preserves_reason_in_contact_and_owner_history(self):
        contact_id, _, _ = self.import_contact("合成联系人讨论饮食偏好。")
        for level in ("contact", "owner"):
            with self.subTest(level=level):
                path = "/api/memories/manual-" + level
                entry = {"text": "以前喜欢热茶。", "category": "preference"}
                if level == "contact":
                    entry["contact_id"] = contact_id
                status, original = self.backend.request(path, entry)
                self.assertEqual(status, 200, original)
                memory_id = original["memory"]["memory_id"]
                prefix = (f"/api/contacts/{contact_id}/memories/" if level == "contact"
                          else "/api/memories/owner/")
                status, updated = self.backend.request(prefix + memory_id + "/correct", {
                    "text": "现在改喝温水。", "change_kind": "state_changed",
                })
                self.assertEqual(status, 200, updated)
                history = self._get(self.backend, prefix + updated["memory"]["memory_id"] + "/versions")
                previous = next(row for row in history["versions"] if row["memory_id"] == memory_id)
                self.assertEqual(previous["retirement_reason"], "state_changed")
                self.assertIsNotNone(previous["retired_at"])
                self.assertIsNone(previous["invalid_at"], "修改记录时间不能伪造事实变化时间")

    def test_unknown_change_kind_is_rejected_without_retiring_original(self):
        status, original = self.backend.request("/api/memories/manual-owner", {
            "text": "合成本人偏好安静。", "category": "preference",
        })
        self.assertEqual(status, 200, original)
        prefix = "/api/memories/owner/" + original["memory"]["memory_id"]
        status, result = self.backend.request(prefix + "/correct", {
            "text": "合成本人偏好热闹。", "change_kind": "unknown",
        })
        self.assertEqual(status, 400, result)
        history = self._get(self.backend, prefix + "/versions")
        self.assertEqual(len(history["versions"]), 1)
        self.assertEqual(history["versions"][0]["status"], "active")

    def test_legacy_correction_defaults_to_error_correction(self):
        status, original = self.backend.request("/api/memories/manual-owner", {
            "text": "错误合成事实。", "category": "common_fact",
        })
        self.assertEqual(status, 200, original)
        prefix = "/api/memories/owner/"
        status, updated = self.backend.request(prefix + original["memory"]["memory_id"] + "/correct", {
            "text": "纠正后的合成事实。",
        })
        self.assertEqual(status, 200, updated)
        history = self._get(self.backend, prefix + updated["memory"]["memory_id"] + "/versions")
        previous = next(row for row in history["versions"] if row["memory_id"] == original["memory"]["memory_id"])
        self.assertEqual(previous["retirement_reason"], "error_correction")
