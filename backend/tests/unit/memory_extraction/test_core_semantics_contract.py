"""核心事实提示的实际SDK合同；给定标签不代表模型已经正确理解来源。"""

from __future__ import annotations

import json
import os
import socket
import unittest
from contextlib import ExitStack
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx

from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
from notalone.memory_extraction.models import MessageSender
from notalone.memory_extraction.pragmatics import PragmaticInterpreter
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from tests.unit.memory_extraction.test_flow import _payload
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3_runtime import response


class CoreSemanticsContractTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_request_ownership_guidance_reaches_extraction_without_reversing_given_subject(self) -> None:
        for sender in (MessageSender.CONTACT, MessageSender.SELF):
            source = window("本周先不要给我打语音。")
            source = replace(source, messages=(replace(source.messages[0], sender=sender),))
            fact = _payload(source.messages[0].message_id, text="本周先不要给我打语音。",
                            subject=sender.value, category="relationship_note", speech_act="request")
            for runtime_type, tool_name, draft in (
                (LangChainExtractionRuntime, "MemoryExtractionOutput", {"facts": [fact]}),
                (GroundedExtractionRuntime, "GroundedMemoryLabels", {
                    "units": {"0:0": {key: value for key, value in row("0:0", "request", subject=sender.value).items()
                                      if key != "unit"}},
                }),
            ):
                with self.subTest(sender=sender, runtime=runtime_type.__name__):
                    requests = []

                    def handler(request: httpx.Request) -> httpx.Response:
                        requests.append(json.loads(request.content))
                        return response(draft, name=tool_name)

                    with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                        model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                     http_client=client)
                        facts = runtime_type(model=model).extract(source)
                    self.assertEqual(len(facts), 1)
                    self.assertEqual((facts[0]["subject"], facts[0]["speech_act"]), (sender.value, "request"))
                    self.assertEqual(facts[0]["source_message_ids"], [str(source.messages[0].message_id)])
                    prompt = requests[0]["messages"][0]["content"]
                    for rule in ("请求者", "受话者", "不必等于subject", "转述第三方请求"):
                        self.assertTrue(rule in prompt, f"实际提取请求缺少请求归属说明：{rule}")

    def test_verifier_receives_request_ownership_and_given_subject_mismatch_rejects(self) -> None:
        source = window("本周先不要给我打语音。")
        correct = _payload(source.messages[0].message_id, text="联系人提出本周先不要给其打语音。",
                           category="relationship_note", speech_act="request")
        wrong = {**correct, "subject": "self"}
        for mode, profile in (("legacy-v4", "default"), ("legacy-v4", "public-author-quote-v1"),
                              ("nullable-proof-v1", "default"), ("nullable-proof-v2", "default")):
            with self.subTest(mode=mode, profile=profile):
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    requests.append(json.loads(request.content))
                    results = [
                        {"candidate_index": 0, "verdict": "supported", "issues": [],
                         "evidence": [{"message_id": str(source.messages[0].message_id),
                                       "quote": source.messages[0].text}]},
                        {"candidate_index": 1, "verdict": "unsupported", "issues": ["subject"], "evidence": []},
                    ]
                    if mode != "legacy-v4":
                        for result in results:
                            result["proof"] = None
                    return response({"results": results}, name="SourceVerificationOutput")

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=RecordingRuntime((correct, wrong)),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model,
                            verification_mode=mode, prompt_profile=profile)).run(source)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                self.assertEqual((fact.subject.value, fact.speech_act.value), ("contact", "request"))
                self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                projected = json.loads(requests[0]["messages"][1]["content"])
                self.assertEqual(projected["messages"][0]["sender"], "contact")
                self.assertEqual([value["subject"] for value in projected["candidates"]], ["contact", "self"])
                self.assertEqual([value["text"] for value in projected["candidates"]], [correct["text"], correct["text"]])
                prompt = requests[0]["messages"][0]["content"]
                for rule in ("请求者", "受话者", "原样引用", "unsupported/subject"):
                    self.assertTrue(rule in prompt, f"实际核验请求缺少请求归属说明：{rule}")

    def test_given_subjects_keep_request_recipient_report_and_shared_boundaries(self) -> None:
        # 标签和V结果均为给定控制；不把这些结果计作模型正确识别主体。
        controls = (
            (MessageSender.CONTACT, "本周先不要给我打语音。", "request", "contact",
             "relationship_note", "request", "asserted", False),
            (MessageSender.SELF, "本周先不要给我打语音。", "request", "self",
             "relationship_note", "request", "asserted", False),
            (MessageSender.CONTACT, "你已经收好实验记录了。", "event", "self",
             "common_fact", "assertion", "asserted", True),
            (MessageSender.SELF, "你已经收好实验记录了。", "event", "contact",
             "common_fact", "assertion", "asserted", True),
            (MessageSender.CONTACT, "我们已经一起完成观测了。", "event", "shared",
             "common_fact", "assertion", "asserted", True),
            (MessageSender.CONTACT, "我们明天一起整理图谱。", "plan", "shared",
             "recent_state", "plan", "asserted", False),
            (MessageSender.CONTACT, "我妹妹已经请你帮她校订说明书了。", "reported_event", "contact",
             "relationship_note", "report", "reported", False),
            (MessageSender.SELF, "我妹妹已经请你帮她校订说明书了。", "reported_event", "self",
             "relationship_note", "report", "reported", False),
        )
        for sender, text, kind, subject, category, speech, status, auto in controls:
            source = window(text)
            source = replace(source, messages=(replace(source.messages[0], sender=sender),))
            fact = _payload(source.messages[0].message_id, text=text, subject=subject, category=category,
                            speech_act=speech, assertion_status=status)
            for runtime_type, tool_name, draft in (
                (LangChainExtractionRuntime, "MemoryExtractionOutput", {"facts": [fact]}),
                (GroundedExtractionRuntime, "GroundedMemoryLabels", {
                    "units": {"0:0": {key: value for key, value in row("0:0", kind, subject=subject).items()
                                      if key != "unit"}},
                }),
            ):
                with self.subTest(sender=sender, kind=kind, subject=subject, runtime=runtime_type.__name__):
                    requests = []

                    def handler(request: httpx.Request) -> httpx.Response:
                        value = json.loads(request.content)
                        requests.append(value)
                        name = value["tools"][0]["function"]["name"]
                        if name == "SourceVerificationOutput":
                            return response({"results": [{"candidate_index": 0, "verdict": "supported",
                                "issues": [], "evidence": [{"message_id": str(source.messages[0].message_id),
                                                            "quote": text}]}]}, name=name)
                        return response(draft, name=tool_name)

                    with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                        model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                     http_client=client)
                        outcome = ExtractionFlow(runtime=runtime_type(model=model),
                            verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                    self.assertIsNone(outcome.failure_reason)
                    accepted, = outcome.accepted
                    self.assertEqual((accepted.subject.value, accepted.category.value,
                                      accepted.speech_act.value, accepted.assertion_status.value),
                                     (subject, category, speech, status))
                    self.assertEqual(can_auto_adopt(accepted, PragmaticInterpreter().interpret(accepted)), auto)
                    projected = json.loads(requests[1]["messages"][1]["content"])
                    self.assertEqual(projected["messages"][0]["sender"], sender.value)
                    self.assertEqual(projected["candidates"][0]["subject"], subject)
                    self.assertEqual(projected["candidates"][0]["text"], accepted.text)
                    self.assertIn(text, accepted.text)

    def test_habit_rhetorical_guidance_reaches_legacy_and_production_extraction(self) -> None:
        source = window("我难道不是每个周末都照常去温室照料花草吗？")
        fact = _payload(source.messages[0].message_id, text="联系人每个周末照料花草。",
                        valid_at=None, invalid_at=None)
        for runtime_type, tool_name, draft in (
            (LangChainExtractionRuntime, "MemoryExtractionOutput", {"facts": [fact]}),
            (GroundedExtractionRuntime, "GroundedMemoryLabels", {
                "units": {"0:0": {key: value for key, value in row("0:0", "preference").items()
                                  if key != "unit"}},
            }),
        ):
            with self.subTest(runtime=runtime_type.__name__):
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    requests.append(json.loads(request.content))
                    return response(draft, name=tool_name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    facts = runtime_type(model=model).extract(source)
                self.assertEqual(len(facts), 1)
                self.assertEqual(facts[0]["category"], "preference")
                self.assertIsNone(facts[0]["valid_at"])
                self.assertIsNone(facts[0]["invalid_at"])
                self.assertEqual(facts[0]["source_message_ids"], [str(source.messages[0].message_id)])
                prompt = requests[0]["messages"][0]["content"]
                for rule in ("反问式强调", "习惯", "字面否定"):
                    self.assertTrue(rule in prompt, f"实际提取请求缺少语义说明：{rule}")

    def test_immediate_intention_guidance_reaches_extraction_and_given_plan_never_auto(self) -> None:
        source = window("我准备马上去寄包裹。")
        fact = _payload(source.messages[0].message_id, text="联系人准备去寄包裹。",
                        category="recent_state", speech_act="plan", valid_at=None, invalid_at=None)
        for runtime_type, tool_name, draft in (
            (LangChainExtractionRuntime, "MemoryExtractionOutput", {"facts": [fact]}),
            (GroundedExtractionRuntime, "GroundedMemoryLabels", {
                "units": {"0:0": {key: value for key, value in row("0:0", "plan").items()
                                  if key != "unit"}},
            }),
        ):
            with self.subTest(runtime=runtime_type.__name__):
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    value = json.loads(request.content)
                    requests.append(value)
                    name = value["tools"][0]["function"]["name"]
                    if name == "SourceVerificationOutput":
                        return response({"results": [{"candidate_index": 0, "verdict": "supported",
                            "issues": [], "evidence": [{"message_id": str(source.messages[0].message_id),
                                                        "quote": source.messages[0].text}]}]}, name=name)
                    return response(draft, name=tool_name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=runtime_type(model=model),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                accepted, = outcome.accepted
                self.assertEqual(accepted.speech_act.value, "plan")
                self.assertFalse(can_auto_adopt(accepted, PragmaticInterpreter().interpret(accepted)))
                self.assertTrue("即时意向" in requests[0]["messages"][0]["content"],
                                "实际提取请求未区分即时意向与已在进行")

    def test_shared_verifier_guidance_and_candidate_fields_reach_each_existing_contract(self) -> None:
        source = window("我难道不是每个周末都照常去温室照料花草吗？")
        fact = _payload(source.messages[0].message_id, text="联系人每个周末照料花草。")
        for mode, profile in (("legacy-v4", "default"), ("legacy-v4", "public-author-quote-v1"),
                              ("nullable-proof-v1", "default"), ("nullable-proof-v2", "default")):
            with self.subTest(mode=mode, profile=profile):
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    requests.append(json.loads(request.content))
                    result = {"candidate_index": 0, "verdict": "supported", "issues": [],
                        "evidence": [{"message_id": str(source.messages[0].message_id),
                                      "quote": source.messages[0].text}]}
                    if mode != "legacy-v4":
                        result["proof"] = None
                    return response({"results": [result]}, name="SourceVerificationOutput")

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=RecordingRuntime((fact,)),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model,
                            verification_mode=mode, prompt_profile=profile)).run(source)
                self.assertIsNone(outcome.failure_reason)
                self.assertEqual(len(outcome.accepted), 1)
                projected = json.loads(requests[0]["messages"][1]["content"])["candidates"][0]
                self.assertEqual(projected, {"candidate_index": 0, **{key: fact[key] for key in (
                    "text", "subject", "category", "topic", "source_message_ids", "valid_at", "invalid_at",
                    "speech_act", "assertion_status", "figurative_type")}})
                for rule in ("反问式强调", "无期限习惯", "即时意向"):
                    self.assertTrue(rule in requests[0]["messages"][0]["content"],
                                    f"实际核验请求缺少语义说明：{rule}")

    def test_given_production_types_keep_habit_current_history_and_intention_separate(self) -> None:
        at = datetime(2027, 1, 4, 16, 30, tzinfo=timezone(timedelta(hours=8)))
        controls = (
            ("我目前固定每周四练习篆刻。", "preference", "preference", "assertion", None, None, True),
            ("我正在修整花圃。", "momentary_state", "recent_state", "assertion",
             "2027-01-04T16:30:00+08:00", "2027-01-05T00:00:00+08:00", True),
            ("我已经整理好花圃了。", "event", "common_fact", "assertion", None, None, True),
            ("我正要去借书。", "plan", "recent_state", "plan", None, None, False),
        )
        # 类型与V判定均为合成给定；这里只反证编译／分流改坏正确标签的假设。
        for text, kind, category, speech, valid, invalid, auto in controls:
            with self.subTest(kind=kind):
                source = window(text, at=at)

                def handler(request: httpx.Request) -> httpx.Response:
                    name = json.loads(request.content)["tools"][0]["function"]["name"]
                    if name == "GroundedMemoryLabels":
                        return response({"units": {"0:0": {key: value for key, value in row("0:0", kind).items()
                                                           if key != "unit"}}}, name=name)
                    return response({"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                        "evidence": [{"message_id": str(source.messages[0].message_id), "quote": text}]}]}, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                self.assertEqual((fact.category.value, fact.speech_act.value), (category, speech))
                self.assertEqual(fact.valid_at.isoformat() if fact.valid_at else None, valid)
                self.assertEqual(fact.invalid_at.isoformat() if fact.invalid_at else None, invalid)
                self.assertEqual(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)), auto)

    def test_given_verifier_downgrades_preserve_fields_and_literal_negation_rejects(self) -> None:
        for text, candidate, verdict, issues, count in (
            ("我准备马上去寄包裹。", "联系人准备马上去寄包裹。", "uncertain", ["pragmatics"], 1),
            ("我从不去温室。", "联系人常去温室。", "unsupported", ["negation"], 0),
            ("你会去温室吗？", "联系人会去温室。", "unsupported", ["meaning"], 0),
        ):
            with self.subTest(verdict=verdict, issues=issues):
                source = window(text)
                original = _payload(source.messages[0].message_id, text=candidate,
                                    category="recent_state", speech_act="assertion")

                def handler(request: httpx.Request) -> httpx.Response:
                    return response({"results": [{"candidate_index": 0, "verdict": verdict,
                        "issues": issues, "evidence": []}]}, name="SourceVerificationOutput")

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=RecordingRuntime((original,)),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                self.assertEqual(len(outcome.accepted), count)
                if count:
                    fact, = outcome.accepted
                    self.assertEqual(fact.text, original["text"])
                    self.assertEqual(fact.speech_act.value, "assertion")
                    self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))


if __name__ == "__main__":
    unittest.main()
