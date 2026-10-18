"""独立V思考owned身份与旧档不可交叉借用。"""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_owned_process import _verify_owned_public_claim
from notalone.memory_extraction.evaluation_records import canonical_sha256
from tests.unit.memory_extraction import test_evaluation_owned_process as process_fixture
from tests.unit.memory_extraction.test_evaluation_reference16_v_thinking_records import (
    v_thinking_registration, PLAN, KIND, POLICY,
)


class Reference16VThinkingOwnedTest(unittest.TestCase):
    launch = process_fixture.OwnedPublicProcessTest.launch

    def test_worker_close_requires_new_plan_and_keeps_original_denominators(self):
        for plan in (PLAN, "reference16-pro-retention-v1"):
            with self.subTest(plan=plan):
                result = self.launch(kind=KIND, windows=16, script_body=f'''
value={{"worker_pid":os.getpid(),"execution_plan":{plan!r},"receipt":{{"budget":{{
    "run_id":run_id,"closed":True,"request_limit":32,"reserved_requests":0}}}}}}
(directory/"result.json").write_text(json.dumps(value))
''')
                self.assertEqual(result["closed"], plan == PLAN)
                self.assertEqual(result["execution_plan"], PLAN)
                self.assertEqual((result["planned_windows"], result["required_claims"], result["optional_claims"]), (16, 18, 1))

    def test_main16_deadline_receipt_requires_owned_pid_and_exact_cap(self):
        for fault in ("valid", "wrong_pid", "wrong_cap"):
            with self.subTest(fault=fault):
                result = self.launch(kind=KIND, windows=16, script_body=f'''
value={{"run_id":run_id,"worker_pid":os.getpid(),"closed":True,
        "request_limit":32,"reserved_requests":0,"reason":"call_wall_deadline"}}
if {fault!r}=="wrong_pid":value["worker_pid"]+=1
if {fault!r}=="wrong_cap":value["request_limit"]=30
(directory/"deadline-receipt.json").write_text(json.dumps(value))
''')
                self.assertEqual(result["closed"], fault == "valid")
                self.assertTrue(result["worker_gone"])
                self.assertFalse(result["quality_certified"])

    def test_claim_rejects_rehashed_phase_profile_and_old_plan_substitution(self):
        original, _ = v_thinking_registration()
        original["source_hashes"] = {}
        bad_phase = deepcopy(POLICY)
        bad_phase["verification"]["tool_choice_mode"] = "forced"
        for change in ({}, {"provider_profile": "deepseek-pro-reference16-v1"},
                       {"execution_plan": "reference16-pro-retention-v1"}, {"request_contract_version": 4},
                       {"phase_request_version": "deepseek-reference16-v-thinking-v2"},
                       {"phase_request_policy": bad_phase}, {"phase_request_policy": {}},
                       {"reasoning_effort": "none"}, {"thinking": {"type": "disabled"}},
                       {"extraction_prompt_profile": "default"}, {"verification_prompt_profile": "default"},
                       {"verification_prompt_sha256": "0" * 64}, {"max_tokens": 8191}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                output = home / "output" / "evaluation"
                output.mkdir(parents=True, mode=0o700)
                config = {**original, **change}
                helper = SimpleNamespace(private_directory=lambda _: None, digest=canonical_sha256,
                    read_private=lambda path: json.loads(path.read_text()))
                with patch.object(Path, "home", return_value=home):
                    budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=32,
                        allowed_endpoints=(original["endpoint"],), config_sha256=canonical_sha256(config))
                    frozen = {"run_id": budget.snapshot()["run_id"], "directory": str(output.parent),
                        "fixed": {"prompt_profile": "reference-retention-v1"},
                        **{key: original[key] for key in ("source_hashes", "extraction_window_contracts",
                            "verification_prompt_sha256", "verification_schema_sha256")}}
                    (output / "manifest.json").write_text(json.dumps({"frozen_config": config}))
                    with budget.batch():
                        if change:
                            with self.assertRaisesRegex(ValueError, KIND + "_claim_manifest_changed"):
                                _verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND)
                        else:
                            _verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND)
