"""Pro16自有进程须核对精确计划、32次预算和16窗状态。"""
import unittest
from tests.unit.memory_extraction import test_evaluation_owned_process as owned_tests


class Reference16ProOwnedTest(unittest.TestCase):
    launch = owned_tests.OwnedPublicProcessTest.launch

    def test_owned_result_rejects_other_plan_and_preserves_original16_counts(self):
        for plan in ("reference16-pro-v1", "reference21-main16-v3"):
            with self.subTest(plan=plan):
                result = self.launch(kind="reference16-pro", windows=16, script_body=f'''
value={{"worker_pid":os.getpid(),"execution_plan":{plan!r},"receipt":{{"budget":{{
    "run_id":run_id,"closed":True,"request_limit":32,"reserved_requests":0}}}}}}
(directory/"result.json").write_text(json.dumps(value))
''')
                self.assertEqual(result["closed"], plan == "reference16-pro-v1")
                self.assertEqual(result["planned_windows"], 16)
                self.assertEqual(result["required_claims"], 18)
                self.assertEqual(len(result["case_statuses"]), 16)

    def test_claim_rejects_contract_drift_even_with_fresh_matching_budget_digest(self):
        import json
        from pathlib import Path
        import tempfile
        from types import SimpleNamespace
        from unittest.mock import patch
        from uuid import uuid4
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.memory_extraction.evaluation_owned_process import _verify_owned_public_claim
        original = dict(mode="deepseek_bounded_reference16_pro", stage="reference16-pro",
            execution_plan="reference16-pro-v1", reference_version="source-fidelity-v2",
            selected_case_positions=list(range(16)), provider_profile="deepseek-pro-reference16-v1",
            request_model="deepseek-v4-pro", request_contract_version=4, max_tokens=8192,
            thinking={"type": "disabled"}, reasoning_effort="none", extraction_mode="grounded-v2",
            verification_mode="legacy-v4", base_url="https://api.deepseek.com",
            endpoint="https://api.deepseek.com/chat/completions", timeout=300.0, max_retries=0,
            temperature=0.0, stream=False, fallback=False,
            response_identity_policy="first_valid_completion_observation_stop_on_change",
            verification_prompt_sha256="a" * 64, verification_schema_sha256="b" * 64,
            tool_choice={"extraction": {"mode": "forced", "name": "GroundedMemoryLabels"},
                         "verification": {"mode": "forced", "name": "SourceVerificationOutput"}},
            source_hashes={}, extraction_window_contracts=[])
        for change in ({}, {"provider_profile": "deepseek-pro-bounded-task-v1"},
                       {"request_model": "deepseek-flash"}, {"request_contract_version": 3},
                       {"max_tokens": 4096}, {"thinking": {"type": "enabled"}},
                       {"reasoning_effort": "max"}, {"phase_request_policy": {}},
                       {"phase_request_version": 1}, {"selected_case_positions": list(range(15))},
                       {"verification_mode": "nullable-proof-v3"}, {"max_retries": 1}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                directory = home / "output"
                output = directory / "evaluation"
                output.mkdir(parents=True, mode=0o700)
                config = {**original, **change}
                helper = SimpleNamespace(private_directory=lambda _: None, digest=canonical_sha256,
                    read_private=lambda path: json.loads(path.read_text()))
                with patch.object(Path, "home", return_value=home):
                    budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output,
                        request_limit=32, allowed_endpoints=(original["endpoint"],), config_sha256=canonical_sha256(config))
                    frozen = {"run_id": budget.snapshot()["run_id"], "directory": str(directory),
                        **{key: original[key] for key in ("source_hashes", "extraction_window_contracts",
                            "verification_prompt_sha256", "verification_schema_sha256")}}
                    (output / "manifest.json").write_text(json.dumps({"frozen_config": config}))
                    with budget.batch():
                        if change:
                            with self.assertRaisesRegex(ValueError, "reference16-pro_claim_manifest_changed"):
                                _verify_owned_public_claim(frozen=frozen, helper=helper, kind="reference16-pro")
                        else:
                            _verify_owned_public_claim(frozen=frozen, helper=helper, kind="reference16-pro")
