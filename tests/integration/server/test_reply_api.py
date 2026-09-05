"""回复 API 的进程内契约测试（真实 ReplyService + fake 边界）。

钉住 POST /api/reply/generate 的 JSON 契约：两种输入形态、幂等键、
范围校验与失败关闭语义。真实 generator 与数据库由
test_postgres_reply_flow 与 reply 集成覆盖；这里验证 HTTP 壳层映射。
"""

from __future__ import annotations

import json
import unittest
from uuid import UUID, uuid4

from notalone.application.reply_service import ReplyService
from notalone.conversation.models import (
    ConversationBinding,
    ConversationBindingStatus,
    ConversationObservation,
    ConversationResolution,
    VerificationReason,
)
from notalone.reply.interface import (
    ContextReceipt,
    ReplyCandidate,
    ReplyGenerated,
)
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
BINDING_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
MESSAGE_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
REQUEST_KEY = UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")


class FakeConversationPort:
    def __init__(self, resolution: ConversationResolution) -> None:
        self.resolution = resolution

    def verify_current(self) -> ConversationResolution:
        return self.resolution


class FakeReplyPort:
    def __init__(self) -> None:
        self.calls = 0
        self.last_command = None

    def generate(self, command, verified_scope) -> ReplyGenerated:
        self.calls += 1
        self.last_command = command
        return ReplyGenerated(
            reply_request_id=uuid4(),
            candidates=(
                ReplyCandidate(
                    candidate_id=uuid4(),
                    text="合成候选回复",
                    basis="回应当前消息并保持自然",
                    citation_ids=(MESSAGE_ID,),
                    risk_notes=(),
                ),
            ),
            context_receipt=ContextReceipt(evidence_ids=(MESSAGE_ID,)),
            used_skill=None,
        )

    @property
    def call_count(self) -> int:
        return self.calls


def _build_service(*, binding_status=ConversationBindingStatus.ACTIVE, ready=True):
    binding = ConversationBinding(
        binding_id=BINDING_ID,
        scope=ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID),
        status=binding_status,
    )
    reply_port = FakeReplyPort()

    def make_conversation(_binding):
        resolution = (
            ConversationResolution.ready(
                VerifiedConversationScope(
                    owner_id=OWNER_ID,
                    contact_id=CONTACT_ID,
                    conversation_binding_id=BINDING_ID,
                )
            )
            if ready
            else ConversationResolution.rejected(
                VerificationReason.NO_ACTIVE_BINDING
            )
        )
        return FakeConversationPort(resolution)

    return (
        ReplyService(
            binding_lookup=lambda owner_id, contact_id: binding,
            conversation_factory=make_conversation,
            reply=reply_port,
        ),
        reply_port,
    )


