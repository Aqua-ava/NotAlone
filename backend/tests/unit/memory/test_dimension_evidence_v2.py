"""版本2的严格无正文合同；结构夹具不冒充生产语义证明。"""

from __future__ import annotations

import unittest
from uuid import uuid4

from notalone.memory.dimension_evidence import DimensionEvidence


def unknown_payload(version: int = 2) -> dict:
    message_id = uuid4()
    payload = {
        "version": version,
        "scope": {"owner_id": str(uuid4()), "contact_id": str(uuid4())},
        "candidate_sha256": "a" * 64, "window_sha256": "b" * 64,
        "pragmatics": None,
        "messages": [{
            "message_id": str(message_id), "text_sha256": "c" * 64,
            "text_length": 12, "sender": "contact", "message_type": "text",
            "text_representation": "text", "source_state_sha256": None,
            "occurred_at": None, "source_refs": [],
        }],
        "paraphrase": None, "reference": None, "media": None, "reported": None,
    }
    if version == 2:
        payload["semantic_basis"] = None
    return payload


class DimensionEvidenceV2ContractTest(unittest.TestCase):
    def test_unknown_v2_round_trips_without_certifying_old_v1(self) -> None:
        payload = unknown_payload()
        evidence = DimensionEvidence.from_payload(payload)
        self.assertEqual(evidence.to_payload(), payload)
        self.assertFalse(evidence.source_bound)
        legacy = unknown_payload(1)
        self.assertEqual(DimensionEvidence.from_payload(legacy).to_payload(), legacy)
        for rejected in (
            {key: value for key, value in payload.items() if key != "semantic_basis"},
            {**legacy, "semantic_basis": None},
            {**payload, "source_bound": True},
            {**payload, "version": True},
            {**payload, "version": 2.0},
        ):
            with self.subTest(payload=rejected):
                with self.assertRaises((TypeError, ValueError)):
                    DimensionEvidence.from_payload(rejected)

    def test_semantic_shape_keeps_kind_edges_and_rejects_boolean_ids(self) -> None:
        from copy import deepcopy
        from notalone.memory.dimension_evidence import SemanticBasis

        payload = unknown_payload()
        source = {"message_id": payload["messages"][0]["message_id"], "span": {
            "start": 0, "end": 1, "sha256": "a" * 64,
        }}
        candidate = {"start": 0, "end": 1, "sha256": "b" * 64}
        slots = {name: None for name in (
            "agent", "recipient", "object", "property_owner", "beneficiary", "actor",
        )}
        basis = {
            "version": 1, "rule_set_sha256": "a" * 64,
            "rules": [{"rule_id": "COND_PLAN_RUN_V1", "rule_version": 1}],
            "roles": [{"role_id": 0, "kind": "author", "sender": "contact", "source": source}],
            "atoms": [
                {"atom_id": 0, "predicate": "clear_weather", "phase": "condition", "roles": slots,
                 "source": source, "candidate": candidate},
                {"atom_id": 1, "predicate": "run", "phase": "planned", "roles": {**slots, "actor": 0},
                 "source": source, "candidate": candidate},
            ],
            "qualifiers": [
                {"qualifier_id": 0, "kind": "quantity", "atom_id": 1, "slot": "distance",
                 "value_sha256": "c" * 64, "source": source, "candidate": candidate},
                {"qualifier_id": 1, "kind": "degree", "quantity_qualifier_id": 0, "modifier": "approx",
                 "value_sha256": "d" * 64, "source": source, "candidate": candidate},
                {"qualifier_id": 2, "kind": "condition", "condition_atom_id": 0, "action_atom_id": 1,
                 "relation": "requires", "source": source, "candidate": candidate},
            ],
            "reference_bindings": [], "frame": "direct", "unresolved": [],
            "source_graph_sha256": "e" * 64, "candidate_graph_sha256": "e" * 64,
        }
        value = SemanticBasis.from_payload(basis)
        self.assertEqual(value.to_payload(), basis)
        payload["semantic_basis"] = basis
        evidence = DimensionEvidence.from_payload(payload)
        self.assertEqual(evidence.to_payload(), payload)
        self.assertFalse(evidence.source_bound)
        returned = value.to_payload()
        returned["roles"].clear()
        self.assertEqual(value.to_payload(), basis)
        for path, changed in (
            (("roles", 0, "role_id"), True),
            (("roles", 0, "role_id"), 0.0),
            (("atoms", 1, "roles", "actor"), 9),
            (("atoms", 1, "roles", "actor"), None),
            (("qualifiers", 0, "atom_id"), 0),
            (("qualifiers", 1, "quantity_qualifier_id"), 2),
            (("qualifiers", 2, "condition_atom_id"), 1),
            (("qualifiers", 2, "action_atom_id"), 0),
            (("rules", 0, "rule_version"), True),
            (("roles", 0, "source", "span", "start"), False),
        ):
            rejected = deepcopy(basis)
            target = rejected
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = changed
            with self.subTest(path=path, changed=changed):
                with self.assertRaises((TypeError, ValueError)):
                    SemanticBasis.from_payload(rejected)
        with self.assertRaises(ValueError):
            SemanticBasis.from_payload({**basis, "model_correct": True})
        with self.assertRaises(ValueError):
            SemanticBasis.from_payload({**basis, "roles": basis["roles"] * 2})

    def test_current_binding_reparses_actual_producer_graph_and_three_anchors(self) -> None:
        from dataclasses import replace
        from copy import deepcopy
        from notalone.memory.evidence_binding import bind_dimension_evidence
        from notalone.memory_extraction.flow import ExtractionFlow
        from tests.unit.memory_extraction.test_dimension_evidence_flow import _arrival_fixture
        from tests.unit.memory_extraction.test_flow import RecordingRuntime
        from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result

        window, payload, proof = _arrival_fixture()
        message = window.messages[0]
        verifier = FixedSourceVerifier(({**verification_result(
            evidence=((message.message_id, message.text),),
        ), "proof": proof},))
        verifier.verification_mode = "nullable-proof-v1"
        outcome = ExtractionFlow(runtime=RecordingRuntime((payload,)), verification_runtime=verifier).run(window)
        self.assertIsNone(outcome.failure_kind)
        fact = outcome.accepted[0]
        evidence = fact.dimension_evidence
        self.assertTrue(evidence.source_bound)
        kwargs = {
            "scope": evidence.scope, "candidate": fact, "messages": evidence.messages,
            "texts": {message.message_id: message.text},
            "source_snapshots": {message.message_id: message.source_snapshots},
        }
        self.assertTrue(bind_dimension_evidence(evidence, **kwargs).source_bound)
        self.assertFalse(bind_dimension_evidence(evidence, **{
            **kwargs, "source_snapshots": None,
        }).source_bound)
        self.assertFalse(bind_dimension_evidence(evidence, **{
            **kwargs, "source_snapshots": {message.message_id: ()},
        }).source_bound)
        for path, changed in (
            (("semantic_basis", "rule_set_sha256"), "f" * 64),
            (("semantic_basis", "source_graph_sha256"), "f" * 64),
            (("semantic_basis", "candidate_graph_sha256"), "f" * 64),
            (("semantic_basis", "frame"), "received_request_h"),
        ):
            invalid = deepcopy(evidence.to_payload())
            target = invalid
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = changed
            mutated = DimensionEvidence.from_payload(invalid)
            with self.subTest(path=path):
                self.assertFalse(bind_dimension_evidence(mutated, **kwargs).source_bound)
        altered = replace(fact, speech_act=type(fact.speech_act).PLAN)
        self.assertFalse(bind_dimension_evidence(evidence, **{
            **kwargs, "candidate": altered,
        }).source_bound)

    def test_actual_producer_quantity_and_polarity_slots_reject_null(self) -> None:
        from copy import deepcopy
        from notalone.memory.dimension_evidence import SemanticBasis
        from notalone.memory_extraction.flow import ExtractionFlow
        from tests.unit.memory_extraction.test_dimension_evidence_flow import _relation_fixture
        from tests.unit.memory_extraction.test_flow import RecordingRuntime
        from tests.unit.memory_extraction.verification_helpers import FixedSourceVerifier, verification_result

        cases = (
            ("quantity", "如果天晴，我计划后天跑约7.5公里。", "如果天晴，联系人计划后天跑约7500米。",
             "COND_PLAN_RUN_V1", "conditional_plan", {"speech_act":"plan", "assertion_status":"conditional"}),
            ("polarity", "我哥前天没有把他的书借给我。这里的“他”指我哥。", "联系人的哥哥前天没有把自己的书借给联系人",
             "KIN_LEND_BA_H1", "negative_h", {}),
        )
        for kind,source,candidate,rule,variant,fields in cases:
            with self.subTest(kind=kind):
                window,payload,proof = _relation_fixture(source,candidate,rule,variant,"direct",**fields)
                message = window.messages[0]
                verifier = FixedSourceVerifier(({**verification_result(
                    evidence=((message.message_id,message.text),),
                ),"proof":proof},))
                verifier.verification_mode = "nullable-proof-v1"
                outcome = ExtractionFlow(runtime=RecordingRuntime((payload,)),verification_runtime=verifier).run(window)
                self.assertIsNone(outcome.failure_kind)
                basis = outcome.accepted[0].dimension_evidence.semantic_basis.to_payload()
                self.assertEqual(SemanticBasis.from_payload(basis).to_payload(),basis)
                changed = deepcopy(basis)
                qualifier = next(item for item in changed["qualifiers"] if item["kind"]==kind)
                qualifier["slot"] = None
                with self.assertRaises(ValueError):
                    SemanticBasis.from_payload(changed)
