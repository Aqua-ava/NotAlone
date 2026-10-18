"""15窗自有worker的封闭领取与收尾；仅合成临时预算及自有进程。"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timezone
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction import evaluation_owned_process as owned
from notalone.memory_extraction.evaluation_bounded_cases import BOUNDED_RUNTIME_INPUTS, BOUNDED_RUNTIME_PLAN
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget
from notalone.memory_extraction.evaluation_owned_deadline import BoundedRuntime15Deadline
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_trace.context import snapshot
from tests.unit.memory_extraction import test_evaluation_bounded_registration as registration
from tests.unit.memory_extraction import test_evaluation_owned_process as process_fixture


KIND = "bounded-runtime15"
FIXTURE = "backend/src/notalone/memory_extraction/evaluation_bounded_cases.py"
ROOT = Path(__file__).resolve().parents[4]


def json_only_digest(value):
    """公开helper的JSON-only边界；不会替调用者转换Window等dataclass。"""
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


class BoundedOwnedClaimTest(unittest.TestCase):
    @contextmanager
    def claim(self, *, pro=False, thinking=False):
        pro = pro or thinking
        with tempfile.TemporaryDirectory() as temporary, patch.object(Path, "home", return_value=Path(temporary).resolve()):
            directory = Path(temporary).resolve() / "output"
            directory.mkdir(mode=0o700)
            evaluation = directory / "evaluation"
            evaluation.mkdir(mode=0o700)
            config, plan, windows = registration.bounded_config(prompt_profile=(
                registration.BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE if thinking else registration.BOUNDED_DEPENDENCY_PROMPT_PROFILE))
            if pro:
                config.update(request_contract_version=5 if thinking else 3,
                              provider_profile="deepseek-pro-bounded-thinking-v1" if thinking else "deepseek-pro-bounded-task-v1",
                              request_model="deepseek-v4-pro", max_tokens=8192)
            if thinking:
                config["tool_choice"]["verification"]["mode"] = "omitted"
            source_hashes = {FIXTURE: hashlib.sha256((ROOT / FIXTURE).read_bytes()).hexdigest()}
            config["source_hashes"] = source_hashes
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=evaluation, request_limit=30,
                allowed_endpoints=(registration.ENDPOINT,), config_sha256=canonical_sha256(config))
            EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan, actual_windows=windows)
            frozen = {"run_id": budget.snapshot()["run_id"], "directory": str(directory), "source_hashes": source_hashes,
                "plan": list(plan), "plan_sha256": canonical_sha256(plan),
                "extraction_window_contracts": config["extraction_window_contracts"],
                "formal_task_bindings": config["formal_tasks"], "actual_windows": snapshot(windows),
                "selection": [{"case_id": row["id"], "gold_position": position}
                              for position, row in enumerate(BOUNDED_RUNTIME_INPUTS)],
                "reference_canonical_sha256": config["gold_sha256"],
                "bounded_inputs_sha256": config["bounded_inputs_sha256"],
                "runtime_rule_set_sha256": config["runtime_rule_set_sha256"]}
            if pro:
                frozen["fixed"] = {"provider_profile": config["provider_profile"], "request_model": "deepseek-v4-pro",
                                   "response_model": "deepseek-v4-pro", "request_contract_version": config["request_contract_version"], "max_tokens": 8192}
            frozen.setdefault("fixed", {})["extraction_prompt_profile"] = config["extraction_prompt_profile"]
            frozen = snapshot(frozen)
            helper = SimpleNamespace(private_directory=lambda path: None, digest=json_only_digest,
                                     read_private=lambda path: json.loads(path.read_bytes()))
            (directory / "owned-worker.json").write_text(json.dumps({
                "run_id": frozen["run_id"], "pid": os.getpid(), "process_group": os.getpid()}))
            with budget.batch(), patch.object(owned.os, "getpgrp", return_value=os.getpid()):
                yield frozen, helper, windows, budget

    def test_json_only_helper_still_accepts_fifteen_actual_window_bindings(self):
        with self.claim() as (frozen, helper, windows, budget):
            with self.assertRaises(TypeError):
                helper.digest(windows[0])
            self.assertEqual(helper.digest(snapshot(windows[0])), canonical_sha256(windows[0]))
            owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=windows)
            self.assertEqual(budget.snapshot()["reserved_requests"], 0)

    def test_pro_owned_claim_requires_matching_frozen_profile_and_output_limit(self):
        with self.claim(pro=True) as (frozen, helper, windows, budget):
            owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=windows)
            for key, value in (("provider_profile", "deepseek-bounded-task-v1"), ("max_tokens", 4096),
                               ("request_model", "deepseek-flash"), ("response_model", "deepseek-flash"),
                               ("request_contract_version", 2)):
                changed = deepcopy(frozen)
                changed["fixed"][key] = value
                with self.subTest(key=key), self.assertRaises(ValueError):
                    owned._verify_owned_public_claim(frozen=changed, helper=helper, kind=KIND, actual_windows=windows)
            self.assertEqual(budget.snapshot()["reserved_requests"], 0)

    def test_thinking_owned_claim_rejects_old_profile_and_version_even_with_same_model(self):
        with self.claim(thinking=True) as (frozen, helper, windows, budget):
            owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=windows)
            for key, value in (("provider_profile", "deepseek-pro-bounded-task-v1"), ("request_contract_version", 3),
                               ("request_contract_version", 4), ("max_tokens", True), ("response_model", "deepseek-flash")):
                changed = deepcopy(frozen)
                changed["fixed"][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    owned._verify_owned_public_claim(frozen=changed, helper=helper, kind=KIND, actual_windows=windows)
            self.assertEqual(budget.snapshot()["reserved_requests"], 0)

    def test_actual_full_window_objects_cannot_be_omitted_cropped_reordered_or_rebound(self):
        with self.claim() as (frozen, helper, windows, budget):
            changed = replace(windows[0], owner_id=uuid4())
            changed_offset = replace(windows[0], messages=(
                replace(windows[0].messages[0], occurred_at=windows[0].messages[0].occurred_at.astimezone(timezone.utc)),
                *windows[0].messages[1:]))
            changed_source = replace(windows[0], messages=(
                replace(windows[0].messages[0], source_snapshots=({"synthetic": "changed"},)),
                *windows[0].messages[1:]))
            for actual in (None, list(windows), windows[:-1], tuple(reversed(windows)),
                           (changed, *windows[1:]), (changed_offset, *windows[1:]), (changed_source, *windows[1:])):
                with self.subTest(actual=type(actual)), self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
                    owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=actual)
            self.assertEqual(budget.snapshot()["reserved_requests"], 0)

    def test_frozen_bindings_rules_source_and_full_window_hashes_cannot_drift(self):
        with self.claim() as (frozen, helper, windows, budget):
            changes = (
                {"formal_task_bindings": []}, {"actual_windows": []}, {"plan": []},
                {"plan_sha256": "0" * 64}, {"bounded_inputs_sha256": "0" * 64},
                {"runtime_rule_set_sha256": "0" * 64}, {"reference_canonical_sha256": "0" * 64},
                {"selection": [{"case_id": "foreign", "gold_position": 0}]},
                {"source_hashes": {FIXTURE: "0" * 64}}, {"extraction_window_contracts": []},
            )
            for change in changes:
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
                    owned._verify_owned_public_claim(frozen={**deepcopy(frozen), **change}, helper=helper,
                                                     kind=KIND, actual_windows=windows)
            self.assertEqual(budget.snapshot()["reserved_requests"], 0)

    def test_claim_requires_current_worker_session_and_exact_run_identity(self):
        with self.claim() as (frozen, helper, windows, budget):
            path = Path(frozen["directory"]) / "owned-worker.json"
            original = json.loads(path.read_bytes())
            for change in ({"pid": os.getpid() + 1}, {"pid": float(os.getpid())}, {"pid": True},
                           {"process_group": os.getpid() + 1}, {"process_group": float(os.getpid())},
                           {"run_id": str(uuid4())}, {"extra": None}):
                path.write_text(json.dumps({**original, **change}))
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
                    owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=windows)
            path.write_text(json.dumps(original))
            with patch.object(owned.os, "getpgrp", return_value=os.getpid() + 1), self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
                owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=windows)
            self.assertEqual(budget.snapshot()["reserved_requests"], 0)

    def test_started_or_closed_synthetic_budget_cannot_be_claimed_again(self):
        with self.claim() as (frozen, helper, windows, budget):
            with budget.attempt(httpx.Request("POST", registration.ENDPOINT)):
                pass
            with self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
                owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=windows)
            self.assertEqual(budget.snapshot()["reserved_requests"], 1)
            budget.close()
            with self.assertRaisesRegex(ValueError, "fresh_claim_required"):
                owned._verify_owned_public_claim(frozen=frozen, helper=helper, kind=KIND, actual_windows=windows)


class BoundedOwnedFinishTest(unittest.TestCase):
    def launch(self, **options):
        return process_fixture.OwnedPublicProcessTest.launch(self, kind=KIND, windows=15, **options)

    def test_both_finish_forms_require_exact_run_cap_pid_and_execution_plan(self):
        for form in ("normal", "deadline"):
            for change in ("valid", "run", "cap", "count", "pid", "float_pid", "plan", "missing_plan"):
                with self.subTest(form=form, change=change):
                    receipt = self.launch(script_body=f'''
value={{"run_id":run_id,"worker_pid":os.getpid(),"execution_plan":{BOUNDED_RUNTIME_PLAN!r},
       "closed":True,"request_limit":30,"reserved_requests":1}}
if {change!r}=="run":value["run_id"]="wrong"
if {change!r}=="cap":value["request_limit"]=42
if {change!r}=="count":value["reserved_requests"]=True
if {change!r}=="pid":value["worker_pid"]+=1
if {change!r}=="float_pid":value["worker_pid"]=float(value["worker_pid"])
if {change!r}=="plan":value["execution_plan"]="old-plan"
if {change!r}=="missing_plan":value.pop("execution_plan")
if {form!r}=="normal":
    value={{"worker_pid":value["worker_pid"],"execution_plan":value.get("execution_plan"),"receipt":{{"budget":value}}}}
    path=directory/"result.json"
else:path=directory/"deadline-receipt.json"
path.write_text(json.dumps(value))
''')
                    self.assertEqual(receipt["closed"], change == "valid")
                    self.assertEqual((receipt["planned_windows"], receipt["required_claims"]), (15, 15))
                    self.assertFalse(receipt["automatic_successor"])

    def test_event_overflow_is_all_unknown_and_never_truncated_into_unrun(self):
        for count in (2048, 2049):
            with self.subTest(count=count):
                receipt = self.launch(script_body=f'''
for i in range(1,{count + 1}):
    (directory/"evaluation"/f"event-{{i:06}}.json").write_text(json.dumps(
        {{"kind":"case_started","case_position":14}} if i=={count} else {{"kind":"synthetic"}}))
''')
                states = [item["status"] for item in receipt["case_statuses"]]
                self.assertEqual(states, ["unknown"] * 15 if count > 2048 else ["unrun"] * 14 + ["unknown"])
                self.assertFalse(receipt["automatic_successor"])
                self.assertFalse(receipt["quality_certified"])

    def test_absolute_end_is_not_extended_and_owned_descendants_are_reaped(self):
        receipt = self.launch(remaining_seconds=10.1, script_body='''
if os.fork()==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    (directory/"descendant-ready").write_text("ready")
    time.sleep(30)
    os._exit(0)
while not (directory/"descendant-ready").exists():time.sleep(.01)
time.sleep(30)
''')
        self.assertTrue(receipt["outer_timed_out"])
        self.assertTrue(receipt["close_unknown"])
        self.assertLess(receipt["elapsed_seconds"], 3)
        self.assertFalse(receipt["automatic_successor"])


class BoundedOwnedDeadlineReceiptTest(unittest.TestCase):
    def test_deadline_publishes_its_exact_execution_plan_after_closing(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(Path, "home", return_value=Path(temporary).resolve()):
            directory = Path(temporary).resolve() / "output"
            directory.mkdir(mode=0o700)
            budget = EvaluationBudget.create(run_id=uuid4(), output_directory=directory, request_limit=30,
                allowed_endpoints=(registration.ENDPOINT,), config_sha256="a" * 64)
            run_id = budget.snapshot()["run_id"]
            ticks, exits = [0.0], []
            control = BoundedRuntime15Deadline(receipt=directory / "deadline.json", clock=lambda: ticks[0], exit_worker=exits.append)
            try:
                with budget.batch():
                    control.start(budget, synthetic=True)
                    with control.invocation():
                        ticks[0] = 601.0
                        control.checkpoint()
                receipt = json.loads((directory / "deadline.json").read_bytes())
                self.assertEqual(receipt["execution_plan"], BOUNDED_RUNTIME_PLAN)
                self.assertEqual(receipt["run_id"], run_id)
                self.assertEqual(receipt["worker_pid"], os.getpid())
                self.assertEqual(receipt["request_limit"], 30)
                self.assertEqual(receipt["reserved_requests"], 0)
                self.assertIs(receipt["closed"], True)
                self.assertEqual(exits, [124])
                self.assertTrue(budget.closed_receipt()["closed"])
            finally:
                control.finish()


if __name__ == "__main__":
    unittest.main()
