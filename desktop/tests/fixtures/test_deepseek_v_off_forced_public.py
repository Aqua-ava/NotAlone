"""单次V探针；仅精确Mock、临时home和自有合成进程，不认证质量。"""
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx


def load_runner():
    spec = importlib.util.spec_from_file_location(
        "deepseek_v_off_forced_public", Path(__file__).with_name("deepseek-v-off-forced-public.py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class VOffForcedPublicTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.stack.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        for owner, names in ((socket.socket, ("connect", "connect_ex")), (socket, ("getaddrinfo",))):
            for name in names:
                self.stack.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def prepared(self, name="run"):
        runner = load_runner()
        frozen = runner.prepare(directory=self.home / name, absolute_start=datetime.now(timezone.utc))
        path = Path(frozen["directory"]) / "freeze.json"
        expected = runner.helpers().file_digest(path)
        approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
        return runner, frozen, path, expected, approval

    def response(self, request, *, content=None, calls=True):
        result = {"results": [{"candidate_index": 0, "verdict": "supported", "issues": [],
                              "evidence": [{"message_id": "33333333-3333-4333-8333-333333333333",
                                            "quote": "我刚刚到家。"}], "proof": None}]}
        message = {"role": "assistant", "content": content}
        if calls:
            message["tool_calls"] = [{"id": "synthetic", "type": "function", "function": {
                "name": "SourceVerificationOutput", "arguments": json.dumps(result)}}]
        return httpx.Response(200, request=request, json={"id": "synthetic", "object": "chat.completion",
            "created": 1, "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls" if calls else "stop",
                                                                       "message": message}]})

    def test_actual_sdk_wire_and_claimed_single_credential_then_durable_close(self):
        from langchain_core.utils.function_calling import convert_to_openai_tool
        from notalone.memory_extraction.verification_adapters import SOURCE_VERIFICATION_PROOF_SCHEMA

        runner, frozen, path, expected, approval = self.prepared()
        requests, loaded = [], []

        def loader():
            runner.verify_claim(frozen)
            loaded.append(True)
            return "synthetic-key"

        def handler(request):
            body = json.loads(request.content)
            requests.append(body)
            self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["reasoning_effort"], "none")
            self.assertEqual(body["tool_choice"], {"type": "function", "function": {"name": "SourceVerificationOutput"}})
            self.assertEqual(body["tools"], [convert_to_openai_tool(SOURCE_VERIFICATION_PROOF_SCHEMA)])
            self.assertEqual(request.extensions["timeout"]["read"], 30)
            self.assertNotIn("strict", body["tools"][0]["function"])
            return self.response(request)

        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(handler), credential_loader=loader)
        self.assertEqual(loaded, [True])
        self.assertEqual(len(requests), 1)
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["closed"])
        self.assertEqual(result["budget"]["reserved_requests"], 1)
        self.assertFalse(result["quality_certified"])
        self.assertFalse(result["automatic_successor"])
        self.assertEqual(frozen["candidate"]["text"], "联系人原话：“我刚刚到家。”")
        manifest = runner.helpers().read_private(path.parent / "pilot-manifest.json")
        self.assertEqual(manifest["authorization_sha256"], runner.helpers().digest(approval))

    def test_prepare_never_reads_home_or_credential_and_freezes_same_absolute_window(self):
        with patch.object(Path, "home", side_effect=AssertionError("prepare禁止home/registry")):
            runner, frozen, path, _, _ = self.prepared()
        start = datetime.fromisoformat(frozen["absolute_start"])
        self.assertEqual((datetime.fromisoformat(frozen["work_end"]) - start).total_seconds(), 70)
        self.assertEqual((datetime.fromisoformat(frozen["absolute_end"]) - start).total_seconds(), 80)
        self.assertEqual(frozen["fixed"]["call_wall_seconds"], 60)
        self.assertEqual(frozen["fixed"]["request_limit"], 1)
        self.assertEqual(frozen["given_v4_labels"]["units"]["0:0"]["kind"], "event")
        self.assertEqual(frozen["candidate"]["source_message_ids"], ["33333333-3333-4333-8333-333333333333"])
        self.assertIsNone(frozen["candidate"]["valid_at"])
        self.assertIsNone(frozen["candidate"]["invalid_at"])
        self.assertIn(runner.PLAN, frozen["source_hashes"])
        self.assertIn(runner.IMPLEMENTATION, frozen["source_hashes"])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_v2_binds_new_input_protocol_and_only_new_plan_documents(self):
        runner, frozen, _, _, _ = self.prepared()
        self.assertEqual(frozen["format"], "deepseek-v-off-forced-pilot-v2")
        self.assertEqual(frozen["window"]["messages"][0]["text"], "我刚刚到家。")
        self.assertEqual(frozen["candidate"]["text"], "联系人原话：“我刚刚到家。”")
        self.assertEqual(runner.PLAN, ".scratch/grounded-evaluation/deepseek-v-off-forced-v2-plan-20261016.md")
        self.assertEqual(runner.IMPLEMENTATION, ".scratch/grounded-evaluation/deepseek-v-off-forced-v2-implementation-20261016.md")
        self.assertIn(runner.PLAN, frozen["source_hashes"])
        self.assertIn(runner.IMPLEMENTATION, frozen["source_hashes"])
        self.assertNotIn(".scratch/grounded-evaluation/deepseek-v-off-forced-pilot-plan-20261016.md", frozen["source_hashes"])
        self.assertNotIn(".scratch/grounded-evaluation/deepseek-v-off-forced-pilot-implementation-20261016.md", frozen["source_hashes"])

    def test_unrecordable_response_keeps_only_safe_actual_metadata_and_fails_closed(self):
        for name, arguments, status in (("invalid-json", '{"x":"argument-marker"', 200),
                                         ("nonobject", '["argument-marker"]', 200),
                                         ("nonfinite-argument", '{"x":NaN,"extra":"argument-marker"}', 200),
                                         ("nonfinite-body", None, 200),
                                         ("non200", '{"x":"argument-marker"', 503)):
            with self.subTest(name=name):
                runner, _, path, expected, approval = self.prepared(name)
                loaded, sizes = [], []

                def handler(request):
                    body = self.response(request).json()
                    if arguments is not None:
                        body["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = arguments
                    if name == "nonfinite-body":
                        body["usage"] = {"prompt_tokens": float("nan")}
                    body["choices"][0]["message"]["reasoning_content"] = "reasoning-marker"
                    content = json.dumps(body).encode()
                    sizes.append(len(content))
                    return httpx.Response(status, content=content, request=request,
                        headers={"authorization": "header-marker", "content-type": "application/json"})

                result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(handler),
                    credential_loader=lambda: loaded.append(True) or "credential-marker")
                events = [runner.helpers().read_private(record) for record in sorted(path.parent.glob("pilot-event-*.json"))]
                self.assertEqual(loaded, [True])
                self.assertEqual(len(sizes), 1)
                self.assertEqual([event["kind"] for event in events], ["provider_request", "provider_response"])
                self.assertEqual(events[1]["payload"], {"status_code": status, "body_bytes": sizes[0],
                    "body_not_saved": "response_processing_failed", "response_obtained": True})
                self.assertTrue(result["response_obtained"])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["verification"], [])
                self.assertTrue(result["closed"])
                self.assertEqual(result["budget"]["reserved_requests"], 1)
                for record in path.parent.glob("*.json"):
                    for forbidden in ("argument-marker", "reasoning-marker", "header-marker", "credential-marker"):
                        self.assertNotIn(forbidden, record.read_text())

    def test_response_publication_failure_never_completes_or_claims_saved_response(self):
        for name, arguments in (("valid", None), ("metadata", '["argument-marker"]')):
            with self.subTest(name=name):
                runner, _, path, expected, approval = self.prepared(name)
                original_publish = runner.helpers().publish
                bridge = sys.modules["explicit_review_bridge"]
                requests = []

                def publish(record_path, value):
                    if value.get("kind") == "provider_response":
                        raise OSError("error-text-marker")
                    return original_publish(record_path, value)

                def handler(request):
                    requests.append(True)
                    body = self.response(request).json()
                    if arguments is not None:
                        body["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = arguments
                    return httpx.Response(200, json=body, request=request)

                with patch.object(bridge, "publish", side_effect=publish):
                    result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(handler), credential_loader=lambda: "credential-marker")
                self.assertEqual(requests, [True])
                self.assertEqual(result["status"], "failed")
                self.assertTrue(result["response_obtained"])
                self.assertTrue(result["closed"])
                self.assertEqual(result["budget"]["reserved_requests"], 1)
                events = [runner.helpers().read_private(record) for record in path.parent.glob("pilot-event-*.json")]
                self.assertEqual([event["kind"] for event in events], ["provider_request"])
                for record in path.parent.glob("*.json"):
                    for forbidden in ("argument-marker", "error-text-marker", "credential-marker"):
                        self.assertNotIn(forbidden, record.read_text())

    def test_failure_event_uses_actual_response_capture_state(self):
        for responded in (False, True):
            with self.subTest(responded=responded):
                runner, _, path, expected, approval = self.prepared(str(responded))

                def handler(request):
                    if not responded:
                        raise RuntimeError("error-text-marker")
                    return self.response(request)

                original_observe = runner._PilotContract.observe_response

                def observe(contract, response):
                    original_observe(contract, response)
                    raise RuntimeError("error-text-marker")

                with patch.object(runner._PilotContract, "observe_response", observe):
                    result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(handler), credential_loader=lambda: "credential-marker")
                events = [runner.helpers().read_private(record) for record in sorted(path.parent.glob("pilot-event-*.json"))]
                self.assertEqual(events[-1]["kind"], "provider_failure")
                self.assertEqual(events[-1]["payload"], {"failure_kind": "unknown_transport_error", "response_obtained": responded})
                self.assertEqual(len(events), 3 if responded else 2)
                self.assertIs(result["response_obtained"], responded)
                self.assertEqual(result["status"], "failed" if responded else "unknown")
                self.assertTrue(result["closed"])
                self.assertEqual(result["budget"]["reserved_requests"], 1)
                for record in path.parent.glob("*.json"):
                    for forbidden in ("error-text-marker", "credential-marker"):
                        self.assertNotIn(forbidden, record.read_text())

    def test_valid_response_saves_redacted_body_and_actual_response_state(self):
        runner, _, path, expected, approval = self.prepared()

        def handler(request):
            body = self.response(request).json()
            body["choices"][0]["message"]["reasoning_content"] = "reasoning-marker"
            body["api_key"] = "body-key-marker"
            return httpx.Response(200, json=body, request=request, headers={"authorization": "header-marker"})

        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(handler), credential_loader=lambda: "credential-marker")
        response = runner.helpers().read_private(path.parent / "pilot-event-000002.json")["payload"]
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["response_obtained"])
        self.assertTrue(response["response_obtained"])
        self.assertIn("body", response)
        self.assertGreater(response["body_bytes"], 0)
        for record in path.parent.glob("*.json"):
            for forbidden in ("reasoning-marker", "body-key-marker", "header-marker", "credential-marker"):
                self.assertNotIn(forbidden, record.read_text())

    def test_unauthorized_or_changed_freeze_scope_versions_wire_and_expiry_reject_before_claim(self):
        for index, changed in enumerate(("authorization", "hash", "protocol", "fixed", "source", "closure", "versions", "wire", "expired")):
            with self.subTest(changed=changed):
                runner, frozen, path, expected, approval = self.prepared(str(index))
                candidate = deepcopy(frozen)
                if changed == "authorization":
                    approval["user_authorized"] = 1
                elif changed == "hash":
                    expected = "0" * 64
                elif changed == "protocol":
                    candidate["format"] = "deepseek-v-off-forced-pilot-v1"
                elif changed == "fixed":
                    candidate["fixed"]["request_limit"] = 2
                elif changed == "source":
                    candidate["source_hashes"][runner.PLAN] = "0" * 64
                elif changed == "closure":
                    candidate["source_hashes"].pop(runner.PLAN)
                elif changed == "versions":
                    candidate["installed_versions"]["openai"] = "0"
                elif changed == "wire":
                    candidate["wire_contract"]["thinking"]["type"] = "enabled"
                elif changed == "expired":
                    for field in ("absolute_start", "work_end", "absolute_end"):
                        candidate[field] = candidate[field].replace("2026", "2020", 1)
                if changed not in {"authorization", "hash"}:
                    path.write_text(json.dumps(candidate), encoding="utf-8")
                    expected = runner.helpers().file_digest(path)
                    approval = {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}
                with self.assertRaises(ValueError):
                    runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得请求")),
                        credential_loader=lambda: self.fail("不得读取凭据"))
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_bad_tool_result_or_timeout_closes_once_without_repair_or_second_credential(self):
        for kind in ("missing", "timeout", "model", "arguments", "name", "multiple", "http500"):
            with self.subTest(kind=kind):
                runner, _, path, expected, approval = self.prepared(kind)
                requests, loaded = [], []

                def handler(request):
                    requests.append(request)
                    if kind == "timeout":
                        raise httpx.ReadTimeout("合成无响应", request=request)
                    response = self.response(request, content="<tool_calls>" if kind == "missing" else None,
                                             calls=kind != "missing")
                    if kind == "model":
                        body = response.json()
                        body["model"] = "other"
                        return httpx.Response(200, json=body, request=request)
                    if kind == "arguments":
                        body = response.json()
                        body["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = "{}"
                        return httpx.Response(200, json=body, request=request)
                    if kind in {"name", "multiple", "http500"}:
                        body = response.json()
                        if kind == "name":
                            body["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "OtherTool"
                        elif kind == "multiple":
                            body["choices"][0]["message"]["tool_calls"] *= 2
                        return httpx.Response(500 if kind == "http500" else 200, json=body, request=request)
                    return response

                result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(handler),
                    credential_loader=lambda: loaded.append(True) or "synthetic-key")
                self.assertEqual(len(requests), 1)
                self.assertEqual(loaded, [True])
                self.assertEqual(result["status"], "unknown" if kind == "timeout" else "failed")
                self.assertIs(result["response_obtained"], kind != "timeout")
                self.assertTrue(result["closed"])
                self.assertEqual(result["budget"]["reserved_requests"], 1)
                self.assertEqual(result["verification"], [])
                with self.assertRaises(BaseException):
                    runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                        synthetic_transport=httpx.MockTransport(lambda _: self.fail("旧run不得重发")),
                        credential_loader=lambda: self.fail("旧run不得重读凭据"))

    def test_response_choice_index_requires_integer_zero(self):
        for name, index in (("bool", False), ("float", 0.0)):
            with self.subTest(index_type=name):
                runner, _, path, expected, approval = self.prepared(name)

                def handler(request):
                    body = self.response(request).json()
                    body["choices"][0]["index"] = index
                    return httpx.Response(200, json=body, request=request)

                result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(handler), credential_loader=lambda: "synthetic-key")
                self.assertEqual(result["status"], "failed")
                self.assertTrue(result["closed"])
                self.assertEqual(result["budget"]["reserved_requests"], 1)
                self.assertEqual(result["verification"], [])

    def test_live_injection_and_wrong_import_origin_reject_without_budget_or_secret(self):
        import notalone.memory_extraction.grounded as grounded
        runner, _, path, expected, approval = self.prepared()
        with self.assertRaisesRegex(ValueError, "exact_mock_only"):
            runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                          credential_loader=lambda: self.fail("不得读取凭据"))
        with patch.object(grounded, "__file__", str(self.home / "other.py")):
            with self.assertRaisesRegex(ValueError, "actual_source_root"):
                runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
                    synthetic_transport=httpx.MockTransport(lambda _: self.fail("不得请求")),
                    credential_loader=lambda: self.fail("不得读取凭据"))
        self.assertFalse((self.home / ".notalone-memory-evaluations").exists())

    def test_version_drift_after_claim_closes_zero_requests_and_logs_no_secret(self):
        runner, _, path, expected, approval = self.prepared()
        original_version = runner.version

        def loader():
            runner.version = lambda name: "changed" if name == "openai" else original_version(name)
            return "must-never-be-recorded"

        result = runner.worker(freeze_path=path, expected_sha256=expected, approval=approval,
            synthetic_transport=httpx.MockTransport(lambda _: self.fail("版本漂移不得请求")), credential_loader=loader)
        self.assertTrue(result["closed"])
        self.assertEqual(result["budget"]["reserved_requests"], 0)
        self.assertEqual(result["status"], "failed")
        for record in path.parent.glob("*.json"):
            self.assertNotIn("must-never-be-recorded", record.read_text())

    def test_cap_one_rejects_second_attempt_before_transport_and_never_refunds(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort, EvaluationTransport
        output = self.home / "cap"
        output.mkdir(mode=0o700)
        budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=1,
            allowed_endpoints=("https://api.deepseek.com/chat/completions",), config_sha256="a" * 64)
        requests = []
        with budget.batch():
            with httpx.Client(transport=EvaluationTransport(budget,
                    synthetic_transport=httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200)))) as client:
                client.post("https://api.deepseek.com/chat/completions")
                with self.assertRaises(EvaluationBudgetAbort):
                    client.post("https://api.deepseek.com/chat/completions")
        self.assertEqual(len(requests), 1)
        self.assertEqual(budget.closed_receipt()["reserved_requests"], 1)

    def test_call_and_work_deadline_close_before_exit_and_close_failure_is_unknown(self):
        from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
        runner = load_runner()
        for name, remaining, elapsed, fail_close in (("call", 70, 60, False), ("work", 20, 20, False),
                                                       ("unknown", 70, 60, True)):
            with self.subTest(name=name):
                output = self.home / name
                output.mkdir(mode=0o700)
                budget = EvaluationBudget.create(run_id=uuid4(), output_directory=output, request_limit=1,
                    allowed_endpoints=(runner.ENDPOINT,), config_sha256="a" * 64)
                ticks, exits = [0.0], []
                control = runner.PilotDeadline(receipt=output / "deadline.json", clock=lambda: ticks[0],
                    exit_worker=exits.append, remaining_batch_seconds=remaining)
                with budget.batch():
                    control.start(budget, synthetic=True)
                    with control.invocation():
                        ticks[0] = elapsed
                        with ExitStack() as failures:
                            if fail_close:
                                failures.enter_context(patch.object(budget, "close", side_effect=EvaluationBudgetAbort("合成关闭故障")))
                            control.checkpoint()
                    receipt = runner.helpers().read_private(output / "deadline.json")
                    self.assertEqual(receipt["reason"], "batch_wall_deadline" if name == "work" else "call_wall_deadline")
                    self.assertEqual(receipt["closed"], not fail_close)
                    self.assertEqual(exits, [125 if fail_close else 124])
                    budget.close()
                    control.finish()

    def test_launch_reaps_own_descendant_after_leader_exits_and_preserves_unrelated_group(self):
        runner, frozen, path, expected, approval = self.prepared()
        approval_path = path.parent / "approval.json"
        runner.helpers().publish(approval_path, approval)
        original = subprocess.Popen
        sentinel = original([sys.executable, "-c", "import time; time.sleep(20)"], start_new_session=True)
        child_code = '''
import json, os, subprocess, sys, time
from pathlib import Path
directory = Path(sys.argv[1])
assert sys.stdin.buffer.readline(7) == b"start\\n"
owner = json.loads((directory / "owned-worker.json").read_bytes())
assert owner["worker_pid"] == os.getpid() == os.getpgrp()
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"])
path = directory / "descendant.json"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    json.dump({"pid": child.pid}, stream)
path = directory / "deadline-receipt.json"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    json.dump({"run_id": sys.argv[2], "worker_pid": os.getpid(), "closed": True,
               "request_limit": 2, "reserved_requests": 1}, stream)
'''

        def spawn(_command, **options):
            self.assertTrue(options["start_new_session"])
            return original([sys.executable, "-B", "-c", child_code, str(path.parent), frozen["run_id"]], **options)

        try:
            with patch.object(runner.subprocess, "Popen", side_effect=spawn):
                finish = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
            self.assertTrue(finish["worker_gone"])
            self.assertTrue(finish["close_unknown"])
            self.assertFalse(finish["closed"])
            self.assertFalse(finish["outer_timed_out"])
            self.assertIsNone(sentinel.poll())
            descendant = runner.helpers().read_private(path.parent / "descendant.json")["pid"]
            with self.assertRaises(ProcessLookupError):
                os.kill(descendant, 0)
        finally:
            if sentinel.poll() is None:
                sentinel.terminate()
            sentinel.wait(timeout=2)

    def test_launch_requires_exact_integer_worker_pid_in_result_and_deadline(self):
        original = subprocess.Popen
        child_code = '''
import json, os, sys
from pathlib import Path
directory = Path(sys.argv[1])
assert sys.stdin.buffer.readline(7) == b"start\\n"
kind, pid_kind = sys.argv[3:5]
pid = {"int": os.getpid(), "float": float(os.getpid()), "bool": True, "wrong": os.getpid() + 1}[pid_kind]
proof = {"run_id": sys.argv[2], "closed": True, "request_limit": 1, "reserved_requests": 1,
         "config_sha256": sys.argv[5], "allowed_endpoints": ["https://api.deepseek.com/chat/completions"]}
if kind == "result":
    name = "result.json"
    value = {"format": sys.argv[6], "run_id": sys.argv[2], "worker_pid": pid, "budget": proof, "status": "completed"}
else:
    name = "deadline-receipt.json"
    value = {**proof, "worker_pid": pid}
fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    json.dump(value, stream)
'''
        for kind in ("result", "deadline"):
            for pid_kind in ("int", "float", "bool", "wrong"):
                with self.subTest(record=kind, pid_type=pid_kind):
                    runner, frozen, path, expected, approval = self.prepared(f"{kind}-{pid_kind}")
                    approval_path = path.parent / "approval.json"
                    runner.helpers().publish(approval_path, approval)

                    def spawn(_command, **options):
                        return original([sys.executable, "-B", "-c", child_code, str(path.parent), frozen["run_id"],
                                         kind, pid_kind, runner.helpers().digest(frozen), runner.PROTOCOL], **options)

                    with patch.object(runner.subprocess, "Popen", side_effect=spawn):
                        finish = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
                    self.assertTrue(finish["worker_gone"])
                    self.assertEqual(finish["closed"], pid_kind == "int")
                    self.assertEqual(finish["close_unknown"], pid_kind != "int")

    def test_outer_uses_original_absolute_end_and_second_launch_rejects_before_spawn(self):
        runner, frozen, path, expected, approval = self.prepared()
        approval_path = path.parent / "approval.json"
        runner.helpers().publish(approval_path, approval)
        original = subprocess.Popen
        end = datetime.fromisoformat(frozen["absolute_end"])
        start = datetime.fromisoformat(frozen["absolute_start"])
        moments = iter((start, end - runner.timedelta(seconds=3.03)))

        def spawn(_command, **options):
            return original([sys.executable, "-c", "import sys,time;sys.stdin.buffer.readline(7);time.sleep(20)"], **options)

        with patch.object(runner, "now", side_effect=lambda: next(moments)), \
                patch.object(runner.subprocess, "Popen", side_effect=spawn):
            finish = runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
        self.assertTrue(finish["outer_timed_out"])
        self.assertTrue(finish["worker_gone"])
        self.assertTrue(finish["close_unknown"])
        self.assertLess(finish["elapsed_seconds"], 3)
        with patch.object(runner.subprocess, "Popen", side_effect=AssertionError("不得重新启动旧探针")):
            with self.assertRaisesRegex(ValueError, "already_started"):
                runner.launch(freeze_path=path, expected_sha256=expected, approval_path=approval_path)
