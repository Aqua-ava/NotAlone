"""退役收藏接口后，正式生成仍正常且不携带样本输入。"""

from uuid import uuid4
import unittest

from tests.fidelity_http_support import FidelityHttpFixture


class StyleSampleRetirementHttpTest(FidelityHttpFixture, unittest.TestCase):
    production_model_wiring = True

    def test_retired_routes_are_unavailable_and_generation_uses_no_samples(self):
        contact, target, _ = self.prepare_contact(self.owner_id)
        collection = f"/api/contacts/{contact}/style-samples"
        item = f"{collection}/{uuid4()}"
        for method, path, body in (
            ("GET", collection, None),
            ("POST", collection, {"idempotency_key": str(uuid4()), "text": "不再保存的合成文字",
                                  "origin": {"kind": "manual"}}),
            ("GET", item, None),
            ("DELETE", item, None),
        ):
            with self.subTest(method=method, path=path):
                self.assertEqual(self.backend.request(path, body, method=method)[0], 404)

        self.reply_model.plans.append({"text": "这次不参加，谢谢邀请。", "basis": "保留本次拒绝的明确意图。"})
        command = {
            "contact_id": contact, "idempotency_key": str(uuid4()), "skill_disabled": True,
            "content": {"type": "reply_to_message", "target_message_id": target, "direction": "拒绝本次邀请"},
        }
        status, generated = self.backend.request("/api/reply/generate", command)
        self.assertEqual(status, 200, generated)
        self.assertNotIn("style_sample_ids", generated["context_receipt"])
        self.assertNotIn("style_references", self.reply_model.payloads[-1])
        self.assertEqual(self.backend.request("/api/reply/generate", command), (200, generated))
        status, evidence = self.backend.request(
            f"/api/contacts/{contact}/replies/{generated['reply_request_id']}/evidence",
        )
        self.assertEqual(status, 200, evidence)
        self.assertNotIn("style_references", evidence)
        self.assertEqual(len(self.reply_model.payloads), 1)
