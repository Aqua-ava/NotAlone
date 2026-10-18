"""仅公开合成审核控制；passed副本不提升实际待审Gold或证明模型质量。"""

from __future__ import annotations

import copy
import json
from dataclasses import asdict
from pathlib import Path
import socket
import unittest
from unittest.mock import patch
from uuid import UUID

from notalone.memory_extraction.evaluation_bounded_cases import (
    BOUNDED_RUNTIME_DIMENSIONS, BOUNDED_RUNTIME_INPUTS, BOUNDED_RUNTIME_PLAN,
    BOUNDED_RUNTIME_REFERENCE_PATH,
)
from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_records import canonical_sha256
from notalone.memory_extraction.grounded_adapter import BOUNDED_DEPENDENCY_PROMPT_PROFILE


class BoundedPhasedAuditTest(unittest.TestCase):
    def setUp(self):
        guard = patch.object(socket.socket, "connect", side_effect=AssertionError("禁止联网"))
        guard.start()
        self.addCleanup(guard.stop)
        root = Path(__file__).resolve().parents[4]
        self.pending = json.loads((root / BOUNDED_RUNTIME_REFERENCE_PATH).read_bytes())
        self.pending["status"] = "agent_reference_pending_review"
        for key in ("structured_review", "independent_review"):
            self.pending["provenance"][key] = {"status": "pending", "scope": "显式合成未复审负控"}
        self.reference = copy.deepcopy(self.pending)
        self.reference["status"] = "agent_reviewed_reference"
        for key in ("structured_review", "independent_review"):
            self.reference["provenance"][key] = {
                "status": "passed", "reviewer": "仅纯合成接口控制，不是实际Gold复审",
            }
        self.criteria_sha = "c" * 64
        self.events = []
        self.views = []
        self.source = str(UUID(int=73))
        source = BOUNDED_RUNTIME_INPUTS[0]
        self.fact = {
            "text": "联系人原话：“我刚刚到家。”", "subject": "contact", "category": "common_fact",
            "topic": "other", "source_message_ids": [self.source], "confidence": 0.9,
            "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "接口合成控制保留原引句。",
        }
        from notalone.memory_extraction.evaluation import EvaluationResult
        original = EvaluationResult(
            name=source["case_name"], dimension="bounded-runtime", expected="auto", actual="auto",
            passed=True, subject_ok=True, labels_ok=True, text_ok=True, validity_ok=True,
            error_kind=None, expected_subject="contact", expected_labels=(),
            facts=({**self.fact, "destination": "auto"},), rejected_count=0, failure_reason=None,
        )
        proof = {"version": 3, "atom_links": None, "reference": None, "reported": None}
        verification = {"candidate_index": 0, "verdict": "supported", "issues": [],
                        "evidence": [{"message_id": self.source, "quote": "我刚刚到家。"}], "proof": proof}
        self.bundle = {
            "case_position": 0, "case_name": source["case_name"],
            "execution_plan": BOUNDED_RUNTIME_PLAN, "reference_version": BOUNDED_RUNTIME_PLAN,
            "extraction_mode": "grounded-v2", "verification_mode": "nullable-proof-v3",
            "extraction_prompt_profile": BOUNDED_DEPENDENCY_PROMPT_PROFILE,
            "extraction_tool_choice": "omitted", "verification_tool_choice": "forced",
            "window": {"messages": [{**source["messages"][0], "message_id": self.source}],
                       "target_message_ids": [self.source]},
            "gold_reference": {"criteria_sha256": self.criteria_sha},
            "original_result": asdict(original),
            "adapter_outputs": [
                {"tool_calls": [{"name": "GroundedMemoryLabels", "args": {"units": {
                    "0:0": {"kind": "event", "subject": "contact", "topic": "other",
                            "dependency": None, "unresolved": False, "confidence": 0.9, "sensitivity": "none"},
                }}}]},
                {"tool_calls": [{"name": "SourceVerificationOutput", "args": {"results": [verification]}}]},
            ],
            "extraction_program": [{"extraction_mode": "grounded-v2", "status": "compiled", "facts": [self.fact]}],
            "verification_program": [{"status": "unknown", "reason": "接口控制不提供正证"}],
            "provider_requests": [{"body": {
                "tools": [{"type": "function", "function": {"name": "SourceVerificationOutput"}}],
                "tool_choice": {"type": "function", "function": {"name": "SourceVerificationOutput"}},
                "messages": [{"role": "user", "content": json.dumps({"candidates": [{"candidate_index": 0, **self.fact}]})}],
            }}],
            "formal_task_execution": {"task": {"id": "仅合成任务接口"}, "worker_results": [],
                                      "trace": [], "memory_api": {"status_code": 200, "body": {}}},
            "persist_audit": self.persist,
        }

    def persist(self, payload):
        receipt = {
            "kind": "semantic_audit", "purpose": "case", "case_position": self.bundle["case_position"],
            "case_name": self.bundle["case_name"], "event_sequence": len(self.events) + 1,
            "payload": copy.deepcopy(payload), "payload_sha256": canonical_sha256(payload),
            "removed_paths": [],
        }
        self.events.append(receipt)
        return receipt

    def raw_review(self, view):
        self.views.append(copy.deepcopy(view))
        self.assertEqual(self.events, [])
        self.assertEqual(view["actual_message_ids_by_index"], [self.source])
        self.assertNotIn("verification_protocol", view)
        self.assertNotIn("formal_task_execution", view)
        self.assertNotIn("verification_program", view)
        present = bool(view["extraction"])
        return {
            "reviewer": "仅纯合成RAW接口控制", "case_id": view["case_id"],
            "reference_sha256": view["reference_sha256"], "raw_evidence_sha256": view["raw_evidence_sha256"],
            "e_rows": [{"raw_index": row["index"], "payload_sha256": row["payload_sha256"],
                        "fields": {field: "pass" for field in view["e_fields"]},
                        "meaning": "pass", "inclusion": "pass", "safety": "safe", "classification": "required",
                        "basis": "只验证封存接口，不认证本合成响应质量。"} for row in view["extraction"]],
            "claims": [{"claim_id": "P01-P1", "groups": [{
                "raw_indices": [0], "variant_id": "P01-P1-literal",
                **{field: "pass" for field in ("raw_meaning", "coherence", "branch", "source", "time")},
            }] if present else []}],
            "window_checks": {"inclusion": "pass", "forbidden_meanings": "pass"},
        }

    def full_review(self, view):
        self.views.append(copy.deepcopy(view))
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0]["payload"]["phase"], "raw")
        packet = view["packet"]
        self.assertEqual(packet["actual_message_ids_by_index"], [self.source])
        review = copy.deepcopy(view["sealed_raw_review"])
        review.pop("raw_evidence_sha256")
        review.update(evidence_sha256=packet["evidence_sha256"], run_status=packet["evidence"]["run_status"])
        for row in review["e_rows"]:
            row["lineage"] = {"v_input_indices": [0], "final_indices": [0], "status": "pass"}
        for claim in review["claims"]:
            for group in claim["groups"]:
                group.update(final_indices=[0], lineage="pass", destination="pass")
        review["v_rows"] = [{
            "result_index": row["index"], "payload_sha256": row["payload_sha256"],
            "fields": {field: "pass" for field in self.reference["v_fields"]},
            "semantic": "pass", "e_indices": [0], "lineage": "pass",
            "basis": "仅接口合成V判断，不授予positive证明信用。",
        } for row in packet["layers"]["verification"]]
        review["window_checks"]["lineage"] = "pass"
        explanations = {
            "subject": "合成控制单独核作者和输出主体。", "time": "合成控制单独核双NULL日期。",
            "truth_intent": "合成控制单独核原话的断言姿态。", "paraphrase": "合成控制单独核完整原引句。",
            "reference": "合成控制单独核指称范围。", "media": "合成控制单独核text/direct来源。",
            "reported": "合成控制单独核direct与转述框架。",
        }
        review["axis_reviews"] = {axis: {"status": "pass", "basis": basis} for axis, basis in explanations.items()}
        return review

    def audit(self, **changes):
        parameters = {
            "reference": self.reference,
            "expected_reference_sha256": canonical_sha256(self.reference),
            "annotation_sha256": self.reference["annotation_sha256"],
            "criteria_sha256": self.criteria_sha,
            "case_set": "bounded15", "reference_version": BOUNDED_RUNTIME_PLAN,
            "execution_plan": BOUNDED_RUNTIME_PLAN, "extraction_mode": "grounded-v2",
            "extraction_prompt_profile": BOUNDED_DEPENDENCY_PROMPT_PROFILE,
            "verification_mode": "nullable-proof-v3", "extraction_tool_choice": "omitted",
            "verification_tool_choice": "forced",
            "raw_reviewer": self.raw_review, "full_reviewer": self.full_review,
        }
        parameters.update(changes)
        return PhasedEvaluationAudit(**parameters)

    def test_fixed15_requires_actual_review_gate_and_forbids_subset_or_protocol_drift(self):
        with self.assertRaises(ValueError):
            self.audit(reference=self.pending, expected_reference_sha256=canonical_sha256(self.pending))
        audit = self.audit()
        self.assertEqual(audit.case_positions, tuple(range(15)))
        self.assertEqual(audit.case_set, "bounded15")
        self.assertEqual(self.audit(verification_tool_choice="omitted").verification_tool_choice, "omitted")
        for key, value in (
            ("case_positions", (0,)), ("extraction_mode", "grounded-v4"),
            ("verification_mode", "nullable-proof-v1"), ("extraction_tool_choice", "forced"),
            ("reference_version", "legacy-v1"),
            ("execution_plan", "original"), ("case_set", "full140"),
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.audit(**{key: value})
        with self.assertRaisesRegex(EvaluationBudgetAbort, "evaluation_policy_invalid"):
            self.audit(verification_tool_choice="auto")
        self.assertEqual(self.pending["status"], "agent_reference_pending_review")

    def test_actual_sources_raw_seal_full_execution_and_independent_axes_survive(self):
        def full(view):
            self.assertEqual(view["verification_protocol"]["model_results"][0]["proof"]["version"], 3)
            self.assertNotIn("proof", view["packet"]["evidence"]["verification"][0])
            self.assertEqual(view["verification_protocol"]["formal_task_execution"], self.bundle["formal_task_execution"])
            review = self.full_review(view)
            review["axis_reviews"]["reference"] = {"status": "fail", "basis": "本合成响应没有正证交付，单独保持该轴失败。"}
            return review

        result = self.audit(full_reviewer=full)(self.bundle)
        self.assertEqual(result["decision"], "safe")
        self.assertEqual([row["dimension"] for row in result["dimension_results"]], list(BOUNDED_RUNTIME_DIMENSIONS))
        self.assertEqual([row["passed"] for row in result["dimension_results"]], [True, True, True, True, False, True, True])
        self.assertEqual({row["semantic_case_id"] for row in result["dimension_results"]},
                         {self.reference["windows"][0]["input_sha256"]})
        final = self.events[1]["payload"]
        self.assertEqual(final["axis_reviews"]["reference"]["status"], "fail")
        self.assertNotIn("axis_reviews", final["review"])
        self.assertEqual(final["verification_protocol"]["formal_task_execution"], self.bundle["formal_task_execution"])

    def test_axis_unresolved_is_sealed_but_produces_no_dimension_success(self):
        def full(view):
            review = self.full_review(view)
            review["axis_reviews"]["media"] = {"status": "unresolved", "basis": "正式API原件不完整，尚不能独立判定。"}
            return review

        result = self.audit(full_reviewer=full)(self.bundle)
        self.assertEqual(result["decision"], "unknown")
        self.assertEqual(result["dimension_results"], [])
        self.assertEqual(self.events[-1]["payload"]["axis_reviews"]["media"]["status"], "unresolved")

    def test_empty_extraction_still_requires_raw_full_and_counts_missing_claim_on_all_axes(self):
        self.bundle["adapter_outputs"] = self.bundle["adapter_outputs"][:1]
        self.bundle["extraction_program"][0]["facts"] = []
        self.bundle["original_result"]["facts"] = []
        self.bundle["provider_requests"] = []
        self.bundle["verification_program"] = []
        result = self.audit()(self.bundle)
        self.assertEqual(result["decision"], "general_error")
        self.assertEqual(result["reason_code"], "coverage_miss")
        self.assertEqual(len(self.events), 2)
        self.assertEqual(self.events[-1]["payload"]["verification_protocol"]["model_results"], [])
        self.assertTrue(all(row["error_kind"] == "general" and not row["passed"]
                            for row in result["dimension_results"]))

    def test_raw_false_fact_or_wrong_person_cannot_be_overridden_by_axis_pass(self):
        for safety, count, error in (("false_fact", "false_fact_count", "false_fact"),
                                     ("wrong_person", "wrong_subject_count", "wrong_subject")):
            self.events.clear()

            def raw(view):
                review = self.raw_review(view)
                review["e_rows"][0]["safety"] = safety
                return review

            with self.subTest(safety=safety):
                result = self.audit(raw_reviewer=raw)(self.bundle)
                self.assertEqual(result["decision"], "safety_error")
                self.assertTrue(all(not row["passed"] and row[count] == 1 and row["error_kind"] == error
                                    for row in result["dimension_results"]))

    def test_known_raw_safety_error_survives_an_unresolved_axis_without_changing_review(self):
        for safety, count in (("false_fact", "false_fact_count"), ("wrong_person", "wrong_subject_count")):
            self.events.clear()

            def raw(view):
                review = self.raw_review(view)
                review["e_rows"][0]["safety"] = safety
                return review

            def full(view):
                review = self.full_review(view)
                review["axis_reviews"]["media"] = {"status": "unresolved", "basis": "媒体来源审核尚未完成。"}
                return review

            with self.subTest(safety=safety):
                result = self.audit(raw_reviewer=raw, full_reviewer=full)(self.bundle)
                self.assertEqual(result["decision"], "safety_error")
                self.assertEqual(len(result["dimension_results"]), 7)
                self.assertTrue(all(not row["passed"] and row[count] == 1 for row in result["dimension_results"]))
                self.assertEqual(self.events[-1]["payload"]["axis_reviews"]["media"], {
                    "status": "unresolved", "basis": "媒体来源审核尚未完成。",
                })

    def test_full_cannot_change_raw_field_decision_after_seal(self):
        def full(view):
            review = self.full_review(view)
            review["e_rows"][0]["fields"]["topic"] = "fail"
            return review

        with self.assertRaisesRegex(EvaluationBudgetAbort, "phased_sealed_raw_changed"):
            self.audit(full_reviewer=full)(self.bundle)
        self.assertEqual(len(self.events), 1)

    def test_axis_contract_is_exact_and_has_nonempty_independent_basis(self):
        for fault in ("missing", "extra", "status", "basis", "extra_field"):
            self.events.clear()

            def full(view):
                review = self.full_review(view)
                axes = review["axis_reviews"]
                if fault == "missing":
                    del axes["reported"]
                elif fault == "extra":
                    axes["other"] = {"status": "pass", "basis": "不能增加轴。"}
                elif fault == "extra_field":
                    axes["time"]["passed"] = True
                else:
                    axes["time"][fault] = True if fault == "status" else " "
                return review

            with self.subTest(fault=fault), self.assertRaises(EvaluationBudgetAbort):
                self.audit(full_reviewer=full)(self.bundle)
            self.assertEqual(len(self.events), 1)

    def test_changed_content_sender_time_type_or_targets_cannot_reach_raw(self):
        original = copy.deepcopy(self.bundle["window"])
        for field, value in (("text", "我刚刚到学校。"), ("sender", "self"),
                             ("occurred_at", "2030-01-02T12:00:00+00:00"),
                             ("text_representation", "processed_text"), ("message_type", "image")):
            self.bundle["window"] = copy.deepcopy(original)
            self.bundle["window"]["messages"][0][field] = value
            with self.subTest(field=field), self.assertRaises(EvaluationBudgetAbort):
                self.audit()(self.bundle)
            self.assertEqual(self.events, [])
        self.bundle["window"] = copy.deepcopy(original)
        self.bundle["window"]["target_message_ids"] = []
        with self.assertRaises(EvaluationBudgetAbort):
            self.audit()(self.bundle)

    def test_old_synthetic_source_id_cannot_score_complete_against_actual_mapping(self):
        from uuid import NAMESPACE_URL, uuid5
        stale = str(uuid5(NAMESPACE_URL, f"notalone-evaluation/{self.bundle['case_name']}/0"))
        self.fact["source_message_ids"] = [stale]
        self.bundle["original_result"]["facts"][0]["source_message_ids"] = [stale]
        v_input = {"candidate_index": 0, **self.fact}
        self.bundle["provider_requests"][0]["body"]["messages"][0]["content"] = json.dumps({"candidates": [v_input]})
        result = self.audit()(self.bundle)
        self.assertEqual(result["decision"], "general_error")
        self.assertTrue(all(not row["passed"] for row in result["dimension_results"]))

    def test_bounded_proof_parser_rejects_other_version_after_raw_seal(self):
        self.bundle["adapter_outputs"][1]["tool_calls"][0]["args"]["results"][0]["proof"]["version"] = 1
        with self.assertRaises(EvaluationBudgetAbort):
            self.audit()(self.bundle)
        self.assertEqual(len(self.events), 1)

    def test_nullable_proof3_field_must_be_present_even_when_value_is_null(self):
        result = self.bundle["adapter_outputs"][1]["tool_calls"][0]["args"]["results"][0]
        result.pop("proof")
        with self.assertRaises(EvaluationBudgetAbort):
            self.audit()(self.bundle)
        self.assertEqual(len(self.events), 1)

    def test_formal_execution_is_required_and_callback_cannot_replace_frozen_evidence(self):
        missing = dict(self.bundle)
        del missing["formal_task_execution"]
        with self.assertRaises(EvaluationBudgetAbort):
            self.audit()(missing)
        self.assertEqual(self.events, [])
        expected = copy.deepcopy(self.bundle["formal_task_execution"])

        def raw(view):
            self.bundle["formal_task_execution"]["memory_api"] = {"changed": True}
            return self.raw_review(view)

        self.audit(raw_reviewer=raw)(self.bundle)
        self.assertEqual(self.events[-1]["payload"]["verification_protocol"]["formal_task_execution"], expected)

    def test_reference_binding_and_each_axis_criterion_are_validated_before_execution(self):
        from notalone.memory_extraction.evaluation_reference import validate_bounded_public_reference
        for fault in ("input", "order", "id", "annotation", "review", "axes", "criterion", "variant", "source"):
            reference = copy.deepcopy(self.reference)
            if fault == "input":
                reference["windows"][0]["input_sha256"] = reference["windows"][1]["input_sha256"]
            elif fault == "order":
                reference["windows"].reverse()
            elif fault == "id":
                reference["windows"][0]["id"] = "different"
            elif fault == "annotation":
                reference["annotation_sha256"] = "a" * 64
            elif fault == "review":
                reference["provenance"]["independent_review"]["status"] = "pending"
            elif fault == "source":
                reference["windows"][0]["claims"][0]["variants"][0]["source_choices"][0]["indices"] = [True]
            else:
                axes = reference["common_rules"]["axis_expectations"]["P01"]
                if fault == "axes":
                    del axes["reported"]
                elif fault == "criterion":
                    axes["time"]["criterion"] = " "
                else:
                    axes["time"]["expected_api_state_by_variant"] = {}
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                validate_bounded_public_reference(reference, expected_reference_sha256=canonical_sha256(reference),
                                                  annotation_sha256=self.reference["annotation_sha256"])


if __name__ == "__main__":
    unittest.main()
