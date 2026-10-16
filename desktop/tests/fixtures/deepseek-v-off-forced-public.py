"""单次V关闭思考／强制具名探针；独立记录，不使用完整评测入口。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib.util
from importlib.metadata import version
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from typing import Any, Callable, cast
from uuid import UUID, uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationBudget, EvaluationBudgetAbort, EvaluationTransport,
)
from notalone.memory_extraction.evaluation_owned_deadline import _OwnedPublicDeadline
from notalone.memory_extraction.evaluation_records import _json_value, _redact


ROOT = Path(__file__).resolve().parents[3]
LEGACY = ROOT / "desktop/artifacts/grounded-public21-prepare-20261015/grounded_public21.py"
PLAN = ".scratch/grounded-evaluation/deepseek-v-off-forced-pilot-plan-20261016.md"
IMPLEMENTATION = ".scratch/grounded-evaluation/deepseek-v-off-forced-pilot-implementation-20261016.md"
PROTOCOL = "deepseek-v-off-forced-pilot-v1"
ENDPOINT = "https://api.deepseek.com/chat/completions"
FIXED = {"protocol": PROTOCOL, "request_limit": 1, "max_retries": 0,
         "model": "deepseek-flash", "endpoint": ENDPOINT,
         "thinking": {"type": "disabled"}, "reasoning_effort": "none",
         "verification_mode": "nullable-proof-v1", "tool_choice": "SourceVerificationOutput",
         "http_read_seconds": 30, "call_wall_seconds": 60, "work_seconds": 70, "outer_seconds": 80,
         "live_extraction": False, "quality_certified": False, "automatic_successor": False}


def helpers() -> Any:
    """只复用已审文件函数及领取后凭据入口；不调用其准备或registry扫描。"""
    parent = str(LEGACY.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location("v_off_pilot_helpers", LEGACY)
    if spec is None or spec.loader is None:
        raise ValueError("pilot_reviewed_helper_required")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    bridge = sys.modules.get("explicit_review_bridge")
    if bridge is None or Path(str(bridge.__file__)).resolve() != LEGACY.parent / "explicit_review_bridge.py":
        raise ValueError("pilot_actual_helper_required")
    return module


def now() -> datetime:
    return datetime.now(timezone.utc)


def contracts() -> tuple[Any, tuple[Any, ...], dict, dict]:
    """给定标签只编译本探针唯一公开候选；不调用E或复制旧场输入。"""
    from langchain_core.utils.function_calling import convert_to_openai_tool
    from notalone.memory_extraction.flow import _to_fact
    from notalone.memory_extraction.grounded import compile_labels_v4
    from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
    from notalone.memory_extraction.verification_adapters import (
        SOURCE_PROOF_PROMPT, SOURCE_VERIFICATION_PROOF_SCHEMA, SOURCE_VERIFICATION_SYSTEM_PROMPT,
        _verification_text,
    )
    message = MessageRef(UUID("33333333-3333-4333-8333-333333333333"), "我刚到家。", MessageSender.CONTACT,
                         datetime(2026, 10, 16, 0, tzinfo=timezone(timedelta(hours=8))))
    window = ExtractionWindow(UUID("11111111-1111-4111-8111-111111111111"),
                              UUID("22222222-2222-4222-8222-222222222222"), (message,), (message.message_id,))
    draft: dict[str, Any] = {"units": {"0:0": {"kind": "event", "subject": "contact", "topic": "other",
             "dependency": None, "unresolved": False, "confidence": 0.9,
             "sensitivity": "none", "ambiguity_codes": []}}}
    candidate, = compile_labels_v4(window, draft)
    facts = (_to_fact(candidate),)
    prompt = SOURCE_VERIFICATION_SYSTEM_PROMPT + SOURCE_PROOF_PROMPT
    wire = {"model": "deepseek-flash", "temperature": 0.0, "stream": False,
            "thinking": {"type": "disabled"}, "reasoning_effort": "none",
            "messages": [{"role": "system", "content": prompt},
                         {"role": "user", "content": _verification_text(window, facts)}],
            "tools": [convert_to_openai_tool(SOURCE_VERIFICATION_PROOF_SCHEMA)],
            "tool_choice": {"type": "function", "function": {"name": "SourceVerificationOutput"}}}
    return window, facts, {"window": _json_value(window), "given_v4_labels": draft,
                           "candidate": candidate, "verification_prompt": prompt,
                           "verification_schema": SOURCE_VERIFICATION_PROOF_SCHEMA}, wire


def _source_names() -> set[str]:
    # 这些包的__init__也导入同包实现；保留封闭源码超集，不读取业务数据。
    names = {path.relative_to(ROOT).as_posix()
             for name in ("memory_extraction", "memory", "memory_trace", "ledger")
             for path in (ROOT / "backend/src/notalone" / name).rglob("*.py")}
    return names | {"backend/pyproject.toml", "backend/src/notalone/__init__.py",
        "backend/src/notalone/scopes.py", "backend/src/notalone/runtime_config.py", PLAN, IMPLEMENTATION,
        Path(__file__).resolve().relative_to(ROOT).as_posix(), LEGACY.relative_to(ROOT).as_posix(),
        (LEGACY.parent / "explicit_review_bridge.py").relative_to(ROOT).as_posix()}


def _disabled_env() -> None:
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1":
        raise ValueError("pilot_disabled_dotenv_required")


def prepare(*, directory: Path, absolute_start: datetime) -> dict:
    _disabled_env()
    if not isinstance(absolute_start, datetime) or absolute_start.utcoffset() is None:
        raise ValueError("pilot_aware_start_required")
    helper = helpers()
    _, _, public, wire = contracts()
    directory = directory.resolve()
    directory.mkdir(mode=0o700)
    identity = helper.private_directory(directory)
    frozen = {"format": PROTOCOL, "state": "prepared_only", "run_id": str(uuid4()), "nonce": str(uuid4()),
              "fixed": json.loads(json.dumps(FIXED)), "repo_root": str(ROOT), "directory": str(directory),
              "directory_identity": list(identity), "absolute_start": absolute_start.isoformat(),
              "work_end": (absolute_start + timedelta(seconds=70)).isoformat(),
              "absolute_end": (absolute_start + timedelta(seconds=80)).isoformat(),
              "source_hashes": {name: helper.file_digest(ROOT / name) for name in sorted(_source_names())},
              "installed_versions": {name: version(name) for name in helper.PACKAGES},
              **public, "wire_contract": wire, "wire_sha256": helper.digest(wire),
              "quality_certified": False, "automatic_successor": False}
    helper.publish(directory / "freeze.json", frozen)
    return frozen


def validate(frozen: dict) -> tuple[datetime, datetime]:
    _disabled_env()
    helper = helpers()
    for name in ("notalone.memory_extraction.grounded", "notalone.memory_extraction.flow",
                 "notalone.memory_extraction.models", "notalone.memory_extraction.verification_adapters",
                 "notalone.memory_extraction.evaluation_http_budget", "notalone.memory_extraction.evaluation_owned_deadline",
                 "notalone.memory_extraction.evaluation_records", "notalone.memory_trace.transport"):
        module = sys.modules.get(name)
        if module is not None and Path(str(module.__file__)).resolve() != ROOT / "backend/src" / (name.replace(".", "/") + ".py"):
            raise ValueError("pilot_actual_source_root_required")
    start, work_end, end = (datetime.fromisoformat(frozen[key]) for key in ("absolute_start", "work_end", "absolute_end"))
    if (frozen["format"] != PROTOCOL or frozen["state"] != "prepared_only"
            or helper.digest(frozen["fixed"]) != helper.digest(FIXED) or frozen["repo_root"] != str(ROOT)
            or frozen["quality_certified"] is not False or frozen["automatic_successor"] is not False
            or any(item.utcoffset() is None for item in (start, work_end, end))
            or work_end - start != timedelta(seconds=70) or end - start != timedelta(seconds=80)
            or not start <= now() < work_end):
        raise ValueError("pilot_fixed_window_required")
    directory = Path(frozen["directory"])
    if directory != directory.resolve() or list(helper.private_directory(directory)) != frozen["directory_identity"]:
        raise ValueError("pilot_directory_binding_changed")
    if set(frozen["source_hashes"]) != _source_names():
        raise ValueError("pilot_source_closure_changed")
    for name, expected in frozen["source_hashes"].items():
        if helper.file_digest(ROOT / name) != expected:
            raise ValueError("pilot_source_drift")
    if frozen["installed_versions"] != {name: version(name) for name in helper.PACKAGES}:
        raise ValueError("pilot_version_drift")
    _, _, public, wire = contracts()
    if (any(helper.digest(frozen[key]) != helper.digest(value) for key, value in public.items())
            or frozen["wire_contract"] != wire or frozen["wire_sha256"] != helper.digest(wire)):
        raise ValueError("pilot_contract_drift")
    return work_end, end


def _authorization(approval: dict, frozen: dict, expected: str) -> None:
    if (type(approval) is not dict or approval.get("user_authorized") is not True
            or approval != {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected}):
        raise ValueError("pilot_bound_authorization_required")


def verify_claim(frozen: dict) -> None:
    """唯一loader调用前核对本轮已领取、零请求、未关闭的独立台账。"""
    helper = helpers()
    run = Path.home() / ".notalone-memory-evaluations" / frozen["run_id"]
    helper.private_directory(run)
    if not (run / "claimed").is_file() or os.path.lexists(run / "closed"):
        raise ValueError("pilot_fresh_claim_required")
    with sqlite3.connect((run / "budget.sqlite3").as_uri() + "?mode=ro", uri=True) as connection:
        rows = connection.execute("SELECT manifest, closed FROM state").fetchall()
        count = connection.execute("SELECT count(*) FROM requests").fetchone()[0]
    manifest = json.loads(rows[0][0]) if len(rows) == 1 else {}
    if (len(rows) != 1 or rows[0][1] != 0 or count != 0
            or manifest.get("run_id") != frozen["run_id"] or type(manifest.get("request_limit")) is not int
            or manifest["request_limit"] != 1 or manifest.get("allowed_endpoints") != [ENDPOINT]
            or manifest.get("config_sha256") != helper.digest(frozen)
            or manifest.get("output_directory") != frozen["directory"]):
        raise ValueError("pilot_claim_manifest_changed")


class PilotDeadline(_OwnedPublicDeadline):
    CALL_SECONDS = 60
    BATCH_SECONDS = 70
    REQUEST_LIMIT = 1
    CODE_PREFIX = "v_off_pilot"


class _PilotRecords:
    """独立探针格式；只捕获SDK正文与受控状态，绝不保存headers。"""
    def __init__(self, frozen: dict, budget: EvaluationBudget):
        self.frozen, self.budget = frozen, budget
        self.events: list[dict] = []
        self.requested = self.responded = False

    def belongs_to(self, budget: EvaluationBudget) -> bool:
        return self.budget is budget

    def save(self, kind: str, sequence: int, payload: dict) -> None:
        sanitized, removed = _redact(_json_value(payload), request=kind == "provider_request")
        event = {"format": PROTOCOL, "run_id": self.frozen["run_id"], "event_sequence": len(self.events) + 1,
                 "request_sequence": sequence, "kind": kind, "payload": sanitized, "removed_paths": removed}
        event["payload_sha256"] = helpers().digest(sanitized)
        try:
            helpers().publish(Path(self.frozen["directory"]) / f"pilot-event-{len(self.events) + 1:06d}.json", event)
        except Exception:
            raise EvaluationBudgetAbort("pilot_record_unavailable") from None
        self.events.append(event)

    def capture_request(self, sequence: int, request: httpx.Request) -> None:
        self.save("provider_request", sequence, {"endpoint": str(request.url), "body": json.loads(request.content)})
        self.requested = True

    def capture_response(self, sequence: int, response: httpx.Response) -> None:
        self.responded = True
        if len(response.content) > 8 * 1024 * 1024:
            raise EvaluationBudgetAbort("pilot_response_too_large")
        try:
            body = json.loads(response.content)
        except (ValueError, UnicodeError):
            self.save("provider_response", sequence, {"status_code": response.status_code, "body_not_saved": "invalid_json"})
            raise EvaluationBudgetAbort("pilot_invalid_json") from None
        self.save("provider_response", sequence, {"status_code": response.status_code, "body": body})

    def capture_failure(self, sequence: int, kind: str) -> None:
        self.save("provider_failure", sequence, {"failure_kind": kind, "response_obtained": False})


class _PilotContract:
    def __init__(self, frozen: dict):
        self.frozen = frozen

    def check_request(self, request: httpx.Request) -> None:
        try:
            validate(self.frozen)
            if (request.method != "POST" or str(request.url) != ENDPOINT
                    or json.loads(request.content) != self.frozen["wire_contract"]
                    or request.extensions.get("timeout", {}).get("read") != 30):
                raise ValueError("wire_changed")
        except Exception:
            raise EvaluationBudgetAbort("pilot_wire_or_freeze_changed") from None

    def observe_response(self, response: httpx.Response) -> None:
        try:
            value = response.json()
            if (response.status_code != 200 or value.get("model") != "deepseek-flash"
                    or value.get("object") != "chat.completion" or len(value["choices"]) != 1
                    or not isinstance(value.get("id"), str) or not value["id"]
                    or type(value.get("created")) is not int or value["created"] < 0
                    or type(value["choices"][0].get("index")) is not int or value["choices"][0]["index"] != 0
                    or value["choices"][0]["message"].get("role") != "assistant"
                    or value["choices"][0].get("finish_reason") not in {"stop", "length", "tool_calls", "content_filter"}):
                raise ValueError("response_changed")
        except Exception:
            raise EvaluationBudgetAbort("pilot_response_contract_failed") from None


def worker(*, freeze_path: Path, expected_sha256: str, approval: dict,
           synthetic_transport: httpx.MockTransport | None = None,
           credential_loader: Callable[[], str] | None = None) -> dict:
    _disabled_env()
    helper = helpers()
    if helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("pilot_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    _authorization(approval, frozen, expected_sha256)
    if (synthetic_transport is not None and type(synthetic_transport) is not httpx.MockTransport
            or synthetic_transport is None and credential_loader is not None):
        raise ValueError("pilot_exact_mock_only")
    work_end, _ = validate(frozen)
    directory = Path(frozen["directory"])
    if freeze_path.resolve() != directory / "freeze.json":
        raise ValueError("pilot_directory_binding_changed")
    from langsmith import get_tracing_context, tracing_context
    from notalone.memory_trace.context import current_trace
    if get_tracing_context().get("enabled") is True or current_trace() is not None:
        raise ValueError("pilot_external_tracing_forbidden")
    control = PilotDeadline(receipt=directory / "deadline-receipt.json",
                            remaining_batch_seconds=min(70, (work_end - now()).total_seconds()))
    if synthetic_transport is None and not control.live_worker:
        raise ValueError("pilot_owned_worker_required")
    budget = EvaluationBudget.create(run_id=UUID(frozen["run_id"]), output_directory=directory,
        request_limit=1, allowed_endpoints=(ENDPOINT,), config_sha256=helper.digest(frozen))
    records = _PilotRecords(frozen, budget)
    client = None
    status = "failed"
    stopped: str | None = None
    payloads: tuple[dict[str, Any], ...] = ()
    began = time.monotonic()
    proof: dict | None = None
    cleanup: list[str] = []
    try:
        helper.publish(directory / "pilot-manifest.json", {"format": PROTOCOL, "frozen_config": frozen,
                       "budget": budget.snapshot(), "worker_pid": os.getpid(),
                       "authorization_sha256": helper.digest(approval)})
        with budget.batch(), tracing_context(enabled=False, parent=False):
            validate(frozen)
            verify_claim(frozen)
            control.start(budget, synthetic=synthetic_transport is not None)
            key = (credential_loader or helper.read_credential)()
            if not isinstance(key, str) or not key.strip():
                raise ValueError("empty_credential")
            validate(frozen)
            client = httpx.Client(transport=EvaluationTransport(budget,
                synthetic_transport=synthetic_transport, records=cast(Any, records), contract=cast(Any, _PilotContract(frozen))),
                trust_env=False, follow_redirects=False, timeout=httpx.Timeout(30, connect=10, write=10, pool=10))
            from langchain_deepseek import ChatDeepSeek
            from pydantic import SecretStr
            from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
            from notalone.memory_extraction.verification import SourceVerificationMode
            model = ChatDeepSeek(api_key=SecretStr(key), base_url="https://api.deepseek.com", model="deepseek-flash",
                temperature=0.0, timeout=30, max_retries=0,
                extra_body={"thinking": {"type": "disabled"}, "reasoning_effort": "none"}, http_client=client)
            window, facts, _, _ = contracts()
            helper.publish(directory / "activation.json", {"format": PROTOCOL, "run_id": frozen["run_id"],
                           "worker_pid": os.getpid(), "process_group": os.getpgrp(), "synthetic": synthetic_transport is not None})
            with control.invocation():
                payloads = LangChainSourceVerificationRuntime(model=model, provider="DeepSeek",
                    verification_mode=SourceVerificationMode.NULLABLE_PROOF_V1).verify(window=window, facts=facts)
            status = "completed"
    except BaseException as error:
        status = "unknown" if records.requested and not records.responded else "failed"
        stopped = type(error).__name__
    finally:
        try:
            budget.close()
            proof = budget.closed_receipt()
        except BaseException:
            cleanup.append("budget_close_unknown")
        if client is not None:
            try:
                client.close()
            except BaseException:
                cleanup.append("client_close_unknown")
        try:
            control.finish()
        except BaseException:
            cleanup.append("deadline_finish_unknown")
    result = {"format": PROTOCOL, "run_id": frozen["run_id"], "worker_pid": os.getpid(), "status": status,
              "stopped_code": stopped, "verification": _json_value(payloads), "budget": proof,
              "closed": proof is not None, "close_unknown": proof is None, "cleanup_codes": cleanup,
              "elapsed_seconds": time.monotonic() - began, "quality_certified": False, "automatic_successor": False}
    helper.publish(directory / "result.json", result)
    return result


def launch(*, freeze_path: Path, expected_sha256: str, approval_path: Path) -> dict:
    helper = helpers()
    if helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("pilot_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    _, end = validate(frozen)
    _authorization(helper.read_private(approval_path), frozen, expected_sha256)
    from notalone.memory_extraction.evaluation_owned_process import owned_group_exists, reap_owned_group
    directory = Path(frozen["directory"])
    if any(os.path.lexists(directory / name) for name in (
            "owned-worker.json", "activation.json", "pilot-manifest.json", "result.json", "finish.json", "deadline-receipt.json")):
        raise ValueError("pilot_already_started")
    began = time.monotonic()
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "NOTALONE_DISABLE_DOTENV": "1",
                   "PYTHONPATH": str(ROOT / "backend/src")}
    child = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "worker", str(freeze_path),
        expected_sha256, str(approval_path)], cwd=ROOT, env=environment, stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    timed_out = False
    try:
        helper.publish(directory / "owned-worker.json", {"run_id": frozen["run_id"], "worker_pid": child.pid,
                                                        "process_group": child.pid})
        assert child.stdin is not None
        try:
            child.stdin.write(b"start\n")
            child.stdin.flush()
            child.stdin.close()
        except BrokenPipeError:
            pass
        try:
            child.wait(timeout=max(0, min(77, (end - now()).total_seconds() - 3)))
        except subprocess.TimeoutExpired:
            timed_out = True
    finally:
        if child.stdin is not None and not child.stdin.closed:
            try:
                child.stdin.close()
            except BrokenPipeError:
                pass
        reap_owned_group(child)
    result = {}
    try:
        result = helper.read_private(directory / "result.json")
    except (OSError, ValueError):
        pass
    proof = result.get("budget")
    closed = (result.get("format") == PROTOCOL and result.get("run_id") == frozen["run_id"]
              and type(proof) is dict and proof.get("run_id") == frozen["run_id"] and proof.get("closed") is True
              and type(proof.get("request_limit")) is int and proof["request_limit"] == 1
              and type(proof.get("reserved_requests")) is int and 0 <= proof["reserved_requests"] <= 1
              and proof.get("config_sha256") == helper.digest(frozen)
              and type(result.get("worker_pid")) is int and result["worker_pid"] == child.pid
              and proof.get("allowed_endpoints") == [ENDPOINT])
    if not closed:
        try:
            deadline = helper.read_private(directory / "deadline-receipt.json")
            closed = (deadline.get("run_id") == frozen["run_id"] and type(deadline.get("worker_pid")) is int
                      and deadline["worker_pid"] == child.pid
                      and deadline.get("closed") is True and type(deadline.get("request_limit")) is int
                      and deadline["request_limit"] == 1 and type(deadline.get("reserved_requests")) is int
                      and 0 <= deadline["reserved_requests"] <= 1)
        except (OSError, ValueError):
            pass
    finish = {"format": PROTOCOL, "run_id": frozen["run_id"], "worker_pid": child.pid, "process_group": child.pid,
              "exit_code": child.returncode, "outer_timed_out": timed_out, "closed": closed, "close_unknown": not closed,
              "worker_gone": child.poll() is not None and not owned_group_exists(child),
              "status": result.get("status", "unknown"), "elapsed_seconds": time.monotonic() - began,
              "quality_certified": False, "automatic_successor": False}
    helper.publish(directory / "finish.json", finish)
    return finish


if __name__ == "__main__":
    try:
        _disabled_env()
        if len(sys.argv) == 4 and sys.argv[1] == "prepare":
            value = prepare(directory=Path(sys.argv[2]), absolute_start=datetime.fromisoformat(sys.argv[3]))
            print(json.dumps({"run_id": value["run_id"], "freeze_sha256": helpers().file_digest(Path(value["directory"]) / "freeze.json")}))
        elif len(sys.argv) == 5 and sys.argv[1] in {"worker", "launch"}:
            if sys.argv[1] == "worker":
                if sys.stdin.buffer.readline(7) != b"start\n":
                    raise ValueError("pilot_owned_parent_release_required")
                value = worker(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3],
                               approval=helpers().read_private(Path(sys.argv[4])))
            else:
                value = launch(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval_path=Path(sys.argv[4]))
            print(json.dumps({"closed": value["closed"], "status": value["status"], "quality_certified": False}))
        else:
            raise ValueError("pilot_explicit_command_required")
    except BaseException as error:
        print(json.dumps({"error_type": type(error).__name__}))
        raise SystemExit(1) from None
