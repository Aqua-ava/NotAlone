"""升级的真实SDK请求合同；只有内存MockTransport，不访问服务或数据库。"""

import asyncio
from dataclasses import replace
from functools import partial
import json
import os
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_deepseek import ChatDeepSeek
from langchain_core.messages import AIMessage

from tests.support.ledger_adapters import InMemoryOutboundLedger
from notalone.application.memory_upgrade_runtime import build_upgrade_components, build_upgrade_runtime
from notalone.application.memory_upgrade import UpgradeModelCalls
from notalone.memory.upgrade import UpgradeBudgetExceeded, UpgradeConflict
from notalone.memory.upgrade_algorithm import upgrade_algorithm
from notalone.scopes import ContactScope
from notalone.memory_extraction.errors import ExtractionRuntimeError, ExtractionInvalidOutputError
from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel
from tests.unit.memory_extraction.test_models import _fact, _window


class MockDispatchStopped(BaseException):
    """越界即停止，不能由SDK普通异常路径继续重试。"""


class UpgradeSdkTransportTest(unittest.TestCase):
    def _run(self, *, response_status, cap, stage='verification', stopped=None, binding_failure=False,
             identity_only=False):
        requests = []
        started = time.monotonic()
        message_id = uuid4()
        window = _window((message_id,))
        fact = _fact(text="合成消息", source_message_ids=(message_id,))
        name = {'extraction': 'DirectMemoryExtractionOutput', 'verification': 'SourceVerificationOutput',
                'adjudication': 'MemoryAdjudicationOutput'}[stage]
        arguments = {'extraction': {'scenes': []}, 'verification': {'results': [{
            'candidate_index': 0, 'verdict': 'supported', 'issues': [],
            'evidence': [{'message_id': str(message_id), 'quote': '合成消息'}],
        }]}, 'adjudication': {'action': 'add', 'replaced_memory_id': None}}[stage]

        def respond(request):
            if (str(request.url) != "http://127.0.0.1:1/v1/chat/completions"
                    or request.method != "POST" or len(requests) >= cap
                    or time.monotonic() - started >= 15):
                raise MockDispatchStopped("本地SDK派发越过固定端点、次数或时限。")
            requests.append(json.loads(request.content))
            if response_status != 200:
                return httpx.Response(response_status, json={"error": {"message": "synthetic"}})
            return httpx.Response(200, json={
                "id": "synthetic-upgrade-sdk", "object": "chat.completion", "created": 1,
                "model": "deepseek-chat", "choices": [{"index": 0, "finish_reason": "tool_calls",
                    "message": {"role": "assistant", "content": "", "tool_calls": [{
                        "id": "synthetic-verification", "type": "function", "function": {
                            "name": name, "arguments": json.dumps(arguments),
                        },
                    }]} }],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
            })

        client = httpx.Client(transport=httpx.MockTransport(respond), trust_env=False)
        async_client = httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False)
        try:
            with patch.dict(os.environ, {
                "NOTALONE_DEEPSEEK_API_KEY": "synthetic-unused-upgrade-key",
                "NOTALONE_DEEPSEEK_BASE_URL": "http://127.0.0.1:1/v1",
                "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false",
                "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_ENV_FILE": "/dev/null",
            }, clear=True), patch("notalone.memory_extraction.cli_support.build_trace_http_client", return_value=client), patch(
                "notalone.reply.adapters.deepseek_provider.ChatDeepSeek",
                partial(ChatDeepSeek, http_async_client=async_client),
            ):
                components = build_upgrade_components("host=/tmp dbname=synthetic_never_connected")
                ledger = InMemoryOutboundLedger()
                runtime = build_upgrade_runtime(replace(components, ledger=ledger))
                identity = upgrade_algorithm(components, runtime)
                self.assertEqual(identity['configuration']['endpoint'], 'http://127.0.0.1:1/v1/')
                self.assertEqual(identity['configuration']['max_retries'], 0)
                self.assertEqual(identity['configuration']['thinking'], 'enabled')
                original_model_name = components.model.model_name
                components.model.model_name = 'synthetic-upgrade-changed'
                changed = upgrade_algorithm(components, runtime)
                self.assertEqual(changed['configuration']['model_name'], 'synthetic-upgrade-changed')
                self.assertNotEqual(changed['digest'], identity['digest'])
                components.model.model_name = original_model_name
                if identity_only:
                    original_endpoint = components.model.root_client.base_url
                    for endpoint in ('https://synthetic-user:synthetic-password@example.invalid/v1',
                                     'https://example.invalid/v1?token=synthetic-secret',
                                     'https://example.invalid/v1#synthetic-secret'):
                        components.model.root_client.base_url = endpoint
                        with self.assertRaises(UpgradeConflict) as error:
                            upgrade_algorithm(components, runtime)
                        self.assertNotIn('synthetic-secret', str(error.exception))
                        self.assertNotIn('synthetic-password', str(error.exception))
                    components.model.root_client.base_url = original_endpoint
                    components.model.root_client.api_key = 'synthetic-private-api-key'
                    components.model.root_client._custom_headers = {'X-Synthetic-Private': 'synthetic-header-secret'}
                    private_configuration = upgrade_algorithm(components, runtime)
                    self.assertEqual(private_configuration, identity)
                    self.assertNotIn('synthetic-private-api-key', json.dumps(private_configuration))
                    self.assertNotIn('synthetic-header-secret', json.dumps(private_configuration))
                    self.assertEqual(requests, [])
                    return
                def invoke(target):
                    if stage == 'verification':
                        return target.verify(window=window, facts=(fact,))
                    if stage == 'extraction':
                        return target.extract(window)
                    return target.adjudicate(candidate_text='合成消息', similar=())
                if binding_failure:
                    with patch.object(ChatDeepSeek, 'bind_tools', side_effect=RuntimeError('合成本地绑定失败')), \
                            patch.object(ChatDeepSeek, 'invoke') as invoke_sdk:
                        with self.assertRaises(ExtractionRuntimeError):
                            invoke(runtime[stage])
                        invoke_sdk.assert_not_called()
                    self.assertEqual(requests, [])
                    self.assertEqual(ledger.list_by_owner(window.owner_id), ())
                    return
                if stopped is not None:
                    class StoppedStore:
                        def charge(self, claim):
                            raise stopped('合成发送前范围或预算门拒绝。')
                    calls = UpgradeModelCalls(scope=ContactScope(window.owner_id, window.contact_id),
                        claim=object(), store=StoppedStore(), extraction=runtime['extraction'],
                        verification=runtime['verification'], adjudication=runtime['adjudication'])
                    with self.assertRaises(stopped):
                        invoke(calls)
                    self.assertEqual(requests, [])
                    return
                if response_status == 200:
                    invoke(runtime[stage])
                else:
                    with self.assertRaises(ExtractionRuntimeError):
                        invoke(runtime[stage])
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0]["thinking"], {"type": "enabled"})
                self.assertNotIn("tool_choice", requests[0])
                self.assertEqual([item["function"]["name"] for item in requests[0]["tools"]], [name])
                self.assertLess(time.monotonic() - started, 15)
        finally:
            client.close()
            asyncio.run(async_client.aclose())
            self.assertTrue(client.is_closed)
            self.assertTrue(async_client.is_closed)
        self.assertTrue(client.is_closed)
        self.assertTrue(async_client.is_closed)

    def test_upgrade_thinking_verification_omits_forced_tool_choice(self):
        self._run(response_status=200, cap=1)

    def test_upgrade_failed_sdk_request_does_not_retry(self):
        self._run(response_status=500, cap=3)

    def test_actual_upgrade_direct_and_adjudication_sdk_requests_keep_their_tools(self):
        for stage in ('extraction', 'adjudication'):
            with self.subTest(stage=stage):
                self._run(response_status=200, cap=1, stage=stage)

    def test_budget_or_scope_rejection_prevents_actual_sdk_dispatch(self):
        for reason in (UpgradeBudgetExceeded, UpgradeConflict):
            with self.subTest(reason=reason):
                self._run(response_status=200, cap=0, stopped=reason)

    def test_local_sdk_binding_failure_has_zero_invoke_transport_and_ledger(self):
        self._run(response_status=200, cap=0, binding_failure=True)

    def test_identity_rejects_credential_endpoints_and_never_records_sdk_secrets(self):
        self._run(response_status=200, cap=0, identity_only=True)

    def test_adjudication_rejects_wrong_multiple_or_extra_tool_arguments(self):
        valid = {"name": "MemoryAdjudicationOutput", "id": "synthetic-a",
                 "args": {"action": "add", "replaced_memory_id": None}}
        for calls in (
            [{**valid, "name": "publish_skill"}],
            [valid, {**valid, "id": "synthetic-extra"}],
            [{**valid, "args": {**valid["args"], "execute": True}}],
        ):
            with self.subTest(calls=calls):
                model = ToolCallingFakeModel(responses=[AIMessage(content="", tool_calls=calls)])
                with self.assertRaises(ExtractionInvalidOutputError):
                    LangChainAdjudicationRuntime(model=model).adjudicate(
                        candidate_text="合成资料。", similar=())
