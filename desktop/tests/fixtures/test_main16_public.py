"""固定v3指代主集准备与运行控制；禁止真实home、凭据及网络。"""
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import httpx

SPEC = importlib.util.spec_from_file_location("main16_public", Path(__file__).with_name("main16-public.py"))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class Main16PublicTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.stack.enter_context(patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"}))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        for owner, names in ((socket.socket, ("connect", "connect_ex")), (socket, ("getaddrinfo",))):
            for name in names:
                self.stack.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))
        original_open = os.open

        def private_open(name, *args, **kwargs):
            if Path(name) == runner.ROOT / ".env":
                raise AssertionError("禁止真实凭据")
            return original_open(name, *args, **kwargs)

        self.stack.enter_context(patch.object(os, "open", side_effect=private_open))

    def prepared(self):
        frozen = runner.prepare(directory=self.home / "run", absolute_start=datetime.now(timezone.utc))
        path = Path(frozen["directory"]) / "freeze.json"
        expected = runner.helpers().file_digest(path)
        approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
        return frozen, path, expected, approval

    def test_prepare_keeps_original_16_windows_and_current_kind_policy_without_home(self):
        with patch.object(Path, "home", side_effect=AssertionError("禁止home与registry")):
            frozen, _, _, _ = self.prepared()
        self.assertEqual(frozen["fixed"]["case_positions"], list(range(16)))
        self.assertEqual(frozen["fixed"]["request_limit"], 32)
        self.assertEqual(frozen["fixed"]["label_policy"], "v3-kind-guidance-v1")
        self.assertEqual(frozen["fixed"]["batch_work_seconds"], 43180)
        self.assertEqual(frozen["fixed"]["outer_wall_seconds"], 43200)
        self.assertEqual([item["case_id"] for item in frozen["selection"]], [f"A{i:02d}" for i in range(1, 17)])
        self.assertEqual([item["gold_position"] for item in frozen["selection"]], list(range(16)))
        old_plan, _, _ = runner.helpers().contracts()
        self.assertEqual([item["input_sha256"] for item in frozen["plan"]],
                         [item["input_sha256"] for item in old_plan[:16]])
        self.assertIn(".scratch/grounded-evaluation/v3-reported-kind-guidance-plan-20261016.md", frozen["source_hashes"])
        self.assertIn("desktop/tests/fixtures/main16-public.py", frozen["source_hashes"])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_actual_sdk_main16_keeps_original_audits_empty_windows_and_independent32_budget(self):
        frozen, path, expected, approval = self.prepared()
        requests, phases, loaders, extraction_positions = [], [], [], []

        class SyntheticBridge:
            def review(inner, phase, view):
                case = view["case_id"] if phase == "raw" else view["packet"]["case_id"]
                phases.append((case, phase))
                if phase == "raw":
                    return {"reviewer": "合成传输控制，不认证语义", "case_id": case,
                        "reference_sha256": view["reference_sha256"], "raw_evidence_sha256": view["raw_evidence_sha256"],
                        "e_rows": [{"raw_index": item["index"], "payload_sha256": item["payload_sha256"],
                            "fields": {field: "pass" for field in view["e_fields"]}, "meaning": "pass",
                            "inclusion": "pass", "safety": "safe", "classification": "extra", "basis": "仅核合成控制。"}
                            for item in view["extraction"]],
                        "claims": [{"claim_id": item["id"], "groups": []} for item in view["reference_case"]["claims"]],
                        "window_checks": {"inclusion": "fail", "forbidden_meanings": "pass"}}
                answer = deepcopy(view["sealed_raw_review"])
                answer.pop("raw_evidence_sha256")
                packet = view["packet"]
                answer.update(evidence_sha256=packet["evidence_sha256"], run_status=packet["evidence"]["run_status"])
                for item in answer["e_rows"]:
                    index = item["raw_index"]
                    item["lineage"] = {"v_input_indices": [index], "final_indices": [index], "status": "pass"}
                answer["v_rows"] = [{"result_index": item["index"], "payload_sha256": item["payload_sha256"],
                    "fields": {field: "pass" for field in ("candidate_index", "verdict", "issues", "evidence")},
                    "semantic": "pass", "e_indices": [item["index"]], "lineage": "pass", "basis": "仅核合成控制。"}
                    for item in packet["layers"]["verification"]]
                answer["window_checks"]["lineage"] = "pass"
                return answer

        def respond(request):
            body = json.loads(request.content)
            requests.append(body)
            self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["reasoning_effort"], "max")
            self.assertNotIn("tool_choice", body)
            function = body["tools"][0]["function"]
            if function["name"] == "GroundedMemoryLabelsV3":
                position = len(extraction_positions)
                extraction_positions.append(position)
                self.assertEqual(runner.helpers().digest(body["messages"][0]["content"]),
                                 frozen["extraction_window_contracts"][position]["prompt_sha256"])
                label = {"kind": "not_memory" if position in (11, 13) else "unknown", "subject": "contact",
                    "topic": "other", "dependency": None, "unresolved": True, "confidence": 0.9,
                    "sensitivity": "none", "ambiguity_codes": ["other_unresolved"]}
                args = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
            else:
                candidates = json.loads(body["messages"][1]["content"])["candidates"]
                args = {"results": [{"candidate_index": index, "verdict": "uncertain",
                    "issues": ["insufficient_evidence"], "evidence": [], "proof": None} for index in range(len(candidates))]}
            return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion", "created": 1,
                "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": None, "tool_calls": [{"id": "synthetic", "type": "function",
                    "function": {"name": function["name"], "arguments": json.dumps(args)}}]}}]})

        def loader():
            loaders.append(True)
            self.assertTrue((self.home / ".notalone-memory-evaluations" / frozen["run_id"] / "claimed").is_file())
            return "synthetic-key"

        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(respond), credential_loader=loader, bridge=SyntheticBridge())
        self.assertEqual(loaders, [True])
        self.assertEqual(extraction_positions, list(range(16)))
        self.assertEqual(len(requests), 30)
        self.assertEqual(phases, [(f"A{i:02d}", phase) for i in range(1, 17) for phase in ("raw", "full")])
        self.assertEqual(result["summary"]["completed"], 16)
        self.assertEqual(result["summary"]["empty"], 2)
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 32)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 30)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertFalse(result["quality_certified"])

    def test_wrong_scope_policy_old_prompt_source_or_expired_window_fail_before_claim(self):
        frozen, path, _, _ = self.prepared()
        variants = []
        for field, value in (("case_positions", list(range(15))), ("request_limit", 4),
                             ("case_positions", [False, *range(1, 16)]), ("request_limit", 32.0),
                             ("provider_profile", "ecnu"), ("label_policy", "v3-guidance-v1"),
                             ("execution_plan", "reference21-ambiguity2-v3")):
            candidate = deepcopy(frozen)
            candidate["fixed"][field] = value
            variants.append((field, candidate, "fixed_window"))
        for name in (runner.PLAN, runner.KIND_GUIDANCE_PLAN, "desktop/tests/fixtures/main16-public.py"):
            candidate = deepcopy(frozen)
            candidate["source_hashes"].pop(name)
            variants.append((name, candidate, "source_closure"))
        candidate = deepcopy(frozen)
        candidate["source_hashes"][runner.PLAN] = "0" * 64
        variants.append(("source", candidate, "source_drift"))
        candidate = deepcopy(frozen)
        candidate["extraction_window_contracts"][0]["prompt_sha256"] = "0" * 64
        variants.append(("prompt", candidate, "contract_drift"))
        candidate = deepcopy(frozen)
        candidate["plan"][0]["case_position"] = False
        candidate["plan_sha256"] = runner.helpers().digest(candidate["plan"])
        variants.append(("plan_position_type", candidate, "contract_drift"))
        candidate = deepcopy(frozen)
        candidate["selection"][0]["gold_position"] = False
        variants.append(("gold_position_type", candidate, "reference_drift"))

        def forbidden(*args):
            self.fail("错误冻结不得领取、读key或出站")

        for index, (name, candidate, code) in enumerate(variants):
            with self.subTest(name=name):
                candidate_path = path.with_name(f"invalid-{index}.json")
                runner.helpers().publish(candidate_path, candidate)
                expected = runner.helpers().file_digest(candidate_path)
                approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
                with self.assertRaisesRegex(ValueError, code):
                    runner.worker(freeze_path=candidate_path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(forbidden), credential_loader=forbidden)
        work_end = datetime.fromisoformat(frozen["work_end"])
        with patch.object(runner, "now", return_value=work_end), self.assertRaisesRegex(ValueError, "fixed_window"):
            runner.validate(frozen)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_authorization_and_real_worker_injection_are_rejected_without_a_budget(self):
        frozen, path, expected, approval = self.prepared()
        with self.assertRaisesRegex(ValueError, "authorization"):
            runner.worker(freeze_path=path, expected_sha256=expected, approval={})
        with self.assertRaisesRegex(ValueError, "exact_mock_only"):
            runner.worker(freeze_path=path, expected_sha256=expected, approval=approval, credential_loader=lambda: "forbidden")
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_review_bridge_has_600s_phases_and_obeys_earlier_batch_deadline(self):
        frozen, path, _, _ = self.prepared()
        for index, phase in enumerate(("raw", "full")):
            directory = self.home / f"phase-{index}"
            directory.mkdir(mode=0o700)
            start = datetime.now(timezone.utc)
            ticks = [0.0]
            wall = [start]
            def step(_):
                ticks[0] = 600 if phase == "raw" else 1
                wall[0] = start + timedelta(seconds=ticks[0])
            bridge = runner.helpers().ExplicitReviewBridge(directory=directory, run_id=frozen["run_id"],
                deadline=start + timedelta(seconds=1000 if phase == "raw" else 1),
                monotonic=lambda: ticks[0], clock=lambda: wall[0], sleeper=step)
            view = {"case_id": "A01"} if phase == "raw" else {"packet": {"case_id": "A01"}}
            with self.assertRaisesRegex(ValueError, "explicit_review_timeout"):
                bridge.review(phase, view)
            envelope = runner.helpers().read_private(directory / f"A01-{phase}-view.json")
            self.assertEqual(envelope["phase_seconds"], 600)
            receipt = runner.helpers().read_private(directory / f"A01-{phase}-receipt.json")
            self.assertFalse(receipt["received"])

    def test_outer_reaps_owned_descendant_after_leader_exit_and_keeps_wrong_cap_receipt_unknown(self):
        from notalone.memory_extraction import evaluation_owned_process as owned

        frozen, path, expected, approval = self.prepared()
        approval_path = path.parent / "approval.json"
        runner.helpers().publish(approval_path, approval)
        real_popen = subprocess.Popen
        children = []
        script = f'''
import json,os,signal,sys,time
from pathlib import Path
directory=Path({str(path.parent)!r})
assert sys.stdin.buffer.readline(7)==b"start\\n"
owner=json.loads((directory/"owned-worker.json").read_bytes())
assert owner["pid"]==os.getpid() and owner["process_group"]==os.getpgrp()
def publish(name,value):
    fd=os.open(directory/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w") as stream:json.dump(value,stream)
publish("deadline-receipt.json",{{"run_id":{frozen["run_id"]!r},"worker_pid":os.getpid(),"closed":True,"request_limit":4,"reserved_requests":1}})
publish("evaluation/event-000001.json",{{"kind":"case_started","case_position":2}})
if os.fork()==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    (directory/"descendant-ready").write_text("ready")
    time.sleep(30)
    os._exit(0)
while not (directory/"descendant-ready").exists():time.sleep(.01)
raise SystemExit(7)
'''
        def spawn(command, **options):
            self.assertEqual(command[2], str(Path(runner.__file__).resolve()))
            self.assertEqual(command[3], "worker")
            child = real_popen([sys.executable, "-B", "-c", script], **options)
            children.append(child)
            return child
        with patch.object(owned.subprocess, "Popen", side_effect=spawn):
            receipt = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
        self.assertEqual(receipt["exit_code"], 7)
        self.assertTrue(receipt["worker_gone"])
        self.assertTrue(receipt["close_unknown"])
        self.assertFalse(receipt["closed"])
        self.assertEqual(receipt["planned_windows"], 16)
        self.assertEqual(receipt["required_claims"], 18)
        self.assertEqual([item["status"] for item in receipt["case_statuses"]], ["unrun", "unrun", "unknown"] + ["unrun"] * 13)
        with self.assertRaises(ProcessLookupError):
            os.killpg(children[0].pid, 0)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_outer_timeout_uses_original_absolute_end_and_only_reaps_this_owned_worker(self):
        from notalone.memory_extraction import evaluation_owned_process as owned

        frozen, path, expected, approval = self.prepared()
        approval_path = path.parent / "approval.json"
        runner.helpers().publish(approval_path, approval)
        real_popen = subprocess.Popen
        script = f'''
import os,signal,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
directory=Path({str(path.parent)!r})
(directory/"ready").write_text("ready")
assert sys.stdin.buffer.readline(7)==b"start\\n"
time.sleep(5)
'''
        def spawn(command, **options):
            child = real_popen([sys.executable, "-B", "-c", script], **options)
            end = time.monotonic() + 2
            while not (path.parent / "ready").exists() and time.monotonic() < end:
                time.sleep(.01)
            self.assertTrue((path.parent / "ready").exists())
            return child
        end = datetime.fromisoformat(frozen["absolute_end"])
        with patch.object(owned.subprocess, "Popen", side_effect=spawn), \
                patch.object(runner, "now", side_effect=[datetime.now(timezone.utc), end - timedelta(seconds=10.1)]):
            receipt = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
        self.assertTrue(receipt["outer_timed_out"])
        self.assertEqual(receipt["exit_code"], -9)
        self.assertTrue(receipt["worker_gone"])
        self.assertTrue(receipt["close_unknown"])
        self.assertEqual([item["status"] for item in receipt["case_statuses"]], ["unrun"] * 16)
        self.assertLess(receipt["elapsed_seconds"], 3)


if __name__ == "__main__":
    unittest.main()
