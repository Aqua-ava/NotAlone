"""07 导航与真实旧版本、来源删除、失败重试的公开生命周期。"""

import unittest
from concurrent.futures import ThreadPoolExecutor

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OverviewReplyLifecycleHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    def test_retired_manual_owner_history_is_visible_but_not_used_for_generation(self):
        contact, _, _ = self.import_contact("合成关系原话：一起聊聊兴趣。")
        original = self.manual_owner("本人喜欢热茶。", category="preference")
        status, corrected = self.backend.request(
            f"/api/memories/owner/{original['memory_id']}/correct", {"text": "本人偏好安静的散步。", "change_kind": "state_changed"})
        self.assertEqual(status, 200, corrected)
        versions = self._get(self.backend, f"/api/memories/owner/{corrected['memory']['memory_id']}/versions")
        old_version = next(item for item in versions["versions"] if item["memory_id"] == original["memory_id"])
        self.assertEqual(old_version["revision"], 2)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "喜欢热茶，想聊热茶。")
        self.reply_model.plans.append({"text": "聊聊现在的偏好吧。", "basis": "按本次草稿生成。"})
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        evidence_path = self.evidence_path(contact, turn)
        evidence = self._get(self.backend, evidence_path)
        self.assertNotIn(original["memory_id"], [item["evidence_id"] for item in evidence["evidence"]])
        self.assertEqual(old_version["text"], "本人喜欢热茶。")
        self.assertEqual(old_version["status"], "invalidated")
        self.assertEqual(self.backend.request(path + "/replies", body), (200, turn))
        restarted = self._backend(self.owner_id)
        self.assertEqual(self._get(restarted, evidence_path), evidence)
        self.assertEqual(restarted.request(path + "/replies", body), (200, turn))
        self.assertEqual(len(self.reply_model.payloads), 1)

    def test_overview_changes_while_model_runs_reject_the_candidate_and_same_key_retry_rebuilds_navigation(self):
        contact, _, message = self.import_contact("合成原话：对方喜欢热茶。")
        original = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "喜欢热茶，想聊热茶。")
        self.reply_model.plans.append({"text": "一起聊热茶吧。", "basis": "按本次草稿生成。"})
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.backend.request, path + "/replies", body)
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                status, corrected = self.backend.request(f"/api/contacts/{contact}/memories/{original['memory_id']}/correct",
                                                        {"text": "对方喜欢温茶。"})
                self.assertEqual(status, 200, corrected)
                gate.set()
                status, rejected = pending.result(timeout=10)
            finally:
                gate.set()
        self.assertNotEqual(status, 200, rejected)
        failed = self._get(self.backend, path)["turns"][0]
        self.assertEqual(failed["state"], "failed")
        self.assertIsNone(failed["reply"])
        current = self.overview(contact)
        self.reply_model.plans.append({"text": "想了解现在的茶饮偏好。", "basis": "重新核验当前资料。"})
        status, completed = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, completed)
        self.assertEqual(completed["turn_id"], failed["turn_id"])
        evidence = self._get(self.backend, self.evidence_path(contact, completed))
        self.assertEqual(evidence["retrieval"]["overview_revisions"]["contact"]["projection_revision"], current["projection_revision"])
        self.assertEqual(self.backend.request(path + "/replies", body), (200, completed))
        self.assertEqual(len(self.reply_model.payloads), 2)

    def test_retired_contact_version_is_visible_but_excluded_from_reply_evidence(self):
        contact, source, message = self.import_contact("合成原话：对方喜欢热茶。")
        original = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        status, corrected = self.backend.request(
            f"/api/contacts/{contact}/memories/{original['memory_id']}/correct", {"text": "对方喜欢冰茶。", "change_kind": "state_changed"})
        self.assertEqual(status, 200, corrected)
        versions = self._get(self.backend, f"/api/contacts/{contact}/memories/{corrected['memory']['memory_id']}/versions")
        old_version = next(item for item in versions["versions"] if item["memory_id"] == original["memory_id"])
        self.assertEqual(old_version["revision"], 2)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "想聊聊现在的偏好。", "basis": "按本次草稿生成。"})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "对方喜欢热茶，想聊热茶。"))
        self.assertEqual(status, 200, turn)
        evidence_path = self.evidence_path(contact, turn)
        evidence = self._get(self.backend, evidence_path)
        self.assertNotIn(original["memory_id"], [item["evidence_id"] for item in evidence["evidence"]])
        self.assertEqual(old_version["text"], "对方喜欢热茶。")
        self.assertEqual(old_version["status"], "invalidated")
        self.assertEqual(self._get(self._backend(self.owner_id), evidence_path), evidence)
