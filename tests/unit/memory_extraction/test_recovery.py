"""提取失败恢复策略的纯函数测试。"""

from __future__ import annotations

import unittest
from uuid import uuid4

from notalone.memory_extraction.models import ExtractionFailureKind
from notalone.memory_extraction.recovery import (
    DEFAULT_FAILURE_SKIP_THRESHOLD,
    ExtractionFailureState,
    FailureRange,
    record_batch_failure,
)


def _range(from_id=None, to_id=None) -> FailureRange:
    return FailureRange(
        from_message_id=from_id or uuid4(),
        to_message_id=to_id or uuid4(),
        code=ExtractionFailureKind.INVALID_OUTPUT,
    )


class RecordBatchFailureTest(unittest.TestCase):
    """同区间连续计数、区间变化重置、达阈值才跳过。"""

    def test_first_failure_starts_counting(self) -> None:
        failure_range = _range()

        state, skip = record_batch_failure(None, failure_range=failure_range)

        self.assertEqual(state.count, 1)
        self.assertEqual(state.failure_range, failure_range)
        self.assertFalse(skip)

    def test_same_range_accumulates_to_threshold(self) -> None:
        from_id, to_id = uuid4(), uuid4()
        failure_range = _range(from_id, to_id)
        state = ExtractionFailureState(count=1, failure_range=failure_range)

        state, skip = record_batch_failure(state, failure_range=failure_range)
        self.assertEqual(state.count, 2)
        self.assertFalse(skip)

        state, skip = record_batch_failure(state, failure_range=failure_range)
        self.assertEqual(state.count, DEFAULT_FAILURE_SKIP_THRESHOLD)
        self.assertTrue(skip)

    def test_different_range_resets_count(self) -> None:
        state = ExtractionFailureState(count=2, failure_range=_range())

        state, skip = record_batch_failure(state, failure_range=_range())

        self.assertEqual(state.count, 1)
        self.assertFalse(skip)

    def test_threshold_is_configurable(self) -> None:
        failure_range = _range()
        state = ExtractionFailureState(count=1, failure_range=failure_range)

        _, skip = record_batch_failure(
            state,
            failure_range=failure_range,
            threshold=2,
        )

        self.assertTrue(skip)

    def test_invalid_threshold_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            record_batch_failure(
                None,
                failure_range=_range(),
                threshold=0,
            )

    def test_state_requires_count_and_range(self) -> None:
        with self.assertRaises(ValueError):
            ExtractionFailureState(count=0, failure_range=_range())
        with self.assertRaises(TypeError):
            ExtractionFailureState(count=1, failure_range=object())

    def test_failure_range_requires_uuid_and_controlled_code(self) -> None:
        with self.assertRaises(TypeError):
            FailureRange(
                from_message_id="not-a-uuid",
                to_message_id=uuid4(),
                code=ExtractionFailureKind.INVALID_OUTPUT,
            )
        with self.assertRaises(TypeError):
            FailureRange(
                from_message_id=uuid4(),
                to_message_id=uuid4(),
                code="invalid_output",
            )


if __name__ == "__main__":
    unittest.main()
