"""教学计划使用独立自有进程身份和原16窗有界预算。"""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_records import canonical_sha256
from notalone.memory_extraction.evaluation_owned_process import _verify_owned_public_claim
from tests.unit.memory_extraction import test_evaluation_owned_process as process_fixture
from tests.unit.memory_extraction.test_evaluation_reference16_teaching_contract import teaching_registration


class Reference16TeachingOwnedTest(unittest.TestCase):
    launch = process_fixture.OwnedPublicProcessTest.launch

    def test_teaching_worker_cannot_close_with_old_plan_receipt(self):
        for plan in ("reference16-pro-teaching-v1", "reference16-pro-v1"):
            with self.subTest(plan=plan):
                result = self.launch(kind="reference16-pro-teaching", windows=16, script_body=f'''
value={{"worker_pid":os.getpid(),"execution_plan":{plan!r},"receipt":{{"budget":{{
    "run_id":run_id,"closed":True,"request_limit":32,"reserved_requests":0}}}}}}
(directory/"result.json").write_text(json.dumps(value))
''')
                self.assertEqual(result["closed"], plan == "reference16-pro-teaching-v1")
                self.assertEqual((result["planned_windows"], result["required_claims"], result["optional_claims"]), (16, 18, 1))

    def test_claim_checks_teaching_profile_with_fresh_budget_digest(self):
        original, _ = teaching_registration()
        original["source_hashes"] = {}
        for change in ({}, {"extraction_prompt_profile": "default"}, {"extraction_prompt_profile": "reference-kind-teaching-v2"},
                       {"execution_plan": "reference16-pro-v1"}, {"verification_mode": "nullable-proof-v3"}):
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
                        **{key: original[key] for key in ("source_hashes", "extraction_window_contracts",
                            "verification_prompt_sha256", "verification_schema_sha256")}}
                    (output / "manifest.json").write_text(json.dumps({"frozen_config": config}))
                    with budget.batch():
                        if change:
                            with self.assertRaisesRegex(ValueError, "reference16-pro-teaching_claim_manifest_changed"):
                                _verify_owned_public_claim(frozen=frozen, helper=helper, kind="reference16-pro-teaching")
                        else:
                            _verify_owned_public_claim(frozen=frozen, helper=helper, kind="reference16-pro-teaching")
