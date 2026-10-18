"""官方思考模式只省略V强制选项；精确SDK Mock不认证真实端点。"""

from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
import json
import os
import socket
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_core.utils.function_calling import convert_to_openai_tool
from langchain_deepseek import ChatDeepSeek

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction import cli_support
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.errors import ExtractionInvalidOutputError, ExtractionRuntimeError
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
from notalone.memory_extraction.models import (
    AssertionStatus, ExtractedFact, FactSubject, FigurativeType, MemoryTopic, SpeechAct,
)
from notalone.memory.models import MemoryCategory
from notalone.memory_extraction.verification_adapters import (
    LangChainSourceVerificationRuntime, source_verification_contract,
)
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import deepseek_uses_thinking
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3_runtime import response


class VerificationToolChoiceTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {
            "NOTALONE_DISABLE_DOTENV": "1",
            "NOTALONE_DEEPSEEK_API_KEY": "synthetic-secret",
            "NOTALONE_DEEPSEEK_MODEL": "deepseek-flash",
            "NOTALONE_DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        }, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_official_factory_preserves_thinking_and_omits_only_v_tool_choice(self) -> None:
        source = window("我刚到家。")
        draft = {"units": {"0:0": {key: value for key, value in row("0:0", "event").items()
                                    if key != "unit"}}}
        result = {"candidate_index": 0, "verdict": "supported", "issues": [],
                  "evidence": [{"message_id": str(source.messages[0].message_id),
                                "quote": source.messages[0].text}]}
        requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            requests.append(body)
            name = body["tools"][0]["function"]["name"]
            payload = draft if name == "GroundedMemoryLabels" else {"results": [result]}
            return response(payload, name=name)

        traces = InMemoryTraceStore()
        scope = ContactScope(source.owner_id, source.contact_id)
        with ExitStack() as guards:
            client = guards.enter_context(build_trace_http_client(transport=httpx.MockTransport(handler)))
            guards.enter_context(patch.object(cli_support, "build_trace_http_client", return_value=client))
            for name in ("PostgresMemoryStore", "PostgresOwnerMemoryStore", "PostgresOutboundLedger",
                         "PostgresWatermarkStore", "PostgresExtractionTraceStore"):
                guards.enter_context(patch.object(cli_support, name, return_value=object()))
            model = cli_support.build_extraction_components("synthetic-no-database").model
            config = deepcopy(model.model_dump())
            stats = run_extraction(
                scope=scope, messages=source.messages, watermark_message_id=None,
                runtime=GroundedExtractionRuntime(model=model), memory_port=InMemoryMemoryStore(),
                owner_memory_port=None, trace_store=traces,
                verification_runtime=LangChainSourceVerificationRuntime(model=model),
            )
            self.assertEqual(model.model_dump(), config)
        self.assertEqual((stats.adopted, stats.pending, stats.rejected_by_contract), (0, 0, 1))
        self.assertEqual(len(requests), 2)
        for body in requests:
            self.assertEqual(body["thinking"], {"type": "enabled"})
            self.assertNotIn("reasoning_effort", body)
            self.assertNotIn("tool_choice", body)
        prompt, schema = source_verification_contract("legacy-v4")
        self.assertEqual(requests[1]["tools"], [convert_to_openai_tool(schema)])
        self.assertEqual(requests[1]["messages"][0], {"role": "system", "content": prompt})
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        events = [event["payload"] for event in detail["events"]
                  if event["stage"] == "model_request" and event["payload"]["purpose"] == "verification"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["tool_options"], {})

