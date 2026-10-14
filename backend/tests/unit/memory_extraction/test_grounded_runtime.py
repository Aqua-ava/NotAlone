"""真实SDK本地传输、结构编译、追踪和默认待确认路径。"""
from __future__ import annotations
import json
import unittest

import httpx

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_grounded_extraction import row, window


class GroundedRuntimeTest(unittest.TestCase):
    def _response(self, draft):
        return httpx.Response(200, json={
            "id": "synthetic-grounded", "object": "chat.completion", "created": 1,
            "model": "deepseek-chat", "choices": [{"index": 0, "finish_reason": "tool_calls",
                "message": {"role": "assistant", "content": "", "tool_calls": [{
                    "id": "synthetic-call", "type": "function", "function": {
                        "name": "GroundedMemoryDraft", "arguments": json.dumps(draft, ensure_ascii=False),
                    },
                }]}}],
        })

    def test_sdk_trace_and_compiled_candidate_use_one_extraction_call(self):
        source = window("如果周末有空，我只去问场馆是否开放。")
        scope = ContactScope(source.owner_id, source.contact_id)
        requests = []
        draft = {"units": [row("0:0", "condition"), row("0:1", "plan")]}
        def handler(request):
            requests.append(json.loads(request.content))
            return self._response(draft)
        traces = InMemoryTraceStore()
        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1", http_client=client)
            stats = run_extraction(scope=scope, messages=source.messages, watermark_message_id=None,
                                   runtime=GroundedExtractionRuntime(model=model), memory_port=InMemoryMemoryStore(),
                                   owner_memory_port=None, trace_store=traces)
        self.assertEqual(len(requests), 1)
        self.assertNotIn("tool_choice", requests[0])
        self.assertEqual(requests[0]["tools"][0]["function"]["name"], "GroundedMemoryDraft")
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = {event["stage"]: event["payload"] for event in detail["events"]}
        self.assertEqual(events["grounded_draft"]["draft"], draft)
        self.assertEqual(events["grounded_compile"]["payloads"][0]["valid_at"], "2026-10-17T00:00:00+08:00")
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)

    def test_incomplete_coverage_stops_before_accepting_candidates(self):
        source = window("已经到了，还在等车。")
        with build_trace_http_client(transport=httpx.MockTransport(lambda _: self._response({"units": [row("0:0", "event")]}))) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1", http_client=client)
            result = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model)).run(source)
        self.assertEqual(result.accepted, ())
        self.assertIsNotNone(result.failure_reason)

    def test_compilation_trace_failure_prevents_candidate_write(self):
        class BrokenTrace(InMemoryTraceStore):
            def append(self, *args, **kwargs):
                if kwargs.get("stage") == "grounded_compile":
                    raise RuntimeError("合成追踪失败")
                return super().append(*args, **kwargs)
        source = window("我已经取件了。")
        with build_trace_http_client(transport=httpx.MockTransport(lambda _: self._response({"units": [row("0:0", "event")]}))) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1", http_client=client)
            with self.assertRaises(TraceWriteError):
                run_extraction(scope=ContactScope(source.owner_id, source.contact_id), messages=source.messages,
                               watermark_message_id=None, runtime=GroundedExtractionRuntime(model=model),
                               memory_port=InMemoryMemoryStore(), owner_memory_port=None, trace_store=BrokenTrace())
