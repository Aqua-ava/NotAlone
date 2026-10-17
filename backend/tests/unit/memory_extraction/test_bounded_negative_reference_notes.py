"""E2有限负向说明只保留未解关系；给定标签与SDK响应不认证模型质量。"""

from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from itertools import product
import json
import os
import socket
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.adoption import can_auto_adopt
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.grounded import compile_draft, compile_labels, compile_labels_v3, compile_labels_v4
from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_extraction.negative_reference import bounded_negative_reference_notes
from notalone.memory_extraction.pragmatics import PragmaticInterpreter
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels
from tests.unit.memory_extraction.test_grounded_v3_runtime import response
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result


VISIT_NOTES = (
    "原句中的复数代词未在本窗口绑定到具体来访者；不补人物身份，来访与否及时间仍以原句为准。",
    "原句只写家里／家中，地点属于谁的家在本窗口未明确；不认定用户、联系人或其他人的住处，也不认定产权。",
)
GENERIC_NOTE = "原文指代在本窗口无法唯一确定，保留原句。"


def loan_notes(text: str) -> tuple[str, str]:
    return (
        "所引原句中的“借”，一种可能的方向是向对方借入；人物与肯定／否定仍以所附原句为准，"
        "本窗不确认此方向，也不把否定解释为发生。 所附原引句及上下文：" + text,
        "所引原句中的“借”，另一种可能的方向是借给对方；人物与肯定／否定仍以所附原句为准，"
        "本窗不确认此方向，也不把否定解释为发生。 所附原引句及上下文：" + text,
    )


def loan_window(question: str = "老陈借你钱了吗？", answer: str = "借了，小林没借。",
                *, sender: MessageSender = MessageSender.CONTACT) -> ExtractionWindow:
    source = window(answer)
    actual_answer = replace(source.messages[0], sender=sender)
    other = MessageSender.SELF if sender is MessageSender.CONTACT else MessageSender.CONTACT
    actual_question = MessageRef(uuid4(), question, other,
                                actual_answer.occurred_at - timedelta(minutes=1))
    return replace(source, messages=(actual_question, actual_answer))


def loan_labels(*, sender: MessageSender = MessageSender.CONTACT,
                unresolved: bool = False) -> dict:
    return labels(*(row(unit, "relationship_event", subject=sender.value,
                        dependency="0:0", unresolved=unresolved, confidence=0.95)
                    for unit in ("1:0", "1:1")))


class BoundedNegativeReferenceNotesTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_complete_plural_visit_explains_people_and_home_without_binding_them(self) -> None:
        source = window("她们明天不会来家中。")
        draft = labels(row("0:0", "plan", unresolved=True))
        original = deepcopy(draft)
        fact, = compile_labels(source, draft)
        self.assertEqual(fact["alternatives"], [GENERIC_NOTE, *VISIT_NOTES])
        self.assertEqual(fact["text"], "联系人原话：“她们明天不会来家中。”")
        self.assertEqual(draft, original)

    def test_separate_loan_answers_each_preserve_their_own_polarity_and_complete_question(self) -> None:
        source = loan_window()
        draft = loan_labels()
        original = deepcopy(draft)
        facts = compile_labels(source, draft)
        self.assertEqual(len(facts), 2)
        for fact, main in zip(facts, ("借了，", "小林没借。")):
            self.assertEqual(fact["text"], "联系人原话：“" + main + "”（相关原文：用户说“老陈借你钱了吗？”）")
            self.assertEqual(fact["alternatives"], list(loan_notes(fact["text"])))
        self.assertEqual(draft, original)

    def test_sdk_e2_supported_verdict_does_not_remove_negative_notes_or_enable_adoption(self) -> None:
        for source, draft, expected in (
            (window("她们明天会来家里。"), labels(row("0:0", "plan", unresolved=True)), VISIT_NOTES),
            (loan_window(), loan_labels(), None),
        ):
            with self.subTest(text=source.messages[-1].text):
                requests: list[dict] = []

                def handler(request: httpx.Request) -> httpx.Response:
                    body = json.loads(request.content)
                    requests.append(body)
                    name = body["tools"][0]["function"]["name"]
                    if name == "GroundedMemoryLabels":
                        return response(draft, name=name)
                    candidates = json.loads(body["messages"][1]["content"])["candidates"]
                    result = [{"candidate_index": index, "verdict": "supported", "issues": [],
                               "evidence": [{"message_id": str(source.messages[-1].message_id),
                                             "quote": source.messages[-1].text}]}
                              for index in range(len(candidates))]
                    return response({"results": result}, name=name)

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    outcome = ExtractionFlow(runtime=GroundedExtractionRuntime(model=model),
                        verification_runtime=LangChainSourceVerificationRuntime(model=model)).run(source)
                self.assertIsNone(outcome.failure_reason)
                self.assertEqual(len(requests), 2)
                self.assertTrue(outcome.accepted)
                for fact in outcome.accepted:
                    wanted = expected if expected is not None else loan_notes(fact.text)
                    self.assertEqual(fact.alternatives[-2:], wanted)
                    self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))
                    self.assertEqual(fact.risk_flags, ("pragmatic:future_validity",) if expected else ())
                    self.assertIsNone(fact.dimension_evidence.semantic_basis)

    def test_visit_cartesian_grammar_authors_and_observation_prefix_preserve_other_fields(self) -> None:
        for pronoun, time, modal, home, stop, sender in product(
            ("他们", "她们"), ("周末", "明天", "后天"), ("", "要", "会", "不", "不会"),
            ("来家里", "来家中"), ("", "。"), (MessageSender.SELF, MessageSender.CONTACT),
        ):
            text = pronoun + time + modal + home + stop
            with self.subTest(text=text, sender=sender):
                source = window(text)
                message = replace(source.messages[0], sender=sender)
                source = replace(source, messages=(message,))
                item = row("0:0", "plan", subject=sender.value, unresolved=True, sensitivity="health")
                baseline, = compile_draft(source, {"units": [item]})
                fact, = compile_labels(source, labels(item))
                self.assertEqual(fact, {**baseline, "alternatives": [GENERIC_NOTE, *VISIT_NOTES]})
                self.assertEqual(compile_labels(source, labels(item)), (fact,))
                for prefix in ("", "截至2026-10-14，"):
                    candidate = prefix + ("用户" if sender is MessageSender.SELF else "联系人") + "原话：“" + text + "”"
                    self.assertEqual(bounded_negative_reference_notes(source, text=candidate,
                        source_message_ids=(message.message_id,)), VISIT_NOTES)
        source = window("他们明天会来家里。")
        with self.assertRaises(ExtractionInvalidOutputError):
            compile_labels(source, labels(row("0:0", "plan", unresolved=False)))

    def test_loan_labels_polarity_punctuation_and_authors_preserve_every_other_field(self) -> None:
        for (first, second), negative, question_mark, stop, sender, unresolved in product(
            (("老陈", "小林"), ("小林", "老陈"), ("老王", "小王"), ("老一", "小龥"),
             ("老陈", "老林"), ("小陈", "小林"), ("老向", "小给")),
            ("没借", "没有借"), ("？", "?"), ("", "。"),
            (MessageSender.SELF, MessageSender.CONTACT), (False, True),
        ):
            with self.subTest(first=first, second=second, negative=negative, sender=sender,
                              question_mark=question_mark, stop=stop, unresolved=unresolved):
                source = loan_window(first + "借你钱了吗" + question_mark,
                                     "借了，" + second + negative + stop, sender=sender)
                draft = loan_labels(sender=sender, unresolved=unresolved)
                original = deepcopy(draft)
                old_rows = [{"unit": unit, **label} for unit, label in draft["units"].items()]
                baseline = compile_draft(source, {"units": old_rows})
                facts = compile_labels(source, draft)
                for before, fact in zip(baseline, facts):
                    wanted = list(loan_notes(fact["text"]))
                    self.assertEqual(fact, {**before, "alternatives": before["alternatives"] + wanted})
                    self.assertEqual(fact["source_message_ids"],
                                     [str(source.messages[1].message_id), str(source.messages[0].message_id)])
                    self.assertTrue(all(note.endswith(fact["text"]) and len(note) <= 8400 for note in wanted))
                    for prefix in ("", "截至2026-10-14，"):
                        candidate = prefix + fact["text"]
                        self.assertEqual(bounded_negative_reference_notes(source, text=candidate,
                            source_message_ids=(source.messages[1].message_id, source.messages[0].message_id)),
                            loan_notes(candidate))
                self.assertEqual(draft, original)

    def test_visit_explicit_roles_extra_content_and_unlisted_forms_are_not_partially_matched(self) -> None:
        for text in (
            "我姐和我哥周末会来家里。", "他们明天会来我家。", "她们明天会来你家。",
            "她们明天会去家里。", "它们明天来家里。", "他们下周末来家里。",
            "他们明天要会来家里。", "他们明天不不来家里。", "他们明天会不会来家里。",
            "他们明天不要来家里。", "他们明天已经来家里。", "他们明天可能来家里。",
            "他们明天不一定来家里。", "他们明天打算来家里。", "他们明天会来家里. 别的事。",
            "他们明天会来家里！", "他们明天会来家里。。", "他们明天会来家里.",
            " 他们明天会来家里。", "他们明天会来家里。 ", "他们\n明天会来家里。",
            "他们明天会来家里。还有其他事。", "他们明天会来家里，其他人不来。",
        ):
            with self.subTest(text=text):
                source = window(text)
                message = source.messages[0]
                self.assertEqual(bounded_negative_reference_notes(source, text="联系人原话：“" + text + "”",
                    source_message_ids=(message.message_id,)), ())
        source = window("他们明天会来家里。")
        message = source.messages[0]
        prior = replace(message, message_id=uuid4(), text="我姐和我哥就是前面提到的人。")
        extended = replace(source, messages=(prior, message))
        self.assertEqual(bounded_negative_reference_notes(extended, text="联系人原话：“" + message.text + "”",
            source_message_ids=(message.message_id,)), ())

    def test_loan_explicit_directions_same_labels_extra_content_and_wrong_authors_are_outside(self) -> None:
        for question, answer in (
            ("老陈向你借钱了吗？", "借了，小林没借。"),
            ("老陈跟你借钱了吗？", "借了，小林没借。"),
            ("老陈从你借钱了吗？", "借了，小林没借。"),
            ("老陈给你钱了吗？", "借了，小林没借。"),
            ("老陈借给你钱了吗？", "借了，小林没借。"),
            ("老陈借你钱了吗？", "向我借了，小林没借。"),
            ("老陈借你钱了吗？", "借了，小林没借给我。"),
            ("老陈借你钱了吗？", "借了，老陈没借。"),
            ("老陈借你钱了吗？", "小林没借，借了。"),
            ("老陈借你钱了吗？", "借了，他没借。"),
            ("老陈借你钱了吗？", "借了,小林没借。"),
            ("老陈借你钱了吗？", "借了；小林没借。"),
            ("老陈借你钱了吗？", "借了，小林昨天没借。"),
            ("老陈借你钱了吗？", "借了，小林没借五元。"),
            ("老陈借你钱了吗？", "借了，小林没借。后来不清楚。"),
            ("老陈借你钱了吗？？", "借了，小林没借。"),
            ("老陈借你钱了吗？", "借了，小林没借！"),
            ("老陈借你钱了吗？", "借了，小林没有借。。"),
            ("老陈借你钱了吗？", "借了，小林没借. "),
            ("老陈借你钱了吗？ ", "借了，小林没借。"),
            ("老陈借你钱了吗？", "借了，\n小林没借。"),
            ("阿陈借你钱了吗？", "借了，小林没借。"),
            ("老陈甲借你钱了吗？", "借了，小林没借。"),
            ("老㐀借你钱了吗？", "借了，小林没借。"),
        ):
            with self.subTest(question=question, answer=answer):
                source = loan_window(question, answer)
                candidate = "联系人原话：“" + answer + "”（相关原文：用户说“" + question + "”）"
                self.assertEqual(bounded_negative_reference_notes(source, text=candidate,
                    source_message_ids=(source.messages[1].message_id, source.messages[0].message_id)), ())
        source = loan_window()
        question, answer = source.messages
        candidate = "联系人原话：“借了，”（相关原文：用户说“老陈借你钱了吗？”）"
        for actual in (
            replace(source, messages=(replace(question, sender=answer.sender), answer)),
            replace(source, messages=(question, replace(answer, message_id=question.message_id)),
                    target_message_ids=(question.message_id,)),
            replace(source, messages=(question, answer, replace(answer, message_id=uuid4(), text="第三条。"))),
        ):
            with self.subTest(actual=actual):
                self.assertEqual(bounded_negative_reference_notes(actual, text=candidate,
                    source_message_ids=(actual.messages[1].message_id, actual.messages[0].message_id)), ())

    def test_exact_targets_sources_and_whole_candidate_are_required(self) -> None:
        visit = window("他们明天会来家里。")
        loan = loan_window()
        for source, candidate, sources in (
            (visit, "联系人原话：“他们明天会来家里。”", (visit.messages[0].message_id,)),
            (loan, "联系人原话：“小林没借。”（相关原文：用户说“老陈借你钱了吗？”）",
             (loan.messages[1].message_id, loan.messages[0].message_id)),
        ):
            with self.subTest(candidate=candidate):
                for invalid_sources in ((), sources[:1] if len(sources) == 2 else (uuid4(),),
                                        tuple(reversed(sources)) if len(sources) == 2 else (*sources, uuid4()),
                                        (*sources, sources[0]), (*sources, uuid4())):
                    self.assertEqual(bounded_negative_reference_notes(source, text=candidate,
                        source_message_ids=invalid_sources), ())
                for actual in (replace(source, target_message_ids=None),
                               replace(source, target_message_ids=(source.messages[-1].message_id,) * 2)):
                    self.assertEqual(bounded_negative_reference_notes(actual, text=candidate,
                        source_message_ids=sources), ())
                for invalid in (candidate + "。", " " + candidate, candidate + "\n",
                                candidate.replace("联系人原话", "用户原话"),
                                candidate.replace("原话：“", "原话：“只是"),
                                "截至2026-10-13，" + candidate):
                    self.assertEqual(bounded_negative_reference_notes(source, text=invalid,
                        source_message_ids=sources), ())
        source = loan
        question, answer = source.messages
        ids = (answer.message_id, question.message_id)
        for candidate in (
            "联系人原话：“借了，”", "联系人原话：“借了，”（相关原文：用户说“老陈借你钱”）",
            "联系人原话：“借了，”（相关原文：联系人说“老陈借你钱了吗？”）",
            "联系人原话：“借了，”（相关原文：用户说“小林借你钱了吗？”）",
            "联系人原话：“老陈没借。”（相关原文：用户说“老陈借你钱了吗？”）",
            "联系人原话：“借了，小林没借。”（相关原文：用户说“老陈借你钱了吗？”）",
            "联系人原话：“借了，” 同一原消息续句：“小林没借。”（相关原文：用户说“老陈借你钱了吗？”）",
            "联系人原话：“借了，”（相关原文：用户说“老陈借你钱了吗？”；用户说“还有其他事。”）",
        ):
            with self.subTest(candidate=candidate):
                self.assertEqual(bounded_negative_reference_notes(source, text=candidate, source_message_ids=ids), ())
        for targets in ((question.message_id,), (question.message_id, answer.message_id)):
            actual = replace(source, target_message_ids=targets)
            self.assertEqual(bounded_negative_reference_notes(actual,
                text="联系人原话：“借了，”（相关原文：用户说“老陈借你钱了吗？”）", source_message_ids=ids), ())

    def test_observation_uses_actual_local_day_and_missing_anchor_allows_only_no_prefix(self) -> None:
        source = window("他们明天会来家里。",
                        at=datetime(2026, 10, 14, 0, 30, tzinfo=timezone(timedelta(hours=14))))
        candidate = "联系人原话：“他们明天会来家里。”"
        ids = (source.messages[0].message_id,)
        self.assertEqual(bounded_negative_reference_notes(source, text="截至2026-10-14，" + candidate,
            source_message_ids=ids), VISIT_NOTES)
        self.assertEqual(bounded_negative_reference_notes(source, text="截至2026-10-13，" + candidate,
            source_message_ids=ids), ())
        actual = replace(source, messages=(replace(source.messages[0], occurred_at=None),))
        self.assertEqual(bounded_negative_reference_notes(actual, text=candidate, source_message_ids=ids), VISIT_NOTES)
        self.assertEqual(bounded_negative_reference_notes(actual, text="截至2026-10-14，" + candidate,
            source_message_ids=ids), ())
        with self.assertRaises(ValueError):
            replace(source.messages[0], occurred_at=datetime(2026, 10, 14))
        source = loan_window()
        question, answer = source.messages
        source = replace(source, messages=(replace(question, occurred_at=answer.occurred_at - timedelta(days=1)), answer))
        candidate = "联系人原话：“借了，”（相关原文：用户说“老陈借你钱了吗？”）"
        ids = (answer.message_id, question.message_id)
        self.assertEqual(bounded_negative_reference_notes(source, text="截至2026-10-14，" + candidate,
            source_message_ids=ids), loan_notes("截至2026-10-14，" + candidate))
        self.assertEqual(bounded_negative_reference_notes(source, text="截至2026-10-13，" + candidate,
            source_message_ids=ids), ())

    def test_boundaries_reject_whole_inputs_without_truncating_or_matching_a_prefix(self) -> None:
        source = window("他们明天会来家里。")
        message = source.messages[0]
        candidate = "联系人原话：“" + message.text + "”"
        for length in (0, 4096, 4097):
            if length == 0:
                with self.assertRaises(ValueError):
                    replace(message, text="")
            else:
                padded_text = message.text + " " * (length - len(message.text))
                actual = replace(source, messages=(replace(message, text=padded_text),))
                self.assertEqual(bounded_negative_reference_notes(actual, text=candidate,
                    source_message_ids=(message.message_id,)), ())
            padded_candidate = "" if length == 0 else candidate + " " * (length - len(candidate))
            self.assertEqual(bounded_negative_reference_notes(source, text=padded_candidate,
                source_message_ids=(message.message_id,)), ())
        for invalid_targets in ((), (uuid4(),)):
            with self.assertRaises(ValueError):
                replace(source, target_message_ids=invalid_targets)
        source = loan_window()
        question, answer = source.messages
        candidate = "联系人原话：“小林没借。”（相关原文：用户说“老陈借你钱了吗？”）"
        for length in (4096, 4097):
            for index, message in enumerate(source.messages):
                actual = list(source.messages)
                actual[index] = replace(message, text=message.text + " " * (length - len(message.text)))
                self.assertEqual(bounded_negative_reference_notes(replace(source, messages=tuple(actual)), text=candidate,
                    source_message_ids=(answer.message_id, question.message_id)), ())
            self.assertEqual(bounded_negative_reference_notes(source, text=candidate + " " * (length - len(candidate)),
                source_message_ids=(answer.message_id, question.message_id)), ())

    def test_missing_dependencies_or_merged_answers_are_never_repaired(self) -> None:
        source = loan_window()
        for draft in (
            labels(row("1:0", "relationship_event"), row("1:1", "relationship_event")),
            labels(row("1:0", "third_party_fact", dependency="0:0", unresolved=True),
                   row("1:1", "third_party_fact", dependency="0:0", unresolved=True)),
        ):
            with self.subTest(draft=draft):
                original = deepcopy(draft)
                facts = compile_labels(source, draft)
                self.assertTrue(all(fact["alternatives"] in ([], [GENERIC_NOTE]) for fact in facts))
                self.assertEqual(draft, original)

    def test_original_uncertain_and_unsupported_verdicts_remain_negative(self) -> None:
        source = loan_window()
        raw = compile_labels(source, loan_labels())
        for verdict in ("uncertain", "unsupported"):
            verifier = FixedSourceVerifier(tuple(verification_result(candidate_index=index, verdict=verdict, issues=("subject",),
                evidence=((source.messages[1].message_id, source.messages[1].text),)) for index in range(2)))
            outcome = ExtractionFlow(runtime=RecordingRuntime(raw), verification_runtime=verifier).run(source)
            self.assertIsNone(outcome.failure_reason)
            self.assertEqual(tuple(fact.alternatives for fact in verifier.calls[0][1]),
                             tuple(loan_notes(fact["text"]) for fact in raw))
            if verdict == "unsupported":
                self.assertEqual((outcome.accepted, outcome.rejected_count), ((), 2))
            else:
                for fact in outcome.accepted:
                    self.assertEqual(fact.risk_flags, ("semantic:subject",))
                    self.assertEqual(fact.alternatives, loan_notes(fact.text))
                    self.assertFalse(can_auto_adopt(fact, PragmaticInterpreter().interpret(fact)))

    def test_old_protocol_outputs_keep_their_existing_notes_without_new_rules(self) -> None:
        for source, draft in (
            (window("他们明天会来家里。"), labels(row("0:0", "plan", unresolved=True))),
            (loan_window(), loan_labels(unresolved=True)),
        ):
            old_rows = [{"unit": unit, **label} for unit, label in draft["units"].items()]
            for fact in compile_draft(source, {"units": old_rows}):
                self.assertEqual(fact["alternatives"], [GENERIC_NOTE])
            typed = {"units": {unit: {**{key: value for key, value in label.items() if key != "event"},
                                     "ambiguity_codes": ["entity_identity"]}
                               for unit, label in draft["units"].items()}}
            for compiler in (compile_labels_v3, compile_labels_v4):
                for fact in compiler(source, typed):
                    self.assertEqual(fact["alternatives"], ["原句所指人物身份在本窗口无法唯一确定，保留原句。"])
