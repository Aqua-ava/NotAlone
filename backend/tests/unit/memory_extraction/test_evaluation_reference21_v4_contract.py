"""新原21固定身份的准入负控；不领取实际预算或访问真实凭据。"""
from datetime import datetime, timezone
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort


class Reference21V4AdmissionTest(unittest.TestCase):
    def test_uniqueness_profile_plan_and_scope_mismatches_reject_before_budget_or_key(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_provider_contract import UNIQUENESS_PLAN, SEMANTIC4_PLAN
        from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            control = Reference21V4Deadline(receipt=root / "receipt.json", clock=lambda: 0, exit_worker=lambda _: None)
            def forbidden(*args, **kwargs):
                self.fail("错配新合同不得领取预算或读key")
            fixed = dict(output_directory=root, run_id=uuid4(), deadline=datetime(2030, 1, 1, tzinfo=timezone.utc),
                repo_root=root, source_hashes={}, frozen_gold={}, credential_loader=forbidden, audit_case=forbidden,
                provider_profile="deepseek-phase-split-v1", execution_plan=UNIQUENESS_PLAN, case_set="reference21",
                case_positions=None, request_limit=42, request_timeout_seconds=300, max_retries=0,
                extraction_mode="grounded-v4", extraction_prompt_profile="reference-uniqueness-v1",
                reference_version="source-fidelity-v2", verification_mode="legacy-v4",
                verification_tool_choice="forced", reference21_v4_deadline=control)
            for change in ({"extraction_prompt_profile": "default"}, {"extraction_prompt_profile": None},
                           {"extraction_prompt_profile": False}, {"extraction_prompt_profile": "reference-uniqueness-v2"},
                           {"execution_plan": SEMANTIC4_PLAN}, {"verification_mode": "nullable-proof-v1"},
                           {"verification_mode": "nullable-proof-v2"}, {"request_limit": 43}, {"request_limit": 42.0},
                           {"case_positions": (0,)}, {"case_set": "full140"}, {"max_retries": 1},
                           {"provider_profile": "deepseek-flash-max"}, {"extraction_mode": "grounded-v3"},
                           {"reference_version": "legacy-v1"}, {"verification_tool_choice": "omitted"}):
                with self.subTest(change=change), patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                        self.assertRaises(EvaluationBudgetAbort):
                    run_ecnu_evaluation(**{**fixed, **change})

    def test_semantic4_rejects_mode_scope_and_provider_mismatch_before_budget_or_key(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_provider_contract import SEMANTIC4_PLAN
        from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            control = Reference21V4Deadline(receipt=root / "receipt.json", clock=lambda: 0, exit_worker=lambda _: None)
            def forbidden(*args, **kwargs):
                self.fail("错误semantic4合同不得领取预算、读key或审核")
            fixed = dict(output_directory=root, run_id=uuid4(), deadline=datetime(2030, 1, 1, tzinfo=timezone.utc),
                repo_root=root, source_hashes={}, frozen_gold={}, credential_loader=forbidden, audit_case=forbidden,
                provider_profile="deepseek-phase-split-v1", execution_plan=SEMANTIC4_PLAN, case_set="reference21",
                case_positions=None, request_limit=42, request_timeout_seconds=300, max_retries=0,
                extraction_mode="grounded-v4", reference_version="source-fidelity-v2", verification_mode="legacy-v4",
                verification_tool_choice="forced", reference21_v4_deadline=control)
            for change in ({"verification_mode": "nullable-proof-v1"}, {"verification_mode": "nullable-proof-v2"},
                           {"execution_plan": "reference21-grounded-v4-source-v2-v-off-forced"},
                           {"request_limit": 42.0}, {"request_limit": 43}, {"request_limit": True},
                           {"case_positions": (0,)}, {"case_set": "full140"}, {"max_retries": 1},
                           {"provider_profile": "deepseek-flash-max"}, {"provider_profile": "ecnu"},
                           {"verification_tool_choice": "omitted"}, {"reference_version": "legacy-v1"},
                           {"extraction_mode": "grounded-v3"}, {"reference21_v4_deadline": None}):
                with self.subTest(change=change), patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                        self.assertRaises(EvaluationBudgetAbort):
                    run_ecnu_evaluation(**{**fixed, **change})

    def test_changed_scope_or_type_rejects_before_budget_credentials_or_audit(self):
        from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
        from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            root.chmod(0o700)
            control = Reference21V4Deadline(receipt=root / "receipt.json", clock=lambda: 0, exit_worker=lambda _: None)
            def forbidden(*args, **kwargs):
                self.fail("错误固定身份不得领取预算、读凭据或审核")
            fixed = {"output_directory": root, "run_id": uuid4(), "deadline": datetime(2030, 1, 1, tzinfo=timezone.utc),
                "repo_root": root, "source_hashes": {}, "frozen_gold": {}, "credential_loader": forbidden, "audit_case": forbidden,
                "provider_profile": "deepseek-phase-split-v1", "execution_plan": "reference21-grounded-v4-source-v2-v-off-forced",
                "case_set": "reference21", "case_positions": None, "request_limit": 42, "request_timeout_seconds": 300,
                "max_retries": 0, "extraction_mode": "grounded-v4", "reference_version": "source-fidelity-v2",
                "verification_mode": "nullable-proof-v1", "verification_tool_choice": "forced", "reference21_v4_deadline": control}
            for change in ({"execution_plan": []}, {"execution_plan": "original"},
                           {"execution_plan": "full140-grounded-v4-source-v2-v-off-forced"},
                           {"provider_profile": "deepseek-flash-max"}, {"provider_profile": "ecnu"},
                           {"case_set": "full140"}, {"case_positions": tuple(range(21))}, {"case_positions": (0,)},
                           {"request_limit": 280}, {"request_limit": 32}, {"request_limit": 41}, {"request_limit": 43},
                           {"request_limit": 42.0}, {"request_limit": True}, {"request_timeout_seconds": 300.0},
                           {"max_retries": 1}, {"max_retries": False}, {"extraction_mode": "grounded-v3"},
                           {"reference_version": "legacy-v1"}, {"verification_mode": "legacy-v4"},
                           {"verification_mode": "nullable-proof-v2"},
                           {"verification_tool_choice": "omitted"}, {"reference21_v4_deadline": object()},
                           {"reference21_v4_deadline": None}, {"full140_v4_deadline": control}):
                with self.subTest(change=change), patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                        self.assertRaises(EvaluationBudgetAbort):
                    run_ecnu_evaluation(**{**fixed, **change})

    def test_phased_requires_the_registered_public_reference_and_exact_bundle_identity(self):
        from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
        from notalone.memory_extraction.evaluation_provider_contract import (
            REFERENCE21_V4_PLAN, MIXED_PLAN, MIXED_REQUEST_VERSION, mixed_phase_policy,
        )
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.evaluation_reference import PUBLIC_REFERENCE_V2_PATH

        reference = json.loads((Path(__file__).resolve().parents[4] / PUBLIC_REFERENCE_V2_PATH).read_bytes())
        def forbidden(*args):
            self.fail("身份不符不得看到RAW或FULL")
        parameters = dict(reference=reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=reference["annotation_sha256"], criteria_sha256="a" * 64,
            raw_reviewer=forbidden, full_reviewer=forbidden, execution_plan=REFERENCE21_V4_PLAN,
            extraction_mode="grounded-v4", reference_version="source-fidelity-v2", case_set="reference21",
            verification_mode="nullable-proof-v1", extraction_tool_choice="omitted", verification_tool_choice="forced")
        audit = PhasedEvaluationAudit(**parameters)
        self.assertEqual(audit.case_positions, tuple(range(21)))
        for change in ({"case_set": "full140"}, {"case_positions": tuple(range(21))},
                       {"execution_plan": MIXED_PLAN}, {"execution_plan": "original"},
                       {"verification_tool_choice": "omitted"}, {"reference_version": "legacy-v1"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                PhasedEvaluationAudit(**{**parameters, **change})
        bundle = dict(execution_plan=REFERENCE21_V4_PLAN, phase_request_version=MIXED_REQUEST_VERSION,
                      phase_request_policy=mixed_phase_policy(), reference_version="source-fidelity-v2", extraction_mode="grounded-v4")
        for change in ({"execution_plan": MIXED_PLAN}, {"phase_request_policy": {}},
                       {"reference_version": "legacy-v1"}, {"extraction_mode": "grounded-v3"}):
            with self.subTest(change=change), self.assertRaises(EvaluationBudgetAbort):
                audit({**bundle, **change})


class Reference21V4RecordsTest(unittest.TestCase):
    def test_uniqueness_records_bind_both_profiles_and_actual_new_prompt_hashes(self):
        from notalone.memory_extraction.evaluation_provider_contract import (
            UNIQUENESS_PLAN, UNIQUENESS_MODE, UNIQUENESS_STAGE, SEMANTIC4_PLAN, SEMANTIC4_PROMPT_PROFILE,
        )
        from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
        from notalone.memory_extraction.grounded_adapter import grounded_v4_prompt

        for fault in ("valid", "missing", "default", "old_plan", "old_prompt_hash", "wrong_v"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary, \
                    patch.object(Path, "home", return_value=Path(temporary)):
                config, plan = self.config_plan()
                config.update(execution_plan=UNIQUENESS_PLAN, mode=UNIQUENESS_MODE, stage=UNIQUENESS_STAGE,
                    verification_mode="legacy-v4", verification_prompt_profile=SEMANTIC4_PROMPT_PROFILE,
                    extraction_prompt_profile="reference-uniqueness-v1")
                if fault != "old_prompt_hash":
                    for item in config["extraction_window_contracts"]:
                        item["prompt_sha256"] = canonical_sha256(grounded_v4_prompt("reference-uniqueness-v1"))
                if fault == "missing":
                    config.pop("extraction_prompt_profile")
                elif fault == "default":
                    config["extraction_prompt_profile"] = "default"
                elif fault == "old_plan":
                    config["execution_plan"] = SEMANTIC4_PLAN
                elif fault == "wrong_v":
                    config["verification_mode"] = "nullable-proof-v1"
                output = Path(temporary) / "output"
                output.mkdir(mode=0o700)
                budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=42,
                    allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256=canonical_sha256(config))
                try:
                    if fault == "valid":
                        store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                        self.assertEqual(store.extraction_prompt_profile, "reference-uniqueness-v1")
                    else:
                        with self.assertRaises(EvaluationBudgetAbort):
                            EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                finally:
                    budget.close()

    def test_semantic4_records_bind_legacy_and_explicit_prompt_without_relaxing_old_identity(self):
        from notalone.memory_extraction.evaluation_provider_contract import (
            SEMANTIC4_PLAN, SEMANTIC4_MODE, SEMANTIC4_STAGE, SEMANTIC4_PROMPT_PROFILE, REFERENCE21_V4_PLAN,
        )
        from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256

        for fault in ("valid", "proof_mode", "old_plan", "wrong_prompt", "missing_prompt", "old_stage"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary, \
                    patch.object(Path, "home", return_value=Path(temporary)):
                config, plan = self.config_plan()
                config.update(execution_plan=SEMANTIC4_PLAN, mode=SEMANTIC4_MODE, stage=SEMANTIC4_STAGE,
                              verification_mode="legacy-v4", verification_prompt_profile=SEMANTIC4_PROMPT_PROFILE)
                if fault == "proof_mode":
                    config["verification_mode"] = "nullable-proof-v1"
                elif fault == "old_plan":
                    config["execution_plan"] = REFERENCE21_V4_PLAN
                elif fault == "wrong_prompt":
                    config["verification_prompt_profile"] = "default"
                elif fault == "missing_prompt":
                    config.pop("verification_prompt_profile")
                elif fault == "old_stage":
                    config["stage"] = "reference21-v4-source-v2-v-off-forced"
                output = Path(temporary) / "output"
                output.mkdir(mode=0o700)
                budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=42,
                    allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256=canonical_sha256(config))
                try:
                    if fault == "valid":
                        self.assertEqual(EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan).execution_plan, SEMANTIC4_PLAN)
                    else:
                        with self.assertRaises(EvaluationBudgetAbort):
                            EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                finally:
                    budget.close()

    def config_plan(self):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        from notalone.memory_extraction.evaluation_reference import _fixed_case_sets, public_window_projection
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.evaluation_provider_contract import (
            REFERENCE21_V4_PLAN, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE, MIXED_REQUEST_VERSION, mixed_phase_policy,
        )
        windows = tuple(build_window(case) for case in _fixed_case_sets()[0])
        plan = tuple({"case_position": index, "case_name": case.name,
                      "input_sha256": canonical_sha256(public_window_projection(window))}
                     for index, (case, window) in enumerate(zip(_fixed_case_sets()[0], windows)))
        config = dict(mode=REFERENCE21_V4_MODE, stage=REFERENCE21_V4_STAGE, execution_plan=REFERENCE21_V4_PLAN,
            reference_version="source-fidelity-v2", extraction_mode="grounded-v4", verification_mode="nullable-proof-v1",
            phase_request_version=MIXED_REQUEST_VERSION, phase_request_policy=mixed_phase_policy(),
            base_url="https://api.deepseek.com", endpoint="https://api.deepseek.com/chat/completions", request_model="deepseek-flash",
            timeout=300.0, max_retries=0, request_contract_version=2, selected_case_positions=list(range(21)),
            tool_choice={"extraction": {"mode": "omitted", "name": "GroundedMemoryLabelsV4"},
                         "verification": {"mode": "forced", "name": "SourceVerificationOutput"}}, plan_sha256=canonical_sha256(plan),
            extraction_window_contracts=[dict(input_sha256=item["input_sha256"], prompt_sha256=canonical_sha256(prompt),
                                              schema_sha256=canonical_sha256(schema))
                for item, (prompt, schema) in zip(plan, (extraction_contract("grounded-v4", window) for window in windows))])
        return config, plan

    def test_records_reject_cross_plan_scope_cap_and_boolean_or_float_positions(self):
        from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
        config, plan = self.config_plan()
        for fault in ("valid", "plan", "stage", "positions", "input", "cap", False, 0.0, True, 1.0):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary, \
                    patch.object(Path, "home", return_value=Path(temporary)):
                current, rows, cap = deepcopy(config), deepcopy(plan), 42
                if type(fault) is not str:
                    rows[int(fault)]["case_position"] = fault
                elif fault == "plan":
                    current["execution_plan"] = "full140-grounded-v4-source-v2-v-off-forced"
                elif fault == "stage":
                    current["stage"] = "full140-v4-source-v2-v-off-forced"
                elif fault == "positions":
                    current["selected_case_positions"][0] = False
                elif fault == "input":
                    rows[0]["input_sha256"] = current["extraction_window_contracts"][0]["input_sha256"] = "f" * 64
                elif fault == "cap":
                    cap = 280
                current["plan_sha256"] = canonical_sha256(rows)
                output = Path(temporary) / "output"
                output.mkdir(mode=0o700)
                budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=cap,
                    allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256=canonical_sha256(current))
                try:
                    if fault == "valid":
                        self.assertEqual(EvaluationRecordStore(budget=budget, frozen_config=current, plan=rows).reference_version,
                                         "source-fidelity-v2")
                    else:
                        with self.assertRaises(EvaluationBudgetAbort):
                            EvaluationRecordStore(budget=budget, frozen_config=current, plan=rows)
                finally:
                    budget.close()

    def test_new_identity_keeps_response_observation_and_strict42_sequence_bound(self):
        from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
        for name, body in (("arguments", {"arguments": "{"}), ("nan", {"usage": float("nan")}),
                           ("surrogate", {"content": "\ud800"}), ("sequence_bool", True),
                           ("sequence_float", 1.0), ("sequence_zero", 0), ("sequence43", 43)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary, \
                    patch.object(Path, "home", return_value=Path(temporary)):
                config, plan = self.config_plan()
                output = Path(temporary) / "output"
                output.mkdir(mode=0o700)
                budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=42,
                    allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256=canonical_sha256(config))
                store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                try:
                    with store.stage(0, "verification"):
                        if name.startswith("sequence"):
                            with self.assertRaises(EvaluationBudgetAbort):
                                store.capture_failure(body, "read_timeout")
                        else:
                            with self.assertRaises(EvaluationBudgetAbort):
                                store.capture_response(1, httpx.Response(503, content=json.dumps(body).encode()))
                            payload = store.events()[0]["payload"]
                            self.assertEqual((payload["status_code"], payload["response_obtained"], payload["capture_form"]),
                                             (503, True, "digest_only"))
                            self.assertNotIn("body", payload)
                finally:
                    budget.close()
