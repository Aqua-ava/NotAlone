"""固定完整140窗v4来源保真v2的准备与独占worker；默认无模型、预算或凭据操作。"""

from datetime import datetime, timedelta, timezone
import importlib.util
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys
from uuid import UUID, uuid4


ROOT = Path(__file__).resolve().parents[3]
LEGACY = ROOT / "desktop/tests/fixtures/grounded_public21.py"
REFERENCE = ".scratch/unfinished-work/memory-gold-full140-reference-v2-20261016.json"
ANNOTATION = ".scratch/unfinished-work/memory-gold-full140-agent-annotations-v2-20261016.md"
PLAN = ".scratch/grounded-evaluation/full140-v4-source-v2-readiness-20261016.md"
CONTROL_PLAN = ".scratch/grounded-evaluation/full140-v4-control-implementation-20261016.md"
PROTOCOL_PLAN = ".scratch/grounded-v4-protocol-readiness/spec.md"
OBJECT_PLAN = ".scratch/grounded-v4-object-ownership/spec.md"
REFERENCE_PLAN = ".scratch/grounded-evaluation/reference-source-fidelity-v2-spec-20261016.md"
PARENT_REFERENCE = ".scratch/unfinished-work/memory-gold-reference-v2-20261016.json"
PARENT_ANNOTATION = ".scratch/unfinished-work/memory-gold-agent-annotations-v2-20261016.md"
POSITIONS = tuple(range(140))
FIXED = {"execution_plan": "full140-grounded-v4-source-v2", "case_set": "full140",
         "reference_version": "source-fidelity-v2",
         "case_positions": None, "request_limit": 280, "request_timeout_seconds": 300,
         "max_retries": 0, "extraction_mode": "grounded-v4", "verification_mode": "nullable-proof-v1",
         "verification_tool_choice": "omitted", "extraction_tool_choice": "omitted",
         "provider_profile": "deepseek-flash-max", "call_wall_seconds": 600,
         "phase_wall_seconds": 600, "planned_windows": 140, "required_claims": 138, "optional_claims": 1,
         "batch_work_seconds": 86380, "outer_wall_seconds": 86400}


def _fixed(plan: str) -> dict:
    from notalone.memory_extraction.evaluation_provider_contract import FULL140_E2_PLAN, MIXED_PLAN, MIXED_REQUEST_VERSION, mixed_phase_policy
    if type(plan) is not str or plan not in (FIXED["execution_plan"], MIXED_PLAN, FULL140_E2_PLAN):
        raise ValueError("full140_registered_variant_required")
    fixed = json.loads(json.dumps(FIXED))
    if plan in (MIXED_PLAN, FULL140_E2_PLAN):
        fixed.update(execution_plan=plan, provider_profile="deepseek-phase-split-v1",
                     verification_tool_choice="forced", phase_request_version=MIXED_REQUEST_VERSION,
                     phase_request_policy=mixed_phase_policy())
    if plan == FULL140_E2_PLAN:
        fixed.update(extraction_mode="grounded-v2", verification_mode="legacy-v4")
    return fixed


def _kind(plan: str) -> str:
    from notalone.memory_extraction.evaluation_provider_contract import FULL140_E2_PLAN, FULL140_E2_KIND, MIXED_PLAN, MIXED_KIND
    _fixed(plan)
    return FULL140_E2_KIND if plan == FULL140_E2_PLAN else MIXED_KIND if plan == MIXED_PLAN else "full140-v4"


