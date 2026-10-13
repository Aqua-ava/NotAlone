"""通过纯证明接缝核验协议及完整来源，不调用模型或存储。"""

import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID

from notalone.memory_extraction.models import (
    AssertionStatus, ExtractionWindow, FactSubject, FigurativeType, MessageRef,
    MessageSender, SpeechAct,
)
from notalone.memory import MemoryCategory
from notalone.memory_extraction.source_proof import parse_proposal, reverify_basis, verify_proposal
from tests.unit.memory_extraction.dimension_helpers import (
    CONTACT_ID, OWNER_ID, SOURCE_ID, synthetic_fact,
)


def window_for(text: str, sender: MessageSender = MessageSender.CONTACT) -> ExtractionWindow:
    message = MessageRef(
        SOURCE_ID, text, sender, datetime(2026, 10, 13, tzinfo=timezone.utc),
        ({
            "source_ref_id": "dddddddd-4444-4444-4444-444444444444",
            "source_id": "eeeeeeee-5555-5555-5555-555555555555",
            "source_kind": "source_document", "locator": "synthetic:one",
            "raw_payload": {"kind": "公开合成文字"},
            "source_content_sha256": "1" * 64,
        },),
        message_type="text", text_representation="text",
    )
    return ExtractionWindow(OWNER_ID, CONTACT_ID, (message,))


def arrival_proposal(source: str, candidate: str):
    anchor = {"message_id": str(SOURCE_ID), "start": 0, "end": 1}
    return parse_proposal({
        "version": 1,
        "atom_links": [{
            "rule_id": "AUTHOR_ARRIVAL_H1", "variant_id": "direct_h",
            "source": {"message_id": str(SOURCE_ID), "start": 0, "end": len(source)},
            "candidate": {"start": 0, "end": len(candidate)},
        }],
        "reference": [{
            "rule_id": "AUTHOR_ARRIVAL_H1", "mention": anchor,
            "target": anchor, "binding": None,
        }],
        "reported": [{
            "rule_id": "AUTHOR_ARRIVAL_H1", "frame": "direct",
            "source": {"message_id": str(SOURCE_ID), "start": 0, "end": len(source)},
            "candidate": {"start": 0, "end": len(candidate)},
        }],
    })


def relational_proposal(source: str, candidate: str, rule: str, variant: str, frame: str = "direct"):
    main = source.split("。", 1)[0]
    author_index = main.rindex("我")
    anchor = {"message_id": str(SOURCE_ID), "start": author_index, "end": author_index + 1}
    references = [{"rule_id": rule, "mention": anchor, "target": anchor, "binding": None}]
    if "这里的“" in source:
        start = source.index("这里的“")
        pronoun = source[start + 4]
        mention = main.index(pronoun)
        target = source.index("指", start) + 1
        references.append({
            "rule_id": "SOURCE_IDENTITY_H1",
            "mention": {"message_id": str(SOURCE_ID), "start": mention, "end": mention + 1},
            "target": {"message_id": str(SOURCE_ID), "start": target, "end": target + len(source[target:].rstrip("。"))},
            "binding": {"message_id": str(SOURCE_ID), "start": start, "end": len(source.rstrip("。"))},
        })
    span = {"message_id": str(SOURCE_ID), "start": 0, "end": len(source)}
    return parse_proposal({
        "version": 1, "reference": references,
        "atom_links": [{"rule_id": rule, "variant_id": variant, "source": span,
                        "candidate": {"start": 0, "end": len(candidate)}}],
        "reported": [{"rule_id": rule, "frame": frame, "source": span,
                      "candidate": {"start": 0, "end": len(candidate)}}],
    })


