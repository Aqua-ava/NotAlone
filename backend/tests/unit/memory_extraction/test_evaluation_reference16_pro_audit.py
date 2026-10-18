"""Pro16独立身份只复用原Gold、E14/V4及先RAW后FULL的审核证据。"""

import copy
import json
import unittest

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
from notalone.memory_extraction.evaluation_records import canonical_sha256
from notalone.memory_extraction.evaluation_reference import PUBLIC_REFERENCE_V2_PATH
from tests.unit.memory_extraction import test_evaluation_phased_audit as phased_tests


class Reference16ProAuditTest(unittest.TestCase):
    persist = phased_tests.EvaluationPhasedAuditTest.persist
    full_review = phased_tests.EvaluationPhasedAuditTest.full_review

    def setUp(self):
        phased_tests.EvaluationPhasedAuditTest.setUp(self)
        self.reference = json.loads((self.root / PUBLIC_REFERENCE_V2_PATH).read_bytes())
        self.bundle.update(
            execution_plan="reference16-pro-v1", reference_version="source-fidelity-v2",
            extraction_mode="grounded-v2", verification_mode="legacy-v4",
            extraction_tool_choice="forced", verification_tool_choice="forced",
            extraction_program=[{"extraction_mode": "grounded-v2", "status": "compiled", "facts": [self.fact]}],
        )
        self.bundle["adapter_outputs"][0] = {"tool_calls": [{
            "name": "GroundedMemoryLabels", "args": {"units": {"1:0": {"kind": "event"}}},
        }]}
        self.bundle["provider_requests"].insert(0, {"body": {
            "tools": [{"type": "function", "function": {"name": "GroundedMemoryLabels"}}],
            "tool_choice": {"type": "function", "function": {"name": "GroundedMemoryLabels"}},
            "messages": [],
        }})

    def raw_review(self, view):
        self.assertEqual(view.pop("extraction_protocol")["extraction_mode"], "grounded-v2")
        return phased_tests.EvaluationPhasedAuditTest.raw_review(self, view)

    def audit(self, *, raw=None, full=None, **changes):
        parameters = {
            "reference": self.reference, "expected_reference_sha256": canonical_sha256(self.reference),
            "annotation_sha256": self.reference["annotation_sha256"], "criteria_sha256": self.criteria_sha,
            "case_set": "reference21", "case_positions": tuple(range(16)),
            "reference_version": "source-fidelity-v2", "execution_plan": "reference16-pro-v1",
            "extraction_mode": "grounded-v2", "verification_mode": "legacy-v4",
            "extraction_tool_choice": "forced", "verification_tool_choice": "forced",
            "raw_reviewer": raw or self.raw_review, "full_reviewer": full or self.full_review,
        }
        parameters.update(changes)
        return PhasedEvaluationAudit(**parameters)

    def test_fixed_first16_keeps_original21_gold_and_exact_denominator(self):
        before = canonical_sha256(self.reference)
        audit = self.audit()
        self.assertEqual(audit.case_positions, tuple(range(16)))
        self.assertEqual(audit.case_set, "reference21")
        self.assertEqual(audit.reference_sha256, before)
        claims = [claim for position in audit.case_positions for claim in self.reference["windows"][position]["claims"]]
        self.assertEqual(sum(claim["required"] for claim in claims), 18)
        self.assertEqual(sum(not claim["required"] for claim in claims), 1)
        self.assertEqual(len(self.reference["windows"]), 21)
        self.assertEqual(canonical_sha256(self.reference), before)

    def test_constructor_rejects_changed_scope_reference_or_protocol(self):
        faults = {
            "case_positions": [None, (), (0,), tuple(range(15)), tuple(range(17)),
                               tuple(range(1, 17)), tuple(reversed(range(16))), list(range(16)),
                               (False, *range(1, 16))],
            "case_set": ["full140", "bounded15", "reference16"],
            "reference_version": ["legacy-v1", "bounded-runtime15-v1"],
            "extraction_mode": ["legacy-e14", "grounded-v3", "grounded-v4"],
            "verification_mode": ["nullable-proof-v1", "nullable-proof-v3"],
            "extraction_tool_choice": ["omitted"], "verification_tool_choice": ["omitted"],
            "extraction_prompt_profile": ["reference-uniqueness-v1"],
        }
        for key, values in faults.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises((ValueError, EvaluationBudgetAbort)):
                    self.audit(**{key: value})
        self.assertEqual(self.order, [])

    def test_new_identity_rejects_mixed_or_changed_bundle_before_raw(self):
        audit = self.audit()
        for change in (
            {"execution_plan": "original"}, {"phase_request_version": "deepseek-phase-split-v1"},
            {"phase_request_policy": {}}, {"reference_version": "legacy-v1"},
            {"extraction_tool_choice": "omitted"}, {"verification_tool_choice": "omitted"},
            {"verification_mode": "nullable-proof-v1"}, {"case_position": 16},
        ):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                audit({**self.bundle, **change})
        self.assertEqual(self.order, [])

    def test_raw_and_full_keep_original_gold_and_compiled_e14_v4_evidence(self):
        before = canonical_sha256(self.reference)

        def raw(view):
            self.assertEqual(view["reference_sha256"], before)
            self.assertEqual(view["reference_case"], self.reference["windows"][7])
            self.assertEqual(view["extraction"][0]["payload"], self.fact)
            self.assertEqual(view["extraction_protocol"]["e14_origin"], "grounded_compiler")
            return self.raw_review(view)

        def full(view):
            self.assertEqual(view["packet"]["reference"], self.reference)
            self.assertEqual(set(view["packet"]["evidence"]["verification"][0]),
                             {"candidate_index", "verdict", "issues", "evidence"})
            self.assertNotIn("verification_protocol", view)
            return self.full_review(view)

        result = self.audit(raw=raw, full=full)(self.bundle)
        self.assertEqual(result["decision"], "safe")
        self.assertEqual(self.order, ["raw", "persist:raw", "full", "persist:final"])
        self.assertFalse(self.events[-1]["payload"]["report"]["quality_certified"])
        self.assertEqual(canonical_sha256(self.reference), before)

    def test_full_cannot_rewrite_sealed_raw_meaning_or_basis(self):
        for field, value in (("meaning", "unresolved"), ("basis", "看到V后改写原判断")):
            with self.subTest(field=field):
                self.order.clear()
                self.events.clear()

                def rewrite(view):
                    review = self.full_review(view)
                    review["e_rows"][0][field] = value
                    return review

                with self.assertRaisesRegex(EvaluationBudgetAbort, "phased_sealed_raw_changed"):
                    self.audit(full=rewrite)(self.bundle)
                self.assertEqual([event["payload"]["phase"] for event in self.events], ["raw"])

    def test_bad_auto_and_ambiguous_auto_take_priority_over_unresolved(self):
        for fault in ("bad_auto", "ambiguous_auto"):
            with self.subTest(fault=fault):
                self.order.clear()
                self.events.clear()

                def raw(view):
                    review = self.raw_review(view)
                    review["e_rows"][0]["fields"]["topic"] = "unresolved"
                    if fault == "bad_auto":
                        review["e_rows"][0]["meaning"] = "fail"
                    else:
                        review["e_rows"][0]["safety"] = "ambiguous"
                    return review

                result = self.audit(raw=raw)(self.bundle)
                report = self.events[-1]["payload"]["report"]
                self.assertGreater(report["safety"][fault], 0)
                self.assertGreater(report["safety"]["unresolved_auto"], 0)
                self.assertEqual((result["decision"], result["reason_code"]),
                                 ("safety_error", "contract_mismatch"))

    def test_unresolved_audit_is_unknown_despite_original_passed_result(self):
        def raw(view):
            review = self.raw_review(view)
            review["e_rows"][0]["meaning"] = "unresolved"
            return review

        self.assertTrue(self.bundle["original_result"]["passed"])
        result = self.audit(raw=raw)(self.bundle)
        self.assertEqual((result["decision"], result["reason_code"]), ("unknown", "audit_unresolved"))
        self.assertFalse(self.events[-1]["payload"]["report"]["quality_certified"])

    def test_unrun_or_missing_verification_never_returns_success(self):
        for fault in ("unrun", "missing_v_request", "missing_v_output"):
            with self.subTest(fault=fault):
                self.order.clear()
                self.events.clear()
                bundle = copy.deepcopy({key: value for key, value in self.bundle.items() if key != "persist_audit"})
                bundle["persist_audit"] = self.persist
                if fault == "unrun":
                    bundle.update(adapter_outputs=[], extraction_program=[], provider_requests=[])
                elif fault == "missing_v_request":
                    bundle["provider_requests"] = bundle["provider_requests"][:1]
                else:
                    bundle["adapter_outputs"] = bundle["adapter_outputs"][:1]
                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit()(bundle)
                self.assertNotIn("persist:final", self.order)

    def test_failed_raw_or_final_receipt_never_returns_success(self):
        for phase in ("raw", "final"):
            with self.subTest(phase=phase):
                self.order.clear()
                self.events.clear()

                def broken_receipt(payload):
                    receipt = self.persist(payload)
                    if payload["phase"] == phase:
                        receipt["payload_sha256"] = "0" * 64
                    return receipt

                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit()({**self.bundle, "persist_audit": broken_receipt})
                if phase == "raw":
                    self.assertNotIn("full", self.order)


if __name__ == "__main__":
    unittest.main()
