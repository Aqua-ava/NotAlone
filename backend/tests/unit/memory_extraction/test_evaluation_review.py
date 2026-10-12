"""显式审核表的机械装配与计数；合成工作例不代替实际 Gold。"""

from __future__ import annotations

import copy
import unittest
from uuid import NAMESPACE_URL, uuid5

from notalone.memory_extraction.evaluation_review import (
    prepare_case_review, score_case_review,
)


E_FIELDS = [
    "text", "category", "subject", "topic", "source_message_ids", "confidence",
    "risk_flags", "valid_at", "invalid_at", "speech_act", "assertion_status",
    "figurative_type", "alternatives", "interpretation_reason",
]
V_FIELDS = ["candidate_index", "verdict", "issues", "evidence"]
CASE_NAME = "合成审核工作例"
SOURCE_ID = str(uuid5(NAMESPACE_URL, f"notalone-evaluation/{CASE_NAME}/0"))


def _reference() -> dict:
    return {
        "format_version": 1, "status": "agent_reviewed_reference",
        "annotation_path": ".scratch/public-fixture.md", "annotation_sha256": "a" * 64,
        "provenance": {"oracle_aware": True, "quality_certified": False},
        "e_fields": E_FIELDS, "v_fields": V_FIELDS, "common_rules": {"rule": "显式人工审核"},
        "windows": [{
            "id": "W1", "position": 0, "case_name": CASE_NAME,
            "input_sha256": "b" * 64, "target_indices": [0], "inclusion": "retain",
            "forbidden_meanings": ["不得写成尚未读完"],
            "claims": [{
                "id": "W1-P1", "required": True,
                "meaning_requirements": ["已读完所指资料"],
                "variants": [{
                    "id": "W1-P1-v1", "body_requirements": ["已读完所指资料"],
                    "subject": "contact", "category": "common_fact", "allowed_topics": ["study"],
                    "source_choices": [{"indices": [0], "when": "本工作例唯一来源"}],
                    "speech_act": "assertion", "assertion_status": "asserted",
                    "figurative_type": "literal", "valid_at": None, "invalid_at": None,
                    "time_rule": "不补日期", "ideal_destination": "auto",
                    "risk_rule": "显式核对", "alternatives_rule": "显式核对",
                    "reason_rule": "显式核对",
                }],
            }],
        }],
    }


def _fact() -> dict:
    return {
        "text": "联系人已经读完合成资料。", "category": "common_fact",
        "subject": "contact", "topic": "study", "source_message_ids": [SOURCE_ID],
        "confidence": 0.9, "risk_flags": [], "valid_at": None, "invalid_at": None,
        "speech_act": "assertion", "assertion_status": "asserted",
        "figurative_type": "literal", "alternatives": [],
        "interpretation_reason": "合成原句明确完成。",
    }


def _evidence() -> dict:
    fact = _fact()
    return {
        "run_status": "completed", "extraction": [fact],
        "verification_inputs": [{"candidate_index": 0, **fact}],
        "verification": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                          "evidence": [{"message_id": SOURCE_ID, "quote": "已读完"}]}],
        "final_facts": [{**fact, "destination": "auto"}],
        "original_result": {"passed": True, "facts": [{**fact, "destination": "auto"}]},
    }


