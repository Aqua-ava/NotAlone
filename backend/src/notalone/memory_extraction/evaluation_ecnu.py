"""只处理固定公开合成计划的受限 ECNU 评测入口。"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
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

from notalone.memory_extraction import adapters as extraction_adapters
from notalone.memory_extraction import verification_adapters
from notalone.memory_extraction.adapters import EXTRACTION_SCHEMA
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.evaluation_cases import CASES
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_offline import _frozen_config, _run_evaluation_batch
from notalone.memory_extraction.evaluation_records import EvaluationRecordStore, canonical_sha256
from notalone.memory_extraction.evaluation_reference import (
    FULL_ANNOTATION_PATH, FULL_REFERENCE_PATH, PUBLIC_REFERENCE_PATH,
    full_case_reference_positions, validate_full_public_reference,
)
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
from notalone.memory_extraction.verification_adapters import SOURCE_VERIFICATION_SCHEMA
from notalone.memory_trace.context import current_trace


_BASE_URL = "https://chat.ecnu.edu.cn/open/api/v1"
_ENDPOINT = f"{_BASE_URL}/chat/completions"
_CRITERIA_PATH = ".scratch/unfinished-work/memory-gold-agent-annotations-20261012.md"
_PLAN_CASES = tuple(case for case in CASES if case.dimension == "reference") + tuple(
    case for case in SEMANTIC_CASES if case.dimension == "reference"
) + tuple(case for case in SEMANTIC_CASES if case.name in {
    "严格：报价判断与条件咨询", "严格：第三人历史经历与当前未知",
})
_FULL_CASES = (*CASES, *SEMANTIC_CASES)
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
_AUDIT_REASONS = {
    "safe": {"supported"}, "general_error": {"coverage_miss", "contract_mismatch"},
    "safety_error": {"false_fact", "wrong_subject", "contract_mismatch"},
    "unknown": {"audit_unresolved"},
}


def _gold_reference(
    frozen_gold: dict, source_hashes: dict[str, str], *, case_set: str = "reference21",
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
    if (not isinstance(criterion, str) or not isinstance(digest, str)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            or not isinstance(source_hashes, dict)
            or source_hashes.get(criterion) != digest
            or not (_REQUIRED_SOURCES | {criterion}) <= set(source_hashes)):
        raise EvaluationBudgetAbort("ecnu_source_freeze_incomplete")
    if case_set == "full140" and (
        criterion != FULL_REFERENCE_PATH or not {
            FULL_REFERENCE_PATH, FULL_ANNOTATION_PATH, PUBLIC_REFERENCE_PATH, _CRITERIA_PATH,
        } <= set(source_hashes)
    ):
        raise EvaluationBudgetAbort("ecnu_full_reference_freeze_incomplete")
    return {"criteria_sha256": digest, "gold_sha256": canonical_sha256(frozen_gold)}


def _load_full_reference(repo_root: Path, source_hashes: dict[str, str]) -> dict:
    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        value: dict = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate_reference_key")
            value[key] = item
        return value

    try:
        content = (repo_root / FULL_REFERENCE_PATH).read_bytes()
        if hashlib.sha256(content).hexdigest() != source_hashes[FULL_REFERENCE_PATH]:
            raise ValueError("changed_reference_bytes")
        reference = json.loads(content, object_pairs_hook=unique_object)
        validation = validate_full_public_reference(
            reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=source_hashes[FULL_ANNOTATION_PATH],
        )
        parent = reference["provenance"]["parent21"]
        if (source_hashes[PUBLIC_REFERENCE_PATH] != parent["reference_file_sha256"]
                or source_hashes[_CRITERIA_PATH] != parent["reference"]["annotation_sha256"]):
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
) -> dict:
    """默认固定P1；显式最多四窗诊断仍须独审，不自动后继或认证质量。"""
    if (type(request_timeout_seconds) not in (int, float)
            or not 0 < request_timeout_seconds <= 300
            or not isfinite(request_timeout_seconds)
            or type(max_retries) is not int or not 0 <= max_retries <= 2):
        raise EvaluationBudgetAbort("ecnu_invalid_request_limits")
    request_timeout_seconds = float(request_timeout_seconds)
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
                or (case_positions is not None and len(positions) > 4)
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
    if synthetic_transport is None:
        from .evaluation_phased_audit import PhasedEvaluationAudit

        if type(audit_case) is not PhasedEvaluationAudit:
            raise EvaluationBudgetAbort("ecnu_phased_audit_required")
    reference = _gold_reference(frozen_gold, source_hashes, case_set=case_set)
    if synthetic_transport is None:
        if (frozen_gold.get("criteria_path") !=
                (FULL_REFERENCE_PATH if case_set == "full140" else PUBLIC_REFERENCE_PATH)
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
    )
    if case_set == "full140":
        validation = _load_full_reference(repo_root, source_hashes)
        if (synthetic_transport is None and
                cast(PhasedEvaluationAudit, audit_case).reference_sha256 !=
                validation["reference_sha256"]):
            raise EvaluationBudgetAbort("ecnu_phased_reference_mismatch")
    runtime_contracts = {
        "extraction": (
            extraction_adapters.EXTRACTION_SYSTEM_PROMPT,
            deepcopy(extraction_adapters.EXTRACTION_SCHEMA),
        ),
        "verification": (
            verification_adapters.SOURCE_VERIFICATION_SYSTEM_PROMPT,
            deepcopy(verification_adapters.SOURCE_VERIFICATION_SCHEMA),
        ),
    }
    tools = {purpose: convert_to_openai_tool(schema)
             for purpose, (_, schema) in runtime_contracts.items()}
    windows = tuple(build_window(case) for case in cases)
    plan = tuple({
        "case_position": index, "case_name": case.name,
        "input_sha256": canonical_sha256(window),
    } for index, (case, window) in enumerate(zip(cases, windows)))
    config = {
        **_frozen_config(plan, request_timeout_seconds=request_timeout_seconds,
                         max_retries=max_retries),
        "mode": ("ecnu_bounded_full140" if case_set == "full140" else
                 "ecnu_bounded_evaluation" if case_positions is None
                 else "ecnu_bounded_diagnostic"),
        "stage": ("full140" if case_set == "full140" else
                  "P1" if case_positions is None else "diagnostic"),
        "base_url": _BASE_URL, "endpoint": _ENDPOINT, "request_model": "ecnu-max",
        "deadline_utc": deadline.astimezone(timezone.utc).isoformat(),
        "source_hashes": dict(source_hashes),
        "gold_sha256": reference["gold_sha256"],
        "public_cases_sha256": canonical_sha256(
            _FULL_CASES if case_set == "full140" else _PLAN_CASES,
        ),
        **({"selected_case_positions": list(positions)}
           if case_set == "full140" or case_positions is not None else {}),
        "response_identity_policy": "first_valid_completion_observation_stop_on_change",
        "request_contract_version": 1,
        "tool_choice": [EXTRACTION_SCHEMA["title"], SOURCE_VERIFICATION_SCHEMA["title"]],
        "fallback": False,
        "versions": {name: version(name) for name in (
            "openai", "langchain-core", "langchain-deepseek", "langchain-openai",
            "httpx", "httpx2", "langsmith", "pydantic",
        )},
        **{f"{purpose}_prompt_sha256": canonical_sha256(prompt)
           for purpose, (prompt, _) in runtime_contracts.items()},
        **{f"{purpose}_schema_sha256": canonical_sha256(schema)
           for purpose, (_, schema) in runtime_contracts.items()},
    }
    budget = EvaluationBudget.create(
        run_id=run_id, output_directory=output_directory, request_limit=2 * len(cases),
        allowed_endpoints=(_ENDPOINT,), config_sha256=canonical_sha256(config),
    )
    try:
        store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
    except BaseException:
        try:
            budget.close()
        except EvaluationBudgetAbort:
            pass
        raise

    def invocation_scope(purpose: str, messages: list[dict]):
        live_contracts = {
            "extraction": (extraction_adapters.EXTRACTION_SYSTEM_PROMPT,
                           extraction_adapters.EXTRACTION_SCHEMA),
            "verification": (verification_adapters.SOURCE_VERIFICATION_SYSTEM_PROMPT,
                             verification_adapters.SOURCE_VERIFICATION_SCHEMA),
        }
        if any(canonical_sha256(live_contracts[stage]) != canonical_sha256(frozen)
               for stage, frozen in runtime_contracts.items()):
            raise EvaluationBudgetAbort("ecnu_runtime_contract_changed")
        prompt, schema = runtime_contracts[purpose]
        if not messages or messages[0] != {"role": "system", "content": prompt}:
            raise EvaluationBudgetAbort("ecnu_runtime_prompt_changed")
        expected = {
            "model": "ecnu-max", "temperature": 0.0, "stream": False,
            "thinking": {"type": "enabled"}, "messages": messages,
            "tools": [deepcopy(tools[purpose])],
            "tool_choice": {"type": "function", "function": {"name": schema["title"]}},
        }
        return contract.expect_request(expected)

    return _run_evaluation_batch(
        cases=cases, windows=windows, plan=plan, budget=budget, store=store,
        base_url=_BASE_URL, request_model="ecnu-max", api_key="",
        synthetic_transport=synthetic_transport, provider="ECNU", contract=contract,
        invocation_scope=invocation_scope,
        semantic_audit=_audit_callback(audit_case, reference), gold_reference=reference,
        code_prefix="ecnu", credential_loader=credential_loader,
        request_timeout_seconds=request_timeout_seconds, max_retries=max_retries,
    )