    def test_official_thinking_configuration_includes_defaults_efforts_and_conflicts(self) -> None:
        cases = [
            (None, None, True),
            ({"thinking": {"type": "enabled"}}, None, True),
            ({"thinking": {"type": "disabled"}}, None, False),
            (None, "none", False),
            ({"reasoning_effort": "none"}, None, False),
            ({"thinking": {"type": "disabled"}}, "none", False),
            ({"thinking": {"type": "enabled"}}, "none", True),
            ({"thinking": {"type": "disabled"}}, "high", True),
            ({"reasoning_effort": "none"}, "high", True),
            ({"reasoning_effort": "high"}, "none", True),
            ({"thinking": {"type": "enabled"}, "reasoning_effort": "none"}, None, True),
            ({"thinking": {"type": "disabled"}, "reasoning_effort": "max"}, None, True),
        ]
        cases += [(None, effort, True) for effort in ("low", "high", "max")]
        cases += [({"reasoning_effort": effort}, None, True) for effort in ("low", "high", "max")]
        for body, effort, expected in cases:
            for base_url in ("https://api.deepseek.com", "https://api.deepseek.com/v1"):
                with self.subTest(body=body, effort=effort, base_url=base_url):
                    model = ChatDeepSeek(api_key="synthetic-secret", model="deepseek-flash",
                                         base_url=base_url, extra_body=body, reasoning_effort=effort)
                    original = deepcopy(model.model_dump())
                    self.assertIs(deepseek_uses_thinking(model), expected)
                    self.assertEqual(model.model_dump(), original)

    def _verify_with_sdk(self, *, options: dict, mode: str = "legacy-v4",
                         invalid: str | None = None) -> list[dict]:
        source = window("我刚到家。")
        fact = ExtractedFact(
            text="联系人原话：“我刚到家。”", category=MemoryCategory.COMMON_FACT,
            subject=FactSubject.CONTACT, topic=MemoryTopic.OTHER,
            source_message_ids=(source.messages[0].message_id,), confidence=0.95,
            speech_act=SpeechAct.ASSERTION, assertion_status=AssertionStatus.ASSERTED,
            figurative_type=FigurativeType.LITERAL,
        )
        result = {"candidate_index": 0, "verdict": "supported", "issues": [],
                  "evidence": [{"message_id": str(source.messages[0].message_id),
                                "quote": source.messages[0].text}]}
        if mode != "legacy-v4":
            result["proof"] = None
        payload = {"results": [result]}
        if invalid == "extra_proof":
            result["proof"] = {"version": 2 if mode == "nullable-proof-v1" else 1,
                               "atom_links": None, "reference": None, "reported": None}
        elif invalid == "unknown_source":
            result["evidence"][0]["message_id"] = str(uuid4())
        elif invalid == "invented_quote":
            result["evidence"][0]["quote"] = "不存在的原文"
        elif invalid == "empty_evidence":
            result["evidence"] = []
        elif invalid == "extra_field":
            result["source_bound"] = True
        elif invalid == "missing_candidate":
            payload["results"] = []
        elif invalid == "duplicate_candidate":
            payload["results"] = [result, deepcopy(result)]
        reply = response(payload, name="WrongTool" if invalid == "wrong_tool" else "SourceVerificationOutput")
        completion = reply.json()
        message = completion["choices"][0]["message"]
        if invalid == "no_tool":
            message.pop("tool_calls")
            message["content"] = "只是自由文本"
        elif invalid == "many_tools":
            message["tool_calls"].append(deepcopy(message["tool_calls"][0]))
        requests: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(json.loads(request.content))
            return httpx.Response(200, json=completion)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            settings = {"model": "deepseek-flash", "base_url": "https://api.deepseek.com", **options}
            model = ChatDeepSeek(api_key="synthetic-secret", http_client=client, **settings)
            original = deepcopy(model.model_dump())
            runtime = LangChainSourceVerificationRuntime(model=model, verification_mode=mode)
            if invalid is not None:
                with self.assertRaises(ExtractionInvalidOutputError):
                    runtime.verify(window=source, facts=(fact,))
            else:
                self.assertEqual(runtime.verify(window=source, facts=(fact,)), (result,))
            self.assertEqual(model.model_dump(), original)
        self.assertEqual(len(requests), 1)
        _, schema = source_verification_contract(mode)
        self.assertEqual(requests[0]["tools"], [convert_to_openai_tool(schema)])
        return requests

