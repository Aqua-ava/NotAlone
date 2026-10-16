"""原公开21窗v4来源保真v2的准备与独占worker；默认无模型、预算或凭据操作。"""

from datetime import datetime, timedelta, timezone
import importlib.util
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
from uuid import UUID, uuid4


ROOT = Path(__file__).resolve().parents[3]
LEGACY = ROOT / "desktop/artifacts/grounded-public21-prepare-20261015/grounded_public21.py"
REFERENCE = ".scratch/unfinished-work/memory-gold-reference-v2-20261016.json"
ANNOTATION = ".scratch/unfinished-work/memory-gold-agent-annotations-v2-20261016.md"
PLAN = ".scratch/grounded-evaluation/reference21-complete-v4-plan-20261016.md"
POSITIONS = tuple(range(21))
from notalone.memory_extraction.evaluation_provider_contract import (
    REFERENCE21_V4_PLAN, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE, REFERENCE21_V4_KIND,
    MIXED_REQUEST_VERSION, mixed_phase_policy,
    SEMANTIC4_PLAN, SEMANTIC4_MODE, SEMANTIC4_STAGE, SEMANTIC4_KIND, SEMANTIC4_PROMPT_PROFILE,
    UNIQUENESS_PLAN, UNIQUENESS_KIND, UNIQUENESS_E_PROFILE, PUBLIC_QUALITY_PLANS, validate_semantic4_windows,
)
FIXED = {"execution_plan": REFERENCE21_V4_PLAN, "case_set": "reference21", "case_positions": None,
         "reference_version": "source-fidelity-v2", "request_limit": 42, "request_timeout_seconds": 300,
         "max_retries": 0, "extraction_mode": "grounded-v4", "verification_mode": "nullable-proof-v1",
         "verification_tool_choice": "forced", "extraction_tool_choice": "omitted",
         "provider_profile": "deepseek-phase-split-v1", "call_wall_seconds": 600, "phase_wall_seconds": 600,
         "phase_request_version": MIXED_REQUEST_VERSION, "phase_request_policy": mixed_phase_policy(),
         "planned_windows": 21, "required_claims": 28, "optional_claims": 1,
         "batch_work_seconds": 14380, "outer_wall_seconds": 14400}
PROFILES: dict[str, dict] = {"baseline": FIXED, "semantic4": {
    **FIXED, "execution_plan": SEMANTIC4_PLAN, "verification_mode": "legacy-v4",
    "prompt_profile": SEMANTIC4_PROMPT_PROFILE,
}, "uniqueness": {
    **FIXED, "execution_plan": UNIQUENESS_PLAN, "verification_mode": "legacy-v4",
    "prompt_profile": SEMANTIC4_PROMPT_PROFILE, "extraction_prompt_profile": UNIQUENESS_E_PROFILE,
}}


def fixed_contract(frozen: dict) -> dict:
    fixed = frozen.get("fixed")
    if type(fixed) is not dict:
        raise ValueError("reference21_v4_fixed_profile_required")
    for expected in PROFILES.values():
        if helpers().digest(fixed) == helpers().digest(expected):
            return expected
    raise ValueError("reference21_v4_fixed_profile_required")


def owned_kind(frozen: dict) -> str:
    return {REFERENCE21_V4_PLAN: REFERENCE21_V4_KIND, SEMANTIC4_PLAN: SEMANTIC4_KIND,
            UNIQUENESS_PLAN: UNIQUENESS_KIND}[fixed_contract(frozen)["execution_plan"]]


