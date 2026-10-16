"""有限作者引句的原事件证明；不读取模型或存储。"""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
import unittest
from uuid import uuid4

from notalone.memory_extraction.models import (
    AssertionStatus, FactSubject, FigurativeType, MessageSender, SpeechAct,
)
from notalone.memory import MemoryCategory
from notalone.memory_extraction.source_proof import parse_proposal, reverify_basis, verify_proposal
from tests.unit.memory_extraction.dimension_helpers import SOURCE_ID, synthetic_fact
from tests.unit.memory_extraction.test_source_proof import window_for


def quote_proposal_payload(source: str, candidate: str, message_id=SOURCE_ID) -> dict:
    author = len(source) - len(source.lstrip())
    source_span = {"message_id": str(message_id), "start": 0, "end": len(source)}
    candidate_span = {"start": 0, "end": len(candidate)}
    anchor = {"message_id": str(message_id), "start": author, "end": author + 1}
    return {
        "version": 2,
        "atom_links": [{"rule_id": "AUTHOR_ARRIVAL_H1", "variant_id": "author_quote_h1",
                        "source": source_span, "candidate": candidate_span}],
        "reference": [{"rule_id": "AUTHOR_ARRIVAL_H1", "mention": anchor, "target": anchor, "binding": None}],
        "reported": [{"rule_id": "AUTHOR_ARRIVAL_H1", "frame": "direct",
                      "source": source_span, "candidate": candidate_span}],
    }


