"""三种当前意图共享正式 HTTP 生成链；不评判受控模型语义。"""

from __future__ import annotations

import unittest
import json
import os
from pathlib import Path
import time
from uuid import uuid4

from tests.fidelity_http_support import FidelityHttpFixture


class FidelityIntentApiTests(FidelityHttpFixture, unittest.TestCase):
    def test_purpose_contract_scope_and_persistent_replay(self):
        contact, _, _ = self.prepare_contact(self.owner_id, history=False)
        body = {
            "contact_id": contact, "idempotency_key": str(uuid4()),
            "content": {"type": "initiate_conversation", "purpose": "只问近况，不承诺见面。"},
            "skill_disabled": True,
        }
        self.reply_model.plans.append({
            "text": "最近怎么样？", "basis": "按本次明确目的关心近况，不增加见面安排。",
        })
        started = time.perf_counter()
        status, result = self.backend.request("/api/reply/generate", body)
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.assertEqual(status, 200, result)
        payload = self.reply_model.payloads[-1]
        self.assertEqual(payload["fidelity_contract"]["current_intent"], {
            "source": "confirmed_purpose", "text": "只问近况，不承诺见面。",
        })
        self.assertEqual(payload["skill_selection"], {"mode": "disabled"})
        self.assertNotIn("current_text", payload)
        self.assertNotIn("target_message_id", payload)
        self.assertEqual([item["kind"] for item in payload["evidence"]], ["user_purpose"])
        reopened = self._backend(self.owner_id)
        self.assertEqual(reopened.request("/api/reply/generate", body), (200, result))
        evidence_path = f"/api/contacts/{contact}/replies/{result['reply_request_id']}/evidence"
        self.assertEqual(reopened.request(evidence_path)[0], 200)
        self.assertNotEqual(self.other_backend.request("/api/reply/generate", {
            **body, "idempotency_key": str(uuid4()),
        })[0], 200)
        self.assertEqual(len(self.reply_model.payloads), 1)
        if path := os.environ.get("NOTALONE_INTENT_CAPTURE"):
            system = "\n".join(str(message.content) for message in self.reply_model.seen_calls[-1]
                               if message.type == "system")
            Path(path).write_text(json.dumps({
                "data_kind": "synthetic", "data_version": "intent-purpose-http-v1", "entry_point": "http",
                "rows": [{"case_id": "purpose-preserve", "owner_id": str(self.owner_id),
                          "contact_id": contact, "payload": payload, "system_prompt": system,
                          "output": result, "latency_ms": elapsed_ms, "call_count": 1}],
            }, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    unittest.main()