def _review(packet: dict) -> dict:
    evidence = packet["evidence"]
    return {
        "reviewer": "合成工作例审核者", "case_id": packet["case_id"],
        "reference_sha256": packet["reference_sha256"],
        "evidence_sha256": packet["evidence_sha256"],
        "run_status": evidence["run_status"],
        "e_rows": [{
            "raw_index": row["index"], "payload_sha256": row["payload_sha256"],
            "fields": {field: "pass" for field in E_FIELDS},
            "meaning": "pass", "inclusion": "pass", "safety": "safe",
            "classification": "required", "lineage": {
                "v_input_indices": [row["index"]],
                "final_indices": [row["index"]] if evidence["final_facts"] else [],
                "status": "pass",
            }, "basis": "此合成工作例显式给定审核判断。",
        } for row in packet["layers"]["extraction"]],
        "v_rows": [{
            "result_index": row["index"], "payload_sha256": row["payload_sha256"],
            "fields": {field: "pass" for field in V_FIELDS}, "semantic": "pass",
            "e_indices": ([evidence["verification"][row["index"]]["candidate_index"]]
                          if type(evidence["verification"][row["index"]].get("candidate_index")) is int
                          else []),
            "lineage": "pass", "basis": "此合成工作例显式给定V审核。",
        } for row in packet["layers"]["verification"]],
        "claims": [{"claim_id": claim["id"], "groups": [{
            "raw_indices": [0], "variant_id": claim["variants"][0]["id"],
            "final_indices": [0] if evidence["final_facts"] else [],
            **{key: "pass" for key in (
                "raw_meaning", "coherence", "branch", "source", "time", "lineage", "destination",
            )},
        }]} for claim in packet["reference"]["windows"][0]["claims"]],
        "window_checks": {"inclusion": "pass", "forbidden_meanings": "pass", "lineage": "pass"},
    }


