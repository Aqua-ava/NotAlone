"""提取外壳的逐条解析、证据契约校验与整体失败语义测试。"""

from __future__ import annotations

import unittest
from uuid import uuid4

from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionFlow, ExtractionOutcome
from notalone.memory_extraction.runtime import ExtractionPayload
from tests.unit.memory_extraction.test_models import _window


def _payload(message_id: object, **overrides: object) -> dict:
    fields: dict[str, object] = {
        "text": "他不爱发语音，有事爱直接打电话",
        "category": "preference",
        "subject": "contact",
        "topic": "other",
        "source_message_ids": [str(message_id)],
        "confidence": 0.9,
        "risk_flags": [],
        "valid_at": None,
        "invalid_at": None,
    }
    fields.update(overrides)
    return fields


class RecordingRuntime:
    """返回预置原始候选的确定性运行时。"""

    def __init__(self, payloads: ExtractionPayload) -> None:
        self.payloads = payloads

    def extract(self, window: object) -> ExtractionPayload:  # noqa: ARG002
        return self.payloads


class CrashingRuntime:
    def extract(self, window: object) -> ExtractionPayload:  # noqa: ARG002
        raise ExtractionRuntimeError("模型未返回可解析的结构化事实。")


class ExtractionFlowTest(unittest.TestCase):
    """外壳只做确定性解析与契约校验，不调用真实模型。"""

    def _run_flow(
        self, runtime: object, message_id: object = None
    ) -> ExtractionOutcome:
        resolved_id = message_id if message_id is not None else uuid4()
        return ExtractionFlow(runtime=runtime).run(_window((resolved_id,)))

    def test_valid_payload_passes_with_counts(self) -> None:
        message_id = uuid4()

        outcome = self._run_flow(
            RecordingRuntime((_payload(message_id),)), message_id
        )

        self.assertEqual(len(outcome.accepted), 1)
        fact = outcome.accepted[0]
        self.assertEqual(fact.text, "他不爱发语音，有事爱直接打电话")
        self.assertEqual(fact.source_message_ids, (message_id,))
        self.assertEqual(outcome.rejected_count, 0)
        self.assertIsNone(outcome.failure_reason)

    def test_facts_referencing_outside_window_are_rejected(self) -> None:
        valid_id = uuid4()
        window = _window((valid_id,))
        payloads = (
            _payload(valid_id),
            _payload(uuid4()),
            _payload(valid_id, source_message_ids=[str(valid_id), str(uuid4())]),
        )

        outcome = ExtractionFlow(
            runtime=RecordingRuntime(payloads)
        ).run(window)

        self.assertEqual(len(outcome.accepted), 1)
        self.assertEqual(outcome.rejected_count, 2)

    def test_invalid_fields_are_rejected_one_by_one(self) -> None:
        message_id = uuid4()
        payloads = (
            _payload(uuid4(), subject="somebody_else"),
            _payload(uuid4(), category="hobby"),
            {"text": "缺字段的事实"},
        )

        outcome = self._run_flow(RecordingRuntime(payloads), message_id)

        self.assertEqual(outcome.accepted, ())
        self.assertEqual(outcome.rejected_count, 3)
        self.assertIsNone(outcome.failure_reason)

    def test_mixed_batch_keeps_valid_and_counts_invalid(self) -> None:
        message_id = uuid4()
        payloads = (
            _payload(message_id),
            _payload(uuid4()),
            _payload(uuid4(), confidence=2.0),
        )

        outcome = self._run_flow(RecordingRuntime(payloads), message_id)

        self.assertEqual(len(outcome.accepted), 1)
        self.assertEqual(outcome.rejected_count, 2)

    def test_runtime_failure_is_reported_not_raised(self) -> None:
        outcome = self._run_flow(CrashingRuntime())

        self.assertEqual(outcome.accepted, ())
        self.assertEqual(
            outcome.failure_reason, "模型未返回可解析的结构化事实。"
        )


if __name__ == "__main__":
    unittest.main()
