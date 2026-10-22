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
    def test_v4_uniqueness_factory_uses_explicit_prompt_without_changing_schema_or_old_defaults(self):
        from notalone.memory_extraction.evaluation_extraction import extraction_contract, extraction_runtime
        from notalone.memory_extraction.grounded_adapter import GROUNDED_V4_REFERENCE_UNIQUENESS_PROMPT

        window = synthetic_window()
        prompt, schema = extraction_contract("grounded-v4", window, prompt_profile="reference-uniqueness-v1")
        self.assertEqual(prompt, GROUNDED_V4_REFERENCE_UNIQUENESS_PROMPT)
        self.assertEqual(schema, extraction_contract("grounded-v4", window)[1])
        model = self.model(tool_name="GroundedMemoryLabelsV4", arguments={"units": {"1:0": {
            "kind": "preference", "subject": "contact", "topic": "other", "dependency": None,
            "unresolved": False, "ambiguity_codes": [], "confidence": 0.95, "sensitivity": "none",
        }}})
        facts = extraction_runtime("grounded-v4", model, prompt_profile="reference-uniqueness-v1").extract(window)
        self.assertEqual(self.requests[0][2]["messages"][0]["content"], prompt)
        self.assertEqual(facts[0]["alternatives"], [])
        for mode in ("legacy-e14", "grounded-v2", "grounded-v3"):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                extraction_contract(mode, window, prompt_profile="reference-uniqueness-v1")
            with self.subTest(runtime=mode), self.assertRaises(ValueError):
                extraction_runtime(mode, model, prompt_profile="reference-uniqueness-v1")
        self.assertEqual(len(self.requests), 1)

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
        from tests.support.ledger_adapters import InMemoryOutboundLedger
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

    def verify_synthetic_time_contract(
        self, *, source_time: str | None, source: str, candidate: str,
        valid_at: str | None, invalid_at: str | None,
        verdict: str = "supported", issues: tuple[str, ...] = (),
        category: MemoryCategory = MemoryCategory.RECENT_STATE,
        speech_act: SpeechAct = SpeechAct.PLAN,
    ) -> str:
        """真实 SDK 只接 Mock；裁决为预置回包，不模拟或认证模型日期推理。"""
        from notalone.memory_extraction.verification_adapters import (
            LangChainSourceVerificationRuntime,
        )

        self.requests.clear()
        expected = {
            "candidate_index": 0, "verdict": verdict, "issues": list(issues),
            "evidence": [{"message_id": str(TARGET_ID), "quote": source}],
        }
        model = self.model(
            tool_name="SourceVerificationOutput", arguments={"results": [expected]},
        )
        window = ExtractionWindow(
            owner_id=UUID("00000000-0000-4000-8000-000000000003"),
            contact_id=UUID("00000000-0000-4000-8000-000000000004"),
            messages=(MessageRef(
                message_id=TARGET_ID, text=source, sender=MessageSender.CONTACT,
                occurred_at=datetime.fromisoformat(source_time) if source_time else None,
            ),),
            target_message_ids=(TARGET_ID,),
        )
        fact = ExtractedFact(
            text=candidate, category=category, subject=FactSubject.CONTACT,
            topic=MemoryTopic.OTHER, source_message_ids=(TARGET_ID,), confidence=0.99,
            valid_at=datetime.fromisoformat(valid_at) if valid_at else None,
            invalid_at=datetime.fromisoformat(invalid_at) if invalid_at else None,
            speech_act=speech_act, assertion_status=AssertionStatus.ASSERTED,
            figurative_type=FigurativeType.LITERAL,
        )
        self.assertEqual(
            LangChainSourceVerificationRuntime(model=model).verify(window=window, facts=(fact,)),
            (expected,),
        )
        payload = self.wire_parameters(tool_name="SourceVerificationOutput")
        verification_input = json.loads(payload["messages"][1]["content"])
        self.assertEqual(verification_input, {
            "messages": [{
                "message_id": str(TARGET_ID), "role": "target", "sender": "contact",
                "occurred_at": source_time if source_time else "unknown", "text": source,
            }],
            "candidates": [{
                "candidate_index": 0, "text": candidate, "subject": "contact",
                "category": category.value, "topic": "other",
                "source_message_ids": [str(TARGET_ID)],
                "valid_at": valid_at, "invalid_at": invalid_at,
                "speech_act": speech_act.value, "assertion_status": "asserted",
                "figurative_type": "literal",
            }],
        })
        return payload["messages"][0]["content"]

    def test_verification_wire_carries_source_natural_day_contract_after_midnight(self) -> None:
        """合成零点后计划固定输入保真与提示合同，不能据 Mock 认证模型质量。"""
        prompt = self.verify_synthetic_time_contract(
            source_time="2034-04-01T00:07:00+05:45",
            source="合成测试：刚过零点还没休息，今天打算参观纸雕展。",
            candidate="联系人计划于2034年4月1日参观纸雕展。",
            valid_at="2034-04-01T00:00:00+05:45",
            invalid_at="2034-04-02T00:00:00+05:45",
        )
        for clause in (
            "来源occurred_at以其自身时区的自然日为锚点",
            "今天／明天／后天分别偏移0／1／2个日历日",
            "当地当日零点至次日零点的半开区间",
            "零点后的夜间对话或作息描述不回拨日期",
            "不得用运行日、机器今天或UTC日期代替来源本地日",
        ):
            self.assertIn(clause, prompt)

    def test_verification_wire_preserves_calendar_boundaries_and_local_offsets(self) -> None:
        """日期期望为公开合成字面量，覆盖午夜、闰日、年界与不同 UTC 日。"""
        for source_time, relative_day, date_text, valid_at, invalid_at in (
            ("2034-03-31T23:58:00+05:45", "今天", "2034年3月31日",
             "2034-03-31T00:00:00+05:45", "2034-04-01T00:00:00+05:45"),
            ("2034-03-31T23:58:00+05:45", "明天", "2034年4月1日",
             "2034-04-01T00:00:00+05:45", "2034-04-02T00:00:00+05:45"),
            ("2032-02-28T23:50:00-09:30", "明天", "2032年2月29日",
             "2032-02-29T00:00:00-09:30", "2032-03-01T00:00:00-09:30"),
            ("2032-02-28T23:50:00-09:30", "后天", "2032年3月1日",
             "2032-03-01T00:00:00-09:30", "2032-03-02T00:00:00-09:30"),
            ("2033-12-31T23:50:00-09:30", "明天", "2034年1月1日",
             "2034-01-01T00:00:00-09:30", "2034-01-02T00:00:00-09:30"),
            ("2033-12-31T23:50:00-09:30", "后天", "2034年1月2日",
             "2034-01-02T00:00:00-09:30", "2034-01-03T00:00:00-09:30"),
            ("2033-01-01T00:02:00+13:45", "今天", "2033年1月1日",
             "2033-01-01T00:00:00+13:45", "2033-01-02T00:00:00+13:45"),
        ):
            with self.subTest(source_time=source_time, relative_day=relative_day):
                prompt = self.verify_synthetic_time_contract(
                    source_time=source_time,
                    source=f"合成测试：{relative_day}打算参加地质讲座。",
                    candidate=f"联系人计划于{date_text}参加地质讲座。",
                    valid_at=valid_at, invalid_at=invalid_at,
                )
                self.assertIn("今天／明天／后天分别偏移0／1／2个日历日", prompt)

    def test_verification_wire_keeps_wrong_or_incomplete_periods_uncertain(self) -> None:
        """预置反控回包验证合同及原裁决通路，不把 Mock 当作语义判分器。"""
        for label, source_time, source, candidate, valid_at, invalid_at in (
            ("零点不回拨", "2034-04-01T00:07:00+05:45", "今天打算参观纸雕展。",
             "联系人计划于2034年3月31日参观纸雕展。",
             "2034-03-31T00:00:00+05:45", "2034-04-01T00:00:00+05:45"),
            ("相对日错移", "2034-03-31T23:58:00+05:45", "明天打算校准望远镜。",
             "联系人计划于2034年4月2日校准望远镜。",
             "2034-04-02T00:00:00+05:45", "2034-04-03T00:00:00+05:45"),
            ("时区偏移改变", "2034-04-01T00:07:00+05:45", "今天打算参观纸雕展。",
             "联系人计划于2034年4月1日参观纸雕展。",
             "2034-04-01T00:00:00+05:30", "2034-04-02T00:00:00+05:30"),
            ("来源时区未知", None, "明天打算校准望远镜。",
             "联系人计划于2034年4月2日校准望远镜。",
             "2034-04-02T00:00:00+05:45", "2034-04-03T00:00:00+05:45"),
            ("两日缩为一日", "2034-04-01T00:07:00+05:45", "明天和后天打算参观纸雕展。",
             "联系人计划于2034年4月2日至3日参观纸雕展。",
             "2034-04-02T00:00:00+05:45", "2034-04-03T00:00:00+05:45"),
            ("可核期间遗漏", "2034-04-01T00:07:00+05:45", "明天打算校准望远镜。",
             "联系人计划明天校准望远镜。", None, None),
        ):
            with self.subTest(case=label):
                prompt = self.verify_synthetic_time_contract(
                    source_time=source_time, source=f"合成测试：{source}",
                    candidate=candidate, valid_at=valid_at, invalid_at=invalid_at,
                    verdict="uncertain", issues=("time",),
                )
                self.assertIn(
                    "核验候选所填日期时，仅在来源时区、相对日期及完整期间与两时间槽均吻合且其他字段正确时supported",
                    prompt,
                )
                self.assertIn(
                    "缺时区、锚点未知、日期或时区偏移错误、期间遗漏或缩窄仍按time规则", prompt,
                )
                self.assertIn("不改变事件阶段或声称现实执行", prompt)

    def test_verification_wire_keeps_observation_history_and_vague_plan_rules(self) -> None:
        """相对自然日合同不覆盖瞬时观察点、历史双 null 或模糊计划双 null。"""
        for label, source, candidate, category, speech_act, valid_at, invalid_at, verdict in (
            ("瞬时观察点", "我现在还没装好模型。", "联系人目前还没装好模型。",
             MemoryCategory.RECENT_STATE, SpeechAct.ASSERTION,
             "2034-04-01T00:07:00+05:45", "2034-04-02T00:00:00+05:45", "supported"),
            ("瞬时点不能回到午夜", "我现在还没装好模型。", "联系人目前还没装好模型。",
             MemoryCategory.RECENT_STATE, SpeechAct.ASSERTION,
             "2034-04-01T00:00:00+05:45", "2034-04-02T00:00:00+05:45", "uncertain"),
            ("完成历史双空", "我刚刚完成纸雕作品。", "联系人已经完成纸雕作品。",
             MemoryCategory.COMMON_FACT, SpeechAct.ASSERTION, None, None, "supported"),
            ("历史不套来源日", "我刚刚完成纸雕作品。", "联系人已经完成纸雕作品。",
             MemoryCategory.COMMON_FACT, SpeechAct.ASSERTION,
             "2034-04-01T00:00:00+05:45", "2034-04-02T00:00:00+05:45", "uncertain"),
            ("模糊计划双空", "空闲以后打算校准望远镜。", "联系人打算空闲以后校准望远镜。",
             MemoryCategory.RECENT_STATE, SpeechAct.PLAN, None, None, "supported"),
            ("模糊计划不补日期", "空闲以后打算校准望远镜。", "联系人打算空闲以后校准望远镜。",
             MemoryCategory.RECENT_STATE, SpeechAct.PLAN,
             "2034-04-01T00:00:00+05:45", "2034-04-02T00:00:00+05:45", "uncertain"),
        ):
            with self.subTest(case=label):
                prompt = self.verify_synthetic_time_contract(
                    source_time="2034-04-01T00:07:00+05:45", source=f"合成测试：{source}",
                    candidate=candidate, category=category, speech_act=speech_act,
                    valid_at=valid_at, invalid_at=invalid_at, verdict=verdict,
                    issues=("time",) if verdict == "uncertain" else (),
                )
                for clause in (
                    "核验候选所填日期时",
                    "当前瞬时状态的valid_at取其证据occurred_at观察点",
                    "不接受其来源日作为历史动作有效期",
                    "两时间槽均null且其他字段吻合时应supported",
                    "计划不能升级为已发生",
                ):
                    self.assertIn(clause, prompt)

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
