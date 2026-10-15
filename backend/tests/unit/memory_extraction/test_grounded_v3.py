"""显式受控歧义协议；旧协议与采纳边界独立保留。"""
from __future__ import annotations

import unittest
from dataclasses import replace
from uuid import uuid4

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.grounded import compile_labels, compile_labels_v3
from notalone.memory_extraction.models import MessageRef, MessageSender
from tests.unit.memory_extraction.test_grounded_extraction import row, window


def labels(*items: dict) -> dict:
    return {"units": {
        item["unit"]: {key: value for key, value in item.items() if key != "unit"}
        for item in items
    }}


class GroundedV3CompilerTest(unittest.TestCase):
    def test_identity_and_place_remain_separate_unknowns_without_inventing_people(self):
        source = window("他们下周末要来家里。")
        draft = labels(row("0:0", "plan", unresolved=True,
                           ambiguity_codes=["place_ownership", "entity_identity"]))

        fact, = compile_labels_v3(source, draft)

        self.assertEqual(fact["text"], "联系人原话：“他们下周末要来家里。”")
        self.assertEqual(fact["alternatives"], [
            "原句所指人物身份在本窗口无法唯一确定，保留原句。",
            "原句所指地点／家里归属在本窗口无法唯一确定，保留原句。",
        ])
        self.assertEqual(fact["subject"], "contact")
        self.assertEqual(fact["assertion_status"], "asserted")
        self.assertEqual(fact["valid_at"], "2026-10-24T00:00:00+08:00")
        self.assertEqual(fact["invalid_at"], "2026-10-26T00:00:00+08:00")

    def test_same_message_unknown_person_keeps_later_place_code_when_clauses_merge(self):
        source = window("她不是编剧，她住家里。")
        draft = labels(
            row("0:0", "third_party_fact", unresolved=True, ambiguity_codes=["entity_identity"]),
            row("0:1", "third_party_fact", unresolved=True,
                ambiguity_codes=["entity_identity", "place_ownership"]),
        )

        fact, = compile_labels_v3(source, draft)

        self.assertIn("她不是编剧", fact["text"])
        self.assertIn("她住家里", fact["text"])
        self.assertEqual(len(fact["alternatives"]), 2)
        self.assertIn("家里归属", fact["alternatives"][1])

    def test_merged_direction_explanations_keep_each_members_selected_context_clause(self):
        source = window("她借了，她没借。")
        context = MessageRef(uuid4(), "店员提到了租金，同事提到了借书。", MessageSender.SELF,
                             source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        draft = labels(
            row("1:0", "third_party_fact", dependency="0:0", unresolved=True,
                ambiguity_codes=["entity_identity"]),
            row("1:1", "third_party_fact", dependency="0:1", unresolved=True,
                ambiguity_codes=["entity_identity", "borrowing_direction"]),
        )

        fact, = compile_labels_v3(source, draft)

        self.assertEqual(len(fact["alternatives"]), 3)
        for explanation in fact["alternatives"][1:]:
            self.assertIn("店员提到了租金，", explanation)
            self.assertIn("同事提到了借书。", explanation)
            self.assertIn("她借了，", explanation)
            self.assertIn("她没借。", explanation)
        old_draft = {"units": {key: {name: value for name, value in item.items()
                                      if name != "ambiguity_codes"}
                               for key, item in draft["units"].items()}}
        old_fact, = compile_labels(source, old_draft)
        self.assertEqual({key: value for key, value in fact.items() if key != "alternatives"},
                         {key: value for key, value in old_fact.items() if key != "alternatives"})

    def test_both_borrowing_readings_quote_the_actual_person_negation_and_question(self):
        source = window("借了，阿齐没借。")
        question = MessageRef(uuid4(), "阿林借你钱了吗？", MessageSender.SELF,
                              source.messages[0].occurred_at)
        source = replace(source, messages=(question, *source.messages))
        draft = labels(
            row("1:0", "relationship_event", dependency="0:0", unresolved=True,
                ambiguity_codes=["borrowing_direction"], sensitivity="financial"),
            row("1:1", "relationship_event", dependency="0:0", unresolved=True,
                ambiguity_codes=["borrowing_direction"], sensitivity="financial"),
        )

        first, second = compile_labels_v3(source, draft)

        self.assertEqual(len(first["alternatives"]), 2)
        self.assertEqual(len(second["alternatives"]), 2)
        self.assertIn("向对方借入", second["alternatives"][0])
        self.assertIn("借给对方", second["alternatives"][1])
        for explanation in second["alternatives"]:
            self.assertIn("阿齐没借。", explanation)
            self.assertIn("阿林借你钱了吗？", explanation)
            self.assertIn("人物与是否发生均以同条原引句为准", explanation)
        self.assertEqual(second["risk_flags"], ["sensitivity:financial"])

    def test_direction_explanation_rejects_oversize_instead_of_truncating_a_negation(self):
        within_budget = window("某" * 8300 + "没借。")
        valid = labels(row("0:0", "relationship_event", unresolved=True,
                           ambiguity_codes=["borrowing_direction"]))
        fact, = compile_labels_v3(within_budget, valid)
        self.assertTrue(all("没借。" in text and len(text) <= 8400 for text in fact["alternatives"]))
        source = window("某" * 8500 + "没借。")
        draft = labels(row("0:0", "relationship_event", unresolved=True,
                           ambiguity_codes=["borrowing_direction"]))

        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels_v3(source, draft)

    def test_corrupt_ambiguity_contract_never_discards_unknown_fields_or_codes(self):
        source = window("原定事项还不清楚。")
        valid = row("0:0", "unknown", unresolved=True, ambiguity_codes=["other_unresolved"])
        for changes in (
            {"ambiguity_codes": []}, {"ambiguity_codes": ["entity_identity", "entity_identity"]},
            {"ambiguity_codes": ["made_up"]}, {"ambiguity_codes": "entity_identity"},
            {"ambiguity_codes": [True]}, {"ambiguity_codes": [None]},
            {"unresolved": False}, {"unresolved": 1}, {"text": "模型补写正文"},
            {"alternatives": ["模型补写解释"]},
        ):
            with self.subTest(changes=changes), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels_v3(source, labels({**valid, **changes}))
        without_codes = {key: value for key, value in valid.items() if key != "ambiguity_codes"}
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels_v3(source, labels(without_codes))

    def test_v2_still_rejects_v3_fields_and_plain_v3_preserves_old_fourteen_slots(self):
        source = window("我已经取件了。")
        old = labels(row("0:0", "event"))
        new = labels(row("0:0", "event", ambiguity_codes=[]))

        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels(source, new)
        self.assertEqual(compile_labels_v3(source, new), compile_labels(source, old))
        unknown = labels(row("0:0", "unknown", unresolved=True))
        self.assertEqual(compile_labels(source, unknown)[0]["alternatives"],
                         ["原文指代在本窗口无法唯一确定，保留原句。"])

    def test_prefix_members_propagate_all_codes_and_lowest_confidence(self):
        source = window("在家里，他们下周要来。")
        draft = labels(
            row("0:0", "prefix", unresolved=True, ambiguity_codes=["place_ownership"], confidence=0.4),
            row("0:1", "plan", unresolved=True, ambiguity_codes=["entity_identity"], confidence=0.9),
        )

        fact, = compile_labels_v3(source, draft)

        self.assertEqual(fact["confidence"], 0.4)
        self.assertEqual(len(fact["alternatives"]), 2)
        self.assertIn("在家里，他们下周要来", fact["text"])

    def test_all_codes_have_fixed_order_and_at_most_five_explanations(self):
        source = window("所指人到家里借的事还不清楚。")
        draft = labels(row("0:0", "unknown", unresolved=True, ambiguity_codes=[
            "other_unresolved", "borrowing_direction", "place_ownership", "entity_identity",
        ]))

        fact, = compile_labels_v3(source, draft)

        self.assertEqual(len(fact["alternatives"]), 5)
        self.assertIn("人物身份", fact["alternatives"][0])
        self.assertIn("家里归属", fact["alternatives"][1])
        self.assertIn("向对方借入", fact["alternatives"][2])
        self.assertIn("借给对方", fact["alternatives"][3])
        self.assertIn("其他未决解释", fact["alternatives"][4])

    def test_nested_negation_is_quoted_without_polarity_rewriting(self):
        for text in ("我没说她借了。", "并非没有借。", "如果没借就再问。"):
            with self.subTest(text=text):
                draft = labels(row("0:0", "unknown", unresolved=True,
                                   ambiguity_codes=["borrowing_direction"]))
                fact, = compile_labels_v3(window(text), draft)
                for explanation in fact["alternatives"]:
                    self.assertIn(text, explanation)
                    self.assertIn("本窗不确认此方向", explanation)
