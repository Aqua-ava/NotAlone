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
        for code in ("clock_period", "event_stage"):
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

        codes = ["event_stage", "clock_period", "other_unresolved", "borrowing_direction",
                 "place_ownership", "entity_identity"]
        source = window("我没有借那件物品。")
        fact, = compile_labels_v4(source, labels(row("0:0", "stage_unknown_state", unresolved=True,
                                                  ambiguity_codes=codes)))
        self.assertEqual(len(fact["alternatives"]), 7)
        for alternative in fact["alternatives"][2:4] + fact["alternatives"][5:]:
            self.assertIn("我没有借那件物品。", alternative)
        with self.assertRaisesRegex(ExtractionInvalidOutputError, "8400"):
            compile_labels_v4(window("我没有" + "甲" * 8400 + "。"), labels(row(
                "0:0", "stage_unknown_state", unresolved=True, ambiguity_codes=["event_stage"],
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
