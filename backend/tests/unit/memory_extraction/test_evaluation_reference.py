"""公开参考加载门的离线检查，不读取凭据或构造模型。"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch


def full_reference_fixture():
    """只提供完整形状的合成协议夹具，不装配或发布119份语义Gold。"""
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_cases import CASES
    from notalone.memory_extraction.evaluation_records import canonical_sha256
    from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES

    root = Path(__file__).resolve().parents[4]
    parent_path = ".scratch/unfinished-work/memory-gold-reference-20261012.json"
    parent_bytes = (root / parent_path).read_bytes()
    parent = json.loads(parent_bytes)
    cases = (*CASES, *SEMANTIC_CASES)
    old_positions = {window["case_name"]: window["position"] for window in parent["windows"]}
    new_cases = tuple(case for case in cases if case.name not in old_positions)
    reference = deepcopy(parent)
    reference["annotation_path"] = (
        ".scratch/unfinished-work/memory-gold-full140-agent-annotations-20261013.md"
    )
    reference["annotation_sha256"] = hashlib.sha256("合成协议判据。".encode()).hexdigest()
    reference["common_rules"] = {"scope": "仅扩展119的协议夹具，不构成语义判据。"}
    template = parent["windows"][7]["claims"][0]
    for index, case in enumerate(new_cases, 1):
        identity = f"R{index:03d}"
        claims = []
        if case.expect != "none":
            claim = deepcopy(template)
            claim["id"] = f"{identity}-P1"
            claim["meaning_requirements"] = ["仅测试完整结构，不认证此用例语义。"]
            variant = claim["variants"][0]
            variant["id"] = f"{identity}-P1-v1"
            variant["source_choices"] = [
                {"indices": [case.targets[0]], "when": "仅测试合法来源位置。"},
            ]
            claims = [claim]
        reference["windows"].append({
            "id": identity, "position": 20 + index, "case_name": case.name,
            "input_sha256": canonical_sha256(build_window(case)),
            "target_indices": list(case.targets),
            "inclusion": "none" if case.expect == "none" else "retain",
            "claims": claims, "forbidden_meanings": ["不得把结构夹具当实际Gold。"],
        })
    positions = {window["case_name"]: window["position"] for window in reference["windows"]}
    reference["provenance"] = {
        "oracle_aware": True, "blind_annotation": False, "quality_certified": False,
        "structured_review": {"status": "passed", "reviewer": "仅合成结构正控"},
        "human_review": [], "reference_complete": True, "unresolved_cases": [],
        "parent21": {
            "reference_path": parent_path,
            "reference_file_sha256": hashlib.sha256(parent_bytes).hexdigest(),
            "reference_sha256": canonical_sha256(parent), "reference": parent,
        },
        "public_cases_sha256": canonical_sha256(cases),
        "local_to_reference_positions": [positions[case.name] for case in cases],
        "rule_scopes": {
            "original21_common_rules_sha256": canonical_sha256(parent["common_rules"]),
            "extended119_common_rules_sha256": canonical_sha256(reference["common_rules"]),
            "extended_case_ids": [f"R{index:03d}" for index in range(1, 120)],
        },
    }
    return reference


class EvaluationReferenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.guard = patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True)
        self.guard.start()
        self.addCleanup(self.guard.stop)
        self.root = Path(__file__).resolve().parents[4]
        self.reference = json.loads((self.root /
            ".scratch/unfinished-work/memory-gold-reference-20261012.json").read_text())
        self.annotation = hashlib.sha256(
            (self.root / self.reference["annotation_path"]).read_bytes(),
        ).hexdigest()
        self.expected = "5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32"

    def validate(self, reference=None, *, digest=None, annotation=None):
        from notalone.memory_extraction.evaluation_reference import validate_public_reference

        return validate_public_reference(
            self.reference if reference is None else reference,
            expected_reference_sha256=self.expected if digest is None else digest,
            annotation_sha256=self.annotation if annotation is None else annotation,
        )

    def test_full_reference_keeps_parent_exact_and_has_original_order_mapping(self):
        from notalone.memory_extraction.evaluation_reference import (
            validate_full_public_reference,
        )
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        reference = full_reference_fixture()
        before = canonical_sha256(reference)
        result = validate_full_public_reference(
            reference, expected_reference_sha256=before,
            annotation_sha256=reference["annotation_sha256"],
        )
        self.assertEqual(result["planned_windows"], 140)
        positions = result["case_positions"]
        self.assertIs(type(positions), tuple)
        self.assertEqual(sorted(positions), list(range(140)))
        self.assertEqual(positions[0], 0)
        self.assertEqual(positions[76], 1)
        self.assertEqual(positions[-2:], (19, 20))
        self.assertEqual(reference["windows"][:21], self.reference["windows"])
        self.assertEqual(canonical_sha256(reference), before)
        self.assertFalse(result["quality_certified"])

    def test_full_reference_rejects_unreviewed_or_unresolved_source_only_draft(self):
        from notalone.memory_extraction.evaluation_reference import (
            validate_full_public_reference,
        )
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        for field, value in (("reference_complete", False),
                             ("unresolved_cases", ["R067:日期冲突"]),
                             ("structured_review", {"status": "pending"})):
            reference = full_reference_fixture()
            reference["provenance"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_full_public_reference(
                    reference, expected_reference_sha256=canonical_sha256(reference),
                    annotation_sha256=reference["annotation_sha256"],
                )

    def test_full_cannot_replace_parent_fields_rule_scope_or_source_contract(self):
        from notalone.memory_extraction.evaluation_reference import validate_full_public_reference
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        def new_claim(reference):
            return next(window["claims"][0] for window in reference["windows"][21:]
                        if window["claims"])

        mutations = (
            lambda ref: ref["windows"].append(deepcopy(ref["windows"][-1])),
            lambda ref: ref["windows"][21].update(id="R002"),
            lambda ref: ref["windows"][21].update(case_name="其他合成输入"),
            lambda ref: ref["windows"][21].update(target_indices=[True]),
            lambda ref: ref["provenance"]["local_to_reference_positions"].__setitem__(0, True),
            lambda ref: ref["provenance"]["parent21"].update(reference_file_sha256="f" * 64),
            lambda ref: ref["provenance"]["parent21"]["reference"]["provenance"].update(
                human_review=[],
            ),
            lambda ref: ref["windows"][0]["claims"][0].update(required=False),
            lambda ref: ref["windows"][0]["claims"][0]["variants"][0][
                "source_choices"
            ][0]["indices"].__setitem__(0, False),
            lambda ref: ref["windows"][0]["claims"][0]["variants"][0][
                "source_choices"
            ][0]["indices"].__setitem__(0, 0.0),
            lambda ref: ref.update(common_rules=deepcopy(self.reference["common_rules"])),
            lambda ref: ref["provenance"]["rule_scopes"].update(extended_case_ids=["A01"]),
            lambda ref: ref.update(e_fields=ref["e_fields"][:-1]),
            lambda ref: ref.update(v_fields=ref["v_fields"][:-1]),
            lambda ref: new_claim(ref).update(required=False),
            lambda ref: new_claim(ref).update(meaning_requirements="这不是判据列表"),
            lambda ref: new_claim(ref)["variants"][0].pop("valid_at"),
            lambda ref: new_claim(ref)["variants"][0].update(valid_at=True),
            lambda ref: new_claim(ref)["variants"][0].update(valid_at="2026-09-15"),
            lambda ref: new_claim(ref)["variants"][0].update(source_choices=[]),
            lambda ref: new_claim(ref)["variants"][0].update(
                source_choices=[{"indices": [True], "when": "不允许布尔序号。"}],
            ),
        )
        for position, mutate in enumerate(mutations):
            reference = full_reference_fixture()
            mutate(reference)
            with self.subTest(position=position), self.assertRaises(ValueError):
                validate_full_public_reference(
                    reference, expected_reference_sha256=canonical_sha256(reference),
                    annotation_sha256=reference["annotation_sha256"],
                )

    def test_full_date_interval_must_be_nonempty_using_actual_timezone_offsets(self):
        from notalone.memory_extraction.evaluation_reference import validate_full_public_reference
        from notalone.memory_extraction.evaluation_records import canonical_sha256

        start = "2026-09-15T08:00:00+08:00"
        for end in ("2026-09-15T00:00:00+00:00", "2026-09-14T23:59:59+00:00"):
            reference = full_reference_fixture()
            claim = next(window["claims"][0] for window in reference["windows"][21:]
                         if window["claims"])
            claim["variants"][0].update(valid_at=start, invalid_at=end)
            with self.subTest(end=end), self.assertRaises(ValueError):
                validate_full_public_reference(
                    reference, expected_reference_sha256=canonical_sha256(reference),
                    annotation_sha256=reference["annotation_sha256"],
                )
        for begin, end in ((start, "2026-09-15T00:00:01+00:00"), (start, None), (None, None)):
            reference = full_reference_fixture()
            claim = next(window["claims"][0] for window in reference["windows"][21:]
                         if window["claims"])
            claim["variants"][0].update(valid_at=begin, invalid_at=end)
            self.assertEqual(validate_full_public_reference(
                reference, expected_reference_sha256=canonical_sha256(reference),
                annotation_sha256=reference["annotation_sha256"],
            )["planned_windows"], 140)

    def test_reviewed_public_reference_keeps_all_windows_and_original_denominators(self):
        result = self.validate()
        self.assertEqual(result["reference_sha256"], self.expected)
        self.assertEqual(result["planned_windows"], 21)
        self.assertEqual(result["required_claims"], 28)
        self.assertEqual(result["optional_claims"], 1)
        self.assertFalse(result["quality_certified"])

    def test_changed_public_plan_or_denominator_is_rejected_even_with_new_digest(self):
        changed = []
        reference = deepcopy(self.reference)
        reference["windows"] = reference["windows"][:1]
        changed.append(reference)
        for key, value in (("case_name", "其他合成窗口"), ("input_sha256", "f" * 64),
                           ("target_indices", []), ("position", 4), ("id", "A99")):
            reference = deepcopy(self.reference)
            reference["windows"][0][key] = value
            changed.append(reference)
        reference = deepcopy(self.reference)
        reference["windows"][0]["claims"][0]["required"] = False
        changed.append(reference)
        reference = deepcopy(self.reference)
        reference["windows"][13]["inclusion"] = "retain"
        changed.append(reference)
        for reference in changed:
            with self.subTest(window_count=len(reference["windows"])):
                digest = hashlib.sha256(json.dumps(
                    reference, ensure_ascii=False, sort_keys=True,
                    separators=(",", ":"), allow_nan=False,
                ).encode()).hexdigest()
                with self.assertRaises(ValueError):
                    self.validate(reference, digest=digest)

    def test_review_provenance_and_optional_identity_cannot_be_silently_replaced(self):
        changed = []
        for key, value in (("oracle_aware", False), ("blind_annotation", True),
                           ("quality_certified", True), ("structured_review", "pending"),
                           ("human_review", [])):
            reference = deepcopy(self.reference)
            reference["provenance"][key] = value
            changed.append(reference)
        reference = deepcopy(self.reference)
        reference["annotation_path"] = ".scratch/other-annotation.md"
        changed.append(reference)
        reference = deepcopy(self.reference)
        reference["windows"][14]["claims"][1]["required"] = True
        reference["windows"][4]["claims"][0]["required"] = False
        changed.append(reference)
        for position, reference in enumerate(changed):
            with self.subTest(mutation=position):
                digest = hashlib.sha256(json.dumps(
                    reference, ensure_ascii=False, sort_keys=True,
                    separators=(",", ":"), allow_nan=False,
                ).encode()).hexdigest()
                with self.assertRaises(ValueError):
                    self.validate(reference, digest=digest)

    def test_review_and_annotation_digest_must_match_the_explicit_expectation(self):
        reference = deepcopy(self.reference)
        reference["windows"][0]["claims"][0]["meaning_requirements"] = ["另一条命题"]
        with self.assertRaises(ValueError):
            self.validate(reference)
        for digest in ("e" * 64, "", True):
            with self.subTest(digest=digest), self.assertRaises(ValueError):
                self.validate(annotation=digest)

    def test_live_schema_fields_must_still_match_the_reviewed_reference(self):
        from notalone.memory_extraction.adapters import EXTRACTION_SCHEMA
        from notalone.memory_extraction.verification_adapters import SOURCE_VERIFICATION_SCHEMA

        items = (
            EXTRACTION_SCHEMA["properties"]["facts"]["items"],
            SOURCE_VERIFICATION_SCHEMA["properties"]["results"]["items"],
        )
        for position, item in enumerate(items):
            with self.subTest(schema=position), patch.dict(
                item, {"required": [*item["required"], "new_field"]},
            ), self.assertRaises(ValueError):
                self.validate()


if __name__ == "__main__":
    unittest.main()
