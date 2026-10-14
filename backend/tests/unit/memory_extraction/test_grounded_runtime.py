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


def labels(*rows):
    return {"units": {item["unit"]: {k: v for k, v in item.items() if k != "unit"} for item in rows}}


class GroundedRuntimeTest(unittest.TestCase):
    def _response(self, draft):
        return httpx.Response(200, json={
            "id": "synthetic-grounded", "object": "chat.completion", "created": 1,
            "model": "deepseek-chat", "choices": [{"index": 0, "finish_reason": "tool_calls",
                "message": {"role": "assistant", "content": "", "tool_calls": [{
                    "id": "synthetic-call", "type": "function", "function": {
                        "name": "GroundedMemoryLabels", "arguments": json.dumps(draft, ensure_ascii=False),
                    },
                }]}}],
        })

    def test_sdk_trace_and_compiled_candidate_use_one_extraction_call(self):
        source = window("如果周末有空，我只去问场馆是否开放。")
        scope = ContactScope(source.owner_id, source.contact_id)
        requests = []
        draft = labels(row("0:0", "condition"), row("0:1", "plan"))
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
        self.assertEqual(requests[0]["tools"][0]["function"]["name"], "GroundedMemoryLabels")
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = {event["stage"]: event["payload"] for event in detail["events"]}
        self.assertEqual(events["grounded_draft"]["draft"], draft)
        self.assertEqual(events["grounded_compile"]["payloads"][0]["valid_at"], "2026-10-17T00:00:00+08:00")
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)

    def test_incomplete_coverage_stops_before_accepting_candidates(self):
        source = window("已经到了，还在等车。")
        with build_trace_http_client(transport=httpx.MockTransport(lambda _: self._response(labels(row("0:0", "event"))))) as client:
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
        with build_trace_http_client(transport=httpx.MockTransport(lambda _: self._response(labels(row("0:0", "event"))))) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1", http_client=client)
            with self.assertRaises(TraceWriteError):
                run_extraction(scope=ContactScope(source.owner_id, source.contact_id), messages=source.messages,
                               watermark_message_id=None, runtime=GroundedExtractionRuntime(model=model),
                               memory_port=InMemoryMemoryStore(), owner_memory_port=None, trace_store=BrokenTrace())

    def test_runtime_binds_labels_to_named_source_slots(self):
        source = window("我已取件，正在等车。")
        first = row("0:0", "event")
        second = row("0:1", "momentary_state")
        first.pop("unit")
        second.pop("unit")
        draft = {"units": {"0:1": second, "0:0": first}}
        requests = []
        def handler(request):
            requests.append(json.loads(request.content))
            response = self._response(draft)
            body = response.json()
            body["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "GroundedMemoryLabels"
            return httpx.Response(200, json=body)
        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1", http_client=client)
            facts = GroundedExtractionRuntime(model=model).extract(source)
        self.assertEqual(len(requests), 1)
        self.assertIn("我已取件", facts[0]["text"])
        self.assertIn("正在等车", facts[1]["text"])
        slots = requests[0]["tools"][0]["function"]["parameters"]["properties"]["units"]
        self.assertEqual(slots["type"], "object")
        self.assertEqual(set(slots["required"]), {"0:0", "0:1"})
        self.assertFalse(slots["additionalProperties"])
        self.assertNotIn("unit", slots["properties"]["0:0"]["properties"])

    def test_sdk_keeps_reference_constraints_and_selected_source(self):
        from dataclasses import replace
        from uuid import uuid4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        source = window("现在她住在哪里，我不清楚。")
        question = MessageRef(uuid4(), "你妹妹现在住在哪里？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(question, *source.messages))
        draft = labels(row("1:0", "prefix", dependency="0:0"), row("1:1", "state"))
        requests = []
        def handler(request):
            requests.append(json.loads(request.content))
            return self._response(draft)
        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1", http_client=client)
            facts = GroundedExtractionRuntime(model=model).extract(source)
        self.assertEqual(len(requests), 1)
        schema = requests[0]["tools"][0]["function"]["parameters"]
        branches = schema["properties"]["units"]["properties"]["1:0"]["anyOf"]
        self.assertIn({"properties": {"unresolved": {"const": True}}}, branches)
        self.assertIn({"properties": {"dependency": {"type": "string", "enum": ["0:0"]}}}, branches)
        self.assertIn(str(question.message_id), facts[0]["source_message_ids"])
        self.assertIn("你妹妹现在住在哪里", facts[0]["text"])
        self.assertEqual(facts[0]["alternatives"], [])
