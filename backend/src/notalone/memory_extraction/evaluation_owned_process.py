"""固定公开评测runner共用的领取证据与自有进程组控制，不创建预算或读取凭据。"""
from dataclasses import dataclass
from datetime import datetime
import os
import json
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
from typing import Any, Callable
from .evaluation_provider_contract import (
    MIXED_PLAN, MIXED_MODE, MIXED_STAGE, MIXED_KIND, MIXED_REQUEST_VERSION, mixed_phase_policy,
    REFERENCE21_V4_PLAN, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE, REFERENCE21_V4_KIND,
    SEMANTIC4_PLAN, SEMANTIC4_MODE, SEMANTIC4_STAGE, SEMANTIC4_KIND, SEMANTIC4_PROMPT_PROFILE,
    UNIQUENESS_PLAN, UNIQUENESS_MODE, UNIQUENESS_STAGE, UNIQUENESS_KIND, UNIQUENESS_E_PROFILE,
)


@dataclass(frozen=True)
class _FixedPublicControl:
    request_limit: int
    outer_seconds: int
    planned_windows: int
    required_claims: int
    mode: str
    stage: str
    positions: tuple[int, ...]
    fallback_event_limit: int = 2048
    execution_plan: str | None = None
    reference_version: str | None = None


_PROFILES = {
    UNIQUENESS_KIND: _FixedPublicControl(42, 14400, 21, 28, UNIQUENESS_MODE, UNIQUENESS_STAGE,
                                       tuple(range(21)), 2048, UNIQUENESS_PLAN, "source-fidelity-v2"),
    SEMANTIC4_KIND: _FixedPublicControl(42, 14400, 21, 28, SEMANTIC4_MODE, SEMANTIC4_STAGE,
                                      tuple(range(21)), 2048, SEMANTIC4_PLAN, "source-fidelity-v2"),
    REFERENCE21_V4_KIND: _FixedPublicControl(42, 14400, 21, 28, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE,
                                           tuple(range(21)), 2048, REFERENCE21_V4_PLAN, "source-fidelity-v2"),
    MIXED_KIND: _FixedPublicControl(280, 86400, 140, 138, MIXED_MODE, MIXED_STAGE,
                                  tuple(range(140)), 16384, MIXED_PLAN, "source-fidelity-v2"),
    "remaining8": _FixedPublicControl(16, 2400, 8, 13, "deepseek_bounded_remaining8", "remaining8",
                                     (19, 20, 13, 14, 15, 16, 17, 18)),
    "ambiguity2": _FixedPublicControl(4, 5400, 2, 3, "deepseek_bounded_ambiguity2_v3", "ambiguity2-v3", (6, 9)),
    "main16": _FixedPublicControl(32, 43200, 16, 18, "deepseek_bounded_main16_v3", "main16-v3",
                                 tuple(range(16))),
    "full140-v4": _FixedPublicControl(280, 86400, 140, 138, "deepseek_bounded_full140_v4_source_v2",
                                     "full140-v4-source-v2", tuple(range(140)), 16384,
                                     "full140-grounded-v4-source-v2", "source-fidelity-v2"),
}