def helpers():
    # 复用已审私有工具的纯函数／显式审核桥，不调用其prepare或registry_snapshot。
    parent = str(LEGACY.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location("full140_v4_preparation_helpers", LEGACY)
    if spec is None or spec.loader is None:
        raise ValueError("reviewed_helper_required")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def now():
    return datetime.now(timezone.utc)


def contracts(*, _plan=FIXED["execution_plan"]):
    """完整公开原输入沿原投影；提取合同只取封闭身份固定版本。"""
    fixed = _fixed(_plan)
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_ecnu import _FULL_CASES
    from notalone.memory_extraction.evaluation_extraction import extraction_contract
    from notalone.memory_extraction.evaluation_reference import public_window_projection
    helper = helpers()
    plan, rows = [], []
    for index, case in enumerate(_FULL_CASES):
        window = build_window(case)
        prompt, schema = extraction_contract(fixed["extraction_mode"], window)
        input_sha = helper.digest(public_window_projection(window))
        plan.append({"case_position": index, "case_name": case.name, "input_sha256": input_sha})
        rows.append({"input_sha256": input_sha, "prompt_sha256": helper.digest(prompt),
                     "schema_sha256": helper.digest(schema)})
    return plan, rows


def _source_names(plan=FIXED["execution_plan"]):
    from notalone.memory_extraction.evaluation_ecnu import _FULL140_V4_REQUIRED_SOURCES, _FULL140_MIXED_REQUIRED_SOURCES, _FULL140_E2_REQUIRED_SOURCES
    _fixed(plan)
    from notalone.memory_extraction.evaluation_provider_contract import FULL140_E2_PLAN
    return (_FULL140_E2_REQUIRED_SOURCES if plan == FULL140_E2_PLAN else
            _FULL140_MIXED_REQUIRED_SOURCES if _kind(plan) != "full140-v4" else _FULL140_V4_REQUIRED_SOURCES)


def prepare(*, directory: Path, absolute_start: datetime, _plan=FIXED["execution_plan"]) -> dict:
    fixed = _fixed(_plan)
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or absolute_start.utcoffset() is None:
        raise ValueError("disabled_dotenv_and_aware_start_required")
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    from notalone.memory_extraction.evaluation_reference import validate_full_public_reference

    helper = helpers()
    directory = directory.resolve()
    directory.mkdir(mode=0o700)
    for name in ("evaluation", "audit"):
        (directory / name).mkdir(mode=0o700)
    sources = {name: helper.file_digest(ROOT / name) for name in sorted(_source_names(_plan))}
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    validation = validate_full_public_reference(reference, expected_reference_sha256=helper.digest(reference),
                              annotation_sha256=sources[ANNOTATION], reference_version="source-fidelity-v2")
    if validation.get("execution_ready") is not True:
        raise ValueError("full140_v4_reference_not_ready")
    from notalone.memory_extraction.evaluation_reference import full_case_reference_positions
    original_plan, rows = contracts(_plan=_plan)
    plan = [{**original_plan[position], "case_position": index} for index, position in enumerate(POSITIONS)]
    prompt, schema = _verification_contract(fixed["verification_mode"])
    frozen = {"state": "prepared_only", "run_id": str(uuid4()), "nonce": str(uuid4()), "fixed": fixed,
        "repo_root": str(ROOT), "directory": str(directory), "absolute_start": absolute_start.isoformat(),
        "work_end": (absolute_start + timedelta(seconds=86380)).isoformat(),
        "absolute_end": (absolute_start + timedelta(seconds=86400)).isoformat(),
        "source_hashes": sources, "installed_versions": {name: version(name) for name in helper.PACKAGES},
        "reference_canonical_sha256": helper.digest(reference), "plan": plan, "plan_sha256": helper.digest(plan),
        "selection": [{"case_id": reference["windows"][position]["id"], "gold_position": position}
                      for position in full_case_reference_positions()],
        "extraction_window_contracts": [rows[position] for position in POSITIONS],
        "verification_prompt_sha256": helper.digest(prompt), "verification_schema_sha256": helper.digest(schema),
        "quality_certified": False}
    helper.publish(directory / "freeze.json", frozen)
    return frozen


def validate(frozen: dict, *, _plan=FIXED["execution_plan"]) -> tuple[datetime, datetime]:
    fixed = _fixed(_plan)
    helper = helpers()
    start, work_end, end = (datetime.fromisoformat(frozen[name]) for name in ("absolute_start", "work_end", "absolute_end"))
    if (frozen["state"] != "prepared_only" or helper.digest(frozen["fixed"]) != helper.digest(fixed) or frozen["repo_root"] != str(ROOT)
            or frozen["quality_certified"] is not False or any(item.utcoffset() is None for item in (start, work_end, end))
            or work_end - start != timedelta(seconds=86380) or end - start != timedelta(seconds=86400)
            or not start <= now() < work_end):
        raise ValueError("full140_v4_fixed_window_required")
    if set(frozen["source_hashes"]) != _source_names(_plan):
        raise ValueError("full140_v4_source_closure_changed")
    for name, expected in frozen["source_hashes"].items():
        if helper.file_digest(ROOT / name) != expected:
            raise ValueError("full140_v4_source_drift")
    if frozen["installed_versions"] != {name: version(name) for name in helper.PACKAGES}:
        raise ValueError("full140_v4_version_drift")
    full_plan, rows = contracts(_plan=_plan)
    expected_plan = [{**full_plan[position], "case_position": index} for index, position in enumerate(POSITIONS)]
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    prompt, schema = _verification_contract(fixed["verification_mode"])
    if (helper.digest(frozen["plan"]) != helper.digest(expected_plan) or frozen["plan_sha256"] != helper.digest(expected_plan)
            or frozen["extraction_window_contracts"] != [rows[position] for position in POSITIONS]
            or frozen["verification_prompt_sha256"] != helper.digest(prompt)
            or frozen["verification_schema_sha256"] != helper.digest(schema)):
        raise ValueError("full140_v4_contract_drift")
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    from notalone.memory_extraction.evaluation_reference import full_case_reference_positions, validate_full_public_reference
    validation = validate_full_public_reference(reference, expected_reference_sha256=helper.digest(reference),
        annotation_sha256=frozen["source_hashes"][ANNOTATION], reference_version="source-fidelity-v2")
    if validation.get("execution_ready") is not True:
        raise ValueError("full140_v4_reference_not_ready")
    expected_selection = [{"case_id": reference["windows"][position]["id"], "gold_position": position}
                          for position in full_case_reference_positions()]
    if (frozen["reference_canonical_sha256"] != helper.digest(reference)
            or helper.digest(frozen["selection"]) != helper.digest(expected_selection)):
        raise ValueError("full140_v4_reference_drift")
    directory = Path(frozen["directory"])
    helper.private_directory(directory)
    return work_end, end


def verify_claim(frozen: dict, *, _plan=FIXED["execution_plan"]) -> None:
    from notalone.memory_extraction.evaluation_owned_process import _verify_owned_public_claim
    _verify_owned_public_claim(frozen=frozen, helper=helpers(), kind=_kind(_plan))


def _check_authorization(approval: dict, frozen: dict, expected_sha256: str) -> None:
    if (type(approval) is not dict or approval.get("user_authorized") is not True
            or approval != {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected_sha256}):
        raise ValueError("full140_v4_bound_authorization_required")


def worker(*, freeze_path: Path, expected_sha256: str, approval: dict,
           synthetic_transport=None, credential_loader=None, bridge=None, _plan=FIXED["execution_plan"]) -> dict:
    fixed = _fixed(_plan)
    helper = helpers()
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("full140_v4_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    _check_authorization(approval, frozen, expected_sha256)
    import httpx
    if (synthetic_transport is not None and type(synthetic_transport) is not httpx.MockTransport
            or synthetic_transport is None and (credential_loader is not None or bridge is not None)):
        raise ValueError("full140_v4_exact_mock_only")
    work_end, _ = validate(frozen, _plan=_plan)
    from notalone.memory_extraction.evaluation_ecnu import _FULL_CASES, run_ecnu_evaluation
    from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
    from notalone.memory_extraction.evaluation_records import _json_value
    from notalone.memory_extraction.evaluation_full140_v4_deadline import Full140V4Deadline
    from langsmith import get_tracing_context
    if get_tracing_context().get("enabled") is True:
        raise ValueError("full140_v4_external_tracing_enabled")
    directory = Path(frozen["directory"])
    if freeze_path.resolve() != directory / "freeze.json":
        raise ValueError("full140_v4_directory_binding_changed")
    control = Full140V4Deadline(receipt=directory / "deadline-receipt.json",
        remaining_batch_seconds=min(86380, (work_end - now()).total_seconds()))
    if synthetic_transport is None and not control.live_worker:
        raise ValueError("full140_v4_dedicated_worker_required")
    bridge = bridge or helper.ExplicitReviewBridge(directory=directory / "audit", run_id=frozen["run_id"], deadline=work_end)
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    audit = PhasedEvaluationAudit(reference=reference, expected_reference_sha256=frozen["reference_canonical_sha256"],
        annotation_sha256=frozen["source_hashes"][ANNOTATION], criteria_sha256=frozen["source_hashes"][REFERENCE],
        raw_reviewer=lambda view: bridge.review("raw", view), full_reviewer=lambda view: bridge.review("full", view),
        case_positions=None, case_set="full140", reference_version="source-fidelity-v2",
        extraction_mode=fixed["extraction_mode"], verification_mode=fixed["verification_mode"],
        verification_tool_choice=fixed["verification_tool_choice"], extraction_tool_choice="omitted",
        **({"execution_plan": _plan} if _kind(_plan) != "full140-v4" else {}))
    loaded = False
    def loader():
        nonlocal loaded
        if loaded:
            raise ValueError("full140_v4_single_loader_required")
        loaded = True
        verify_claim(frozen, _plan=_plan)
        return (credential_loader or helper.read_credential)()
    helper.publish(directory / "activation.json", {"run_id": frozen["run_id"], "pid": os.getpid(),
        "process_group": os.getpgrp(), "synthetic": synthetic_transport is not None, "started_utc": now().isoformat()})
    result = run_ecnu_evaluation(output_directory=directory / "evaluation", run_id=UUID(frozen["run_id"]),
        deadline=work_end, repo_root=ROOT, source_hashes=frozen["source_hashes"],
        frozen_gold={"status": "frozen_agent_review", "case_names": [case.name for case in _FULL_CASES],
                     "criteria_path": REFERENCE, "criteria_sha256": frozen["source_hashes"][REFERENCE]},
        credential_loader=loader, audit_case=audit, synthetic_transport=synthetic_transport,
        provider_profile=fixed["provider_profile"], request_timeout_seconds=300, max_retries=0,
        case_positions=None, case_set="full140", reference_version="source-fidelity-v2", request_limit=280,
        verification_mode=fixed["verification_mode"], verification_tool_choice=fixed["verification_tool_choice"], extraction_mode=fixed["extraction_mode"],
        execution_plan=_plan, full140_v4_deadline=control)
    if _kind(_plan) != "full140-v4":
        result.update(worker_pid=os.getpid(), execution_plan=_plan)
    helper.publish(directory / "result.json", _json_value(result))
    return result


def launch(*, freeze_path: Path, expected_sha256: str, approval_path: Path, _plan=FIXED["execution_plan"]) -> dict:
    helper = helpers()
    if helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("full140_v4_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    _, end = validate(frozen, _plan=_plan)
    approval = helper.read_private(approval_path)
    _check_authorization(approval, frozen, expected_sha256)
    from notalone.memory_extraction.evaluation_owned_process import _launch_owned_public_worker
    from notalone.memory_extraction.evaluation_provider_contract import FULL140_E2_PLAN
    script = (ROOT / "desktop/tests/fixtures/full140-e2-v-off-public.py" if _plan == FULL140_E2_PLAN else
              ROOT / "desktop/tests/fixtures/full140-mixed-v-off-public.py" if _kind(_plan) != "full140-v4" else Path(__file__).resolve())
    return _launch_owned_public_worker(frozen=frozen, script=script, root=ROOT,
        helper=helper, freeze_path=freeze_path, expected_sha256=expected_sha256, approval_path=approval_path, end=end,
        clock=now, kind=_kind(_plan))


def main(plan=FIXED["execution_plan"]):
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "prepare":
            freeze = prepare(directory=Path(sys.argv[2]), absolute_start=datetime.fromisoformat(sys.argv[3]), _plan=plan)
            print(json.dumps({"run_id": freeze["run_id"], "freeze_sha256": helpers().file_digest(Path(freeze["directory"]) / "freeze.json")}))
        elif len(sys.argv) == 5 and sys.argv[1] in {"launch", "worker"}:
            if sys.argv[1] == "launch":
                value = launch(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval_path=Path(sys.argv[4]), _plan=plan)
            else:
                if sys.stdin.buffer.readline(7) != b"start\n":
                    raise ValueError("full140_v4_owned_parent_release_required")
                value = worker(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval=helpers().read_private(Path(sys.argv[4])), _plan=plan)
            print(json.dumps({"quality_certified": False, "stopped_code": value.get("stopped_code"), "closed": value.get("closed")}))
        else:
            raise ValueError("full140_v4_explicit_command_required")
    except BaseException as error:
        print(json.dumps({"error_type": type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
