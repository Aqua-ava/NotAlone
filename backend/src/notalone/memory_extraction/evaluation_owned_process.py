"""固定公开评测runner共用的领取证据与自有进程组控制，不创建预算或读取凭据。"""
from dataclasses import dataclass
from datetime import datetime
import hashlib
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
    FULL140_E2_PLAN, FULL140_E2_MODE, FULL140_E2_STAGE, FULL140_E2_KIND,
    MIXED_PLAN, MIXED_MODE, MIXED_STAGE, MIXED_KIND, MIXED_REQUEST_VERSION, mixed_phase_policy,
    REFERENCE21_V4_PLAN, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE, REFERENCE21_V4_KIND,
    SEMANTIC4_PLAN, SEMANTIC4_MODE, SEMANTIC4_STAGE, SEMANTIC4_KIND, SEMANTIC4_PROMPT_PROFILE,
    UNIQUENESS_PLAN, UNIQUENESS_MODE, UNIQUENESS_STAGE, UNIQUENESS_KIND, UNIQUENESS_E_PROFILE,
    BOUNDED_RUNTIME_KIND, BOUNDED_RUNTIME_MODE, BOUNDED_RUNTIME_STAGE,
    REFERENCE16_PRO_PLAN, REFERENCE16_PRO_MODE, REFERENCE16_PRO_STAGE, REFERENCE16_PRO_KIND,
    REFERENCE16_PRO_TEACHING_PLAN, REFERENCE16_PRO_TEACHING_MODE, REFERENCE16_PRO_TEACHING_STAGE,
    REFERENCE16_PRO_TEACHING_KIND, REFERENCE16_TEACHING_E_PROFILE,
    REFERENCE16_PRO_RETENTION_PLAN, REFERENCE16_PRO_RETENTION_MODE, REFERENCE16_PRO_RETENTION_STAGE,
    REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_RETENTION_V_PROFILE,
    REFERENCE16_PRO_RETENTION_V_THINKING_PLAN, REFERENCE16_PRO_RETENTION_V_THINKING_MODE,
    REFERENCE16_PRO_RETENTION_V_THINKING_STAGE, REFERENCE16_PRO_RETENTION_V_THINKING_KIND,
    REFERENCE16_V_THINKING_REQUEST_VERSION, reference16_v_thinking_phase_policy,
)
from .evaluation_bounded_cases import BOUNDED_RUNTIME_PLAN


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
    REFERENCE16_PRO_RETENTION_V_THINKING_KIND: _FixedPublicControl(32, 14400, 16, 18,
        REFERENCE16_PRO_RETENTION_V_THINKING_MODE, REFERENCE16_PRO_RETENTION_V_THINKING_STAGE,
        tuple(range(16)), 2048, REFERENCE16_PRO_RETENTION_V_THINKING_PLAN, "source-fidelity-v2"),
    REFERENCE16_PRO_RETENTION_KIND: _FixedPublicControl(32, 14400, 16, 18,
        REFERENCE16_PRO_RETENTION_MODE, REFERENCE16_PRO_RETENTION_STAGE,
        tuple(range(16)), 2048, REFERENCE16_PRO_RETENTION_PLAN, "source-fidelity-v2"),
    REFERENCE16_PRO_TEACHING_KIND: _FixedPublicControl(32, 14400, 16, 18,
        REFERENCE16_PRO_TEACHING_MODE, REFERENCE16_PRO_TEACHING_STAGE,
        tuple(range(16)), 2048, REFERENCE16_PRO_TEACHING_PLAN, "source-fidelity-v2"),
    REFERENCE16_PRO_KIND: _FixedPublicControl(32, 14400, 16, 18, REFERENCE16_PRO_MODE, REFERENCE16_PRO_STAGE,
                                             tuple(range(16)), 2048, REFERENCE16_PRO_PLAN, "source-fidelity-v2"),
    FULL140_E2_KIND: _FixedPublicControl(280, 86400, 140, 138, FULL140_E2_MODE, FULL140_E2_STAGE,
                                      tuple(range(140)), 16384, FULL140_E2_PLAN, "source-fidelity-v2"),
    BOUNDED_RUNTIME_KIND: _FixedPublicControl(30, 14400, 15, 15, BOUNDED_RUNTIME_MODE, BOUNDED_RUNTIME_STAGE,
                                            tuple(range(15)), 2048, BOUNDED_RUNTIME_PLAN, BOUNDED_RUNTIME_PLAN),
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
    closed = (closed_receipt(budget) and (kind not in {FULL140_E2_KIND, MIXED_KIND, REFERENCE21_V4_KIND, SEMANTIC4_KIND, UNIQUENESS_KIND, BOUNDED_RUNTIME_KIND, REFERENCE16_PRO_KIND, REFERENCE16_PRO_TEACHING_KIND, REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_PRO_RETENTION_V_THINKING_KIND} or (
        type(result.get("worker_pid")) is int and result["worker_pid"] == child.pid
        and result.get("execution_plan") == profile.execution_plan))) or (type(deadline.get("worker_pid")) is int
                                       and deadline["worker_pid"] == child.pid and closed_receipt(deadline)
                                       and (kind != BOUNDED_RUNTIME_KIND
                                            or deadline.get("execution_plan") == BOUNDED_RUNTIME_PLAN))
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
    if kind in {BOUNDED_RUNTIME_KIND, REFERENCE16_PRO_KIND, REFERENCE16_PRO_TEACHING_KIND, REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_PRO_RETENTION_V_THINKING_KIND}:
        receipt["execution_plan"] = profile.execution_plan
    if kind in {REFERENCE16_PRO_KIND, REFERENCE16_PRO_TEACHING_KIND, REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_PRO_RETENTION_V_THINKING_KIND}:
        receipt["optional_claims"] = 1
    helper.publish(directory / "finish.json", receipt)
    return receipt



