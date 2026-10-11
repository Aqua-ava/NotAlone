"""表达样本与已准备续写中断的公开 HTTP 子组合；不模拟原生退出。"""

from __future__ import annotations

import json
import os
import time
import unittest
from pathlib import Path
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class AuthenticExpressionInterruptionTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.capture_rows = []

    @classmethod
    def tearDownClass(cls):
        try:
            if path := os.environ.get("NOTALONE_INTERRUPTION_FIDELITY_CAPTURE"):
                Path(path).write_text(json.dumps({
                    "data_kind": "synthetic", "rows": cls.capture_rows,
                    "coverage": "真实HTTP与隔离PG；prepare→interrupt→重读→删除，不代表宿主或原生退出",
                    "quality_verified": False, "human_fidelity_pass": 0,
                }, ensure_ascii=False, indent=2) + "\n")
        finally:
            super().tearDownClass()

    def test_interrupted_typed_input_and_candidate_sample_are_erased_with_style_reference(self):
        self._exercise("sample")

    def test_interrupted_typed_input_and_candidate_sample_are_erased_with_raw_source(self):
        self._exercise("source")

    def _exercise(self, removal: str) -> None:
        contact, target, source = self.prepare_contact(self.owner_id)
        samples_path = f"/api/contacts/{contact}/style-samples"
        original_sample = self._save_sample(samples_path, "合成旧表达：明晚七点陪你去合成海边。")
        sample_id = original_sample["sample_id"]
        session = self._post(self.backend, f"/api/contacts/{contact}/assistant-session/default", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        discussion = self._post(self.backend, path + "/inputs", {"content": {
            "type": "purpose_exploration", "purpose_hint": "与本次生成无关的合成讨论。", "skill_mode": "disabled",
        }})
        independent_discussion = next(item["content"] for item in self._get(self.backend, path)["inputs"]
                                      if item["input_version_id"] == discussion["input_version_id"])
        ordinary = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                    "expected_input_version_id": discussion["input_version_id"], "content": {
                        "type": "reply_to_message", "target_message_id": target,
                        "direction": "明确拒绝本次合成邀请，不增加约定。", "user_instruction": "不要承诺",
                    }}
        self.reply_model.plans.append({"text": "这次不参加。\n\n谢谢你邀请。",
                                       "messages": ["这次不参加。", "谢谢你邀请。"],
                                       "basis": "保留当前拒绝，不沿旧表达建立约定。"})
        generated = self._post(self.backend, path + "/replies", ordinary)
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual(generated["context_receipt"]["style_sample_ids"], [sample_id])
        captured = {"case_id": f"prepared-interruption-{removal}", "owner_id": str(self.owner_id),
                    "contact_id": contact, "payload": self.reply_model.payloads[0],
                    "model_inputs": self.reply_model.seen_model_payloads, "output": generated,
                    "call_count": 1, "control_contract_completed": False}
        self.capture_rows.append(captured)
        completed_reply = self._get(self.backend, path)["turns"][0]["reply"]
        candidate = generated["candidates"][0]
        versions_path = path + f"/candidates/{candidate['candidate_id']}/versions"
        original_versions = self._get(self.backend, versions_path)
        saved_candidate = self._save_sample(samples_path, candidate["text"], {
            "kind": "candidate", "id": candidate["candidate_id"],
        })
        self.assertIn(source, saved_candidate["source_ids"])
        self.assertEqual(saved_candidate["sending_status"], "unknown")
        frame = {"session_id": session["session_id"], "candidate_group_id": generated["reply_request_id"],
                 "candidates": [{"number": original_versions["candidate_number"],
                                  "candidate_id": candidate["candidate_id"],
                                  "version_id": original_versions["default_display_version_id"]}]}
        command = {"idempotency_key": str(uuid4()), "expected_input_version_id": generated["input_version_id"],
                   "instruction": "第一条自然一点", "displayed_group": frame}
        prepared = self._post(self.backend, path + "/continue/prepare", command)
        self.assertEqual(set(prepared), {"session_id", "turn_id", "request_key", "input_version_id", "state"})
        self.assertEqual(prepared["request_key"], command["idempotency_key"])
        self.assertEqual(prepared["session_id"], session["session_id"])
        self.assertEqual(prepared["state"], "running")
        # 在准备之后主动保存，与已经领取的生成没有依赖关系。
        independent_sample = self._save_sample(samples_path, "合成独立表达：今天先记到这里。")
        interruption = {"request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"]}
        self.assertEqual(self.other_backend.request(path + "/interrupt", interruption)[0], 404)
        stopped = self._post(self.backend, path + "/interrupt", interruption)
        self.assertEqual(stopped, {**prepared, "state": "failed", "interruption_reason": "app_quit"})
        self.assertEqual(len(self.reply_model.payloads), 1)

        rebuilt = self._backend(self.owner_id)
        restored = self._get(rebuilt, path)
        captured.update(prepared_receipt=prepared, interrupted_receipt=stopped, interrupted_projection=restored)
        self.assertEqual(restored["current_input_version_id"], prepared["input_version_id"])
        self.assertEqual(restored["turns"][0]["state"], "completed")
        self.assertEqual(restored["turns"][0]["reply"], completed_reply)
        pending = restored["turns"][1]
        self.assertEqual(pending["turn_id"], prepared["turn_id"])
        self.assertEqual(pending["input_version_id"], prepared["input_version_id"])
        self.assertEqual(pending["state"], "failed")
        self.assertEqual(pending["interruption_reason"], "app_quit")
        self.assertIsNone(pending["reply"])
        self.assertEqual(pending["input"]["content"]["draft_text"], "这次不参加。\n\n谢谢你邀请。")
        self.assertEqual(pending["input"]["content"]["user_instruction"], "不要承诺；自然一点")
        self.assertEqual(self._get(rebuilt, versions_path), original_versions)
        self.assertEqual(self._get(rebuilt, samples_path + "/" + saved_candidate["sample_id"])["sample"], saved_candidate)
        self.assertEqual(rebuilt.request(path + "/replies", ordinary), (200, generated))
        self.assertEqual(self._post(rebuilt, path + "/interrupt", interruption), stopped)
        for operation in ("continue", "continue/prepare"):
            self.assertNotEqual(rebuilt.request(path + "/" + operation, command)[0], 200)
            self.assertEqual(self.other_backend.request(path + "/" + operation, command)[0], 404)
        self.assertEqual(len(self.reply_model.payloads), 1)

        self._remove_reference(contact, source, sample_id, removal)
        recovered = self._get(self._backend(self.owner_id), path)
        self.assertEqual(len(recovered["turns"]), 2)
        self.assertTrue(all(turn["state"] == "redacted" and turn["input"] is None and turn["reply"] is None
                            for turn in recovered["turns"]))
        self.assertIsNone(recovered["current_input_version_id"])
        discussion_after = next(item for item in recovered["inputs"]
                                if item["input_version_id"] == discussion["input_version_id"])
        self.assertEqual(discussion_after["state"], "active")
        self.assertEqual(discussion_after["content"], independent_discussion)
        self.assertEqual(rebuilt.request(samples_path + "/" + saved_candidate["sample_id"])[0], 410)
        self.assertEqual(self._get(rebuilt, samples_path + "/" + independent_sample["sample_id"])["sample"], independent_sample)
        self.assertEqual(rebuilt.request(versions_path)[0], 404)
        self.assertNotEqual(rebuilt.request(path + "/replies", ordinary)[0], 200)
        self.assertNotEqual(rebuilt.request(
            f"/api/contacts/{contact}/replies/{generated['reply_request_id']}/evidence")[0], 200)
        self.assertNotEqual(rebuilt.request(path + "/interrupt", interruption)[0], 200)
        self.assertNotEqual(rebuilt.request(samples_path, {
            "idempotency_key": str(uuid4()), "text": candidate["text"],
            "origin": {"kind": "candidate", "id": candidate["candidate_id"]},
        })[0], 200)
        for operation in ("continue", "continue/prepare"):
            for body in (command, {**command, "idempotency_key": str(uuid4())}):
                self.assertNotEqual(rebuilt.request(path + "/" + operation, body)[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        captured.update(control_contract_completed=True, preparation_model_calls=0, recovery_model_calls=0,
                        deletion_model_calls=0, prepared_receipt=prepared, interrupted_receipt=stopped,
                        recovered_projection=recovered, independent_sample=independent_sample)

    def _save_sample(self, path: str, text: str, origin: dict | None = None) -> dict:
        return self._post(self.backend, path, {"idempotency_key": str(uuid4()), "text": text,
                                              "origin": origin or {"kind": "manual"}})["sample"]

    def _post(self, backend, path: str, body: dict) -> dict:
        status, result = backend.request(path, body)
        self.assertEqual(status, 200, result)
        return result

    def _remove_reference(self, contact: str, source: str, sample_id: str, removal: str) -> None:
        if removal == "sample":
            self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}", method="DELETE")[0], 200)
            state = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
                         if item["source_id"] == source)
            self.assertEqual(state["status"], "active")
            self.assertEqual(self.backend.request(f"/api/contacts/{contact}/style-samples/{sample_id}")[0], 410)
            return
        status, receipt = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
        self.assertEqual(status, 202, receipt)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
                         if item["source_id"] == source)
            self.assertNotEqual(state["task_status"], "failed", state)
            if state["status"] == "deleted" and state["task_status"] == "succeeded":
                break
            time.sleep(.02)
        else:
            self.fail("合成来源删除尚未完成。")
        self.assertEqual(self._get(self.backend, f"/api/contacts/{contact}/style-samples/{sample_id}")["sample"]["sample_id"], sample_id)


if __name__ == "__main__":
    unittest.main()
