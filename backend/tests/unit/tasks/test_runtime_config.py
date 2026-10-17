"""指定提取任务配置的精确持久化值合同。"""

from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

from notalone.tasks.models import (
    BackgroundTaskStepName, ClaimedBackgroundTaskStep,
    ExtractionRuntimeConfig, ExtractionRuntimeMode,
)


class ExtractionRuntimeConfigTest(unittest.TestCase):
    def test_round_trip_preserves_explicit_mode_and_rule_version(self) -> None:
        payload = {
            "version": 1,
            "mode": "bounded-runtime-v1",
            "rule_set_sha256": "a" * 64,
        }

        config = ExtractionRuntimeConfig.from_payload(payload)

        self.assertEqual(config.mode, ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        self.assertEqual(config.to_payload(), payload)
        payload["rule_set_sha256"] = "b" * 64
        self.assertEqual(config.rule_set_sha256, "a" * 64)

    def test_explicit_legacy_has_no_rule_digest(self) -> None:
        config = ExtractionRuntimeConfig.from_payload({
            "version": 1, "mode": "legacy", "rule_set_sha256": None,
        })

        self.assertEqual(config.mode, ExtractionRuntimeMode.LEGACY)
        self.assertEqual(config.to_payload(), {
            "version": 1, "mode": "legacy", "rule_set_sha256": None,
        })

    def test_storage_rejects_malformed_or_ambiguous_config(self) -> None:
        valid = {"version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": "a" * 64}
        invalid = [
            None, [], "legacy", {},
            {**valid, "version": True}, {**valid, "version": 1.0},
            {**valid, "version": "1"}, {**valid, "version": 2},
            {**valid, "mode": None}, {**valid, "mode": True},
            {**valid, "mode": "unknown"},
            {**valid, "mode": ExtractionRuntimeMode.BOUNDED_RUNTIME_V1},
            {**valid, "rule_set_sha256": None}, {**valid, "rule_set_sha256": 123},
            {**valid, "rule_set_sha256": "A" * 64},
            {**valid, "rule_set_sha256": "g" * 64},
            {**valid, "rule_set_sha256": "a" * 63},
            {**valid, "rule_set_sha256": "a" * 64 + "\n"},
            {**valid, "mode": "legacy"},
            {**valid, "extra": False},
            {k: v for k, v in valid.items() if k != "rule_set_sha256"},
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    ExtractionRuntimeConfig.from_payload(payload)

    def test_claim_preserves_immutable_config_and_rejects_raw_payload(self) -> None:
        claim = ClaimedBackgroundTaskStep(
            task_id=uuid4(), owner_id=uuid4(), contact_id=uuid4(),
            source_document_id=uuid4(), step_id=uuid4(),
            name=BackgroundTaskStepName.EXTRACT_MEMORY, worker_id=uuid4(),
            attempt_count=1, message_count=1,
            lease_expires_at=datetime.now(timezone.utc),
        )
        self.assertIsNone(claim.extraction_runtime_config)
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1, "a" * 64)
        self.assertEqual(replace(claim, extraction_runtime_config=config).extraction_runtime_config, config)
        for raw in (config.to_payload(), "bounded-runtime-v1"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                replace(claim, extraction_runtime_config=raw)


if __name__ == "__main__":
    unittest.main()
