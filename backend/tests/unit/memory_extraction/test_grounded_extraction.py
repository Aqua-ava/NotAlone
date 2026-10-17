"""从原文分句编译候选；模型不能直接提供时间和改写正文。"""
from datetime import datetime, timezone, timedelta
import unittest
from uuid import uuid4

from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_extraction.grounded import compile_draft, compile_labels, source_units
from notalone.memory_extraction.errors import ExtractionInvalidOutputError


def window(text: str, *, at: datetime | None = None) -> ExtractionWindow:
    message = MessageRef(uuid4(), text, MessageSender.CONTACT,
                         at or datetime(2026, 10, 14, 18, 0, tzinfo=timezone(timedelta(hours=8))))
    return ExtractionWindow(uuid4(), uuid4(), (message,), (message.message_id,))


def row(unit: str, kind: str, **kwargs: object) -> dict:
    return {"unit": unit, "kind": kind, "subject": "contact", "topic": "other", "dependency": None,
            "unresolved": False, "confidence": 0.9, "sensitivity": "none",
            **({} if "ambiguity_codes" in kwargs else {"event": None}), **kwargs}


class GroundedCompilerTest(unittest.TestCase):
    def test_event_labels_compile_source_positions_without_free_dates_or_stage_certification(self):
        source = window("🙂明天去看展。")
        label = row("0:0", "plan", event={"stage": "planned", "occurrence": "0:0"})
        fact = compile_labels(source, {"units": {"0:0": {key: value for key, value in label.items() if key != "unit"}}})[0]
        self.assertIn("🙂明天去看展。", fact["text"])
        self.assertEqual(fact["event"], {
            "version": 1, "stage": "planned", "stage_evidence": [{
                "message_id": str(source.messages[0].message_id), "char_start": 0, "char_end": 7,
            }], "occurrence_start": "2026-10-15T00:00:00+08:00",
            "occurrence_end": "2026-10-16T00:00:00+08:00",
            "occurrence_evidence": [{"message_id": str(source.messages[0].message_id), "char_start": 0, "char_end": 7}],
        })

    def test_event_labels_preserve_negation_and_unknown_periods_and_reject_unbound_metadata(self):
        from dataclasses import replace
        source = window("不是明天去看展。")
        for stage in ("planned", "agreed", "rescheduled", "cancelled", "occurred", "unknown"):
            item = row("0:0", "event", event={"stage": stage, "occurrence": "0:0"})
            draft = {"units": {"0:0": {key: value for key, value in item.items() if key != "unit"}}}
            with self.subTest(stage=stage):
                fact = compile_labels(source, draft)[0]
                self.assertEqual(fact["text"], "联系人原话：“不是明天去看展。”")
                self.assertEqual(fact["event"]["stage"], stage)
                self.assertIsNone(fact["event"]["occurrence_start"])
        source = window("明天去看展。")
        source = replace(source, messages=(replace(source.messages[0], occurred_at=None),))
        item = row("0:0", "plan", event={"stage": "planned", "occurrence": "0:0"})
        draft = {"units": {"0:0": {key: value for key, value in item.items() if key != "unit"}}}
        self.assertIsNone(compile_labels(source, draft)[0]["event"]["occurrence_start"])
        for invalid in ({"stage": "planned", "occurrence": "99:0"},
                        {"stage": "planned", "occurrence": None, "stage_verified": True},
                        {"stage": "planned", "occurrence": None, "occurrence_start": "2026-12-01"},
                        {"stage": "automatic", "occurrence": None}):
            draft["units"]["0:0"]["event"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels(source, draft)

    def test_event_cannot_borrow_an_unrelated_source_period(self):
        from dataclasses import replace
        source = window("我已取件。")
        unrelated = MessageRef(uuid4(), "明天去看展。", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(unrelated, *source.messages))
        item = row("1:0", "event", event={"stage": "occurred", "occurrence": "0:0"})
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels(source, {"units": {"1:0": {key: value for key, value in item.items() if key != "unit"}}})

    def test_conditional_weekend_is_computed_from_source_not_model_date(self):
        source = window("如果周末有空，我只去问场馆是否开放。")
        draft = {"units": [row("0:0", "condition"), row("0:1", "plan")]}
        result = compile_draft(source, draft)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["assertion_status"], "conditional")
        self.assertEqual(result[0]["valid_at"], "2026-10-17T00:00:00+08:00")
        self.assertEqual(result[0]["invalid_at"], "2026-10-19T00:00:00+08:00")
        self.assertIn("如果周末有空", result[0]["text"])
        self.assertNotIn("已经开放", result[0]["text"])

    def test_missing_or_duplicate_unit_fails_instead_of_silent_success(self):
        source = window("我已经到站，正在等接驳车。")
        for items in ([row("0:0", "event")], [row("0:0", "event"), row("0:0", "event")]):
            with self.subTest(items=items), self.assertRaises(ExtractionInvalidOutputError):
                compile_draft(source, {"units": items})

    def test_historical_and_current_state_have_independent_lifetimes(self):
        source = window("办完入住了，还在等电梯。")
        result = compile_draft(source, {"units": [row("0:0", "event"), row("0:1", "momentary_state")]})
        self.assertEqual(result[0]["category"], "common_fact")
        self.assertIsNone(result[0]["valid_at"])
        self.assertIsNone(result[0]["invalid_at"])
        self.assertEqual(result[1]["valid_at"], "2026-10-14T18:00:00+08:00")
        self.assertEqual(result[1]["invalid_at"], "2026-10-15T00:00:00+08:00")
        self.assertNotIn("2026-10-14", result[0]["text"])

    def test_decision_state_never_gets_an_invented_expiry(self):
        result = compile_draft(window("是否参加还没决定。"), {"units": [row("0:0", "state")]})
        self.assertIsNone(result[0]["invalid_at"])
        self.assertIn("截至2026-10-14", result[0]["text"])

    def test_unknown_person_clauses_remain_in_one_source_record(self):
        source = window("她不是老师，她在医院。")
        result = compile_draft(source, {"units": [row("0:0", "third_party_fact", unresolved=True),
                                                 row("0:1", "third_party_fact", unresolved=True)]})
        self.assertEqual(len(result), 1)
        self.assertIn("她不是老师", result[0]["text"])
        self.assertIn("她在医院", result[0]["text"])
        self.assertTrue(result[0]["alternatives"])
        self.assertNotIn("认识", str(result[0]))

    def test_model_cannot_supply_free_text_dates_or_risk_labels(self):
        source = window("我姐把她的伞借给我了。")
        for override in ({"text": "我已经还了"}, {"invalid_at": "2026-12-31"}, {"sensitivity": "借用"}):
            with self.subTest(override=override), self.assertRaises(ExtractionInvalidOutputError):
                compile_draft(source, {"units": [row("0:0", "relationship_event", **override)]})

    def test_context_ids_and_target_ids_cannot_be_fabricated(self):
        source = window("我不知道。")
        for item in (row("foreign:0", "state"), row("0:0", "state", dependency="foreign:0")):
            with self.subTest(item=item), self.assertRaises(ExtractionInvalidOutputError):
                compile_draft(source, {"units": [item]})

    def test_unknown_time_cannot_be_filled_from_wall_clock(self):
        from dataclasses import replace
        source = window("明天我去散步。")
        source = replace(source, messages=(replace(source.messages[0], occurred_at=None),))
        result = compile_draft(source, {"units": [row("0:0", "plan")]})
        self.assertIsNone(result[0]["valid_at"])
        self.assertIsNone(result[0]["invalid_at"])
        self.assertIn("grounded:unresolved_period", result[0]["risk_flags"])

    def test_orphan_condition_is_not_discarded(self):
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_draft(window("如果有空。"), {"units": [row("0:0", "condition")]})

    def test_unit_positions_are_exact_source_slices(self):
        source = window("🙂我到站了，正在等车。")
        units = source_units(source)
        self.assertEqual([u.text for u in units], ["🙂我到站了，", "正在等车。"])
        self.assertEqual(units[1].start, 6)

    def test_dependency_does_not_pull_unrelated_history_into_source_ids(self):
        source = window("现在他的工作，我不知道。")
        previous = MessageRef(uuid4(), "你表哥做什么工作？", MessageSender.SELF, source.messages[0].occurred_at)
        from dataclasses import replace
        source = replace(source, messages=(previous, *source.messages))
        result = compile_draft(source, {"units": [row("1:0", "state", dependency="0:0"), row("1:1", "state", dependency="1:0")]})
        self.assertEqual(len(result[0]["source_message_ids"]), 2)
        self.assertIn("你表哥做什么工作", result[0]["text"])

    def test_unsupported_time_modifiers_never_become_different_dates(self):
        for text in ("下下周去游泳。", "大后天去取件。", "周末之后去医院。", "下周三去开会。", "不是明天去学校。"):
            with self.subTest(text=text):
                result = compile_draft(window(text), {"units": [row("0:0", "plan")]})
                self.assertIsNone(result[0]["valid_at"])
                self.assertIn("grounded:unresolved_period", result[0]["risk_flags"])

    def test_prefix_keeps_dependency_uncertainty_and_low_confidence(self):
        from dataclasses import replace
        source = window("他的情况，我不知道。")
        context = MessageRef(uuid4(), "你同事最近怎么样？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        result = compile_draft(source, {"units": [
            row("1:0", "prefix", dependency="0:0", unresolved=True, confidence=0.4),
            row("1:1", "state"),
        ]})
        self.assertIn(str(context.message_id), result[0]["source_message_ids"])
        self.assertTrue(result[0]["alternatives"])
        self.assertEqual(result[0]["confidence"], 0.4)

    def test_display_brackets_are_normalized_without_accepting_extra_content(self):
        source = window("我已经取件了。")
        self.assertEqual(len(compile_draft(source, {"units": [row("[0:0]", "event")]})), 1)
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_draft(source, {"units": [row("[0:0]extra", "event")]})

    def test_compound_answer_without_dependency_stays_unresolved(self):
        from dataclasses import replace
        source = window("现在他的住处，我不知道。")
        context = MessageRef(uuid4(), "你弟弟现在住哪？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        result = compile_draft(source, {"units": [row("1:0", "prefix", dependency="1:1"), row("1:1", "state", dependency="1:0")]})
        self.assertNotIn("你弟弟现在住哪", result[0]["text"])
        self.assertEqual(result[0]["source_message_ids"], [str(source.messages[1].message_id)])
        self.assertTrue(result[0]["alternatives"])

    def test_time_parser_does_not_fall_back_to_shorter_period(self):
        for text in ("下周末前去取件。", "每个周末去公园。", "除了周末都能去。"):
            with self.subTest(text=text):
                fact = compile_draft(window(text), {"units": [row("0:0", "plan")]})[0]
                self.assertIsNone(fact["valid_at"])

    def test_historical_time_prefix_does_not_import_unrelated_question(self):
        from dataclasses import replace
        source = window("去年冬天，我去过昆明。")
        previous = MessageRef(uuid4(), "你同事在哪里上班？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(previous, *source.messages))
        fact = compile_draft(source, {"units": [row("1:0", "prefix"), row("1:1", "event")]})[0]
        self.assertEqual(fact["source_message_ids"], [str(source.messages[1].message_id)])
        self.assertNotIn("同事", fact["text"])

    def test_adjacent_unrelated_question_is_not_a_reference(self):
        from dataclasses import replace
        source = window("他现在的工作，我不知道。")
        context = MessageRef(uuid4(), "你午饭吃面了吗？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        fact = compile_draft(source, {"units": [row("1:0", "prefix"), row("1:1", "state")]})[0]
        self.assertNotIn("午饭", fact["text"])
        self.assertEqual(fact["source_message_ids"], [str(source.messages[1].message_id)])
        self.assertTrue(fact["alternatives"])

    def test_resolved_pronoun_requires_independent_earlier_evidence(self):
        from dataclasses import replace
        source = window("现在她住在哪里，我不清楚。")
        context = MessageRef(uuid4(), "你妹妹现在住在哪里？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(context, *source.messages))
        def draft(dep):
            items = [row("1:0", "prefix", dependency=dep), row("1:1", "state")]
            return {"units": {item["unit"]: {k: v for k, v in item.items() if k != "unit"} for item in items}}
        for dep in (None, "1:1"):
            with self.subTest(dep=dep), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels(source, draft(dep))
        fact = compile_labels(source, draft("0:0"))[0]
        self.assertIn("你妹妹现在住在哪里", fact["text"])
        self.assertEqual(set(fact["source_message_ids"]), {str(m.message_id) for m in source.messages})
        self.assertEqual(fact["alternatives"], [])

    def test_labels_never_guess_missing_or_replaced_field_names(self):
        source = window("她不是会计，她在研发部。")
        label = {k: v for k, v in row("0:0", "third_party_fact", unresolved=True).items() if k != "unit"}
        for invalid in ({"0": label, "1": label}, {"0:0": label}, {"[0:0]": label, "0:1": label}):
            with self.subTest(invalid=invalid), self.assertRaises(ExtractionInvalidOutputError):
                compile_labels(source, {"units": invalid})
        facts = compile_labels(source, {"units": {"0:1": label, "0:0": label}})
        self.assertEqual(len(facts), 1)
        self.assertLess(facts[0]["text"].index("不是会计"), facts[0]["text"].index("研发部"))
        self.assertTrue(facts[0]["alternatives"])

    def test_unsupported_identity_cannot_be_resolved_by_a_pronoun_chain(self):
        source = window("他不是司机，他在商场。")
        first = row("0:0", "third_party_fact", unresolved=True)
        second = row("0:1", "third_party_fact", dependency="0:0")
        draft = {"units": {item["unit"]: {k: v for k, v in item.items() if k != "unit"} for item in (first, second)}}
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels(source, draft)

    def test_completed_action_answer_cannot_expire_as_a_momentary_state(self):
        from dataclasses import replace
        source = window("签收了，正在检查包装。")
        question = MessageRef(uuid4(), "你签收包裹了吗？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(question, *source.messages))
        items = [row("1:0", "momentary_state", dependency="0:0"), row("1:1", "momentary_state")]
        draft = {"units": {item["unit"]: {k: v for k, v in item.items() if k != "unit"} for item in items}}
        facts = compile_labels(source, draft)
        self.assertEqual(facts[0]["category"], "common_fact")
        self.assertIsNone(facts[0]["valid_at"])
        self.assertIsNone(facts[0]["invalid_at"])
        self.assertEqual(facts[1]["category"], "recent_state")
        self.assertIn("完成问答", facts[0]["interpretation_reason"])

    def test_completion_rule_rejects_deadlines_future_and_unrelated_questions(self):
        from dataclasses import replace
        for question_text, answer_text in (
            ("截止时间到了吗？", "到了。"),
            ("你到极限了吗？", "到了。"),
            ("你到崩溃边缘了吗？", "到了。"),
            ("你的交租日到了吗？", "到了。"),
            ("你到明天了吗？", "到了。"),
            ("你吃午饭了吗？", "到了。"),
            ("你到公司了吗？", "明天就到了。"),
            ("你到公司了吗？", "还没到。"),
            ("你到公司了吗？", "到了就告诉你。"),
        ):
            with self.subTest(question=question_text, answer=answer_text):
                source = window(answer_text)
                question = MessageRef(uuid4(), question_text, MessageSender.SELF, source.messages[0].occurred_at)
                source = replace(source, messages=(question, *source.messages))
                label = {k: v for k, v in row("1:0", "momentary_state", dependency="0:0", topic="travel").items() if k != "unit"}
                fact = compile_labels(source, {"units": {"1:0": label}})[0]
                self.assertEqual(fact["category"], "recent_state")
                self.assertNotIn("完成问答", fact["interpretation_reason"])

    def test_future_question_cannot_certify_an_earlier_completion(self):
        from dataclasses import replace
        source = window("到了。")
        question = MessageRef(uuid4(), "你到学校了吗？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(*source.messages, question))
        label = {k: v for k, v in row("0:0", "momentary_state", dependency="1:0").items() if k != "unit"}
        fact = compile_labels(source, {"units": {"0:0": label}})[0]
        self.assertEqual(fact["category"], "recent_state")

    def test_arrival_answer_requires_a_supported_place_in_the_question(self):
        from dataclasses import replace
        source = window("抵达了。")
        question = MessageRef(uuid4(), "你抵达东侧码头了吗？", MessageSender.SELF, source.messages[0].occurred_at)
        source = replace(source, messages=(question, *source.messages))
        label = {k: v for k, v in row("1:0", "momentary_state", dependency="0:0").items() if k != "unit"}
        fact = compile_labels(source, {"units": {"1:0": label}})[0]
        self.assertEqual(fact["category"], "common_fact")
        self.assertIsNone(fact["valid_at"])
        self.assertIsNone(fact["invalid_at"])
