"""混合合同与共享记录的封闭负控；仅临时home和精确Mock。"""
from contextlib import ExitStack
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_extraction import EvaluationExtractionMode
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort, EvaluationTransport
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_extraction.evaluation_provider_contract import (
    MIXED_PLAN, MIXED_MODE, MIXED_STAGE, MIXED_REQUEST_VERSION, mixed_phase_policy,
    EvaluationProviderProfile, _validate_payload,
)
from tests.unit.memory_extraction import test_evaluation_records as records_tests
from tests.unit.memory_extraction import test_evaluation_provider_contract as provider_tests


class MixedContractTest(unittest.TestCase):
    setUp = provider_tests.EvaluationProviderContractTest.setUp
    _contract = provider_tests.EvaluationProviderContractTest._contract

    def test_fixed_pair_validates_exact_tool_phase_and_old_profile_rejects_new_v(self):
        for purpose in ("extraction", "verification"):
            value = provider_tests._payload()
            value["model"] = "deepseek-flash"
            value["tools"][0]["function"]["name"] = "GroundedMemoryLabelsV4" if purpose == "extraction" else "SourceVerificationOutput"
            value["thinking"] = {"type": "enabled" if purpose == "extraction" else "disabled"}
            value["reasoning_effort"] = "max" if purpose == "extraction" else "none"
            if purpose == "extraction":
                value.pop("tool_choice")
            else:
                value["tool_choice"]["function"]["name"] = "SourceVerificationOutput"
            options = {"provider_profile": EvaluationProviderProfile.DEEPSEEK_PHASE_SPLIT,
                       "extraction_mode": EvaluationExtractionMode.GROUNDED_V4, "verification_tool_choice": "forced"}
            _validate_payload(value, **options)
            for changed in ("thinking", "effort", "choice"):
                broken = deepcopy(value)
                if changed == "thinking":
                    broken["thinking"] = {"type": "disabled" if purpose == "extraction" else "enabled"}
                elif changed == "effort":
                    broken["reasoning_effort"] = "none" if purpose == "extraction" else "max"
                elif purpose == "extraction":
                    broken["tool_choice"] = {"type": "function", "function": {"name": "GroundedMemoryLabelsV4"}}
                else:
                    broken.pop("tool_choice")
                with self.subTest(purpose=purpose, changed=changed), self.assertRaises(EvaluationBudgetAbort):
                    _validate_payload(broken, **options)
            if purpose == "verification":
                with self.assertRaises(EvaluationBudgetAbort):
                    _validate_payload(value, **{**options, "provider_profile": EvaluationProviderProfile.DEEPSEEK_FLASH_MAX})
        with self.assertRaises(EvaluationBudgetAbort):
            self._contract(provider_profile="deepseek-phase-split-v1")
        self._contract(provider_profile="deepseek-phase-split-v1", execution_plan=MIXED_PLAN, extraction_mode="grounded-v4")

    def test_new_response_requires_integer_zero_single_choice_and_official_model(self):
        for invalid in (False, 0.0, 1, "model", "multiple"):
            with self.subTest(invalid=invalid):
                contract = self._contract(provider_profile="deepseek-phase-split-v1", execution_plan=MIXED_PLAN,
                                          extraction_mode="grounded-v4")
                body = provider_tests._completion("deepseek-flash")
                if invalid == "model":
                    body["model"] = "deepseek-v4-flash"
                elif invalid == "multiple":
                    body["choices"] *= 2
                else:
                    body["choices"][0]["index"] = invalid
                with self.assertRaises(EvaluationBudgetAbort):
                    contract.observe_response(httpx.Response(200, json=body))


