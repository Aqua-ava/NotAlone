"""旧模型配置的公开恢复，密钥与全部消息均为合成资料。"""

import asyncio
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.application.setup_service import SetupService
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.fidelity_http_support import FidelityHttpFixture
from tests.integration.server.core_business_flow_support import HttpBackend
from tests.integration.server import test_manual_input as manual


class LegacyModelRecoveryHttpTest(FidelityHttpFixture, unittest.TestCase):
    manual_request = manual.ManualInputHttpTest.manual_request
    create_contact = manual.ManualInputHttpTest.create_contact

    def setUp(self):
        environment = patch.dict(os.environ, {"NOTALONE_DEEPSEEK_API_KEY": "synthetic-legacy-key",
            "NOTALONE_DEEPSEEK_MODEL": "deepseek-chat", "NOTALONE_DEEPSEEK_BASE_URL": "https://api.deepseek.com",
            "NOTALONE_DISABLE_DOTENV": "1"})
        environment.start()
        self.addCleanup(environment.stop)
        self.model_calls = 0
        super().setUp()

    def _respond(self, request):
        self.model_calls += 1
        self.assertEqual(request.headers.get("authorization"), "Bearer synthetic-new-official-key")
        payload = json.loads(request.content)
        self.assertEqual(payload["model"], "deepseek-flash")
        current = next(json.loads(message["content"]) for message in payload["messages"] if message["role"] == "user")
        result = {"candidates": [{"text": "合成恢复已完成。", "basis": "只使用本次合成草稿。",
                                  "citation_ids": [current["evidence"][0]["evidence_id"]], "risk_notes": []}],
                  "used_skill_version_id": None}
        return httpx.Response(200, json={"id": "synthetic-recovery", "object": "chat.completion", "created": 1,
            "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "", "tool_calls": [{"id": "synthetic-call", "type": "function",
                "function": {"name": "ReplyRuntimeOutput", "arguments": json.dumps(result)}}]}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}})

    def _backend(self, owner_id):
        sync = httpx.Client(transport=httpx.MockTransport(self._respond))
        asynchronous = httpx.AsyncClient(transport=httpx.MockTransport(self._respond))
        self.addCleanup(sync.close)
        self.addCleanup(lambda: asyncio.run(asynchronous.aclose()))
        model = build_deepseek_model(http_client=sync, http_async_client=asynchronous)
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=model):
            reply = build_reply_service(database_url=self.database_url, owner_id=owner_id)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=owner_id,
            token=f"synthetic-legacy-{owner_id}", reply_service=reply,
            setup_service=SetupService(owner_directory=PostgresOwnerDirectory(self.database_url),
                env_path=Path(self.temporary.name) / "synthetic-runtime.env")), owner_id)
        self.addCleanup(backend.close)
        return backend

    def test_legacy_model_stays_blocked_until_explicit_official_route_and_new_key_are_confirmed(self):
        contact, _ = self.create_contact()
        self.manual_request(f"/api/contacts/{contact}/manual-confirmation", {})
        status, session = self.manual_request(f"/api/contacts/{contact}/assistant-session/default", {}, contact_id=contact)
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}/replies"
        body = {"contact_id": contact, "idempotency_key": str(uuid4()), "content": {"type": "rewrite_draft", "draft_text": "合成恢复已完成。"}}
        status, result = self.manual_request(path, body, contact_id=contact)
        self.assertEqual((status, result["error"]), (409, "input_budget_unavailable"))
        self.assertEqual(self.model_calls, 0)
        self.assertEqual(self.manual_request("/api/setup/official-deepseek", {"api_key": "synthetic-new-official-key"})[0], 400)
        status, saved = self.manual_request("/api/setup/official-deepseek", {
            "api_key": "synthetic-new-official-key", "confirm_official_defaults": True})
        self.assertEqual(status, 200, saved)
        self.assertNotIn("synthetic-new-official-key", json.dumps(saved))
        self.assertEqual(self.manual_request("/api/setup/status")[1]["official_deepseek_defaults"], True)
        reopened = self._backend(self.owner_id)
        body["idempotency_key"] = str(uuid4())
        status, generated = self.manual_request(path, body, contact_id=contact, backend=reopened)
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["candidates"][0]["text"], "合成恢复已完成。")
        self.assertEqual(self.model_calls, 1)
