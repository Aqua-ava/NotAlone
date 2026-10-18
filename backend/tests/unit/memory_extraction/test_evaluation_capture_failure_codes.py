"""捕获失败只暴露固定诊断码，不落盘异常或合成秘密。"""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationBudget, EvaluationBudgetAbort, EvaluationTransport,
)
from notalone.memory_extraction.evaluation_records import (
    EvaluationRecordStore, canonical_sha256,
)


ENDPOINT = "https://evaluation.invalid/v1/chat/completions"
SECRET = "synthetic-private-sentinel-do-not-save"


class CaptureFailureCodesTest(unittest.TestCase):
    def assert_safe_failure(self, body, code, *, strict=False):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            output = home / "output"
            output.mkdir(mode=0o700)
            plan = ({"case_position": 0, "case_name": "合成未知", "input_sha256": "a" * 64},)
            config = {"mode": "offline_mock", "plan_sha256": canonical_sha256(plan)}
            if strict:
                from tests.unit.memory_extraction.test_evaluation_reference16_pro_contract import registration
                config, plan = registration()
            endpoint = config.get("endpoint", ENDPOINT)
            with patch.object(Path, "home", return_value=home):
                budget = EvaluationBudget.create(
                    run_id=uuid4(), output_directory=output, request_limit=32 if strict else 1,
                    allowed_endpoints=(endpoint,), config_sha256=canonical_sha256(config),
                )
                records = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                with self.assertRaisesRegex(EvaluationBudgetAbort, "response_redaction_unavailable"):
                    with budget.batch(), records.stage(0, "case"):
                        records.record(kind="case_started", payload={})
                        with httpx.Client(transport=EvaluationTransport(
                            budget, records=records,
                            synthetic_transport=httpx.MockTransport(
                                lambda request: httpx.Response(200, content=body),
                            ),
                        ), trust_env=False) as client:
                            client.post(endpoint, json={})
                self.assertEqual(budget.closed_receipt()["reserved_requests"], 1)
                receipt = records.finalize(
                    outcomes=tuple({**item, "status": "unknown" if index == 0 else "unrun"}
                                   for index, item in enumerate(plan)), budget_closed=True,
                )
                gap, = receipt["capture_gaps"]
                self.assertEqual(gap["redaction_failure_code"], code)
                self.assertEqual(gap["original_bytes_sha256"], hashlib.sha256(body).hexdigest())
                self.assertEqual(gap["body_not_saved"], "redaction_unavailable")
                self.assertFalse(receipt["quality_certified"])
                self.assertFalse(receipt["plan_complete"])
                self.assertEqual(receipt["outcomes"][0]["status"], "unknown")
                response, = [event for event in records.events() if event["kind"] == "provider_response"]
                self.assertEqual(response["payload"]["redaction_failure_code"], code)
                self.assertNotIn("body", response["payload"])
                for path in output.iterdir():
                    content = path.read_bytes()
                    self.assertNotIn(SECRET.encode(), content)
                    self.assertNotIn(b"JSONDecodeError", content)

    def test_invalid_body_json_keeps_digest_and_closed_unknown_receipt(self):
        self.assert_safe_failure(
            ('{"reasoning_content":"' + SECRET + '"').encode(), "body_json_invalid",
        )

    def test_capture_failures_have_fixed_codes_without_saving_sensitive_input(self):
        cases = (
            (b'\xff' + SECRET.encode(), "body_encoding_invalid"),
            (json.dumps({"arguments": SECRET}).encode(), "nested_json_invalid"),
            (json.dumps({"arguments": json.dumps([SECRET])}).encode(), "nested_json_not_object"),
            (("[" * 1200 + json.dumps(SECRET) + "]" * 1200).encode(), "internal_failure"),
        )
        for body, code in cases:
            for strict in (False, True):
                with self.subTest(code=code, strict=strict):
                    self.assert_safe_failure(body, code, strict=strict)

    def test_strict_serialization_failure_keeps_digest_and_unknown_receipt(self):
        for value in ("\ud800", float("nan")):
            with self.subTest(value_type=type(value).__name__):
                self.assert_safe_failure(
                    json.dumps({"reasoning_content": SECRET, "answer": value}).encode(),
                    "serialization_failed", strict=True,
                )
