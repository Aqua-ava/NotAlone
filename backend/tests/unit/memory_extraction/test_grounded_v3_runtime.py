"""真实SDK经本地传输验证显式v3工具、追踪及默认待确认。"""
from __future__ import annotations

import hashlib
import json
import unittest

import httpx

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.cases.reference import CASES as REFERENCE_CASES
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded_adapter import GroundedV2ExtractionRuntime, GroundedV3ExtractionRuntime, grounded_schema
from notalone.memory_extraction.pragmatics import PragmaticInterpreter
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
        for guidance in ("原文明示本人已参与", "第三人行动的陈述", "我”仅作关系对象", "人物身份未知本身不要求一律转述",
                         "否定、条件、引语及未证交付"):
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

    def test_v2_wire_prompt_matches_current_core_semantics_contract(self):
        source = window("我已取件。")
        draft = labels(row("0:0", "event"))
        requests = []

        def handler(request):
            requests.append(json.loads(request.content))
            return response(draft, name="GroundedMemoryLabels")

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            GroundedV2ExtractionRuntime(model=model).extract(source)

        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["tools"][0]["function"]["name"], "GroundedMemoryLabels")
        prompt = requests[0]["messages"][0]["content"]
        # 本次当前判断／未来安排提示修订后重签；原schema和给定标签输出保持。
        self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(),
                         "283e7e75239067bec8c98615336ca9af46f9cef6d2cc180342567aa42a7d82e5")

    def test_given_kind_labels_keep_participation_report_negation_condition_and_quote_boundaries(self):
        # 每项kind是合成输入标签；这些通过不代表模型能正确分类或增加质量样本数。
        cases = (
            ("A02已收到邀请", build_window(REFERENCE_CASES[1]),
             labels(row("1:0", "relationship_event", dependency="0:0", ambiguity_codes=[])),
             "assertion", "asserted", "他约我周末去钓鱼。"),
            ("A05姐姐借车", build_window(REFERENCE_CASES[4]),
             labels(row("0:0", "relationship_event", ambiguity_codes=[])),
             "assertion", "asserted", "我姐把她的车借给我了。"),
            ("明确本人接收", window("我已经收到同事交给我的资料了。"),
             labels(row("0:0", "relationship_event", ambiguity_codes=[])),
             "assertion", "asserted", "我已经收到同事交给我的资料了。"),
            ("未知人但参与明确", window("有个陌生人把雨伞交到我手上了。"),
             labels(row("0:0", "relationship_event", unresolved=True, ambiguity_codes=["entity_identity"])),
             "assertion", "asserted", "有个陌生人把雨伞交到我手上了。"),
            ("纯第三方历史", window("小林去年完成了搬家。"),
             labels(row("0:0", "reported_event", ambiguity_codes=[])),
             "report", "reported", "小林去年完成了搬家。"),
            ("否定未变完成", window("小林没有向我借钱。"),
             labels(row("0:0", "reported_event", sensitivity="financial", ambiguity_codes=[])),
             "report", "reported", "小林没有向我借钱。"),
            ("条件未变完成", window("如果小林向我借钱，我再考虑。"),
             labels(row("0:0", "condition", sensitivity="financial", ambiguity_codes=[]),
                    row("0:1", "hypothesis", ambiguity_codes=[])),
             "plan", "conditional", "如果小林向我借钱，我再考虑。"),
            ("引语保留", window("小林原话是“我没有向同事借钱”。"),
             labels(row("0:0", "reported_event", sensitivity="financial", ambiguity_codes=[])),
             "report", "reported", "小林原话是“我没有向同事借钱”。"),
        )
        for name, source, draft, speech, assertion, quote in cases:
            with self.subTest(name=name):
                requests = []

                def handler(request):
                    requests.append(json.loads(request.content))
                    return response(draft)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedV3ExtractionRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                self.assertEqual((fact.speech_act.value, fact.assertion_status.value), (speech, assertion))
                self.assertIn(quote, fact.text)
                self.assertEqual(len(requests), 1)
                choices = requests[0]["tools"][0]["function"]["parameters"]["properties"]["units"]["properties"]
                self.assertNotIn("report", next(iter(choices.values()))["properties"]["kind"]["enum"])

    def test_a03_given_v3_kind_changes_only_existing_mapping_and_remains_pending(self):
        source = build_window(REFERENCE_CASES[2])
        for kind, speech, assertion in (("relationship_event", "assertion", "asserted"),
                                        ("reported_event", "report", "reported")):
            with self.subTest(kind=kind):
                draft = labels(row("0:0", kind, topic="finance", confidence=0.8, sensitivity="financial",
                                   unresolved=True, ambiguity_codes=["entity_identity"]))
                with build_trace_http_client(transport=httpx.MockTransport(lambda _: response(draft))) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedV3ExtractionRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                self.assertEqual((fact.speech_act.value, fact.assertion_status.value), (speech, assertion))
                self.assertEqual(fact.text, "联系人原话：“他昨天又跟我借钱了。”")
                self.assertIsNone(fact.valid_at)
                self.assertIsNone(fact.invalid_at)
                self.assertIn("sensitivity:financial", fact.risk_flags)
                self.assertEqual(fact.alternatives,
                                 ("原句所指人物身份在本窗口无法唯一确定，保留原句。",))
                self.assertEqual(PragmaticInterpreter().interpret(fact).disposition.value, "pending")

    def test_a03_old_v2_labels_reproduce_original_full_output_and_schema(self):
        source = build_window(REFERENCE_CASES[2])
        draft = labels(row("0:0", "relationship_event", topic="finance", confidence=0.8,
                           sensitivity="financial", unresolved=True))
        with build_trace_http_client(transport=httpx.MockTransport(
                lambda _: response(draft, name="GroundedMemoryLabels"))) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            payload = GroundedV2ExtractionRuntime(model=model).extract(source)
        # 完整E14摘要来自原A03封存输出；schema摘要来自变更前85ca9ea7。
        for value, expected in (
            (payload, "b4c25153f4aac09f74718d82597f12b39ca6cc352873e293e9a04009bb86d9a3"),
            (grounded_schema(source), "46d3cfb96ddecbff0c653b1200e0261c16e5de0ab0acff97060d5ca5f6eb57a7"),
        ):
            encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            self.assertEqual(hashlib.sha256(encoded).hexdigest(), expected)

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