class ReplyApiContractTest(unittest.TestCase):
    def test_runtime_limits_return_stable_errors(self):
        from notalone.reply.errors import ReplyTimeoutError, ReplyBudgetError

        for error, status, code in (
            (ReplyTimeoutError, 504, "reply_timeout"),
            (ReplyBudgetError, 502, "reply_budget_exceeded"),
        ):
            with self.subTest(code=code):
                def fail(*args, **kwargs):
                    raise error("合成内部异常，不应回显")

                self.reply_port.generate = fail
                response = self.client.request(
                    "POST", "/api/reply/generate", headers=self.headers,
                    body=self._reply_to_message_body().encode("utf-8"),
                )
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json(), {"error": code})

    def setUp(self) -> None:
        self.service, self.reply_port = _build_service()
        self.app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            reply_service=self.service,
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    # ------------------------------------------------------------------
    # 鉴权
    # ------------------------------------------------------------------

    def test_reply_requires_token(self) -> None:
        response = self.client.request("POST", "/api/reply/generate")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})

    # ------------------------------------------------------------------
    # 两种输入形态
    # ------------------------------------------------------------------

    def test_reply_to_message_shape(self) -> None:
        response = self.client.request(
            "POST",
            "/api/reply/generate",
            headers=self.headers,
            body=self._reply_to_message_body().encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("reply_request_id", payload)
        self.assertEqual(len(payload["candidates"]), 1)
        self.assertEqual(payload["candidates"][0]["text"], "合成候选回复")
        self.assertEqual(
            payload["candidates"][0]["citation_ids"],
            [str(MESSAGE_ID)],
        )
        # 命令携带请求里的幂等键（由 FakeReplyPort 记录）。
        self.assertIsNotNone(self.reply_port.last_command)
        self.assertEqual(
            self.reply_port.last_command.idempotency_key,
            REQUEST_KEY,
        )
        self.assertIsNone(payload["used_skill"])
        # 候选正文之外不回显请求方向文本之外的会话正文。
        self.assertEqual(
            payload["context_receipt"]["evidence_ids"],
            [str(MESSAGE_ID)],
        )

    def test_rewrite_draft_shape(self) -> None:
        response = self.client.request(
            "POST",
            "/api/reply/generate",
            headers=self.headers,
            body=self._rewrite_body().encode("utf-8"),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("reply_request_id", payload)
        self.assertEqual(len(payload["candidates"]), 1)

    # ------------------------------------------------------------------
    # 参数与幂等
    # ------------------------------------------------------------------

    def test_reply_rejects_invalid_request_body(self) -> None:
        for body in (
            b"not-json",
            b"[]",
            b"{}",
            '{"contact_id": "not-a-uuid", "content": {}}'.encode("utf-8"),
            ('{"contact_id": "' + str(CONTACT_ID) + '"}').encode("utf-8"),
            json.dumps(
                {
                    "contact_id": str(CONTACT_ID),
                    "content": {
                        "type": "reply_to_message",
                        "target_message_id": str(MESSAGE_ID),
                        "direction": "自然地答应",
                    },
                }
            ).encode("utf-8"),
        ):
            with self.subTest(body=body):
                response = self.client.request(
                    "POST",
                    "/api/reply/generate",
                    headers=self.headers,
                    body=body,
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json(), {"error": "reply_request_invalid"}
                )

    def test_reply_requires_post_method(self) -> None:
        response = self.client.get("/api/reply/generate", headers=self.headers)
        self.assertEqual(response.status_code, 404)

    def test_reply_passes_user_skill_version(self) -> None:
        from notalone.reply.interface import UserSkillChoice

        skill_version = uuid4()
        body = json.dumps(
            {
                "idempotency_key": str(REQUEST_KEY),
                "contact_id": str(CONTACT_ID),
                "content": {
                    "type": "rewrite_draft",
                    "draft_text": "帮我改写这句话",
                },
                "skill_version_id": str(skill_version),
            }
        ).encode("utf-8")

        response = self.client.request(
            "POST",
            "/api/reply/generate",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(self.reply_port.last_command)
        self.assertEqual(
            self.reply_port.last_command.skill,
            UserSkillChoice(version_id=skill_version),
        )

    def test_reply_rejects_invalid_skill_version(self) -> None:
        body = json.dumps(
            {
                "idempotency_key": str(REQUEST_KEY),
                "contact_id": str(CONTACT_ID),
                "content": {
                    "type": "rewrite_draft",
                    "draft_text": "帮我改写这句话",
                },
                "skill_version_id": "not-a-uuid",
            }
        ).encode("utf-8")

        response = self.client.request(
            "POST",
            "/api/reply/generate",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": "reply_request_invalid"})

    # ------------------------------------------------------------------
    # 范围校验失败关闭
    # ------------------------------------------------------------------

    def test_reply_rejected_when_conversation_unverified(self) -> None:
        service, reply_port = _build_service(ready=False)
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
            reply_service=service,
        )
        client = InProcessClient(app)

        response = client.request(
            "POST",
            "/api/reply/generate",
            headers={"Authorization": "Bearer test-token"},
            body=self._reply_to_message_body().encode("utf-8"),
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {"error": "reply_rejected", "reason": "no_active_binding"},
        )
        self.assertEqual(reply_port.call_count, 0)

    def test_reply_unavailable_without_service(self) -> None:
        app = create_app(
            database_url="postgresql:///notalone_test",
            owner_id=OWNER_ID,
            token="test-token",
        )
        client = InProcessClient(app)

        response = client.request(
            "POST",
            "/api/reply/generate",
            headers={"Authorization": "Bearer test-token"},
            body=self._reply_to_message_body().encode("utf-8"),
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "reply_unavailable"})

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------

    def _reply_to_message_body(self) -> str:
        return json.dumps(
            {
                "idempotency_key": str(REQUEST_KEY),
                "contact_id": str(CONTACT_ID),
                "conversation_binding_id": str(BINDING_ID),
                "content": {
                    "type": "reply_to_message",
                    "target_message_id": str(MESSAGE_ID),
                    "direction": "自然地答应，并保持轻松",
                    "direction_source": "direct_input",
                },
            }
        )

    def _rewrite_body(self) -> str:
        return json.dumps(
            {
                "idempotency_key": str(REQUEST_KEY),
                "contact_id": str(CONTACT_ID),
                "conversation_binding_id": str(BINDING_ID),
                "content": {
                    "type": "rewrite_draft",
                    "draft_text": "帮我改写这句话",
                    "user_instruction": "更口语一点",
                    "include_relationship_context": True,
                },
            }
        )


if __name__ == "__main__":
    unittest.main()