class AuthorQuoteProofTest(unittest.TestCase):
    def test_complete_event_uses_actual_unicode_coordinates_and_reverifies(self):
        source, candidate = " 我刚刚到家。 ", " 联系人原话：“我刚刚到家。” "
        fact = synthetic_fact(text=candidate, category=MemoryCategory.COMMON_FACT)
        proof = parse_proposal(quote_proposal_payload(source, candidate), version=2)
        checked = verify_proposal(proof, window_for(source), fact, proof_version=2)
        self.assertEqual((checked.status, checked.reason), ("verified", "verified"))
        basis = checked.semantic_basis
        self.assertEqual(basis["version"], 2)
        self.assertEqual(basis["rules"], [{"rule_id": "AUTHOR_ARRIVAL_H1", "rule_version": 2}])
        self.assertEqual(basis["frame"], "direct")
        self.assertEqual(basis["atoms"][0]["predicate"], "arrive_home")
        self.assertEqual(basis["atoms"][0]["phase"], "completed")
        representation = basis["representation"]
        self.assertEqual((representation["version"], representation["kind"]), (1, "author_quote_h1"))
        for name, interval in (("candidate", (1, 15)), ("author", (1, 4)), ("inner", (8, 14))):
            self.assertEqual((representation[name]["start"], representation[name]["end"]), interval)
        self.assertEqual((representation["source"]["span"]["start"], representation["source"]["span"]["end"]), (1, 7))
        qualifier = basis["qualifiers"][0]["candidate"]
        self.assertEqual((qualifier["start"], qualifier["end"]), (9, 11))
        self.assertEqual(basis["capabilities"], ["author_binding", "arrival_event_preservation",
                                             "author_self_reference", "direct_attribution", "recency_preservation"])
        self.assertEqual(reverify_basis(basis, window_for(source), fact).status, "verified")

    def test_new_basis_round_trip_keeps_representation_spans_and_rejects_tampering(self):
        from notalone.memory.dimension_evidence import SemanticBasis

        source, candidate = "我刚到家", "联系人原话：“我刚到家”"
        fact = synthetic_fact(text=candidate, category=MemoryCategory.COMMON_FACT)
        proof = parse_proposal(quote_proposal_payload(source, candidate), version=2)
        payload = verify_proposal(proof, window_for(source), fact, proof_version=2).semantic_basis
        basis = SemanticBasis.from_payload(payload)
        self.assertEqual(basis.to_payload(), payload)
        self.assertEqual(len(basis.candidate_spans), 5)
        self.assertEqual(len(basis.message_spans), 6)
        for field, value in (("version", True), ("capabilities", ["author_binding"]),
                             ("frame", "quoted_request_h"), ("rules", [{"rule_id": "AUTHOR_ARRIVAL_H1", "rule_version": 1}])):
            bad = deepcopy(payload)
            bad[field] = value
            with self.subTest(field=field), self.assertRaises((ValueError, TypeError)):
                SemanticBasis.from_payload(bad)
        for path in (("representation", "inner", "sha256"), ("qualifiers", 0, "candidate", "sha256")):
            bad = deepcopy(payload)
            target = bad
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = "f" * 64
            with self.subTest(path=path), self.assertRaises(ValueError):
                SemanticBasis.from_payload(bad)

    def test_only_new_representation_requires_completed_common_fact_category(self):
        from tests.unit.memory_extraction.test_source_proof import arrival_proposal

        source, candidate = "我刚到家", "联系人原话：“我刚到家”"
        fact = synthetic_fact(text=candidate, category=MemoryCategory.COMMON_FACT)
        proof = parse_proposal(quote_proposal_payload(source, candidate), version=2)
        basis = verify_proposal(proof, window_for(source), fact, proof_version=2).semantic_basis
        for category in MemoryCategory:
            if category is MemoryCategory.COMMON_FACT:
                continue
            with self.subTest(category=category):
                changed = replace(fact, category=category)
                result = verify_proposal(proof, window_for(source), changed, proof_version=2)
                self.assertEqual((result.status, result.reason), ("UNKNOWN", "pragmatics_not_supported"))
                self.assertIsNone(result.semantic_basis)
                self.assertEqual(reverify_basis(basis, window_for(source), changed).status, "UNKNOWN")
        direct = "联系人刚到家"
        old = verify_proposal(arrival_proposal(source, direct), window_for(source), synthetic_fact(text=direct))
        self.assertEqual((old.status, old.semantic_basis["version"]), ("verified", 1))
        self.assertEqual(old.semantic_basis["rule_set_sha256"], "b3e74a14c5c7d1d9589c7f8d53b107a67937432c9f218f2b83d7c5b401fe76c6")

    def test_exact_sender_and_complete_variants_preserve_event_not_a_speech_claim(self):
        for sender, author in ((MessageSender.SELF, "用户"), (MessageSender.CONTACT, "联系人")):
            for text in ("我刚到家", "我刚刚到家。", " 我刚到家。 "):
                with self.subTest(sender=sender, text=text):
                    candidate = f'{author}原话：“{text.strip()}”'
                    fact = synthetic_fact(text=candidate, subject=FactSubject(sender.value), category=MemoryCategory.COMMON_FACT)
                    proof = parse_proposal(quote_proposal_payload(text, candidate), version=2)
                    result = verify_proposal(proof, window_for(text, sender), fact, proof_version=2)
                    self.assertEqual(result.status, "verified")
                    self.assertEqual(result.semantic_basis["roles"][0]["sender"], sender.value)
                    self.assertEqual(result.semantic_basis["atoms"][0]["predicate"], "arrive_home")

    def test_other_grammar_partial_wrapper_and_weak_links_do_not_sign(self):
        for source, candidate in (
            ("我刚到家", "联系人刚到家"),
            ("我刚到家", "联系人原话：“我刚到家”。"),
            ("我刚到家。", "联系人原话：“我刚到家”"),
            ("我刚到家", "联系人原话：“我刚到家”并休息了"),
            ("我刚到家。继续聊", "联系人原话：“我刚到家。继续聊”"),
            ("如果我刚到家", "联系人原话：“如果我刚到家”"),
            ("我没到家", "联系人原话：“我没到家”"),
            ("我刚到家了", "联系人原话：“我刚到家了”"),
            ("我刚到家。。", "联系人原话：“我刚到家。。”"),
            ("我说“我刚到家”", "联系人原话：“我说“我刚到家””"),
        ):
            with self.subTest(source=source, candidate=candidate):
                result = verify_proposal(None, window_for(source), synthetic_fact(text=candidate, category=MemoryCategory.COMMON_FACT), proof_version=2)
                self.assertEqual((result.status, result.reason), ("UNKNOWN", "unsupported_grammar"))
        source, candidate = "我刚到家", "联系人原话：“我刚到家”"
        fact = synthetic_fact(text=candidate, category=MemoryCategory.COMMON_FACT)
        for missing in ("atom_links", "reference", "reported"):
            payload = quote_proposal_payload(source, candidate)
            payload[missing] = []
            result = verify_proposal(parse_proposal(payload, version=2), window_for(source), fact, proof_version=2)
            self.assertEqual((result.status, result.reason), ("UNKNOWN", "proposal_not_matching"))
        payload = quote_proposal_payload(source, candidate)
        payload["atom_links"][0]["candidate"] = {"start": 7, "end": 11}
        self.assertEqual(verify_proposal(parse_proposal(payload, version=2), window_for(source), fact, proof_version=2).reason, "proposal_not_matching")
        for link in ("atom_links", "reported"):
            payload = quote_proposal_payload(source, candidate)
            payload[link][0]["source"]["end"] -= 1
            self.assertEqual(verify_proposal(parse_proposal(payload, version=2), window_for(source), fact, proof_version=2).reason, "proposal_not_matching")
        self.assertEqual(verify_proposal(None, window_for(source), fact, proof_version=2).reason, "missing_proof")

    def test_actual_author_subject_pragmatics_and_scope_remain_independent(self):
        source, candidate = "我刚到家", "联系人原话：“我刚到家”"
        window = window_for(source)
        fact = synthetic_fact(text=candidate, category=MemoryCategory.COMMON_FACT)
        proof = parse_proposal(quote_proposal_payload(source, candidate), version=2)
        for changes in (
            {"subject": FactSubject.SELF}, {"speech_act": SpeechAct.REPORT},
            {"assertion_status": AssertionStatus.REPORTED}, {"figurative_type": FigurativeType.UNKNOWN},
            {"valid_at": datetime(2026, 10, 16, tzinfo=timezone.utc)},
            {"invalid_at": datetime(2026, 10, 17, tzinfo=timezone.utc)},
        ):
            with self.subTest(changes=changes):
                result = verify_proposal(proof, window, replace(fact, **changes), proof_version=2)
                self.assertEqual((result.status, result.reason), ("UNKNOWN", "pragmatics_not_supported"))
        wrong = replace(fact, text="用户原话：“我刚到家”")
        self.assertEqual(verify_proposal(None, window, wrong, proof_version=2).reason, "known_graph_difference")
        for message in (replace(window.messages[0], source_snapshots=()),
                        replace(window.messages[0], message_type="image")):
            result = verify_proposal(proof, replace(window, messages=(message,)), fact, proof_version=2)
            self.assertEqual((result.status, result.reason), ("UNKNOWN", "untrusted_source"))
        extra = replace(window.messages[0], message_id=uuid4())
        self.assertEqual(verify_proposal(proof, replace(window, messages=(*window.messages, extra)), fact, proof_version=2).reason, "scope_not_supported")
        self.assertEqual(verify_proposal(proof, window, fact, {SOURCE_ID: "别的正文"}, proof_version=2).reason, "untrusted_source")

    def test_proposal_version_and_actual_bounds_remain_strict_before_trust(self):
        source, candidate = "我刚到家", "联系人原话：“我刚到家”"
        valid = quote_proposal_payload(source, candidate)
        invalid = []
        for version in (1, True, 2.0):
            invalid.append({**valid, "version": version})
        for value in (False, 0.0, -1):
            bad = deepcopy(valid)
            bad["atom_links"][0]["source"]["start"] = value
            invalid.append(bad)
        for field, value in (("variant_id", "direct_h"), ("rule_id", "KIN_LEND_BA_H1")):
            bad = deepcopy(valid)
            bad["atom_links"][0][field] = value
            invalid.append(bad)
        bad = deepcopy(valid)
        bad["reported"][0]["frame"] = "quoted_request_h"
        invalid.append(bad)
        invalid.append({**valid, "source_bound": True})
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_proposal(payload, version=2)
        with self.assertRaises(ValueError):
            parse_proposal(valid)
        window = window_for(source)
        untrusted = replace(window, messages=(replace(window.messages[0], source_snapshots=()),))
        for field, value in (("end", len(source) + 1), ("message_id", str(uuid4()))):
            bad = deepcopy(valid)
            bad["atom_links"][0]["source"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_proposal(parse_proposal(bad, version=2), untrusted, synthetic_fact(text=candidate), proof_version=2)
