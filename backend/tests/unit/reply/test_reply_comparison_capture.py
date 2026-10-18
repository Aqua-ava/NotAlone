"""双组评测只替换供应商 HTTP；预算、SDK 与证据写入使用真实实现。"""

import asyncio
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory.organization_quality import ReplyQualityContract, content_digest
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.reply.adapters.reply_comparison_capture import ReplyComparisonCapture
from notalone.experiments.reply_comparison import (
    InstalledReplyHttpAdapter, ReplyComparisonBlocked, build_manifest, run_reply_comparison,
)


class ReplyComparisonCaptureTest(unittest.TestCase):
    def test_public_controlled_constructor_accepts_explicit_deadline_without_connecting(self):
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.experiments.reply_comparison import controlled_layered_memory
        # 此纯回归只隔离已由PG用例验证的_test身份探测，保留真实服务/Adapter合同构造。
        with patch('notalone.persistence.layered_memory.PostgresLayeredMemoryStore.require_synthetic_database'), \
                patch('psycopg.connect', side_effect=AssertionError('纯构造回归不得连接数据库')), \
                patch.object(socket.socket, 'connect', side_effect=AssertionError('构造不得连接模型')):
            service = controlled_layered_memory('host=/not-used dbname=controlled_regression_test')
        self.assertIsInstance(service, LayeredMemoryService)

    def test_persisted_installation_accepts_skipped_large_entry_and_directory_only(self):
        from notalone.experiments.reply_comparison import validate_persisted_installation
        owner, contact, profile, scenario, version = [str(uuid4()) for _ in range(5)]
        small = {'text': '保留这一完整小条目。', 'references': []}
        large = {'text': '大' * 5000, 'references': []}
        frozen = {'scope': {'owner_id': owner, 'contact_id': contact}, 'settings_generation': 1,
            'organization_generation': 2, 'profile_version_id': profile, 'profile_entries': [large, small],
            'scenarios': [{'scenario_id': scenario, 'version_id': version, 'title': '合成主题',
                           'hint': '完整目录提示。', 'paragraphs': [{'text': '正文。', 'references': []}]}]}
        binding = {'expected_scopes': ['contact'], 'installed': {'contact': frozen}}
        for directory_only in (False, True):
            with self.subTest(directory_only=directory_only):
                if directory_only:
                    frozen['profile_entries'] = [large]
                context = {'schema_version': 3, 'scope_kind': 'contact', 'settings_generation': 1,
                    'organization_generation': 2, 'profile_version_id': None if directory_only else profile,
                    'profile_entries': [] if directory_only else [small],
                    'directory': [{'scenario_id': scenario, 'version_id': version, 'title': '合成主题',
                        'hint': '完整目录提示。', 'paragraph_count': 1, 'paragraph_range': [0, 1]}],
                    'read_policy': 'synthetic-scoped-layered-v3', 'scenario_read_budget': None,
                    'budget': {'profile_entries': 2, 'directory_entries': 1, 'characters': 1600}}
                evidence = {'layered_context': context, 'owner_layered_context': None,
                            'layered_scenario_reads': [], 'owner_layered_scenario_reads': []}
                actual = validate_persisted_installation(binding, evidence, 'layered')
                self.assertEqual(actual['contact']['context']['profile_entries'], [] if directory_only else [small])
                self.assertEqual(len(actual['contact']['context']['directory']), 1)

    def test_installed_http_header_stays_on_confirmed_assistant_scope(self):
        from notalone.server.app import Response
        from notalone.server.testing import InProcessClient
        seen = []

        class App:
            def handle(self, **request):
                seen.append(request)
                return Response(200, {}, b'{}')

        client = InProcessClient(App())
        contact, session = str(uuid4()), str(uuid4())
        prefix = f"/api/contacts/{contact}"
        paths = [prefix + "/assistant-sessions", prefix + f"/assistant-sessions/{session}/replies/prepare",
                 prefix + f"/assistant-sessions/{session}/replies", prefix + f"/replies/{uuid4()}/evidence"]
        for path in paths:
            InstalledReplyHttpAdapter.request_confirmed_contact(client, token="synthetic-token",
                contact_id=contact, method="GET" if path.endswith("/evidence") else "POST", path=path, body={})
        for request in seen[:3]:
            self.assertEqual(request["headers"]["X-NotAlone-Manual-Contact"], contact)
            self.assertEqual(request["headers"]["Authorization"], "Bearer synthetic-token")
        self.assertNotIn("X-NotAlone-Manual-Contact", seen[3]["headers"])
        with self.assertRaises(ReplyComparisonBlocked):
            InstalledReplyHttpAdapter.request_confirmed_contact(client, token="synthetic-token",
                contact_id=contact, method="POST", path=f"/api/contacts/{uuid4()}/assistant-sessions", body={})
        self.assertEqual(len(seen), 4)

    def test_per_arm_hard_stop_keeps_remaining_arm_without_replacement(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(os, "environ", {}):
            root = Path(directory)
            configuration = {"request_model": "deepseek-flash"}
            case = self.case()
            contract = ReplyQualityContract(model_version=content_digest(configuration))
            manifest = build_manifest(contract=contract,
                model_configuration=configuration, dataset_version="synthetic-v1", cases=[case])
            sent = []

            def respond(request):
                sent.append(request)
                return httpx.Response(200, json={"model": "deepseek-flash", "choices": []})

            with patch.object(Path, "home", return_value=root):
                capture = ReplyComparisonCapture(root / "output", manifest,
                    synthetic_transport=httpx.MockTransport(respond))

                def invoke(item, arm, request_key, recorder):
                    for _ in range(7):
                        recorder.http_client.post("https://api.deepseek.com/chat/completions",
                            json={"model": "deepseek-flash", "messages": []})
                    raise AssertionError("第七次不应进入供应商传输")

                bundle = run_reply_comparison(manifest=manifest, cases=[case], capture=capture, invoke_arm=invoke)
                from notalone.application.reply_qualification import ReplyComparisonSource
                report = ReplyComparisonSource(capture.path.parent).resolve(contract)
                self.assertEqual(report["stage"]["status"], "unknown")
                self.assertNotIn("reply_qualification_source_unavailable", report["stage"]["reasons"])
            self.assertEqual(len(sent), 6)
            self.assertEqual(bundle["budget_receipt"]["reserved_requests"], 6)
            self.assertEqual([row["status"] for row in bundle["arms"]], ["blocked", "not_run"])
            self.assertEqual(bundle["arms"][0]["error"]["kind"], "reply_comparison_per_arm_limit_exhausted")
            self.assertTrue(bundle["budget_receipt"]["closed"])

    def case(self):
        return {"case_id": "synthetic-pair", "scope_kind": "contact", "input_package": {
            "scope": {"owner_id": str(uuid4()), "contact_id": str(uuid4()), "confirmed": True,
                      "confirmation_receipt": {"kind": "synthetic"}}, "l1_version": "synthetic-l1-v1",
            "request": {"content": {"type": "rewrite_draft", "draft_text": "合成原句",
                                     "include_relationship_context": True}}},
            "organization_output_sha256": "a" * 64,
            "organization_review": {"reviewer_kind": "agent", "decision": "approved"}}

    def test_paired_sdk_calls_share_closed_budget_and_keep_failed_arm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configuration = {"model": "deepseek-flash", "temperature": 0.0, "max_retries": 0}
            contract = ReplyQualityContract(model_version=content_digest(configuration))
            case = {
                "case_id": "synthetic-pair", "scope_kind": "contact",
                "input_package": {
                    "scope": {"owner_id": str(uuid4()), "contact_id": str(uuid4()),
                              "confirmed": True, "confirmation_receipt": {"kind": "synthetic"}},
                    "l1_version": "synthetic-l1-v1",
                    "request": {"content": {"type": "rewrite_draft", "draft_text": "合成原句",
                                             "include_relationship_context": True}},
                },
                "organization_output_sha256": "a" * 64,
                "organization_review": {"reviewer_kind": "agent", "decision": "approved"},
            }
            manifest = build_manifest(contract=contract, model_configuration=configuration,
                                      dataset_version="synthetic-v1", cases=[case])
            requests = []

            def respond(request):
                requests.append(json.loads(request.content))
                if len(requests) == 2:
                    return httpx.Response(503, json={"error": {"message": "合成失败"}})
                return httpx.Response(200, json={
                    "id": "synthetic-completion", "object": "chat.completion", "created": 0,
                    "model": "deepseek-flash", "choices": [{"index": 0,
                        "message": {"role": "assistant", "content": "合成候选"}, "finish_reason": "stop"}],
                })

            with patch.object(Path, "home", return_value=root), patch.object(os, "environ", {}), \
                    patch.object(socket.socket, "connect", side_effect=AssertionError("禁止真实网络")):
                capture = ReplyComparisonCapture(root / "output", manifest,
                    synthetic_transport=httpx.MockTransport(respond))
                model = build_deepseek_model(api_key="synthetic-unused-key", max_retries=0,
                    model_name="deepseek-flash", base_url="https://api.deepseek.com",
                    extra_body={"thinking": {"type": "disabled"}},
                    http_client=capture.http_client, http_async_client=capture.http_async_client)

                def invoke(item, arm, request_key, recorder):
                    result = model.invoke("合成输入") if arm == "baseline" else asyncio.run(model.ainvoke("合成输入"))
                    return {"request_id": str(uuid4()), "output": {"text": result.content},
                            "evidence": {"l1_version": item["input_package"]["l1_version"]}}

                bundle = run_reply_comparison(manifest=manifest, cases=[case], capture=capture, invoke_arm=invoke)
            self.assertEqual([item["status"] for item in bundle["arms"]], ["succeeded", "failed"])
            self.assertEqual(len(requests), 2)
            self.assertEqual([item["sequence"] for item in bundle["calls"]], [1, 2])
            self.assertEqual([item["outcome"] for item in bundle["calls"]], ["succeeded", "failed"])
            self.assertEqual(bundle["calls"][1]["response"]["error"]["message"], "合成失败")
            self.assertEqual(bundle["budget_receipt"]["reserved_requests"], 2)
            self.assertTrue(bundle["budget_receipt"]["closed"])
            self.assertEqual(bundle["budget_receipt"]["config_sha256"], bundle["manifest_sha256"])
            self.assertEqual(bundle["arms"][0]["input_sha256"], bundle["arms"][1]["input_sha256"])
            self.assertEqual(bundle["arms"][0]["evidence"]["first_model_request"], requests[0])
            self.assertIsNone(bundle["arms"][1]["request_id"])
            self.assertEqual(capture.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(capture.path.read_text()), bundle)
