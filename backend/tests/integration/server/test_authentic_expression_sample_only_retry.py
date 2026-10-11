"""仅手工样本的实际模型输入在中断后复制，删除仍须清理未执行派生输入。"""

from __future__ import annotations

import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.test_assistant_retry_source_guard import CapturedPendingModel


class AuthenticExpressionSampleOnlyRetryTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.capture_rows = []

    @classmethod
    def tearDownClass(cls):
        try:
            if path := os.environ.get("NOTALONE_SAMPLE_ONLY_RETRY_CAPTURE"):
                Path(path).write_text(json.dumps({
                    "data_kind": "synthetic", "rows": cls.capture_rows,
                    "coverage": "实际样本模型输入→HTTP中断→仅准备新键复制→样本删除；不代表宿主退出",
                    "quality_verified": False, "human_fidelity_pass": 0,
                }, ensure_ascii=False, indent=2) + "\n")
        finally:
            super().tearDownClass()

    def test_manual_sample_only_interrupted_copy_is_erased_without_any_raw_sources(self):
        self._exercise(False)

    def test_manual_sample_only_interrupted_copy_erases_but_preserves_unrelated_completed_discussion(self):
        self._exercise(True)

    def _exercise(self, with_discussion: bool) -> None:
        self.reply_model = CapturedPendingModel()
        self.backend = self._backend(self.owner_id)
        contact, target, raw_source = self.prepare_contact(self.owner_id, history=False)
        self.assertIsNone(target)
        self.assertIsNone(raw_source)
        sources_path = f"/api/contacts/{contact}/sources"
        self.assertEqual(self._get(self.backend, sources_path)["sources"], [])
        session = self._post(f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        independent_turn = None
        if with_discussion:
            self.reply_model.plans.append({"text": "独立合成讨论的完整候选。", "basis": "仅来自独立合成草稿。"})
            original = self._post(path + "/replies", {
                "contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "rewrite_draft", "draft_text": "独立合成讨论：稍后再确认。"},
            })
            self.assertEqual(original["context_receipt"]["style_sample_ids"], [])
            independent_turn = self._get(self.backend, path)["turns"][0]

        samples_path = f"/api/contacts/{contact}/style-samples"
        sample = self._save_sample(samples_path, "仅供参考的合成手工表达：我先想一想。")
        self.assertEqual(sample["origin_kind"], "manual")
        self.assertEqual(sample["source_ids"], [])
        self.assertEqual(sample["sending_status"], "unknown")
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "content": {"type": "rewrite_draft", "draft_text": "没有原始聊天来源的合成当前草稿。",
                            "user_instruction": "只表达本次意愿", "include_relationship_context": True}}
        prepared = self._post(path + "/replies/prepare", body)
        self.reply_model.plans.append({"text": "合成迟到样本候选。", "basis": "只保留合成原稿。"})
        self.reply_model.entered.clear()
        self.reply_model.actual_payload = None
        release = self.reply_model.pause_next_response()
        capture = {"case_id": f"sample-only-interrupted-copy-{int(with_discussion)}",
                   "owner_id": str(self.owner_id), "contact_id": contact, "raw_source_ids": [],
                   "sample": sample, "prepared_receipt": prepared, "control_contract_completed": False}
        self.capture_rows.append(capture)
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/replies", body, timeout=20)
            try:
                self.assertTrue(self.reply_model.entered.wait(5), "生成必须实际进入原受控模型。")
                payload = self.reply_model.actual_payload
                self.assertIsNotNone(payload)
                self.assertEqual([item["sample_id"] for item in payload["style_references"]], [sample["sample_id"]])
                self.assertTrue(all(item["factual_role"] == "expression_reference"
                                    and item["weight"] == "low" for item in payload["style_references"]))
                self.assertFalse(any(item["kind"] == "message" for item in payload["evidence"]))
                stopped = self._post(path + "/interrupt", {
                    "request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"],
                })
                self.assertEqual(stopped["state"], "failed")
                self.assertEqual(stopped["interruption_reason"], "app_quit")
                restored = self._get(self.backend, path)
                interrupted = next(turn for turn in restored["turns"] if turn["turn_id"] == prepared["turn_id"])
                self.assertEqual(interrupted["state"], "failed")
                self.assertEqual(interrupted["input"]["content"]["draft_text"], body["content"]["draft_text"])
                capture.update(actual_model_payload=payload, interrupted_receipt=stopped,
                               interrupted_projection=restored)
            finally:
                release.set()
            late_status, late = running.result(timeout=10)
            self.assertNotEqual(late_status, 200, late)
            capture.update(late_status=late_status, late_result=late)

        actual_calls = 2 if with_discussion else 1
        self.assertEqual(len(self.reply_model.seen_calls), actual_calls)
        retry = {**body, "idempotency_key": str(uuid4()),
                 "expected_input_version_id": prepared["input_version_id"], "content": interrupted["input"]["content"]}
        self.assertEqual(self.other_backend.request(path + "/replies/prepare", retry)[0], 404)
        copy = self._post(path + "/replies/prepare", retry)
        self.assertEqual(copy["state"], "running")
        self.assertEqual(copy["request_key"], retry["idempotency_key"])
        self.assertNotEqual(copy["input_version_id"], prepared["input_version_id"])
        copy_projection = self._get(self.backend, path)
        copied_before_delete = next(turn for turn in copy_projection["turns"] if turn["turn_id"] == copy["turn_id"])
        self.assertEqual(copied_before_delete["state"], "running")
        self.assertEqual(copied_before_delete["input"]["content"], retry["content"])
        self.assertEqual(len(self.reply_model.seen_calls), actual_calls)
        independent_sample = self._save_sample(samples_path, "模型之后独立保存的合成手工表达。")

        deleted_status, deleted = self.backend.request(samples_path + "/" + sample["sample_id"], method="DELETE")
        self.assertEqual(deleted_status, 200, deleted)
        self.assertEqual(self.backend.request(samples_path + "/" + sample["sample_id"])[0], 410)
        recovered = self._get(self._backend(self.owner_id), path)
        copied = next(turn for turn in recovered["turns"] if turn["turn_id"] == copy["turn_id"])
        capture.update(copy_receipt=copy, retry_body=retry, deleted_projection=recovered,
                       actual_calls=actual_calls, prepare_model_delta=0, deletion_model_delta=0,
                       copied_turn_observed_state=copied["state"])
        original = next(turn for turn in recovered["turns"] if turn["turn_id"] == prepared["turn_id"])
        self.assertEqual(original["state"], "redacted")
        self.assertIsNone(original["input"])
        self.assertIsNone(original["reply"])
        self.assertEqual(len(self.reply_model.seen_calls), actual_calls)
        self.assertEqual(self._get(self.backend, sources_path)["sources"], [])
        self.assertEqual(self._get(self.backend, samples_path + "/" + independent_sample["sample_id"])["sample"], independent_sample)
        if independent_turn:
            self.assertEqual(next(turn for turn in recovered["turns"]
                                  if turn["turn_id"] == independent_turn["turn_id"]), independent_turn)

        self.assertEqual(copied["state"], "redacted", "实际模型使用的无raw样本须传递清理仅准备的复制输入。")
        self.assertIsNone(copied["input"])
        self.assertIsNone(copied["reply"])
        self.assertIsNone(recovered["current_input_version_id"])
        self.assertNotEqual(self.backend.request(path + "/replies/prepare", retry)[0], 200)
        self.assertNotEqual(self.backend.request(path + "/replies", retry)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), actual_calls)
        capture["control_contract_completed"] = True

    def _post(self, path: str, body: dict) -> dict:
        status, result = self.backend.request(path, body)
        self.assertEqual(status, 200, result)
        return result

    def _save_sample(self, path: str, text: str) -> dict:
        return self._post(path, {"idempotency_key": str(uuid4()), "text": text,
                                 "origin": {"kind": "manual"}})["sample"]


if __name__ == "__main__":
    unittest.main()
