"""固定v3标签指导两窗的准备与独占worker；默认无模型、预算或凭据操作。"""

from datetime import datetime, timedelta, timezone
import importlib.util
from importlib.metadata import version
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID, uuid4


ROOT = Path(__file__).resolve().parents[3]
LEGACY = ROOT / "desktop/tests/fixtures/grounded_public21.py"
REFERENCE = ".scratch/unfinished-work/memory-gold-reference-20261012.json"
ANNOTATION = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
PLAN = ".scratch/grounded-evaluation/v3-label-guidance-public2-plan-20261016.md"
LABEL_GUIDANCE_PLAN = ".scratch/grounded-evaluation/v3-label-guidance-plan-20261016.md"
POSITIONS = (6, 9)
FIXED = {"execution_plan": "reference21-ambiguity2-v3", "case_set": "reference21",
         "case_positions": list(POSITIONS), "request_limit": 4, "request_timeout_seconds": 300,
         "max_retries": 0, "extraction_mode": "grounded-v3", "verification_mode": "nullable-proof-v1",
         "verification_tool_choice": "omitted", "extraction_tool_choice": "omitted",
         "provider_profile": "deepseek-flash-max", "call_wall_seconds": 600,
         "phase_wall_seconds": 600, "label_policy": "v3-guidance-v1",
         "batch_work_seconds": 5380, "outer_wall_seconds": 5400}


