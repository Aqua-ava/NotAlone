"""回复冒烟接缝：真实SDK／运行时、纯Mock和临时持久预算。"""

import importlib.util
import importlib
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

import httpx

_CONNECT = socket.socket.connect
_GETADDRINFO = socket.getaddrinfo

SPEC = importlib.util.spec_from_file_location(
    "reply_model_smoke_backend", Path(__file__).with_name("reply-model-smoke-backend.py"),
)
smoke = importlib.util.module_from_spec(SPEC)
with patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"}):
    SPEC.loader.exec_module(smoke)


class SmokeBudgetTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.env = patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.home_patch = patch.object(Path, "home", return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        # Mock通过SDK真实序列化；任何意外DNS或网络构造立即失败。
        for target in ("socket.getaddrinfo", "socket.socket.connect", "socket.socket.connect_ex"):
            guard = patch(target, side_effect=AssertionError("禁止真实网络"))
            guard.start()
            self.addCleanup(guard.stop)
        self.output = self.home / "output"
        self.output.mkdir(mode=0o700)
        self.budget = smoke.EvaluationBudget.create(
            run_id=uuid4(), output_directory=self.output, request_limit=1,
            allowed_endpoints=(smoke.ENDPOINT,), config_sha256=smoke.configuration_sha256(),
        )

    def bundle(self, handler):
        bundle = smoke.SmokeModel(
            self.budget, "synthetic-not-a-key", synthetic_transport=httpx.MockTransport(handler),
        )
        self.addCleanup(bundle.close)
        return bundle

    def test_valid_async_sdk_uses_frozen_protocol_and_one_reservation(self):
        seen = []

        def handler(request):
            body = json.loads(request.content)
            seen.append(body)
            self.assertEqual(self.budget.snapshot()["reserved_requests"], 1)
            return smoke.mock_response(request)

        bundle = self.bundle(handler)
        with self.budget.batch():
            reply = smoke.offline_runtime_reply(bundle)
        self.assertEqual(len(reply.candidates), 1)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["reasoning_effort"], "none")
        self.assertEqual(seen[0]["tool_choice"], "required")
        self.assertEqual(seen[0]["max_tokens"], smoke.OUTPUT_RESERVE)
        self.assertEqual(bundle.model.max_retries, 0)
        self.assertTrue(self.budget.closed_receipt()["closed"])

    def test_503_is_not_retried_or_refunded(self):
        seen = []

        def handler(request):
            seen.append(1)
            return httpx.Response(503, request=request, json={"error": {"message": "合成失败"}})

        bundle = self.bundle(handler)
        with self.assertRaises(Exception), self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        self.assertEqual(seen, [1])
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 1)

    def test_timeout_is_not_retried_or_refunded(self):
        seen = []

        def handler(request):
            seen.append(1)
            raise httpx.ReadTimeout("合成超时", request=request)

        bundle = self.bundle(handler)
        with self.assertRaises(Exception), self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        self.assertEqual(seen, [1])
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 1)

    def test_business_tool_loop_second_request_is_never_transmitted(self):
        seen = []

        def handler(request):
            seen.append(1)
            return smoke.mock_response(request, tool_loop=True)

        bundle = self.bundle(handler)
        with self.assertRaises(BaseException), self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        self.assertEqual(seen, [1])
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 1)

    def test_wrong_response_model_fails_closed(self):
        bundle = self.bundle(lambda request: smoke.mock_response(request, model="wrong-model"))
        with self.assertRaises(BaseException), self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 1)

    def test_bad_structure_does_not_trigger_schema_retry(self):
        seen = []

        def handler(request):
            seen.append(1)
            return smoke.mock_response(request, invalid=True)

        bundle = self.bundle(handler)
        with self.assertRaises(BaseException), self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        self.assertEqual(seen, [1])

    def test_sync_and_async_share_the_same_hard_limit(self):
        seen = []
        bundle = self.bundle(lambda request: (seen.append(1), smoke.mock_response(request))[1])
        with self.budget.batch():
            smoke.offline_runtime_reply(bundle)
            request = httpx.Request("POST", smoke.ENDPOINT, json=bundle.audit.last_request)
            with self.assertRaises(smoke.EvaluationBudgetAbort):
                bundle.sync_transport.handle_request(request)
        self.assertEqual(seen, [1])
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 1)

    def test_configuration_change_is_rejected_before_send(self):
        bundle = self.bundle(lambda request: self.fail("不应发送"))
        self.assertTrue(bundle.counter.is_bound_to(bundle.model))
        bundle.model.model_name = "other"
        self.assertFalse(bundle.counter.is_bound_to(bundle.model))
        with self.assertRaises(BaseException), self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 0)

    def test_full_payload_and_tool_schema_are_guarded_with_explicit_estimate(self):
        bundle = self.bundle(smoke.mock_response)
        with self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        payload = json.loads(json.dumps(bundle.audit.last_request))
        smoke.require_payload(payload)
        profile = smoke.input_profile()
        self.assertEqual(profile.measurement_kind.value, "approximate")
        self.assertGreater(profile.safety_margin_tokens, 0)
        payload["messages"][0]["content"] += "合" * smoke.MAX_JSON_BYTES
        with self.assertRaises(ValueError):
            smoke.require_payload(payload)
        payload = json.loads(json.dumps(bundle.audit.last_request))
        payload["tools"][1]["function"]["description"] = "变更schema"
        with self.assertRaises(ValueError):
            smoke.require_payload(payload)

    def test_audit_write_failure_prevents_first_http(self):
        bundle = self.bundle(lambda request: self.fail("不应发送"))
        bundle.audit.path = self.home / "absent" / "audit.json"
        with self.assertRaises(BaseException), self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 0)

    def test_wire_bytes_limit_is_checked_before_a_second_reservation(self):
        bundle = self.bundle(smoke.mock_response)
        with self.budget.batch():
            smoke.offline_runtime_reply(bundle)
            # 合法JSON加空白在解析后相同，仍须受真实wire字节上限约束。
            raw = json.dumps(bundle.audit.last_request).encode() + b" " * smoke.MAX_JSON_BYTES
            with self.assertRaises(smoke.EvaluationBudgetAbort) as caught:
                bundle.sync_transport.handle_request(httpx.Request("POST", smoke.ENDPOINT, content=raw))
            self.assertEqual(str(caught.exception), "smoke_outbound_contract_invalid")
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 1)

    def test_prompt_drift_changes_freeze_and_rejects_old_outbound(self):
        bundle = self.bundle(smoke.mock_response)
        with self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        before = smoke.configuration_sha256()
        runtime = importlib.import_module("notalone.reply.adapters.langchain_runtime")
        with patch.object(runtime, "BASE_SYSTEM_PROMPT", runtime.BASE_SYSTEM_PROMPT + "合成漂移"):
            self.assertNotEqual(smoke.configuration_sha256(), before)
            with self.assertRaises(ValueError):
                smoke.require_payload(bundle.audit.last_request)

    def test_read_file_schema_drift_is_rejected(self):
        bundle = self.bundle(smoke.mock_response)
        with self.budget.batch():
            smoke.offline_runtime_reply(bundle)
        payload = json.loads(json.dumps(bundle.audit.last_request))
        read_file = next(item for item in payload["tools"] if item["function"]["name"] == "read_file")
        read_file["function"]["parameters"]["properties"]["file_path"]["description"] = "合成漂移"
        with self.assertRaises(ValueError):
            smoke.require_payload(payload)

    def test_system_text_blocks_are_joined_losslessly_and_other_blocks_rejected(self):
        from langchain_core.messages import SystemMessage
        bundle = self.bundle(lambda request: self.fail("序列化检查不应发送"))
        blocks = [{"type": "text", "text": "甲"}, {"type": "text", "text": "\n\n乙"}]
        body = bundle.model._get_request_payload([SystemMessage(content=blocks)])
        self.assertEqual(body["messages"][0]["content"], "甲\n\n乙")
        for invalid in ([{"type": "text", "text": "甲", "unknown": True}],
                        [{"type": "image_url", "image_url": {"url": "synthetic"}}], [],
                        [{"type": "text", "text": "单块"}], blocks + [{"type": "text", "text": "多块"}],
                        [{"type": "text", "text": "甲"}, {"type": "text", "text": "错误分隔"}]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                bundle.model._get_request_payload([SystemMessage(content=invalid)])

    def test_wire_payload_must_equal_the_complete_measured_payload(self):
        bundle = self.bundle(smoke.mock_response)
        with self.budget.batch():
            smoke.offline_runtime_reply(bundle)
            payload = json.loads(json.dumps(bundle.audit.last_request))
            payload["messages"][0]["content"] = next(text for text in smoke.expected_system_messages()
                                                      if text != payload["messages"][0]["content"])
            # 两个已冻结system变体仍须与本次实际计量的唯一正文一致。
            smoke.require_payload(payload)
            with self.assertRaises(smoke.EvaluationBudgetAbort) as caught:
                bundle.sync_transport.handle_request(httpx.Request("POST", smoke.ENDPOINT, json=payload))
            self.assertEqual(str(caught.exception), "smoke_outbound_contract_invalid")

    def test_budget_receipt_failure_still_closes_every_owned_resource(self):
        budget = Mock()
        budget.close.side_effect = smoke.EvaluationBudgetAbort("synthetic_close_failure")
        budget.closed_receipt.side_effect = smoke.EvaluationBudgetAbort("synthetic_receipt_failure")
        backend, bundle, remove_info = Mock(), Mock(), Mock()
        with self.assertRaises(RuntimeError):
            smoke.finalize_resources(budget, backend, bundle, remove_info, self.output)
        backend.close.assert_called_once()
        bundle.close.assert_called_once()
        remove_info.assert_called_once()
        result = json.loads((self.output / "reply-smoke-closed.json").read_text())
        self.assertIsNone(result["budget"])
        self.assertFalse(result["budget_close_confirmed"])
        self.assertTrue(result["cleanup_confirmed"])

    def test_cleanup_failure_keeps_original_exception(self):
        budget = Mock()
        budget.closed_receipt.return_value = {"closed": True}
        backend, bundle, remove_info = Mock(), Mock(), Mock()
        backend.close.side_effect = RuntimeError("合成收尾故障")
        original = ValueError("合成原始失败")
        smoke.finalize_resources(budget, backend, bundle, remove_info, self.output, original)
        bundle.close.assert_called_once()
        self.assertIn("smoke_cleanup_unconfirmed", original.__notes__)

    def test_wrong_endpoint_prevents_first_http_and_seals_budget(self):
        bundle = self.bundle(lambda request: self.fail("不应发送"))
        with self.assertRaises(smoke.EvaluationBudgetAbort), self.budget.batch():
            bundle.sync_transport.handle_request(httpx.Request("POST", "https://example.invalid/chat/completions", json={}))
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 0)

    def test_closed_budget_cannot_be_reopened(self):
        run_id = smoke.UUID(self.budget.snapshot()["run_id"])
        with self.budget.batch():
            pass
        with self.assertRaises(smoke.EvaluationBudgetAbort):
            smoke.EvaluationBudget.open(run_id=run_id)

    def test_authorization_metadata_validation_does_not_load_key(self):
        key = self.home / "synthetic-key"
        key.write_text("synthetic-not-a-real-key")
        key.chmod(0o600)
        asar = "a" * 64
        environment = {"NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE": "1",
                       "NOTALONE_REPLY_MODEL_SMOKE_AUTHORIZED_RUN_ID": str(uuid4()),
                       "NOTALONE_REPLY_MODEL_SMOKE_APP_ASAR_SHA256": asar,
                       "NOTALONE_REPLY_MODEL_SMOKE_CONFIG_SHA256": smoke.configuration_sha256(asar),
                       "NOTALONE_REPLY_MODEL_SMOKE_KEY_FILE": str(key)}
        original_read = Path.read_text

        def read_text(path, *args, **kwargs):
            if path == key:
                raise AssertionError("不能读key")
            return original_read(path, *args, **kwargs)

        with patch.object(Path, "read_text", read_text), \
                patch.object(smoke.EvaluationBudget, "create", side_effect=AssertionError("不能领预算")):
            smoke.require_live_configuration(environment)
            environment["NOTALONE_REPLY_MODEL_SMOKE_CONFIG_SHA256"] = "b" * 64
            with self.assertRaises(ValueError):
                smoke.require_live_configuration(environment)

    def test_explicit_project_env_loads_only_verified_official_provider(self):
        source = self.home / ".env"
        source.write_text(
            "NOTALONE_DATABASE_URL=synthetic-database-secret\n"
            "NOTALONE_DEEPSEEK_BASE_URL='https://api.deepseek.com'\n"
            "NOTALONE_DEEPSEEK_MODEL=deepseek-flash\n"
            "NOTALONE_DEEPSEEK_API_KEY='synthetic-not-a-real-key' # 本机合成凭据\n",
        )
        source.chmod(0o600)
        with patch.object(smoke, "PROJECT_ENV", source, create=True):
            asar = "a" * 64
            environment = {"NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE": "1",
                           "NOTALONE_REPLY_MODEL_SMOKE_AUTHORIZED_RUN_ID": str(uuid4()),
                           "NOTALONE_REPLY_MODEL_SMOKE_APP_ASAR_SHA256": asar,
                           "NOTALONE_REPLY_MODEL_SMOKE_CONFIG_SHA256": smoke.configuration_sha256(asar),
                           "NOTALONE_REPLY_MODEL_SMOKE_KEY_FILE": str(source)}
            smoke.require_live_configuration(environment)
            self.assertEqual(smoke.read_authorized_key(source), "synthetic-not-a-real-key")
        self.assertNotIn("NOTALONE_DATABASE_URL", os.environ)

    def test_project_provider_source_rejects_route_drift_and_ambiguous_credentials(self):
        source = self.home / ".env"
        valid = (
            "NOTALONE_DEEPSEEK_BASE_URL=https://api.deepseek.com\n"
            "NOTALONE_DEEPSEEK_MODEL=deepseek-flash\n"
            "NOTALONE_DEEPSEEK_API_KEY=synthetic-not-a-real-key\n"
        )
        invalid = (
            valid.replace("https://api.deepseek.com", "https://chat.ecnu.edu.cn/open/api/v1"),
            valid.replace("deepseek-flash", "other-model"),
            valid + "NOTALONE_DEEPSEEK_API_KEY=another-synthetic-key\n",
            valid.replace("synthetic-not-a-real-key", "${EXTERNAL_SECRET}"),
            valid.replace("NOTALONE_DEEPSEEK_MODEL=deepseek-flash\n", ""),
        )
        with patch.object(smoke, "PROJECT_ENV", source):
            for text in invalid:
                with self.subTest(source_case=invalid.index(text)):
                    source.write_text(text)
                    source.chmod(0o600)
                    with self.assertRaises(ValueError):
                        smoke.read_authorized_key(source)
            source.write_text(valid)
            source.chmod(0o644)
            with self.assertRaises(ValueError):
                smoke.read_authorized_key(source)
            source.chmod(0o600)
            target = self.home / "synthetic-provider-source"
            target.write_text(valid)
            target.chmod(0o600)
            source.unlink()
            source.symlink_to(target)
            with self.assertRaises(OSError):
                smoke.read_authorized_key(source)
            source.unlink()
            alias = self.home / ".env.other"
            alias.write_text(valid)
            alias.chmod(0o600)
            with patch.object(os, "open", side_effect=AssertionError("不能读取未指定的其他env来源")):
                with self.assertRaises(ValueError):
                    smoke.read_authorized_key(alias)

    def test_missing_opt_in_never_reads_a_key_or_creates_a_live_budget(self):
        with patch.object(Path, "read_text", side_effect=AssertionError("不能读文件")), \
                patch.object(smoke.EvaluationBudget, "create", side_effect=AssertionError("不能领预算")):
            with self.assertRaises(ValueError):
                smoke.require_live_configuration({})

    def test_public_http_prepare_zero_then_model_one_and_pg_restore(self):
        def connect(stream, address):
            if isinstance(address, tuple) and address[0] == "127.0.0.1":
                return _CONNECT(stream, address)
            raise AssertionError("只允许本场回环HTTP")

        def resolve(host, *args, **kwargs):
            if host == "127.0.0.1":
                return _GETADDRINFO(host, *args, **kwargs)
            raise AssertionError("禁止外部DNS")

        bundle = self.bundle(smoke.mock_response)
        with patch("socket.socket.connect", connect), patch("socket.getaddrinfo", resolve), self.budget.batch():
            backend = smoke.SmokeBackend(bundle, self.home)
            self.addCleanup(backend.close)
            http = backend.backend
            cid = str(backend.contact_id)
            status, default = http.request(f"/api/contacts/{cid}/assistant-session/default", {}, method="POST")
            self.assertEqual(status, 200)
            sid = default["session_id"]
            endpoint = f"/api/contacts/{cid}/assistant-sessions/{sid}"
            body = {"contact_id": cid, "idempotency_key": str(uuid4()), "content": {
                "type": "rewrite_draft", "draft_text": smoke.DRAFT, "user_instruction": smoke.INSTRUCTION,
                "include_relationship_context": False,
            }}
            status, receipt = http.request(endpoint + "/replies/prepare", body, method="POST")
            self.assertEqual(status, 200, receipt)
            self.assertEqual(self.budget.snapshot()["reserved_requests"], 0)
            status, result = http.request(endpoint + "/replies", body, method="POST", timeout=25)
            self.assertEqual(status, 200, result)
            self.assertEqual(result["state"], "completed")
            self.assertEqual(result["turn_id"], receipt["turn_id"])
            self.assertEqual(result["input_version_id"], receipt["input_version_id"])
            status, restored = http.request(endpoint)
            self.assertEqual(status, 200)
            self.assertEqual(restored["turns"][0]["state"], "completed")
            self.assertEqual(self.budget.snapshot()["reserved_requests"], 1)
            inspection = backend.inspect()
            self.assertEqual(inspection["counts"]["message"], 0)
            self.assertEqual(inspection["counts"]["source_document"], 0)
            self.assertEqual(inspection["reply_states"], ["completed"])
            status, stopped = http.request("/api/runtime/shutdown", {}, method="POST")
            self.assertEqual((status, stopped), (200, {"state": "stopped"}))
        self.assertEqual(self.budget.closed_receipt()["reserved_requests"], 1)


if __name__ == "__main__":
    unittest.main()
