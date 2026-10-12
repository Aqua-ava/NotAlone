"""供应商容量错误经公开 HTTP；只在外部模型边界构造真实 SDK 错误。"""

from __future__ import annotations

import json
import unittest
from uuid import uuid4

import httpx
from openai import BadRequestError

from tests.fidelity_http_support import FidelityControlledModel, FidelityHttpFixture
from tests.integration.server import test_ecnu_input_budget as ecnu_fixture


class ProviderErrorModel(FidelityControlledModel):
    """合成协议保留实际业务与框架，SDK 错误不访问外部供应商。"""

    error_body: dict | None = None

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.error_body is not None:
            self.seen_calls.append(messages)
            response = httpx.Response(400, request=httpx.Request(
                "POST", "https://synthetic.provider.invalid/chat/completions",
                headers={"Authorization": "Bearer synthetic-secret-must-not-leak"},
            ))
            raise BadRequestError(
                "synthetic-private-sdk-body-must-not-leak",
                response=response, body=self.error_body,
            )
        return super()._generate(messages, stop, run_manager, **kwargs)


class ProviderContextLimitHttpTest(FidelityHttpFixture, unittest.TestCase):
    """新用例沿用已确认 HTTP→隔离 PG→外部模型接缝。"""

    reply_model_factory = ProviderErrorModel

    def _session(self) -> tuple[str, str]:
        contact_id, _, _ = self.prepare_contact(self.owner_id, history=False)
        status, session = self.backend.request(
            f"/api/contacts/{contact_id}/assistant-session/default", {},
        )
        self.assertEqual(status, 200, session)
        return contact_id, f"/api/contacts/{contact_id}/assistant-sessions/{session['session_id']}"

    @staticmethod
    def _body(contact_id: str, draft: str) -> dict:
        return {"contact_id": contact_id, "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": draft}}

    def test_provider_context_limit_is_explicit_and_keeps_saved_history(self):
        contact_id, path = self._session()
        first_text = "合成已保存候选，之后仍可回看。"
        self.reply_model.plans = [{"text": first_text, "basis": "保留合成原句。"}]
        status, first = self.backend.request(
            path + "/replies", self._body(contact_id, first_text),
        )
        self.assertEqual(status, 200, first)
        discussion = "合成已保存讨论，不得因供应商超长而裁剪。"
        status, recorded = self.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": discussion},
            "expected_input_version_id": first["input_version_id"],
        })
        self.assertEqual(status, 200, recorded)
        self.reply_model.error_body = {
            "code": "context_length_exceeded", "type": "invalid_request_error",
            "message": "synthetic-private-response-must-not-leak",
        }
        before = len(self.reply_model.seen_calls)

        status, rejected = self.backend.request(path + "/replies", {
            **self._body(contact_id, "合成新的短请求。"),
            "expected_input_version_id": recorded["input_version_id"],
        })

        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected, {
            "error": "provider_context_limit",
            "message": "模型提示这次内容过长，请新开助手会话。",
        })
        self.assertEqual(len(self.reply_model.seen_calls) - before, 1)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["reply"]["candidates"][0]["text"], first_text)
        self.assertEqual(saved["turns"][1]["state"], "failed")
        self.assertEqual(saved["inputs"][1]["content"]["purpose_hint"], discussion)

    def test_unknown_provider_code_does_not_guess_from_error_message(self):
        contact_id, path = self._session()
        self.reply_model.error_body = {
            "code": "unknown_provider_error", "type": "invalid_request_error",
            "message": "context_length_exceeded 内容过长，请新开 synthetic-private-response",
        }

        status, rejected = self.backend.request(
            path + "/replies", self._body(contact_id, "合成短请求。"),
        )

        self.assertEqual((status, rejected), (500, {"error": "internal_error"}))
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_exploration_context_limit_keeps_discussion_without_extra_generation(self):
        _, path = self._session()
        discussion = "合成之前的讨论必须继续可读。"
        status, recorded = self.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": discussion},
        })
        self.assertEqual(status, 200, recorded)
        self.reply_model.error_body = {"code": "context_length_exceeded"}

        status, rejected = self.backend.request(path + "/explorations", {
            "operation_key": str(uuid4()),
            "expected_input_version_id": recorded["input_version_id"],
            "content": {"type": "purpose_exploration", "purpose_hint": "合成当前讨论。"},
        })

        self.assertEqual((status, rejected), (409, {
            "error": "provider_context_limit",
            "message": "模型提示这次内容过长，请新开助手会话。",
        }))
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        status, saved = self.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["inputs"][0]["content"]["purpose_hint"], discussion)
        self.assertEqual(saved["turns"], [])


class EcnuSdkContextLimitHttpTest(FidelityHttpFixture, unittest.TestCase):
    """真实 ChatDeepSeek/SDK 收到离线合成 400；不代表 ECNU 实际错误契约。"""

    def _backend(self, owner_id):
        return ecnu_fixture.EcnuInputBudgetHttpTest._backend(self, owner_id)

    def _respond(self, request: httpx.Request) -> httpx.Response:
        self.sdk_payloads.append(json.loads(request.content))
        return httpx.Response(400, json={"error": {
            "code": "context_length_exceeded", "type": "invalid_request_error",
            "message": "synthetic-private-sdk-body-must-not-leak",
        }})

    def test_offline_sdk_context_error_is_public_without_counter_forgery(self):
        contact_id, _, _ = self.prepare_contact(self.owner_id, history=False)
        prefix = f"/api/contacts/{contact_id}"
        status, session = self.backend.request(prefix + "/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        path = prefix + f"/assistant-sessions/{session['session_id']}"

        status, rejected = self.backend.request(path + "/replies", {
            "contact_id": contact_id, "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "合成短请求。"},
        })

        self.assertEqual((status, rejected), (409, {
            "error": "provider_context_limit",
            "message": "模型提示这次内容过长，请新开助手会话。",
        }))
        self.assertEqual(len(self.sdk_payloads), 1)
        status, history = self.backend.request(path)
        self.assertEqual(status, 200, history)
        self.assertEqual(history["turns"][0]["state"], "failed")
        self.assertEqual(history["turns"][0]["input"]["content"]["draft_text"], "合成短请求。")


if __name__ == "__main__":
    unittest.main()
