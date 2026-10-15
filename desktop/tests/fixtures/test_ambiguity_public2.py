"""v3两窗入口的离线控制；禁止真实home、凭据及网络。"""
from datetime import datetime, timezone
from contextlib import ExitStack
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx

SPEC = importlib.util.spec_from_file_location("ambiguity_public2", Path(__file__).with_name("ambiguity-public2.py"))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class AmbiguityPublic2Test(unittest.TestCase):
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

    def prepared(self):
        frozen = runner.prepare(directory=self.home / "run", absolute_start=datetime.now(timezone.utc))
        path = Path(frozen["directory"]) / "freeze.json"
        expected = runner.helpers().file_digest(path)
        approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
        return frozen, path, expected, approval

    def test_prepare_freezes_original_two_inputs_and_actual_v3_contract_without_home(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(os, "environ", {"NOTALONE_DISABLE_DOTENV": "1"}), \
                patch.object(Path, "home", side_effect=AssertionError("禁止home与registry")):
            frozen = runner.prepare(directory=Path(temporary).resolve() / "run", absolute_start=datetime.now(timezone.utc))
        self.assertEqual(frozen["fixed"]["case_positions"], [6, 9])
        self.assertEqual(frozen["fixed"]["request_limit"], 4)
        self.assertEqual(frozen["fixed"]["extraction_mode"], "grounded-v3")
        self.assertEqual(frozen["fixed"]["batch_work_seconds"], 5380)
        self.assertEqual([item["case_id"] for item in frozen["selection"]], ["A07", "A10"])
        old_plan, old_rows, _ = runner.helpers().contracts()
        for index, position in enumerate((6, 9)):
            self.assertEqual(frozen["plan"][index]["input_sha256"], old_plan[position]["input_sha256"])
            self.assertNotEqual(frozen["extraction_window_contracts"][index]["schema_sha256"], old_rows[position]["schema_sha256"])
        self.assertNotIn("existing_runs", frozen)

    def test_actual_sdk_two_e_and_two_v_preserve_original_gold_mapping_and_four_cap(self):
        frozen, path, expected, approval = self.prepared()
        requests, phases, loaders = [], [], []

        class ExplicitSyntheticBridge:
            def review(inner, phase, view):
                case = view["case_id"] if phase == "raw" else view["packet"]["case_id"]
                phases.append((case, phase))
                if phase == "raw":
                    return {"reviewer": "合成传输控制，不认证质量", "case_id": case,
                        "reference_sha256": view["reference_sha256"], "raw_evidence_sha256": view["raw_evidence_sha256"],
                        "e_rows": [{"raw_index": item["index"], "payload_sha256": item["payload_sha256"],
                            "fields": {field: "pass" for field in view["e_fields"]}, "meaning": "pass",
                            "inclusion": "pass", "safety": "safe", "classification": "extra", "basis": "仅检查合成流程控制。"}
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
                    "semantic": "pass", "e_indices": [item["index"]], "lineage": "pass", "basis": "仅检查合成流程控制。"}
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
                slots = function["parameters"]["properties"]["units"]["required"]
                label = {"kind": "plan" if slots == ["0:0"] else "relationship_event", "subject": "contact",
                    "topic": "other", "dependency": None if slots == ["0:0"] else "0:0", "unresolved": True,
                    "confidence": 0.9, "sensitivity": "none" if slots == ["0:0"] else "financial",
                    "ambiguity_codes": ["entity_identity", "place_ownership"] if slots == ["0:0"] else ["borrowing_direction"]}
                args = {"units": {slot: dict(label) for slot in slots}}
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
            synthetic_transport=httpx.MockTransport(respond), credential_loader=loader, bridge=ExplicitSyntheticBridge())

        self.assertEqual(loaders, [True])
        self.assertEqual(len(requests), 4)
        self.assertEqual(phases, [(case, phase) for case in ("A07", "A10") for phase in ("raw", "full")])
        self.assertEqual(result["receipt"]["budget"]["request_limit"], 4)
        self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 4)
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertFalse(result["quality_certified"])

    def test_missing_actual_runner_from_freeze_is_rejected_before_budget(self):
        frozen, _, _, _ = self.prepared()
        frozen["source_hashes"].pop("desktop/tests/fixtures/ambiguity-public2.py")
        with self.assertRaisesRegex(ValueError, "source_closure"):
            runner.validate(frozen)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_claim_receipt_with_remaining8_limit_cannot_authorize_v3_credential_read(self):
        frozen, path, _, _ = self.prepared()
        helper = runner.helpers()
        registry = self.home / ".notalone-memory-evaluations"
        registry.mkdir(mode=0o700)
        run = registry / frozen["run_id"]
        run.mkdir(mode=0o700)
        (run / "claimed").touch(mode=0o600)
        config = {"mode": "deepseek_bounded_ambiguity2_v3", "stage": "ambiguity2-v3",
            "selected_case_positions": [6, 9], "source_hashes": frozen["source_hashes"],
            "extraction_window_contracts": frozen["extraction_window_contracts"]}
        helper.publish(path.parent / "evaluation/manifest.json", {"frozen_config": config})
        with sqlite3.connect(run / "budget.sqlite3") as connection:
            connection.execute("CREATE TABLE state (manifest TEXT, closed INTEGER)")
            connection.execute("CREATE TABLE requests (id INTEGER)")
            connection.execute("INSERT INTO state VALUES (?, 0)", (json.dumps({
                "run_id": frozen["run_id"], "request_limit": 16,
                "allowed_endpoints": ["https://api.deepseek.com/chat/completions"],
                "config_sha256": helper.digest(config), "output_directory": str(path.parent / "evaluation"),
            }),))
        with self.assertRaisesRegex(ValueError, "claim_manifest_changed"):
            runner.verify_claim(frozen)

    def test_missing_authorization_or_source_drift_never_claims_or_loads_credentials(self):
        frozen, path, expected, approval = self.prepared()
        with self.assertRaisesRegex(ValueError, "authorization"):
            runner.worker(freeze_path=path, expected_sha256=expected, approval={})
        with patch.object(runner, "POSITIONS", (9, 6)), self.assertRaisesRegex(ValueError, "contract_drift"):
            runner.worker(freeze_path=path, expected_sha256=expected, approval=approval)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_outer_rejects_wrong_pid_close_receipt_and_keeps_started_unknown_denominator(self):
        frozen, path, expected, approval = self.prepared()
        helper = runner.helpers()
        approval_path = path.parent / "approval.json"
        helper.publish(approval_path, approval)
        real_popen = subprocess.Popen
        script = f'''
import json,os,sys
from pathlib import Path
directory=Path({str(path.parent)!r})
assert sys.stdin.buffer.readline(7)==b"start\\n"
owner=json.loads((directory/"owned-worker.json").read_bytes())
assert owner["pid"]==os.getpid() and owner["process_group"]==os.getpgrp()
def publish(name,value):
    fd=os.open(directory/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"w") as stream:json.dump(value,stream)
publish("deadline-receipt.json",{{"run_id":{frozen["run_id"]!r},"worker_pid":os.getpid()+1,"closed":True,"request_limit":4,"reserved_requests":1}})
publish("evaluation/event-000001.json",{{"kind":"case_started","case_position":1}})
raise SystemExit(7)
'''

        def owned_synthetic(command, **options):
            self.assertEqual(command[2], str(Path(runner.__file__).resolve()))
            self.assertEqual(command[3], "worker")
            self.assertEqual(options["env"]["NOTALONE_DISABLE_DOTENV"], "1")
            return real_popen([sys.executable, "-B", "-c", script], **options)

        with patch.object(runner.subprocess, "Popen", side_effect=owned_synthetic):
            receipt = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)

        self.assertEqual(receipt["exit_code"], 7)
        self.assertTrue(receipt["worker_gone"])
        self.assertTrue(receipt["close_unknown"])
        self.assertFalse(receipt["closed"])
        self.assertEqual(receipt["planned_windows"], 2)
        self.assertEqual(receipt["required_claims"], 3)
        self.assertEqual([item["status"] for item in receipt["case_statuses"]], ["unrun", "unknown"])
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())


if __name__ == "__main__":
    unittest.main()
