"""新E2完整身份的精确合同负控；旧E4合同保持封闭。"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_provider_contract import (
    FULL140_E2_PLAN, FULL140_E2_MODE, FULL140_E2_STAGE, MIXED_PLAN,
    MIXED_REQUEST_VERSION, mixed_phase_policy, _validate_payload, EvaluationProviderProfile,
    STRICT_RESPONSE_IDENTITY_POLICY,
)
from notalone.memory_extraction.evaluation_extraction import EvaluationExtractionMode
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from tests.unit.memory_extraction import test_evaluation_provider_contract as provider_tests
from tests.unit.memory_extraction import test_evaluation_owned_process as owned_tests


def config_plan():
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_ecnu import _FULL_CASES
    from notalone.memory_extraction.evaluation_offline import _frozen_config
    from notalone.memory_extraction.evaluation_reference import public_window_projection
    windows = tuple(build_window(case) for case in _FULL_CASES)
    plan = tuple({"case_position": i, "case_name": case.name,
                  "input_sha256": canonical_sha256(public_window_projection(window))}
                 for i, (case, window) in enumerate(zip(_FULL_CASES, windows)))
    config = _frozen_config(plan, windows=windows, extraction_mode="grounded-v2", verification_mode="legacy-v4",
                           max_retries=0, request_timeout_seconds=300.0)
    config.pop("thinking")
    config.update(mode=FULL140_E2_MODE, stage=FULL140_E2_STAGE, execution_plan=FULL140_E2_PLAN,
        reference_version="source-fidelity-v2", base_url="https://api.deepseek.com",
        endpoint="https://api.deepseek.com/chat/completions", request_model="deepseek-flash",
        request_contract_version=2, selected_case_positions=list(range(140)),
        response_identity_policy=STRICT_RESPONSE_IDENTITY_POLICY, fallback=False,
        phase_request_version=MIXED_REQUEST_VERSION, phase_request_policy=mixed_phase_policy(),
        tool_choice={"extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                     "verification": {"mode": "forced", "name": "SourceVerificationOutput"}})
    return config, plan


class Full140E2ContractTest(unittest.TestCase):
    setUp = provider_tests.EvaluationProviderContractTest.setUp
    _contract = provider_tests.EvaluationProviderContractTest._contract

    def test_e2_only_binds_new_identity_and_final_phase_body(self):
        self._contract(provider_profile="deepseek-phase-split-v1", execution_plan=FULL140_E2_PLAN,
                       extraction_mode="grounded-v2")
        for plan, mode in ((MIXED_PLAN, "grounded-v2"), (FULL140_E2_PLAN, "grounded-v4"),
                           ("original", "grounded-v2")):
            with self.subTest(plan=plan, mode=mode), self.assertRaises(EvaluationBudgetAbort):
                self._contract(provider_profile="deepseek-phase-split-v1", execution_plan=plan, extraction_mode=mode)
        for phase in ("extraction", "verification"):
            body = provider_tests._payload()
            name = "GroundedMemoryLabels" if phase == "extraction" else "SourceVerificationOutput"
            body.update(model="deepseek-flash", thinking={"type": "enabled" if phase == "extraction" else "disabled"},
                        reasoning_effort="max" if phase == "extraction" else "none")
            body["tools"][0]["function"]["name"] = name
            if phase == "extraction":
                body.pop("tool_choice")
            else:
                body["tool_choice"]["function"]["name"] = name
            options = {"provider_profile": EvaluationProviderProfile.DEEPSEEK_PHASE_SPLIT,
                       "extraction_mode": EvaluationExtractionMode.GROUNDED_V2}
            _validate_payload(body, **options)
            contract = self._contract(provider_profile="deepseek-phase-split-v1", execution_plan=FULL140_E2_PLAN,
                                      extraction_mode="grounded-v2")
            with contract.expect_request(body):
                endpoint = "https://api.deepseek.com/chat/completions"
                contract.check_request(httpx.Request("POST", endpoint, json=body))
                changed_body = deepcopy(body)
                changed_body["messages"][0]["content"] += "合成漂移"
                with self.assertRaises(EvaluationBudgetAbort):
                    contract.check_request(httpx.Request("POST", endpoint, json=changed_body))
            for changed in ("thinking", "reasoning_effort", "tool_choice", "model"):
                broken = deepcopy(body)
                broken[changed] = {"type": "enabled" if phase == "verification" else "disabled"} if changed == "thinking" else "other"
                with self.subTest(phase=phase, changed=changed), self.assertRaises(EvaluationBudgetAbort):
                    _validate_payload(broken, **options)


class Full140E2RecordsTest(unittest.TestCase):
    def test_records_reject_mutation_even_with_fresh_budget_hash(self):
        original, plan = config_plan()
        changes = ({}, {"execution_plan": MIXED_PLAN}, {"extraction_mode": "grounded-v4"},
            {"verification_mode": "nullable-proof-v1"}, {"mode": "deepseek_bounded_full140_v4_source_v2_v_off_forced"},
            {"stage": "full140-v4-source-v2-v-off-forced"}, {"reference_version": "legacy-v1"},
            {"verification_prompt_sha256": "0" * 64}, {"verification_schema_sha256": "0" * 64},
            {"extraction_prompt_sha256": "0" * 64}, {"extraction_schema_sha256": "0" * 64},
            {"temperature": True}, {"stream": True}, {"fallback": True}, {"timeout": 300},
            {"response_identity_policy": "ecnu_configured_route_known_labels_v1"},
            {"extraction_prompt_profile": "default"}, {"verification_prompt_profile": "default"},
            {"phase_request_policy": {}}, {"max_retries": False}, {"selected_case_positions": list(range(139))},
            {"extraction_window_contracts": [{**row, "schema_sha256": "0" * 64} for row in original["extraction_window_contracts"]]})
        for changed in changes:
            config = {**deepcopy(original), **changed}
            with self.subTest(changed=tuple(changed)), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                output = home / "output"
                output.mkdir(mode=0o700)
                with patch.object(Path, "home", return_value=home), patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
                    budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=280,
                        allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256=canonical_sha256(config))
                    try:
                        if changed:
                            with self.assertRaises(EvaluationBudgetAbort):
                                EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                        else:
                            store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                            self.assertEqual(store.execution_plan, FULL140_E2_PLAN)
                            self.assertEqual(store.reference_version, "source-fidelity-v2")
                    finally:
                        budget.close()


class Full140E2AdmissionTest(unittest.TestCase):
    def test_fixed_changes_fail_before_budget_or_credential(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_full140_v4_deadline import Full140V4Deadline
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            root = Path(temporary).resolve()
            control = Full140V4Deadline(receipt=root / "deadline.json", clock=lambda: 0, exit_worker=lambda _: None)
            fixed = {"output_directory": root, "run_id": uuid4(), "deadline": datetime.now(timezone.utc) + timedelta(hours=24),
                "repo_root": root, "source_hashes": {}, "frozen_gold": {}, "credential_loader": lambda: self.fail("不得读凭据"),
                "audit_case": lambda _: self.fail("不得审核"), "provider_profile": "deepseek-phase-split-v1",
                "execution_plan": FULL140_E2_PLAN, "case_set": "full140", "case_positions": None,
                "request_limit": 280, "request_timeout_seconds": 300, "max_retries": 0, "extraction_mode": "grounded-v2",
                "reference_version": "source-fidelity-v2", "verification_mode": "legacy-v4",
                "verification_tool_choice": "forced", "full140_v4_deadline": control}
            for changed in ({"execution_plan": MIXED_PLAN}, {"provider_profile": "deepseek-flash-max"},
                    {"extraction_mode": "grounded-v4"}, {"verification_mode": "nullable-proof-v1"},
                    {"verification_tool_choice": "omitted"}, {"reference_version": "legacy-v1"},
                    {"request_limit": 281}, {"request_limit": 280.0}, {"request_limit": True},
                    {"request_timeout_seconds": 300.0}, {"max_retries": False}, {"max_retries": 1},
                    {"case_positions": tuple(range(140))}, {"case_set": "reference21"},
                    {"full140_v4_deadline": None}, {"extraction_prompt_profile": "reference-uniqueness-v1"}):
                with self.subTest(changed=changed), patch.object(EvaluationBudget, "create", side_effect=AssertionError("不得领取")):
                    with self.assertRaises(EvaluationBudgetAbort):
                        run_ecnu_evaluation(**{**fixed, **changed})


class Full140E2OwnedTest(unittest.TestCase):
    launch = owned_tests.OwnedPublicProcessTest.launch

    def test_owned_receipts_require_new_plan_integer_pid_and_closed280(self):
        from notalone.memory_extraction.evaluation_provider_contract import FULL140_E2_KIND
        for form, change in (("normal", "valid"), ("deadline", "valid"), ("normal", "old_plan"),
                             ("normal", "pid"), ("deadline", "cap"), ("deadline", "count")):
            with self.subTest(form=form, change=change):
                receipt = self.launch(kind=FULL140_E2_KIND, windows=140, script_body=f'''
pid=float(os.getpid()) if {change!r}=="pid" else os.getpid()
value={{"run_id":run_id,"worker_pid":pid,"closed":True,"request_limit":280,"reserved_requests":1}}
if {change!r}=="cap":value["request_limit"]=281
if {change!r}=="count":value["reserved_requests"]=True
if {form!r}=="normal":
    value={{"worker_pid":pid,"execution_plan":{MIXED_PLAN!r} if {change!r}=="old_plan" else {FULL140_E2_PLAN!r},"receipt":{{"budget":value}}}}
    path=directory/"result.json"
else:path=directory/"deadline-receipt.json"
path.write_text(json.dumps(value))
''')
                self.assertEqual(receipt["closed"], change == "valid")
                self.assertEqual(receipt["planned_windows"], 140)
