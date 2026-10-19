"""实际E2编译的有限字段语义；合成标签不认证模型质量。"""
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
from zoneinfo import ZoneInfo

import httpx

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.grounded import compile_draft, compile_labels
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


class E2FieldSemanticsTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_complete_uncertain_current_state_weakens_only_assertion(self) -> None:
        for text in ("我也许有些头晕。", "你可能稍微发烧。", "我们不一定咳嗽。"):
            with self.subTest(text=text):
                source = window(text)
                draft = labels(row("0:0", "state", sensitivity="health"))
                original = deepcopy(draft)
                fact, = compile_labels(source, draft)
                self.assertEqual(fact["assertion_status"], "unknown")
                self.assertEqual(fact["valid_at"], "2026-10-14T18:00:00+08:00")
                self.assertIsNone(fact["invalid_at"])
                self.assertEqual(fact["speech_act"], "assertion")
                self.assertEqual(fact["risk_flags"], ["sensitivity:health"])
                self.assertEqual(fact["text"], "截至2026-10-14，联系人原话：“" + text + "”")
                self.assertEqual(draft, original)

    def test_new_complete_condition_forms_compile_through_existing_named_labels(self) -> None:
        for prefix in ("你来春港的话", "你要是来河谷", "后天要是不降雨"):
            for kind in ("condition", "prefix"):
                with self.subTest(prefix=prefix, kind=kind):
                    source = window(prefix + "，我就去露营。")
                    draft = labels(row("0:0", kind, confidence=0.72, sensitivity="health"),
                                   row("0:1", "plan", confidence=0.96))
                    original = deepcopy(draft)
                    fact, = compile_labels(source, draft)
                    self.assertEqual(fact["assertion_status"], "conditional")
                    self.assertEqual(fact["text"], "联系人原话：“" + source.messages[0].text + "”")
                    self.assertEqual(fact["source_message_ids"], [str(source.messages[0].message_id)])
                    self.assertEqual(fact["confidence"], 0.72)
                    self.assertEqual(fact["risk_flags"][0], "sensitivity:health")
                    self.assertEqual(draft, original)

    def test_conditional_action_retains_its_own_time_and_finite_certainty_particle(self) -> None:
        for action in ("我明天一定请你吃饭", "我一定明天请你喝茶"):
            with self.subTest(action=action):
                source = window("你来春港的话，" + action + "。")
                fact, = compile_labels(source, labels(row("0:0", "condition"), row("0:1", "plan")))
                self.assertEqual(fact["assertion_status"], "conditional")
                self.assertEqual(fact["valid_at"], "2026-10-15T00:00:00+08:00")
                self.assertEqual(fact["risk_flags"], [])

    def test_conditional_container_allows_a_more_specific_action_period(self) -> None:
        for first, action, start, end in (
            ("下周如果天晴", "我下周五就休息", "2026-10-23T00:00:00+08:00", "2026-10-24T00:00:00+08:00"),
            ("明天如果天晴", "我明天下午三点就休息", "2026-10-15T15:00:00+08:00", "2026-10-16T00:00:00+08:00"),
            ("下周如果天晴", "我本周五就休息", None, None),
            ("明天如果天晴", "我后天就休息", None, None),
        ):
            for kind in ("condition", "prefix"):
                with self.subTest(first=first, action=action, kind=kind):
                    source = window(first + "，" + action + "。")
                    fact, = compile_labels(source, labels(row("0:0", kind), row("0:1", "plan")))
                    self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))
                    self.assertEqual(fact["assertion_status"], "conditional")
                    self.assertEqual(fact["risk_flags"], [] if start else ["grounded:unresolved_period"])
                    self.assertEqual(fact["text"], "联系人原话：“" + source.messages[0].text + "”")

        source = window("下周如果天晴，我下周五就休息。", at=datetime(2026, 10, 19, 2, tzinfo=timezone.utc))
        prior = MessageRef(uuid4(), "安排确认了吗？", MessageSender.SELF,
                           datetime(2026, 10, 18, 22, tzinfo=timezone.utc))
        source = replace(source, messages=(prior, *source.messages))
        draft = labels(row("1:0", "condition", dependency="0:0"), row("1:1", "plan"))
        fact, = compile_labels(source, draft)
        self.assertEqual(fact["valid_at"], "2026-10-30T00:00:00+00:00")
        # 必须用承载T0/TA的MAIN消息；MAIN无锚时不能借前文的较早日期。
        source = replace(source, messages=(prior, replace(source.messages[1], occurred_at=None)))
        fact, = compile_labels(source, draft)
        self.assertIsNone(fact["valid_at"])
        self.assertIsNone(fact["invalid_at"])

    def test_completion_condition_without_deadline_uses_the_same_finite_grammar(self) -> None:
        for first in ("能完工的话", "能完成评审的话", "能做完报告的话"):
            for kind in ("condition", "prefix"):
                with self.subTest(first=first, kind=kind):
                    source = window(first + "，我明天就休息。")
                    draft = labels(row("0:0", kind), row("0:1", "plan"))
                    original = deepcopy(draft)
                    fact, = compile_labels(source, draft)
                    self.assertEqual(fact["assertion_status"], "conditional")
                    self.assertEqual(fact["valid_at"], "2026-10-15T00:00:00+08:00")
                    self.assertEqual(fact["risk_flags"], [])
                    self.assertEqual(fact["text"], "联系人原话：“" + source.messages[0].text + "”")
                    self.assertEqual(draft, original)
        for first, action in (
            ("不能完工的话", "我明天就休息"),
            ("能完成的话", "我明天就休息"),
            ("能完成评审以后再说的话", "我明天就休息"),
            ("能完工另外再议的话", "我明天就休息"),
            ("能完工的话", "我明天就休息并且去春港"),
        ):
            source = window(first + "，" + action + "。")
            with self.subTest(first=first, action=action):
                with self.assertRaises(ExtractionInvalidOutputError):
                    compile_labels(source, labels(row("0:0", "condition"), row("0:1", "plan")))
                items = [row("0:0", "prefix"), row("0:1", "plan")]
                self.assertEqual(compile_labels(source, labels(*items)), compile_draft(source, {"units": items}))

    def test_complete_uncertain_plan_and_bare_clock_do_not_become_asserted_facts(self) -> None:
        for text in ("我也许下月去春港出差。", "我们将来可能去河谷发展。", "你不一定去吃饭。"):
            with self.subTest(text=text):
                fact, = compile_labels(window(text), labels(row("0:0", "plan")))
                self.assertEqual((fact["speech_act"], fact["assertion_status"]), ("plan", "unknown"))
        for text in ("今天我值班到九点。", "工作到十二点。", "我学习到两点。"):
            with self.subTest(text=text):
                fact, = compile_labels(window(text), labels(row("0:0", "state")))
                self.assertEqual((fact["speech_act"], fact["assertion_status"]), ("unknown", "unknown"))
                self.assertIsNone(fact["valid_at"])
                self.assertIsNone(fact["invalid_at"])

    def test_financial_challenge_requires_actual_complete_printed_dependency(self) -> None:
        source = window("后天 26万 到手，我贷款 4.2万 投资。")
        challenge = MessageRef(uuid4(), "你又吹牛了。", MessageSender.SELF,
                               source.messages[0].occurred_at)
        source = replace(source, messages=(*source.messages, challenge))
        for dependency, expected in (("1:0", "unknown"), (None, "literal")):
            with self.subTest(dependency=dependency):
                facts = compile_labels(source, labels(*(row("0:" + str(index), "plan", dependency=dependency)
                                                       for index in (0, 1))))
                self.assertEqual(len(facts), 2)
                for fact in facts:
                    self.assertEqual(fact["figurative_type"], expected)
                    self.assertEqual(len(fact["source_message_ids"]), 2 if dependency else 1)
                    if dependency:
                        self.assertTrue(fact["text"].endswith("（相关原文：用户说“你又吹牛了。”）"))
                self.assertIsNone(facts[1]["valid_at"])

    def test_source_calendar_computes_complete_weekdays_months_ranges_and_clock(self) -> None:
        for text, start, end in (
            ("我下周一入职。", "2026-10-19T00:00:00+08:00", "2026-10-20T00:00:00+08:00"),
            ("我周五去吃饭。", "2026-10-16T00:00:00+08:00", "2026-10-17T00:00:00+08:00"),
            ("我下周一到周三都在春港。", "2026-10-19T00:00:00+08:00", "2026-10-22T00:00:00+08:00"),
            ("我下个月准备去河谷参加培训。", "2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00"),
            ("我们约好下周五晚上七点吃饭。", "2026-10-23T19:00:00+08:00", "2026-10-24T00:00:00+08:00"),
        ):
            with self.subTest(text=text):
                source = window(text)
                fact, = compile_labels(source, labels(row("0:0", "plan", sensitivity="health")))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))
                self.assertEqual(fact["risk_flags"], ["sensitivity:health"])
                self.assertEqual(fact["assertion_status"], "asserted")

    def test_state_observation_and_explicit_event_period_are_distinct(self) -> None:
        for text, start, end in (
            ("本周临时在春港值班。", "2026-10-14T18:00:00+08:00", "2026-10-19T00:00:00+08:00"),
            ("本周一到周三临时在河谷值班。", "2026-10-12T00:00:00+08:00", "2026-10-15T00:00:00+08:00"),
        ):
            with self.subTest(text=text):
                fact, = compile_labels(window(text), labels(row("0:0", "state")))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))
                self.assertTrue(fact["text"].startswith("截至2026-10-14，"))
                self.assertEqual(fact["risk_flags"], [])

    def test_explicit_state_range_covers_all_finite_events_without_clamping_start(self) -> None:
        for text in ("本周一到周三休息。", "本周一到周三都去爬山。", "本周一到周三参加评审。"):
            with self.subTest(text=text):
                source = window(text)
                item = row("0:0", "state", sensitivity="health", confidence=0.83)
                before, = compile_draft(source, {"units": [item]})
                fact, = compile_labels(source, labels(item))
                self.assertEqual(fact, {**before, "valid_at": "2026-10-12T00:00:00+08:00",
                                       "invalid_at": "2026-10-15T00:00:00+08:00"})
        for text, kind in (
            ("本周一到周三休息。", "request"),
            ("本周一到周三情绪复杂。", "state"),
            ("本周一到周三左右休息。", "state"),
            ("本周一到周三休息并且去春港。", "state"),
            ("本周临时休息。", "state"),
            ("我有点头晕。", "state"),
        ):
            with self.subTest(text=text, kind=kind):
                source = window(text)
                item = row("0:0", kind)
                self.assertEqual(compile_labels(source, labels(item)), compile_draft(source, {"units": [item]}))
        fact, = compile_labels(window("本周临时在河谷值班。"), labels(row("0:0", "state")))
        self.assertEqual(fact["valid_at"], "2026-10-14T18:00:00+08:00")
        self.assertEqual(fact["invalid_at"], "2026-10-19T00:00:00+08:00")

    def test_condition_calendar_uses_outer_action_or_explicit_weather_scenario_time(self) -> None:
        for first, action, start, end in (
            ("明天要是不降雨", "我才去爬山", "2026-10-15T00:00:00+08:00", "2026-10-16T00:00:00+08:00"),
            ("如果周五前能完工", "我周末就休息", "2026-10-17T00:00:00+08:00", "2026-10-19T00:00:00+08:00"),
            ("如果下周天晴", "我就去露营", "2026-10-19T00:00:00+08:00", "2026-10-26T00:00:00+08:00"),
            ("如果下周不下雨", "我就去露营", "2026-10-19T00:00:00+08:00", "2026-10-26T00:00:00+08:00"),
        ):
            with self.subTest(first=first):
                source = window(first + "，" + action + "。")
                fact, = compile_labels(source, labels(row("0:0", "condition"), row("0:1", "plan")))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))
                self.assertEqual(fact["assertion_status"], "conditional")
                self.assertEqual(fact["risk_flags"], [] if start else ["grounded:unresolved_period"])

    def test_negative_rules_require_complete_units_and_compatible_original_kinds(self) -> None:
        for text, kind in (
            ("我可能有些头晕吗？", "state"), ("我可能有些头晕但没发烧。", "state"),
            ("据说我可能头晕。", "state"), ("我没有这种可能。", "state"),
            ("我可能去春港吗？", "plan"), ("也许我们去春港。", "plan"),
            ("我以后可能回河谷工作。", "plan"), ("我可能去去露营。", "plan"),
            ("今天我已经工作到十点。", "state"), ("今天我准备工作到十点。", "state"),
            ("明天我工作到十点。", "state"), ("[语音] 今天我工作到十点。", "state"),
        ):
            with self.subTest(text=text):
                source = window(text)
                item = row("0:0", kind)
                self.assertEqual(compile_labels(source, labels(item)), compile_draft(source, {"units": [item]}))
        for kind, assertion in (("hypothesis", "hypothetical"), ("reported_event", "reported"),
                                ("unknown", "unknown"), ("event", "asserted"), ("request", "asserted")):
            with self.subTest(kind=kind):
                fact, = compile_labels(window("我可能下月去河谷。"), labels(row("0:0", kind)))
                self.assertEqual(fact["assertion_status"], assertion)
        for kind in ("question", "nonliteral", "not_memory", "greeting"):
            self.assertEqual(compile_labels(window("我可能下月去河谷。"), labels(row("0:0", kind))), ())

    def test_all_three_go_activities_are_complete_events_not_opaque_places(self) -> None:
        for activity in ("露营", "爬山", "吃饭"):
            for text in ("我明天去" + activity + "。", "我明天" + activity + "。"):
                with self.subTest(text=text):
                    fact, = compile_labels(window(text), labels(row("0:0", "plan")))
                    self.assertEqual(fact["valid_at"], "2026-10-15T00:00:00+08:00")
                    self.assertEqual(fact["risk_flags"], [])
        for text in ("我下月去去露营。", "我下月去。", "我下月去入职。"):
            fact, = compile_labels(window(text), labels(row("0:0", "plan")))
            self.assertIsNone(fact["valid_at"])

    def test_calendar_unknown_can_clear_only_owned_unreliable_periods(self) -> None:
        for text in ("我明天下午三点半去春港。", "我明天晚上十二点去河谷。", "我明天十点去春港。"):
            for kind in ("plan", "state", "momentary_state", "request"):
                with self.subTest(text=text, kind=kind):
                    source = window(text)
                    item = row("0:0", kind, sensitivity="health")
                    fact, = compile_labels(source, labels(item))
                    before, = compile_draft(source, {"units": [item]})
                    if kind == "plan":
                        self.assertIsNone(fact["valid_at"])
                        self.assertIsNone(fact["invalid_at"])
                        self.assertEqual(fact["risk_flags"], ["sensitivity:health", "grounded:unresolved_period"])
                    else:
                        self.assertEqual(fact, before)
        # 一个未知尾串使完整接管失效，不因其中出现明天而清原已支持日期。
        for text in ("我明天去春港左右。", "我明天去春港以后去河谷。", "我明天游泳。"):
            source = window(text)
            item = row("0:0", "plan")
            self.assertEqual(compile_labels(source, labels(item)), compile_draft(source, {"units": [item]}))
        source = window("如果下周降雨，我才去露营。")
        fact, = compile_labels(source, labels(row("0:0", "condition"), row("0:1", "plan")))
        self.assertIsNone(fact["valid_at"])
        self.assertIn("grounded:unresolved_period", fact["risk_flags"])

    def test_calendar_boundaries_follow_source_local_calendar_without_wall_clock(self) -> None:
        for anchor, text, start, end in (
            (datetime(2026, 12, 31, 23, 20, tzinfo=timezone(timedelta(hours=14))), "我下月去春港。",
             "2027-01-01T00:00:00+14:00", "2027-02-01T00:00:00+14:00"),
            (datetime(2028, 1, 31, 1, tzinfo=timezone(timedelta(hours=-5))), "我下个月去日月港。",
             "2028-02-01T00:00:00-05:00", "2028-03-01T00:00:00-05:00"),
            (datetime(2028, 2, 28, 22, tzinfo=timezone(timedelta(hours=8))), "我后天去河谷。",
             "2028-03-01T00:00:00+08:00", "2028-03-02T00:00:00+08:00"),
            (datetime(2026, 10, 18, 18, tzinfo=timezone.utc), "我周末去爬山。",
             "2026-10-17T00:00:00+00:00", "2026-10-19T00:00:00+00:00"),
        ):
            with self.subTest(text=text, anchor=anchor):
                fact, = compile_labels(window(text, at=anchor), labels(row("0:0", "plan")))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))
        for anchor in (None,):
            source = window("我下个月去春港。")
            source = replace(source, messages=(replace(source.messages[0], occurred_at=anchor),))
            fact, = compile_labels(source, labels(row("0:0", "plan")))
            self.assertIsNone(fact["valid_at"])
        with self.assertRaises(ValueError):
            window("我下月去春港。", at=datetime(2026, 10, 14, 18))
        for zone, at in (("America/Santiago", (2024, 9, 6)), ("America/Havana", (2024, 11, 1))):
            with self.subTest(zone=zone):
                fact, = compile_labels(window("我后天去春港。", at=datetime(*at, 18, tzinfo=ZoneInfo(zone))),
                                       labels(row("0:0", "plan")))
                self.assertIsNone(fact["valid_at"])
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])

    def test_unrepresentable_calendar_boundaries_preserve_candidate_with_unknown_period(self) -> None:
        for anchor, time in ((datetime(9999, 12, 31, 18, tzinfo=timezone.utc), "明天"),
                             (datetime(1, 1, 1, 18, tzinfo=timezone(timedelta(hours=14))), "今天")):
            with self.subTest(anchor=anchor):
                fact, = compile_labels(window("我" + time + "去春港。", at=anchor), labels(row("0:0", "plan")))
                self.assertIsNone(fact["valid_at"])
                self.assertIsNone(fact["invalid_at"])
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])

    def test_unsupported_time_forms_and_competing_dependencies_do_not_get_shorter_periods(self) -> None:
        for text in ("我周一去春港。", "我下周三到周一去河谷。", "我下周一到下下周三去春港。",
                     "我下个月底去河谷。", "我半个月后去春港。", "我下个月去河谷半个月。",
                     "我下个月去春港下月去河谷。", "我下个月去春港上旬。"):
            with self.subTest(text=text):
                fact, = compile_labels(window(text), labels(row("0:0", "plan")))
                self.assertIsNone(fact["valid_at"])
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])
        # 范围外多动作/多时间不获清除权限；保留旧值并不认证其日期正确。
        outside = window("我下个月去春港明天下午三点。")
        item = row("0:0", "plan")
        self.assertEqual(compile_labels(outside, labels(item)), compile_draft(outside, {"units": [item]}))
        source = window("我下个月去春港。")
        prior = MessageRef(uuid4(), "下周去河谷。", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(prior, *source.messages))
        fact, = compile_labels(source, labels(row("1:0", "plan", dependency="0:0")))
        self.assertIsNone(fact["valid_at"])
        self.assertIn("用户说“下周去河谷。”", fact["text"])

    def test_target_scope_window_budget_and_candidate_budget_are_not_repaired(self) -> None:
        source = window("我可能有点头疼。")
        item = row("0:0", "state")
        for changed in (
            replace(source, target_message_ids=None),
            replace(source, messages=(*source.messages, *(MessageRef(uuid4(), "背景", MessageSender.SELF,
                    source.messages[0].occurred_at) for _ in range(4)))),
            replace(source, messages=(*source.messages, MessageRef(uuid4(), "字" * 4097,
                    MessageSender.SELF, source.messages[0].occurred_at))),
        ):
            with self.subTest(messages=len(changed.messages), targets=changed.target_message_ids):
                # None兼容路径的所有目标仍须完整交代，不能靠丢目标得到命中。
                self.assertEqual(compile_labels(changed, labels(item))[0]["assertion_status"], "asserted")
        extra = MessageRef(uuid4(), "字" * 4080, MessageSender.SELF, source.messages[0].occurred_at)
        extended = replace(source, messages=(extra, *source.messages))
        fact, = compile_labels(extended, labels(row("1:0", "state", dependency="0:0")))
        self.assertEqual(fact["assertion_status"], "asserted")
        self.assertGreater(len(fact["text"]), 4096)

    def test_financial_challenge_has_no_credit_from_partial_or_other_context(self) -> None:
        for claim, challenge, sender, third in (
            ("明天 17万 到手。", "你吹了。还有别的。", MessageSender.SELF, False),
            ("明天 17万 到手。", "你吹了。", MessageSender.CONTACT, False),
            ("明天 17万 到手。", "你吹了。", MessageSender.SELF, True),
            ("明天 17万 到手，还有一笔。", "你吹了。", MessageSender.SELF, False),
        ):
            source = window(claim)
            other = MessageRef(uuid4(), challenge, sender, source.messages[0].occurred_at)
            messages = (*source.messages, other)
            if third:
                messages += (MessageRef(uuid4(), "别的。", MessageSender.SELF, other.occurred_at),)
            source = replace(source, messages=messages)
            draft = labels(row("0:0", "plan", dependency="1:0"),
                           *([row("0:1", "state")] if "，" in claim else []))
            with self.subTest(claim=claim, challenge=challenge, sender=sender, third=third):
                self.assertEqual(compile_labels(source, draft)[0]["figurative_type"], "literal")

    def test_financial_challenge_uses_the_whole_supported_time_parameter(self) -> None:
        for time in ("下周四下午三点", "本周一到周三", "下月", "明天"):
            source = window(time + " 19.3万 到手。")
            challenge = MessageRef(uuid4(), "你开始吹了。", MessageSender.SELF, source.messages[0].occurred_at)
            source = replace(source, messages=(*source.messages, challenge))
            with self.subTest(time=time):
                fact, = compile_labels(source, labels(row("0:0", "plan", dependency="1:0")))
                self.assertEqual(fact["figurative_type"], "unknown")

    def test_new_condition_grammar_keeps_original_structure_and_reference_rejections(self) -> None:
        for text, second_kind in (("你来春港的话，我就去露营。", "state"),
                                  ("你来春港的话，我就去露营。", "not_memory"),
                                  ("你来春港的话；我就去露营。", "plan"),
                                  ("你来春港的话，我就去入职。", "plan")):
            with self.subTest(text=text, second_kind=second_kind), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels(window(text), labels(row("0:0", "condition"), row("0:1", second_kind)))
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels(window("他们明天会来家里。"), labels(row("0:0", "plan", unresolved=False)))
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels(window("你来春港的话，我就去露营。"),
                           labels(row("0:0", "condition", dependency="9:0"), row("0:1", "plan")))

    def test_sdk_retains_original_draft_and_final_raw_before_the_single_v(self) -> None:
        for verdict in ("supported", "uncertain", "unsupported"):
            with self.subTest(verdict=verdict):
                source = window("我也许下月去春港出差。")
                draft = labels(row("0:0", "plan", confidence=0.95))
                original = deepcopy(draft)
                requests = []

                def handler(request: httpx.Request) -> httpx.Response:
                    body = json.loads(request.content)
                    requests.append(body)
                    name = body["tools"][0]["function"]["name"]
                    if name == "GroundedMemoryLabels":
                        return response(draft, name=name)
                    return response({"results": [{"candidate_index": 0, "verdict": verdict,
                        "issues": [] if verdict == "supported" else ["pragmatics"],
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
                self.assertEqual(final["assertion_status"], "unknown")
                self.assertEqual(final["valid_at"], "2026-11-01T00:00:00+08:00")
                self.assertEqual(final["risk_flags"], [])
                self.assertEqual(events["candidate_raw"]["fields"], final)
                self.assertEqual(events["extraction_return"]["payloads"][0], final)
                self.assertEqual(len(requests), 2)
                self.assertEqual(stats.adopted, 0)
                self.assertEqual((stats.pending, stats.rejected_by_contract), (0, 1))
                self.assertNotIn("e2_field_semantics", events)

    def test_old_versions_keep_140_public_windows_across_six_given_kinds(self) -> None:
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.grounded import compile_labels_v3, compile_labels_v4, source_units

        sources = [build_window(case) for case in (*CASES, *SEMANTIC_CASES)]
        self.assertEqual(len(sources), 140)
        # 修改前4fe1cf9的实际公开编译结果；不读取Gold，不断言质量。
        for name, compiler, expected in (
            ("v1", compile_draft, "c60cf2e582872124ca6aa2339915de8da05f7a3c96652cef53aa526e78871505"),
            ("v3", compile_labels_v3, "9a8c10b1ae150fc9fda27835844afd1b7b690409def91bcc4b065892eff5a56d"),
            ("v4", compile_labels_v4, "8b58ca04572ad3236b6c041ed0efce74c2f40983fa36295ca853edc005014652"),
        ):
            with self.subTest(version=name):
                matrix = []
                for kind in ("event", "plan", "state", "momentary_state", "hypothesis", "request"):
                    compiled = []
                    for source in sources:
                        items = [row(unit.id, kind, unresolved=True, confidence=0.85,
                                     **({"ambiguity_codes": ["entity_identity"]} if name != "v1" else {}))
                                 for unit in source_units(source) if unit.target]
                        compiled.append(compiler(source, {"units": items} if name == "v1" else labels(*items)))
                    matrix.append(compiled)
                self.assertEqual(canonical_sha256(matrix), expected)
