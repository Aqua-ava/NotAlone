"""核心主张依赖保留显式前件；给定标签回归不代替模型质量验收。"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.memory_extraction.grounded import compile_labels
from notalone.memory_extraction.models import MessageRef, MessageSender
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels


class CoreDependencyRetentionTest(unittest.TestCase):
    def test_referenced_historical_fact_keeps_its_explicit_time_prefix(self) -> None:
        source = window("前年冬天，我表弟在书店做收银。")
        followup = MessageRef(uuid4(), "这段经历是他自己告诉我的。", MessageSender.CONTACT,
                              source.messages[0].occurred_at)
        source = replace(source, messages=(*source.messages, followup),
                         target_message_ids=(*source.target_message_ids, followup.message_id))
        draft = labels(row("0:0", "prefix"), row("0:1", "reported_event"),
                       row("1:0", "reported_event", dependency="0:1"))
        original = deepcopy(draft)
        facts = compile_labels(source, draft)
        self.assertEqual(len(facts), 2)
        self.assertIn('联系人说“前年冬天，”', facts[1]["text"])
        self.assertLess(facts[1]["text"].index("前年冬天"), facts[1]["text"].index("我表弟"))
        self.assertEqual((facts[1]["speech_act"], facts[1]["assertion_status"]), ("report", "reported"))
        self.assertEqual(facts[1]["source_message_ids"],
                         [str(followup.message_id), str(source.messages[0].message_id)])
        self.assertIsNone(facts[1]["valid_at"])
        self.assertIsNone(facts[1]["invalid_at"])
        self.assertEqual(draft, original)

    def test_referenced_condition_keeps_both_members_and_external_source(self) -> None:
        source = window("如果周末有空，我就去露营。")
        context = MessageRef(uuid4(), "我先看日程再决定。", MessageSender.CONTACT,
                             source.messages[0].occurred_at)
        followup = MessageRef(uuid4(), "你说的安排我知道了。", MessageSender.SELF,
                              source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages, followup),
                         target_message_ids=(*source.target_message_ids, followup.message_id))
        for reference in ("1:0", "1:1"):
            with self.subTest(reference=reference):
                facts = compile_labels(source, labels(
                    row("1:0", "condition", dependency="0:0"),
                    row("1:1", "plan", dependency="1:0"),
                    row("2:0", "state", subject="self", dependency=reference)))
                self.assertEqual(facts[0]["assertion_status"], "conditional")
                for quote in ("如果周末有空，", "我就去露营。", "我先看日程再决定。"):
                    self.assertIn(quote, facts[1]["text"])
                self.assertEqual(set(facts[1]["source_message_ids"]),
                                 {str(m.message_id) for m in source.messages})
                self.assertNotIn("已经露营", facts[1]["text"])

    def test_plain_adjacent_fact_is_not_pulled_into_dependency(self) -> None:
        source = window("我喜欢喝茶。我今天在书店。")
        followup = MessageRef(uuid4(), "你说的地点我知道了。", MessageSender.SELF,
                              source.messages[0].occurred_at)
        source = replace(source, messages=(*source.messages, followup),
                         target_message_ids=(*source.target_message_ids, followup.message_id))
        facts = compile_labels(source, labels(row("0:0", "preference"), row("0:1", "state"),
                                              row("1:0", "state", subject="self", dependency="0:1")))
        self.assertNotIn("喝茶", facts[-1]["text"])
        self.assertIn("我今天在书店", facts[-1]["text"])

    def test_group_dependencies_keep_external_cycle_rejection(self) -> None:
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError

        source = window("前年冬天，我在书店做收银。去年夏天，我在花店整理花束。这些经历我都记得。")
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels(source, labels(
                row("0:0", "prefix", dependency="0:3"), row("0:1", "event"),
                row("0:2", "prefix", dependency="0:1"), row("0:3", "event"),
                row("0:4", "state", dependency="0:1")))

    def test_old_draft_and_v3_v4_keep_frozen_dependency_projection(self) -> None:
        from notalone.memory_extraction.grounded import compile_draft, compile_labels_v3, compile_labels_v4

        source = window("前年冬天，我在书店做收银。这段经历我记得。")
        items = (row("0:0", "prefix"), row("0:1", "event"), row("0:2", "state", dependency="0:1"))
        legacy = compile_draft(source, {"units": list(items)})
        self.assertNotIn("前年冬天", legacy[-1]["text"])
        coded = labels(*(dict({k: v for k, v in item.items() if k != "event"}, ambiguity_codes=[])
                         for item in items))
        for compile_facts in (compile_labels_v3, compile_labels_v4):
            self.assertNotIn("前年冬天", compile_facts(source, coded)[-1]["text"])

    def test_complete_context_survives_flow_without_creating_auto_authority(self) -> None:
        from notalone.memory_extraction.adoption import can_auto_adopt
        from notalone.memory_extraction.flow import ExtractionFlow
        from notalone.memory_extraction.pragmatics import PragmaticInterpreter
        from tests.unit.memory_extraction.test_flow import RecordingRuntime
        from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier

        source = window("前年冬天，我表弟在书店做收银。这段经历是他自己告诉我的。")
        draft = labels(row("0:0", "prefix"), row("0:1", "reported_event"),
                       row("0:2", "reported_event", dependency="0:1"))
        raw = compile_labels(source, draft)
        outcome = ExtractionFlow(runtime=RecordingRuntime(tuple(raw)),
                                 verification_runtime=SyntheticSupportingVerifier()).run(source)
        self.assertIsNone(outcome.failure_reason)
        self.assertEqual((len(raw), len(outcome.accepted), outcome.rejected_count), (2, 2, 0))
        for fact in outcome.accepted:
            self.assertIn("前年冬天", fact.text)
            self.assertEqual((fact.speech_act.value, fact.assertion_status.value), ("report", "reported"))
            self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
