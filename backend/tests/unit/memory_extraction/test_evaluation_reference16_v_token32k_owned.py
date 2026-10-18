"""V32K自有进程及领取身份不得借用v6或隐含全局token。"""

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
from tests.unit.memory_extraction.test_evaluation_reference16_v_token32k_records import (
    v_token32k_registration, PLAN, KIND, POLICY, PLAN_SOURCE,
)


class Reference16VToken32kOwnedTest(unittest.TestCase):
    launch = process_fixture.OwnedPublicProcessTest.launch

    def test_worker_receipt_binds_v7_plan_and_original_denominators(self):
        for plan in (PLAN, "reference16-pro-retention-v-thinking-v1"):
            with self.subTest(plan=plan):
                result = self.launch(kind=KIND, windows=16, script_body=f'''
value={{"worker_pid":os.getpid(),"execution_plan":{plan!r},"receipt":{{"budget":{{
    "run_id":run_id,"closed":True,"request_limit":32,"reserved_requests":0}}}}}}
(directory/"result.json").write_text(json.dumps(value))
''')
                self.assertEqual(result["closed"], plan == PLAN)
                self.assertEqual(result["execution_plan"], PLAN)
                self.assertEqual((result["planned_windows"], result["required_claims"], result["optional_claims"]), (16, 18, 1))

    def test_claim_rejects_rehashed_phase_tokens_globals_and_source_drift(self):
        original, _ = v_token32k_registration()
        original["source_hashes"] = {PLAN_SOURCE: "a" * 64}
        changes = [{}, {"max_tokens": 32768}, {"max_tokens": None},
                   {"thinking": {"type": "enabled"}}, {"reasoning_effort": "max"},
                   {"request_contract_version": 6}, {"provider_profile": "deepseek-pro-reference16-v-thinking-v1"},
                   {"execution_plan": "reference16-pro-retention-v-thinking-v1"},
                   {"phase_request_version": "deepseek-reference16-v-thinking-v1"},
                   {"source_hashes": {}}, {"source_hashes": {PLAN_SOURCE: "b" * 64}}]
        for phase in ("extraction", "verification"):
            for value in (True, float(POLICY[phase]["max_tokens"]), 32768 if phase == "extraction" else 8192):
                changed = deepcopy(POLICY)
                changed[phase]["max_tokens"] = value
                changes.append({"phase_request_policy": changed})
        for change in changes:
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
