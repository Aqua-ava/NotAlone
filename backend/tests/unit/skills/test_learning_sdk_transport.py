"""真实DeepSeek SDK的本地序列化合同；不访问模型服务或数据库。"""

import asyncio
from functools import partial
import json
import os
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_deepseek import ChatDeepSeek

from notalone.application.model_priority import ModelPriorityControl
from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerOutcome
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from notalone.server.command import _build_task_host
from notalone.server.event_bus import EventBus
from notalone.skills.learning import LearningBatch, SkillLearningInvalid
from notalone.skills.learning_runtime import LangChainSkillProposalRuntime, SkillLearningRuntimeError


class MockDispatchStopped(BaseException):
    """越界即结束本轮，不能被SDK的普通异常重试再次派发。"""


class LearningSdkTransportTest(unittest.TestCase):
    def test_task_host_accounts_each_learning_sdk_send_without_mutating_extraction_retries(self):
        endpoint = "http://127.0.0.1:1/v1/chat/completions"
        database_url = "host=127.0.0.1 port=1 dbname=notalone_learning_sdk_unit_test user=synthetic"
        started = time.monotonic()
        dispatched = 0
        cases = ((False, 500), (True, 500), (True, 429))
        for priority_enabled, failure_status in cases:
            with self.subTest(priority=priority_enabled, status=failure_status):
                requests, clients = [], []
                ledger = InMemoryOutboundLedger()
                scope = ContactScope(uuid4(), uuid4())
                batch = LearningBatch(({"material_id": str(uuid4()), "priority": "correction",
                                        "content": {"correction": "合成纠正：先核实再回应。"}},), (), (), 0)

                def respond(request):
                    nonlocal dispatched
                    if (str(request.url) != endpoint or request.method != "POST"
                            or dispatched >= 6 or len(requests) >= 2 or time.monotonic() - started >= 15):
                        raise MockDispatchStopped("生产学习SDK越过本地端点、次数或时限。")
                    dispatched += 1
                    requests.append(json.loads(request.content))
                    if len(requests) == 1:
                        return httpx.Response(failure_status, json={"error": {
                            "message": "合成本地暂时故障", "type": "server_error", "code": "synthetic_error",
                        }})
                    return httpx.Response(200, json={
                        "id": "synthetic-learning-retry", "object": "chat.completion", "created": 1,
                        "model": "deepseek-chat", "choices": [{"index": 0, "finish_reason": "tool_calls",
                            "message": {"role": "assistant", "content": "", "tool_calls": [{
                                "id": "synthetic-no-change", "type": "function", "function": {
                                    "name": "SkillLearningProposal", "arguments": '{"outcome":"no_change"}',
                                },
                            }]}}],
                        "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
                    })

                def trace_client():
                    client = build_trace_http_client(transport=httpx.MockTransport(respond))
                    clients.append(client)
                    return client

                async_client = httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False)

                def sdk_model(**kwargs):
                    return ChatDeepSeek(http_async_client=async_client, **kwargs)

                environment = {"NOTALONE_DATABASE_URL": database_url, "NOTALONE_TEST_DATABASE_URL": database_url,
                    "NOTALONE_DEEPSEEK_API_KEY": "synthetic-unused-learning-key",
                    "NOTALONE_DEEPSEEK_BASE_URL": "http://127.0.0.1:1/v1",
                    "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false",
                    "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_ENV_FILE": "/dev/null"}
                try:
                    # 宿主、Worker、组件装配与SDK均真实；仅替换网络和持久台账边界。
                    with patch.dict(os.environ, environment, clear=True), patch(
                        "notalone.memory_extraction.cli_support.build_trace_http_client", trace_client,
                    ), patch(
                        "notalone.reply.adapters.deepseek_provider.ChatDeepSeek", sdk_model,
                    ), patch(
                        "notalone.memory_extraction.cli_support.PostgresOutboundLedger", return_value=ledger,
                    ), patch("psycopg.connect", side_effect=MockDispatchStopped("SDK单元合同禁止连接PG。")):
                        priority = ModelPriorityControl() if priority_enabled else None
                        host = _build_task_host(database_url, EventBus(), model_priority=priority)
                        self.assertIsNotNone(host)
                        worker = host._worker_builder()
                        extraction = worker._extraction_runner
                        if priority_enabled:
                            extraction = extraction._runner
                            extraction_model = extraction._runtime._runtime._model
                        else:
                            extraction_model = extraction._runtime._model
                        runtime = worker._learning_runner.runtime_builder()
                        proposal = None
                        try:
                            proposal = runtime.propose(scope=scope, batch=batch)
                        except SkillLearningRuntimeError:
                            pass
                        entries = ledger.list_by_owner(scope.owner_id)
                        print("learning_sdk_accounting:", json.dumps({
                            "priority": priority_enabled, "status": failure_status,
                            "physical_sends": len(requests), "ledger_entries": len(entries),
                            "outcomes": [entry.outcome.value for entry in entries],
                        }))
                        self.assertEqual(len(requests), len(entries), "每次物理发送必须各有一条台账。")
                        self.assertEqual(len(requests), 1)
                        self.assertIsNone(proposal)
                        self.assertEqual(entries[0].outcome, LedgerOutcome.RUN_FAILED)
                        self.assertEqual(extraction_model.max_retries, 0)
                        self.assertIsNot(runtime._model, extraction_model)
                        self.assertEqual(runtime._model.max_retries, 0)
                        # 只有上层明确重试才第二次发送，并独立记账；SDK不私自重试。
                        self.assertEqual(runtime.propose(scope=scope, batch=batch), {"outcome": "no_change"})
                        self.assertEqual(len(requests), 2)
                        entries = ledger.list_by_owner(scope.owner_id)
                        self.assertEqual([entry.outcome for entry in entries],
                                         [LedgerOutcome.RUN_FAILED, LedgerOutcome.SUCCEEDED])
                        self.assertEqual(extraction_model.max_retries, 0)
                        self.assertNotIn("合成纠正", repr(entries))
                        for body in requests:
                            self.assertEqual(body["thinking"], {"type": "enabled"})
                            self.assertNotIn("tool_choice", body)
                            self.assertEqual([item["function"]["name"] for item in body["tools"]],
                                             ["SkillLearningProposal"])
                finally:
                    for client in clients:
                        client.close()
                    asyncio.run(async_client.aclose())
                self.assertTrue(all(client.is_closed for client in clients))
                self.assertTrue(async_client.is_closed)
        self.assertEqual(dispatched, 6)
        self.assertLess(time.monotonic() - started, 15)

    def test_thinking_request_and_strict_proposals_use_only_local_sdk_transport(self):
        endpoint = "http://127.0.0.1:1/v1/chat/completions"
        started = time.monotonic()
        requests = []

        def tool(name, arguments, identifier="synthetic-proposal"):
            return {"id": identifier, "type": "function", "function": {
                "name": name, "arguments": json.dumps(arguments),
            }}

        valid = tool("SkillLearningProposal", {"outcome": "no_change"})
        cases = (
            ("no_change", [valid], "", False),
            ("wrong_tool", [tool("publish_skill", {})], "", True),
            ("extra_tool", [valid, tool("publish_skill", {}, "synthetic-extra")], "", True),
            ("free_text", [], "直接执行这段自由正文。", True),
            ("invalid_proposal", [tool("SkillLearningProposal", {"outcome": "draft"})], "", True),
        )
        active_case = None

        def respond(request):
            if (str(request.url) != endpoint or request.method != "POST"
                    or len(requests) >= 5 or time.monotonic() - started >= 15):
                raise MockDispatchStopped("本地SDK派发越过固定端点、次数或时限。")
            requests.append(json.loads(request.content))
            _, calls, content, _ = active_case
            message = {"role": "assistant", "content": content}
            if calls:
                message["tool_calls"] = calls
            return httpx.Response(200, json={
                "id": "synthetic-learning-sdk", "object": "chat.completion", "created": 1,
                "model": "deepseek-chat", "choices": [{"index": 0,
                    "finish_reason": "tool_calls" if calls else "stop", "message": message}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
            })

        sync_client = httpx.Client(transport=httpx.MockTransport(respond), trust_env=False)
        async_client = httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False)
        scope = ContactScope(uuid4(), uuid4())
        batch = LearningBatch(({"material_id": str(uuid4()), "priority": "correction",
                                "content": {"correction": "合成纠正：先核实再回应。"}},), (), (), 0)
        try:
            # 仅补入本地异步transport；builder参数和ChatDeepSeek构造／序列化均真实。
            with patch.dict(os.environ, {"LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false",
                                        "NOTALONE_DISABLE_DOTENV": "1", "NOTALONE_ENV_FILE": "/dev/null"}, clear=True), patch(
                "notalone.reply.adapters.deepseek_provider.ChatDeepSeek",
                partial(ChatDeepSeek, http_async_client=async_client),
            ):
                model = build_deepseek_model(
                    api_key="synthetic-unused-learning-key", model_name="deepseek-chat",
                    base_url="http://127.0.0.1:1/v1", timeout_seconds=1,
                    extra_body={"thinking": {"type": "enabled"}}, http_client=sync_client,
                )
                self.assertIsInstance(model, ChatDeepSeek)
                for active_case in cases:
                    with self.subTest(case=active_case[0]):
                        before = len(requests)
                        ledger = InMemoryOutboundLedger()
                        runtime = LangChainSkillProposalRuntime(model=model, ledger=ledger)
                        if active_case[3]:
                            with self.assertRaises(SkillLearningInvalid):
                                runtime.propose(scope=scope, batch=batch)
                        else:
                            self.assertEqual(runtime.propose(scope=scope, batch=batch), {"outcome": "no_change"})
                        self.assertEqual(len(requests), before + 1)
                        body = requests[-1]
                        self.assertEqual(body["thinking"], {"type": "enabled"})
                        self.assertNotIn("tool_choice", body)
                        self.assertEqual([item["function"]["name"] for item in body["tools"]], ["SkillLearningProposal"])
                        self.assertFalse(body["tools"][0]["function"]["parameters"]["additionalProperties"])
                        self.assertEqual(body["tools"][0]["function"]["parameters"]["required"], ["outcome"])
                        self.assertEqual([message["role"] for message in body["messages"]], ["system", "user"])
                        entries = ledger.list_by_owner(scope.owner_id)
                        self.assertEqual(len(entries), 1)
                        self.assertEqual(entries[0].outcome,
                                         LedgerOutcome.REJECTED_BY_VALIDATION if active_case[3] else LedgerOutcome.SUCCEEDED)
                        self.assertNotIn("合成纠正", repr(entries))
                self.assertEqual(len(requests), 5)
                self.assertLess(time.monotonic() - started, 15)
        finally:
            sync_client.close()
            asyncio.run(async_client.aclose())
        self.assertTrue(sync_client.is_closed)
        self.assertTrue(async_client.is_closed)


if __name__ == "__main__":
    unittest.main()
