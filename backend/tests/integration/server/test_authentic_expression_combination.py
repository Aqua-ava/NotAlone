"""真实表达组合沿正式助手HTTP与隔离PG验证；不替代未交付A/B路径。"""

from __future__ import annotations

import time
import unittest
from uuid import uuid4

import psycopg

from tests.fidelity_http_support import FidelityHttpFixture


class AuthenticExpressionCombinationTests(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    def test_sample_source_delete_blocks_reassembly_replay_and_continuation_but_keeps_discussion(self):
        self._exercise_deleted_reference("source")

    def test_sample_delete_blocks_reassembly_replay_and_continuation_but_keeps_original_source(self):
        self._exercise_deleted_reference("sample")

    def _exercise_deleted_reference(self, removal: str):
        contact, _, source = self.prepare_contact(self.owner_id)
        with psycopg.connect(self.database_url) as connection:
            message_id = connection.execute(
                "SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s ORDER BY occurred_at LIMIT 1",
                (self.owner_id, contact),
            ).fetchone()[0]
            connection.execute("UPDATE public.message SET speaker='user' WHERE owner_id=%s AND contact_id=%s AND id=%s",
                               (self.owner_id, contact, message_id))
        status, sample = self.backend.request(f"/api/contacts/{contact}/style-samples", {
            "idempotency_key": str(uuid4()), "text": "合成旧说法只提供表达参考。",
            "origin": {"kind": "message", "id": str(message_id)},
        })
        self.assertEqual(status, 200, sample)
        status, saved = self.backend.request(f"/api/contacts/{contact}/assistant-session/default", {})
        self.assertEqual(status, 200, saved)
        path = f"/api/contacts/{contact}/assistant-sessions/{saved['session_id']}"
        status, discussion = self.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "无关合成讨论仍需保留。", "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200, discussion)
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
                "expected_input_version_id": discussion["input_version_id"],
                "content": {"type": "initiate_conversation", "purpose": "本次拒绝聚会，不增加安排。"}}
        self.reply_model.plans.append({"text": "这次我不参加。", "basis": "保留本次明确拒绝，不扩写样本里的内容。"})
        status, generated = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["context_receipt"]["style_sample_ids"], [sample["sample"]["sample_id"]])
        reopened = self._backend(self.owner_id)
        before = self._get(reopened, path)
        self.assertEqual(before["turns"][0]["reply"]["context_receipt"]["style_sample_ids"], generated["context_receipt"]["style_sample_ids"])
        self.assertEqual(reopened.request(path + "/replies", body), (200, generated))
        self.assertEqual(len(self.reply_model.payloads), 1)

        if removal == "sample":
            status, deleted = self.backend.request(f"/api/contacts/{contact}/style-samples/{sample['sample']['sample_id']}", method="DELETE")
            self.assertEqual(status, 200, deleted)
            source_state = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
                                if item["source_id"] == source)
            self.assertEqual(source_state["status"], "active")
        else:
            status, deleted = self.backend.request(f"/api/contacts/{contact}/sources/{source}", method="DELETE")
            self.assertEqual(status, 202, deleted)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                item = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/sources")["sources"]
                            if item["source_id"] == source)
                self.assertNotEqual(item["task_status"], "failed", item)
                if item["status"] == "deleted" and item["task_status"] == "succeeded":
                    break
                time.sleep(.02)
            else:
                self.fail("本轮合成来源删除没有完成。")

        after_backend = self._backend(self.owner_id)
        after = self._get(after_backend, path)
        self.assertEqual(after["turns"][0]["state"], "redacted")
        self.assertIsNone(after["turns"][0]["input"])
        self.assertIsNone(after["turns"][0]["reply"])
        inputs = {item["input_version_id"]: item for item in after["inputs"]}
        self.assertEqual(inputs[discussion["input_version_id"]]["state"], "active")
        self.assertEqual(inputs[discussion["input_version_id"]]["content"]["purpose_hint"], "无关合成讨论仍需保留。")
        self.assertEqual(inputs[generated["input_version_id"]]["state"], "redacted")
        self.assertIsNone(inputs[generated["input_version_id"]]["content"])
        self.assertEqual(after_backend.request(f"/api/contacts/{contact}/style-samples/{sample['sample']['sample_id']}")[0], 410)
        self.assertNotEqual(after_backend.request(path + "/replies", body)[0], 200)
        self.assertNotEqual(after_backend.request(path + "/replies", {
            **body, "idempotency_key": str(uuid4()),
            "continued_from_candidate_id": generated["candidates"][0]["candidate_id"],
            "expected_input_version_id": after["current_input_version_id"],
        })[0], 200)
        self.assertNotEqual(after_backend.request(f"/api/contacts/{contact}/replies/{generated['reply_request_id']}/evidence")[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)


if __name__ == "__main__":
    unittest.main()
