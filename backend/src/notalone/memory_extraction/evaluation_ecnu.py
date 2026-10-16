"""只处理固定公开合成计划的受限 ECNU 评测入口。"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
from math import isfinite
from pathlib import Path
import re
from typing import cast
from uuid import UUID

import httpx

from notalone.memory_extraction.evaluation import build_window
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
    validate_full_public_reference,
)
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
from notalone.memory_extraction.verification import SourceVerificationMode
from notalone.memory_trace.context import current_trace
from .evaluation_provider_contract import (
    MIXED_PLAN, MIXED_REQUEST_VERSION, MIXED_MODE, MIXED_STAGE, mixed_phase_policy,
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
    "desktop/artifacts/grounded-public21-prepare-20261015/grounded_public21.py",
    "desktop/artifacts/grounded-public21-prepare-20261015/explicit_review_bridge.py",
})
_FULL140_MIXED_REQUIRED_SOURCES = _FULL140_V4_REQUIRED_SOURCES | frozenset({
    "desktop/tests/fixtures/full140-mixed-v-off-public.py",
    ".scratch/grounded-evaluation/full140-mixed-v-off-plan-20261016.md",
    ".scratch/grounded-evaluation/full140-mixed-v-off-implementation-20261016.md",
    "architecture/adr/059-closed-unknown-kinds-and-calendar-month.md",
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
    required_sources = (_FULL140_MIXED_REQUIRED_SOURCES if execution_plan == MIXED_PLAN else
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


def _load_full_reference(repo_root: Path, source_hashes: dict[str, str], *, reference_version: str = "legacy-v1") -> dict:
    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        value: dict = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate_reference_key")
            value[key] = item
        return value

    try:
        full_path, annotation_path, parent_path, parent_annotation = _reference_paths(reference_version)
        content = (repo_root / full_path).read_bytes()
        if hashlib.sha256(content).hexdigest() != source_hashes[full_path]:
            raise ValueError("changed_reference_bytes")
        reference = json.loads(content, object_pairs_hook=unique_object)
        validation = validate_full_public_reference(
            reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=source_hashes[annotation_path], reference_version=reference_version,
        )
        parent = reference["provenance"]["parent21"]
        if (source_hashes[parent_path] != parent["reference_file_sha256"]
                or source_hashes[parent_annotation] != parent["reference"]["annotation_sha256"]
                or reference_version == "source-fidelity-v2" and validation.get("execution_ready") is not True):
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
) -> dict:
    """保留原固定计划；剩余8窗须显式选择独立版本，不提供任意子集。"""
    from .evaluation_provider_contract import EvaluationProviderProfile

    mixed = execution_plan == MIXED_PLAN
    full140_v4 = execution_plan in ("full140-grounded-v4-source-v2", MIXED_PLAN)
    if (type(reference_version) is not str or reference_version not in {"legacy-v1", "source-fidelity-v2"}
            or not full140_v4 and (reference_version != "legacy-v1" or extraction_mode == "grounded-v4")):
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
    if (type(execution_plan) is not str or execution_plan not in {"original", "reference21-remaining8-v1", "reference21-ambiguity2-v3", "reference21-main16-v3", "full140-grounded-v4-source-v2", MIXED_PLAN}
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
    from .evaluation_ambiguity2_deadline import Ambiguity2Deadline
    from .evaluation_main16_deadline import Main16Deadline
    from .evaluation_remaining8_deadline import Remaining8Deadline
    from .evaluation_full140_v4_deadline import Full140V4Deadline

    if ((remaining8_deadline is not None and (not remaining8 or type(remaining8_deadline) is not Remaining8Deadline))
            or remaining8 and synthetic_transport is None and (
                type(remaining8_deadline) is not Remaining8Deadline or not remaining8_deadline.live_worker)):
        raise EvaluationBudgetAbort("remaining8_owned_deadline_required")
    if ((ambiguity2_deadline is not None and (not ambiguity2 or type(ambiguity2_deadline) is not Ambiguity2Deadline))
            or ambiguity2 and synthetic_transport is None and (
                type(ambiguity2_deadline) is not Ambiguity2Deadline or not ambiguity2_deadline.live_worker)):
        raise EvaluationBudgetAbort("ambiguity2_owned_deadline_required")
    if ((main16_deadline is not None and (not main16 or type(main16_deadline) is not Main16Deadline))
            or main16 and synthetic_transport is None and (
                type(main16_deadline) is not Main16Deadline or not main16_deadline.live_worker)):
        raise EvaluationBudgetAbort("main16_owned_deadline_required")
    if ((full140_v4_deadline is not None and (not full140_v4 or type(full140_v4_deadline) is not Full140V4Deadline))
            or full140_v4 and (type(full140_v4_deadline) is not Full140V4Deadline
                or synthetic_transport is None and not full140_v4_deadline.live_worker)):
        raise EvaluationBudgetAbort("full140_v4_owned_deadline_required")
    bounded = cast(Remaining8Deadline | Ambiguity2Deadline | Main16Deadline | Full140V4Deadline | None,
                   remaining8_deadline or ambiguity2_deadline or main16_deadline or full140_v4_deadline)
    if official and case_set == "reference21" and not remaining8 and not ambiguity2 and not main16 and (
        case_positions is not None or request_limit not in (None, 42)
    ):
        raise EvaluationBudgetAbort("evaluation_official_fixed_reference21_required")
    if official and not mixed and verification_tool_choice != "omitted":
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
                or (case_positions is not None and len(positions) > 4 and not remaining8 and not main16)
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

    if full140_v4 and type(audit_case) is not PhasedEvaluationAudit:
        raise EvaluationBudgetAbort("ecnu_phased_audit_required")
    if type(audit_case) is PhasedEvaluationAudit and audit_case.reference_version != reference_version:
        raise EvaluationBudgetAbort("evaluation_phased_reference_version_mismatch")
    if type(audit_case) is PhasedEvaluationAudit and mixed != (audit_case.execution_plan == MIXED_PLAN):
        raise EvaluationBudgetAbort("evaluation_phased_execution_plan_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.extraction_mode != extraction_selected.value):
        raise EvaluationBudgetAbort("evaluation_phased_extraction_mode_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.verification_mode != selected.value):
        raise EvaluationBudgetAbort("ecnu_phased_verification_mode_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.verification_tool_choice != verification_tool_choice):
        raise EvaluationBudgetAbort("ecnu_phased_tool_choice_mismatch")
    if (type(audit_case) is PhasedEvaluationAudit
            and audit_case.extraction_tool_choice != ("omitted" if official else "forced")):
        raise EvaluationBudgetAbort("evaluation_phased_extraction_tool_choice_mismatch")
    if synthetic_transport is None:
        if type(audit_case) is not PhasedEvaluationAudit:
            raise EvaluationBudgetAbort("ecnu_phased_audit_required")
    reference = _gold_reference(
        frozen_gold, source_hashes, case_set=case_set, verification_mode=selected,
        reference_version=reference_version, execution_plan=execution_plan,
    )
    if synthetic_transport is None or full140_v4:
        if (frozen_gold.get("criteria_path") !=
                (FULL_REFERENCE_V2_PATH if full140_v4 else
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
    )
    if case_set == "full140":
        validation = _load_full_reference(repo_root, source_hashes, reference_version=reference_version)
        if ((synthetic_transport is None or full140_v4) and
                cast(PhasedEvaluationAudit, audit_case).reference_sha256 !=
                validation["reference_sha256"]):
            raise EvaluationBudgetAbort("ecnu_phased_reference_mismatch")
    windows = tuple(build_window(case) for case in cases)
    extraction_contracts = tuple(deepcopy(extraction_contract(extraction_selected, window))
                                 for window in windows)
    runtime_contracts = {
        "extraction": extraction_contracts[0],
        "verification": deepcopy(_verification_contract(selected)),
    }
    plan = tuple({
        "case_position": index, "case_name": case.name,
        "input_sha256": canonical_sha256(public_window_projection(window)),
    } for index, (case, window) in enumerate(zip(cases, windows)))
    config = {
        **_frozen_config(plan, request_timeout_seconds=request_timeout_seconds,
                         max_retries=max_retries, verification_mode=selected,
                         extraction_mode=extraction_selected, windows=windows),
        "mode": (MIXED_MODE if mixed else "deepseek_bounded_full140_v4_source_v2" if full140_v4 else
                 "deepseek_bounded_main16_v3" if main16 else
                 "deepseek_bounded_ambiguity2_v3" if ambiguity2 else
                 "deepseek_bounded_remaining8" if remaining8 else
                 "deepseek_bounded_full140" if official and case_set == "full140" else
                 "deepseek_bounded_evaluation" if official else
                 "ecnu_bounded_full140" if case_set == "full140" else
                 "ecnu_bounded_evaluation" if case_positions is None
                 else "ecnu_bounded_diagnostic"),
        "stage": (MIXED_STAGE if mixed else "full140-v4-source-v2" if full140_v4 else "main16-v3" if main16 else "ambiguity2-v3" if ambiguity2 else "remaining8" if remaining8 else "full140" if case_set == "full140" else
                  "P1" if case_positions is None else "diagnostic"),
        "base_url": base_url, "endpoint": endpoint, "request_model": request_model,
        **({"reasoning_effort": "max"} if official else {}),
        "deadline_utc": deadline.astimezone(timezone.utc).isoformat(),
        "source_hashes": dict(source_hashes),
        "gold_sha256": reference["gold_sha256"],
        "public_cases_sha256": canonical_sha256(
            _FULL_CASES if case_set == "full140" else _PLAN_CASES,
        ),
        **({"selected_case_positions": list(range(140)) if full140_v4 else list(positions)}
           if case_set == "full140" or case_positions is not None else {}),
        **({"execution_plan": execution_plan, "reference_version": reference_version} if full140_v4 else {}),
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
            "extraction": extraction_contract(extraction_selected, window),
            "verification": _verification_contract(selected),
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
            **({"reasoning_effort": "none" if mixed_v else "max"} if official else {}),
            "thinking": {"type": "disabled" if mixed_v else "enabled"}, "messages": messages,
            "tools": [deepcopy(convert_to_openai_tool(schema))],
            "tool_choice": {"type": "function", "function": {"name": schema["title"]}},
        }
        if official and not mixed_v or purpose == "verification" and verification_tool_choice == "omitted":
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
            reasoning_effort="max" if official else None,
            extraction_tool_choice="omitted" if official else "forced",
            extraction_mode=extraction_selected,
            execution_plan=execution_plan,
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
