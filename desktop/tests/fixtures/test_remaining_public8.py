"""新8窗入口的离线控制；不读取真实home、registry、凭据或网络。"""

from datetime import datetime, timedelta, timezone
from contextlib import ExitStack
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import tempfile
import unittest
from unittest.mock import patch

import httpx

SPEC = importlib.util.spec_from_file_location("remaining_public8", Path(__file__).with_name("remaining-public8.py"))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class RemainingPublic8Test(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"}))
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
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

    def test_prepare_freezes_only_remaining8_without_home_registry_or_credential(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"}), \
                patch.object(Path, "home", side_effect=AssertionError("禁止真实home或registry")):
            target = Path(temporary).resolve() / "run"
            frozen = runner.prepare(directory=target, absolute_start=datetime.now(timezone.utc))
            self.assertEqual(frozen["fixed"]["request_limit"], 16)
            self.assertEqual(frozen["fixed"]["case_positions"], [19, 20, 13, 14, 15, 16, 17, 18])
            self.assertEqual([item["case_id"] for item in frozen["selection"]],
                             ["B01", "B02", "A14", "A15", "A16", "A17", "A18", "A19"])
            self.assertEqual(len(frozen["extraction_window_contracts"]), 8)
            self.assertNotIn("existing_runs", frozen)
            self.assertEqual(frozen["fixed"]["batch_work_seconds"], 2380)
            self.assertFalse((target / "activation.json").exists())

    def prepared(self):
        target = self.home / "run"
        frozen = runner.prepare(directory=target, absolute_start=datetime.now(timezone.utc))
        path = target / "freeze.json"
        expected = runner.helpers().file_digest(path)
        approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
        return frozen, path, expected, approval

    def test_actual_sdk_empty8_uses_original_gold_mapping_and16_bound_with_explicit_phases(self):
        frozen, path, expected, approval = self.prepared()
        requests, phases, loaders = [], [], []
        class EmptyBridge:
            def review(inner, phase, view):
                case = view["case_id"] if phase == "raw" else view["packet"]["case_id"]
                phases.append((case, phase))
                if phase == "raw":
                    return {"reviewer": "合成空输出控制", "case_id": case,
                        "reference_sha256": view["reference_sha256"], "raw_evidence_sha256": view["raw_evidence_sha256"],
                        "e_rows": [], "claims": [{"claim_id": item["id"], "groups": []}
                                                 for item in view["reference_case"]["claims"]],
                        "window_checks": {"inclusion": "pass" if case == "A14" else "fail", "forbidden_meanings": "pass"}}
                answer = deepcopy(view["sealed_raw_review"])
                answer.pop("raw_evidence_sha256")
                answer.update(evidence_sha256=view["packet"]["evidence_sha256"], run_status="empty", v_rows=[])
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
            label = {"kind": "not_memory", "subject": "contact", "topic": "other", "dependency": None,
                     "unresolved": False, "confidence": 0.9, "sensitivity": "none"}
            args = {"units": {slot: dict(label) for slot in function["parameters"]["properties"]["units"]["required"]}}
            return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion", "created": 1,
                "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": None, "tool_calls": [{"id": "synthetic", "type": "function",
                    "function": {"name": function["name"], "arguments": json.dumps(args)}}]}}]})
        def loader():
            loaders.append(True)
            self.assertTrue((self.home / ".notalone-memory-evaluations" / frozen["run_id"] / "claimed").is_file())
            return "synthetic-key"
        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(respond), credential_loader=loader, bridge=EmptyBridge())
        self.assertEqual(loaders, [True]); self.assertEqual(len(requests), 8)
        self.assertEqual(phases, [(case, phase) for case in ["B01", "B02", "A14", "A15", "A16", "A17", "A18", "A19"]
                                 for phase in ("raw", "full")])
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 16)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 8)
        self.assertFalse(result["quality_certified"])

    def test_missing_authorization_and_source_drift_never_create_budget_or_read_key(self):
        frozen, path, expected, approval = self.prepared()
        with self.assertRaisesRegex(ValueError, "bound_authorization"):
            runner.worker(freeze_path=path, expected_sha256=expected, approval={})
        with patch.object(runner, "POSITIONS", (20, 19, 13, 14, 15, 16, 17, 18)), self.assertRaisesRegex(ValueError, "contract_drift"):
            runner.worker(freeze_path=path, expected_sha256=expected, approval=approval)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_outer_records_owned_worker_before_release_and_preserves_null_receipt_unknown(self):
        frozen, path, expected, approval = self.prepared()
        helper = runner.helpers()
        approval_path = path.parent / "approval.json"; helper.publish(approval_path, approval)
        real_popen = subprocess.Popen
        script = f'''
import json,os,sys
from pathlib import Path
directory=Path({str(path.parent)!r})
assert sys.stdin.buffer.readline(7)==b"start\\n"
owner=json.loads((directory/"owned-worker.json").read_bytes())
assert owner["pid"]==os.getpid() and owner["process_group"]==os.getpgrp()
fd=os.open(directory/"result.json",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"w") as stream:json.dump({{"receipt":None,"stopped_code":"synthetic_unknown"}},stream)
raise SystemExit(7)
'''
        def owned_synthetic(command, **options):
            self.assertEqual(command[3], "worker")
            self.assertEqual(command[2], str(Path(runner.__file__).resolve()))
            return real_popen([sys.executable, "-B", "-c", script], **options)
        with patch.object(runner.subprocess, "Popen", side_effect=owned_synthetic):
            receipt = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
        self.assertEqual(receipt["exit_code"], 7)
        self.assertTrue(receipt["worker_gone"])
        self.assertFalse(receipt["closed"])
        self.assertTrue(receipt["close_unknown"])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_outer_timeout_only_reaps_owned_group_and_rejects_other_run_closed_receipt(self):
        frozen, path, expected, approval = self.prepared()
        helper = runner.helpers()
        approval_path = path.parent / "approval.json"; helper.publish(approval_path, approval)
        real_popen = subprocess.Popen
        script = f'''
import json,os,signal,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
directory=Path({str(path.parent)!r})
(directory/"ready").write_text("ready")
assert sys.stdin.buffer.readline(7)==b"start\\n"
fd=os.open(directory/"deadline-receipt.json",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"w") as stream:json.dump({{"run_id":"other-run","worker_pid":os.getpid(),"closed":True,"request_limit":16,"reserved_requests":0}},stream)
time.sleep(5)
'''
        def owned_synthetic(command, **options):
            child = real_popen([sys.executable, "-B", "-c", script], **options)
            deadline = time.monotonic() + 2
            while not (path.parent / "ready").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue((path.parent / "ready").exists())
            return child
        point = runner.now()
        end = datetime.fromisoformat(frozen["absolute_end"])
        with patch.object(runner.subprocess, "Popen", side_effect=owned_synthetic), \
                patch.object(runner, "now", side_effect=[point, end - timedelta(seconds=10.1)]):
            receipt = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
        self.assertTrue(receipt["outer_timed_out"])
        self.assertEqual(receipt["exit_code"], -9)
        self.assertTrue(receipt["worker_gone"])
        self.assertFalse(receipt["closed"])
        self.assertTrue(receipt["close_unknown"])
        self.assertEqual(receipt["planned_windows"], 8)
        self.assertEqual([row["status"] for row in receipt["case_statuses"]], ["unrun"] * 8)
        self.assertLess(receipt["elapsed_seconds"], 3)

    def test_outer_reaps_owned_descendant_even_after_worker_leader_exits(self):
        frozen, path, expected, approval = self.prepared()
        helper = runner.helpers()
        approval_path = path.parent / "approval.json"; helper.publish(approval_path, approval)
        real_popen = subprocess.Popen
        children = []
        script = f'''
import os,signal,sys,time
from pathlib import Path
directory=Path({str(path.parent)!r})
assert sys.stdin.buffer.readline(7)==b"start\\n"
if os.fork()==0:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    (directory/"descendant-ready").write_text(str(os.getpid()))
    time.sleep(30)
    os._exit(0)
while not (directory/"descendant-ready").exists():time.sleep(.01)
raise SystemExit(7)
'''
        def owned_synthetic(command, **options):
            child = real_popen([sys.executable, "-B", "-c", script], **options)
            children.append(child)
            return child
        try:
            with patch.object(runner.subprocess, "Popen", side_effect=owned_synthetic):
                receipt = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
            self.assertEqual(receipt["exit_code"], 7)
            with self.assertRaises(ProcessLookupError):
                os.killpg(children[0].pid, 0)
            self.assertTrue(receipt["worker_gone"])
            self.assertFalse(receipt["outer_timed_out"])
            self.assertTrue(receipt["close_unknown"])
            self.assertLess(receipt["elapsed_seconds"], 3)
        finally:
            if children:
                try:
                    os.killpg(children[0].pid, 9)
                except ProcessLookupError:
                    pass
                children[0].wait(timeout=1)


if __name__ == "__main__":
    unittest.main()