class EvaluationReviewTest(unittest.TestCase):
    def test_correct_raw_claim_rejected_by_verification_has_no_accepted_credit(self):
        evidence = _evidence()
        evidence["verification"][0].update(verdict="unsupported", issues=["meaning"], evidence=[])
        evidence["final_facts"] = []
        evidence["original_result"] = {"passed": False, "error_kind": "general"}
        packet = prepare_case_review(_reference(), "W1", evidence)
        review = _review(packet)
        review["v_rows"][0]["semantic"] = "fail"
        report = score_case_review(packet, review)
        self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 0, "full": 0})
        self.assertEqual(report["v_semantic"], {"fail": 1, "unresolved": 0})
        self.assertEqual(report["original_result"], evidence["original_result"])
        self.assertFalse(report["quality_certified"])

    def test_incomplete_duplicate_or_changed_review_is_rejected(self):
        packet = prepare_case_review(_reference(), "W1", _evidence())
        for fault in ("missing_e", "duplicate_e", "missing_claim", "enum", "digest", "basis"):
            with self.subTest(fault=fault):
                review = _review(packet)
                if fault == "missing_e":
                    review["e_rows"] = []
                elif fault == "duplicate_e":
                    review["e_rows"] *= 2
                elif fault == "missing_claim":
                    review["claims"] = []
                elif fault == "enum":
                    review["e_rows"][0]["meaning"] = "safe"
                elif fault == "digest":
                    review["e_rows"][0]["payload_sha256"] = "0" * 64
                else:
                    review["e_rows"][0]["basis"] = ""
                with self.assertRaises(ValueError):
                    score_case_review(packet, review)

    def test_non_json_invalid_verification_or_inconsistent_empty_is_rejected(self):
        for fault in ("non_json", "nan", "v_missing", "v_duplicate", "v_index", "empty"):
            with self.subTest(fault=fault):
                evidence = _evidence()
                if fault == "non_json":
                    evidence["extraction"][0]["source_message_ids"] = {SOURCE_ID}
                elif fault == "nan":
                    evidence["extraction"][0]["confidence"] = float("nan")
                elif fault == "v_missing":
                    evidence["verification"] = []
                elif fault == "v_duplicate":
                    evidence["verification"] *= 2
                elif fault == "v_index":
                    evidence["verification"][0]["candidate_index"] = 1
                else:
                    evidence["run_status"] = "empty"
                with self.assertRaises(ValueError):
                    prepare_case_review(_reference(), "W1", evidence)

    def test_variant_mismatches_cannot_be_overridden_by_pass_labels(self):
        for field, value in (
            ("subject", "self"), ("category", "preference"), ("topic", "finance"),
            ("speech_act", "plan"), ("assertion_status", "reported"),
            ("figurative_type", "joke"), ("valid_at", "2026-09-15T00:00:00+00:00"),
            ("invalid_at", "2026-09-16T00:00:00+00:00"),
            ("source_message_ids", ["00000000-0000-0000-0000-000000000000"]),
        ):
            with self.subTest(field=field):
                evidence = _evidence()
                evidence["extraction"][0][field] = value
                evidence["final_facts"][0][field] = value
                packet = prepare_case_review(_reference(), "W1", evidence)
                report = score_case_review(packet, _review(packet))
                self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 1, "full": 0})

    def test_e_lineage_and_v_fields_gate_complete_credit_separately(self):
        packet = prepare_case_review(_reference(), "W1", _evidence())
        for fault in ("e_lineage", "e_field", "v_field", "v_semantic", "destination"):
            with self.subTest(fault=fault):
                review = _review(packet)
                expected_accepted = 1
                if fault == "e_lineage":
                    review["e_rows"][0]["lineage"]["status"] = "unresolved"
                    review["window_checks"]["lineage"] = "unresolved"
                    expected_accepted = 0
                elif fault == "e_field":
                    review["e_rows"][0]["fields"]["confidence"] = "fail"
                elif fault == "v_field":
                    review["v_rows"][0]["fields"]["evidence"] = "fail"
                elif fault == "v_semantic":
                    review["v_rows"][0]["semantic"] = "fail"
                else:
                    review["claims"][0]["groups"][0]["destination"] = "fail"
                report = score_case_review(packet, review)
                self.assertEqual(report["required"]["raw"], 1)
                self.assertEqual(report["required"]["accepted"], expected_accepted)
                self.assertEqual(report["required"]["full"], 0)

    def test_split_claim_counts_once_and_cannot_pick_fields_across_wrong_members(self):
        evidence = _evidence()
        evidence["extraction"].append(_fact())
        evidence["extraction"][0]["text"] = "合成资料阅读已经完成。"
        evidence["extraction"][1]["text"] = "所指资料是此前说的那份。"
        evidence["verification_inputs"].append({"candidate_index": 1, **_fact()})
        evidence["verification"].append({**copy.deepcopy(evidence["verification"][0]), "candidate_index": 1})
        evidence["final_facts"].append({**_fact(), "destination": "auto"})
        for wrong_members in (False, True):
            with self.subTest(wrong_members=wrong_members):
                current = copy.deepcopy(evidence)
                if wrong_members:
                    current["extraction"][0]["subject"] = "self"
                    current["extraction"][1]["category"] = "preference"
                packet = prepare_case_review(_reference(), "W1", current)
                review = _review(packet)
                review["claims"][0]["groups"][0].update(raw_indices=[0, 1], final_indices=[0, 1])
                report = score_case_review(packet, review)
                self.assertEqual(report["required"], {
                    "total": 1, "raw": 1, "accepted": 1, "full": 0 if wrong_members else 1,
                })

    def test_bad_extra_auto_is_counted_even_when_required_claim_has_good_version(self):
        evidence = _evidence()
        extra = _fact()
        extra["text"] = "联系人拥有一辆不存在于来源中的车。"
        evidence["extraction"].append(extra)
        evidence["verification_inputs"].append({"candidate_index": 1, **extra})
        evidence["verification"].append({**copy.deepcopy(evidence["verification"][0]), "candidate_index": 1})
        evidence["final_facts"].append({**extra, "destination": "auto"})
        packet = prepare_case_review(_reference(), "W1", evidence)
        review = _review(packet)
        review["e_rows"][1].update(classification="extra", meaning="fail", safety="false_fact")
        review["v_rows"][1]["semantic"] = "fail"
        review["window_checks"]["forbidden_meanings"] = "fail"
        report = score_case_review(packet, review)
        self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 1, "full": 0})
        self.assertEqual(report["classifications"]["extra"], 1)
        self.assertEqual(report["safety"]["false_fact"], 1)
        self.assertEqual(report["safety"]["bad_auto"], 1)
        self.assertEqual(report["v_semantic"]["fail"], 1)

    def test_unmapped_lineage_remains_unresolved_without_guessing_indices(self):
        packet = prepare_case_review(_reference(), "W1", _evidence())
        review = _review(packet)
        review["e_rows"][0]["lineage"] = {
            "v_input_indices": [], "final_indices": [], "status": "unresolved",
        }
        review["v_rows"][0].update(e_indices=[], lineage="unresolved")
        review["claims"][0]["groups"][0].update(final_indices=[], lineage="unresolved")
        review["window_checks"]["lineage"] = "unresolved"
        report = score_case_review(packet, review)
        self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 0, "full": 0})
        self.assertEqual(report["unmapped_v_inputs"], [0])
        self.assertEqual(report["unmapped_final_facts"], [0])
        self.assertGreater(report["review_unresolved"], 0)
        review["window_checks"]["lineage"] = "pass"
        with self.assertRaises(ValueError):
            score_case_review(packet, review)

    def test_empty_none_and_failed_unknown_unrun_keep_distinct_denominators(self):
        reference = _reference()
        reference["windows"][0].update(inclusion="none", claims=[])
        empty = {"run_status": "empty", **{layer: [] for layer in (
            "extraction", "verification_inputs", "verification", "final_facts",
        )}, "original_result": {"actual": "none", "passed": True}}
        packet = prepare_case_review(reference, "W1", empty)
        report = score_case_review(packet, _review(packet))
        self.assertTrue(report["none_correct"])
        self.assertEqual(report["required"]["total"], 0)
        for status in ("failed", "unknown", "unrun"):
            with self.subTest(status=status):
                evidence = _evidence() if status != "unrun" else copy.deepcopy(empty)
                evidence["run_status"] = status
                evidence["verification"] = []
                evidence["final_facts"] = []
                packet = prepare_case_review(_reference(), "W1", evidence)
                review = _review(packet)
                if status == "unrun":
                    review["claims"][0]["groups"] = []
                report = score_case_review(packet, review)
                self.assertEqual(report["required"], {
                    "total": 1, "raw": 0 if status == "unrun" else 1, "accepted": 0, "full": 0,
                })
                self.assertFalse(report["none_correct"])

    def test_timezone_equivalence_and_duplicate_sources_have_separate_counts(self):
        reference = _reference()
        reference["windows"][0]["claims"][0]["variants"][0]["valid_at"] = "2026-09-15T00:00:00Z"
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate):
                evidence = _evidence()
                for layer in ("extraction", "verification_inputs", "final_facts"):
                    evidence[layer][0]["valid_at"] = "2026-09-15T08:00:00+08:00"
                    if duplicate:
                        evidence[layer][0]["source_message_ids"] = [SOURCE_ID, SOURCE_ID]
                packet = prepare_case_review(reference, "W1", evidence)
                report = score_case_review(packet, _review(packet))
                self.assertEqual(report["required"]["full"], 0 if duplicate else 1)
                self.assertEqual(report["duplicate_source_references"], 1 if duplicate else 0)

    def test_failed_invalid_objects_are_kept_and_every_missing_field_is_audited(self):
        evidence = {
            "run_status": "failed", "extraction": [{"text": "非法原E结构"}],
            "verification_inputs": [], "verification": [{"verdict": "非法原V标签"}],
            "final_facts": [], "original_result": {"failure_reason": "invalid_output"},
        }
        packet = prepare_case_review(_reference(), "W1", evidence)
        review = _review(packet)
        review["e_rows"][0]["fields"] = {field: "fail" for field in E_FIELDS}
        review["e_rows"][0].update(meaning="unresolved", inclusion="unresolved", safety="unresolved")
        review["e_rows"][0]["lineage"] = {"v_input_indices": [], "final_indices": [], "status": "unresolved"}
        review["v_rows"][0].update(
            fields={field: "fail" for field in V_FIELDS}, semantic="unresolved",
            e_indices=[], lineage="unresolved",
        )
        review["claims"][0]["groups"] = []
        review["window_checks"]["lineage"] = "unresolved"
        report = score_case_review(packet, review)
        self.assertEqual(packet["layers"]["extraction"][0]["payload"], {"text": "非法原E结构"})
        self.assertEqual(packet["layers"]["verification"][0]["payload"], {"verdict": "非法原V标签"})
        self.assertEqual(report["required"], {"total": 1, "raw": 0, "accepted": 0, "full": 0})
        self.assertEqual(report["e_fields"]["category"]["fail"], 1)
        self.assertEqual(report["v_fields"]["candidate_index"]["fail"], 1)
        self.assertFalse(report["none_correct"])

    def test_packet_drift_or_missing_verification_review_cannot_be_scored(self):
        packet = prepare_case_review(_reference(), "W1", _evidence())
        review = _review(packet)
        for fault in ("packet", "missing_v", "v_digest", "run_status"):
            with self.subTest(fault=fault):
                altered_packet, altered_review = copy.deepcopy(packet), copy.deepcopy(review)
                if fault == "packet":
                    altered_packet["evidence"]["extraction"][0]["text"] = "换成其他证据"
                elif fault == "missing_v":
                    altered_review["v_rows"] = []
                elif fault == "v_digest":
                    altered_review["v_rows"][0]["payload_sha256"] = "c" * 64
                else:
                    altered_review["run_status"] = "empty"
                with self.assertRaises(ValueError):
                    score_case_review(altered_packet, altered_review)

    def test_optional_denominator_and_mixed_claims_do_not_reward_extra_versions(self):
        reference = _reference()
        second = copy.deepcopy(reference["windows"][0]["claims"][0])
        second["id"] = "W1-P2"
        second["variants"][0].update(id="W1-P2-v1", speech_act="plan", ideal_destination="pending")
        reference["windows"][0]["claims"].append(second)
        evidence = _evidence()
        evidence["extraction"][0]["text"] = "已经读完合成资料，准备归还。"
        evidence["final_facts"][0]["destination"] = "none"
        packet = prepare_case_review(reference, "W1", evidence)
        review = _review(packet)
        review["e_rows"][0]["fields"]["speech_act"] = "fail"
        report = score_case_review(packet, review)
        self.assertEqual(report["required"], {"total": 2, "raw": 2, "accepted": 0, "full": 0})
        second["required"] = False
        packet = prepare_case_review(reference, "W1", _evidence())
        review = _review(packet)
        review["claims"][1]["groups"] = []
        review["claims"][0]["groups"] *= 2
        report = score_case_review(packet, review)
        self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 1, "full": 1})
        self.assertEqual(report["optional"], {"total": 1, "raw": 0, "accepted": 0, "full": 0})

    def test_safety_uses_actual_auto_destination_and_counts_ambiguous_auto(self):
        for safety, destination, key, expected in (
            ("wrong_person", "auto", "wrong_person", 1),
            ("wrong_person", "pending", "wrong_person", 0),
            ("ambiguous", "auto", "ambiguous_auto", 1),
        ):
            with self.subTest(safety=safety, destination=destination):
                evidence = _evidence()
                evidence["final_facts"][0]["destination"] = destination
                packet = prepare_case_review(_reference(), "W1", evidence)
                review = _review(packet)
                review["e_rows"][0]["safety"] = safety
                report = score_case_review(packet, review)
                self.assertEqual(report["safety"][key], expected)
                self.assertEqual(report["required"]["full"], 0)

    def test_actual_verification_input_mismatch_does_not_get_full_credit(self):
        evidence = _evidence()
        evidence["verification_inputs"][0]["subject"] = "self"
        packet = prepare_case_review(_reference(), "W1", evidence)
        report = score_case_review(packet, _review(packet))
        self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 1, "full": 0})

    def test_raw_captured_before_verification_failure_keeps_only_raw_credit(self):
        evidence = _evidence()
        evidence.update(run_status="failed", verification=[], final_facts=[])
        evidence["original_result"] = {"failure_reason": "verification_unavailable"}
        packet = prepare_case_review(_reference(), "W1", evidence)
        report = score_case_review(packet, _review(packet))
        self.assertEqual(report["required"], {"total": 1, "raw": 1, "accepted": 0, "full": 0})
        self.assertFalse(report["none_correct"])


if __name__ == "__main__":
    unittest.main()