class MixedRecordsTest(unittest.TestCase):
    config_plan = records_tests.Full140V4RecordContractTest.config_plan

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))

    def create(self, *, mixed=True, name="case"):
        folder = self.home / name
        folder.mkdir(mode=0o700)
        config, plan = self.config_plan()
        if mixed:
            config.update(mode=MIXED_MODE, stage=MIXED_STAGE, execution_plan=MIXED_PLAN,
                          phase_request_version=MIXED_REQUEST_VERSION, phase_request_policy=mixed_phase_policy())
            config["tool_choice"]["verification"]["mode"] = "forced"
        output = folder / "output"
        output.mkdir(mode=0o700)
        config.update(base_url="https://api.deepseek.com", endpoint="https://api.deepseek.com/chat/completions",
                      request_model="deepseek-flash", timeout=300.0, request_contract_version=2)
        budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=280,
            allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256=canonical_sha256(config))
        return budget, EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)

    def test_response_capture_gap_covers_full_normalization_and_keeps_actual_status(self):
        for name, body, status in (
            ("arguments", {"arguments": "{"}, 503), ("nonobject", {"arguments": "[]"}, 200),
            ("nonfinite", {"usage": {"total_tokens": float("nan")}}, 200),
            ("surrogate", {"content": "\ud800"}, 503),
        ):
            with self.subTest(name=name):
                budget, records = self.create(name=name)
                content = json.dumps({**body, "reasoning_content": "private-marker"}).encode()
                with self.assertRaises(EvaluationBudgetAbort), budget.batch(), records.stage(0, "verification"):
                    with httpx.Client(transport=EvaluationTransport(budget, records=records,
                            synthetic_transport=httpx.MockTransport(lambda request: httpx.Response(status, content=content)))) as client:
                        client.post("https://api.deepseek.com/chat/completions", json={})
                events = records.events()
                self.assertEqual([event["kind"] for event in events], ["provider_request", "provider_response"])
                payload = events[-1]["payload"]
                self.assertEqual(payload["status_code"], status)
                self.assertIs(payload["response_obtained"], True)
                self.assertEqual(payload["capture_form"], "digest_only")
                self.assertEqual(payload["original_bytes_length"], len(content))
                self.assertNotIn("body", payload)
                self.assertEqual(budget.closed_receipt()["reserved_requests"], 1)
                for path in (self.home / name / "output").glob("*.json"):
                    self.assertNotIn("private-marker", path.read_text())

    def test_legacy_nonfinite_path_keeps_original_failure_semantics(self):
        budget, records = self.create(mixed=False)
        with self.assertRaises(EvaluationBudgetAbort), budget.batch(), records.stage(0, "verification"):
            with httpx.Client(transport=EvaluationTransport(budget, records=records,
                    synthetic_transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'{"x":NaN}')))) as client:
                client.post("https://api.deepseek.com/chat/completions", json={})
        events = records.events()
        self.assertEqual(events[-1]["kind"], "provider_failure")
        self.assertIs(events[-1]["payload"]["response_obtained"], False)

    def test_response_state_is_per_integer_sequence(self):
        for index, sequence in enumerate((True, 1.0, 0, 281)):
            with self.subTest(sequence=sequence):
                budget, records = self.create(name=str(index))
                with self.assertRaises(EvaluationBudgetAbort), records.stage(0, "verification"):
                    records.capture_failure(sequence, "unknown_transport_error")
                budget.close()
        budget, records = self.create(name="valid")
        with records.stage(0, "verification"):
            records.capture_response(1, httpx.Response(200, json={}))
            records.capture_failure(1, "unknown_transport_error")
            records.capture_failure(2, "read_timeout")
        self.assertIs(records.events()[-2]["payload"]["response_obtained"], True)
        self.assertIs(records.events()[-1]["payload"]["response_obtained"], False)
        budget.close()

    def test_publication_fault_does_not_attempt_a_second_terminal_write(self):
        budget, records = self.create()
        calls = []
        real_open = os.open

        def fault(path, *args, **kwargs):
            if str(path) == "event-000001.json":
                calls.append(path)
                raise OSError("private-error-marker")
            return real_open(path, *args, **kwargs)

        with patch.object(os, "open", side_effect=fault), records.stage(0, "verification"):
            with self.assertRaises(EvaluationBudgetAbort):
                records.capture_response(1, httpx.Response(503, content=b'{"x":NaN}'))
        self.assertEqual(len(calls), 1)
        self.assertEqual(records.events(), ())
        self.assertTrue(budget.closed_receipt()["closed"])


class MixedAdmissionTest(unittest.TestCase):
    def test_any_changed_closed_pair_rejects_before_budget_or_credential(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_full140_v4_deadline import Full140V4Deadline
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            root = Path(temporary).resolve()
            root.chmod(0o700)
            control = Full140V4Deadline(receipt=root / "deadline.json", clock=lambda: 0, exit_worker=lambda _: None)
            fixed = {"output_directory": root, "run_id": uuid4(), "deadline": datetime.now(timezone.utc) + timedelta(hours=24),
                "repo_root": root, "source_hashes": {}, "frozen_gold": {},
                "credential_loader": lambda: self.fail("不得读取凭据"), "audit_case": lambda _: self.fail("不得审核"),
                "provider_profile": "deepseek-phase-split-v1", "execution_plan": MIXED_PLAN,
                "case_set": "full140", "case_positions": None, "request_limit": 280, "request_timeout_seconds": 300,
                "max_retries": 0, "extraction_mode": "grounded-v4", "reference_version": "source-fidelity-v2",
                "verification_mode": "nullable-proof-v1", "verification_tool_choice": "forced", "full140_v4_deadline": control}
            for changed in ({"execution_plan": "full140-grounded-v4-source-v2"}, {"provider_profile": "deepseek-flash-max"},
                            {"verification_tool_choice": "omitted"}, {"request_limit": 280.0}, {"request_limit": True},
                            {"case_positions": tuple(range(140))}, {"case_set": "reference21"},
                            {"reference_version": "legacy-v1"}, {"extraction_mode": "grounded-v3"},
                            {"max_retries": False}, {"request_timeout_seconds": 300.0}):
                with self.subTest(changed=changed), patch.object(EvaluationBudget, "create", side_effect=AssertionError("不得领取")):
                    with self.assertRaises(EvaluationBudgetAbort):
                        run_ecnu_evaluation(**{**fixed, **changed})
