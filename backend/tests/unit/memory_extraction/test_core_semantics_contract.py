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
from uuid import uuid4

import httpx

from notalone.memory_extraction.adapters import LangChainExtractionRuntime
from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime, GroundedV4ExtractionRuntime
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
            ("我后天在展馆值班。", "plan", "recent_state", "plan",
             "2027-01-06T00:00:00+08:00", "2027-01-07T00:00:00+08:00", False),
            ("我不知道后天是否要去展馆。", "state", "recent_state", "assertion",
             "2027-01-04T16:30:00+08:00", None, True),
            ("我还没决定明天去不去展馆。", "state", "recent_state", "assertion",
             "2027-01-04T16:30:00+08:00", None, True),
            ("我正在核对后天活动的名册。", "momentary_state", "recent_state", "assertion",
             "2027-01-04T16:30:00+08:00", "2027-01-05T00:00:00+08:00", True),
            ("我已经整理好明天要用的名册了。", "event", "common_fact", "assertion", None, None, True),
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

    def test_fixed_future_arrangement_guidance_reaches_production_sdk(self) -> None:
        source = window("我后天在展馆值班。", at=datetime(2027, 1, 4, 16, 30,
                      tzinfo=timezone(timedelta(hours=8))))
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            value = json.loads(request.content)
            requests.append(value)
            name = value["tools"][0]["function"]["name"]
            if name == "GroundedMemoryLabels":
                return response({"units": {"0:0": {key: value for key, value in row("0:0", "plan").items()
                                                   if key != "unit"}}}, name=name)
            return response({"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": str(source.messages[0].message_id),
                              "quote": source.messages[0].text}]}]}, name=name)

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
        self.assertIsNone(outcome.failure_reason)
        fact, = outcome.accepted
        self.assertEqual(fact.speech_act.value, "plan")
        self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
        projected = json.loads(requests[1]["messages"][1]["content"])["candidates"][0]
        self.assertEqual((projected["speech_act"], projected["valid_at"], projected["invalid_at"]),
                         ("plan", "2027-01-06T00:00:00+08:00", "2027-01-07T00:00:00+08:00"))
        # SDK标签与V结果均为给定；红绿只证明通用说明进入实际请求，不证明模型语义改善。
        prompt = requests[0]["messages"][0]["content"]
        for rule in ("既定日程", "自主打算", "知情", "长期身份", "时间词"):
            self.assertTrue(rule in prompt, f"实际提取请求缺少未来安排边界说明：{rule}")

    def test_faithful_vague_plan_guidance_reaches_existing_verifier_contracts_without_auto_adoption(self) -> None:
        source = window("我过些时候先在凉亭歇一会儿再去核对观测记录。")
        source = replace(source, messages=(replace(source.messages[0], sender=MessageSender.SELF),))
        for mode, profile in (("legacy-v4", "default"), ("legacy-v4", "public-author-quote-v1"),
                              ("nullable-proof-v1", "default"), ("nullable-proof-v2", "default")):
            for verdict, issues in (("supported", []), ("uncertain", ["pragmatics"])):
                with self.subTest(mode=mode, profile=profile, verdict=verdict):
                    requests = []

                    def handler(request: httpx.Request) -> httpx.Response:
                        value = json.loads(request.content)
                        requests.append(value)
                        name = value["tools"][0]["function"]["name"]
                        if name == "GroundedMemoryLabels":
                            return response({"units": {"0:0": {key: value for key, value in row(
                                "0:0", "plan", subject="self").items() if key != "unit"}}}, name=name)
                        result = {"candidate_index": 0, "verdict": verdict, "issues": issues,
                            "evidence": [{"message_id": str(source.messages[0].message_id),
                                          "quote": source.messages[0].text}]}
                        if mode != "legacy-v4":
                            result["proof"] = None
                        return response({"results": [result]}, name=name)

                    with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                        model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                     http_client=client)
                        outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                            verification_runtime=LangChainSourceVerificationRuntime(model=model,
                                verification_mode=mode, prompt_profile=profile)).run(source)
                    self.assertIsNone(outcome.failure_reason)
                    fact, = outcome.accepted
                    self.assertEqual((fact.text, fact.subject.value, fact.category.value, fact.speech_act.value,
                                      fact.assertion_status.value, fact.valid_at, fact.invalid_at),
                                     (f"用户原话：“{source.messages[0].text}”", "self", "recent_state", "plan",
                                      "asserted", None, None))
                    self.assertIn("grounded:unresolved_period", fact.risk_flags)
                    self.assertEqual(tuple(flag for flag in fact.risk_flags if flag.startswith("semantic:")),
                                     () if verdict == "supported" else ("semantic:pragmatics",))
                    self.assertEqual(PragmaticInterpreter().interpret(fact).disposition.value, "pending")
                    self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                    projected = json.loads(requests[1]["messages"][1]["content"])["candidates"][0]
                    self.assertEqual((projected["text"], projected["subject"], projected["speech_act"],
                                      projected["assertion_status"], projected["valid_at"], projected["invalid_at"]),
                                     (fact.text, "self", "plan", "asserted", None, None))
                    self.assertNotIn("risk_flags", projected)
                    # 给定标签与V判定只验实际SDK合同，不能证明模型语义改善或自动改判uncertain。
                    prompt = requests[1]["messages"][0]["content"]
                    for rule in ("现实是否执行", "能否自动采纳", "原时段本就模糊", "顺序、阶段及全部可知限定",
                                 "两时间槽均null", "可核定期间", "候选漏掉或改变"):
                        self.assertTrue(rule in prompt, f"实际核验请求缺少忠实计划边界说明：{rule}")

    def test_subjective_assessment_guidance_reaches_each_existing_verifier_contract(self) -> None:
        source = window("我觉得给盆栽记生长日志更容易发现变化。")
        source = replace(source, messages=(replace(source.messages[0], sender=MessageSender.SELF),))
        for mode, profile in (("legacy-v4", "default"), ("legacy-v4", "public-author-quote-v1"),
                              ("nullable-proof-v1", "default"), ("nullable-proof-v2", "default")):
            with self.subTest(mode=mode, profile=profile):
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    value = json.loads(request.content)
                    requests.append(value)
                    name = value["tools"][0]["function"]["name"]
                    if name == "GroundedMemoryLabels":
                        return response({"units": {"0:0": {key: value for key, value in row("0:0", "assessment",
                            subject="self").items() if key != "unit"}}}, name=name)
                    result = {"candidate_index": 0, "verdict": "supported", "issues": [],
                        "evidence": [{"message_id": str(source.messages[0].message_id),
                                      "quote": source.messages[0].text}]}
                    if mode != "legacy-v4":
                        result["proof"] = None
                    return response({"results": [result]}, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model,
                            verification_mode=mode, prompt_profile=profile)).run(source)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                self.assertEqual((fact.subject.value, fact.category.value, fact.speech_act.value),
                                 ("self", "relationship_note", "assertion"))
                self.assertEqual(fact.text, f"用户原话：“{source.messages[0].text}”")
                self.assertTrue(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                projected = json.loads(requests[1]["messages"][1]["content"])["candidates"][0]
                self.assertEqual((projected["text"], projected["subject"]), (fact.text, "self"))
                self.assertEqual((projected["valid_at"], projected["invalid_at"]), (None, None))
                # 给定assessment与supported只验证接线，不能代签模型正确理解主观评价。
                prompt = requests[1]["messages"][0]["content"]
                for rule in ("主观观点", "现实普遍性", "虚构引述", "主观归属"):
                    self.assertTrue(rule in prompt, f"实际核验请求缺少主观评价边界说明：{rule}")

    def test_given_opinion_verdicts_keep_author_objectification_irony_and_unknown_boundaries(self) -> None:
        opinion = "我觉得给盆栽记生长日志更容易发现变化。"
        retained = "用户认为给盆栽记生长日志更容易发现变化。"
        controls = (
            (opinion, retained, "supported", [], 1, True),
            (opinion, retained, "uncertain", ["pragmatics"], 1, False),
            (opinion, "给盆栽记生长日志必定更容易发现变化。", "unsupported", ["meaning"], 0, False),
            ("我今天给盆栽浇了水。", retained, "unsupported", ["meaning"], 0, False),
            ("我觉得自己可真厉害，又把花盆碰倒了。", "用户觉得自己很擅长照顾花草。", "unsupported", ["meaning"], 0, False),
            ("我开玩笑说这株花成精了。", "用户认为自己养了一株成精的花。", "unsupported", ["meaning"], 0, False),
            ("有人觉得这种记录方式最好。", "用户觉得这种记录方式最好。", "uncertain", ["subject"], 1, False),
        )
        # 全部判定为给定V控制；合成uncertain保持原样，不将旧捕获或模型误判自动改为supported。
        for text, candidate, verdict, issues, count, auto in controls:
            with self.subTest(verdict=verdict, issues=issues, source=text):
                source = window(text)
                source = replace(source, messages=(replace(source.messages[0], sender=MessageSender.SELF),))
                original = _payload(source.messages[0].message_id, text=candidate, subject="self",
                                    category="relationship_note")

                def handler(request: httpx.Request) -> httpx.Response:
                    evidence = [] if verdict != "supported" else [{
                        "message_id": str(source.messages[0].message_id), "quote": text}]
                    return response({"results": [{"candidate_index": 0, "verdict": verdict,
                        "issues": issues, "evidence": evidence}]}, name="SourceVerificationOutput")

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=RecordingRuntime((original,)),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                self.assertEqual(len(outcome.accepted), count)
                if count:
                    fact, = outcome.accepted
                    self.assertEqual((fact.text, fact.subject.value, fact.speech_act.value,
                                      fact.assertion_status.value, fact.valid_at, fact.invalid_at),
                                     (candidate, "self", "assertion", "asserted", None, None))
                    self.assertEqual(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)), auto)
                    for issue in issues:
                        self.assertIn(f"semantic:{issue}", fact.risk_flags)

    def test_elliptical_current_judgment_guidance_reaches_existing_verifier_contracts(self) -> None:
        source = window("不会呀。")
        question = replace(source.messages[0], message_id=uuid4(), sender=MessageSender.SELF,
                           text="以后你会觉得给盆栽做观察记录很枯燥吗？")
        source = replace(source, messages=(question, *source.messages))
        for mode, profile in (("legacy-v4", "default"), ("legacy-v4", "public-author-quote-v1"),
                              ("nullable-proof-v1", "default"), ("nullable-proof-v2", "default")):
            with self.subTest(mode=mode, profile=profile):
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    value = json.loads(request.content)
                    requests.append(value)
                    name = value["tools"][0]["function"]["name"]
                    if name == "GroundedMemoryLabels":
                        return response({"units": {"1:0": {key: value for key, value in row("1:0", "assessment",
                            dependency="0:0").items() if key != "unit"}}}, name=name)
                    result = {"candidate_index": 0, "verdict": "supported", "issues": [],
                        "evidence": [{"message_id": str(source.messages[1].message_id), "quote": "不会呀。"}]}
                    if mode != "legacy-v4":
                        result["proof"] = None
                    return response({"results": [result]}, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model,
                            verification_mode=mode, prompt_profile=profile)).run(source)
                self.assertIsNone(outcome.failure_reason)
                fact, = outcome.accepted
                self.assertEqual((fact.subject.value, fact.speech_act.value, fact.assertion_status.value,
                                  fact.valid_at, fact.invalid_at), ("contact", "assertion", "asserted", None, None))
                self.assertEqual(fact.text, f"联系人原话：“不会呀。”（相关原文：用户说“{question.text}”）")
                projected = json.loads(requests[1]["messages"][1]["content"])
                candidate = projected["candidates"][0]
                self.assertEqual(candidate["text"], fact.text)
                self.assertEqual(candidate["source_message_ids"],
                                 [str(source.messages[1].message_id), str(question.message_id)])
                self.assertEqual([message["role"] for message in projected["messages"]], ["context", "target"])
                self.assertNotIn("kind", candidate)
                self.assertTrue(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                # 给定assessment和supported仅验SDK合同；不证明模型已正确判断省略回答。
                prompt = requests[1]["messages"][0]["content"]
                for rule in ("完整问答", "当前判断", "assessment标签", "确定未来结果"):
                    self.assertTrue(rule in prompt, f"实际核验请求缺少省略问答边界说明：{rule}")

    def test_future_current_judgment_guidance_reaches_extraction_sdk(self) -> None:
        """给定 assessment 与 V 回包只核提示、完整问答和原编译接线。"""
        source = window("不会。", at=datetime(2035, 6, 10, 11, tzinfo=timezone(timedelta(hours=5, minutes=45))))
        answer = source.messages[0]
        question = replace(answer, message_id=uuid4(), sender=MessageSender.SELF,
                           text="你觉得往后会把星图的方向看反吗？")
        source = replace(source, messages=(question, answer))
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            value = json.loads(request.content)
            requests.append(value)
            name = value["tools"][0]["function"]["name"]
            if name == "GroundedMemoryLabels":
                return response({"units": {"1:0": {key: value for key, value in row(
                    "1:0", "assessment", dependency="0:0").items() if key != "unit"}}}, name=name)
            return response({"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": str(answer.message_id), "quote": answer.text}]}]}, name=name)

        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
        self.assertIsNone(outcome.failure_reason)
        fact, = outcome.accepted
        self.assertEqual((fact.text, fact.category.value, fact.subject.value, fact.speech_act.value,
                          fact.assertion_status.value, fact.valid_at, fact.invalid_at),
                         (f"联系人原话：“不会。”（相关原文：用户说“{question.text}”）",
                          "relationship_note", "contact", "assertion", "asserted", None, None))
        self.assertEqual(fact.source_message_ids, (answer.message_id, question.message_id))
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["messages"][1]["content"],
                         f"[0:0] [context] sender=self occurred_at=2035-06-10T11:00:00+05:45 原文={question.text}\n"
                         "[1:0] [target] sender=contact occurred_at=2035-06-10T11:00:00+05:45 原文=不会。")
        candidate, = json.loads(requests[1]["messages"][1]["content"])["candidates"]
        self.assertEqual(candidate["text"], fact.text)
        self.assertEqual(candidate["source_message_ids"], [str(answer.message_id), str(question.message_id)])
        self.assertEqual((candidate["speech_act"], candidate["valid_at"], candidate["invalid_at"]),
                         ("assertion", None, None))
        for rule in (
            "assessment也可表达对未来行为的当前明确判断或预测",
            "未来时间词和简短肯定／否定本身不证明行动安排",
            "省略回答保留理解必需的问句dependency",
        ):
            self.assertTrue(rule in requests[0]["messages"][0]["content"], f"实际E请求缺少判断／计划边界：{rule}")

    def test_given_future_judgment_labels_keep_plans_limits_and_verifier_downgrades(self) -> None:
        """公开合成标签及裁决只验既有接线，不模拟模型分类或要求 V 支持。"""
        controls = (
            {"label": "明确日程", "text": "我已安排明天去修复工坊。", "kind": "plan",
             "category": "recent_state", "speech": "plan", "valid": "2035-06-11T00:00:00+05:45",
             "invalid": "2035-06-12T00:00:00+05:45"},
            {"label": "明示承诺", "text": "我保证明天到修复工坊报到。", "kind": "plan",
             "category": "recent_state", "speech": "plan", "sensitivity": "commitment",
             "valid": "2035-06-11T00:00:00+05:45", "invalid": "2035-06-12T00:00:00+05:45"},
            {"label": "当前知情", "text": "我还不知道明天展厅是否开放。", "kind": "state",
             "category": "recent_state", "valid": "2035-06-10T11:00:00+05:45",
             "prefix": "截至2035-06-10，"},
            {"label": "仅有假设", "text": "假设明天换展柜。", "kind": "hypothesis",
             "category": "recent_state", "speech": "plan", "assertion": "hypothetical",
             "valid": "2035-06-11T00:00:00+05:45", "invalid": "2035-06-12T00:00:00+05:45"},
            {"label": "缺必要问句", "text": "不会。", "verdict": "uncertain",
             "issues": ["disconnected_context"]},
            {"label": "错误作者", "text": "不会。", "dependency": "0:0", "subject": "self",
             "verdict": "unsupported", "issues": ["subject"]},
            {"label": "原未知不翻案", "text": "不会。", "dependency": "0:0",
             "verdict": "uncertain", "issues": ["pragmatics"]},
            {"label": "简短肯定判断", "text": "会。", "dependency": "0:0"},
        )
        for control in controls:
            with self.subTest(control=control["label"]):
                source = window(control["text"], at=datetime(
                    2035, 6, 10, 11, tzinfo=timezone(timedelta(hours=5, minutes=45))))
                answer = source.messages[0]
                question = replace(answer, message_id=uuid4(), sender=MessageSender.SELF,
                                   text="你觉得往后会把星图的方向看反吗？")
                source = replace(source, messages=(question, answer))
                verdict = control.get("verdict", "supported")
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    value = json.loads(request.content)
                    requests.append(value)
                    name = value["tools"][0]["function"]["name"]
                    if name == "GroundedMemoryLabels":
                        return response({"units": {"1:0": {key: value for key, value in row(
                            "1:0", control.get("kind", "assessment"),
                            dependency=control.get("dependency"), subject=control.get("subject", "contact"),
                            sensitivity=control.get("sensitivity", "none")).items() if key != "unit"}}}, name=name)
                    return response({"results": [{"candidate_index": 0, "verdict": verdict,
                        "issues": control.get("issues", []), "evidence": [] if verdict != "supported" else [
                            {"message_id": str(answer.message_id), "quote": answer.text}]}]}, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                self.assertEqual(len(requests), 2)
                candidate, = json.loads(requests[1]["messages"][1]["content"])["candidates"]
                context = f"（相关原文：用户说“{question.text}”）" if control.get("dependency") else ""
                self.assertEqual(candidate["text"],
                                 f"{control.get('prefix', '')}联系人原话：“{answer.text}”{context}")
                self.assertEqual(candidate["source_message_ids"], [str(answer.message_id), *(
                    [str(question.message_id)] if control.get("dependency") else [])])
                self.assertEqual((candidate["category"], candidate["subject"], candidate["speech_act"],
                                  candidate["assertion_status"], candidate["valid_at"], candidate["invalid_at"]),
                                 (control.get("category", "relationship_note"), control.get("subject", "contact"),
                                  control.get("speech", "assertion"), control.get("assertion", "asserted"),
                                  control.get("valid"), control.get("invalid")))
                for rule in (
                    "明示未来日程、意图、安排或承诺仍用plan并保留原敏感性",
                    "当前不知道或未决定仍用state",
                    "来源仅表达可能性、假设、条件或转引时保留原限定",
                    "不能借assessment抹掉限定或改成确定结果",
                ):
                    self.assertTrue(rule in requests[0]["messages"][0]["content"], f"实际E请求缺少原限定：{rule}")
                if verdict == "unsupported":
                    self.assertEqual(outcome.accepted, ())
                    self.assertEqual(outcome.rejected_count, 1)
                else:
                    fact, = outcome.accepted
                    self.assertEqual(fact.text, candidate["text"])
                    self.assertEqual((fact.speech_act.value, fact.assertion_status.value),
                                     (candidate["speech_act"], candidate["assertion_status"]))
                    for issue in control.get("issues", []):
                        self.assertIn(f"semantic:{issue}", fact.risk_flags)
                    if control.get("sensitivity"):
                        self.assertIn("sensitivity:commitment", fact.risk_flags)
                        self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))

    def test_given_elliptical_verdicts_keep_missing_context_stage_and_ambiguity_boundaries(self) -> None:
        controls = (
            {"label": "给定uncertain不翻案", "verdict": "uncertain", "issues": ["pragmatics"]},
            {"label": "无问句", "with_question": False, "verdict": "uncertain", "issues": ["insufficient_evidence"]},
            {"label": "错否定对象", "candidate": "联系人表示以后不再做观察记录。", "verdict": "unsupported", "issues": ["negation"]},
            {"label": "升级完成", "candidate": "联系人已经做完观察记录。", "verdict": "unsupported", "issues": ["meaning"]},
            {"label": "确定未来结果", "candidate": "联系人确定以后绝对不会觉得观察记录枯燥。", "verdict": "unsupported", "issues": ["degree"]},
            {"label": "无据计划", "candidate": "联系人计划以后定期做观察记录。", "verdict": "unsupported", "issues": ["meaning"]},
            {"label": "无据承诺", "candidate": "联系人承诺以后坚持做观察记录。", "verdict": "unsupported", "issues": ["meaning"]},
            {"label": "推测", "answer": "也许不会吧。", "speech_act": "unknown", "assertion_status": "unknown", "verdict": "supported", "issues": []},
            {"label": "条件", "answer": "如果有空就不会。", "speech_act": "plan", "assertion_status": "conditional", "verdict": "supported", "issues": []},
            {"label": "真实歧义", "answer": "不好说。", "alternatives": ["本窗未明确这是当前判断还是未来推测。"], "verdict": "supported", "issues": []},
        )
        # 全部是合成给定判定；只核风险与原字段传播，不让新提示覆写旧uncertain或自证语义。
        for control in controls:
            with self.subTest(control=control["label"]):
                source = window(control.get("answer", "不会呀。"))
                answer = source.messages[0]
                with_question = control.get("with_question", True)
                question = replace(answer, message_id=uuid4(), sender=MessageSender.SELF,
                                   text="以后你会觉得给盆栽做观察记录很枯燥吗？")
                if with_question:
                    source = replace(source, messages=(question, answer))
                text = f"联系人原话：“{answer.text}”"
                if with_question:
                    text += f"（相关原文：用户说“{question.text}”）"
                speech = control.get("speech_act", "assertion")
                original = _payload(answer.message_id, text=control.get("candidate", text),
                    source_message_ids=[str(answer.message_id), *([str(question.message_id)] if with_question else [])],
                    category="recent_state" if speech == "plan" else "relationship_note",
                    speech_act=speech, assertion_status=control.get("assertion_status", "asserted"),
                    alternatives=control.get("alternatives", []))

                def handler(request: httpx.Request) -> httpx.Response:
                    evidence = [] if control["verdict"] != "supported" else [{
                        "message_id": str(answer.message_id), "quote": answer.text}]
                    return response({"results": [{"candidate_index": 0, "verdict": control["verdict"],
                        "issues": control["issues"], "evidence": evidence}]}, name="SourceVerificationOutput")

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=RecordingRuntime((original,)),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                if control["verdict"] == "unsupported":
                    self.assertEqual(outcome.accepted, ())
                else:
                    fact, = outcome.accepted
                    self.assertEqual((fact.text, fact.speech_act.value, fact.assertion_status.value,
                                      fact.alternatives, fact.valid_at, fact.invalid_at),
                                     (original["text"], speech, original["assertion_status"],
                                      tuple(original["alternatives"]), None, None))
                    self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                    if control["verdict"] == "uncertain":
                        for issue in control["issues"]:
                            self.assertIn(f"semantic:{issue}", fact.risk_flags)

    def test_given_v4_stable_identity_keeps_original_kind_and_null_validity(self) -> None:
        source = window("我一直是标本馆的讲解员。")

        def handler(request: httpx.Request) -> httpx.Response:
            return response({"units": {"0:0": {key: value for key, value in row("0:0", "stable_fact",
                ambiguity_codes=[]).items() if key != "unit"}}}, name="GroundedMemoryLabelsV4")

        # E2没有stable_fact；这里只控制既有显式v4，不扩E2协议或证明模型分类正确。
        with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
            model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                         http_client=client)
            facts = GroundedV4ExtractionRuntime(model=model).extract(source)
        self.assertEqual(len(facts), 1)
        self.assertEqual((facts[0]["category"], facts[0]["speech_act"]), ("common_fact", "assertion"))
        self.assertIsNone(facts[0]["valid_at"])
        self.assertIsNone(facts[0]["invalid_at"])

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
