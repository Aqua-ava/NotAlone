"""本场唯一prepare/launch入口；准备不读取秘密、不领取预算，启动无自动后继。"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import signal
import sqlite3
import stat
import sys
import time
from typing import Any
from uuid import UUID, uuid4

from explicit_review_bridge import ExplicitReviewBridge, digest, private_directory, publish, read_private


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
REFERENCE = ".scratch/unfinished-work/memory-gold-reference-20261012.json"
ANNOTATION = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
PUBLIC_PLAN = ".scratch/grounded-evaluation/next-public-run-plan-20261015.md"
PACKAGES = ("openai", "langchain-core", "langchain-deepseek", "langchain-openai", "httpx", "httpx2", "langsmith", "pydantic")
FIXED: dict[str, Any] = {"case_set": "reference21", "case_positions": None, "extraction_mode": "grounded-v2",
    "verification_mode": "nullable-proof-v1", "verification_tool_choice": "omitted",
    "response_identity_policy": "first_valid_completion_observation_stop_on_change", "provider_profile": "deepseek-flash-max",
    "request_timeout_seconds": 300.0, "max_retries": 0, "request_limit": 42,
    "base_url": "https://api.deepseek.com", "model": "deepseek-flash", "reasoning_effort": "max",
    "extraction_tool_choice": "omitted"}


def file_digest(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("frozen_regular_file_required")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now():
    return datetime.now(timezone.utc)


def registry_snapshot():
    registry = Path.home() / ".notalone-memory-evaluations"
    if not os.path.lexists(registry):
        return {}
    private_directory(registry)
    result = {}
    for path in registry.iterdir():
        if str(UUID(path.name)) != path.name:
            raise ValueError("unrecognized_existing_run")
        private_directory(path)
        result[path.name] = (path / "closed").is_file()
    return result


def contracts():
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
    from notalone.memory_extraction.evaluation_extraction import extraction_contract
    from notalone.memory_extraction.evaluation_reference import public_window_projection
    rows = []
    plan = []
    schemas = []
    for position, case in enumerate(_PLAN_CASES):
        window = build_window(case)
        prompt, schema = extraction_contract("grounded-v2", window)
        item = {"case_position": position, "case_name": case.name,
                "input_sha256": digest(public_window_projection(window))}
        plan.append(item)
        rows.append({"input_sha256": item["input_sha256"], "prompt_sha256": digest(prompt), "schema_sha256": digest(schema)})
        schemas.append(schema)
    return plan, rows, digest(schemas)


def prepare(*, directory: Path, absolute_start: datetime) -> dict[str, Any]:
    """仅生成本轮待审阅冻结，不创建激活记录或预算。"""
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or absolute_start.utcoffset() is None:
        raise ValueError("disabled_dotenv_and_aware_start_required")
    from notalone.memory_extraction.evaluation_ecnu import _NULLABLE_REQUIRED_SOURCES
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    from notalone.memory_extraction.evaluation_reference import validate_public_reference

    directory = directory.resolve()
    if not directory.is_relative_to(HERE):
        raise ValueError("new_private_preparation_directory_required")
    directory.mkdir(mode=0o700)
    for name in ("evaluation", "audit"):
        (directory / name).mkdir(mode=0o700)
    source_names = _NULLABLE_REQUIRED_SOURCES | {
        REFERENCE, ANNOTATION, PUBLIC_PLAN, "backend/src/notalone/runtime_config.py",
        (HERE / "grounded_public21.py").relative_to(ROOT).as_posix(),
        (HERE / "explicit_review_bridge.py").relative_to(ROOT).as_posix(),
    }
    sources = {name: file_digest(ROOT / name) for name in sorted(source_names)}
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    validate_public_reference(reference, expected_reference_sha256=digest(reference), annotation_sha256=sources[ANNOTATION])
    plan, rows, schema_digest = contracts()
    if len(plan) != 21:
        raise ValueError("exact_public21_required")
    v_prompt, v_schema = _verification_contract("nullable-proof-v1")
    last = absolute_start + timedelta(hours=4)
    frozen = {"state": "prepared_only", "run_id": str(uuid4()), "nonce": str(uuid4()), "fixed": FIXED,
        "repo_root": str(ROOT), "directory": str(directory), "created_utc": now().isoformat(),
        "absolute_start": absolute_start.isoformat(), "last_http_start": last.isoformat(),
        "absolute_end": (last + timedelta(seconds=1845)).isoformat(),
        "source_hashes": sources, "installed_versions": {name: version(name) for name in PACKAGES},
        "reference_canonical_sha256": digest(reference), "plan": plan, "plan_sha256": digest(plan),
        "extraction_window_contracts": rows, "extraction_schema_sha256": schema_digest,
        "verification_prompt_sha256": digest(v_prompt), "verification_schema_sha256": digest(v_schema),
        "existing_runs": registry_snapshot(), "quality_certified": False}
    publish(directory / "freeze.json", frozen)
    return frozen


def validate(frozen):
    if (frozen["state"] != "prepared_only" or frozen["fixed"] != FIXED or frozen["repo_root"] != str(ROOT)
            or frozen["quality_certified"] is not False):
        raise ValueError("fixed_plan_changed")
    start, last, end = (datetime.fromisoformat(frozen[key]) for key in ("absolute_start", "last_http_start", "absolute_end"))
    if (any(value.utcoffset() is None for value in (start, last, end)) or not start <= now() < last
            or last - start != timedelta(hours=4) or end - last != timedelta(seconds=1845)):
        raise ValueError("fixed_dispatch_window_invalid")
    for name, expected in frozen["source_hashes"].items():
        if file_digest(ROOT / name) != expected:
            raise ValueError("frozen_source_changed")
    if frozen["installed_versions"] != {name: version(name) for name in PACKAGES}:
        raise ValueError("installed_versions_changed")
    plan, rows, schema_digest = contracts()
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    v_prompt, v_schema = _verification_contract("nullable-proof-v1")
    if (plan != frozen["plan"] or digest(plan) != frozen["plan_sha256"]
            or rows != frozen["extraction_window_contracts"] or schema_digest != frozen["extraction_schema_sha256"]
            or digest(v_prompt) != frozen["verification_prompt_sha256"]
            or digest(v_schema) != frozen["verification_schema_sha256"]):
        raise ValueError("frozen_dynamic_contract_changed")
    current_runs = registry_snapshot()
    if (current_runs != frozen["existing_runs"] or not all(current_runs.values())
            or frozen["run_id"] in current_runs):
        raise ValueError("old_or_active_run_changed")
    return start, last, end


def verify_claim(frozen):
    """只有本轮新预算已领取且尚未发送时才允许loader读取三项配置。"""
    run = Path.home() / ".notalone-memory-evaluations" / frozen["run_id"]
    private_directory(run)
    if not (run / "claimed").is_file() or (run / "closed").exists():
        raise ValueError("fresh_claim_required")
    with sqlite3.connect((run / "budget.sqlite3").as_uri() + "?mode=ro", uri=True) as connection:
        entries = connection.execute("SELECT manifest, closed FROM state").fetchall()
        count = connection.execute("SELECT count(*) FROM requests").fetchone()[0]
    if len(entries) != 1 or entries[0][1] != 0 or count != 0:
        raise ValueError("fresh_zero_request_claim_required")
    budget = {**json.loads(entries[0][0]), "reserved_requests": count}
    record = read_private(Path(frozen["directory"]) / "evaluation" / "manifest.json")
    config = record["frozen_config"]
    if (budget["run_id"] != frozen["run_id"] or budget["request_limit"] != 42
            or budget["allowed_endpoints"] != [FIXED["base_url"] + "/chat/completions"]
            or budget["output_directory"] != str(Path(frozen["directory"]) / "evaluation")
            or budget["reserved_requests"] != 0 or record["budget"] != budget
            or record["plan"] != frozen["plan"] or budget["config_sha256"] != digest(config)
            or config.get("extraction_mode") != "grounded-v2" or config.get("verification_mode") != "nullable-proof-v1"
            or config.get("extraction_window_contracts") != frozen["extraction_window_contracts"]
            or config.get("extraction_schema_sha256") != frozen["extraction_schema_sha256"]
            or config.get("extraction_prompt_sha256") != frozen["extraction_window_contracts"][0]["prompt_sha256"]
            or config.get("verification_prompt_sha256") != frozen["verification_prompt_sha256"]
            or config.get("verification_schema_sha256") != frozen["verification_schema_sha256"]
            or config.get("source_hashes") != frozen["source_hashes"]
            or config.get("versions") != frozen["installed_versions"]
            or config.get("timeout") != 300.0 or config.get("max_retries") != 0
            or config.get("base_url") != FIXED["base_url"] or config.get("request_model") != FIXED["model"]
            or config.get("reasoning_effort") != "max"
            or config.get("request_contract_version") != 2 or config.get("plan_sha256") != frozen["plan_sha256"]
            or config.get("mode") != "deepseek_bounded_evaluation" or config.get("stage") != "P1"
            or config.get("response_identity_policy") != FIXED["response_identity_policy"]
            or config.get("tool_choice") != {"extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                "verification": {"mode": "omitted", "name": "SourceVerificationOutput"}}
            or config.get("deadline_utc") != datetime.fromisoformat(frozen["last_http_start"]).astimezone(timezone.utc).isoformat()
            or "selected_case_positions" in config):
        raise ValueError("claimed_manifest_changed")


def read_credential():
    """此函数只由已领取且核对manifest的loader调用；准备与Mock不调用。"""
    from notalone.runtime_config import _parse_line
    descriptor = os.open(ROOT / ".env", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    values = {}
    selected = {"NOTALONE_DEEPSEEK_API_KEY", "NOTALONE_DEEPSEEK_BASE_URL", "NOTALONE_DEEPSEEK_MODEL"}
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536):
            raise ValueError("private_credential_file_required")
        for line in stream:
            key, value = _parse_line(line)
            if key in selected:
                if key in values or not value.strip():
                    raise ValueError("credential_configuration_ambiguous")
                values[key] = value
    if (set(values) != selected or values["NOTALONE_DEEPSEEK_MODEL"] != FIXED["model"]
            or values["NOTALONE_DEEPSEEK_BASE_URL"].rstrip("/") != FIXED["base_url"]):
        raise ValueError("credential_route_changed")
    return values["NOTALONE_DEEPSEEK_API_KEY"]


@contextmanager
def absolute_guard(end):
    from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
    previous = signal.getsignal(signal.SIGALRM)
    if signal.getitimer(signal.ITIMER_REAL)[0] != 0:
        raise ValueError("absolute_timer_already_used")
    def expired(signum, frame):
        raise EvaluationBudgetAbort("public21_absolute_deadline")
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, (end - now()).total_seconds()))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def launch(*, freeze_path: Path, expected_sha256: str, approval: dict[str, Any],
           synthetic_transport=None, credential_loader=None, bridge=None) -> dict[str, Any]:
    """Root确认本轮真实批准后调用；approval仅绑定已有批准，不要求用户另做文件。"""
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or file_digest(freeze_path) != expected_sha256:
        raise ValueError("exact_freeze_required")
    frozen = read_private(freeze_path)
    if approval != {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected_sha256}:
        raise ValueError("root_bound_approval_required")
    import httpx
    if (synthetic_transport is not None and type(synthetic_transport) is not httpx.MockTransport
            or synthetic_transport is None and (credential_loader is not None or bridge is not None)):
        raise ValueError("synthetic_injection_only_with_exact_mock")
    from notalone.memory_extraction.evaluation_ecnu import run_ecnu_evaluation
    from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
    from notalone.memory_extraction.evaluation_records import _json_value
    from langsmith import get_tracing_context
    if get_tracing_context().get("enabled") is True:
        raise ValueError("external_tracing_enabled")
    start, last, end = validate(frozen)
    directory = Path(frozen["directory"])
    if (not directory.is_relative_to(HERE) or freeze_path.resolve() != directory / "freeze.json"):
        raise ValueError("freeze_directory_binding_changed")
    bridge = bridge or ExplicitReviewBridge(directory=directory / "audit", run_id=frozen["run_id"], deadline=end)
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    audit = PhasedEvaluationAudit(reference=reference, expected_reference_sha256=frozen["reference_canonical_sha256"],
        annotation_sha256=frozen["source_hashes"][ANNOTATION], criteria_sha256=frozen["source_hashes"][REFERENCE],
        raw_reviewer=lambda view: bridge.review("raw", view), full_reviewer=lambda view: bridge.review("full", view),
        extraction_mode="grounded-v2", verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
        extraction_tool_choice="omitted")
    loaded = False
    def loader():
        nonlocal loaded
        if loaded or not start <= now() < last:
            raise ValueError("single_in_window_loader_required")
        loaded = True
        verify_claim(frozen)
        value = (credential_loader or read_credential)()
        publish(directory / "credential-receipt.json", {"run_id": frozen["run_id"],
            "loader_calls": 1, "secret_persisted": False, "synthetic": synthetic_transport is not None})
        return value
    publish(directory / "activation.json", {"run_id": frozen["run_id"], "freeze_sha256": expected_sha256,
        "started_utc": now().isoformat(), "pid": os.getpid(), "synthetic": synthetic_transport is not None})
    try:
        with absolute_guard(end):
            result = run_ecnu_evaluation(output_directory=directory / "evaluation", run_id=UUID(frozen["run_id"]),
                deadline=last, repo_root=ROOT, source_hashes=frozen["source_hashes"],
                frozen_gold={"status": "frozen_agent_review", "case_names": [item["case_name"] for item in frozen["plan"]],
                    "criteria_path": REFERENCE, "criteria_sha256": frozen["source_hashes"][REFERENCE]},
                credential_loader=loader, audit_case=audit, synthetic_transport=synthetic_transport,
                request_timeout_seconds=300.0, max_retries=0, case_set="reference21", case_positions=None,
                extraction_mode="grounded-v2", verification_mode="nullable-proof-v1", verification_tool_choice="omitted",
                response_identity_policy=FIXED["response_identity_policy"],
                provider_profile="deepseek-flash-max", request_limit=42)
        publish(directory / "result.json", _json_value(result))
        return result
    finally:
        publish(directory / "finish.json", {"run_id": frozen["run_id"], "finished_utc": now().isoformat(),
            "quality_certified": False, "automatic_successor": False})


if __name__ == "__main__":
    os.environ["NOTALONE_DISABLE_DOTENV"] = "1"
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "prepare":
            value = prepare(directory=Path(sys.argv[2]), absolute_start=datetime.fromisoformat(sys.argv[3]))
            print(json.dumps({"state": "prepared_only", "run_id": value["run_id"], "freeze_sha256": file_digest(Path(value["directory"]) / "freeze.json")}))
        elif len(sys.argv) == 5 and sys.argv[1] == "launch":
            result = launch(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval=read_private(Path(sys.argv[4])))
            print(json.dumps({"quality_certified": False, "stopped_code": result["stopped_code"]}))
        else:
            raise ValueError("explicit_prepare_or_root_authorized_launch_required")
    except BaseException as error:
        print(json.dumps({"error_type": type(error).__name__}))
        raise SystemExit(1) from None
