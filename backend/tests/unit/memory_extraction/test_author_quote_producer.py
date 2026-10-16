"""显式新协议经实际compiler/adapter/producer，不调用外部模型。"""
from dataclasses import replace
from copy import deepcopy
import json
import unittest
from uuid import uuid4

from notalone.memory import InMemoryMemoryStore
from notalone.memory_extraction.adoption import MemoryAdoption
from notalone.memory_extraction.dimensions import required_dimensions, valid_evidence_dimensions
from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
from notalone.memory.dimension_evidence import DimensionEvidence, SemanticBasis
from notalone.memory.evidence_binding import bind_dimension_evidence
from notalone.memory_extraction.models import FactSubject, MessageSender
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.author_quote_helpers import author_quote_producer
from tests.unit.memory_extraction.test_source_proof import window_for
from tests.unit.memory_extraction.test_author_quote_proof import quote_proposal_payload


class AuthorQuoteProducerTest(unittest.TestCase):
    def test_compiler_single_fake_v_and_real_producer_keep_default_pending(self):
        window = window_for("我刚到家。")
        outcome, model, raw = author_quote_producer(window)
        self.assertIsNone(outcome.failure_kind)
        self.assertEqual(len(model.seen_calls), 1)
        fact, = outcome.accepted
        self.assertEqual(fact.text, "联系人原话：“我刚到家。”")
        self.assertEqual(fact.dimension_evidence.version, 3)
        self.assertEqual(fact.dimension_evidence.semantic_basis.to_payload()["version"], 2)
        self.assertTrue(fact.dimension_evidence.source_bound)
        self.assertEqual(required_dimensions(fact), {"subject", "truth_intent", "paraphrase", "reference", "reported", "time"})
        self.assertTrue({"subject", "paraphrase", "reference", "reported", "time"} <= valid_evidence_dimensions(fact))
        scope = ContactScope(window.owner_id, window.contact_id)
        stats = MemoryAdoption(memory_port=InMemoryMemoryStore()).adopt(scope, outcome)
        self.assertEqual((stats.pending, stats.adopted), (1, 0))
        self.assertEqual(raw["verdict"], "supported")

    def test_actual_adapter_selects_independent_closed_schema_and_prompt(self):
        _, model, _ = author_quote_producer(window_for("我刚到家"))
        schema = model.seen_schemas[0]["properties"]["results"]["items"]
        self.assertEqual(set(schema["required"]), {"candidate_index", "verdict", "issues", "evidence"})
        proof = schema["properties"]["proof"]
        self.assertEqual(set(proof["properties"]), {"version", "atom_links", "reference", "reported"})
        self.assertEqual(proof["properties"]["version"], {"type": "integer", "const": 2})
        atom = proof["properties"]["atom_links"]["items"]
        self.assertEqual(atom["properties"]["rule_id"]["enum"], ["AUTHOR_ARRIVAL_H1"])
        self.assertEqual(atom["properties"]["variant_id"]["enum"], ["author_quote_h1"])
        self.assertEqual(proof["properties"]["reported"]["items"]["properties"]["frame"]["enum"], ["direct"])
        prompt = str(model.seen_calls[0])
        self.assertIn("nullable-proof-v2", prompt)
        self.assertIn("common_fact", prompt)
        self.assertNotIn("source_bound", json.dumps(schema))

    def test_missing_null_or_weak_proof_never_self_signs_capabilities(self):
        source, candidate = "我刚到家", "联系人原话：“我刚到家”"
        weak = quote_proposal_payload(source, candidate)
        weak["reported"] = []
        for proposed in (None, "omitted", weak):
            with self.subTest(proof=proposed):
                outcome, model, _ = author_quote_producer(window_for(source), proof=proposed)
                self.assertIsNone(outcome.failure_kind)
                fact, = outcome.accepted
                self.assertEqual(fact.dimension_evidence.version, 3)
                self.assertIsNone(fact.dimension_evidence.semantic_basis)
                self.assertFalse({"paraphrase", "reference", "reported", "time"} & valid_evidence_dimensions(fact))
                self.assertEqual(len(model.seen_calls), 1)

    def test_old_modes_reject_new_proof_and_new_mode_rejects_old_proof_without_retry(self):
        for mode in ("legacy-v4", "nullable-proof-v1"):
            with self.subTest(mode=mode):
                outcome, model, _ = author_quote_producer(window_for("我刚到家"), mode=mode)
                self.assertIsNotNone(outcome.failure_kind)
                self.assertFalse(outcome.accepted)
                self.assertEqual(len(model.seen_calls), 1)
        proof = quote_proposal_payload("我刚到家", "联系人原话：“我刚到家”")
        proof["version"] = 1
        outcome, model, _ = author_quote_producer(window_for("我刚到家"), proof=proof)
        self.assertIsNotNone(outcome.failure_kind)
        self.assertEqual(len(model.seen_calls), 1)

    def test_valid_proof_does_not_upgrade_uncertain_or_unsupported_model_verdict(self):
        window = window_for("我刚到家")
        for verdict, issues in (("uncertain", ("meaning",)), ("unsupported", ("meaning",))):
            with self.subTest(verdict=verdict):
                outcome, model, _ = author_quote_producer(window, verdict=verdict, issues=issues)
                self.assertIsNone(outcome.failure_kind)
                self.assertEqual(len(model.seen_calls), 1)
                if verdict == "uncertain":
                    fact, = outcome.accepted
                    self.assertIn("semantic:meaning", fact.risk_flags)
                    stats = MemoryAdoption(memory_port=InMemoryMemoryStore(), dimension_release=RELEASE_ALL_DIMENSIONS).adopt(
                        ContactScope(window.owner_id, window.contact_id), outcome)
                    self.assertEqual((stats.pending, stats.adopted), (1, 0))
                else:
                    self.assertFalse(outcome.accepted)

    def test_current_text_author_graph_and_capabilities_require_real_rebinding(self):
        window = window_for("我刚到家")
        outcome, _, _ = author_quote_producer(window)
        fact, = outcome.accepted
        evidence = fact.dimension_evidence
        payload = evidence.to_payload()
        self.assertEqual(DimensionEvidence.from_payload(payload).to_payload(), payload)
        self.assertFalse(DimensionEvidence.from_payload(payload).source_bound)
        kwargs = {"scope": evidence.scope, "candidate": fact, "messages": evidence.messages,
                  "texts": {window.messages[0].message_id: window.messages[0].text},
                  "source_snapshots": {window.messages[0].message_id: window.messages[0].source_snapshots}}
        self.assertTrue(bind_dimension_evidence(evidence, **kwargs).source_bound)
        for changes in (
            {"candidate": replace(fact, text="用户原话：“我刚到家”")},
            {"candidate": replace(fact, subject=FactSubject.SELF)},
            {"texts": {window.messages[0].message_id: "我刚刚到家"}},
            {"source_snapshots": {window.messages[0].message_id: ()}},
        ):
            with self.subTest(changes=changes):
                self.assertFalse(bind_dimension_evidence(evidence, **{**kwargs, **changes}).source_bound)
        for path, value in (
            (("semantic_basis", "rule_set_sha256"), "f" * 64),
            (("semantic_basis", "source_graph_sha256"), "f" * 64),
            (("semantic_basis", "representation", "author", "sha256"), "f" * 64),
        ):
            bad = deepcopy(payload)
            target = bad
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path):
                try:
                    parsed = DimensionEvidence.from_payload(bad)
                except ValueError:
                    continue
                self.assertFalse(bind_dimension_evidence(parsed, **kwargs).source_bound)
        with self.assertRaises((TypeError, ValueError)):
            DimensionEvidence.from_payload({**payload, "version": 2})
        from notalone.memory_extraction.source_proof import verify_proposal
        from tests.unit.memory_extraction.test_source_proof import arrival_proposal
        from tests.unit.memory_extraction.dimension_helpers import synthetic_fact
        old_basis = verify_proposal(arrival_proposal("我刚到家", "联系人刚到家"), window,
                                   synthetic_fact(text="联系人刚到家")).semantic_basis
        with self.assertRaises((TypeError, ValueError)):
            DimensionEvidence.from_payload({**payload, "semantic_basis": old_basis})
        with self.assertRaises(ValueError):
            SemanticBasis.from_payload({**payload["semantic_basis"], "capabilities": ["author_binding"]})

    def test_release_override_does_not_bypass_existing_confidence_or_risk_gates(self):
        window = window_for("我刚到家")
        for confidence, sensitivity, expected in ((.69, "none", (1, 0)), (.70, "none", (0, 1)), (.92, "financial", (1, 0))):
            with self.subTest(confidence=confidence, sensitivity=sensitivity):
                outcome, _, _ = author_quote_producer(window, confidence=confidence, sensitivity=sensitivity)
                stats = MemoryAdoption(memory_port=InMemoryMemoryStore(), dimension_release=RELEASE_ALL_DIMENSIONS).adopt(
                    ContactScope(window.owner_id, window.contact_id), outcome)
                self.assertEqual((stats.pending, stats.adopted), expected)

    def test_public_weak_source_remains_unknown_and_self_wrapper_binds_actual_self(self):
        window = window_for("我刚到家")
        weak = replace(window, messages=(replace(window.messages[0], source_snapshots=()),))
        outcome, _, _ = author_quote_producer(weak)
        self.assertIsNone(outcome.accepted[0].dimension_evidence.semantic_basis)
        own, _, _ = author_quote_producer(window_for("我刚到家", MessageSender.SELF))
        self.assertTrue(own.accepted[0].dimension_evidence.source_bound)
        self.assertEqual(own.accepted[0].text, "用户原话：“我刚到家”")
        context = replace(window.messages[0], message_id=uuid4(), text="独立合成上下文")
        contextual = replace(window, messages=(context, window.messages[0]), target_message_ids=(window.messages[0].message_id,))
        contextual_outcome, _, _ = author_quote_producer(contextual)
        contextual_fact, = contextual_outcome.accepted
        self.assertEqual(contextual_fact.source_message_ids, (window.messages[0].message_id,))
        self.assertIsNone(contextual_fact.dimension_evidence.semantic_basis)
