"""公开参考加载门的离线检查，不读取凭据或构造模型。"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch


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
