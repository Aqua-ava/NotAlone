"""实际 E/V 适配器的离线 HTTP 序列化契约；不认证生产装配或供应商。"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import socket
import unittest
from contextlib import ExitStack
from datetime import datetime, timezone
from typing import Any
from unittest.mock import patch
from uuid import UUID

import httpx

from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractedFact,
    ExtractionWindow,
    FigurativeType,
    MessageRef,
    MessageSender,
    SpeechAct,
)
from notalone.memory.models import FactSubject, MemoryCategory, MemoryTopic


BASE_URL = "https://evaluation.invalid/v1"
ENDPOINT = f"{BASE_URL}/chat/completions"
REQUEST_MODEL = "synthetic-request-alias"
RESPONSE_MODEL = "synthetic-response-model"
CONTEXT_ID = UUID("00000000-0000-4000-8000-000000000001")
TARGET_ID = UUID("00000000-0000-4000-8000-000000000002")
TARGET_TEXT = "合成测试：我喜欢红茶。"


def synthetic_window() -> ExtractionWindow:
    return ExtractionWindow(
        owner_id=UUID("00000000-0000-4000-8000-000000000003"),
        contact_id=UUID("00000000-0000-4000-8000-000000000004"),
        messages=(
            MessageRef(
                message_id=CONTEXT_ID,
                text="合成测试：你喜欢什么饮品？",
                sender=MessageSender.SELF,
                occurred_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            ),
            MessageRef(
                message_id=TARGET_ID,
                text=TARGET_TEXT,
                sender=MessageSender.CONTACT,
                occurred_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
            ),
        ),
        target_message_ids=(TARGET_ID,),
    )


def synthetic_fact_payload() -> dict[str, Any]:
    return {
        "text": "联系人喜欢红茶。",
        "category": "preference",
        "subject": "contact",
        "topic": "other",
        "source_message_ids": [str(TARGET_ID)],
        "confidence": 0.99,
        "risk_flags": [],
        "valid_at": None,
        "invalid_at": None,
        "speech_act": "assertion",
        "assertion_status": "asserted",
        "figurative_type": "literal",
        "alternatives": [],
        "interpretation_reason": "合成来源直接表达饮品偏好。",
    }


class EvaluationWireContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # 替换整个环境对象，不读取或复制本机凭据和追踪设置。
        self.stack.enter_context(patch.object(os, "environ", {}))
        for module_name in ("httpx", "httpx2", "httpx._client", "httpx2._client"):
            module = importlib.import_module(module_name)
            for name in ("HTTPTransport", "AsyncHTTPTransport"):
                self.stack.enter_context(
                    patch.object(
                        module,
                        name,
                        side_effect=AssertionError("禁止构造真实网络 transport"),
                    )
                )
        for name in ("connect", "connect_ex"):
            self.stack.enter_context(
                patch.object(
                    socket.socket,
                    name,
                    side_effect=AssertionError("禁止真实 socket 连接"),
                )
            )
        self.stack.enter_context(
            patch.object(
                socket,
                "getaddrinfo",
                side_effect=AssertionError("禁止真实 DNS 查询"),
            )
        )
        self.model_type = importlib.import_module("langchain_deepseek").ChatDeepSeek
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def model(self, *, tool_name: str, arguments: dict[str, Any]) -> Any:
        def synthetic(request: httpx.Request) -> httpx.Response:
            # 只保留合成请求正文、方法和端点；不读取或保存请求头。
            self.requests.append(
                (request.method, str(request.url), json.loads(request.content))
            )
            return httpx.Response(
                200,
                request=request,
                json={
                    "id": "synthetic-completion",
                    "object": "chat.completion",
                    "created": 1,
                    "model": RESPONSE_MODEL,
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [{
                                "id": "synthetic-tool-call",
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": json.dumps(arguments),
                                },
                            }],
                        },
                        "finish_reason": "tool_calls",
                    }],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                },
            )

        sync_client = self.stack.enter_context(httpx.Client(
            transport=httpx.MockTransport(synthetic),
            trust_env=False,
            follow_redirects=False,
        ))
        async_client = httpx.AsyncClient(
            transport=httpx.MockTransport(synthetic),
            trust_env=False,
            follow_redirects=False,
        )
        self.stack.callback(lambda: asyncio.run(async_client.aclose()))
        # ChatDeepSeek 构造时同时建立两侧 SDK 客户端，必须显式隔离两侧。
        return self.model_type(
            api_key="synthetic-not-a-real-key",
            base_url=BASE_URL,
            model=REQUEST_MODEL,
            temperature=0.0,
            timeout=60.0,
            max_retries=2,
            extra_body={"thinking": {"type": "enabled"}},
            http_client=sync_client,
            http_async_client=async_client,
        )

    def wire_parameters(self, *, tool_name: str) -> dict[str, Any]:
        self.assertEqual(len(self.requests), 1)
        method, endpoint, payload = self.requests[0]
        self.assertEqual((method, endpoint), ("POST", ENDPOINT))
        self.assertEqual(payload["model"], REQUEST_MODEL)
        self.assertEqual(payload["temperature"], 0.0)
        self.assertIs(payload["stream"], False)
        self.assertEqual(payload["thinking"], {"type": "enabled"})
        self.assertEqual(payload["tool_choice"], {
            "type": "function", "function": {"name": tool_name},
        })
        for omitted in (
            "extra_body", "reasoning_effort", "response_format", "strict",
            "parallel_tool_calls", "max_tokens", "max_completion_tokens",
        ):
            self.assertNotIn(omitted, payload)
        self.assertEqual(len(payload["tools"]), 1)
        tool = payload["tools"][0]
        self.assertEqual(tool["type"], "function")
        self.assertEqual(tool["function"]["name"], tool_name)
        self.assertNotIn("strict", tool["function"])
        return payload

    def test_extraction_adapter_serializes_named_tool_and_source_contract(self) -> None:
        from notalone.memory_extraction.adapters import LangChainExtractionRuntime

        expected = synthetic_fact_payload()
        model = self.model(
            tool_name="MemoryExtractionOutput", arguments={"facts": [expected]},
        )
        result = LangChainExtractionRuntime(model=model).extract(synthetic_window())
        self.assertEqual(result, (expected,))
        self.assertEqual(model.max_retries, 2)
        self.assertEqual(model.request_timeout, 60.0)
        payload = self.wire_parameters(tool_name="MemoryExtractionOutput")
        parameters = payload["tools"][0]["function"]["parameters"]
        self.assertEqual(parameters["required"], ["facts"])
        self.assertIs(parameters["additionalProperties"], False)
        fact = parameters["properties"]["facts"]["items"]
        self.assertIs(fact["additionalProperties"], False)
        self.assertEqual(set(fact["required"]), {
            "text", "category", "subject", "topic", "source_message_ids",
            "confidence", "risk_flags", "valid_at", "invalid_at",
            "speech_act", "assertion_status", "figurative_type", "alternatives",
            "interpretation_reason",
        })
        self.assertEqual(fact["properties"]["subject"]["enum"],
                         ["self", "contact", "shared"])
        self.assertEqual(fact["properties"]["source_message_ids"]["minItems"], 1)
        self.assertEqual(fact["properties"]["invalid_at"]["anyOf"],
                         [{"type": "string"}, {"type": "null"}])
        self.assertEqual([message["role"] for message in payload["messages"]],
                         ["system", "user"])
        window_text = payload["messages"][1]["content"]
        self.assertIn(f"[context] [message_id={CONTEXT_ID}]", window_text)
        self.assertIn(f"[target] [message_id={TARGET_ID}]", window_text)
        self.assertIn(
            "occurred_at=2026-01-02T00:00:00+00:00 sender=contact", window_text,
        )
        self.assertIn(TARGET_TEXT, window_text)

    def test_verification_adapter_serializes_evidence_and_uses_reported_model(self) -> None:
        from notalone.ledger.adapters import InMemoryOutboundLedger
        from notalone.ledger.models import LedgerOutcome
        from notalone.memory_extraction.verification_adapters import (
            LangChainSourceVerificationRuntime,
        )

        expected = {
            "candidate_index": 0,
            "verdict": "supported",
            "issues": [],
            "evidence": [{"message_id": str(TARGET_ID), "quote": TARGET_TEXT}],
        }
        model = self.model(
            tool_name="SourceVerificationOutput",
            arguments={"results": [expected]},
        )
        window = synthetic_window()
        ledger = InMemoryOutboundLedger()
        fact = ExtractedFact(
            text="联系人喜欢红茶。",
            category=MemoryCategory.PREFERENCE,
            subject=FactSubject.CONTACT,
            topic=MemoryTopic.OTHER,
            source_message_ids=(TARGET_ID,),
            confidence=0.99,
            speech_act=SpeechAct.ASSERTION,
            assertion_status=AssertionStatus.ASSERTED,
            figurative_type=FigurativeType.LITERAL,
        )
        result = LangChainSourceVerificationRuntime(
            model=model, ledger=ledger, provider="synthetic-provider",
        ).verify(window=window, facts=(fact,))
        self.assertEqual(result, (expected,))
        payload = self.wire_parameters(tool_name="SourceVerificationOutput")
        parameters = payload["tools"][0]["function"]["parameters"]
        self.assertEqual(parameters["required"], ["results"])
        self.assertIs(parameters["additionalProperties"], False)
        results = parameters["properties"]["results"]
        self.assertEqual(results["maxItems"], 60)
        item = results["items"]
        self.assertIs(item["additionalProperties"], False)
        self.assertEqual(set(item["required"]),
                         {"candidate_index", "verdict", "issues", "evidence"})
        self.assertEqual(item["properties"]["verdict"]["enum"],
                         ["supported", "uncertain", "unsupported"])
        evidence = item["properties"]["evidence"]["items"]
        self.assertEqual(evidence["required"], ["message_id", "quote"])
        self.assertEqual(evidence["properties"]["quote"]["minLength"], 1)
        self.assertEqual([message["role"] for message in payload["messages"]],
                         ["system", "user"])
        verification_input = json.loads(payload["messages"][1]["content"])
        self.assertEqual(verification_input["messages"][1], {
            "message_id": str(TARGET_ID), "role": "target", "sender": "contact",
            "occurred_at": "2026-01-02T00:00:00+00:00", "text": TARGET_TEXT,
        })
        self.assertEqual(verification_input["candidates"], [{
            "candidate_index": 0, "text": "联系人喜欢红茶。", "subject": "contact",
            "category": "preference", "topic": "other",
            "source_message_ids": [str(TARGET_ID)], "valid_at": None,
            "invalid_at": None, "speech_act": "assertion",
            "assertion_status": "asserted", "figurative_type": "literal",
        }])
        entries = ledger.list_by_owner(window.owner_id)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].model_name, RESPONSE_MODEL)
        self.assertNotEqual(entries[0].model_name, REQUEST_MODEL)
        self.assertEqual(entries[0].outcome, LedgerOutcome.SUCCEEDED)
        self.assertEqual((entries[0].input_tokens, entries[0].output_tokens), (10, 5))

    def test_public_author_quote_profile_uses_existing_four_slots_with_explicit_prompt(self) -> None:
        from notalone.memory_extraction.flow import _to_fact
        from notalone.memory_extraction.verification_adapters import (
            LangChainSourceVerificationRuntime, SOURCE_VERIFICATION_SYSTEM_PROMPT,
        )

        expected = {"candidate_index": 0, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": str(TARGET_ID), "quote": TARGET_TEXT}]}
        model = self.model(tool_name="SourceVerificationOutput", arguments={"results": [expected]})
        result = LangChainSourceVerificationRuntime(
            model=model, verification_mode="legacy-v4", prompt_profile="public-author-quote-v1",
        ).verify(window=synthetic_window(), facts=(_to_fact(synthetic_fact_payload()),))
        self.assertEqual(result, (expected,))
        payload = self.wire_parameters(tool_name="SourceVerificationOutput")
        self.assertTrue(payload["messages"][0]["content"].startswith(SOURCE_VERIFICATION_SYSTEM_PROMPT))
        self.assertIn("不能把引文中的第三人改成作者", payload["messages"][0]["content"])
        self.assertIn("原话包装不是通行证", payload["messages"][0]["content"])
        item = payload["tools"][0]["function"]["parameters"]["properties"]["results"]["items"]
        self.assertEqual(set(item["properties"]), {"candidate_index", "verdict", "issues", "evidence"})
        self.assertFalse(item["additionalProperties"])

    def test_public_bound_model_parses_synthetic_response_metadata(self) -> None:
        from notalone.memory_extraction.adapters import EXTRACTION_SCHEMA
        from notalone.memory_extraction.verification_adapters import (
            SOURCE_VERIFICATION_SCHEMA,
        )

        for schema, argument_name in (
            (EXTRACTION_SCHEMA, "facts"), (SOURCE_VERIFICATION_SCHEMA, "results"),
        ):
            with self.subTest(tool_name=schema["title"]):
                self.requests.clear()
                model = self.model(
                    tool_name=schema["title"], arguments={argument_name: []},
                )
                message = model.bind_tools(
                    [schema], tool_choice=schema["title"],
                ).invoke([{"role": "user", "content": "合成元数据解析检查"}])
                self.wire_parameters(tool_name=schema["title"])
                self.assertEqual(message.response_metadata["model_name"],
                                 RESPONSE_MODEL)
                self.assertEqual(message.response_metadata["finish_reason"],
                                 "tool_calls")
                self.assertEqual(message.usage_metadata, {
                    "input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                    "input_token_details": {}, "output_token_details": {},
                })
                self.assertEqual(message.tool_calls[0]["name"], schema["title"])
                self.assertEqual(message.tool_calls[0]["args"], {argument_name: []})


if __name__ == "__main__":
    unittest.main()
