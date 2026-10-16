"""显式v4纯编译行为；给定标签不是模型分类或质量证据。"""
from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels


class GroundedV4CompilerTest(unittest.TestCase):
    def test_explicit_ownership_unknown_is_visible_in_reason_without_rewriting_source(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        source = window("我姐把她的车借给我了。")
        clear, = compile_labels_v4(source, labels(row(
            "0:0", "relationship_event", topic="family", confidence=0.95, ambiguity_codes=[],
        )))
        unresolved, = compile_labels_v4(source, labels(row(
            "0:0", "relationship_event", topic="family", confidence=0.95, unresolved=True,
            ambiguity_codes=["object_ownership"],
        )))
        self.assertEqual(unresolved["interpretation_reason"],
                         "按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。"
                         " 当前未决说明：所引原句中的物品所有者在本窗口无法唯一确定；"
                         "不因出借或接收认定所有者，保留原句。")
        self.assertEqual(unresolved["alternatives"], [
            "所引原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。"
            " 所附原引句及上下文：联系人原话：“我姐把她的车借给我了。”",
        ])
        self.assertEqual({key: value for key, value in unresolved.items()
                          if key not in {"alternatives", "interpretation_reason"}},
                         {key: value for key, value in clear.items()
                          if key not in {"alternatives", "interpretation_reason"}})

    def test_ownership_and_identity_reasons_are_independent_and_canonically_ordered(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        fact, = compile_labels_v4(window("我姐把她的车借给我了。"), labels(row(
            "0:0", "relationship_event", topic="family", confidence=0.95, unresolved=True,
            ambiguity_codes=["object_ownership", "entity_identity"],
        )))
        self.assertEqual(fact["interpretation_reason"],
                         "按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。"
                         " 当前未决说明：原句所指人物身份在本窗口无法唯一确定，保留原句。"
                         "所引原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。")
        self.assertNotIn("我姐", fact["interpretation_reason"])
        self.assertEqual((fact["assertion_status"], fact["figurative_type"]), ("asserted", "literal"))

    def test_unlabelled_a05_keeps_original_auto_and_does_not_gain_unknowns(self):
        from notalone.memory_extraction.evaluation import build_window, evaluate_case
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.grounded import compile_labels_v4
        from tests.unit.memory_extraction.test_flow import RecordingRuntime
        from tests.unit.memory_extraction.verification_helpers import SyntheticSupportingVerifier

        # 同值于已封公开A05原标签；保留其auto失败，不用旧matcher判分救回。
        case = next(case for case in CASES if case.name == "指代：姐借车")
        source = build_window(case)
        payloads = compile_labels_v4(source, labels(row(
            "0:0", "relationship_event", topic="family", confidence=0.95, ambiguity_codes=[],
        )))
        self.assertEqual(payloads[0], {
            "text": "联系人原话：“我姐把她的车借给我了。”",
            "category": "relationship_note", "subject": "contact", "topic": "family",
            "source_message_ids": [str(source.messages[0].message_id)], "confidence": 0.95,
            "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [],
            "interpretation_reason": "按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。",
        })
        result = evaluate_case(case, source, RecordingRuntime(payloads),
                               verification_runtime=SyntheticSupportingVerifier())
        self.assertEqual(result.actual, "auto")
        self.assertTrue(result.verification_enabled)
        self.assertNotIn("semantic_basis", payloads[0])

    def test_completed_answer_reason_keeps_program_basis_before_explicit_unknown(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        from uuid import uuid4

        source = window("到了。")
        prior = MessageRef(uuid4(), "你到公司了吗？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(prior, *source.messages))
        # 人为给定未决码，仅核已有完成问答理由不会被替换；不认证语义选码。
        fact, = compile_labels_v4(source, labels(row(
            "1:0", "momentary_state", dependency="0:0", unresolved=True,
            ambiguity_codes=["entity_identity"],
        )))
        self.assertEqual(fact["interpretation_reason"],
                         "原文完成问答明确表示动作已完成，程序据此保留历史动作，不设置当天失效。"
                         " 当前未决说明：原句所指人物身份在本窗口无法唯一确定，保留原句。")
        self.assertEqual((fact["category"], fact["valid_at"], fact["invalid_at"]),
                         ("common_fact", None, None))

    def test_matter_reference_explicitly_preserves_unknown_matter_and_full_quote(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        fact, = compile_labels_v4(window("那件事情你暂时不要透露。"), labels(row(
            "0:0", "request", unresolved=True, ambiguity_codes=["matter_reference"],
        )))
        self.assertEqual(fact["text"], "截至2026-10-14，联系人原话：“那件事情你暂时不要透露。”")
        self.assertEqual(fact["alternatives"], [
            "所引原句中的事项指称在本窗口无法唯一识别；保留未知，不补事项内容或类型。"
            " 所附原引句及上下文：截至2026-10-14，联系人原话：“那件事情你暂时不要透露。”",
        ])
        self.assertEqual((fact["category"], fact["speech_act"], fact["assertion_status"]),
                         ("relationship_note", "request", "asserted"))
        self.assertNotIn("semantic_basis", fact)

    def test_matter_reference_unions_members_and_keeps_dependencies_risks_and_lowest_confidence(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        from uuid import uuid4

        source = window("那件事，暂时不要向他们透露。")
        context = MessageRef(uuid4(), "所指事项仍未说明。", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        fact, = compile_labels_v4(source, labels(
            row("1:0", "prefix", dependency="0:0", unresolved=True, confidence=0.4,
                sensitivity="other", ambiguity_codes=["matter_reference"]),
            row("1:1", "request", unresolved=True, ambiguity_codes=["entity_identity", "matter_reference"]),
        ))
        self.assertEqual(fact["confidence"], 0.4)
        self.assertEqual(fact["risk_flags"], ["sensitivity:other"])
        self.assertEqual(set(fact["source_message_ids"]), {str(message.message_id) for message in source.messages})
        self.assertEqual(len(fact["alternatives"]), 2)
        self.assertIn("人物身份", fact["alternatives"][0])
        self.assertIn("事项指称", fact["alternatives"][1])
        self.assertIn("那件事，暂时不要向他们透露。", fact["alternatives"][1])
        self.assertIn("所指事项仍未说明。", fact["alternatives"][1])

    def test_matter_reference_is_never_filled_from_words_or_generic_unknown_code(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        for text in ("那个事你先别跟别人说。", "周一的值班安排先不要告诉别人。"):
            with self.subTest(text=text):
                source = window(text)
                clear, = compile_labels_v4(source, labels(row("0:0", "request", ambiguity_codes=[])))
                generic, = compile_labels_v4(source, labels(row(
                    "0:0", "request", unresolved=True, ambiguity_codes=["other_unresolved"],
                )))
                self.assertEqual(clear["alternatives"], [])
                self.assertEqual(generic["alternatives"], ["原句在本窗口仍有其他未决解释，保留原句。"])

    def test_matter_reference_rejects_invalid_codes_and_stays_out_of_old_protocols(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels, compile_labels_v3, compile_labels_v4

        source = window("那项安排尚未说明。")
        valid = labels(row("0:0", "state", unresolved=True, ambiguity_codes=["matter_reference"]))
        for compile_old in (compile_labels, compile_labels_v3):
            with self.subTest(old=compile_old.__name__), self.assertRaises(ExtractionInvalidOutputError):
                compile_old(source, valid)
        for override in (
            {"unresolved": False}, {"ambiguity_codes": []},
            {"ambiguity_codes": ["matter_reference", "matter_reference"]},
            {"ambiguity_codes": ["invented_matter"]}, {"matter": "未给出的内容"},
        ):
            with self.subTest(override=override), self.assertRaises(ExtractionInvalidOutputError):
                draft = deepcopy(valid)
                draft["units"]["0:0"].update(override)
                compile_labels_v4(source, draft)

    def test_continuation_keeps_completed_action_quantity_and_question_in_one_candidate(self):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.grounded import compile_labels_v4

        source = build_window(next(case for case in CASES if case.name == "指代：门票"))
        fact, = compile_labels_v4(source, labels(
            row("1:0", "event", dependency="0:0", confidence=0.85, ambiguity_codes=[]),
            row("1:1", "continuation", dependency="1:0", confidence=0.55, ambiguity_codes=[]),
        ))
        self.assertEqual(fact["text"], "联系人原话：“买好了，两张。”（相关原文：用户说“门票买好了吗？”）")
        self.assertEqual(fact["confidence"], 0.55)
        self.assertEqual(set(fact["source_message_ids"]), {str(message.message_id) for message in source.messages})
        self.assertEqual((fact["category"], fact["speech_act"], fact["assertion_status"],
                          fact["figurative_type"], fact["valid_at"], fact["invalid_at"]),
                         ("common_fact", "assertion", "asserted", "literal", None, None))
        self.assertEqual((fact["risk_flags"], fact["alternatives"]), ([], []))
        self.assertNotIn("semantic_basis", fact)

    def test_continuation_unions_both_dependencies_risks_and_ambiguities_at_minimum_confidence(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        from uuid import uuid4

        # 风险和未知标签人为给定，只核成员传播，不认证分类正确。
        source = window("材料送到了，二十份。")
        contexts = tuple(MessageRef(uuid4(), text, MessageSender.SELF, source.messages[0].occurred_at)
                         for text in ("你答应送来的材料呢？", "指的是尚未确认归属的资料吗？"))
        source = replace(source, messages=(*contexts, *source.messages))
        fact, = compile_labels_v4(source, labels(
            row("2:0", "event", dependency="0:0", confidence=0.83, sensitivity="commitment",
                unresolved=True, ambiguity_codes=["other_unresolved"]),
            row("2:1", "continuation", dependency="1:0", confidence=0.46, sensitivity="other",
                unresolved=True, ambiguity_codes=["object_ownership"]),
        ))
        self.assertEqual(fact["text"], "联系人原话：“材料送到了，二十份。”"
                         "（相关原文：用户说“你答应送来的材料呢？”；用户说“指的是尚未确认归属的资料吗？”）")
        self.assertEqual(set(fact["source_message_ids"]), {str(message.message_id) for message in source.messages})
        self.assertEqual(fact["confidence"], 0.46)
        self.assertEqual(fact["risk_flags"], ["sensitivity:commitment", "sensitivity:other"])
        self.assertEqual(len(fact["alternatives"]), 2)
        self.assertIn("其他未决解释", fact["alternatives"][0])
        self.assertIn("物品所有者", fact["alternatives"][1])
        self.assertIn(fact["text"], fact["alternatives"][1])
        self.assertIn("其他未决解释", fact["interpretation_reason"])
        self.assertIn("物品所有者在本窗口无法唯一确定", fact["interpretation_reason"])
        self.assertEqual(fact["interpretation_reason"].count("当前未决说明："), 1)
        self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))

    def test_continuation_supports_only_bounded_integers_and_closed_counting_units(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageSender

        draft = labels(
            row("0:0", "event", subject="self", ambiguity_codes=[]),
            row("0:1", "continuation", subject="self", ambiguity_codes=[]),
        )
        for number in ("0", "1", "12", "9999", "零", "〇", "一", "两", "十", "十一", "十九", "二十", "九十九"):
            with self.subTest(number=number):
                text = f"我归档好了，{number}份。"
                source = window(text)
                source = replace(source, messages=(replace(source.messages[0], sender=MessageSender.SELF),))
                fact, = compile_labels_v4(source, draft)
                self.assertEqual(fact["text"], f"用户原话：“{text}”")
                self.assertEqual((fact["category"], fact["subject"], fact["valid_at"], fact["invalid_at"]),
                                 ("common_fact", "self", None, None))
        draft = labels(row("0:0", "event", ambiguity_codes=[]),
                       row("0:1", "continuation", ambiguity_codes=[]))
        for unit in ("个", "位", "名", "人", "张", "份", "本", "件", "台", "套", "把", "双", "只", "支",
                     "瓶", "盒", "袋", "包", "辆", "枚", "颗", "条"):
            with self.subTest(unit=unit):
                text = f"处理完了；12{unit}！"
                fact, = compile_labels_v4(window(text), draft)
                self.assertEqual(fact["text"], f"联系人原话：“{text}”")
        for ending in ("", "。", "！", "!"):
            with self.subTest(ending=ending):
                text = f"处理完了; 12份{ending}"
                fact, = compile_labels_v4(window(text), draft)
                self.assertEqual(fact["text"], f"联系人原话：“{text}”")
        # 没有句末标点时，分句内部的首尾空白也保留；不改旧分句器的定位规则。
        fact, = compile_labels_v4(window("处理完了; 12份 "), draft)
        self.assertEqual(fact["text"], "联系人原话：“处理完了; 12份 ”")

    def test_continuation_rejects_other_quantity_shapes_predicates_money_and_dates(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels_v4

        draft = labels(row("0:0", "event", ambiguity_codes=[]),
                       row("0:1", "continuation", ambiguity_codes=[]))
        for suffix in ("10000份。", "01份。", "一百份。", "两十份。", "一十份。", "十十份。",
                       "-2份。", "1.5份。", "１份。", "二三份。", "几份。", "半份。", "约两份。",
                       "两份左右。", "2至3份。", "2-3份。", "2 份。", "两份资料。", "共两份。",
                       "两元。", "两块。", "2月。", "两天。", "十点。", "2026-10-16。",
                       "2公斤。", "两。", "2。", "我取了两份。", "两份发出去了。", "两份？"):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(ExtractionInvalidOutputError, "有限整数"):
                compile_labels_v4(window("处理完了，" + suffix), draft)

    def test_continuation_rejects_orphans_other_anchors_sentence_boundaries_and_multiple_suffixes(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels_v4, source_units

        examples = (
            ("两份。", ["continuation"]),
            ("说到材料，两份。", ["prefix", "continuation"]),
            ("如果已经备好，两份。", ["condition", "continuation"]),
            ("你处理完了吗，两份。", ["question", "continuation"]),
            ("你好，两份。", ["greeting", "continuation"]),
            ("随口说说，两份。", ["nonliteral", "continuation"]),
            ("无关的话，两份。", ["not_memory", "continuation"]),
            ("已经收到了，两份。", ["relationship_event", "continuation"]),
            ("现在还在处理，两份。", ["state", "continuation"]),
            ("我准备明天去领，两份。", ["plan", "continuation"]),
            ("他可能收到，两份。", ["reported_event", "continuation"]),
            ("处理完了。两份。", ["event", "continuation"]),
            ("处理完了！两份。", ["event", "continuation"]),
            ("处理完了？两份。", ["event", "continuation"]),
            ("处理完了\n两份。", ["event", "continuation"]),
            ("处理完了。，两份。", ["event", "continuation"]),
            ("处理完了，两份，三张。", ["event", "continuation", "continuation"]),
            ("关于材料，处理完了，两份。", ["prefix", "event", "continuation"]),
            ("如果备齐，处理完了，两份。", ["condition", "event", "continuation"]),
        )
        for text, kinds in examples:
            source = window(text)
            draft = labels(*(row(unit.id, kind, ambiguity_codes=[])
                             for unit, kind in zip(source_units(source), kinds, strict=True)))
            with self.subTest(text=text), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels_v4(source, draft)

    def test_continuation_rejects_cross_message_context_and_conflicting_ownership_or_topic(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        from uuid import uuid4

        source = window("两份。")
        prior = MessageRef(uuid4(), "处理完了，", MessageSender.CONTACT, source.messages[0].occurred_at)
        for targets, draft in (
            ((prior.message_id, source.messages[0].message_id), labels(
                row("0:0", "event", ambiguity_codes=[]), row("1:0", "continuation", ambiguity_codes=[]),
            )),
            ((source.messages[0].message_id,), labels(row("1:0", "continuation", ambiguity_codes=[]))),
        ):
            with self.subTest(targets=len(targets)), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels_v4(replace(source, messages=(prior, *source.messages), target_message_ids=targets), draft)
        for mismatch in ({"subject": "self"}, {"subject": "shared"}, {"topic": "study"}):
            with self.subTest(mismatch=mismatch), self.assertRaisesRegex(ExtractionInvalidOutputError, "冲突"):
                compile_labels_v4(window("处理完了，两份。"), labels(
                    row("0:0", "event", ambiguity_codes=[]),
                    row("0:1", "continuation", ambiguity_codes=[], **mismatch),
                ))

    def test_continuation_is_v4_only_and_never_changes_unlabelled_event_event(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.evaluation import build_window, evaluate_case
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.grounded import compile_draft, compile_labels, compile_labels_v3, compile_labels_v4
        from notalone.memory_extraction.verification import SourceVerificationMode

        source = window("处理完了，两份。")
        rows = (row("0:0", "event"), row("0:1", "continuation"))
        for compiler, draft in ((compile_draft, {"units": list(rows)}), (compile_labels, labels(*rows)),
                                (compile_labels_v3, labels(*(dict(item, ambiguity_codes=[]) for item in rows)))):
            with self.subTest(version=compiler.__name__), self.assertRaisesRegex(
                ExtractionInvalidOutputError, "未知事实类型",
            ):
                compiler(source, draft)
        for override in ({"kind": "continuation_extra"}, {"text": "改写"}, {"valid_at": "2026-10-16"},
                         {"confidence": True}, {"confidence": float("nan")}, {"dependency": "0:1"},
                         {"unresolved": True}, {"ambiguity_codes": ["not_a_code"]}):
            with self.subTest(override=override), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels_v4(source, labels(row("0:0", "event", ambiguity_codes=[]),
                                                {**row("0:1", "continuation", ambiguity_codes=[]), **override}))

        case = next(case for case in CASES if case.name == "指代：门票")
        source = build_window(case)
        old = labels(row("1:0", "event", dependency="0:0", confidence=0.85, ambiguity_codes=[]),
                     row("1:1", "event", dependency="1:0", confidence=0.55, ambiguity_codes=[]))
        facts = compile_labels_v4(source, old)
        self.assertEqual([fact["text"] for fact in facts], [
            "联系人原话：“买好了，”（相关原文：用户说“门票买好了吗？”）",
            "联系人原话：“两张。”（相关原文：联系人说“买好了，”；用户说“门票买好了吗？”）",
        ])

        class FixedExtraction:
            def extract(self, window):
                return deepcopy(facts)

        class SupportingVerifier:
            verification_mode = SourceVerificationMode.NULLABLE_PROOF_V1

            def verify(self, *, window, facts):
                return tuple({"candidate_index": index, "verdict": "supported", "issues": [], "proof": None,
                              "evidence": [{"message_id": str(message.message_id), "quote": message.text}
                                           for message in window.messages if message.message_id in fact.source_message_ids]}
                             for index, fact in enumerate(facts))

        result = evaluate_case(case, source, FixedExtraction(), verification_runtime=SupportingVerifier())
        self.assertIsNone(result.failure_reason)
        self.assertEqual([(fact["confidence"], fact["destination"]) for fact in result.facts],
                         [(0.85, "auto"), (0.55, "pending")])

    def test_stable_fact_preserves_self_and_contact_sources_without_observation_dates(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageSender

        for text, sender, subject, topic, author in (
            ("我读应用统计专业。", MessageSender.SELF, "self", "study", "用户"),
            ("我目前是社区图书馆的管理员。", MessageSender.CONTACT, "contact", "work", "联系人"),
        ):
            with self.subTest(subject=subject):
                source = window(text)
                source = replace(source, messages=(replace(source.messages[0], sender=sender),))
                fact, = compile_labels_v4(source, labels(row(
                    "0:0", "stable_fact", subject=subject, topic=topic, confidence=0.84,
                    ambiguity_codes=[],
                )))
                self.assertEqual(set(fact), {
                    "text", "category", "subject", "topic", "source_message_ids", "confidence",
                    "risk_flags", "valid_at", "invalid_at", "speech_act", "assertion_status",
                    "figurative_type", "alternatives", "interpretation_reason",
                })
                self.assertEqual(fact["text"], f"{author}原话：“{text}”")
                self.assertEqual((fact["category"], fact["subject"], fact["topic"], fact["speech_act"],
                                  fact["assertion_status"], fact["figurative_type"]),
                                 ("common_fact", subject, topic, "assertion", "asserted", "literal"))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
                self.assertEqual(fact["source_message_ids"], [str(source.messages[0].message_id)])
                self.assertEqual((fact["confidence"], fact["risk_flags"], fact["alternatives"]),
                                 (0.84, [], []))
                self.assertTrue(fact["interpretation_reason"].strip())
                self.assertNotIn("semantic_basis", fact)

    def test_stable_fact_never_uses_missing_or_non_utc_source_time(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        for at in (None, datetime.fromisoformat("2026-08-19T23:45:00-04:30")):
            with self.subTest(at=at):
                source = window("我在这里担任资料管理员。")
                source = replace(source, messages=(replace(source.messages[0], occurred_at=at),))
                fact, = compile_labels_v4(source, labels(row("0:0", "stable_fact", ambiguity_codes=[])))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
                self.assertEqual(fact["text"], "联系人原话：“我在这里担任资料管理员。”")

    def test_stable_fact_preserves_prefix_dependencies_risk_ambiguity_and_low_confidence(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        from uuid import uuid4

        # 标签人为给定，只核新叶不清除原风险／歧义；不认证标签的语义判断。
        source = window("关于我的资料，我从事建筑设计。")
        context = MessageRef(uuid4(), "你长期从事哪个行业？", MessageSender.SELF,
                             source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        fact, = compile_labels_v4(source, labels(
            row("1:0", "prefix", dependency="0:0", unresolved=True, confidence=0.4,
                sensitivity="commitment", ambiguity_codes=["other_unresolved"]),
            row("1:1", "stable_fact", topic="work", ambiguity_codes=[], confidence=0.95),
        ))
        self.assertEqual(fact["text"], "联系人原话：“关于我的资料，我从事建筑设计。”"
                         "（相关原文：用户说“你长期从事哪个行业？”）")
        self.assertEqual(set(fact["source_message_ids"]), {str(message.message_id) for message in source.messages})
        self.assertEqual(fact["confidence"], 0.4)
        self.assertEqual(fact["risk_flags"], ["sensitivity:commitment"])
        self.assertEqual(fact["alternatives"], ["原句在本窗口仍有其他未决解释，保留原句。"])
        self.assertEqual((fact["category"], fact["valid_at"], fact["invalid_at"]), ("common_fact", None, None))

    def test_stable_fact_stays_v4_only_and_does_not_relax_invalid_labels(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels, compile_labels_v3, compile_labels_v4

        source = window("我从事建筑设计。")
        old = labels(row("0:0", "stable_fact"))
        typed = labels(row("0:0", "stable_fact", ambiguity_codes=[]))
        for compiler, draft in ((compile_labels, old), (compile_labels_v3, typed)):
            with self.subTest(version=compiler.__name__), self.assertRaisesRegex(
                ExtractionInvalidOutputError, "未知事实类型",
            ):
                compiler(source, draft)
        for draft in (
            labels(row("0:0", "stable_fact_extra", ambiguity_codes=[])),
            labels(row("0:0", "stable_fact", ambiguity_codes=["entity_identity"])),
            labels(row("0:0", "stable_fact", unresolved=True, ambiguity_codes=[])),
            labels(row("0:0", "stable_fact", ambiguity_codes=[], valid_at="2026-08-19")),
        ):
            with self.subTest(draft=draft), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels_v4(source, draft)
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels_v4(window("如果审核通过，我就在这里任职。"), labels(
                row("0:0", "condition", ambiguity_codes=[]),
                row("0:1", "stable_fact", ambiguity_codes=[]),
            ))

    def test_stable_fact_extension_keeps_existing_state_event_and_plan_fields(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        examples = (
            ("是否参加还没决定。", "state", "recent_state", "assertion", "asserted", "literal",
             "2026-10-14T18:00:00+08:00", None),
            ("正在等电梯。", "momentary_state", "recent_state", "assertion", "asserted", "literal",
             "2026-10-14T18:00:00+08:00", "2026-10-15T00:00:00+08:00"),
            ("已经交完材料了。", "event", "common_fact", "assertion", "asserted", "literal", None, None),
            ("我下周去参加培训。", "plan", "recent_state", "plan", "asserted", "literal",
             "2026-10-19T00:00:00+08:00", "2026-10-26T00:00:00+08:00"),
            ("我可能有点感冒。", "uncertain_state", "recent_state", "assertion", "unknown", "literal",
             "2026-10-14T18:00:00+08:00", None),
        )
        for text, kind, category, speech, assertion, figurative, start, end in examples:
            with self.subTest(kind=kind):
                fact, = compile_labels_v4(window(text), labels(row("0:0", kind, ambiguity_codes=[])))
                self.assertEqual((fact["category"], fact["speech_act"], fact["assertion_status"],
                                  fact["figurative_type"], fact["valid_at"], fact["invalid_at"]),
                                 (category, speech, assertion, figurative, start, end))
                self.assertIn(text, fact["text"])

    def test_object_ownership_keeps_known_lending_roles_and_historical_assertion(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        source = window("我姐把她的车借给我了。")
        fact, = compile_labels_v4(source, labels(row(
            "0:0", "relationship_event", topic="family", unresolved=True,
            ambiguity_codes=["object_ownership"], confidence=1.0,
        )))
        self.assertEqual(fact["text"], "联系人原话：“我姐把她的车借给我了。”")
        self.assertEqual((fact["subject"], fact["category"], fact["speech_act"], fact["assertion_status"],
                          fact["figurative_type"]),
                         ("contact", "relationship_note", "assertion", "asserted", "literal"))
        self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
        self.assertEqual(fact["source_message_ids"], [str(source.messages[0].message_id)])
        self.assertEqual(fact["risk_flags"], [])
        self.assertEqual(fact["alternatives"], [
            "所引原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。"
            " 所附原引句及上下文：联系人原话：“我姐把她的车借给我了。”",
        ])
        # 标签人为给定；既不按借用词补码，也不认证模型会判断所有权。
        for text in ("我姐把她的车借给我了。", "我姐把她自己所有的伞借给我了。"):
            with self.subTest(text=text):
                known, = compile_labels_v4(window(text), labels(row(
                    "0:0", "relationship_event", ambiguity_codes=[], confidence=1.0,
                )))
                self.assertEqual(known["alternatives"], [])
                self.assertEqual((known["speech_act"], known["assertion_status"]), ("assertion", "asserted"))
                self.assertIn(text, known["text"])

    def test_object_ownership_source_binding_survives_prefix_and_unknown_person_merges(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        from uuid import uuid4

        source = window("说到那辆车，我已经接过钥匙了。")
        context = MessageRef(uuid4(), "我承诺把车借给你。", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        fact, = compile_labels_v4(source, labels(
            row("1:0", "prefix", dependency="0:0", unresolved=True, confidence=0.4,
                sensitivity="commitment", ambiguity_codes=["object_ownership"]),
            row("1:1", "relationship_event", ambiguity_codes=[], confidence=1.0),
        ))
        self.assertEqual(fact["confidence"], 0.4)
        self.assertEqual(fact["risk_flags"], ["sensitivity:commitment"])
        self.assertEqual(set(fact["source_message_ids"]), {str(m.message_id) for m in source.messages})
        explanation, = fact["alternatives"]
        self.assertIn("说到那辆车，我已经接过钥匙了。", explanation)
        self.assertIn("我承诺把车借给你。", explanation)

        source = window("她不是车主，她只是借用人。")
        context = MessageRef(uuid4(), "同事送来了车，登记资料没有提供。", MessageSender.SELF,
                             source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        fact, = compile_labels_v4(source, labels(
            row("1:0", "third_party_fact", dependency="0:0", unresolved=True,
                ambiguity_codes=["entity_identity"]),
            row("1:1", "third_party_fact", dependency="0:1", unresolved=True, confidence=0.6,
                ambiguity_codes=["object_ownership", "entity_identity"]),
        ))
        self.assertEqual(len(fact["alternatives"]), 2)
        self.assertEqual(fact["confidence"], 0.6)
        self.assertEqual((fact["speech_act"], fact["assertion_status"]), ("report", "reported"))
        self.assertEqual(set(fact["source_message_ids"]), {str(m.message_id) for m in source.messages})
        for text in ("她不是车主，", "她只是借用人。", "同事送来了车，", "登记资料没有提供。"):
            self.assertIn(text, fact["alternatives"][1])

    def test_reviewed_eight_month_branches_remain_expressible_with_given_labels(self):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
        from notalone.memory_extraction.grounded import compile_labels_v4, source_units

        # 独审Gold是字段预期来源；标签人为给定，不认证模型分类或正文评分。
        root = Path(__file__).resolve().parents[4]
        reference = json.loads((root / ".scratch/unfinished-work/memory-gold-full140-reference-20261013.json").read_text())
        windows = {w["id"]: w for w in reference["windows"]}
        cases = {case.name: case for case in (*CASES, *SEMANTIC_CASES)}
        for identity, kinds, fact_index, claim_index in (
            ("R009", ["plan"], 0, 0),
            ("R013", ["uncertain_plan"], 0, 0),
            ("R064", ["uncertain_plan"], 0, 0),
            ("R081", ["plan"], 0, 0),
            ("R096", ["plan"], 0, 0),
            ("R097", ["not_memory", "plan"], 0, 0),
            ("R101", ["plan", "plan"], 0, 0),
            ("R118", ["event", "plan"], 1, 1),
        ):
            with self.subTest(identity=identity):
                expected = windows[identity]["claims"][claim_index]["variants"][0]
                source = build_window(cases[windows[identity]["case_name"]])
                targets = [u for u in source_units(source) if u.target]
                draft = labels(*(row(u.id, kind, ambiguity_codes=[], subject=expected["subject"],
                                     topic=expected["allowed_topics"][0])
                                 for u, kind in zip(targets, kinds, strict=True)))
                fact = compile_labels_v4(source, draft)[fact_index]
                for field in ("subject", "category", "speech_act", "assertion_status", "figurative_type",
                              "valid_at", "invalid_at"):
                    self.assertEqual(fact[field], expected[field])
                self.assertEqual((fact["valid_at"], fact["invalid_at"]),
                                 ("2026-10-01T00:00:00+00:00", "2026-11-01T00:00:00+00:00"))
                indices = expected["source_choices"][0]["indices"]
                self.assertEqual(set(fact["source_message_ids"]),
                                 {str(source.messages[index].message_id) for index in indices})
                self.assertNotIn("grounded:unresolved_period", fact["risk_flags"])

    def test_bounded_month_plan_shape_rejects_other_ranges_without_testing_place_names(self):
        from notalone.memory_extraction.grounded import compile_labels_v3, compile_labels_v4

        draft = labels(row("0:0", "plan", ambiguity_codes=[]))
        for text in ("我下个月尾几天去出差。", "下个月的头几天去出差。",
                     "我下个月刚结束才去出差。", "从明天到下个月去出差。",
                     "我计划在下个月头三天去出差。", "小林下个月去外地。", "我下个月学习。",
                     "我下个月去外地月底才回来。", "我下个月去外地待半个月。",
                     "我下个月去外地月初再转车。", "我下个月去外地待几个月。",
                     "我下个月去外地待半天。", "我下个月去外地待几周。",
                     "我下周去外地待半天。", "我半个周末去外地。"):
            with self.subTest(text=text):
                fact, = compile_labels_v4(window(text), draft)
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])
                self.assertIn(text, fact["text"])
        for text in ("我们下个月参加月饼展。", "我下个月去月光路。"):
            with self.subTest(text=text):
                fact, = compile_labels_v4(window(text), draft)
                self.assertEqual((fact["valid_at"], fact["invalid_at"]),
                                 ("2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00"))
        source = window("我下周去月光路。")
        self.assertEqual(compile_labels_v4(source, draft), compile_labels_v3(source, draft))

    def test_month_partial_ranges_and_non_temporal_month_character_have_lexical_boundaries(self):
        from notalone.memory_extraction.grounded import compile_labels_v3, compile_labels_v4

        for text in ("下个月头几天去出差。", "下个月刚开始就去出差。", "从现在到下个月去出差。"):
            with self.subTest(text=text):
                fact, = compile_labels_v4(window(text), labels(row("0:0", "plan", ambiguity_codes=[])))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])
        draft = labels(row("0:0", "plan", ambiguity_codes=[]))
        for text, start, end, week in (
            ("我计划下周去月亮湾。", "2026-10-19T00:00:00+08:00", "2026-10-26T00:00:00+08:00", True),
            ("我计划下个月去月亮湾。", "2026-11-01T00:00:00+08:00", "2026-12-01T00:00:00+08:00", False),
        ):
            with self.subTest(text=text):
                source = window(text)
                fact, = compile_labels_v4(source, draft)
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))
                self.assertNotIn("grounded:unresolved_period", fact["risk_flags"])
                if week:
                    old, = compile_labels_v3(source, draft)
                    self.assertEqual(fact, old)

    def test_old_protocols_reject_v4_labels_and_keep_month_unknown(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels, compile_labels_v3

        source = window("我下个月去外地。")
        for v3, compiler in ((False, compile_labels), (True, compile_labels_v3)):
            for kind in ("uncertain_plan", "uncertain_state", "figurative_unknown_plan", "stage_unknown_state"):
                with self.subTest(v3=v3, kind=kind), self.assertRaises(ExtractionInvalidOutputError):
                    draft = labels(row("0:0", kind, **({"ambiguity_codes": []} if v3 else {})))
                    compiler(source, draft)
            fact, = compiler(source, labels(row("0:0", "plan", **({"ambiguity_codes": []} if v3 else {}))))
            self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
            self.assertIn("grounded:unresolved_period", fact["risk_flags"])
        for code in ("clock_period", "event_stage", "object_ownership"):
            with self.subTest(code=code), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels_v3(source, labels(row("0:0", "unknown", unresolved=True, ambiguity_codes=[code])))

    def test_v2_v3_full140_contracts_and_given_label_outputs_keep_pinned_bytes(self):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.grounded import compile_labels, compile_labels_v3, source_units
        from notalone.memory_extraction.grounded_adapter import (
            GROUNDED_PROMPT, GROUNDED_V3_PROMPT, grounded_schema, grounded_schema_v3,
        )

        # 摘要独立取自变更前56051719；合成给定标签仅核兼容，不提供语义/模型质量信用。
        windows = [build_window(case) for case in (*CASES, *SEMANTIC_CASES)]
        for v3, prompt, schema, compiler, prompt_sha, schemas_sha, output_sha in (
            (False, GROUNDED_PROMPT, grounded_schema, compile_labels,
             "8580e630bbc4d600b08beb8a607cfcc05dc3efeb7daacc98a9f95bcb6164a01b",
             "c55322ae1480541222fdb03285b29613e47be0089d1692c57d30d36d27c2d10d",
             "50838572df12c4219b3b34436a521cbed2293f914d58ee094ab38ce7ad37508b"),
            (True, GROUNDED_V3_PROMPT, grounded_schema_v3, compile_labels_v3,
             "3a73e81e83b500d4f4293622f23bfaa681b38d33883e25193ddbccb3225fba91",
             "7a76206ef4316e7489a1cc43308da3495685e87e30fe9ccbaf3891e8e60bbb0a",
             "b16033ed4840d5128b5e96d3aa296ef9781e70ba63f1e24da4972f2741815619"),
        ):
            with self.subTest(v3=v3):
                self.assertEqual(hashlib.sha256(prompt.encode()).hexdigest(), prompt_sha)
                self.assertEqual(canonical_sha256([schema(w) for w in windows]), schemas_sha)
                compiled = []
                for w in windows:
                    draft = {"units": {u.id: {"kind": "event", "subject": "contact", "topic": "other",
                        "dependency": None, "unresolved": True, "confidence": 0.85, "sensitivity": "none",
                        **({"ambiguity_codes": ["entity_identity"]} if v3 else {})}
                        for u in source_units(w) if u.target}}
                    compiled.append(compiler(w, draft))
                self.assertEqual(canonical_sha256(compiled), output_sha)

    def test_new_codes_propagate_from_prefix_with_risk_dependency_and_lowest_confidence(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.models import MessageRef, MessageSender
        from uuid import uuid4

        source = window("在门口，活动到九点。")
        context = MessageRef(uuid4(), "你说的活动是什么？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        fact, = compile_labels_v4(source, labels(
            row("1:0", "prefix", dependency="0:0", unresolved=True, confidence=0.4,
                sensitivity="commitment", ambiguity_codes=["clock_period"]),
            row("1:1", "stage_unknown_state", unresolved=True, ambiguity_codes=["event_stage"]),
        ))
        self.assertEqual(fact["confidence"], 0.4)
        self.assertIn("sensitivity:commitment", fact["risk_flags"])
        self.assertEqual(set(fact["source_message_ids"]), {str(m.message_id) for m in source.messages})
        self.assertEqual(len(fact["alternatives"]), 2)
        for alternative in fact["alternatives"]:
            self.assertIn("在门口，活动到九点。", alternative)
            self.assertIn("你说的活动是什么？", alternative)

    def test_v4_rejects_free_fields_bad_codes_and_unrepresentable_condition_combinations(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels_v4

        source = window("我可能下个月去外地。")
        valid = labels(row("0:0", "uncertain_plan", ambiguity_codes=[]))
        for override in (
            {"kind": "uncertain_relationship"}, {"text": "已去外地"}, {"valid_at": None},
            {"figurative_type": "unknown"}, {"assertion_status": "asserted"},
            {"ambiguity_codes": ["clock_period"]},
            {"unresolved": True, "ambiguity_codes": []},
            {"unresolved": True, "ambiguity_codes": ["clock_period", "clock_period"]},
            {"unresolved": True, "ambiguity_codes": ["invented"]},
            {"ambiguity_codes": None},
        ):
            with self.subTest(override=override), self.assertRaises(ExtractionInvalidOutputError):
                draft = deepcopy(valid)
                draft["units"]["0:0"].update(override)
                compile_labels_v4(source, draft)
        for text, draft in (
            ("如果有空，我可能去外地。", labels(row("0:0", "condition", ambiguity_codes=[]),
                                             row("0:1", "uncertain_plan", ambiguity_codes=[]))),
            ("如果有空我可能去外地。", labels(row("0:0", "uncertain_plan", ambiguity_codes=[]))),
        ):
            with self.subTest(text=text), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels_v4(window(text), draft)

    def test_v4_explanations_are_bounded_and_never_truncate_negative_source(self):
        from notalone.memory_extraction.errors import ExtractionInvalidOutputError
        from notalone.memory_extraction.grounded import compile_labels_v4

        codes = ["matter_reference", "object_ownership", "event_stage", "clock_period", "other_unresolved", "borrowing_direction",
                 "place_ownership", "entity_identity"]
        source = window("我没有借那件物品。")
        fact, = compile_labels_v4(source, labels(row("0:0", "stage_unknown_state", unresolved=True,
                                                  ambiguity_codes=codes)))
        self.assertEqual(len(fact["alternatives"]), 9)
        self.assertLessEqual(len(fact["interpretation_reason"]), 600)
        self.assertEqual(fact["interpretation_reason"].count("当前未决说明："), 1)
        self.assertIn("向对方借入", fact["interpretation_reason"])
        self.assertIn("借给对方", fact["interpretation_reason"])
        self.assertIn("事项指称", fact["interpretation_reason"])
        self.assertNotIn("我没有借那件物品。", fact["interpretation_reason"])
        for alternative in fact["alternatives"][2:4] + fact["alternatives"][5:]:
            self.assertIn("我没有借那件物品。", alternative)
        within, = compile_labels_v4(window("甲" * 8100 + "没有确认车主。"), labels(row(
            "0:0", "relationship_event", unresolved=True, ambiguity_codes=["object_ownership"],
        )))
        self.assertIn("没有确认车主。", within["alternatives"][0])
        self.assertLessEqual(len(within["alternatives"][0]), 8400)
        self.assertLessEqual(len(within["interpretation_reason"]), 100)
        self.assertNotIn("甲", within["interpretation_reason"])
        with self.assertRaisesRegex(ExtractionInvalidOutputError, "8400"):
            compile_labels_v4(window("我没有" + "甲" * 8400 + "。"), labels(row(
                "0:0", "stage_unknown_state", unresolved=True, ambiguity_codes=codes,
            )))
        for code in ("event_stage", "object_ownership", "matter_reference"):
            with self.subTest(code=code), self.assertRaisesRegex(ExtractionInvalidOutputError, "8400"):
                compile_labels_v4(window("我没有" + "甲" * 8400 + "。"), labels(row(
                    "0:0", "stage_unknown_state", unresolved=True, ambiguity_codes=[code],
                )))

    def test_historical_correction_keeps_full_original_content_and_null_dates(self):
        from notalone.memory_extraction.grounded import compile_labels_v4
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES

        cases = {case.name: case for case in CASES}
        source = build_window(cases["窗口内自我更正"])
        # 给定有限标签只核依赖合并；不声称模型会选对或该输出已通过语义评分。
        fact, = compile_labels_v4(source, labels(
            row("1:0", "prefix", ambiguity_codes=[]),
            row("1:1", "correction", dependency="1:2", ambiguity_codes=[]),
            row("1:2", "not_memory", dependency="0:0", ambiguity_codes=[]),
        ))
        self.assertEqual((fact["category"], fact["speech_act"], fact["assertion_status"], fact["figurative_type"]),
                         ("relationship_note", "correction", "asserted", "literal"))
        self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
        for text in ("北京", "下周三不是下周一", "我记错了"):
            self.assertIn(text, fact["text"])
        self.assertEqual(set(fact["source_message_ids"]), {str(m.message_id) for m in source.messages})
        source = build_window(cases["行程改期"])
        fact, = compile_labels_v4(source, labels(row("0:0", "prefix", ambiguity_codes=[]),
                                               row("0:1", "correction", ambiguity_codes=[])))
        self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
        self.assertIn("本来说下周去北京，改成下个月了。", fact["text"])

    def test_clock_and_stage_unknowns_are_independent_source_bound_explanations(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        source = window("今天加班到九点。")
        fact, = compile_labels_v4(source, labels(row(
            "0:0", "stage_unknown_state", unresolved=True,
            ambiguity_codes=["event_stage", "clock_period"],
        )))
        self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
        self.assertEqual(len(fact["alternatives"]), 2)
        self.assertIn("时制", fact["alternatives"][0])
        self.assertIn("完成", fact["alternatives"][1])
        self.assertIn("安排", fact["alternatives"][1])
        for text in fact["alternatives"]:
            self.assertIn("今天加班到九点。", text)
            self.assertNotIn("21:00", text)
            self.assertNotIn("09:00", text)

    def test_month_modifiers_and_mixed_periods_never_fall_back_to_shorter_tokens(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        for text in (
            "下个月初去出差。", "下个月底去出差。", "下个月中旬去出差。",
            "下个月第二周去出差。", "下个月的某一天去出差。", "下个月三号去出差。",
            "下个月20日去出差。", "下个月之前去出差。", "下个月之后去出差。",
            "下个月末去出差。", "下个月起去出差。", "下下个月去出差。",
            "每个月去出差。", "下两个月去出差。", "大约下个月去出差。",
            "最早下个月去出差。", "明年下个月去出差。", "以后下个月去出差。",
            "今天说下个月去出差。", "下个月明天去出差。", "下个月下周去出差。",
            "下个月周末去出差。", "下个月和后天都去出差。",
            "下个月以后明天去出差。", "不是下个月是明天去出差。",
            "下个月不去出差。", "下个月取消出差。", "下个月改期去出差。",
            "下个月附近去出差。", "下个月早些时候去出差。", "下个月的前几天去出差。",
            "下个月的月底去出差。", "下个月的最后几天去出差。",
        ):
            with self.subTest(text=text):
                fact, = compile_labels_v4(window(text), labels(row("0:0", "plan", ambiguity_codes=[])))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])
                self.assertIn(text, fact["text"])

    def test_unknown_naive_overflow_or_nonunique_month_boundary_is_not_guessed(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        for at in (None,
                   datetime.fromisoformat("9999-12-15T12:00:00+00:00"),
                   datetime(2026, 10, 15, tzinfo=ZoneInfo("America/Havana")),
                   datetime(2023, 9, 15, tzinfo=ZoneInfo("America/Asuncion"))):
            with self.subTest(at=at):
                source = window("下个月去外地。")
                source = replace(source, messages=(replace(source.messages[0], occurred_at=at),))
                fact, = compile_labels_v4(source, labels(row("0:0", "plan", ambiguity_codes=[])))
                self.assertEqual((fact["valid_at"], fact["invalid_at"]), (None, None))
                self.assertIn("grounded:unresolved_period", fact["risk_flags"])

        source = window("下个月去外地。")
        with self.assertRaisesRegex(ValueError, "带时区"):
            replace(source.messages[0], occurred_at=datetime(2026, 9, 15))

    def test_next_month_uses_complete_calendar_month_and_source_timezone(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        for at, start, end in (
            (datetime.fromisoformat("2026-09-15T14:00:00+08:00"),
             "2026-10-01T00:00:00+08:00", "2026-11-01T00:00:00+08:00"),
            (datetime.fromisoformat("2026-12-31T23:50:00-05:00"),
             "2027-01-01T00:00:00-05:00", "2027-02-01T00:00:00-05:00"),
            (datetime.fromisoformat("2028-01-16T10:00:00+00:00"),
             "2028-02-01T00:00:00+00:00", "2028-03-01T00:00:00+00:00"),
            (datetime.fromisoformat("2027-01-16T10:00:00+00:00"),
             "2027-02-01T00:00:00+00:00", "2027-03-01T00:00:00+00:00"),
            (datetime(2026, 2, 16, 10, tzinfo=ZoneInfo("America/New_York")),
             "2026-03-01T00:00:00-05:00", "2026-04-01T00:00:00-04:00"),
        ):
            for token in ("下个月", "下月"):
                with self.subTest(at=at, token=token):
                    fact, = compile_labels_v4(window(f"我可能{token}去外地。", at=at), labels(row(
                        "0:0", "uncertain_plan", ambiguity_codes=[],
                    )))
                    self.assertEqual((fact["valid_at"], fact["invalid_at"]), (start, end))
                    self.assertNotIn("grounded:unresolved_period", fact["risk_flags"])
                    self.assertEqual(fact["assertion_status"], "unknown")

    def test_closed_unknown_kinds_keep_independent_pragmatic_and_time_fields(self):
        from notalone.memory_extraction.grounded import compile_labels_v4

        for text, kind, speech, assertion, figurative, valid in (
            ("我可能有点发烧。", "uncertain_state", "assertion", "unknown", "literal",
             "2026-10-14T18:00:00+08:00"),
            ("我以后可能去外地发展。", "uncertain_plan", "plan", "unknown", "literal", None),
            ("我说收益明天到手。", "figurative_unknown_plan", "plan", "asserted", "unknown",
             "2026-10-15T00:00:00+08:00"),
            ("今天工作到九点。", "stage_unknown_state", "unknown", "unknown", "literal", None),
        ):
            with self.subTest(kind=kind):
                fact, = compile_labels_v4(window(text), labels(row(
                    "0:0", kind, ambiguity_codes=[],
                )))
                self.assertEqual((fact["category"], fact["speech_act"], fact["assertion_status"],
                                  fact["figurative_type"]),
                                 ("recent_state", speech, assertion, figurative))
                self.assertEqual(fact["valid_at"], valid)
                self.assertIn(text, fact["text"])
                self.assertEqual(fact["alternatives"], [])


if __name__ == "__main__":
    unittest.main()