def owned_group_exists(child: subprocess.Popen, *, permission_deadline: float | None = None) -> bool:
    if permission_deadline is None:
        permission_deadline = time.monotonic() + .1
    permission_error: PermissionError | None = None
    while True:
        child.poll()
        try:
            os.killpg(child.pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError as error:
            # 退出中的组可短暂不可查询；EPERM保持未知，仅实际ESRCH才判为消失。
            if permission_error is None:
                permission_error = error
            remaining = permission_deadline - time.monotonic()
            if remaining <= 0:
                raise permission_error
            time.sleep(min(.01, remaining))


def reap_owned_group(child: subprocess.Popen) -> None:
    # leader已退出也须收尾同组后代；仅操作本轮start_new_session创建的组。
    for kind in (signal.SIGTERM, signal.SIGKILL):
        if not owned_group_exists(child):
            return
        try:
            os.killpg(child.pid, kind)
        except ProcessLookupError:
            return
        end = time.monotonic() + 1
        while owned_group_exists(child, permission_deadline=end) and time.monotonic() < end:
            time.sleep(.01)


def _launch_owned_public_worker(*, frozen: dict, script: Path, root: Path, helper: Any,
                                freeze_path: Path, expected_sha256: str, approval_path: Path, end: datetime,
                                clock: Callable[[], datetime], kind: str) -> dict:
    profile = _PROFILES[kind]
    request_limit, outer_seconds = profile.request_limit, profile.outer_seconds
    planned_windows, required_claims = profile.planned_windows, profile.required_claims
    directory = Path(frozen["directory"])
    # 环境不传任何真实凭据；只有worker领取后读取既有显式三字段来源。
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "NOTALONE_DISABLE_DOTENV": "1",
                   "PYTHONPATH": str(root / "backend/src")}
    began = time.monotonic()
    child = subprocess.Popen([sys.executable, "-B", str(script), "worker",
        str(freeze_path), expected_sha256, str(approval_path)], cwd=root, env=environment,
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    owner = {"pid": child.pid, "process_group": child.pid, "run_id": frozen["run_id"]}
    try:
        helper.publish(directory / "owned-worker.json", owner)
        assert child.stdin is not None
        child.stdin.write(b"start\n"); child.stdin.flush(); child.stdin.close()
        remaining = min(outer_seconds - 10, max(0, (end - clock()).total_seconds() - 10))
        try:
            code = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            code = None
    finally:
        if child.stdin is not None and not child.stdin.closed:
            try:
                child.stdin.close()
            except BrokenPipeError:
                pass
        reap_owned_group(child)
    result_path, deadline_path = directory / "result.json", directory / "deadline-receipt.json"
    records = []
    for record_path in (result_path, deadline_path):
        try:
            value = helper.read_private(record_path) if record_path.exists() else {}
            records.append(value if type(value) is dict else {})
        except (OSError, ValueError):
            records.append({})
    result, deadline = records
    completion = result.get("receipt")
    budget = completion.get("budget") if type(completion) is dict else {}
    def closed_receipt(value):
        return (type(value) is dict and value.get("run_id") == frozen["run_id"] and value.get("closed") is True
                and type(value.get("request_limit")) is int and value["request_limit"] == request_limit
                and type(value.get("reserved_requests")) is int
                and 0 <= value["reserved_requests"] <= request_limit)
    closed = (closed_receipt(budget) and (kind not in {MIXED_KIND, REFERENCE21_V4_KIND, SEMANTIC4_KIND, UNIQUENESS_KIND} or (
        type(result.get("worker_pid")) is int and result["worker_pid"] == child.pid
        and result.get("execution_plan") == profile.execution_plan))) or (type(deadline.get("worker_pid")) is int
                                       and deadline["worker_pid"] == child.pid and closed_receipt(deadline))
    states = ["unrun"] * planned_windows
    if isinstance(result.get("outcomes"), list) and len(result["outcomes"]) == planned_windows:
        states = [row["status"] if type(row) is dict and row.get("status") in {"unrun", "unknown", "completed", "empty", "failed"}
                  else "unknown" for row in result["outcomes"]]
    else:
        event_paths = sorted((directory / "evaluation").glob("event-??????.json"))
        if len(event_paths) > profile.fallback_event_limit:
            # 超出已支持日志边界时整批未知，不能把截断后已开始的窗口称为unrun。
            states = ["unknown"] * planned_windows
            event_paths = []
        for event_path in event_paths:
            try:
                event = helper.read_private(event_path)
                if type(event) is not dict:
                    raise ValueError("invalid_event_record")
                position = event.get("case_position")
                if event.get("kind") == "case_started" and type(position) is int and 0 <= position < planned_windows:
                    states[position] = "unknown"
            except (OSError, ValueError):
                states = ["unknown"] * planned_windows
                break
    receipt = {**owner, "exit_code": child.returncode, "outer_timed_out": code is None,
               "stopped_code": "outer_wall_deadline" if code is None else (result or {}).get("stopped_code"),
               "worker_gone": child.poll() is not None and not owned_group_exists(child), "closed": closed,
               "close_unknown": not closed, "elapsed_seconds": time.monotonic() - began,
               "planned_windows": planned_windows, "required_claims": required_claims,
               "case_statuses": [{**selection, "status": status} for selection, status in zip(frozen["selection"], states)],
               "quality_certified": False, "automatic_successor": False}
    helper.publish(directory / "finish.json", receipt)
    return receipt



def _verify_owned_public_claim(*, frozen: dict, helper: Any, kind: str) -> None:
    profile = _PROFILES[kind]
    run = Path.home() / ".notalone-memory-evaluations" / frozen["run_id"]
    helper.private_directory(run)
    if not (run / "claimed").is_file() or os.path.lexists(run / "closed"):
        raise ValueError(kind + "_fresh_claim_required")
    record = helper.read_private(Path(frozen["directory"]) / "evaluation/manifest.json")
    with sqlite3.connect((run / "budget.sqlite3").as_uri() + "?mode=ro", uri=True) as connection:
        states = connection.execute("SELECT manifest, closed FROM state").fetchall()
        count = connection.execute("SELECT count(*) FROM requests").fetchone()[0]
    config = record["frozen_config"]
    budget = json.loads(states[0][0]) if len(states) == 1 else {}
    if (len(states) != 1 or states[0][1] != 0 or count != 0
            or budget.get("run_id") != frozen["run_id"] or type(budget.get("request_limit")) is not int
            or budget["request_limit"] != profile.request_limit
            or budget.get("allowed_endpoints") != ["https://api.deepseek.com/chat/completions"]
            or budget.get("config_sha256") != helper.digest(config)
            or budget.get("output_directory") != str(Path(frozen["directory"]) / "evaluation")
            or config.get("mode") != profile.mode or config.get("stage") != profile.stage
            or config.get("selected_case_positions") != list(profile.positions)
            or any(type(position) is not int for position in config.get("selected_case_positions", []))
            or profile.execution_plan is not None and (
                config.get("execution_plan") != profile.execution_plan
                or config.get("reference_version") != profile.reference_version)
            or kind in {MIXED_KIND, REFERENCE21_V4_KIND, SEMANTIC4_KIND, UNIQUENESS_KIND} and (
                config.get("phase_request_version") != MIXED_REQUEST_VERSION
                or config.get("phase_request_policy") != mixed_phase_policy()
                or config.get("tool_choice") != {
                    "extraction": {"mode": "omitted", "name": "GroundedMemoryLabelsV4"},
                    "verification": {"mode": "forced", "name": "SourceVerificationOutput"}})
            or config.get("source_hashes") != frozen["source_hashes"]
            or kind in {SEMANTIC4_KIND, UNIQUENESS_KIND} and (config.get("verification_mode") != "legacy-v4"
                or config.get("verification_prompt_profile") != SEMANTIC4_PROMPT_PROFILE)
            or kind == UNIQUENESS_KIND and config.get("extraction_prompt_profile") != UNIQUENESS_E_PROFILE
            or kind != UNIQUENESS_KIND and "extraction_prompt_profile" in config
            or config.get("extraction_window_contracts") != frozen["extraction_window_contracts"]):
        raise ValueError(kind + "_claim_manifest_changed")