def helpers():
    # 复用已审私有工具的纯函数／显式审核桥，不调用其prepare或registry_snapshot。
    parent = str(LEGACY.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location("ambiguity2_preparation_helpers", LEGACY)
    if spec is None or spec.loader is None:
        raise ValueError("reviewed_helper_required")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def now():
    return datetime.now(timezone.utc)


def contracts():
    """公开原输入沿原投影，E合同直接取当前显式v3，不沿用旧v2行。"""
    from notalone.memory_extraction.evaluation import build_window
    from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
    from notalone.memory_extraction.evaluation_extraction import extraction_contract
    from notalone.memory_extraction.evaluation_reference import public_window_projection
    helper = helpers()
    plan, rows = [], []
    for index, case in enumerate(_PLAN_CASES):
        window = build_window(case)
        prompt, schema = extraction_contract("grounded-v3", window)
        input_sha = helper.digest(public_window_projection(window))
        plan.append({"case_position": index, "case_name": case.name, "input_sha256": input_sha})
        rows.append({"input_sha256": input_sha, "prompt_sha256": helper.digest(prompt),
                     "schema_sha256": helper.digest(schema)})
    return plan, rows


def _source_names():
    from notalone.memory_extraction.evaluation_ecnu import _NULLABLE_REQUIRED_SOURCES
    return _NULLABLE_REQUIRED_SOURCES | {
        REFERENCE, ANNOTATION, PLAN, LABEL_GUIDANCE_PLAN, "backend/src/notalone/runtime_config.py",
        "desktop/tests/fixtures/remaining-public8.py", "desktop/tests/fixtures/ambiguity-public2.py",
        ".scratch/grounded-evaluation/remaining-public8-plan-20261016.md", LEGACY.relative_to(ROOT).as_posix(),
        (LEGACY.parent / "explicit_review_bridge.py").relative_to(ROOT).as_posix(),
    }


def prepare(*, directory: Path, absolute_start: datetime) -> dict:
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or absolute_start.utcoffset() is None:
        raise ValueError("disabled_dotenv_and_aware_start_required")
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    from notalone.memory_extraction.evaluation_reference import validate_public_reference

    helper = helpers()
    directory = directory.resolve()
    directory.mkdir(mode=0o700)
    for name in ("evaluation", "audit"):
        (directory / name).mkdir(mode=0o700)
    sources = {name: helper.file_digest(ROOT / name) for name in sorted(_source_names())}
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    validate_public_reference(reference, expected_reference_sha256=helper.digest(reference),
                              annotation_sha256=sources[ANNOTATION])
    original_plan, rows = contracts()
    plan = [{**original_plan[position], "case_position": index} for index, position in enumerate(POSITIONS)]
    prompt, schema = _verification_contract("nullable-proof-v1")
    frozen = {"state": "prepared_only", "run_id": str(uuid4()), "nonce": str(uuid4()), "fixed": FIXED,
        "repo_root": str(ROOT), "directory": str(directory), "absolute_start": absolute_start.isoformat(),
        "work_end": (absolute_start + timedelta(seconds=5380)).isoformat(),
        "absolute_end": (absolute_start + timedelta(seconds=5400)).isoformat(),
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
    start, work_end, end = (datetime.fromisoformat(frozen[name]) for name in ("absolute_start", "work_end", "absolute_end"))
    if (frozen["state"] != "prepared_only" or frozen["fixed"] != FIXED or frozen["repo_root"] != str(ROOT)
            or frozen["quality_certified"] is not False or any(item.utcoffset() is None for item in (start, work_end, end))
            or work_end - start != timedelta(seconds=5380) or end - start != timedelta(seconds=5400)
            or not start <= now() < work_end):
        raise ValueError("ambiguity2_fixed_window_required")
    if set(frozen["source_hashes"]) != _source_names():
        raise ValueError("ambiguity2_source_closure_changed")
    for name, expected in frozen["source_hashes"].items():
        if helper.file_digest(ROOT / name) != expected:
            raise ValueError("ambiguity2_source_drift")
    if frozen["installed_versions"] != {name: version(name) for name in helper.PACKAGES}:
        raise ValueError("ambiguity2_version_drift")
    full_plan, rows = contracts()
    expected_plan = [{**full_plan[position], "case_position": index} for index, position in enumerate(POSITIONS)]
    from notalone.memory_extraction.evaluation_offline import _verification_contract
    prompt, schema = _verification_contract("nullable-proof-v1")
    if (frozen["plan"] != expected_plan or frozen["plan_sha256"] != helper.digest(expected_plan)
            or frozen["extraction_window_contracts"] != [rows[position] for position in POSITIONS]
            or frozen["verification_prompt_sha256"] != helper.digest(prompt)
            or frozen["verification_schema_sha256"] != helper.digest(schema)):
        raise ValueError("ambiguity2_contract_drift")
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    if (frozen["reference_canonical_sha256"] != helper.digest(reference)
            or frozen["selection"] != [{"case_id": reference["windows"][position]["id"], "gold_position": position}
                                       for position in POSITIONS]):
        raise ValueError("ambiguity2_reference_drift")
    directory = Path(frozen["directory"])
    helper.private_directory(directory)
    return work_end, end


def verify_claim(frozen: dict) -> None:
    from notalone.memory_extraction.evaluation_owned_process import _verify_owned_public_claim
    _verify_owned_public_claim(frozen=frozen, helper=helpers(), kind="ambiguity2")


def worker(*, freeze_path: Path, expected_sha256: str, approval: dict,
           synthetic_transport=None, credential_loader=None, bridge=None) -> dict:
    helper = helpers()
    if os.environ.get("NOTALONE_DISABLE_DOTENV") != "1" or helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("ambiguity2_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    if approval != {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected_sha256}:
        raise ValueError("ambiguity2_bound_authorization_required")
    import httpx
    if (synthetic_transport is not None and type(synthetic_transport) is not httpx.MockTransport
            or synthetic_transport is None and (credential_loader is not None or bridge is not None)):
        raise ValueError("ambiguity2_exact_mock_only")
    work_end, _ = validate(frozen)
    from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES, run_ecnu_evaluation
    from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
    from notalone.memory_extraction.evaluation_records import _json_value
    from notalone.memory_extraction.evaluation_ambiguity2_deadline import Ambiguity2Deadline
    from langsmith import get_tracing_context
    if get_tracing_context().get("enabled") is True:
        raise ValueError("ambiguity2_external_tracing_enabled")
    directory = Path(frozen["directory"])
    if freeze_path.resolve() != directory / "freeze.json":
        raise ValueError("ambiguity2_directory_binding_changed")
    control = Ambiguity2Deadline(receipt=directory / "deadline-receipt.json",
        remaining_batch_seconds=min(5380, (work_end - now()).total_seconds()))
    if synthetic_transport is None and not control.live_worker:
        raise ValueError("ambiguity2_dedicated_worker_required")
    bridge = bridge or helper.ExplicitReviewBridge(directory=directory / "audit", run_id=frozen["run_id"], deadline=work_end)
    reference = json.loads((ROOT / REFERENCE).read_bytes())
    audit = PhasedEvaluationAudit(reference=reference, expected_reference_sha256=frozen["reference_canonical_sha256"],
        annotation_sha256=frozen["source_hashes"][ANNOTATION], criteria_sha256=frozen["source_hashes"][REFERENCE],
        raw_reviewer=lambda view: bridge.review("raw", view), full_reviewer=lambda view: bridge.review("full", view),
        case_positions=POSITIONS, extraction_mode="grounded-v3", verification_mode="nullable-proof-v1",
        verification_tool_choice="omitted", extraction_tool_choice="omitted")
    loaded = False
    def loader():
        nonlocal loaded
        if loaded:
            raise ValueError("ambiguity2_single_loader_required")
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
        provider_profile="deepseek-flash-max", request_timeout_seconds=300, max_retries=0,
        case_positions=POSITIONS, case_set="reference21", request_limit=4,
        verification_mode="nullable-proof-v1", verification_tool_choice="omitted", extraction_mode="grounded-v3",
        execution_plan="reference21-ambiguity2-v3", ambiguity2_deadline=control)
    helper.publish(directory / "result.json", _json_value(result))
    return result


def launch(*, freeze_path: Path, expected_sha256: str, approval_path: Path) -> dict:
    helper = helpers()
    if helper.file_digest(freeze_path) != expected_sha256:
        raise ValueError("ambiguity2_exact_freeze_required")
    frozen = helper.read_private(freeze_path)
    _, end = validate(frozen)
    approval = helper.read_private(approval_path)
    if approval != {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected_sha256}:
        raise ValueError("ambiguity2_bound_authorization_required")
    from notalone.memory_extraction.evaluation_owned_process import _launch_owned_public_worker
    return _launch_owned_public_worker(frozen=frozen, script=Path(__file__).resolve(), root=ROOT,
        helper=helper, freeze_path=freeze_path, expected_sha256=expected_sha256, approval_path=approval_path, end=end,
        clock=now, kind="ambiguity2")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "prepare":
            freeze = prepare(directory=Path(sys.argv[2]), absolute_start=datetime.fromisoformat(sys.argv[3]))
            print(json.dumps({"run_id": freeze["run_id"], "freeze_sha256": helpers().file_digest(Path(freeze["directory"]) / "freeze.json")}))
        elif len(sys.argv) == 5 and sys.argv[1] in {"launch", "worker"}:
            if sys.argv[1] == "launch":
                value = launch(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval_path=Path(sys.argv[4]))
            else:
                if sys.stdin.buffer.readline(7) != b"start\n":
                    raise ValueError("ambiguity2_owned_parent_release_required")
                value = worker(freeze_path=Path(sys.argv[2]), expected_sha256=sys.argv[3], approval=helpers().read_private(Path(sys.argv[4])))
            print(json.dumps({"quality_certified": False, "stopped_code": value.get("stopped_code"), "closed": value.get("closed")}))
        else:
            raise ValueError("ambiguity2_explicit_command_required")
    except BaseException as error:
        print(json.dumps({"error_type": type(error).__name__}))
        raise SystemExit(1) from None
