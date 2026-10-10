"""纯预算回执 codec 的严格结构、不可变值与无正文错误边界。"""

from __future__ import annotations

import unittest
from dataclasses import FrozenInstanceError, replace

from notalone.reply.input_budget import (
    BudgetState, InputBudgetDecision, TokenMeasurementKind,
)
from notalone.reply.input_budget_receipt import (
    decode_input_budget_receipt,
    input_budget_receipt_payload,
    validate_input_budget_receipt,
)


def receipt() -> InputBudgetDecision:
    return InputBudgetDecision(
        state=BudgetState.WARNING, model_id="synthetic-receipt-model-v1",
        context_window_tokens=1000, input_tokens=750, output_reserve_tokens=100,
        total_tokens=850, measurement_kind=TokenMeasurementKind.EXACT,
        measurement_id="synthetic-complete-protocol-v1",
    )


class InputBudgetReceiptTest(unittest.TestCase):
    def test_complete_receipt_roundtrips_without_recomputing_saved_warning(self):
        for kind in TokenMeasurementKind:
            with self.subTest(kind=kind):
                expected = replace(receipt(), measurement_kind=kind)
                payload = input_budget_receipt_payload(expected)
                decoded = decode_input_budget_receipt(payload)
                self.assertEqual(decoded, expected)
                self.assertEqual(validate_input_budget_receipt(decoded), expected)
                self.assertIsNot(decoded, expected)
                with self.assertRaises(FrozenInstanceError):
                    decoded.input_tokens = 0

    def test_legacy_absence_is_optional_but_present_null_is_not_a_saved_receipt(self):
        self.assertIsNone(validate_input_budget_receipt(None))
        self.assertIsNone(input_budget_receipt_payload(None))
        with self.assertRaises(ValueError):
            decode_input_budget_receipt(None)

    def test_partial_extra_or_non_mapping_payload_never_becomes_a_receipt(self):
        complete = receipt().to_payload()
        missing = dict(complete)
        del missing["measurement_id"]
        cases = (
            missing,
            {**complete, "request_body": "合成敏感正文不能写入预算。"},
            {**complete, "allowed": 1},
            [],
        )
        for payload in cases:
            with self.subTest(payload_type=type(payload).__name__):
                with self.assertRaises(ValueError) as caught:
                    decode_input_budget_receipt(payload)
                self.assertNotIn("合成敏感正文", str(caught.exception))

    def test_unknown_failed_or_inconsistent_numeric_metadata_is_rejected(self):
        changes = (
            {"state": "unavailable", "allowed": False},
            {"state": "exceeded", "allowed": False},
            {"model_id": ""},
            {"measurement_id": None},
            {"measurement_kind": "approximate"},
            {"reason": "context_window_exceeded"},
            {"input_tokens": True},
            {"input_tokens": -1},
            {"input_tokens": float("nan")},
            {"input_tokens": float("inf")},
            {"input_tokens": 750.0},
            {"context_window_tokens": None},
            {"output_reserve_tokens": 1000},
            {"total_tokens": 849},
            {"input_tokens": 1000, "total_tokens": 1100},
        )
        for change in changes:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    decode_input_budget_receipt({**receipt().to_payload(), **change})

    def test_internal_metadata_must_be_the_typed_allowed_value(self):
        for value in (
            receipt().to_payload(),
            replace(receipt(), input_tokens=True),
            replace(receipt(), state=BudgetState.EXCEEDED),
        ):
            with self.subTest(value_type=type(value).__name__):
                with self.assertRaises(ValueError):
                    validate_input_budget_receipt(value)


if __name__ == "__main__":
    unittest.main()