def helpers():
    # 复用已审私有工具的纯函数／显式审核桥，不调用其prepare或registry_snapshot。
    parent = str(LEGACY.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location("reference21_v4_preparation_helpers", LEGACY)
    if spec is None or spec.loader is None:
        raise ValueError("reviewed_helper_required")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def now():
    return datetime.now(timezone.utc)


def contracts(*, prompt_profile="default"):
    """公开原输入沿原投影，E合同直接取当前显式v4，不沿用旧v2行。"""
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
    from notalone.memory_extraction.evaluation_extraction import extraction_contract
    from notalone.memory_extraction.evaluation_reference import public_window_projection
    helper = helpers()
    plan, rows = [], []
    for index, case in enumerate(_PLAN_CASES):
        window = build_window(case)
        prompt, schema = extraction_contract("grounded-v4", window, prompt_profile=prompt_profile)
        input_sha = helper.digest(public_window_projection(window))
        plan.append({"case_position": index, "case_name": case.name, "input_sha256": input_sha})
        rows.append({"input_sha256": input_sha, "prompt_sha256": helper.digest(prompt),
                     "schema_sha256": helper.digest(schema)})
    return plan, rows


def _source_names(fixed=None):
    from notalone.memory_extraction.evaluation_ecnu import (
        _REFERENCE21_V4_REQUIRED_SOURCES, _SEMANTIC4_REQUIRED_SOURCES, _UNIQUENESS_REQUIRED_SOURCES,
    )
    if fixed is not None and fixed["execution_plan"] == UNIQUENESS_PLAN:
        return _UNIQUENESS_REQUIRED_SOURCES
    return _SEMANTIC4_REQUIRED_SOURCES if fixed is not None and fixed["execution_plan"] == SEMANTIC4_PLAN else _REFERENCE21_V4_REQUIRED_SOURCES


def prepare(*, directory: Path, absolute_start: datetime, profile: str = "baseline") -> dict:
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or absolute_start.utcoffset() is None:
        raise ValueError("disabled_dotenv_and_aware_start_required")
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    from notalone.memory_extraction.evaluation_reference import validate_public_reference
    if type(profile) is not str or profile not in PROFILES:
        raise ValueError("reference21_v4_fixed_profile_required")
    fixed = PROFILES[profile]
    if fixed["execution_plan"] in PUBLIC_QUALITY_PLANS:
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
        validate_semantic4_windows(tuple(build_window(case) for case in _PLAN_CASES))

    helper = helpers()
    directory = directory.resolve()
    directory.mkdir(mode=0o700)
    for name in ("evaluation", "audit"):
        (directory / name).mkdir(mode=0o700)
    sources = {name: helper.file_digest(ROOT / name) for name in sorted(_source_names(fixed))}
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    validation = validate_public_reference(reference, expected_reference_sha256=helper.digest(reference),
                              annotation_sha256=sources[ANNOTATION], reference_version="source-fidelity-v2")
    if validation.get("execution_ready") is not True:
        raise ValueError("reference21_v4_reference_not_ready")
    original_plan, rows = contracts(prompt_profile=fixed.get("extraction_prompt_profile", "default"))
    plan = [{**original_plan[position], "case_position": index} for index, position in enumerate(POSITIONS)]
    prompt, schema = _verification_contract(fixed["verification_mode"], prompt_profile=fixed.get("prompt_profile", "default"))
    frozen = {"state": "prepared_only", "run_id": str(uuid4()), "nonce": str(uuid4()), "fixed": json.loads(json.dumps(fixed)),
        "repo_root": str(ROOT), "directory": str(directory), "absolute_start": absolute_start.isoformat(),
        "work_end": (absolute_start + timedelta(seconds=14380)).isoformat(),
        "absolute_end": (absolute_start + timedelta(seconds=14400)).isoformat(),
        "source_hashes": sources, "installed_versions": {name: version(name) for name in helper.PACKAGES},
        "reference_canonical_sha256": helper.digest(reference), "plan": plan, "plan_sha256": helper.digest(plan),
        "selection": [{"case_id": reference["windows"][position]["id"], "gold_position": position}
                      for position in POSITIONS],
        "extraction_window_contracts": [rows[position] for position in POSITIONS],
        "verification_prompt_sha256": helper.digest(prompt), "verification_schema_sha256": helper.digest(schema),
        "quality_certified": False}
    helper.publish(directory / "freeze.json", frozen)
    return frozen


def validate(frozen: dict) -> tuple[datetime, datetime]:
    helper = helpers()
    fixed = fixed_contract(frozen)
    start, work_end, end = (datetime.fromisoformat(frozen[name]) for name in ("absolute_start", "work_end", "absolute_end"))
    if (frozen["state"] != "prepared_only" or frozen["repo_root"] != str(ROOT)
            or frozen["quality_certified"] is not False or any(item.utcoffset() is None for item in (start, work_end, end))
            or work_end - start != timedelta(seconds=14380) or end - start != timedelta(seconds=14400)
            or not start <= now() < work_end):
        raise ValueError("reference21_v4_fixed_window_required")
    if set(frozen["source_hashes"]) != _source_names(fixed):
        raise ValueError("reference21_v4_source_closure_changed")
    for name, expected in frozen["source_hashes"].items():
        if helper.file_digest(ROOT / name) != expected:
            raise ValueError("reference21_v4_source_drift")
    if frozen["installed_versions"] != {name: version(name) for name in helper.PACKAGES}:
        raise ValueError("reference21_v4_version_drift")
    full_plan, rows = contracts(prompt_profile=fixed.get("extraction_prompt_profile", "default"))
    expected_plan = [{**full_plan[position], "case_position": index} for index, position in enumerate(POSITIONS)]
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    prompt, schema = _verification_contract(fixed["verification_mode"], prompt_profile=fixed.get("prompt_profile", "default"))
    if (helper.digest(frozen["plan"]) != helper.digest(expected_plan) or frozen["plan_sha256"] != helper.digest(expected_plan)
            or frozen["extraction_window_contracts"] != [rows[position] for position in POSITIONS]
            or frozen["verification_prompt_sha256"] != helper.digest(prompt)
            or frozen["verification_schema_sha256"] != helper.digest(schema)):
        raise ValueError("reference21_v4_contract_drift")
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    from notalone.memory_extraction.evaluation_reference import validate_public_reference
    validation = validate_public_reference(reference, expected_reference_sha256=helper.digest(reference),
        annotation_sha256=frozen["source_hashes"][ANNOTATION], reference_version="source-fidelity-v2")
    if validation.get("execution_ready") is not True:
        raise ValueError("reference21_v4_reference_not_ready")
    expected_selection = [{"case_id": reference["windows"][position]["id"], "gold_position": position}
                          for position in POSITIONS]
    if (frozen["reference_canonical_sha256"] != helper.digest(reference)
            or helper.digest(frozen["selection"]) != helper.digest(expected_selection)):
        raise ValueError("reference21_v4_reference_drift")
    directory = Path(frozen["directory"])
    helper.private_directory(directory)
    return work_end, end


def verify_claim(frozen: dict) -> None:
    from notalone.memory_extraction.evaluation_owned_process import _verify_owned_public_claim
    _verify_owned_public_claim(frozen=frozen, helper=helpers(), kind=owned_kind(frozen))


def worker(*, freeze_path: Path, expected_sha256: str, approval: dict,
           synthetic_transport=None, credential_loader=None, bridge=None) -> dict:
    helper = helpers()
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("reference21_v4_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    if (type(approval) is not dict or approval.get("user_authorized") is not True
            or approval != {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected_sha256}):
        raise ValueError("reference21_v4_bound_authorization_required")
    import httpx
    if (synthetic_transport is not None and type(synthetic_transport) is not httpx.MockTransport
            or synthetic_transport is None and (credential_loader is not None or bridge is not None)):
        raise ValueError("reference21_v4_exact_mock_only")
    work_end, _ = validate(frozen)
    fixed = fixed_contract(frozen)
    from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES, run_ecnu_evaluation
    from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
    from notalone.memory_extraction.evaluation_records import _json_value
    from notalone.memory_extraction.evaluation_reference21_v4_deadline import Reference21V4Deadline
    from langsmith import get_tracing_context
    if get_tracing_context().get("enabled") is True:
        raise ValueError("reference21_v4_external_tracing_enabled")
    directory = Path(frozen["directory"])
    if freeze_path.resolve() != directory / "freeze.json":
        raise ValueError("reference21_v4_directory_binding_changed")
    control = Reference21V4Deadline(receipt=directory / "deadline-receipt.json",
        remaining_batch_seconds=min(14380, (work_end - now()).total_seconds()))
    if synthetic_transport is None and not control.live_worker:
        raise ValueError("reference21_v4_dedicated_worker_required")
    bridge = bridge or helper.ExplicitReviewBridge(directory=directory / "audit", run_id=frozen["run_id"], deadline=work_end)
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    audit = PhasedEvaluationAudit(reference=reference, expected_reference_sha256=frozen["reference_canonical_sha256"],
        annotation_sha256=frozen["source_hashes"][ANNOTATION], criteria_sha256=frozen["source_hashes"][REFERENCE],
        raw_reviewer=lambda view: bridge.review("raw", view), full_reviewer=lambda view: bridge.review("full", view),
        case_positions=None, case_set="reference21", reference_version="source-fidelity-v2",
        execution_plan=fixed["execution_plan"], extraction_mode="grounded-v4", verification_mode=fixed["verification_mode"],
        verification_tool_choice="forced", extraction_tool_choice="omitted",
        extraction_prompt_profile=fixed.get("extraction_prompt_profile", "default"))
    loaded = False
    def loader():
        nonlocal loaded
        if loaded:
            raise ValueError("reference21_v4_single_loader_required")
        loaded = True
        verify_claim(frozen)
        return (credential_loader or helper.read_credential)()
    helper.publish(directory / "activation.json", {"run_id": frozen["run_id"], "pid": os.getpid(),
        "process_group": os.getpgrp(), "synthetic": synthetic_transport is not None, "started_utc": now().isoformat()})
    result = run_ecnu_evaluation(output_directory=directory / "evaluation", run_id=UUID(frozen["run_id"]),
        deadline=work_end, repo_root=ROOT, source_hashes=frozen["source_hashes"],
        frozen_gold={"status": "frozen_agent_review", "case_names": [case.name for case in _PLAN_CASES],
                     "criteria_path": REFERENCE, "criteria_sha256": frozen["source_hashes"][REFERENCE]},
        credential_loader=loader, audit_case=audit, synthetic_transport=synthetic_transport,
        provider_profile="deepseek-phase-split-v1", request_timeout_seconds=300, max_retries=0,
        case_positions=None, case_set="reference21", request_limit=42, reference_version="source-fidelity-v2",
        verification_mode=fixed["verification_mode"], verification_tool_choice="forced", extraction_mode="grounded-v4",
        execution_plan=fixed["execution_plan"], reference21_v4_deadline=control,
        extraction_prompt_profile=fixed.get("extraction_prompt_profile", "default"))
    result.update(worker_pid=os.getpid(), execution_plan=fixed["execution_plan"])
    if fixed["execution_plan"] in PUBLIC_QUALITY_PLANS:
        result.update(typed_evaluated=False, typed_credit=False)
    helper.publish(directory / "result.json", _json_value(result))
    return result


def launch(*, freeze_path: Path, expected_sha256: str, approval_path: Path) -> dict:
    helper = helpers()
    if helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("reference21_v4_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    _, end = validate(frozen)
    approval = helper.read_private(approval_path)
    if (type(approval) is not dict or approval.get("user_authorized") is not True
            or approval != {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected_sha256}):
        raise ValueError("reference21_v4_bound_authorization_required")
    from notalone.memory_extraction.evaluation_owned_process import _launch_owned_public_worker
    return _launch_owned_public_worker(frozen=frozen, script=Path(__file__).resolve(), root=ROOT,
        helper=helper, freeze_path=freeze_path, expected_sha256=expected_sha256, approval_path=approval_path, end=end,
        clock=now, kind=owned_kind(frozen))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] in {"prepare", "prepare-semantic4", "prepare-uniqueness"}:
            freeze = prepare(directory=Path(sys.argv[2]), absolute_start=datetime.fromisoformat(sys.argv[3]),
                             profile={"prepare": "baseline", "prepare-semantic4": "semantic4", "prepare-uniqueness": "uniqueness"}[sys.argv[1]])
            print(json.dumps({"run_id": freeze["run_id"], "freeze_sha256": helpers().file_digest(Path(freeze["directory"]) / "freeze.json")}))
        elif len(sys.argv) == 5 and sys.argv[1] in {"launch", "worker"}:
            if sys.argv[1] == "launch":
                value = launch(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval_path=Path(sys.argv[4]))
            else:
                if sys.stdin.buffer.readline(7) != b"start\n":
                    raise ValueError("reference21_v4_owned_parent_release_required")
                value = worker(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval=helpers().read_private(Path(sys.argv[4])))
            print(json.dumps({"quality_certified": False, "stopped_code": value.get("stopped_code"), "closed": value.get("closed")}))
        else:
            raise ValueError("reference21_v4_explicit_command_required")
    except BaseException as error:
        print(json.dumps({"error_type": type(error).__name__}))
        raise SystemExit(1) from None
