"""只处理固定公开合成计划的受限 ECNU 评测入口。"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import os
from math import isfinite
from pathlib import Path
import re
from typing import cast
from uuid import UUID

import httpx

from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction.evaluation_owned_deadline import BoundedRuntime15Deadline
from notalone.memory_extraction.evaluation_bounded_cases import (
    BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_INPUTS, BOUNDED_RUNTIME_REFERENCE_PATH,
    BOUNDED_RUNTIME_ANNOTATION_PATH,
)
from notalone.memory_extraction.evaluation_extraction import (
    EvaluationExtractionMode, extraction_contract,
)
from notalone.memory_extraction.evaluation_cases import CASES
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_offline import (
    _frozen_config, _run_evaluation_batch, _verification_contract,
)
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_extraction.evaluation_reference import (
    FULL_ANNOTATION_PATH, FULL_REFERENCE_PATH, PUBLIC_REFERENCE_PATH,
    FULL_ANNOTATION_V2_PATH, FULL_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH, PUBLIC_REFERENCE_V2_PATH,
    full_case_reference_positions, public_window_projection,
    validate_full_public_reference, validate_public_reference,
)
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
from notalone.memory_extraction.verification import SourceVerificationMode
from notalone.memory_trace.context import current_trace
from .evaluation_provider_contract import (
    FULL140_E2_PLAN, FULL140_E2_MODE, FULL140_E2_STAGE,
    MIXED_PLAN, MIXED_REQUEST_VERSION, MIXED_MODE, MIXED_STAGE, mixed_phase_policy,
    REFERENCE21_V4_PLAN, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE, PHASE_SPLIT_PLANS, REFERENCE21_PLANS,
    SEMANTIC4_PLAN, SEMANTIC4_MODE, SEMANTIC4_STAGE, SEMANTIC4_PROMPT_PROFILE, validate_semantic4_windows,
    UNIQUENESS_PLAN, UNIQUENESS_MODE, UNIQUENESS_STAGE, PUBLIC_QUALITY_PLANS,
    validate_extraction_prompt_profile,
    BOUNDED_RUNTIME_PLAN, BOUNDED_RUNTIME_MODE, BOUNDED_RUNTIME_STAGE,
    _BOUNDED_MIGRATION_SOURCES,
    REFERENCE16_PRO_PLAN, REFERENCE16_PRO_MODE, REFERENCE16_PRO_STAGE,
)


_BASE_URL = "https://chat.ecnu.edu.cn/open/api/v1"
_ENDPOINT = f"{_BASE_URL}/chat/completions"
_CRITERIA_PATH = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
_PLAN_CASES = tuple(case for case in CASES if case.dimension == "reference") + tuple(
    case for case in SEMANTIC_CASES if case.dimension == "reference"
) + tuple(case for case in SEMANTIC_CASES if case.name in {
    "严格：报价判断与条件咨询", "严格：第三人历史经历与当前未知",
})
_FULL_CASES = (*CASES, *SEMANTIC_CASES)
_REMAINING8_POSITIONS = (19, 20, 13, 14, 15, 16, 17, 18)
_AMBIGUITY2_POSITIONS = (6, 9)
_MAIN16_POSITIONS = tuple(range(16))
_GOLD_FIELDS = {"status", "case_names", "criteria_sha256", "criteria_path"}
_SOURCE_DIRECTORY = Path(__file__).resolve().parent
_REQUIRED_SOURCES = frozenset(
    f"backend/src/notalone/memory_extraction/{path.relative_to(_SOURCE_DIRECTORY)}"
    for path in _SOURCE_DIRECTORY.rglob("*.py")
) | frozenset({
    "backend/pyproject.toml", "backend/src/notalone/__init__.py",
    "backend/src/notalone/scopes.py",
    *(f"backend/src/notalone/memory/{name}.py" for name in
      ("__init__", "adapters", "models", "ports", "timing")),
    *(f"backend/src/notalone/memory_trace/{name}.py" for name in
      ("__init__", "context", "ports", "transport")),
    *(f"backend/src/notalone/ledger/{name}.py" for name in
      ("__init__", "models", "ports")),
})
# 新证明入口还执行这三个共享模块；旧四槽准入集合保持原合同。
_NULLABLE_REQUIRED_SOURCES = _REQUIRED_SOURCES | frozenset(
    f"backend/src/notalone/memory/{name}.py"
    for name in ("dimension_evidence", "evidence_binding", "pragmatics")
)
_FULL140_V4_REQUIRED_SOURCES = _NULLABLE_REQUIRED_SOURCES | frozenset({
    FULL_REFERENCE_V2_PATH, FULL_ANNOTATION_V2_PATH, PUBLIC_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH,
    "backend/src/notalone/runtime_config.py", "desktop/tests/fixtures/full140-v4-public.py",
    ".scratch/grounded-evaluation/full140-v4-source-v2-readiness-20261016.md",
    ".scratch/grounded-evaluation/full140-v4-control-implementation-20261016.md",
    ".scratch/grounded-evaluation/full140-v4-reference-integration-20261016.md",
    ".scratch/grounded-evaluation/reference-source-fidelity-v2-spec-20261016.md",
    ".scratch/grounded-v4-protocol-readiness/spec.md", ".scratch/grounded-v4-object-ownership/spec.md",
    "desktop/tests/fixtures/grounded_public21.py",
    "desktop/tests/fixtures/explicit_review_bridge.py",
})
_FULL140_E2_REQUIRED_SOURCES = _NULLABLE_REQUIRED_SOURCES | frozenset({
    FULL_REFERENCE_V2_PATH, FULL_ANNOTATION_V2_PATH, PUBLIC_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH,
    "backend/src/notalone/runtime_config.py", "desktop/tests/fixtures/full140-v4-public.py",
    "desktop/tests/fixtures/full140-e2-v-off-public.py",
    ".scratch/grounded-evaluation/full140-e2-v-off-plan-20261017.md",
    ".scratch/grounded-evaluation/reference-source-fidelity-v2-spec-20261016.md",
    "desktop/tests/fixtures/grounded_public21.py",
    "desktop/tests/fixtures/explicit_review_bridge.py",
})
_FULL140_MIXED_REQUIRED_SOURCES = _FULL140_V4_REQUIRED_SOURCES | frozenset({
    "desktop/tests/fixtures/full140-mixed-v-off-public.py",
    ".scratch/grounded-evaluation/full140-mixed-v-off-plan-20261016.md",
    ".scratch/grounded-evaluation/full140-mixed-v-off-implementation-20261016.md",
    "architecture/adr/059-closed-unknown-kinds-and-calendar-month.md",
})
_REFERENCE21_V4_REQUIRED_SOURCES = _NULLABLE_REQUIRED_SOURCES | frozenset({
    PUBLIC_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH,
    "backend/src/notalone/runtime_config.py", "desktop/tests/fixtures/reference21-v4-public.py",
    ".scratch/grounded-evaluation/reference21-complete-v4-plan-20261016.md",
    ".scratch/grounded-evaluation/reference21-complete-v4-implementation-20261016.md",
    ".scratch/grounded-evaluation/reference-source-fidelity-v2-spec-20261016.md",
    ".scratch/grounded-v4-protocol-readiness/spec.md", ".scratch/grounded-v4-object-ownership/spec.md",
    ".scratch/grounded-v4-stable-facts/spec.md", ".scratch/grounded-v4-quantity-continuation/spec.md",
    "architecture/adr/059-closed-unknown-kinds-and-calendar-month.md",
    "desktop/tests/fixtures/grounded_public21.py",
    "desktop/tests/fixtures/explicit_review_bridge.py",
})
_SEMANTIC4_REQUIRED_SOURCES = _REFERENCE21_V4_REQUIRED_SOURCES | frozenset({
    ".scratch/grounded-evaluation/reference21-semantic4-plan-20261016.md",
    ".scratch/grounded-evaluation/reference21-semantic4-implementation-20261016.md",
    ".scratch/grounded-v4-matter-reference/spec.md",
})
_UNIQUENESS_REQUIRED_SOURCES = _SEMANTIC4_REQUIRED_SOURCES | frozenset({
    ".scratch/grounded-evaluation/reference21-uniqueness-plan-20261016.md",
    ".scratch/grounded-evaluation/reference21-uniqueness-implementation-20261016.md",
    ".scratch/grounded-ambiguity-check-plan/spec.md",
    ".scratch/grounded-ambiguity-check-plan/implementation-result-20261016.md",
})
_REFERENCE16_PRO_REQUIRED_SOURCES = _NULLABLE_REQUIRED_SOURCES | frozenset({
    PUBLIC_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH,
    ".scratch/memory-extraction-accuracy/reference-pro16-plan-20261018.md",
    "backend/src/notalone/runtime_config.py", "desktop/tests/fixtures/reference21-v4-public.py",
    "desktop/tests/fixtures/grounded_public21.py", "desktop/tests/fixtures/explicit_review_bridge.py",
})
_BACKEND_ROOT = _SOURCE_DIRECTORY.parents[2]
_BOUNDED_BACKEND_SOURCES = frozenset(
    f"backend/{path.relative_to(_BACKEND_ROOT).as_posix()}"
    for path in (_BACKEND_ROOT / "src/notalone").rglob("*.py")
)
_BOUNDED_RUNTIME_REQUIRED_SOURCES = _BOUNDED_BACKEND_SOURCES | _BOUNDED_MIGRATION_SOURCES | frozenset({
    "backend/pyproject.toml", BOUNDED_RUNTIME_REFERENCE_PATH, BOUNDED_RUNTIME_ANNOTATION_PATH,
    "desktop/tests/fixtures/reference21-v4-public.py",
    "desktop/tests/fixtures/grounded_public21.py",
    "desktop/tests/fixtures/explicit_review_bridge.py",
})
_AUDIT_REASONS = {
    "safe": {"supported"}, "general_error": {"coverage_miss", "contract_mismatch"},
    "safety_error": {"false_fact", "wrong_subject", "contract_mismatch"},
    "unknown": {"audit_unresolved"},
}


def _reference_paths(reference_version: str) -> tuple[str, str, str, str]:
    return ((FULL_REFERENCE_V2_PATH, FULL_ANNOTATION_V2_PATH, PUBLIC_REFERENCE_V2_PATH, PUBLIC_ANNOTATION_V2_PATH)
            if reference_version == "source-fidelity-v2" else
            (FULL_REFERENCE_PATH, FULL_ANNOTATION_PATH, PUBLIC_REFERENCE_PATH, _CRITERIA_PATH))


def _gold_reference(
    frozen_gold: dict, source_hashes: dict[str, str], *, case_set: str = "reference21",
    verification_mode: SourceVerificationMode = SourceVerificationMode.LEGACY_V4,
    reference_version: str = "legacy-v1",
    execution_plan: str = "original",
) -> dict:
    """这里只核对准备协议，不把 Agent 标记认证为真实语义质量。"""
    cases = _FULL_CASES if case_set == "full140" else _PLAN_CASES
    if (not isinstance(frozen_gold, dict)
            or frozen_gold.get("status") != "frozen_agent_review"
            or not set(frozen_gold) <= _GOLD_FIELDS
            or frozen_gold.get("case_names") != [case.name for case in cases]
            or len(cases) != (140 if case_set == "full140" else 21)):
        raise EvaluationBudgetAbort("ecnu_gold_not_frozen")
    criterion = frozen_gold.get("criteria_path", _CRITERIA_PATH)
    digest = frozen_gold.get("criteria_sha256")
    required_sources = (_REFERENCE16_PRO_REQUIRED_SOURCES if execution_plan == REFERENCE16_PRO_PLAN else
                        _UNIQUENESS_REQUIRED_SOURCES if execution_plan == UNIQUENESS_PLAN else
                        _SEMANTIC4_REQUIRED_SOURCES if execution_plan == SEMANTIC4_PLAN else
                        _REFERENCE21_V4_REQUIRED_SOURCES if execution_plan == REFERENCE21_V4_PLAN else
                        _FULL140_E2_REQUIRED_SOURCES if execution_plan == FULL140_E2_PLAN else
                        _FULL140_MIXED_REQUIRED_SOURCES if execution_plan == MIXED_PLAN else
                        _FULL140_V4_REQUIRED_SOURCES if reference_version == "source-fidelity-v2" else
                        _NULLABLE_REQUIRED_SOURCES
                        if verification_mode is SourceVerificationMode.NULLABLE_PROOF_V1
                        else _REQUIRED_SOURCES)
    if (not isinstance(criterion, str) or not isinstance(digest, str)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            or not isinstance(source_hashes, dict)
            or source_hashes.get(criterion) != digest
            or not (required_sources | {criterion}) <= set(source_hashes)):
        raise EvaluationBudgetAbort("ecnu_source_freeze_incomplete")
    full_path, annotation_path, parent_path, parent_annotation = _reference_paths(reference_version)
    if case_set == "full140" and (
        criterion != full_path or not {
            full_path, annotation_path, parent_path, parent_annotation,
        } <= set(source_hashes)
    ):
        raise EvaluationBudgetAbort("ecnu_full_reference_freeze_incomplete")
    return {"criteria_sha256": digest, "gold_sha256": canonical_sha256(frozen_gold)}


def _load_fixed_reference(repo_root: Path, source_hashes: dict[str, str], *, reference_version: str = "legacy-v1",
                          case_set: str = "full140") -> dict:
    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        value: dict = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate_reference_key")
            value[key] = item
        return value

    try:
        full_path, annotation_path, parent_path, parent_annotation = _reference_paths(reference_version)
        if case_set == "reference21":
            full_path, annotation_path = parent_path, parent_annotation
        content = (repo_root / full_path).read_bytes()
        if hashlib.sha256(content).hexdigest() != source_hashes[full_path]:
            raise ValueError("changed_reference_bytes")
        reference = json.loads(content, object_pairs_hook=unique_object)
        validation = (validate_public_reference if case_set == "reference21" else validate_full_public_reference)(
            reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=source_hashes[annotation_path], reference_version=reference_version,
        )
        parent = reference["provenance"].get("parent21")
        if (case_set == "full140" and (source_hashes[parent_path] != parent["reference_file_sha256"]
                or source_hashes[parent_annotation] != parent["reference"]["annotation_sha256"]
                ) or reference_version == "source-fidelity-v2" and validation.get("execution_ready") is not True):
            raise ValueError("changed_parent_file_binding")
        return validation
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, EvaluationBudgetAbort):
        raise EvaluationBudgetAbort("ecnu_full_reference_invalid") from None


def _audit_callback(audit_case: Callable[[dict], dict], reference: dict) -> Callable:
    def validated(bundle: dict) -> dict:
        position = bundle["case_position"]
        answer = audit_case(bundle)
        if (not isinstance(answer, dict)
                or set(answer) != {"case_position", "decision", "reason_code", "criteria_sha256"}
                or type(answer["case_position"]) is not int
                or answer["case_position"] != position
                or not isinstance(answer["decision"], str)
                or not isinstance(answer["reason_code"], str)
                or answer["reason_code"] not in _AUDIT_REASONS.get(answer["decision"], set())
                or answer["criteria_sha256"] != reference["criteria_sha256"]):
            raise EvaluationBudgetAbort("ecnu_invalid_semantic_audit")
        return dict(answer)
    return validated


def _bounded_source_inventory(repo_root: Path, source_hashes: dict[str, str]) -> None:
    """完整源码清单在注册时固定；新增、删除也不能逃过逐次复核。"""
    actual = frozenset(f"backend/{path.relative_to(repo_root / 'backend').as_posix()}"
                       for path in (repo_root / "backend/src/notalone").rglob("*.py"))
    migrations = frozenset(f"backend/database/migrations/{path.name}"
                          for path in (repo_root / "backend/database/migrations").glob("*.sql")
                          if re.fullmatch(r"(?:00[1-9]|0[1-6][0-9]|07[0-2])_.+\.sql", path.name))
    if (actual != _BOUNDED_BACKEND_SOURCES or migrations != _BOUNDED_MIGRATION_SOURCES
            or not _BOUNDED_RUNTIME_REQUIRED_SOURCES <= set(source_hashes)):
        raise EvaluationBudgetAbort("evaluation_bounded_source_inventory_changed")


def _bounded_formal_bindings(
    windows: tuple[ExtractionWindow, ...], task_ids: tuple[UUID, ...], database_url: str,
) -> list[dict]:
    """只读实际任务、来源和默认单批窗口；首次提取留给已登记后的worker。"""
    from .evaluation_formal_task import _task_window
    from .evaluation_reference import bounded_window_projection
    from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
    from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
    from notalone.scopes import ContactScope
    from notalone.tasks.extraction_runtime import runtime_config_for_mode
    from notalone.tasks.models import (
        BackgroundTaskStatus, BackgroundTaskStepName, BackgroundTaskStepStatus,
        BackgroundTaskType, ExtractionRuntimeMode,
    )

    repository = PostgresBackgroundTaskRepository(database_url)
    traces = PostgresExtractionTraceStore(database_url)
    expected_config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
    bindings = []
    for window, task_id, case, item in zip(windows, task_ids, BOUNDED_RUNTIME_CASES,
                                          BOUNDED_RUNTIME_INPUTS, strict=True):
        task = repository.get_task(owner_id=window.owner_id, contact_id=window.contact_id, task_id=task_id)
        extraction = [step for step in task.steps if step.name is BackgroundTaskStepName.EXTRACT_MEMORY]
        if (task.owner_id != window.owner_id or task.contact_id != window.contact_id or task.task_id != task_id
                or task.extraction_runtime_config != expected_config or task.retry_count != 0
                or task.task_type is not (BackgroundTaskType.IMPORT if item["source_route"] == "jsonl"
                                         else BackgroundTaskType.OBSERVATION)
                or task.status not in {BackgroundTaskStatus.QUEUED, BackgroundTaskStatus.RUNNING}
                or len(extraction) != 1 or extraction[0].status is not BackgroundTaskStepStatus.PENDING
                or extraction[0].attempt_count != 0
                or canonical_sha256(bounded_window_projection(window)) != canonical_sha256({
                    "messages": item["messages"], "target_indices": item["target_indices"]})
                or canonical_sha256(_task_window(database_url, window, case)) != canonical_sha256(window)
                or traces.list_batches(ContactScope(window.owner_id, window.contact_id), limit=1)):
            raise EvaluationBudgetAbort("evaluation_bounded_formal_source_mismatch")
        bindings.append({"owner_id": str(window.owner_id), "contact_id": str(window.contact_id),
            "task_id": str(task_id), "extraction_runtime_config": expected_config.to_payload(),
            "input_sha256": canonical_sha256(window)})
    return bindings


def _run_bounded_runtime_evaluation(
    *, output_directory: Path, run_id: UUID, deadline: datetime, repo_root: Path,
    source_hashes: dict[str, str], frozen_gold: dict, credential_loader: Callable[[], str],
    audit_case: Callable[[dict], dict], synthetic_transport: httpx.MockTransport | None,
    windows: tuple[ExtractionWindow, ...], task_ids: tuple[UUID, ...], database_url: str,
    guard: BoundedRuntime15Deadline, provider_profile: str,
) -> dict:
    """在共享入口登记固定正式任务；沿原预算、SDK、审核与收尾执行。"""
    from .evaluation_provider_contract import ECNUEvaluationContract, EvaluationProviderProfile
    from .grounded_adapter import BOUNDED_DEPENDENCY_PROMPT_PROFILE
    from .evaluation_phased_audit import PhasedEvaluationAudit
    from .evaluation_reference import validate_bounded_public_reference
    from notalone.memory.bounded_evidence import rule_set_sha256
    from langchain_core.utils.function_calling import convert_to_openai_tool
    from langsmith import get_tracing_context

    profile = EvaluationProviderProfile(provider_profile)
    if not profile.is_bounded:
        raise EvaluationBudgetAbort("evaluation_bounded_fixed_profile_required")
    if (current_trace() is not None or get_tracing_context().get("enabled") is True
            or not callable(credential_loader) or type(audit_case) is not PhasedEvaluationAudit
            or synthetic_transport is not None and type(synthetic_transport) is not httpx.MockTransport
            or synthetic_transport is None and repo_root.resolve() != Path(__file__).resolve().parents[4]):
        raise EvaluationBudgetAbort("evaluation_bounded_explicit_protocol_required")
    _bounded_source_inventory(repo_root, source_hashes)
    contract = ECNUEvaluationContract(deadline=deadline, repo_root=repo_root, source_hashes=source_hashes,
        provider_profile=profile, extraction_mode="grounded-v2", execution_plan=BOUNDED_RUNTIME_PLAN,
        extraction_prompt_profile=BOUNDED_DEPENDENCY_PROMPT_PROFILE)

    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        result: dict = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate_reference_key")
            result[key] = value
        return result

    try:
        content = (repo_root / BOUNDED_RUNTIME_REFERENCE_PATH).read_bytes()
        reference = json.loads(content, object_pairs_hook=unique_object)
        validation = validate_bounded_public_reference(reference,
            expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=source_hashes[BOUNDED_RUNTIME_ANNOTATION_PATH])
        if (hashlib.sha256(content).hexdigest() != source_hashes[BOUNDED_RUNTIME_REFERENCE_PATH]
                or set(frozen_gold) != _GOLD_FIELDS or frozen_gold["status"] != "frozen_agent_review"
                or frozen_gold["case_names"] != [case.name for case in BOUNDED_RUNTIME_CASES]
                or frozen_gold["criteria_path"] != BOUNDED_RUNTIME_REFERENCE_PATH
                or frozen_gold["criteria_sha256"] != source_hashes[BOUNDED_RUNTIME_REFERENCE_PATH]
                or audit_case.reference_sha256 != validation["reference_sha256"]
                or audit_case.criteria_sha256 != frozen_gold["criteria_sha256"]
                or audit_case.execution_plan != BOUNDED_RUNTIME_PLAN or audit_case.reference_version != BOUNDED_RUNTIME_PLAN
                or audit_case.case_set != "bounded15" or audit_case.case_positions != tuple(range(15))
                or audit_case.extraction_mode != "grounded-v2" or audit_case.extraction_prompt_profile != BOUNDED_DEPENDENCY_PROMPT_PROFILE
                or audit_case.verification_mode != "nullable-proof-v3"
                or audit_case.extraction_tool_choice != "omitted" or audit_case.verification_tool_choice != "forced"):
            raise ValueError("changed_bounded_reference_binding")
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        raise EvaluationBudgetAbort("evaluation_bounded_reference_invalid") from None
    bindings = _bounded_formal_bindings(windows, task_ids, database_url)
    plan = tuple({"case_position": index, "case_name": case.name, "input_sha256": canonical_sha256(window)}
                 for index, (case, window) in enumerate(zip(BOUNDED_RUNTIME_CASES, windows, strict=True)))
    extraction_contracts = tuple(deepcopy(extraction_contract("grounded-v2", window, prompt_profile=BOUNDED_DEPENDENCY_PROMPT_PROFILE)) for window in windows)
    v_contract = deepcopy(_verification_contract(SourceVerificationMode.NULLABLE_PROOF_V3))
    config = {**_frozen_config(plan, request_timeout_seconds=300.0, max_retries=0,
        verification_mode="nullable-proof-v3", extraction_mode="grounded-v2", windows=windows,
        extraction_prompt_profile=BOUNDED_DEPENDENCY_PROMPT_PROFILE),
        "mode": BOUNDED_RUNTIME_MODE, "stage": BOUNDED_RUNTIME_STAGE,
        "base_url": profile.base_url, "endpoint": profile.endpoint, "request_model": profile.model,
        "execution_plan": BOUNDED_RUNTIME_PLAN, "reference_version": BOUNDED_RUNTIME_PLAN,
        "selected_case_positions": list(range(15)), "deadline_utc": deadline.astimezone(timezone.utc).isoformat(),
        "source_hashes": dict(source_hashes), "gold_sha256": validation["reference_sha256"],
        "public_cases_sha256": canonical_sha256(BOUNDED_RUNTIME_CASES), "formal_tasks": bindings,
        "bounded_inputs_sha256": canonical_sha256(tuple({"messages": item["messages"],
            "target_indices": item["target_indices"]} for item in BOUNDED_RUNTIME_INPUTS)),
        "runtime_rule_set_sha256": rule_set_sha256(), "request_contract_version": 2,
        "response_identity_policy": "first_valid_completion_observation_stop_on_change",
        "tool_choice": {"extraction": {"mode": "omitted", "name": extraction_contracts[0][1]["title"]},
                        "verification": {"mode": "forced", "name": v_contract[1]["title"]}},
        "fallback": False, "versions": {name: version(name) for name in (
            "openai", "langchain-core", "langchain-deepseek", "langchain-openai", "httpx", "httpx2", "langsmith", "pydantic")},
    }
    if profile is EvaluationProviderProfile.DEEPSEEK_PRO_BOUNDED_TASK:
        config.update(request_contract_version=3, provider_profile=profile.value, **profile.output_parameters)
    config.pop("thinking")
    config["omitted_parameters"].remove("reasoning_effort")

    def check_runtime() -> None:
        _bounded_source_inventory(repo_root, source_hashes)
        if {name: version(name) for name in config["versions"]} != config["versions"]:
            raise EvaluationBudgetAbort("evaluation_bounded_package_versions_changed")
        contract.check_preflight()

    check_runtime()
    # 所有只读准入已完成，才创建不可恢复的独立预算。
    budget = EvaluationBudget.create(run_id=run_id, output_directory=output_directory, request_limit=30,
        allowed_endpoints=(profile.endpoint,), config_sha256=canonical_sha256(config))
    try:
        store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan, actual_windows=windows)
    except BaseException:
        budget.close()
        raise

    @contextmanager
    def invocation_scope(purpose: str, messages: list[dict], window: ExtractionWindow):
        check_runtime()
        position = windows.index(window)
        live = (extraction_contract("grounded-v2", window, prompt_profile=BOUNDED_DEPENDENCY_PROMPT_PROFILE) if purpose == "extraction"
                else _verification_contract(SourceVerificationMode.NULLABLE_PROOF_V3))
        frozen = extraction_contracts[position] if purpose == "extraction" else v_contract
        if purpose not in {"extraction", "verification"} or canonical_sha256(live) != canonical_sha256(frozen):
            raise EvaluationBudgetAbort("ecnu_runtime_contract_changed")
        prompt, schema = frozen
        if not messages or messages[0] != {"role": "system", "content": prompt}:
            raise EvaluationBudgetAbort("ecnu_runtime_prompt_changed")
        verification = purpose == "verification"
        expected = {"model": profile.model, "temperature": 0.0, "stream": False, **profile.output_parameters,
            "reasoning_effort": "none" if verification else "max",
            "thinking": {"type": "disabled" if verification else "enabled"}, "messages": messages,
            "tools": [deepcopy(convert_to_openai_tool(schema))],
            **({"tool_choice": {"type": "function", "function": {"name": schema["title"]}}} if verification else {})}
        with guard.invocation(), contract.expect_request(expected):
            yield

    loaded = False

    def bounded_loader() -> str:
        nonlocal loaded
        if loaded:
            raise EvaluationBudgetAbort("evaluation_bounded_credentials_already_loaded")
        check_runtime()
        guard.start(budget, synthetic=synthetic_transport is not None)
        loaded = True
        return credential_loader()

    try:
        result = _run_evaluation_batch(cases=BOUNDED_RUNTIME_CASES, windows=windows, plan=plan,
            budget=budget, store=store, base_url=profile.base_url, request_model=profile.model, api_key="",
            synthetic_transport=synthetic_transport, provider="DeepSeek", contract=contract,
            invocation_scope=invocation_scope, semantic_audit=audit_case,
            gold_reference={"criteria_sha256": frozen_gold["criteria_sha256"]}, code_prefix="deepseek",
            credential_loader=bounded_loader, request_timeout_seconds=300.0, max_retries=0,
            verification_mode="nullable-proof-v3", verification_tool_choice="forced", reasoning_effort="max",
            extraction_tool_choice="omitted", extraction_mode="grounded-v2", execution_plan=BOUNDED_RUNTIME_PLAN,
            formal_task_ids=task_ids, database_url=database_url, extraction_prompt_profile=BOUNDED_DEPENDENCY_PROMPT_PROFILE)
    except BaseException as error:
        try:
            budget.close()
        except BaseException:
            error.add_note("bounded_runtime15_budget_close_unknown")
        try:
            guard.finish()
        except BaseException:
            error.add_note("bounded_runtime15_deadline_cleanup_unknown")
        raise
    try:
        guard.finish()
    except BaseException:
        result["cleanup_error_codes"] = (*result.get("cleanup_error_codes", ()), "bounded_runtime15_deadline_cleanup_unknown")
        result["receipt"] = None
        result["receipt_error_code"] = "bounded_runtime15_completion_receipt_unavailable"
    result.update(worker_pid=os.getpid(), execution_plan=BOUNDED_RUNTIME_PLAN)
    return result


def run_ecnu_evaluation(
    *, output_directory: Path, run_id: UUID, deadline: datetime, repo_root: Path,
    source_hashes: dict[str, str], frozen_gold: dict,
    credential_loader: Callable[[], str], audit_case: Callable[[dict], dict],
    synthetic_transport: httpx.MockTransport | None = None,
    request_timeout_seconds: float = 60.0, max_retries: int = 2,
    case_positions: tuple[int, ...] | None = None,
    case_set: str = "reference21",
    verification_mode: SourceVerificationMode | str = SourceVerificationMode.LEGACY_V4,
    verification_tool_choice: str = "forced",
    response_identity_policy: str = "first_valid_completion_observation_stop_on_change",
    provider_profile: str = "ecnu",
    request_limit: int | None = None,
    extraction_mode: EvaluationExtractionMode | str = EvaluationExtractionMode.LEGACY_E14,
    execution_plan: str = "original",
    remaining8_deadline: object | None = None,
    ambiguity2_deadline: object | None = None,
    main16_deadline: object | None = None,
    reference_version: str = "legacy-v1",
    full140_v4_deadline: object | None = None,
    reference21_v4_deadline: object | None = None,
    extraction_prompt_profile: str = "default",
    formal_windows: tuple[ExtractionWindow, ...] | None = None,
    formal_task_ids: tuple[UUID, ...] = (),
    database_url: str | None = None,
    bounded_runtime_deadline: BoundedRuntime15Deadline | None = None,
) -> dict:
    """保留原固定计划；剩余8窗须显式选择独立版本，不提供任意子集。"""
    from .evaluation_provider_contract import EvaluationProviderProfile
    from .grounded_adapter import BOUNDED_DEPENDENCY_PROMPT_PROFILE

    pro16 = execution_plan == REFERENCE16_PRO_PLAN
    if pro16 or provider_profile == EvaluationProviderProfile.DEEPSEEK_PRO_REFERENCE16:
        if (not pro16 or provider_profile != EvaluationProviderProfile.DEEPSEEK_PRO_REFERENCE16
                or case_set != "reference21" or type(case_positions) is not tuple
                or case_positions != tuple(range(16)) or any(type(value) is not int for value in case_positions)
                or type(request_limit) is not int or request_limit != 32
                or extraction_mode != "grounded-v2" or extraction_prompt_profile != "default"
                or verification_mode != "legacy-v4" or verification_tool_choice != "forced"
                or reference_version != "source-fidelity-v2"
                or response_identity_policy != "first_valid_completion_observation_stop_on_change"
                or type(request_timeout_seconds) is not int or request_timeout_seconds != 300
                or type(max_retries) is not int or max_retries != 0
                or formal_windows is not None or formal_task_ids != () or database_url is not None
                or any(value is not None for value in (remaining8_deadline, ambiguity2_deadline,
                    full140_v4_deadline, reference21_v4_deadline, bounded_runtime_deadline))):
            raise EvaluationBudgetAbort("evaluation_reference16_pro_fixed_plan_required")

    bounded15 = execution_plan == BOUNDED_RUNTIME_PLAN
    if (bounded15 or provider_profile in {EvaluationProviderProfile.DEEPSEEK_BOUNDED_TASK, EvaluationProviderProfile.DEEPSEEK_PRO_BOUNDED_TASK}
            or case_set == "bounded15" or formal_windows is not None or formal_task_ids != ()
            or database_url is not None or bounded_runtime_deadline is not None):
        if (not bounded15 or provider_profile not in {EvaluationProviderProfile.DEEPSEEK_BOUNDED_TASK, EvaluationProviderProfile.DEEPSEEK_PRO_BOUNDED_TASK}
                or reference_version != BOUNDED_RUNTIME_PLAN or case_set != "bounded15" or case_positions is not None
                or extraction_mode != "grounded-v2" or extraction_prompt_profile != BOUNDED_DEPENDENCY_PROMPT_PROFILE
                or verification_mode != "nullable-proof-v3" or verification_tool_choice != "forced"
                or response_identity_policy != "first_valid_completion_observation_stop_on_change"
                or type(request_limit) is not int or request_limit != 30
                or type(request_timeout_seconds) not in (int, float) or request_timeout_seconds != 300
                or type(max_retries) is not int or max_retries != 0
                or type(formal_windows) is not tuple or len(formal_windows) != 15
                or any(type(window) is not ExtractionWindow for window in formal_windows)
                or len({window.contact_id for window in formal_windows}) != 15
                or type(formal_task_ids) is not tuple or len(formal_task_ids) != 15
                or any(type(task_id) is not UUID for task_id in formal_task_ids) or len(set(formal_task_ids)) != 15
                or type(database_url) is not str or not database_url
                or type(bounded_runtime_deadline) is not BoundedRuntime15Deadline
                or synthetic_transport is None and not bounded_runtime_deadline.live_worker
                or any(value is not None for value in (remaining8_deadline, ambiguity2_deadline,
                    main16_deadline, full140_v4_deadline, reference21_v4_deadline))):
            raise EvaluationBudgetAbort("evaluation_bounded_fixed_tasks_required")
        return _run_bounded_runtime_evaluation(output_directory=output_directory, run_id=run_id,
            deadline=deadline, repo_root=repo_root, source_hashes=source_hashes, frozen_gold=frozen_gold,
            credential_loader=credential_loader, audit_case=audit_case, synthetic_transport=synthetic_transport,
            windows=formal_windows, task_ids=formal_task_ids, database_url=database_url, guard=bounded_runtime_deadline,
            provider_profile=provider_profile)

    mixed = type(execution_plan) is str and execution_plan in PHASE_SPLIT_PLANS
    reference21_v4 = type(execution_plan) is str and execution_plan in REFERENCE21_PLANS
    uniqueness = execution_plan == UNIQUENESS_PLAN
    public_quality = type(execution_plan) is str and execution_plan in PUBLIC_QUALITY_PLANS
    prompt_profile = SEMANTIC4_PROMPT_PROFILE if public_quality else "default"
    validate_extraction_prompt_profile(execution_plan, extraction_prompt_profile)
    full140_v4 = execution_plan in ("full140-grounded-v4-source-v2", MIXED_PLAN)
    full140_e2 = execution_plan == FULL140_E2_PLAN
    fixed_full140 = full140_v4 or full140_e2
    fixed_source_v2 = fixed_full140 or reference21_v4 or pro16
    if (type(reference_version) is not str or reference_version not in {"legacy-v1", "source-fidelity-v2"}
            or not fixed_source_v2 and (reference_version != "legacy-v1" or extraction_mode == "grounded-v4")):
        raise EvaluationBudgetAbort("evaluation_full140_v4_fixed_plan_required")
    try:
        extraction_selected = EvaluationExtractionMode(extraction_mode)
    except (TypeError, ValueError):
        raise EvaluationBudgetAbort("evaluation_extraction_mode_invalid") from None
    try:
        profile = EvaluationProviderProfile(provider_profile)
    except (TypeError, ValueError):
        raise EvaluationBudgetAbort("evaluation_provider_profile_invalid") from None
    official = profile.is_official
    if mixed != (profile is EvaluationProviderProfile.DEEPSEEK_PHASE_SPLIT):
        raise EvaluationBudgetAbort("evaluation_mixed_fixed_plan_required")
    remaining8 = execution_plan == "reference21-remaining8-v1"
    ambiguity2 = execution_plan == "reference21-ambiguity2-v3"
    main16 = execution_plan == "reference21-main16-v3"
    if (type(execution_plan) is not str or execution_plan not in {"original", "reference21-remaining8-v1", "reference21-ambiguity2-v3", "reference21-main16-v3", "full140-grounded-v4-source-v2", REFERENCE16_PRO_PLAN, *PHASE_SPLIT_PLANS}
            or remaining8 and (not official or case_set != "reference21"
                or type(case_positions) is not tuple or case_positions != _REMAINING8_POSITIONS
                or any(type(position) is not int for position in case_positions)
                or type(request_limit) is not int or request_limit != 16
                or extraction_selected is not EvaluationExtractionMode.GROUNDED_V2
                or verification_mode != SourceVerificationMode.NULLABLE_PROOF_V1
                or verification_tool_choice != "omitted"
                or request_timeout_seconds != 300 or type(max_retries) is not int or max_retries != 0)):
        raise EvaluationBudgetAbort("evaluation_remaining8_fixed_plan_required")
    if ambiguity2 and (not official or case_set != "reference21"
            or type(case_positions) is not tuple or case_positions != _AMBIGUITY2_POSITIONS
            or any(type(position) is not int for position in case_positions)
            or type(request_limit) is not int or request_limit != 4
            or extraction_selected is not EvaluationExtractionMode.GROUNDED_V3
            or verification_mode != SourceVerificationMode.NULLABLE_PROOF_V1
            or verification_tool_choice != "omitted"
            or request_timeout_seconds != 300 or type(max_retries) is not int or max_retries != 0):
        raise EvaluationBudgetAbort("evaluation_ambiguity2_fixed_plan_required")
    if main16 and (not official or case_set != "reference21"
            or type(case_positions) is not tuple or case_positions != _MAIN16_POSITIONS
            or any(type(position) is not int for position in case_positions)
            or type(request_limit) is not int or request_limit != 32
            or extraction_selected is not EvaluationExtractionMode.GROUNDED_V3
            or verification_mode != SourceVerificationMode.NULLABLE_PROOF_V1
            or verification_tool_choice != "omitted"
            or request_timeout_seconds != 300 or type(max_retries) is not int or max_retries != 0):
        raise EvaluationBudgetAbort("evaluation_main16_fixed_plan_required")
    if full140_v4 and (not official or type(case_set) is not str or case_set != "full140"
            or case_positions is not None or type(request_limit) is not int or request_limit != 280
            or extraction_selected.value != "grounded-v4" or reference_version != "source-fidelity-v2"
            or verification_mode != SourceVerificationMode.NULLABLE_PROOF_V1
            or verification_tool_choice != ("forced" if mixed else "omitted")
            or type(request_timeout_seconds) is not int or request_timeout_seconds != 300
            or type(max_retries) is not int or max_retries != 0):
        raise EvaluationBudgetAbort("evaluation_full140_v4_fixed_plan_required")
    if full140_e2 and (not official or type(case_set) is not str or case_set != "full140"
            or case_positions is not None or type(request_limit) is not int or request_limit != 280
            or extraction_selected is not EvaluationExtractionMode.GROUNDED_V2 or reference_version != "source-fidelity-v2"
            or verification_mode != SourceVerificationMode.LEGACY_V4 or verification_tool_choice != "forced"
            or type(request_timeout_seconds) is not int or request_timeout_seconds != 300
            or type(max_retries) is not int or max_retries != 0):
        raise EvaluationBudgetAbort("evaluation_full140_e2_fixed_plan_required")
    if reference21_v4 and (not official or type(case_set) is not str or case_set != "reference21"
            or case_positions is not None or type(request_limit) is not int or request_limit != 42
            or extraction_selected.value != "grounded-v4" or reference_version != "source-fidelity-v2"
            or verification_mode != (SourceVerificationMode.LEGACY_V4 if public_quality else SourceVerificationMode.NULLABLE_PROOF_V1)
            or verification_tool_choice != "forced"
            or type(request_timeout_seconds) is not int or request_timeout_seconds != 300
            or type(max_retries) is not int or max_retries != 0):
        raise EvaluationBudgetAbort("evaluation_reference21_v4_fixed_plan_required")
    from .evaluation_ambiguity2_deadline import Ambiguity2Deadline
    from .evaluation_main16_deadline import Main16Deadline
    from .evaluation_remaining8_deadline import Remaining8Deadline
    from .evaluation_full140_v4_deadline import Full140V4Deadline
    from .evaluation_reference21_v4_deadline import Reference21V4Deadline

    if ((remaining8_deadline is not None and (not remaining8 or type(remaining8_deadline) is not Remaining8Deadline))
            or remaining8 and synthetic_transport is None and (
                type(remaining8_deadline) is not Remaining8Deadline or not remaining8_deadline.live_worker)):
        raise EvaluationBudgetAbort("remaining8_owned_deadline_required")
    if ((ambiguity2_deadline is not None and (not ambiguity2 or type(ambiguity2_deadline) is not Ambiguity2Deadline))
            or ambiguity2 and synthetic_transport is None and (
                type(ambiguity2_deadline) is not Ambiguity2Deadline or not ambiguity2_deadline.live_worker)):
        raise EvaluationBudgetAbort("ambiguity2_owned_deadline_required")
    if ((main16_deadline is not None and (not (main16 or pro16) or type(main16_deadline) is not Main16Deadline))
            or (main16 or pro16) and synthetic_transport is None and (
                type(main16_deadline) is not Main16Deadline or not main16_deadline.live_worker)):
        raise EvaluationBudgetAbort("main16_owned_deadline_required")
    if ((full140_v4_deadline is not None and (not fixed_full140 or type(full140_v4_deadline) is not Full140V4Deadline))
            or fixed_full140 and (type(full140_v4_deadline) is not Full140V4Deadline
                or synthetic_transport is None and not full140_v4_deadline.live_worker)):
        raise EvaluationBudgetAbort("full140_v4_owned_deadline_required")
    if ((reference21_v4_deadline is not None and (not reference21_v4 or type(reference21_v4_deadline) is not Reference21V4Deadline))
            or reference21_v4 and (type(reference21_v4_deadline) is not Reference21V4Deadline
                or synthetic_transport is None and not reference21_v4_deadline.live_worker)):
        raise EvaluationBudgetAbort("reference21_v4_owned_deadline_required")
    bounded = cast(Remaining8Deadline | Ambiguity2Deadline | Main16Deadline | Full140V4Deadline | Reference21V4Deadline | None,
                   remaining8_deadline or ambiguity2_deadline or main16_deadline or full140_v4_deadline or reference21_v4_deadline)
    if official and case_set == "reference21" and not remaining8 and not ambiguity2 and not main16 and not pro16 and (
        case_positions is not None or request_limit not in (None, 42)
    ):
        raise EvaluationBudgetAbort("evaluation_official_fixed_reference21_required")
    if official and not mixed and not pro16 and verification_tool_choice != "omitted":
        raise EvaluationBudgetAbort("evaluation_official_tools_must_be_omitted")
    if request_limit is not None and (
        not official or type(request_limit) is not int or not 1 <= request_limit <= 280
    ):
        raise EvaluationBudgetAbort("evaluation_request_limit_invalid")
    base_url, endpoint, request_model = profile.base_url, profile.endpoint, profile.model
    try:
        selected = SourceVerificationMode(verification_mode)
    except (TypeError, ValueError):
        raise EvaluationBudgetAbort("ecnu_invalid_verification_mode") from None
    from .evaluation_provider_contract import (
        KNOWN_ECNU_RESPONSE_IDENTITY_POLICY, KNOWN_ECNU_RESPONSE_LABELS,
        validate_evaluation_policy,
    )

    validate_evaluation_policy(verification_tool_choice, response_identity_policy)
    if (verification_tool_choice == "omitted"
            and selected is not SourceVerificationMode.NULLABLE_PROOF_V1):
        raise EvaluationBudgetAbort("ecnu_omitted_verification_requires_nullable")
    if (verification_tool_choice == "omitted"
            or response_identity_policy == KNOWN_ECNU_RESPONSE_IDENTITY_POLICY):
        from langsmith import get_tracing_context

        if get_tracing_context().get("enabled") is True:
            raise EvaluationBudgetAbort("ecnu_external_tracing_enabled")
    if (type(request_timeout_seconds) not in (int, float)
            or not 0 < request_timeout_seconds <= 300
            or not isfinite(request_timeout_seconds)
            or type(max_retries) is not int or not 0 <= max_retries <= 2):
        raise EvaluationBudgetAbort("ecnu_invalid_request_limits")
    request_timeout_seconds = float(request_timeout_seconds)
    if (selected is SourceVerificationMode.NULLABLE_PROOF_V1
            and (request_timeout_seconds != 300.0 or max_retries != 0)):
        raise EvaluationBudgetAbort("ecnu_nullable_fixed_request_limits")
    if type(case_set) is not str or case_set not in {"reference21", "full140"}:
        raise EvaluationBudgetAbort("ecnu_invalid_case_set")
    if case_set == "full140":
        if (case_positions is not None or request_timeout_seconds != 300.0 or max_retries != 0):
            raise EvaluationBudgetAbort("ecnu_full_fixed_plan_required")
        try:
            positions = full_case_reference_positions()
        except ValueError:
            raise EvaluationBudgetAbort("ecnu_full_fixed_plan_required") from None
        cases = _FULL_CASES
    else:
        positions = tuple(range(len(_PLAN_CASES))) if case_positions is None else case_positions
        if (type(positions) is not tuple or not positions
                or (case_positions is not None and len(positions) > 4 and not remaining8 and not main16 and not pro16)
                or any(type(position) is not int or not 0 <= position < len(_PLAN_CASES)
                       for position in positions)
                or len(set(positions)) != len(positions)):
            raise EvaluationBudgetAbort("ecnu_invalid_case_positions")
        cases = tuple(_PLAN_CASES[position] for position in positions)
    if (current_trace() is not None or not callable(credential_loader)
            or not callable(audit_case)
            or (synthetic_transport is not None
                and type(synthetic_transport) is not httpx.MockTransport)):
        raise EvaluationBudgetAbort("ecnu_explicit_protocol_required")
    from .evaluation_phased_audit import PhasedEvaluationAudit

    if fixed_source_v2 and type(audit_case) is not PhasedEvaluationAudit:
        raise EvaluationBudgetAbort("ecnu_phased_audit_required")
    if type(audit_case) is PhasedEvaluationAudit and audit_case.reference_version != reference_version:
        raise EvaluationBudgetAbort("evaluation_phased_reference_version_mismatch")
    if type(audit_case) is PhasedEvaluationAudit and (mixed != (audit_case.execution_plan in PHASE_SPLIT_PLANS)
            or (mixed or pro16) and audit_case.execution_plan != execution_plan):
        raise EvaluationBudgetAbort("evaluation_phased_execution_plan_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.extraction_mode != extraction_selected.value):
        raise EvaluationBudgetAbort("evaluation_phased_extraction_mode_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.extraction_prompt_profile != extraction_prompt_profile):
        raise EvaluationBudgetAbort("evaluation_phased_extraction_prompt_profile_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.verification_mode != selected.value):
        raise EvaluationBudgetAbort("ecnu_phased_verification_mode_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.verification_tool_choice != verification_tool_choice):
        raise EvaluationBudgetAbort("ecnu_phased_tool_choice_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.extraction_tool_choice != ("omitted" if official and not pro16 else "forced")):
        raise EvaluationBudgetAbort("evaluation_phased_extraction_tool_choice_mismatch")
    if synthetic_transport is None:
        if type(audit_case) is not PhasedEvaluationAudit:
            raise EvaluationBudgetAbort("ecnu_phased_audit_required")
    reference = _gold_reference(
        frozen_gold, source_hashes, case_set=case_set, verification_mode=selected,
        reference_version=reference_version, execution_plan=execution_plan,
    )
    if synthetic_transport is None or fixed_source_v2:
        if (frozen_gold.get("criteria_path") !=
                (PUBLIC_REFERENCE_V2_PATH if reference21_v4 or pro16 else FULL_REFERENCE_V2_PATH if fixed_full140 else
                 FULL_REFERENCE_PATH if case_set == "full140" else PUBLIC_REFERENCE_PATH)
                or cast(PhasedEvaluationAudit, audit_case).criteria_sha256 !=
                reference["criteria_sha256"]):
            raise EvaluationBudgetAbort("ecnu_phased_reference_mismatch")
        if (cast(PhasedEvaluationAudit, audit_case).case_set != case_set
                or cast(PhasedEvaluationAudit, audit_case).case_positions != positions):
            raise EvaluationBudgetAbort("ecnu_phased_case_positions_mismatch")
    if (synthetic_transport is None
            and repo_root.resolve() != Path(__file__).resolve().parents[4]):
        raise EvaluationBudgetAbort("ecnu_actual_source_root_required")
    from langchain_core.utils.function_calling import convert_to_openai_tool
    from notalone.memory_extraction.evaluation_provider_contract import ECNUEvaluationContract

    contract = ECNUEvaluationContract(
        deadline=deadline, repo_root=repo_root, source_hashes=dict(source_hashes),
        verification_tool_choice=verification_tool_choice,
        response_identity_policy=response_identity_policy,
        provider_profile=profile,
        extraction_mode=extraction_selected,
        execution_plan=execution_plan,
        extraction_prompt_profile=extraction_prompt_profile,
    )
    if case_set == "full140" or reference21_v4 or pro16:
        validation = _load_fixed_reference(repo_root, source_hashes, reference_version=reference_version, case_set=case_set)
        if ((synthetic_transport is None or fixed_source_v2) and
                cast(PhasedEvaluationAudit, audit_case).reference_sha256 !=
                validation["reference_sha256"]):
            raise EvaluationBudgetAbort("ecnu_phased_reference_mismatch")
        if pro16:
            reference["gold_sha256"] = validation["reference_sha256"]
    windows = tuple(build_window(case) for case in cases)
    if public_quality:
        validate_semantic4_windows(windows)
    extraction_contracts = tuple(deepcopy(extraction_contract(extraction_selected, window, prompt_profile=extraction_prompt_profile))
                                 for window in windows)
    runtime_contracts = {
        "extraction": extraction_contracts[0],
        "verification": deepcopy(_verification_contract(selected, prompt_profile=prompt_profile)),
    }
    plan = tuple({
        "case_position": index, "case_name": case.name,
        "input_sha256": canonical_sha256(public_window_projection(window)),
    } for index, (case, window) in enumerate(zip(cases, windows)))
    config = {
        **_frozen_config(plan, request_timeout_seconds=request_timeout_seconds,
                         max_retries=max_retries, verification_mode=selected,
                         extraction_mode=extraction_selected, windows=windows, prompt_profile=prompt_profile,
                         extraction_prompt_profile=extraction_prompt_profile),
        "mode": (REFERENCE16_PRO_MODE if pro16 else FULL140_E2_MODE if full140_e2 else UNIQUENESS_MODE if uniqueness else SEMANTIC4_MODE if public_quality else REFERENCE21_V4_MODE if reference21_v4 else MIXED_MODE if mixed else "deepseek_bounded_full140_v4_source_v2" if full140_v4 else
                 "deepseek_bounded_main16_v3" if main16 else
                 "deepseek_bounded_ambiguity2_v3" if ambiguity2 else
                 "deepseek_bounded_remaining8" if remaining8 else
                 "deepseek_bounded_full140" if official and case_set == "full140" else
                 "deepseek_bounded_evaluation" if official else
                 "ecnu_bounded_full140" if case_set == "full140" else
                 "ecnu_bounded_evaluation" if case_positions is None
                 else "ecnu_bounded_diagnostic"),
        "stage": (REFERENCE16_PRO_STAGE if pro16 else FULL140_E2_STAGE if full140_e2 else UNIQUENESS_STAGE if uniqueness else SEMANTIC4_STAGE if public_quality else REFERENCE21_V4_STAGE if reference21_v4 else MIXED_STAGE if mixed else "full140-v4-source-v2" if full140_v4 else "main16-v3" if main16 else "ambiguity2-v3" if ambiguity2 else "remaining8" if remaining8 else "full140" if case_set == "full140" else
                  "P1" if case_positions is None else "diagnostic"),
        "base_url": base_url, "endpoint": endpoint, "request_model": request_model,
        **({"reasoning_effort": "max"} if official else {}),
        "deadline_utc": deadline.astimezone(timezone.utc).isoformat(),
        "source_hashes": dict(source_hashes),
        "gold_sha256": reference["gold_sha256"],
        "public_cases_sha256": canonical_sha256(
            _FULL_CASES if case_set == "full140" else _PLAN_CASES,
        ),
        **({"selected_case_positions": list(range(140)) if fixed_full140 else list(positions)}
           if case_set == "full140" or case_positions is not None or reference21_v4 else {}),
        **({"execution_plan": execution_plan, "reference_version": reference_version} if fixed_source_v2 else {}),
        "response_identity_policy": ({
            "mode": response_identity_policy, "known_labels": sorted(KNOWN_ECNU_RESPONSE_LABELS),
            "endpoint": _ENDPOINT, "request_model": "ecnu-max", "weights_identity_verified": False,
        } if response_identity_policy == KNOWN_ECNU_RESPONSE_IDENTITY_POLICY else response_identity_policy),
        "request_contract_version": 2 if extraction_selected.is_grounded else 1,
        "tool_choice": ({
            "extraction": {"mode": "omitted", "name": runtime_contracts["extraction"][1]["title"]},
            "verification": {"mode": "forced", "name": runtime_contracts["verification"][1]["title"]},
        } if mixed else {
            "extraction": {"mode": "omitted" if official else "forced", "name": runtime_contracts["extraction"][1]["title"]},
            "verification": {"mode": "omitted", "name": runtime_contracts["verification"][1]["title"]},
        } if verification_tool_choice == "omitted" else
            [schema["title"] for _, schema in runtime_contracts.values()]),
        "fallback": False,
        "versions": {name: version(name) for name in (
            "openai", "langchain-core", "langchain-deepseek", "langchain-openai",
            "httpx", "httpx2", "langsmith", "pydantic",
        )},
        **{f"{purpose}_prompt_sha256": canonical_sha256(prompt)
           for purpose, (prompt, _) in runtime_contracts.items() if purpose == "verification"},
        **{f"{purpose}_schema_sha256": canonical_sha256(schema)
           for purpose, (_, schema) in runtime_contracts.items() if purpose == "verification"},
    }
    if pro16:
        config.update(provider_profile=profile.value, request_contract_version=4, max_tokens=8192,
            thinking={"type": "disabled"}, reasoning_effort="none", tool_choice={
                "extraction": {"mode": "forced", "name": runtime_contracts["extraction"][1]["title"]},
                "verification": {"mode": "forced", "name": runtime_contracts["verification"][1]["title"]}})
        config["omitted_parameters"] = [item for item in config["omitted_parameters"] if item != "max_tokens"]
    if mixed:
        config.pop("thinking")
        config.pop("reasoning_effort")
        config.update(phase_request_version=MIXED_REQUEST_VERSION, phase_request_policy=mixed_phase_policy())
    if official:
        config["omitted_parameters"] = [
            item for item in config["omitted_parameters"] if item != "reasoning_effort"
        ]
    budget = EvaluationBudget.create(
        run_id=run_id, output_directory=output_directory,
        request_limit=2 * len(cases) if request_limit is None else request_limit,
        allowed_endpoints=(endpoint,), config_sha256=canonical_sha256(config),
    )
    try:
        store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
    except BaseException:
        try:
            budget.close()
        except EvaluationBudgetAbort:
            pass
        raise

    @contextmanager
    def invocation_scope(purpose: str, messages: list[dict], window):
        position = windows.index(window)
        frozen_contracts = {**runtime_contracts, "extraction": extraction_contracts[position]}
        live_contracts = {
            "extraction": extraction_contract(extraction_selected, window, prompt_profile=extraction_prompt_profile),
            "verification": _verification_contract(selected, prompt_profile=prompt_profile),
        }
        if any(canonical_sha256(live_contracts[stage]) != canonical_sha256(frozen)
               for stage, frozen in frozen_contracts.items()):
            raise EvaluationBudgetAbort("ecnu_runtime_contract_changed")
        prompt, schema = frozen_contracts[purpose]
        if not messages or messages[0] != {"role": "system", "content": prompt}:
            raise EvaluationBudgetAbort("ecnu_runtime_prompt_changed")
        mixed_v = mixed and purpose == "verification"
        expected = {
            "model": request_model, "temperature": 0.0, "stream": False,
            **({"max_tokens": 8192} if pro16 else {}),
            **({"reasoning_effort": "none" if mixed_v or pro16 else "max"} if official else {}),
            "thinking": {"type": "disabled" if mixed_v or pro16 else "enabled"}, "messages": messages,
            "tools": [deepcopy(convert_to_openai_tool(schema))],
            "tool_choice": {"type": "function", "function": {"name": schema["title"]}},
        }
        if official and not mixed_v and not pro16 or purpose == "verification" and verification_tool_choice == "omitted":
            del expected["tool_choice"]
        with (bounded.invocation() if bounded is not None else nullcontext()), contract.expect_request(expected):
            yield

    def bounded_loader():
        if bounded is not None:
            bounded.start(budget, synthetic=synthetic_transport is not None)
        return credential_loader()

    try:
        result = _run_evaluation_batch(
            cases=cases, windows=windows, plan=plan, budget=budget, store=store,
            base_url=base_url, request_model=request_model, api_key="",
            synthetic_transport=synthetic_transport, provider="DeepSeek" if official else "ECNU", contract=contract,
            invocation_scope=invocation_scope,
            semantic_audit=_audit_callback(audit_case, reference), gold_reference=reference,
            code_prefix="deepseek" if official else "ecnu", credential_loader=bounded_loader if bounded else credential_loader,
            request_timeout_seconds=request_timeout_seconds, max_retries=max_retries,
            verification_mode=selected,
            verification_tool_choice=verification_tool_choice,
            reasoning_effort="none" if pro16 else "max" if official else None,
            extraction_tool_choice="omitted" if official and not pro16 else "forced",
            extraction_mode=extraction_selected,
            execution_plan=execution_plan,
            extraction_prompt_profile=extraction_prompt_profile,
        )
    except BaseException as error:
        if bounded is not None:
            try:
                bounded.finish()
            except BaseException:
                error.add_note(bounded.CODE_PREFIX + "_deadline_cleanup_unknown")
        raise
    if bounded is not None:
        try:
            bounded.finish()
        except BaseException:
            result["cleanup_error_codes"] = (*result["cleanup_error_codes"], bounded.CODE_PREFIX + "_deadline_cleanup_unknown")
            result["receipt"] = None
            result["receipt_error_code"] = bounded.CODE_PREFIX + "_completion_receipt_unavailable"
    return result