class SourceProofContractTests(unittest.TestCase):
    def test_missing_proof_keeps_unknown(self) -> None:
        self.assertIsNone(parse_proposal(None))

    def test_proposal_accepts_only_versioned_bounded_positions(self) -> None:
        payload = {
            "version": 1, "reference": None, "reported": None,
            "atom_links": [{
                "rule_id": "AUTHOR_ARRIVAL_H1", "variant_id": "direct_h",
                "source": {
                    "message_id": "cccccccc-3333-3333-3333-333333333333",
                    "start": 0, "end": 4,
                },
                "candidate": {"start": 0, "end": 6},
            }],
        }
        parsed = parse_proposal(payload)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.version, 1)
        invalid = []
        for value in (True, 1.0, -1, 2):
            changed = deepcopy(payload)
            changed["version"] = value
            invalid.append(changed)
        for value in (True, 1.0, -1):
            changed = deepcopy(payload)
            changed["atom_links"][0]["source"]["start"] = value
            invalid.append(changed)
        changed = deepcopy(payload)
        changed["valid"] = True
        invalid.append(changed)
        changed = deepcopy(payload)
        changed["atom_links"] *= 17
        invalid.append(changed)
        for changed in invalid:
            with self.subTest(payload=changed), self.assertRaises(ValueError):
                parse_proposal(changed)

    def test_actual_author_arrival_keeps_recency_and_original_source(self) -> None:
        source, candidate = "我刚到家", "联系人刚到家"
        result = verify_proposal(
            arrival_proposal(source, candidate), window_for(source),
            synthetic_fact(text=candidate), {SOURCE_ID: source},
        )
        self.assertEqual(result.status, "verified")
        basis = result.semantic_basis
        self.assertEqual(basis["frame"], "direct")
        self.assertEqual(basis["atoms"][0]["predicate"], "arrive_home")
        self.assertEqual(basis["atoms"][0]["roles"]["actor"], 0)
        self.assertEqual(basis["roles"][0]["sender"], "contact")
        self.assertEqual(basis["qualifiers"][0]["slot"], "event_time")
        self.assertEqual(basis["source_graph_sha256"], basis["candidate_graph_sha256"])
        basis["frame"] = "received_request_h"
        self.assertEqual(result.semantic_basis["frame"], "direct")

    def test_lend_owner_requires_complete_source_identity(self) -> None:
        source = "我姐把她的车借给我了。这里的“她”指我姐。"
        candidate = "联系人的姐姐把自己的车借给了联系人"
        fact = synthetic_fact(text=candidate)
        result = verify_proposal(
            relational_proposal(source, candidate, "KIN_LEND_BA_H1", "completed_h"),
            window_for(source), fact,
        )
        self.assertEqual(result.status, "verified")
        basis = result.semantic_basis
        self.assertEqual(basis["atoms"][0]["roles"]["property_owner"], 1)
        self.assertEqual(basis["reference_bindings"][1]["method"], "source_identity")
        unknown_source = "我姐把她的车借给我了"
        for guessed in (candidate, "联系人的姐姐把联系人的车借给了联系人"):
            with self.subTest(candidate=guessed):
                unknown = verify_proposal(None, window_for(unknown_source), replace(fact, text=guessed))
                self.assertEqual((unknown.status, unknown.reason), ("UNKNOWN", "missing_source_identity"))
        changed = "联系人把自己的车借给了联系人的姐姐"
        rejected = verify_proposal(None, window_for(unknown_source), replace(fact, text=changed))
        self.assertEqual((rejected.status, rejected.reason), ("unsupported", "known_graph_difference"))

    def test_parameterized_negative_lend_keeps_time_object_and_polarity(self) -> None:
        source = "我哥前天没有把他的书借给我。这里的“他”指我哥。"
        candidate = "联系人的哥哥前天没有把自己的书借给联系人"
        result = verify_proposal(
            relational_proposal(source, candidate, "KIN_LEND_BA_H1", "negative_h"),
            window_for(source), synthetic_fact(text=candidate),
        )
        self.assertEqual(result.status, "verified")
        self.assertEqual([item["kind"] for item in result.semantic_basis["qualifiers"]], ["polarity", "time"])
        for changed in (
            "联系人的姐姐前天没有把自己的书借给联系人",
            "联系人的哥哥前天没有把自己的车借给联系人",
            "联系人的哥哥前天把自己的书借给了联系人",
            "联系人的哥哥没有把自己的书借给联系人",
        ):
            with self.subTest(candidate=changed):
                rejected = verify_proposal(None, window_for(source), synthetic_fact(text=changed))
                self.assertEqual(rejected.status, "unsupported")

    def test_saved_basis_requires_current_full_reparse(self) -> None:
        source, candidate = "我刚到家", "联系人刚到家"
        window, fact = window_for(source), synthetic_fact(text=candidate)
        basis = verify_proposal(arrival_proposal(source, candidate), window, fact).semantic_basis
        self.assertEqual(reverify_basis(basis, window, fact).status, "verified")
        changed = deepcopy(basis)
        changed["atoms"][0]["roles"]["actor"] = True
        self.assertEqual(reverify_basis(changed, window, fact).status, "UNKNOWN")
        self.assertNotEqual(reverify_basis(basis, window, replace(fact, text="用户刚到家")).status, "verified")

    def test_request_frames_keep_inner_roles_and_unaccepted_stage(self) -> None:
        source = "我同事让我周末帮他顶个班。这里的“他”指我同事。"
        candidates = (
            ("用户的同事已提出请托，内容是希望用户周末替该同事顶班，未说明接受", "quoted_request_h", SpeechAct.REPORT, AssertionStatus.REPORTED),
            ("用户已收到用户的同事请托；所请内容为用户周末替该同事顶班，未说明接受", "received_request_h", SpeechAct.ASSERTION, AssertionStatus.ASSERTED),
        )
        for text, frame, speech, assertion in candidates:
            with self.subTest(frame=frame):
                fact = synthetic_fact(text=text, subject=FactSubject.SELF,
                                      category=MemoryCategory.RELATIONSHIP_NOTE,
                                      speech_act=speech, assertion_status=assertion)
                result = verify_proposal(
                    relational_proposal(source, text, "REQUEST_ROLE_H1", frame, frame),
                    window_for(source, MessageSender.SELF), fact,
                )
                self.assertEqual(result.status, "verified")
                self.assertEqual(result.semantic_basis["atoms"][1]["roles"]["beneficiary"], 1)
                self.assertEqual(result.semantic_basis["qualifiers"][0]["slot"], "requested_time")
                unknown = verify_proposal(None, window_for(source.split("。", 1)[0], MessageSender.SELF), fact)
                self.assertEqual((unknown.status, unknown.reason), ("UNKNOWN", "missing_source_identity"))
        for text, reason in (
            ("用户已答应周末替用户的同事顶班", "unsupported_addition"),
            ("用户有义务周末替用户的同事顶班", "unsupported_addition"),
            ("用户已经周末替用户的同事顶班了", "stage_change"),
            ("用户周末已收到用户的同事请托；所请内容为用户替该同事顶班，未说明接受", "known_graph_difference"),
        ):
            with self.subTest(candidate=text):
                rejected = verify_proposal(None, window_for(source, MessageSender.SELF), synthetic_fact(text=text, subject=FactSubject.SELF))
                self.assertEqual((rejected.status, rejected.reason), ("unsupported", reason))

    def test_conditional_plan_keeps_quantity_degrees_condition_and_time(self) -> None:
        source = "如果天晴，我计划明天只跑约3公里"
        candidate = "如果天晴，联系人计划明天只跑约3000米"
        fact = synthetic_fact(text=candidate, speech_act=SpeechAct.PLAN,
                              assertion_status=AssertionStatus.CONDITIONAL)
        result = verify_proposal(
            relational_proposal(source, candidate, "COND_PLAN_RUN_V1", "conditional_plan"),
            window_for(source), fact,
        )
        self.assertEqual(result.status, "verified")
        qualifiers = result.semantic_basis["qualifiers"]
        self.assertEqual([item["kind"] for item in qualifiers], ["quantity", "degree", "degree", "condition", "time"])
        self.assertEqual(qualifiers[1]["quantity_qualifier_id"], 0)
        self.assertEqual(qualifiers[3]["condition_atom_id"], 0)
        self.assertEqual(qualifiers[3]["action_atom_id"], 1)
        self.assertEqual(reverify_basis(result.semantic_basis, window_for(source), fact).status, "verified")
        for candidate in (
            "联系人计划明天只跑约3000米", "如果天晴，联系人计划明天跑约3000米",
            "如果天晴，联系人计划明天只跑3000米", "如果天晴，联系人计划明天只跑约米",
            "如果天晴，联系人计划明天只跑约3000", "如果天晴，联系人计划只跑约3000米",
            "如果天晴，联系人已经明天只跑约3000米了",
        ):
            with self.subTest(candidate=candidate):
                rejected = verify_proposal(None, window_for(source), replace(fact, text=candidate))
                self.assertEqual(rejected.status, "unsupported")

    def test_new_parameter_combinations_use_same_complete_grammar(self) -> None:
        sources = (
            ("我姐昨天没把她的雨伞借给我。这里的“她”指我姐。", "用户的姐姐昨天没有把自己的雨伞借给用户", "KIN_LEND_BA_H1", "negative_h", MessageSender.SELF),
            ("我哥前天把他的书借给我了。这里的“他”指我哥。", "联系人的哥哥前天把联系人的哥哥的书借给了联系人", "KIN_LEND_BA_H1", "completed_h", MessageSender.CONTACT),
            ("如果天晴，我计划后天跑约7.5公里。", "如果天晴，联系人计划后天跑约7500米", "COND_PLAN_RUN_V1", "conditional_plan", MessageSender.CONTACT),
        )
        for source, candidate, rule, variant, sender in sources:
            with self.subTest(rule=rule, source=source):
                fact = synthetic_fact(
                    text=candidate, subject=FactSubject(sender.value),
                    speech_act=SpeechAct.PLAN if rule == "COND_PLAN_RUN_V1" else SpeechAct.ASSERTION,
                    assertion_status=AssertionStatus.CONDITIONAL if rule == "COND_PLAN_RUN_V1" else AssertionStatus.ASSERTED,
                )
                result = verify_proposal(relational_proposal(source, candidate, rule, variant), window_for(source, sender), fact)
                self.assertEqual(result.status, "verified")
                self.assertEqual(reverify_basis(result.semantic_basis, window_for(source, sender), fact).status, "verified")
                changed_source = source.replace("前天", "昨天") if "前天" in source else source.replace("雨伞", "书") if "雨伞" in source else source.replace("7.5", "7.6")
                self.assertEqual(verify_proposal(None, window_for(changed_source, sender), fact).status, "unsupported")
        source = "我姐让我后天帮她顶个班。这里的“她”指我姐。"
        for frame, candidate, speech, assertion in (
            ("quoted_request_h", "用户的姐姐已提出请托，内容是希望用户后天替该姐姐顶班，未说明接受", SpeechAct.REPORT, AssertionStatus.REPORTED),
            ("received_request_h", "用户已收到用户的姐姐请托；所请内容为用户后天替该姐姐顶班，未说明接受", SpeechAct.ASSERTION, AssertionStatus.ASSERTED),
        ):
            fact = synthetic_fact(text=candidate, subject=FactSubject.SELF,
                                  category=MemoryCategory.RELATIONSHIP_NOTE,
                                  speech_act=speech, assertion_status=assertion)
            result = verify_proposal(relational_proposal(source, candidate, "REQUEST_ROLE_H1", frame, frame), window_for(source, MessageSender.SELF), fact)
            self.assertEqual(result.status, "verified")
            self.assertEqual(verify_proposal(None, window_for(source, MessageSender.SELF), replace(fact, text=candidate.replace("后天", "明天"))).status, "unsupported")

    def test_unlisted_context_names_media_and_pragmatics_keep_unknown(self) -> None:
        source, candidate = "我刚到家", "联系人刚到家"
        window, fact = window_for(source), synthetic_fact(text=candidate)
        variants = (
            (window_for("我不喝酒"), replace(fact, text="联系人喝酒")),
            (window_for("小王说“我刚到家”"), fact),
            (window_for(source + "，今天很开心"), fact),
            (window, replace(fact, text="小王刚到家")),
            (replace(window, messages=(replace(window.messages[0], message_type="image", text_representation="placeholder"),)), fact),
            (replace(window, messages=(replace(window.messages[0], source_snapshots=()),)), fact),
            (window, replace(fact, speech_act=SpeechAct.PLAN)),
            (window, replace(fact, figurative_type=FigurativeType.JOKE)),
            (window, replace(fact, source_message_ids=(UUID("ffffffff-6666-6666-6666-666666666666"),))),
            (replace(window, messages=(window.messages[0], replace(window.messages[0], message_id=UUID("ffffffff-6666-6666-6666-666666666666"), text="独立上下文"))), fact),
        )
        for current, candidate_fact in variants:
            with self.subTest(source=current.messages[0].text, candidate=candidate_fact.text):
                self.assertEqual(verify_proposal(None, current, candidate_fact).status, "UNKNOWN")
        self.assertEqual(verify_proposal(arrival_proposal(source, candidate), window, fact, {SOURCE_ID: "另一个实际文本"}).status, "UNKNOWN")
        self.assertEqual(verify_proposal(None, window, fact).reason, "missing_proof")

    def test_proposal_ranges_are_checked_against_actual_complete_strings(self) -> None:
        source, candidate = "我刚到家", "联系人刚到家"
        proposal = arrival_proposal(source, candidate)
        for span in (
            replace(proposal.atom_links[0].source, end=99),
            replace(proposal.atom_links[0].source, message_id=UUID("ffffffff-6666-6666-6666-666666666666")),
        ):
            with self.subTest(span=span), self.assertRaises(ValueError):
                verify_proposal(replace(proposal, atom_links=(replace(proposal.atom_links[0], source=span),)), window_for(source), synthetic_fact(text=candidate))
        with self.assertRaises(ValueError):
            verify_proposal(replace(proposal, atom_links=(replace(proposal.atom_links[0], candidate=replace(proposal.atom_links[0].candidate, end=99)),)), window_for(source), synthetic_fact(text=candidate))

    def test_changed_qualifier_relationships_fail_reparse_even_with_old_graph_hashes(self) -> None:
        source, candidate = "如果天晴，我计划后天跑约7.5公里", "如果天晴，联系人计划后天跑约7500米"
        window = window_for(source)
        fact = synthetic_fact(text=candidate, speech_act=SpeechAct.PLAN, assertion_status=AssertionStatus.CONDITIONAL)
        basis = verify_proposal(relational_proposal(source, candidate, "COND_PLAN_RUN_V1", "conditional_plan"), window, fact).semantic_basis
        for key, index, value in (
            ("atom_id", 0, 0), ("quantity_qualifier_id", 1, 3),
            ("condition_atom_id", 2, 1), ("action_atom_id", 2, 0),
        ):
            changed = deepcopy(basis)
            changed["qualifiers"][index][key] = value
            with self.subTest(key=key):
                self.assertEqual(reverify_basis(changed, window, fact).status, "UNKNOWN")

    def test_all_proposal_object_shapes_reject_unknown_or_missing_fields(self) -> None:
        base = {
            "version": 1, "atom_links": None, "reference": None, "reported": None,
        }
        invalid = []
        for key in base:
            value = deepcopy(base)
            del value[key]
            invalid.append(value)
        for field in ("reference", "reported", "atom_links"):
            for value in ({}, "[]", [True]):
                changed = deepcopy(base)
                changed[field] = value
                invalid.append(changed)
        source, candidate = "我刚到家", "联系人刚到家"
        proposal = arrival_proposal(source, candidate)
        for field, value in (("reference", None), ("reported", None), ("atom_links", None)):
            result = verify_proposal(replace(proposal, **{field: value}), window_for(source), synthetic_fact(text=candidate))
            self.assertEqual(result.status, "UNKNOWN")
        for value in invalid:
            with self.subTest(payload=value), self.assertRaises(ValueError):
                parse_proposal(value)


if __name__ == "__main__":
    unittest.main()