    def test_sdk_modes_keep_schema_and_change_only_choice_for_actual_configuration(self) -> None:
        cases = [
            ({}, True),
            ({"extra_body": {"thinking": {"type": "enabled"}}}, True),
            ({"extra_body": {"thinking": {"type": "disabled"}}}, False),
            ({"reasoning_effort": "none"}, False),
            ({"extra_body": {"reasoning_effort": "none"}}, False),
            ({"extra_body": {"thinking": {"type": "enabled"}}, "reasoning_effort": "none"}, True),
            ({"extra_body": {"thinking": {"type": "disabled"}}, "reasoning_effort": "high"}, True),
            ({"extra_body": {"reasoning_effort": "none"}, "reasoning_effort": "high"}, True),
            ({"base_url": "https://proxy.example.test/v1", "extra_body": {"thinking": {"type": "enabled"}}}, False),
            ({"base_url": "https://api.deepseek.com/v2", "extra_body": {"thinking": {"type": "enabled"}}}, False),
            ({"model": "deepseek-chat", "extra_body": {"thinking": {"type": "enabled"}}}, False),
        ]
        cases += [({"reasoning_effort": effort}, True) for effort in ("low", "high", "max")]
        cases += [({"extra_body": {"reasoning_effort": effort}}, True) for effort in ("low", "high", "max")]
        for mode in ("legacy-v4", "nullable-proof-v1", "nullable-proof-v2"):
            for options, omitted in cases:
                with self.subTest(mode=mode, options=options):
                    body, = self._verify_with_sdk(options=options, mode=mode)
                    if omitted:
                        self.assertNotIn("tool_choice", body)
                    else:
                        self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": "SourceVerificationOutput"}})
                    extras = options.get("extra_body", {})
                    if "thinking" in extras:
                        self.assertEqual(body["thinking"], extras["thinking"])
                    else:
                        self.assertNotIn("thinking", body)
                    effort = extras.get("reasoning_effort", options.get("reasoning_effort"))
                    if effort is None:
                        self.assertNotIn("reasoning_effort", body)
                    else:
                        self.assertEqual(body["reasoning_effort"], effort)

    def test_omitted_choice_keeps_strict_rejection_without_extra_calls_in_all_modes(self) -> None:
        for mode in ("legacy-v4", "nullable-proof-v1", "nullable-proof-v2"):
            for invalid in ("no_tool", "wrong_tool", "many_tools", "extra_proof", "unknown_source",
                            "invented_quote", "empty_evidence", "extra_field", "missing_candidate", "duplicate_candidate"):
                with self.subTest(mode=mode, invalid=invalid):
                    body, = self._verify_with_sdk(options={"extra_body": {"thinking": {"type": "enabled"}}},
                                                  mode=mode, invalid=invalid)
                    self.assertNotIn("tool_choice", body)

    def test_supported_effort_aliases_preserve_exact_sdk_values(self) -> None:
        for mode in ("legacy-v4", "nullable-proof-v1", "nullable-proof-v2"):
            for effort in ("minimal", "medium", "xhigh", "ultra"):
                for extra in (False, True):
                    with self.subTest(mode=mode, effort=effort, extra=extra):
                        options = ({"extra_body": {"reasoning_effort": effort}} if extra
                                   else {"reasoning_effort": effort})
                        body, = self._verify_with_sdk(options=options, mode=mode)
                        self.assertNotIn("tool_choice", body)
                        self.assertEqual(body["reasoning_effort"], effort)

    def test_invalid_official_configuration_is_not_repaired_or_sent(self) -> None:
        for body in ({"thinking": True}, {"thinking": {"type": "invented"}},
                     {"thinking": {"type": "enabled", "extra": True}},
                     {"reasoning_effort": True}, {"reasoning_effort": "invented"}):
            with self.subTest(body=body):
                source = window("我刚到家。")
                fact = ExtractedFact(text="联系人已到家。", category=MemoryCategory.COMMON_FACT,
                                     subject=FactSubject.CONTACT, topic=MemoryTopic.OTHER,
                                     source_message_ids=(source.messages[0].message_id,), confidence=0.95)
                with httpx.Client(transport=httpx.MockTransport(
                    lambda _: self.fail("无效配置不得发送请求")
                )) as client:
                    model = ChatDeepSeek(api_key="synthetic-secret", model="deepseek-flash",
                                         base_url="https://api.deepseek.com", extra_body=body, http_client=client)
                    original = deepcopy(model.model_dump())
                    with self.assertRaises(ExtractionRuntimeError):
                        LangChainSourceVerificationRuntime(model=model).verify(window=source, facts=(fact,))
                    self.assertEqual(model.model_dump(), original)
