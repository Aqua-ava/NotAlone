"""E2有限日历补全；仅核公开合成来源的实际编译。"""
from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import os
import socket
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.grounded import compile_draft, compile_labels, source_units
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
from notalone.memory_extraction.models import MessageRef, MessageSender
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels
from tests.unit.memory_extraction.test_grounded_v3_runtime import response


class E2CalendarFollowupTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_complete_weather_scenario_uses_its_single_container_without_proving_action(self) -> None:
        for time, start, end in (
            ("今天", "2026-12-30", "2026-12-31"),
            ("明天", "2026-12-31", "2027-01-01"),
            ("后天", "2027-01-01", "2027-01-02"),
            ("本周", "2026-12-28", "2027-01-04"),
            ("这周", "2026-12-28", "2027-01-04"),
            ("下周", "2027-01-04", "2027-01-11"),
            ("本周末", "2027-01-02", "2027-01-04"),
            ("这周末", "2027-01-02", "2027-01-04"),
            ("周末", "2027-01-02", "2027-01-04"),
            ("下周末", "2027-01-09", "2027-01-11"),
            ("下个月", "2027-01-01", "2027-02-01"),
            ("下月", "2027-01-01", "2027-02-01"),
        ):
            for kind, sender in (("condition", MessageSender.CONTACT), ("prefix", MessageSender.SELF)):
                with self.subTest(time=time, kind=kind, sender=sender):
                    source = window("假如" + time + "不降雨，我们就去云港参加研讨。",
                                    at=datetime(2026, 12, 30, 23, tzinfo=timezone(timedelta(hours=-5))))
                    source = replace(source, messages=(replace(source.messages[0], sender=sender),))
                    draft = labels(row("0:0", kind, confidence=0.73, sensitivity="health"),
                                   row("0:1", "plan", confidence=0.96))
                    original = deepcopy(draft)
                    fact, = compile_labels(source, draft)
                    self.assertEqual((fact["valid_at"], fact["invalid_at"]),
                                     (start + "T00:00:00-05:00", end + "T00:00:00-05:00"))
                    self.assertEqual(fact["assertion_status"], "conditional")
                    self.assertEqual(fact["risk_flags"], ["sensitivity:health"])
                    self.assertEqual(fact["confidence"], 0.73)
                    self.assertEqual(fact["text"], ("用户" if sender == MessageSender.SELF else "联系人")
                                     + "原话：“" + source.messages[0].text + "”")
                    self.assertEqual(fact["source_message_ids"], [str(source.messages[0].message_id)])
                    self.assertEqual(draft, original)

    def test_single_terminal_particle_is_calendar_only_and_keeps_the_complete_quote(self) -> None:
        for text in ("我们下月一起去澄港玩吧。", "你下个月准备参加研讨吧", "我下月去露营吧。"):
            for kind, assertion in (("plan", "asserted"), ("hypothesis", "hypothetical")):
                with self.subTest(text=text, kind=kind):
                    source = window(text, at=datetime(2028, 1, 31, 23, tzinfo=timezone(timedelta(hours=8))))
                    draft = labels(row("0:0", kind, confidence=0.82, sensitivity="health"))
                    original = deepcopy(draft)
                    fact, = compile_labels(source, draft)
                    self.assertEqual((fact["valid_at"], fact["invalid_at"]),
                                     ("2028-02-01T00:00:00+08:00", "2028-03-01T00:00:00+08:00"))
                    self.assertEqual(fact["assertion_status"], assertion)
                    self.assertEqual(fact["risk_flags"], ["sensitivity:health"])
                    self.assertEqual(fact["text"], "联系人原话：“" + text + "”")
                    self.assertEqual(draft, original)

    def test_complete_weather_is_separated_before_the_weekday_maximal_token(self) -> None:
        for connector in ("如果", "假如", "要是", "倘若", "若"):
            for weather in ("下雨", "降雨", "不下雨", "不降雨", "天晴"):
                for kind in ("condition", "prefix"):
                    with self.subTest(connector=connector, weather=weather, kind=kind):
                        source = window(connector + "下周" + weather + "，你就休息。")
                        draft = labels(row("0:0", kind), row("0:1", "plan"))
                        fact, = compile_labels(source, draft)
                        self.assertEqual(fact["assertion_status"], "conditional")
                        self.assertEqual((fact["valid_at"], fact["invalid_at"]),
                                         ("2026-10-19T00:00:00+08:00", "2026-10-26T00:00:00+08:00"))

        source = window("如果下周天天晴，你就休息。")
        fact, = compile_labels(source, labels(row("0:0", "prefix"), row("0:1", "plan")))
        self.assertEqual(fact["assertion_status"], "conditional")
        self.assertIsNone(fact["valid_at"])
        self.assertIsNone(fact["invalid_at"])

    def test_outer_weather_prefix_recovers_only_the_original_conditional_semantics(self) -> None:
        source = window("下周如果下周天晴，你就休息。")
        fact, = compile_labels(source, labels(row("0:0", "prefix"), row("0:1", "plan")))
        self.assertEqual(fact["assertion_status"], "conditional")
        self.assertEqual((fact["valid_at"], fact["invalid_at"]),
                         ("2026-10-19T00:00:00+08:00", "2026-10-26T00:00:00+08:00"))
        source = window("下周如果下周刮风，你就休息。")
        items = [row("0:0", "prefix"), row("0:1", "plan")]
        self.assertEqual(compile_labels(source, labels(*items)), compile_draft(source, {"units": items}))

    def test_weather_exception_requires_the_entire_condition_response_and_own_scope(self) -> None:
        for first, action in (
            ("如果下月刮风", "我就休息"),
            ("如果下月不降雨", "我休息"),
            ("如果下月不降雨", "我才休息"),
            ("如果下月前能完工", "我就休息"),
            ("如果下月前不降雨", "我就休息"),
            ("如果下月不降雨吧", "我就休息"),
            ("如果下周天不下雨", "我就休息"),
            ("如果下月不降雨", "我就不休息"),
            ("如果下月不降雨", "我就去澄港吧"),
            ("如果下月不降雨", "我就去澄港吗"),
            ("如果下月不降雨", "我就去澄港了"),
            ("如果下月不降雨", "我就参加评审下个月"),
            ("如果下月下周不降雨", "我就休息"),
        ):
            with self.subTest(first=first, action=action):
                source = window(first + "，" + action + "。")
                fact, = compile_labels(source, labels(row("0:0", "prefix"), row("0:1", "plan")))
                self.assertIsNone(fact["valid_at"])
                self.assertIsNone(fact["invalid_at"])
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])
                self.assertIn(source.messages[0].text, fact["text"])
                if "刮风" in first or "下月下周" in first:
                    items = [row("0:0", "prefix"), row("0:1", "plan")]
                    self.assertEqual((fact,), compile_draft(source, {"units": items}))

        for first, action, start, end in (
            ("如果下月不降雨", "我后天就休息", "2026-10-16T00:00:00+08:00", "2026-10-17T00:00:00+08:00"),
            ("下周如果下月天晴", "我下周五就休息", "2026-10-23T00:00:00+08:00", "2026-10-24T00:00:00+08:00"),
            ("下周如果下月天晴", "我本周五就休息", None, None),
        ):
            with self.subTest(first=first, action=action):
                fact, = compile_labels(window(first + "，" + action + "。"),
                                       labels(row("0:0", "condition"), row("0:1", "plan")))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))

    def test_weather_exception_does_not_add_members_anchors_targets_or_context(self) -> None:
        source = window("如果下月天晴，我就休息。")
        draft = labels(row("0:0", "prefix"), row("0:1", "plan"))
        prior = MessageRef(uuid4(), "下周另有安排。", MessageSender.SELF,
                           source.messages[0].occurred_at)
        for changed, changed_draft in (
            (replace(source, messages=(replace(source.messages[0], occurred_at=None),)), draft),
            (replace(source, target_message_ids=None), draft),
            (source, labels(row("0:0", "not_memory"), row("0:1", "plan"))),
            (replace(source, messages=(prior, *source.messages)),
             labels(row("1:0", "prefix", dependency="0:0"), row("1:1", "plan"))),
            (replace(source, messages=(*source.messages, *(MessageRef(uuid4(), "背景", MessageSender.SELF,
                prior.occurred_at) for _ in range(4)))), draft),
        ):
            with self.subTest(messages=len(changed.messages), draft=changed_draft):
                fact, = compile_labels(changed, changed_draft)
                self.assertIsNone(fact["valid_at"])
                self.assertIsNone(fact["invalid_at"])
                if len(changed.messages) == 2:
                    self.assertIn("用户说“下周另有安排。”", fact["text"])
                    self.assertEqual(len(fact["source_message_ids"]), 2)
        cross = replace(source, messages=(replace(source.messages[0], text="如果下月天晴，"),
            MessageRef(uuid4(), "我就休息。", MessageSender.SELF, prior.occurred_at)))
        cross = replace(cross, target_message_ids=tuple(message.message_id for message in cross.messages))
        for bad_source, bad_draft in (
            (cross, labels(row("0:0", "prefix"), row("1:0", "plan"))),
            (source, labels(row("0:0", "condition"), row("0:1", "not_memory"))),
            (source, labels(row("0:0", "prefix", dependency="9:0"), row("0:1", "plan"))),
            (source, labels(row("0:1", "plan"))),
        ):
            with self.subTest(draft=bad_draft), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels(bad_source, bad_draft)

    def test_particle_cannot_hide_tail_tokens_or_change_observation_and_request_dates(self) -> None:
        for text in ("我下月去澄港了吧。", "我下月去澄港吧吧。", "我下月去澄港吗。",
                     "我下月吧。", "我下月去吧。", "我下月去澄港吧！", "我下月去澄港吧，",
                     "我下月去澄港玩吧。另有安排。", "我下月去澄港吧；"):
            with self.subTest(text=text):
                source = window(text)
                draft = labels(*(row(unit.id, "plan" if index == 0 else "not_memory")
                                 for index, unit in enumerate(source_units(source))))
                fact, = compile_labels(source, draft)
                self.assertIsNone(fact["valid_at"])
                self.assertIsNone(fact["invalid_at"])
        for kind in ("state", "momentary_state", "request"):
            source = window("我下月去澄港吧。")
            item = row("0:0", kind)
            with self.subTest(kind=kind):
                self.assertEqual(compile_labels(source, labels(item)), compile_draft(source, {"units": [item]}))
        # 范围外表达不新增清除权限；旧短日结果保留，不冒称日历已核清。
        for text in ("我明天去澄港了吧。", "我明天去澄港吧吧。", "我明天去澄港吗。",
                     "我下月去澄港吧明天。", "我下月参加研讨吧下周。"):
            source = window(text)
            item = row("0:0", "plan")
            self.assertEqual(compile_labels(source, labels(item)), compile_draft(source, {"units": [item]}))

    def test_sdk_retains_both_original_drafts_through_raw_and_one_unchanged_v(self) -> None:
        for text, kinds, assertion in (
            ("倘若下月不降雨，我们就去澄港旅行。", ("prefix", "plan"), "conditional"),
            ("我们下月一起去澄港旅行吧。", ("plan",), "asserted"),
        ):
            for verdict in ("supported", "uncertain", "unsupported"):
                with self.subTest(text=text, verdict=verdict):
                    source = window(text)
                    draft = labels(*(row("0:" + str(index), kind, confidence=0.95)
                                     for index, kind in enumerate(kinds)))
                    original = deepcopy(draft)
                    requests = []

                    def handler(request: httpx.Request) -> httpx.Response:
                        body = json.loads(request.content)
                        requests.append(body)
                        name = body["tools"][0]["function"]["name"]
                        if name == "GroundedMemoryLabels":
                            return response(draft, name=name)
                        return response({"results": [{"candidate_index": 0, "verdict": verdict,
                            "issues": [] if verdict == "supported" else ["time"],
                            "evidence": [{"message_id": str(source.messages[0].message_id),
                                          "quote": source.messages[0].text}]}]}, name=name)

                    scope = ContactScope(source.owner_id, source.contact_id)
                    traces = InMemoryTraceStore()
                    with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                        model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                     http_client=client)
                        stats = run_extraction(scope=scope, messages=source.messages, watermark_message_id=None,
                            runtime=GroundedExtractionRuntime(model=model),
                            verification_runtime=LangChainSourceVerificationRuntime(model=model),
                            memory_port=InMemoryMemoryStore(), owner_memory_port=None, trace_store=traces)
                    detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
                    events = {event["stage"]: event["payload"] for event in detail["events"]}
                    self.assertEqual(events["grounded_draft"]["draft"], original)
                    final = events["grounded_compile"]["payloads"][0]
                    self.assertEqual(final["assertion_status"], assertion)
                    self.assertEqual((final["valid_at"], final["invalid_at"]),
                                     ("2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00"))
                    self.assertEqual(final["risk_flags"], [])
                    self.assertEqual(final["text"], "联系人原话：“" + text + "”")
                    self.assertEqual(events["candidate_raw"]["fields"], final)
                    self.assertEqual(events["extraction_return"]["payloads"][0], final)
                    self.assertEqual([request["tools"][0]["function"]["name"] for request in requests],
                                     ["GroundedMemoryLabels", "SourceVerificationOutput"])
                    self.assertIn("2026-11-01", json.dumps(requests[1], ensure_ascii=False))
                    self.assertEqual(stats.adopted, 0)
                    self.assertEqual(stats.pending, 0 if verdict == "unsupported" else 1)