def _verify_owned_public_claim(*, frozen: dict, helper: Any, kind: str,
                               actual_windows: tuple | None = None) -> None:
    profile = _PROFILES[kind]
    v_thinking = kind == REFERENCE16_PRO_RETENTION_V_THINKING_KIND
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
            or kind in {FULL140_E2_KIND, MIXED_KIND, REFERENCE21_V4_KIND, SEMANTIC4_KIND, UNIQUENESS_KIND} and (
                config.get("phase_request_version") != MIXED_REQUEST_VERSION
                or config.get("phase_request_policy") != mixed_phase_policy()
                or config.get("tool_choice") != {
                    "extraction": {"mode": "omitted", "name": "GroundedMemoryLabels" if kind == FULL140_E2_KIND else "GroundedMemoryLabelsV4"},
                    "verification": {"mode": "forced", "name": "SourceVerificationOutput"}})
            or kind in {REFERENCE16_PRO_KIND, REFERENCE16_PRO_TEACHING_KIND, REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_PRO_RETENTION_V_THINKING_KIND} and (
                config.get("provider_profile") != ("deepseek-pro-reference16-v-thinking-v1" if v_thinking else "deepseek-pro-reference16-v1")
                or config.get("request_model") != "deepseek-v4-pro"
                or type(config.get("request_contract_version")) is not int or config["request_contract_version"] != (6 if v_thinking else 4)
                or type(config.get("max_tokens")) is not int or config["max_tokens"] != 8192
                or (bool({"thinking", "reasoning_effort"} & set(config))
                    or config.get("phase_request_version") != REFERENCE16_V_THINKING_REQUEST_VERSION
                    or config.get("phase_request_policy") != reference16_v_thinking_phase_policy()
                    if v_thinking else config.get("thinking") != {"type": "disabled"}
                    or config.get("reasoning_effort") != "none"
                    or bool({"phase_request_version", "phase_request_policy"} & set(config)))
                or ((config.get("verification_prompt_profile") != REFERENCE16_RETENTION_V_PROFILE
                     or frozen.get("fixed", {}).get("prompt_profile") != REFERENCE16_RETENTION_V_PROFILE)
                    if kind in {REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_PRO_RETENTION_V_THINKING_KIND} else "verification_prompt_profile" in config)
                or config.get("extraction_mode") != "grounded-v2" or config.get("verification_mode") != "legacy-v4"
                or config.get("base_url") != "https://api.deepseek.com"
                or config.get("endpoint") != "https://api.deepseek.com/chat/completions"
                or type(config.get("timeout")) is not float or config["timeout"] != 300.0
                or type(config.get("max_retries")) is not int or config["max_retries"] != 0
                or type(config.get("temperature")) not in (int, float) or config["temperature"] != 0
                or config.get("stream") is not False or config.get("fallback") is not False
                or config.get("response_identity_policy") != "first_valid_completion_observation_stop_on_change"
                or config.get("verification_prompt_sha256") != frozen["verification_prompt_sha256"]
                or config.get("verification_schema_sha256") != frozen["verification_schema_sha256"]
                or config.get("tool_choice") != {
                    "extraction": {"mode": "forced", "name": "GroundedMemoryLabels"},
                    "verification": {"mode": "omitted" if v_thinking else "forced", "name": "SourceVerificationOutput"}})
            or config.get("source_hashes") != frozen["source_hashes"]
            or kind in {SEMANTIC4_KIND, UNIQUENESS_KIND} and (config.get("verification_mode") != "legacy-v4"
                or config.get("verification_prompt_profile") != SEMANTIC4_PROMPT_PROFILE)
            or kind == FULL140_E2_KIND and (config.get("extraction_mode") != "grounded-v2"
                or config.get("verification_mode") != "legacy-v4" or "verification_prompt_profile" in config
                or config.get("verification_prompt_sha256") != frozen["verification_prompt_sha256"]
                or config.get("verification_schema_sha256") != frozen["verification_schema_sha256"])
            or kind == UNIQUENESS_KIND and config.get("extraction_prompt_profile") != UNIQUENESS_E_PROFILE
            or kind in {REFERENCE16_PRO_TEACHING_KIND, REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_PRO_RETENTION_V_THINKING_KIND} and config.get("extraction_prompt_profile") != REFERENCE16_TEACHING_E_PROFILE
            or kind not in {UNIQUENESS_KIND, BOUNDED_RUNTIME_KIND, REFERENCE16_PRO_TEACHING_KIND, REFERENCE16_PRO_RETENTION_KIND, REFERENCE16_PRO_RETENTION_V_THINKING_KIND} and "extraction_prompt_profile" in config
            or config.get("extraction_window_contracts") != frozen["extraction_window_contracts"]):
        raise ValueError(kind + "_claim_manifest_changed")
    if kind == BOUNDED_RUNTIME_KIND:
        try:
            _verify_bounded_claim(frozen, config, helper, actual_windows)
        except (ValueError, TypeError, KeyError, AttributeError, OSError):
            raise ValueError(kind + "_claim_manifest_changed") from None


