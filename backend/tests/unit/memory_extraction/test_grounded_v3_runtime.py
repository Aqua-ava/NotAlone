"""真实SDK经本地传输验证显式v3工具、追踪及默认待确认。"""
from __future__ import annotations

import hashlib
import json
import unittest

import httpx

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime, GroundedV3ExtractionRuntime
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels


def response(draft: dict, *, name: str = "GroundedMemoryLabelsV3") -> httpx.Response:
    return httpx.Response(200, json={
        "id": "synthetic-v3", "object": "chat.completion", "created": 1,
        "model": "deepseek-chat", "choices": [{"index": 0, "finish_reason": "tool_calls",
            "message": {"role": "assistant", "content": "", "tool_calls": [{
                "id": "synthetic-call", "type": "function", "function": {
                    "name": name, "arguments": json.dumps(draft, ensure_ascii=False),
                },
            }]}}],
    })


class GroundedV3RuntimeTest(unittest.TestCase):
    def test_single_sdk_request_freezes_codes_and_traces_labels_separately_from_compilation(self):
        source = window("他们周末要来家里。")
        scope = ContactScope(source.owner_id, source.contact_id)
        draft = labels(row("0:0", "plan", unresolved=True,
                           ambiguity_codes=["entity_identity", "place_ownership"]))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft)

        traces = InMemoryTraceStore()
        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            stats = run_extraction(
                scope=scope, messages=source.messages, watermark_message_id=None,
                runtime=GroundedV3ExtractionRuntime(model=model), memory_port=InMemoryMemoryStore(),
                owner_memory_port=None, trace_store=traces,
            )

        self.assertEqual(len(requests), 1)
        self.assertNotIn("tool_choice", requests[0])
        prompt = requests[0]["messages"][0]["content"]
        for guidance in ("非互斥", "逐类核对", "全部选择", "词语命中"):
            self.assertIn(guidance, prompt)
        tool = requests[0]["tools"][0]["function"]
        self.assertEqual(tool["name"], "GroundedMemoryLabelsV3")
        slots = tool["parameters"]["properties"]["units"]
        self.assertEqual(slots["required"], ["0:0"])
        label = slots["properties"]["0:0"]
        self.assertIn("ambiguity_codes", label["required"])
        self.assertEqual(label["properties"]["ambiguity_codes"]["maxItems"], 4)
        self.assertTrue(label["properties"]["ambiguity_codes"]["uniqueItems"])
        self.assertNotIn("alternatives", label["properties"])
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = {event["stage"]: event["payload"] for event in detail["events"]}
        self.assertEqual(events["grounded_draft"]["draft"], draft)
        self.assertEqual(events["grounded_draft"]["protocol"], "grounded-v3")
        self.assertEqual(events["grounded_compile"]["protocol"], "grounded-v3")
        self.assertEqual(len(events["grounded_compile"]["payloads"][0]["alternatives"]), 2)
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)

    def test_v3_financial_guidance_preserves_negative_source_and_supplied_labels(self):
        # 合成响应仅验证指导已上wire及原编译合同，不认证模型会遵守指导。
        for text, kind, sensitivity in (
            ("我没有向同事借钱。", "relationship_event", "financial"),
            ("我没有向同事借钱。", "relationship_event", "none"),
            ("我借过同事的伞。", "relationship_event", "none"),
            ("我觉得这杯茶报价二十元。", "assessment", "none"),
        ):
            with self.subTest(text=text, sensitivity=sensitivity):
                source = window(text)
                draft = labels(row("0:0", kind, sensitivity=sensitivity, ambiguity_codes=[]))
                requests = []

                def handler(request):
                    requests.append(json.loads(request.content))
                    return response(draft)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    result = GroundedV3ExtractionRuntime(model=model).extract(source)

                self.assertEqual(len(requests), 1)
                self.assertNotIn("tool_choice", requests[0])
                prompt = requests[0]["messages"][0]["content"]
                for guidance in ("金融敏感事项", "即使原文否定", "financial也保留", "不表示已有负债",
                                 "普通借用物品、报价判断"):
                    self.assertIn(guidance, prompt)
                self.assertNotIn("financial=真实金钱风险", prompt)
                self.assertIn(text, result[0]["text"])
                self.assertEqual(result[0]["risk_flags"],
                                 ["sensitivity:financial"] if sensitivity == "financial" else [])

    def test_v2_wire_prompt_retains_frozen_bytes(self):
        source = window("我已取件。")
        draft = labels(row("0:0", "event"))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft, name="GroundedMemoryLabels")

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            GroundedExtractionRuntime(model=model).extract(source)

        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["tools"][0]["function"]["name"], "GroundedMemoryLabels")
        prompt = requests[0]["messages"][0]["content"]
        # 来自本次变更前8171d7c0的v2提示字节，不从当前实现派生预期值。
        self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(),
                         "8580e630bbc4d600b08beb8a607cfcc05dc3efeb7daacc98a9f95bcb6164a01b")

    def test_old_tool_or_missing_codes_fail_without_fallback_or_repair_request(self):
        source = window("我已取件。")
        for name, draft in (
            ("GroundedMemoryLabels", labels(row("0:0", "event", ambiguity_codes=[]))),
            ("GroundedMemoryLabelsV3", labels(row("0:0", "event"))),
        ):
            with self.subTest(name=name):
                requests = []

                def handler(request):
                    requests.append(request)
                    return response(draft, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    result = ExtractionFlow(runtime=GroundedV3ExtractionRuntime(model=model)).run(source)
                self.assertEqual(len(requests), 1)
                self.assertEqual(result.accepted, ())
                self.assertIsNotNone(result.failure_reason)

    def test_compilation_trace_failure_prevents_v3_candidate_write(self):
        class BrokenTrace(InMemoryTraceStore):
            def append(self, *args, **kwargs):
                if kwargs.get("stage") == "grounded_compile":
                    raise RuntimeError("合成追踪失败")
                return super().append(*args, **kwargs)

        source = window("我已取件。")
        scope = ContactScope(source.owner_id, source.contact_id)
        draft = labels(row("0:0", "event", ambiguity_codes=[]))
        with build_trace_http_client(transport=httpx.MockTransport(lambda _: response(draft))) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            with self.assertRaises(TraceWriteError):
                run_extraction(scope=scope, messages=source.messages, watermark_message_id=None,
                               runtime=GroundedV3ExtractionRuntime(model=model), memory_port=InMemoryMemoryStore(),
                               owner_memory_port=None, trace_store=BrokenTrace())
