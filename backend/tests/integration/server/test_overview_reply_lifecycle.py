"""07 导航与真实旧版本、来源删除、失败重试的公开生命周期。"""

import unittest
from concurrent.futures import ThreadPoolExecutor

from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OverviewReplyLifecycleHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    def test_corrected_manual_owner_history_keeps_its_actual_old_navigation_before_and_after_save(self):
        contact, _, _ = self.import_contact("合成关系原话：一起聊聊兴趣。")
        original = self.manual_owner("本人喜欢热茶。", category="preference")
        status, corrected = self.backend.request(
            f"/api/memories/owner/{original['memory_id']}/correct", {"text": "本人偏好安静的散步。"})
        self.assertEqual(status, 200, corrected)
        versions = self._get(self.backend, f"/api/memories/owner/{corrected['memory']['memory_id']}/versions")
        old_version = next(item for item in versions["versions"] if item["memory_id"] == original["memory_id"])
        self.assertEqual(old_version["revision"], 2)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "喜欢热茶，想聊热茶。")
        self.reply_model.plans.append({"text": "我之前喜欢热茶，想聊聊你现在的偏好。",
                                      "basis": "本人历史偏好需要重新核实。", "cite_kinds": ["owner_memory"]})
        status, turn = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, turn)
        evidence_path = self.evidence_path(contact, turn)
        evidence = self._get(self.backend, evidence_path)
        old = next(item for item in evidence["evidence"] if item["evidence_id"] == original["memory_id"])
        self.assertEqual(old["kind"], "owner_memory")
        self.assertEqual(old["text"], "本人喜欢热茶。")
        self.assertEqual(old["snapshot_status"], "invalidated")
        self.assertEqual(old_version["source_ids"], [str(self.owner_id)])
        self.assertEqual(old["navigation"]["scope_kind"], "owner")
        self.assertEqual(old["navigation"]["provenance_kind"], "manual_entry")
        self.assertEqual(old["navigation"]["memory_revision"], old_version["revision"])
        self.assertEqual(old["timing"]["current_status"], "historical")
        self.assertTrue(old["cited"])
        self.assertTrue(old["selection_reason"].startswith("历史资料，仅用于追溯；当前未核实，不得当作当前事实。"))
        self.assertEqual(self.backend.request(path + "/replies", body), (200, turn))
        restarted = self._backend(self.owner_id)
        self.assertEqual(self._get(restarted, evidence_path), evidence)
        self.assertEqual(restarted.request(path + "/replies", body), (200, turn))
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual(self.backend.request(f"/api/memories/owner/{corrected['memory']['memory_id']}/delete", {})[0], 200)
        self.assertEqual(self.backend.request(evidence_path)[0], 404)
        self.assertNotIn("本人喜欢热茶。", str(self._get(self.backend, path)))

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

    def test_old_legal_version_uses_its_actual_text_and_source_and_is_explicitly_historical(self):
        contact, source, message = self.import_contact("合成原话：对方喜欢热茶。")
        original = self.confirm(contact, "对方喜欢热茶。", message, category="preference")
        status, corrected = self.backend.request(
            f"/api/contacts/{contact}/memories/{original['memory_id']}/correct", {"text": "对方喜欢冰茶。"})
        self.assertEqual(status, 200, corrected)
        versions = self._get(self.backend, f"/api/contacts/{contact}/memories/{corrected['memory']['memory_id']}/versions")
        old_version = next(item for item in versions["versions"] if item["memory_id"] == original["memory_id"])
        self.assertEqual(old_version["revision"], 2)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({"text": "之前聊过热茶，现在再确认一下吧。", "basis": "历史资料需要重新核实。",
                                      "cite_kinds": ["confirmed_memory"]})
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(contact, "对方喜欢热茶，想聊热茶。"))
        self.assertEqual(status, 200, turn)
        evidence_path = self.evidence_path(contact, turn)
        original_evidence = self._get(self.backend, evidence_path)
        old = next(item for item in original_evidence["evidence"] if item["evidence_id"] == original["memory_id"])
        self.assertEqual(old["text"], "对方喜欢热茶。")
        self.assertEqual(old["snapshot_status"], "invalidated")
        self.assertEqual(old["navigation"]["memory_revision"], old_version["revision"])
        self.assertEqual(old["timing"]["current_status"], "historical")
        self.assertTrue(old["selection_reason"].startswith("历史资料，仅用于追溯；当前未核实，不得当作当前事实。"))
        self.assertNotIn("已确认且当前有效", old["selection_reason"])
        self.assertNotIn("basis_changes", original_evidence)
        self.assertEqual(self._get(self._backend(self.owner_id), evidence_path), original_evidence)
        self.delete_source(contact, source)
        self.assertEqual(self.backend.request(evidence_path)[0], 404)
        saved = self._get(self.backend, path)
        self.assertNotIn("对方喜欢热茶。", str(saved))
        self.assertNotIn(turn["reply_request_id"], str(saved))
