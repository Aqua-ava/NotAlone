"""真实 SDK 通过本地合成 HTTP transport 验证最终序列化及原始返回。"""

from __future__ import annotations

import json
import unittest
from uuid import UUID

import httpx

from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from notalone.memory_extraction.command import run_extraction
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_command import _messages, _payload


class TraceTransportTest(unittest.TestCase):
    def test_committed_ledger_with_lost_receipt_is_never_recorded_twice(self):
        class ReceiptLostLedger(InMemoryOutboundLedger):
            def record(self, entry):
                super().record(entry)
                raise RuntimeError("合成提交回执丢失")

        ledger = ReceiptLostLedger()
        traces = InMemoryTraceStore()
        scope = ContactScope(
            UUID("aaaaaaaa-1111-1111-1111-111111111111"),
            UUID("bbbbbbbb-2222-2222-2222-222222222222"),
        )

        def synthetic_http(request):
            return httpx.Response(
                200,
                json={
                    "id": "synthetic-ack-loss",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "deepseek-chat",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "synthetic-zero",
                                        "type": "function",
                                        "function": {
                                            "name": "MemoryExtractionOutput",
                                            "arguments": '{"facts":[]}',
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                },
            )

        with build_trace_http_client(
            transport=httpx.MockTransport(synthetic_http)
        ) as client:
            model = build_deepseek_model(
                api_key="synthetic-secret",
                base_url="http://127.0.0.1/v1",
                http_client=client,
            )
            with self.assertRaises(RuntimeError):
                run_extraction(
                    scope=scope,
                    messages=_messages(1),
                    watermark_message_id=None,
                    runtime=LangChainExtractionRuntime(model=model),
                    memory_port=InMemoryMemoryStore(),
                    owner_memory_port=None,
                    trace_store=traces,
                    ledger=ledger,
                )
        entries = ledger.list_by_owner(scope.owner_id)
        self.assertEqual(len(entries), 1)
        detail = traces.get_batch(
            scope, traces.list_batches(scope)[0]["trace_id"]
        )
        self.assertEqual(len(detail["calls"]), 1)
        self.assertEqual(
            detail["calls"][0]["ledger_entry_id"], str(entries[0].entry_id)
        )
        self.assertEqual(detail["calls"][0]["ledger_commit_status"], "unknown")

    def test_final_sdk_request_and_response_preserve_raw_serialization_and_tools(
        self,
    ):
        messages = _messages(1)
        payload = _payload(messages[0].message_id)
        wire_response = (
            ' {"id":"synthetic-request", "object":"chat.completion","created":1,"model":"deepseek-chat","choices":[{"index":0,"message":{"role":"assistant","content":"","tool_calls":[{"id":"synthetic-tool","type":"function","function":{"name":"MemoryExtractionOutput","arguments":'
            + json.dumps(json.dumps({"facts": [payload]}, ensure_ascii=False))
            + '}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n'
        )
        observed = []

        def synthetic_http(request):
            observed.append(request.content.decode())
            return httpx.Response(
                200,
                content=wire_response.encode(),
                headers={
                    "content-type": "application/json",
                    "x-request-id": "synthetic-request",
                },
            )

        scope = ContactScope(
            UUID("aaaaaaaa-1111-1111-1111-111111111111"),
            UUID("bbbbbbbb-2222-2222-2222-222222222222"),
        )
        traces = InMemoryTraceStore()
        with build_trace_http_client(
            transport=httpx.MockTransport(synthetic_http)
        ) as client:
            model = build_deepseek_model(
                api_key="synthetic-secret",
                base_url="https://synthetic.example.test/v1",
                http_client=client,
                extra_body={"thinking": {"type": "enabled"}},
            )
            stats = run_extraction(
                scope=scope,
                messages=messages,
                watermark_message_id=None,
                runtime=LangChainExtractionRuntime(model=model),
                memory_port=InMemoryMemoryStore(),
                owner_memory_port=None,
                trace_store=traces,
            )
        self.assertEqual((stats.pending, stats.rejected_by_contract), (0, 1))
        detail = traces.get_batch(
            scope, traces.list_batches(scope)[0]["trace_id"]
        )
        request = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "provider_request"
        )
        response = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "provider_response"
        )
        self.assertEqual(request["body_text"], observed[0])
        self.assertEqual(response["body_text"], wire_response)
        self.assertEqual(
            request["parsed_body"]["tools"][0]["function"]["name"],
            "MemoryExtractionOutput",
        )
        self.assertEqual(
            request["parsed_body"]["tool_choice"]["function"]["name"],
            "MemoryExtractionOutput",
        )
        self.assertEqual(
            request["parsed_body"]["thinking"], {"type": "enabled"}
        )
        self.assertEqual(response["parsed_body"]["usage"]["prompt_tokens"], 10)
        self.assertNotIn(
            "synthetic-secret", json.dumps(detail, ensure_ascii=False)
        )

    def test_transport_trace_fault_is_not_swallowed_or_retried_by_real_sdk(
        self,
    ):
        from tests.unit.memory_extraction.test_command import (
            RecordingWatermark,
        )

        for failing_stage, expected_sends in (
            ("model_request", 0),
            ("provider_request", 0),
            ("provider_response", 1),
            ("model_response", 1),
        ):
            with self.subTest(stage=failing_stage):

                class FailingStore(InMemoryTraceStore):
                    def append(self, *args, stage, **kwargs):
                        if stage == failing_stage:
                            raise RuntimeError("合成记录故障")
                        return super().append(*args, stage=stage, **kwargs)

                observed = []
                ledger = InMemoryOutboundLedger()

                def synthetic_http(request):
                    observed.append(request.content)
                    return httpx.Response(
                        200,
                        json={
                            "id": "synthetic",
                            "object": "chat.completion",
                            "created": 1,
                            "model": "deepseek-chat",
                            "choices": [
                                {
                                    "index": 0,
                                    "message": {
                                        "role": "assistant",
                                        "content": "损坏的结构化返回",
                                    },
                                    "finish_reason": "stop",
                                }
                            ],
                        },
                    )

                traces = FailingStore()
                scope = ContactScope(
                    UUID("aaaaaaaa-1111-1111-1111-111111111111"),
                    UUID("bbbbbbbb-2222-2222-2222-222222222222"),
                )
                watermark = RecordingWatermark()
                with build_trace_http_client(
                    transport=httpx.MockTransport(synthetic_http)
                ) as client:
                    model = build_deepseek_model(
                        api_key="synthetic-secret",
                        base_url="https://synthetic.example.test/v1",
                        http_client=client,
                    )
                    with self.assertRaises(TraceWriteError):
                        run_extraction(
                            scope=scope,
                            messages=_messages(1),
                            watermark_message_id=None,
                            runtime=LangChainExtractionRuntime(model=model),
                            memory_port=InMemoryMemoryStore(),
                            owner_memory_port=None,
                            trace_store=traces,
                            ledger=ledger,
                            watermark_port=watermark,
                        )
                self.assertEqual(len(observed), expected_sends)
                entries = ledger.list_by_owner(scope.owner_id)
                self.assertEqual(len(entries), expected_sends)
                calls = traces.get_batch(
                    scope, traces.list_batches(scope)[0]["trace_id"]
                )["calls"]
                self.assertEqual(len(calls), expected_sends)
                if expected_sends:
                    self.assertEqual(
                        calls[0]["ledger_entry_id"], str(entries[0].entry_id)
                    )
                    self.assertEqual(
                        calls[0]["response_status"],
                        (
                            "received"
                            if failing_stage == "provider_response"
                            else "returned"
                        ),
                    )
                self.assertEqual(watermark.values, [])
                self.assertIsNone(watermark.get_failure(scope))
                self.assertEqual(
                    traces.list_batches(scope)[0]["status"], "trace_failed"
                )

    def test_visible_provider_retry_has_distinct_raw_attempts_under_one_model_call(
        self,
    ):
        requests = []

        def synthetic_http(request):
            requests.append(request.content)
            if len(requests) == 1:
                return httpx.Response(
                    500,
                    json={
                        "error": {
                            "message": "合成暂时故障",
                            "type": "server_error",
                        }
                    },
                    headers={"retry-after-ms": "1"},
                )
            return httpx.Response(
                200,
                json={
                    "id": "synthetic",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "deepseek-chat",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "synthetic-tool",
                                        "type": "function",
                                        "function": {
                                            "name": "MemoryExtractionOutput",
                                            "arguments": '{"facts":[]}',
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                },
            )

        scope = ContactScope(
            UUID("aaaaaaaa-1111-1111-1111-111111111111"),
            UUID("bbbbbbbb-2222-2222-2222-222222222222"),
        )
        traces = InMemoryTraceStore()
        with build_trace_http_client(
            transport=httpx.MockTransport(synthetic_http)
        ) as client:
            model = build_deepseek_model(
                api_key="synthetic",
                base_url="https://synthetic.example.test/v1",
                http_client=client,
            )
            stats = run_extraction(
                scope=scope,
                messages=_messages(1),
                watermark_message_id=None,
                runtime=LangChainExtractionRuntime(model=model),
                memory_port=InMemoryMemoryStore(),
                owner_memory_port=None,
                trace_store=traces,
            )
        detail = traces.get_batch(
            scope, traces.list_batches(scope)[0]["trace_id"]
        )
        attempts = [
            event
            for event in detail["events"]
            if event["stage"] == "provider_request"
        ]
        self.assertEqual(
            [event["payload"]["attempt"] for event in attempts], [1, 2]
        )
        self.assertEqual(len({event["call_id"] for event in attempts}), 1)
        self.assertEqual(stats.extracted, 0)

    def test_extraction_verification_and_adjudication_each_preserve_their_own_sdk_call(
        self,
    ):
        from notalone.ledger.adapters import InMemoryOutboundLedger
        from notalone.memory.models import MemoryCandidate, MemoryCategory
        from notalone.memory_extraction.adjudication_adapters import (
            LangChainAdjudicationRuntime,
        )
        from notalone.memory_extraction.dimensions import (
            RELEASE_ALL_DIMENSIONS,
        )
        from notalone.memory_extraction.verification_adapters import (
            LangChainSourceVerificationRuntime,
        )

        scope = ContactScope(
            UUID("aaaaaaaa-1111-1111-1111-111111111111"),
            UUID("bbbbbbbb-2222-2222-2222-222222222222"),
        )
        messages = _messages(2)
        memory = InMemoryMemoryStore()
        old_candidate = memory.create_candidate(
            MemoryCandidate(
                candidate_id=UUID("cccccccc-3333-3333-3333-333333333333"),
                scope=scope,
                text="他习惯直接打电话沟通",
                category=MemoryCategory.COMMON_FACT,
                source_ids=(messages[0].message_id,),
            )
        )
        old = memory.confirm(
            scope=scope, candidate_id=old_candidate.candidate_id
        )
        facts = [
            {
                **_payload(messages[1].message_id),
                "text": "他现在习惯直接打电话沟通",
            }
        ]
        requests = []

        def synthetic_http(request):
            body = json.loads(request.content)
            requests.append(body)
            name = body["tools"][0]["function"]["name"]
            outputs = {
                "MemoryExtractionOutput": {"facts": facts},
                "SourceVerificationOutput": {
                    "results": [
                        {
                            "candidate_index": 0,
                            "verdict": "supported",
                            "issues": [],
                            "evidence": [
                                {
                                    "message_id": str(messages[1].message_id),
                                    "quote": messages[1].text,
                                }
                            ],
                        }
                    ]
                },
                "BatchMemoryAdjudicationOutput": {"decisions": [{
                    "candidate_index": 0, "action": "update",
                    "replaced_memory_id": str(old.memory_id),
                    "merged_memory_ids": [], "merged_text": None, "duplicate_memory_id": None,
                }]},
            }
            return httpx.Response(
                200,
                json={
                    "id": "synthetic-" + name,
                    "object": "chat.completion",
                    "created": 1,
                    "model": "deepseek-chat",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "synthetic-tool",
                                        "type": "function",
                                        "function": {
                                            "name": name,
                                            "arguments": json.dumps(
                                                outputs[name],
                                                ensure_ascii=False,
                                            ),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                },
            )

        traces = InMemoryTraceStore()
        ledger = InMemoryOutboundLedger()
        with build_trace_http_client(
            transport=httpx.MockTransport(synthetic_http)
        ) as client:
            model = build_deepseek_model(
                api_key="synthetic",
                base_url="https://synthetic.example.test/v1",
                http_client=client,
            )
            stats = run_extraction(
                scope=scope,
                messages=messages,
                watermark_message_id=None,
                runtime=LangChainExtractionRuntime(model=model),
                verification_runtime=LangChainSourceVerificationRuntime(
                    model=model, ledger=ledger
                ),
                adjudication_runtime=LangChainAdjudicationRuntime(model=model),
                memory_port=memory,
                owner_memory_port=None,
                trace_store=traces,
                dimension_release=RELEASE_ALL_DIMENSIONS,
                ledger=ledger,
            )
        self.assertEqual((stats.updated, stats.pending), (0, 1))
        detail = traces.get_batch(
            scope, traces.list_batches(scope)[0]["trace_id"]
        )
        calls = [
            event
            for event in detail["events"]
            if event["stage"] == "model_request"
        ]
        self.assertEqual(
            [event["payload"]["purpose"] for event in calls],
            ["extraction", "verification", "adjudication"],
        )
        self.assertEqual(len({event["call_id"] for event in calls}), 3)
        ledger_events = [
            event
            for event in detail["events"]
            if event["stage"] == "ledger_call"
        ]
        self.assertEqual(
            {event["payload"]["entry"]["entry_id"] for event in ledger_events},
            {
                str(entry.entry_id)
                for entry in ledger.list_by_owner(scope.owner_id)
            },
        )
        self.assertEqual(
            {event["call_id"] for event in ledger_events},
            {event["call_id"] for event in calls},
        )
        self.assertEqual(len(requests), 3)
        self.assertEqual(
            len(
                [
                    event
                    for event in detail["events"]
                    if event["stage"] == "provider_response"
                ]
            ),
            3,
        )
        adjudication = requests[2]["messages"][1]["content"]
        self.assertIn(str(old.memory_id), adjudication)
        self.assertIn('"version": 2', adjudication)
        self.assertNotIn('raw_payload', adjudication)