def _verify_bounded_claim(frozen: dict, config: dict, helper: Any, actual_windows: tuple | None) -> None:
    """只核Root提供的真实完整Window及封存身份，不从公开正文重造来源。"""
    from uuid import UUID
    from .evaluation_bounded_cases import BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_INPUTS
    from .evaluation_extraction import extraction_contract
    from .evaluation_reference import bounded_window_projection
    from .evaluation_records import canonical_sha256
    from .models import ExtractionWindow
    from .source_proof import bounded_runtime_rule_set_sha256
    from .verification_adapters import source_verification_contract
    from .evaluation_provider_contract import bounded_profile_for_config, EvaluationProviderProfile
    from notalone.memory_trace.context import snapshot
    from notalone.tasks.models import ExtractionRuntimeConfig, ExtractionRuntimeMode

    if (type(actual_windows) is not tuple or len(actual_windows) != 15
            or any(type(window) is not ExtractionWindow for window in actual_windows)
            or snapshot(actual_windows) != frozen["actual_windows"]):
        raise ValueError("bounded_actual_windows_changed")
    content = helper.digest(tuple({"messages": row["messages"], "target_indices": row["target_indices"]}
                                  for row in BOUNDED_RUNTIME_INPUTS))
    current_rules = bounded_runtime_rule_set_sha256()
    profile = bounded_profile_for_config(config)
    if (config.get("extraction_prompt_profile") != profile.bounded_extraction_prompt_profile
            or frozen.get("fixed", {}).get("extraction_prompt_profile") != profile.bounded_extraction_prompt_profile):
        raise ValueError("bounded_frozen_extraction_prompt_changed")
    fixed = frozen.get("fixed", {})
    if fixed.get("provider_profile", EvaluationProviderProfile.DEEPSEEK_BOUNDED_TASK.value) != profile.value:
        raise ValueError("bounded_frozen_provider_changed")
    if profile.is_pro and (
            fixed.get("request_model") != profile.model or fixed.get("response_model") != profile.model
            or type(fixed.get("request_contract_version")) is not int or fixed["request_contract_version"] != profile.bounded_request_version
            or type(fixed.get("max_tokens")) is not int or fixed["max_tokens"] != 8192):
        raise ValueError("bounded_frozen_pro_contract_changed")
    fixture = "backend/src/notalone/memory_extraction/evaluation_bounded_cases.py"
    fixture_sha = hashlib.sha256((Path(__file__).resolve().parents[4] / fixture).read_bytes()).hexdigest()
    plan = [{"case_position": position, "case_name": case.name, "input_sha256": canonical_sha256(window)}
            for position, (case, window) in enumerate(zip(BOUNDED_RUNTIME_CASES, actual_windows, strict=True))]
    if (frozen["plan"] != plan or frozen["plan_sha256"] != helper.digest(plan)
            or config.get("plan_sha256") != helper.digest(plan)
            or frozen["selection"] != [{"case_id": row["id"], "gold_position": position}
                                       for position, row in enumerate(BOUNDED_RUNTIME_INPUTS)]
            or config.get("formal_tasks") != frozen["formal_task_bindings"]
            or config.get("bounded_inputs_sha256") != content or frozen["bounded_inputs_sha256"] != content
            or helper.digest(tuple(bounded_window_projection(window) for window in actual_windows)) != content
            or config.get("runtime_rule_set_sha256") != current_rules or frozen["runtime_rule_set_sha256"] != current_rules
            or frozen["source_hashes"].get(fixture) != fixture_sha
            or config.get("gold_sha256") != frozen["reference_canonical_sha256"]
            or config.get("extraction_mode") != "grounded-v2" or config.get("verification_mode") != "nullable-proof-v3"
            or config.get("base_url") != "https://api.deepseek.com"
            or config.get("endpoint") != "https://api.deepseek.com/chat/completions"
            or config.get("request_model") != profile.model
            or type(config.get("timeout")) is not float or config["timeout"] != 300.0
            or type(config.get("max_retries")) is not int or config["max_retries"] != 0
            or type(config.get("temperature")) not in (int, float) or config["temperature"] != 0
            or config.get("stream") is not False or config.get("fallback") is not False
            or config.get("response_identity_policy") != "first_valid_completion_observation_stop_on_change"
            or {"thinking", "reasoning_effort", "phase_request_version", "phase_request_policy",
                "verification_prompt_profile"} & set(config)
            or config.get("tool_choice") != {
                "extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                "verification": {"mode": profile.bounded_verification_tool_choice, "name": "SourceVerificationOutput"}}):
        raise ValueError("bounded_fixed_registration_changed")
    tasks = config["formal_tasks"]
    if type(tasks) is not list or len(tasks) != 15:
        raise ValueError("bounded_formal_tasks_required")
    task_ids, contacts = set(), set()
    for task, window, item in zip(tasks, actual_windows, plan, strict=True):
        if type(task) is not dict or set(task) != {"owner_id", "contact_id", "task_id", "extraction_runtime_config", "input_sha256"}:
            raise ValueError("bounded_formal_task_fields_changed")
        identifiers = {}
        for key in ("owner_id", "contact_id", "task_id"):
            if type(task[key]) is not str or str(UUID(task[key])) != task[key]:
                raise ValueError("bounded_formal_identity_changed")
            identifiers[key] = UUID(task[key])
        runtime = ExtractionRuntimeConfig.from_payload(task["extraction_runtime_config"])
        if (identifiers["owner_id"] != window.owner_id or identifiers["contact_id"] != window.contact_id
                or identifiers["task_id"] in task_ids or identifiers["contact_id"] in contacts
                or task["input_sha256"] != item["input_sha256"]
                or runtime.mode is not ExtractionRuntimeMode.BOUNDED_RUNTIME_V1
                or runtime.rule_set_sha256 != current_rules):
            raise ValueError("bounded_formal_binding_changed")
        task_ids.add(identifiers["task_id"])
        contacts.add(identifiers["contact_id"])
    contracts = tuple(extraction_contract("grounded-v2", window, prompt_profile=profile.bounded_extraction_prompt_profile) for window in actual_windows)
    prompt, schema = source_verification_contract("nullable-proof-v3")
    if (config["extraction_window_contracts"] != [{"input_sha256": item["input_sha256"],
            "prompt_sha256": helper.digest(e_prompt), "schema_sha256": helper.digest(e_schema)}
            for item, (e_prompt, e_schema) in zip(plan, contracts, strict=True)]
            or config.get("extraction_prompt_sha256") != helper.digest(contracts[0][0])
            or config.get("extraction_schema_sha256") != helper.digest(tuple(value[1] for value in contracts))
            or config.get("verification_prompt_sha256") != helper.digest(prompt)
            or config.get("verification_schema_sha256") != helper.digest(schema)):
        raise ValueError("bounded_prompt_contract_changed")
    owner = helper.read_private(Path(frozen["directory"]) / "owned-worker.json")
    if (type(owner) is not dict or set(owner) != {"pid", "process_group", "run_id"}
            or type(owner["pid"]) is not int or type(owner["process_group"]) is not int
            or owner["pid"] != os.getpid() or owner["process_group"] != owner["pid"]
            or os.getpgrp() != owner["pid"] or owner["run_id"] != frozen["run_id"]):
        raise ValueError("bounded_owned_worker_changed")

