"""公开合成两阶段审核，只观察显式回调与假保存回执。"""

from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import NAMESPACE_URL, uuid5

from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_records import canonical_sha256


REFERENCE_SHA = "5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32"
ANNOTATION_SHA = "7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91"


class EvaluationPhasedAuditTest(unittest.TestCase):
    def setUp(self):
        guard = patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"})
        guard.start()
        self.addCleanup(guard.stop)
        self.root = Path(__file__).resolve().parents[4]
        path = self.root / ".scratch/unfinished-work/memory-gold-reference-20261012.json"
        self.reference = json.loads(path.read_text())
        self.criteria_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        self.events = []
        self.order = []
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES

        self.case = next(case for case in CASES if case.name == "指代：那本书")
        window = build_window(self.case)
        from notalone.memory_extraction.evaluation_records import _json_value
        self.window = _json_value(window)
        source = str(uuid5(NAMESPACE_URL, f"notalone-evaluation/{self.case.name}/1"))
        self.fact = {
            "text": "联系人刚读完《活着》。", "subject": "contact", "category": "common_fact",
            "topic": "study", "source_message_ids": [source], "confidence": 0.9,
            "risk_flags": [], "valid_at": None, "invalid_at": None,
            "speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "联系人明确说刚看完。",
        }
        verification = {"candidate_index": 0, "verdict": "supported", "issues": [],
                        "evidence": [{"message_id": source, "quote": "《活着》，我刚看完。"}]}
        v_input = {"candidate_index": 0, **{key: self.fact[key] for key in (
            "text", "subject", "category", "topic", "source_message_ids", "valid_at",
            "invalid_at", "speech_act", "assertion_status", "figurative_type",
        )}}
        self.bundle = {
            "case_position": 7, "case_name": self.case.name, "window": self.window,
            "original_result": {"passed": True, "facts": [{**self.fact, "destination": "auto"}]},
            "adapter_outputs": [
                {"tool_calls": [{"name": "MemoryExtractionOutput", "args": {"facts": [self.fact]}}]},
                {"tool_calls": [{"name": "SourceVerificationOutput", "args": {"results": [verification]}}]},
            ],
            "provider_requests": [{"body": {
                "tools": [{"type": "function", "function": {"name": "SourceVerificationOutput"}}],
                "tool_choice": {"type": "function", "function": {"name": "SourceVerificationOutput"}},
                "messages": [{"role": "user", "content": json.dumps({"candidates": [v_input]})}],
            }}],
            "provider_responses": [], "gold_reference": {"criteria_sha256": self.criteria_sha},
            "persist_audit": self.persist,
        }

    def persist(self, payload):
        self.order.append("persist:" + payload["phase"])
        event = {
            "kind": "semantic_audit", "purpose": "case", "case_position": self.bundle["case_position"],
            "case_name": self.case.name, "event_sequence": len(self.events) + 1,
            "payload": copy.deepcopy(payload), "payload_sha256": canonical_sha256(payload),
            "removed_paths": [],
        }
        self.events.append(event)
        return event

    def raw_review(self, view):
        self.order.append("raw")
        self.assertEqual(set(view), {
            "case_id", "case_position", "case_name", "window", "reference_case", "common_rules",
            "e_fields", "extraction", "reference_sha256", "raw_evidence_sha256",
        })
        self.assertNotIn("verification", view)
        self.assertNotIn("final_facts", view)
        self.assertNotIn("original_result", view)
        return {
            "reviewer": "合成raw审核者", "case_id": view["case_id"],
            "reference_sha256": view["reference_sha256"],
            "raw_evidence_sha256": view["raw_evidence_sha256"],
            "e_rows": [{
                "raw_index": item["index"], "payload_sha256": item["payload_sha256"],
                "fields": {field: "pass" for field in view["e_fields"]},
                "meaning": "pass", "inclusion": "pass", "safety": "safe",
                "classification": "required", "basis": "此合成工作例显式核定已完成阅读。",
            } for item in view["extraction"]],
            "claims": [{"claim_id": claim["id"], "groups": [{
                "raw_indices": [0], "variant_id": claim["variants"][0]["id"],
                **{key: "pass" for key in ("raw_meaning", "coherence", "branch", "source", "time")},
            }]} for claim in view["reference_case"]["claims"]],
            "window_checks": {"inclusion": "pass", "forbidden_meanings": "pass"},
        }

    def full_review(self, view):
        self.order.append("full")
        self.assertEqual(self.order[:3], ["raw", "persist:raw", "full"])
        self.assertEqual(view["sealed_raw_review"], self.events[0]["payload"]["review"])
        self.assertEqual(view["packet"]["evidence"]["verification_inputs"][0]["candidate_index"], 0)
        raw = copy.deepcopy(view["sealed_raw_review"])
        raw.pop("raw_evidence_sha256")
        packet = view["packet"]
        raw.update(evidence_sha256=packet["evidence_sha256"], run_status=packet["evidence"]["run_status"])
        for row in raw["e_rows"]:
            row["lineage"] = {"v_input_indices": [0], "final_indices": [0], "status": "pass"}
        for claim in raw["claims"]:
            for group in claim["groups"]:
                group.update(final_indices=[0], lineage="pass", destination="pass")
        raw["v_rows"] = [{
            "result_index": item["index"], "payload_sha256": item["payload_sha256"],
            "fields": {field: "pass" for field in self.reference["v_fields"]},
            "semantic": "pass", "e_indices": [0], "lineage": "pass",
            "basis": "此合成工作例显式核定完整来源支持。",
        } for item in packet["layers"]["verification"]]
        raw["window_checks"]["lineage"] = "pass"
        return raw

    def audit(self, *, raw=None, full=None, **parameters):
        return PhasedEvaluationAudit(
            reference=self.reference, expected_reference_sha256=REFERENCE_SHA,
            annotation_sha256=ANNOTATION_SHA, criteria_sha256=self.criteria_sha,
            raw_reviewer=raw or self.raw_review, full_reviewer=full or self.full_review,
            **parameters,
        )

    def test_selected_local_position_uses_original_gold_without_reordering_it(self):
        positions = (0, 1, 7, 4)
        before = canonical_sha256(self.reference)
        self.bundle["case_position"] = 2

        def selected_raw(view):
            self.assertEqual(view["case_position"], 2)
            self.assertEqual(view["reference_case"]["position"], 7)
            self.assertEqual(view["case_id"], "A08")
            return self.raw_review(view)

        audit = self.audit(raw=selected_raw, case_positions=positions)
        self.assertEqual(audit.case_positions, positions)
        self.assertEqual(audit(self.bundle)["case_position"], 2)
        self.assertEqual([event["case_position"] for event in self.events], [2, 2])
        self.assertEqual(canonical_sha256(self.reference), before)
        with self.assertRaises(AttributeError):
            audit.case_positions = (7,)

    def test_invalid_selection_or_local_binding_never_reaches_raw(self):
        for positions in ((), [7], (True,), (7, 7), (-1,), (21,), ("7",)):
            with self.subTest(positions=positions):
                with self.assertRaises(ValueError):
                    self.audit(case_positions=positions)
        for position, fault in ((True, "position"), (1, "position"),
                                (0, "input"), (0, "case")):
            with self.subTest(position=position, fault=fault):
                bundle = copy.deepcopy({key: value for key, value in self.bundle.items()
                                        if key != "persist_audit"})
                bundle["persist_audit"] = self.persist
                bundle["case_position"] = position
                if fault == "input":
                    bundle["window"]["messages"][0]["text"] = "错输入"
                elif fault == "case":
                    bundle["case_name"] = "错位置的合成名称"
                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit(case_positions=(7,))(bundle)
                self.assertEqual(self.order, [])
                self.assertEqual(self.events, [])

    def test_raw_is_sealed_before_full_view_and_final_report_before_decision(self):
        result = self.audit()(self.bundle)
        self.assertEqual(self.order, ["raw", "persist:raw", "full", "persist:final"])
        self.assertEqual(result, {"case_position": 7, "decision": "safe", "reason_code": "supported",
                                  "criteria_sha256": self.criteria_sha})
        self.assertEqual(self.events[-1]["payload"]["report"]["required"]["full"], 1)
        self.assertFalse(self.events[-1]["payload"]["report"]["quality_certified"])

    def test_raw_save_failure_or_bad_receipt_never_reveals_full_view(self):
        for fault in ("raise", "digest", "payload", "removed", "position", "sequence"):
            with self.subTest(fault=fault):
                self.events.clear()
                self.order.clear()

                def broken(payload):
                    if fault == "raise":
                        raise OSError("合成保存故障")
                    event = self.persist(payload)
                    if fault == "digest":
                        event["payload_sha256"] = "0" * 64
                    elif fault == "payload":
                        event["payload"]["review"]["reviewer"] = "被替换"
                    elif fault == "removed":
                        event["removed_paths"] = ["$.review.basis"]
                    elif fault == "position":
                        event["case_position"] = 8
                    else:
                        event["event_sequence"] = True
                    return event

                bundle = {**self.bundle, "persist_audit": broken}
                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit()(bundle)
                self.assertNotIn("full", self.order)

    def test_invalid_raw_review_is_rejected_before_save_or_full(self):
        for fault in ("row", "digest", "window", "group"):
            with self.subTest(fault=fault):
                self.events.clear()
                self.order.clear()

                def invalid(view):
                    review = self.raw_review(view)
                    if fault == "row":
                        review["e_rows"] = []
                    elif fault == "digest":
                        review["raw_evidence_sha256"] = "f" * 64
                    elif fault == "window":
                        review["window_checks"]["lineage"] = "pass"
                    else:
                        review["claims"][0]["groups"][0]["destination"] = "pass"
                    return review

                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit(raw=invalid)(self.bundle)
                self.assertEqual(self.events, [])
                self.assertNotIn("full", self.order)

    def test_full_cannot_change_sealed_raw_judgments_or_basis(self):
        for fault in ("field", "meaning", "basis", "group", "window"):
            with self.subTest(fault=fault):
                self.events.clear()
                self.order.clear()

                def changed(view):
                    review = self.full_review(view)
                    if fault == "field":
                        review["e_rows"][0]["fields"]["confidence"] = "fail"
                    elif fault == "meaning":
                        review["e_rows"][0]["meaning"] = "unresolved"
                    elif fault == "basis":
                        review["e_rows"][0]["basis"] = "看见V之后重写依据"
                    elif fault == "group":
                        review["claims"][0]["groups"][0]["branch"] = "fail"
                    else:
                        review["window_checks"]["inclusion"] = "fail"
                    return review

                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit(full=changed)(self.bundle)
                self.assertEqual([event["payload"]["phase"] for event in self.events], ["raw"])

    def test_full_may_have_distinct_reviewer_but_keeps_raw_identity(self):
        def another(view):
            review = self.full_review(view)
            review["reviewer"] = "另一位合成full审核者"
            return review

        result = self.audit(full=another)(self.bundle)
        self.assertEqual(result["decision"], "safe")
        self.assertEqual(self.events[0]["payload"]["review"]["reviewer"], "合成raw审核者")
        self.assertEqual(self.events[1]["payload"]["review"]["reviewer"], "另一位合成full审核者")

    def test_callback_side_effect_cannot_replace_saved_case_evidence(self):
        def change_input_after_raw(view):
            review = self.raw_review(view)
            self.bundle["original_result"]["facts"][0]["destination"] = "none"
            return review

        result = self.audit(raw=change_input_after_raw)(self.bundle)
        self.assertEqual(result["decision"], "safe")
        self.assertEqual(self.events[-1]["payload"]["report"]["required"]["full"], 1)

    def test_final_receipt_failure_never_returns_completed_decision(self):
        def broken_final(payload):
            event = self.persist(payload)
            if payload["phase"] == "final":
                event["payload_sha256"] = "0" * 64
            return event

        with self.assertRaises(EvaluationBudgetAbort):
            self.audit()({**self.bundle, "persist_audit": broken_final})

    def test_missing_actual_verification_or_stale_final_sequence_cannot_pass(self):
        for fault in ("request", "adapter", "final_sequence"):
            with self.subTest(fault=fault):
                self.events.clear()
                self.order.clear()
                bundle = {**self.bundle}
                if fault == "request":
                    bundle["provider_requests"] = []
                elif fault == "adapter":
                    bundle["adapter_outputs"] = self.bundle["adapter_outputs"][:1]
                else:
                    def stale_final(payload):
                        event = self.persist(payload)
                        if payload["phase"] == "final":
                            event["event_sequence"] = 1
                        return event
                    bundle["persist_audit"] = stale_final
                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit()(bundle)
                if fault != "final_sequence":
                    self.assertNotIn("full", self.order)
                self.assertEqual(self.events[0]["payload"]["phase"], "raw")

    def test_verification_retries_must_have_identical_registered_bodies(self):
        for drift in (False, True):
            with self.subTest(drift=drift):
                self.events.clear()
                self.order.clear()
                requests = copy.deepcopy(self.bundle["provider_requests"])
                requests.append(copy.deepcopy(requests[0]))
                if drift:
                    requests[1]["body"]["messages"].append({"role": "system", "content": "替换规则"})
                bundle = {**self.bundle, "provider_requests": requests}
                if drift:
                    with self.assertRaises(EvaluationBudgetAbort):
                        self.audit()(bundle)
                    self.assertNotIn("full", self.order)
                else:
                    self.assertEqual(self.audit()(bundle)["decision"], "safe")

    def test_changed_case_window_or_criteria_stops_before_raw_callback(self):
        for fault in ("position", "name", "window", "criteria"):
            with self.subTest(fault=fault):
                bundle = {**self.bundle}
                if fault == "position":
                    bundle["case_position"] = -14
                elif fault == "name":
                    bundle["case_name"] = "其他窗口"
                elif fault == "window":
                    bundle["window"] = {"modified": True}
                else:
                    bundle["gold_reference"] = {"criteria_sha256": REFERENCE_SHA}
                with self.assertRaises(EvaluationBudgetAbort):
                    self.audit()(bundle)
                self.assertEqual(self.order, [])

    def test_missing_or_extra_named_adapter_tools_are_not_silently_ignored(self):
        outputs = copy.deepcopy(self.bundle["adapter_outputs"])
        outputs[1]["tool_calls"].append({"name": "send_chat", "args": {}})
        with self.assertRaises(EvaluationBudgetAbort):
            self.audit()({**self.bundle, "adapter_outputs": outputs})
        self.assertNotIn("full", self.order)

    def test_safety_unresolved_and_verification_loss_have_distinct_decisions(self):
        for fault, decision, reason in (
            ("wrong_person", "safety_error", "wrong_subject"),
            ("false_fact", "safety_error", "false_fact"),
            ("ambiguous", "safety_error", "contract_mismatch"),
            ("unresolved", "unknown", "audit_unresolved"),
            ("v_rejection", "general_error", "coverage_miss"),
        ):
            with self.subTest(fault=fault):
                self.events.clear()
                self.order.clear()

                def raw(view):
                    review = self.raw_review(view)
                    if fault in {"wrong_person", "false_fact", "ambiguous"}:
                        review["e_rows"][0]["safety"] = fault
                    elif fault == "unresolved":
                        review["e_rows"][0]["fields"]["topic"] = "unresolved"
                    return review

                def full(view):
                    review = self.full_review(view)
                    if fault == "v_rejection":
                        review["v_rows"][0]["semantic"] = "fail"
                    return review

                result = self.audit(raw=raw, full=full)(self.bundle)
                self.assertEqual((result["decision"], result["reason_code"]), (decision, reason))
                self.assertEqual(self.events[-1]["payload"]["phase"], "final")

    def test_legitimate_empty_none_is_safe_but_unexpected_v_is_not_omitted(self):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.evaluation_records import _json_value

        self.case = next(case for case in CASES if case.name == "指代：发地址")
        self.bundle.update(
            case_position=13, case_name=self.case.name, window=_json_value(build_window(self.case)),
            original_result={"facts": [], "passed": True},
            adapter_outputs=[{"tool_calls": [{"name": "MemoryExtractionOutput", "args": {"facts": []}}]}],
            provider_requests=[],
        )

        def full(view):
            self.order.append("full")
            packet = view["packet"]
            raw = copy.deepcopy(view["sealed_raw_review"])
            raw.pop("raw_evidence_sha256")
            raw.update(evidence_sha256=packet["evidence_sha256"], run_status="empty", v_rows=[])
            raw["window_checks"]["lineage"] = "pass"
            return raw

        result = self.audit(full=full)(self.bundle)
        self.assertEqual(result["decision"], "safe")
        self.assertTrue(self.events[-1]["payload"]["report"]["none_correct"])
        self.events.clear()
        self.order.clear()
        outputs = copy.deepcopy(self.bundle["adapter_outputs"])
        outputs.append({"tool_calls": [{"name": "SourceVerificationOutput", "args": {"results": []}}]})
        with self.assertRaises(EvaluationBudgetAbort):
            self.audit(full=full)({**self.bundle, "adapter_outputs": outputs})


if __name__ == "__main__":
    unittest.main()
