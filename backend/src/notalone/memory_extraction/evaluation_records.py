"""评测专用私有记录；不连接业务追踪、数据库或供应商。"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, is_dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Iterator, NoReturn
from uuid import UUID

import httpx

from .evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort, _endpoint
from .evaluation_provider_contract import (
    FULL140_E2_PLAN, FULL140_E2_MODE, FULL140_E2_STAGE,
    CORE_PROFILE_PLAN, CORE_PROFILE_MODE, CORE_PROFILE_STAGES,
    BOUNDED_RUNTIME_PLAN, BOUNDED_RUNTIME_MODE, BOUNDED_RUNTIME_STAGE,
    MIXED_PLAN, MIXED_MODE, MIXED_STAGE, MIXED_REQUEST_VERSION, mixed_phase_policy,
    REFERENCE21_V4_PLAN, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE, PHASE_SPLIT_PLANS, REFERENCE21_PLANS,
    SEMANTIC4_PLAN, SEMANTIC4_MODE, SEMANTIC4_STAGE, SEMANTIC4_PROMPT_PROFILE,
    UNIQUENESS_PLAN, UNIQUENESS_MODE, UNIQUENESS_STAGE, PUBLIC_QUALITY_PLANS,
    validate_extraction_prompt_profile, STRICT_RESPONSE_IDENTITY_POLICY, bounded_profile_for_config, EvaluationProviderProfile,
    REFERENCE16_PRO_PLAN, REFERENCE16_PRO_MODE, REFERENCE16_PRO_STAGE, REFERENCE16_PRO_PLANS,
    REFERENCE16_PRO_TEACHING_PLAN, REFERENCE16_PRO_TEACHING_MODE, REFERENCE16_PRO_TEACHING_STAGE,
)
from .models import ExtractionWindow
from .verification_adapters import CORE_SOURCE_FIDELITY_PROFILE


_EVENT_KINDS = frozenset({
    "case_started", "adapter_output", "case_result", "case_failed",
    "provider_request", "provider_response", "provider_failure",
    "semantic_audit", "verification_program", "extraction_program",
    "formal_task_execution",
})
_PURPOSES = frozenset({"case", "extraction", "verification"})
_MAX_RECORD_BYTES = 8 * 1024 * 1024
_PRIVATE_FIELDS = frozenset({
    "reasoning_content", "reasoning_details", "chain_of_thought", "analysis",
    "thinking", "headers", "response_headers", "request_headers",
    "authorization", "api_key", "apikey", "secret", "password", "passwd",
    "token", "access_token", "refresh_token", "client_secret", "private_key",
    "credentials", "credential", "database_url", "connection_string",
    "body_base64",
})
_BOUNDED_CONFIG_FIELDS = frozenset({"formal_tasks", "bounded_inputs_sha256", "runtime_rule_set_sha256", "provider_profile", "max_tokens"})
_CONFIG_FIELDS = _BOUNDED_CONFIG_FIELDS | frozenset({
    "mode", "synthetic_only", "base_url", "endpoint", "request_model",
    "temperature", "timeout", "max_retries", "thinking", "stream", "reasoning_effort",
    "plan_sha256", "public_cases_sha256", "extraction_prompt_sha256",
    "extraction_schema_sha256", "verification_prompt_sha256",
    "verification_schema_sha256", "versions", "omitted_parameters",
    "deadline_utc", "source_hashes", "gold_sha256", "stage",
    "response_identity_policy", "request_contract_version", "tool_choice",
    "fallback", "baseline_commit", "selected_case_positions", "verification_mode", "verification_prompt_profile",
    "extraction_mode", "extraction_window_contracts", "execution_plan", "reference_version", "extraction_prompt_profile",
    "phase_request_version", "phase_request_policy",
})


def _json_value(value: Any) -> Any:
    if isinstance(value, (UUID, datetime)):
        return str(value) if isinstance(value, UUID) else value.isoformat()
    if isinstance(value, Enum):
        return _json_value(value.value)
    if is_dataclass(value) and not isinstance(value, type):
        return _json_value(asdict(value))
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    if value is None or type(value) in (str, bool, int, float):
        return value
    raise EvaluationBudgetAbort("unsupported_record_value")


def _canonical(value: Any) -> bytes:
    return json.dumps(
        _json_value(value), sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    """摘要只由规范JSON决定；不调用任意对象的repr或model_dump。"""
    return hashlib.sha256(_canonical(value)).hexdigest()


def _redact(
    value: Any, *, path: str = "$", request: bool = False,
) -> tuple[Any, list[str]]:
    removed: list[str] = []
    if isinstance(value, dict):
        result: Any = {}
        for key, item in value.items():
            location = f"{path}.{key}"
            if key.lower() in _PRIVATE_FIELDS and not (
                request and key == "thinking" and path in ("$", "$.body")
            ):
                removed.append(location)
                continue
            if key in {"arguments", "body_text"} and isinstance(item, str):
                decoded = json.loads(item)
                if not isinstance(decoded, dict):
                    raise ValueError("unstructured_tool_arguments")
                sanitized, nested = _redact(
                    decoded, path=location + "::json", request=request
                )
                result[key] = _canonical(sanitized).decode("utf-8")
            else:
                result[key], nested = _redact(item, path=location, request=request)
            removed.extend(nested)
        return result, removed
    if isinstance(value, list):
        result = []
        for index, item in enumerate(value):
            sanitized, nested = _redact(
                item, path=f"{path}[{index}]", request=request
            )
            result.append(sanitized)
            removed.extend(nested)
        return result, removed
    return value, removed


class EvaluationRecordStore:
    """预算绑定的追加记录；每次持久成功之后才向调用方交回结果。"""

    def __init__(
        self, *, budget: EvaluationBudget, frozen_config: dict,
        plan: tuple[dict, ...],
        actual_windows: tuple[ExtractionWindow, ...] | None = None,
    ):
        self._budget = budget
        self._manifest = budget.snapshot()
        bounded = frozen_config.get("execution_plan") == BOUNDED_RUNTIME_PLAN
        reference16 = type(frozen_config.get("execution_plan")) is str and frozen_config["execution_plan"] in REFERENCE16_PRO_PLANS
        for key in ("base_url", "endpoint"):
            if key in frozen_config:
                _endpoint(frozen_config[key])
        _, forbidden_config = _redact(_json_value(frozen_config), request=True)
        if (
            self._manifest["reserved_requests"] != 0
            or canonical_sha256(frozen_config) != self._manifest["config_sha256"]
            or frozen_config.get("plan_sha256") != canonical_sha256(plan)
            or not plan
            or forbidden_config
            or not set(frozen_config) <= _CONFIG_FIELDS
            or frozen_config.get("extraction_mode", "legacy-e14") not in {
                "legacy-e14", "grounded-v2", "grounded-v3", "grounded-v4",
            }
            or ("verification_mode" in frozen_config and (
                type(frozen_config["verification_mode"]) is not str
                or frozen_config["verification_mode"] not in {
                    "legacy-v4", "nullable-proof-v1", *(('nullable-proof-v3',) if bounded else ()),
                }
            ))
            or any(
                item.get("case_position") != index
                or not isinstance(item.get("case_name"), str)
                or set(item) != {"case_position", "case_name", "input_sha256"}
                for index, item in enumerate(plan)
            )
        ):
            raise EvaluationBudgetAbort("invalid_record_freeze")
        self._extraction_mode = frozen_config.get("extraction_mode", "legacy-e14")
        self._execution_plan = frozen_config.get("execution_plan", "original")
        if type(self._execution_plan) is not str:
            raise EvaluationBudgetAbort("invalid_record_execution_plan")
        if not bounded and ((_BOUNDED_CONFIG_FIELDS - ({"provider_profile", "max_tokens"} if reference16 else set())) & set(frozen_config)
                or frozen_config.get("mode") == BOUNDED_RUNTIME_MODE
                or frozen_config.get("stage") == BOUNDED_RUNTIME_STAGE
                or frozen_config.get("reference_version") == BOUNDED_RUNTIME_PLAN):
            raise EvaluationBudgetAbort("invalid_record_bounded_registration")
        core = self._execution_plan == CORE_PROFILE_PLAN
        if core:
            if frozen_config.get("verification_prompt_profile") != CORE_SOURCE_FIDELITY_PROFILE:
                raise EvaluationBudgetAbort("invalid_record_verification_prompt_profile")
        elif ((self._execution_plan in PUBLIC_QUALITY_PLANS) != (frozen_config.get("verification_prompt_profile") == SEMANTIC4_PROMPT_PROFILE)
                or self._execution_plan not in PUBLIC_QUALITY_PLANS and "verification_prompt_profile" in frozen_config):
            raise EvaluationBudgetAbort("invalid_record_verification_prompt_profile")
        self._extraction_prompt_profile = frozen_config.get("extraction_prompt_profile", "default")
        validate_extraction_prompt_profile(self._execution_plan, self._extraction_prompt_profile)
        if self._execution_plan not in {UNIQUENESS_PLAN, BOUNDED_RUNTIME_PLAN, CORE_PROFILE_PLAN, REFERENCE16_PRO_TEACHING_PLAN} and "extraction_prompt_profile" in frozen_config:
            raise EvaluationBudgetAbort("invalid_record_extraction_prompt_profile")
        self._mixed = type(self._execution_plan) is str and self._execution_plan in PHASE_SPLIT_PLANS
        self._strict_response = self._mixed or bounded or reference16 or core
        if not self._mixed and {"phase_request_version", "phase_request_policy"} & set(frozen_config):
            raise EvaluationBudgetAbort("invalid_record_mixed_registration")
        self._response_sequences: set[int] = set()
        self._reference_version = "legacy-v1"
        if core:
            self._validate_core_registration(frozen_config, plan, actual_windows)
            self._reference_version = CORE_PROFILE_PLAN
        elif bounded:
            self._validate_bounded_registration(frozen_config, plan, actual_windows)
            self._reference_version = BOUNDED_RUNTIME_PLAN
        elif (self._extraction_mode == "grounded-v4"
                or "execution_plan" in frozen_config or "reference_version" in frozen_config
                or frozen_config.get("mode") == "deepseek_bounded_full140_v4_source_v2"
                or frozen_config.get("stage") == "full140-v4-source-v2"):
            self._validate_fixed_v4_registration(frozen_config, plan)
            self._reference_version = "source-fidelity-v2"
        contracts = frozen_config.get("extraction_window_contracts")
        if self._extraction_mode in {"grounded-v2", "grounded-v3", "grounded-v4"}:
            if (not isinstance(contracts, (tuple, list)) or len(contracts) != len(plan)
                    or any(not isinstance(item, dict)
                           or set(item) != {"input_sha256", "prompt_sha256", "schema_sha256"}
                           or item["input_sha256"] != position["input_sha256"]
                           or any(not isinstance(value, str) or len(value) != 64
                                  or any(char not in "0123456789abcdef" for char in value)
                                  for value in item.values())
                           for item, position in zip(contracts, plan))):
                raise EvaluationBudgetAbort("invalid_record_extraction_freeze")
        elif contracts is not None:
            raise EvaluationBudgetAbort("invalid_record_extraction_freeze")
        self._extraction_contracts = json.loads(_canonical(contracts if contracts is not None else [{
            "prompt_sha256": frozen_config.get("extraction_prompt_sha256"),
            "schema_sha256": frozen_config.get("extraction_schema_sha256"),
        } for _ in plan]))
        self._plan = json.loads(_canonical(plan))
        self._bounded_provider_profile = bounded_profile_for_config(frozen_config) if bounded else None
        self._formal_tasks = json.loads(_canonical(frozen_config["formal_tasks"])) if bounded else []
        self._core_contract = ({
            "execution_plan": CORE_PROFILE_PLAN,
            "provider_profile": EvaluationProviderProfile.DEEPSEEK_FLASH_MAX.value,
            "extraction_mode": "grounded-v2",
            "extraction_prompt_profile": self._extraction_prompt_profile,
            "verification_tool_choice": "omitted",
            "source_hashes": json.loads(_canonical(frozen_config["source_hashes"])),
            "deadline_utc": frozen_config["deadline_utc"],
        } if core else None)
        self._gold_sha256: str | None = frozen_config["gold_sha256"] if bounded or core else None
        self._output = Path(self._manifest["output_directory"])
        self._failed = False
        self._stop_reason: str | None = None
        self._completion_digest: str | None = None
        self._files: list[tuple[str, str]] = []
        self._stage: ContextVar[tuple[int, str] | None] = ContextVar(
            "evaluation_record_stage", default=None
        )
        self._write("manifest.json", {
            "budget": self._manifest, "frozen_config": frozen_config,
            "plan": self._plan, "synthetic_quality_certified": False,
        })

    @property
    def bounded_provider_profile(self) -> EvaluationProviderProfile | None:
        return self._bounded_provider_profile

    def _validate_core_registration(
        self, config: dict, plan: tuple[dict, ...],
        actual_windows: tuple[ExtractionWindow, ...] | None,
    ) -> None:
        """核心私有入口的数量及请求合同门；来源独审和跨场门仍由入口负责。"""
        from .evaluation_extraction import extraction_contract
        from .verification_adapters import source_verification_contract

        try:
            stage = config.get("stage")
            if type(stage) is not str or stage not in CORE_PROFILE_STAGES:
                raise ValueError("core_stage_required")
            count, cap = CORE_PROFILE_STAGES[stage]
            if (type(actual_windows) is not tuple or len(actual_windows) != count
                    or len(plan) != count or any(type(window) is not ExtractionWindow for window in actual_windows)):
                raise ValueError("actual_windows_required")
            deadline = datetime.fromisoformat(config["deadline_utc"])
            if deadline.tzinfo is None or deadline.isoformat() != config["deadline_utc"]:
                raise ValueError("core_deadline_required")
            positions = config.get("selected_case_positions")
            hashes = config.get("source_hashes")
            def valid_digest(value: Any) -> bool:
                return type(value) is str and len(value) == 64 and all(char in "0123456789abcdef" for char in value)
            if (self._extraction_mode != "grounded-v2" or config.get("verification_mode") != "legacy-v4"
                    or config.get("reference_version") != CORE_PROFILE_PLAN or config.get("mode") != CORE_PROFILE_MODE
                    or config.get("base_url") != "https://api.deepseek.com"
                    or config.get("endpoint") != "https://api.deepseek.com/chat/completions"
                    or config.get("request_model") != "deepseek-flash"
                    or type(config.get("timeout")) is not float or config["timeout"] != 300.0
                    or type(config.get("max_retries")) is not int or config["max_retries"] != 0
                    or type(config.get("temperature")) not in (int, float) or config["temperature"] != 0
                    or config.get("stream") is not False or config.get("fallback") is not False
                    or config.get("thinking") != {"type": "enabled"} or config.get("reasoning_effort") != "max"
                    or type(config.get("request_contract_version")) is not int or config["request_contract_version"] != 2
                    or config.get("response_identity_policy") != STRICT_RESPONSE_IDENTITY_POLICY
                    or config.get("tool_choice") != {
                        "extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                        "verification": {"mode": "omitted", "name": "SourceVerificationOutput"}}
                    or self._manifest["request_limit"] != cap
                    or self._manifest["allowed_endpoints"] != ["https://api.deepseek.com/chat/completions"]
                    or not isinstance(positions, (list, tuple))
                    or any(type(position) is not int for position in positions) or tuple(positions) != tuple(range(count))
                    or any(type(item["case_position"]) is not int
                           or item["input_sha256"] != canonical_sha256(window)
                           for item, window in zip(plan, actual_windows, strict=True))
                    or len({item["case_name"] for item in plan}) != count
                    or not valid_digest(config.get("gold_sha256"))
                    or type(hashes) is not dict or not hashes
                    or any(type(key) is not str or not key or not valid_digest(value) for key, value in hashes.items())):
                raise ValueError("core_registration_changed")
            contracts = tuple(extraction_contract("grounded-v2", window,
                prompt_profile=self._extraction_prompt_profile) for window in actual_windows)
            prompt, schema = source_verification_contract("legacy-v4", prompt_profile=CORE_SOURCE_FIDELITY_PROFILE)
            if (config.get("extraction_window_contracts") != [{"input_sha256": item["input_sha256"],
                    "prompt_sha256": canonical_sha256(e_prompt), "schema_sha256": canonical_sha256(e_schema)}
                    for item, (e_prompt, e_schema) in zip(plan, contracts, strict=True)]
                    or config.get("extraction_prompt_sha256") != canonical_sha256(contracts[0][0])
                    or config.get("extraction_schema_sha256") != canonical_sha256(tuple(value[1] for value in contracts))
                    or config.get("verification_prompt_sha256") != canonical_sha256(prompt)
                    or config.get("verification_schema_sha256") != canonical_sha256(schema)):
                raise ValueError("core_prompt_contract_changed")
        except (ValueError, TypeError, KeyError, AttributeError):
            raise EvaluationBudgetAbort("invalid_record_core_registration") from None

    def core_contract_binding(self) -> dict:
        """不从运行参数重建本场来源及期限；返回注册时冻结的副本。"""
        if self._core_contract is None:
            raise EvaluationBudgetAbort("evaluation_core_registration_required")
        return json.loads(_canonical(self._core_contract))

    def validate_core_execution(self, windows: tuple[ExtractionWindow, ...], plan: tuple[dict, ...]) -> None:
        """执行时仍必须使用注册的同序窗口，不能仅更换运行参数。"""
        if (self._execution_plan != CORE_PROFILE_PLAN or type(windows) is not tuple
                or len(windows) != len(self._plan) or _json_value(plan) != self._plan
                or any(type(window) is not ExtractionWindow or canonical_sha256(window) != item["input_sha256"]
                       for item, window in zip(self._plan, windows, strict=True))):
            raise EvaluationBudgetAbort("evaluation_core_window_binding_changed")

    def _validate_bounded_registration(
        self, config: dict, plan: tuple[dict, ...],
        actual_windows: tuple[ExtractionWindow, ...] | None,
    ) -> None:
        """仅绑定实际15个任务窗口；来源全文与公开内容投影分别核验。"""
        from notalone.memory.bounded_evidence import rule_set_sha256
        from notalone.tasks.models import ExtractionRuntimeConfig, ExtractionRuntimeMode
        from .evaluation_bounded_cases import BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_INPUTS
        from .evaluation_extraction import extraction_contract
        from .evaluation_reference import bounded_window_projection
        from .verification_adapters import source_verification_contract

        try:
            if (type(actual_windows) is not tuple or len(actual_windows) != 15
                    or any(type(window) is not ExtractionWindow for window in actual_windows)):
                raise ValueError("actual_windows_required")
            expected = tuple({"case_position": position, "case_name": case.name,
                "input_sha256": canonical_sha256(window)} for position, (case, window) in
                enumerate(zip(BOUNDED_RUNTIME_CASES, actual_windows, strict=True)))
            content_hash = canonical_sha256(tuple({"messages": item["messages"],
                "target_indices": item["target_indices"]} for item in BOUNDED_RUNTIME_INPUTS))
            current_rules = rule_set_sha256()
            profile = bounded_profile_for_config(config)
            positions = config.get("selected_case_positions")
            if (self._extraction_mode != "grounded-v2" or config.get("verification_mode") != "nullable-proof-v3"
                    or config.get("reference_version") != BOUNDED_RUNTIME_PLAN
                    or config.get("mode") != BOUNDED_RUNTIME_MODE or config.get("stage") != BOUNDED_RUNTIME_STAGE
                    or config.get("base_url") != "https://api.deepseek.com"
                    or config.get("endpoint") != "https://api.deepseek.com/chat/completions"
                    or config.get("request_model") != profile.model
                    or type(config.get("timeout")) is not float or config["timeout"] != 300.0
                    or type(config.get("max_retries")) is not int or config["max_retries"] != 0
                    or type(config.get("temperature")) not in (int, float) or config["temperature"] != 0
                    or config.get("stream") is not False or config.get("fallback") is not False
                    or config.get("response_identity_policy") != STRICT_RESPONSE_IDENTITY_POLICY
                    or config.get("tool_choice") != {
                        "extraction": {"mode": "omitted", "name": "GroundedMemoryLabels"},
                        "verification": {"mode": "forced", "name": "SourceVerificationOutput"},
                    }
                    or {"thinking", "reasoning_effort", "phase_request_version", "phase_request_policy"} & set(config)
                    or self._manifest["request_limit"] != 30
                    or self._manifest["allowed_endpoints"] != ["https://api.deepseek.com/chat/completions"]
                    or not isinstance(positions, (list, tuple))
                    or any(type(position) is not int for position in positions) or tuple(positions) != tuple(range(15))
                    or any(type(item["case_position"]) is not int for item in plan) or plan != expected
                    or config.get("bounded_inputs_sha256") != content_hash
                    or canonical_sha256(tuple(bounded_window_projection(window) for window in actual_windows)) != content_hash
                    or config.get("runtime_rule_set_sha256") != current_rules
                    or type(config.get("gold_sha256")) is not str or len(config["gold_sha256"]) != 64
                    or any(char not in "0123456789abcdef" for char in config["gold_sha256"])):
                raise ValueError("fixed_registration_changed")
            tasks = config.get("formal_tasks")
            if type(tasks) is not list or len(tasks) != 15:
                raise ValueError("formal_tasks_required")
            task_ids: set[UUID] = set()
            contacts: set[UUID] = set()
            for task, window, item in zip(tasks, actual_windows, expected, strict=True):
                if type(task) is not dict or set(task) != {
                        "owner_id", "contact_id", "task_id", "extraction_runtime_config", "input_sha256"}:
                    raise ValueError("formal_task_fields_changed")
                identifiers = {}
                for key in ("owner_id", "contact_id", "task_id"):
                    value = task[key]
                    if type(value) is not str or str(UUID(value)) != value:
                        raise ValueError("formal_task_identity_invalid")
                    identifiers[key] = UUID(value)
                runtime = ExtractionRuntimeConfig.from_payload(task["extraction_runtime_config"])
                if (identifiers["owner_id"] != window.owner_id or identifiers["contact_id"] != window.contact_id
                        or identifiers["task_id"] in task_ids or identifiers["contact_id"] in contacts
                        or task["input_sha256"] != item["input_sha256"]
                        or runtime.mode is not ExtractionRuntimeMode.BOUNDED_RUNTIME_V1
                        or runtime.rule_set_sha256 != current_rules):
                    raise ValueError("formal_task_binding_changed")
                task_ids.add(identifiers["task_id"])
                contacts.add(identifiers["contact_id"])
            contracts = tuple(extraction_contract("grounded-v2", window,
                prompt_profile=self._extraction_prompt_profile) for window in actual_windows)
            prompt, schema = source_verification_contract("nullable-proof-v3")
            if (config.get("extraction_window_contracts") != [{"input_sha256": item["input_sha256"],
                    "prompt_sha256": canonical_sha256(e_prompt), "schema_sha256": canonical_sha256(e_schema)}
                    for item, (e_prompt, e_schema) in zip(expected, contracts, strict=True)]
                    or config.get("extraction_prompt_sha256") != canonical_sha256(contracts[0][0])
                    or config.get("extraction_schema_sha256") != canonical_sha256(tuple(value[1] for value in contracts))
                    or config.get("verification_prompt_sha256") != canonical_sha256(prompt)
                    or config.get("verification_schema_sha256") != canonical_sha256(schema)):
                raise ValueError("prompt_contract_changed")
        except (ValueError, TypeError, KeyError, AttributeError):
            raise EvaluationBudgetAbort("invalid_record_bounded_registration") from None

    def _validate_fixed_v4_registration(self, config: dict, plan: tuple[dict, ...]) -> None:
        """只注册既有v4与独立E2完整身份；不开放任意来源v2运行。"""
        from .evaluation import build_window
        from .evaluation_cases import CASES
        from .evaluation_reference import public_window_projection, _fixed_case_sets
        from .semantic_evaluation_cases import SEMANTIC_CASES

        reference16 = self._execution_plan in REFERENCE16_PRO_PLANS
        teaching = self._execution_plan == REFERENCE16_PRO_TEACHING_PLAN
        e2 = self._execution_plan == FULL140_E2_PLAN or reference16
        reference21 = self._execution_plan in REFERENCE21_PLANS
        public_quality = self._execution_plan in PUBLIC_QUALITY_PLANS
        uniqueness = self._execution_plan == UNIQUENESS_PLAN
        cases = _fixed_case_sets()[0][:16] if reference16 else _fixed_case_sets()[0] if reference21 else (*CASES, *SEMANTIC_CASES)
        count, cap = (16, 32) if reference16 else (21, 42) if reference21 else (140, 280)
        expected = tuple({
            "case_position": position, "case_name": case.name,
            "input_sha256": canonical_sha256(public_window_projection(build_window(case))),
        } for position, case in enumerate(cases))
        positions = config.get("selected_case_positions")
        if reference16:
            from .evaluation_reference import _PUBLIC_V2
            if (config.get("provider_profile") != EvaluationProviderProfile.DEEPSEEK_PRO_REFERENCE16.value
                    or type(config.get("request_contract_version")) is not int or config["request_contract_version"] != 4
                    or config.get("base_url") != "https://api.deepseek.com"
                    or config.get("endpoint") != "https://api.deepseek.com/chat/completions"
                    or config.get("request_model") != "deepseek-v4-pro"
                    or type(config.get("max_tokens")) is not int or config["max_tokens"] != 8192
                    or config.get("thinking") != {"type": "disabled"} or config.get("reasoning_effort") != "none"
                    or config.get("gold_sha256") != _PUBLIC_V2.reference_sha256
                    or self._manifest["allowed_endpoints"] != ["https://api.deepseek.com/chat/completions"]):
                raise EvaluationBudgetAbort("invalid_record_reference16_pro_registration")
        if self._mixed and (config.get("phase_request_version") != MIXED_REQUEST_VERSION
                or config.get("phase_request_policy") != mixed_phase_policy()
                or "thinking" in config or "reasoning_effort" in config
                or config.get("base_url") != "https://api.deepseek.com"
                or config.get("endpoint") != "https://api.deepseek.com/chat/completions"
                or config.get("request_model") != "deepseek-flash"
                or config.get("timeout") != 300.0
                or type(config.get("request_contract_version")) is not int or config["request_contract_version"] != 2
                or self._manifest["allowed_endpoints"] != ["https://api.deepseek.com/chat/completions"]):
            raise EvaluationBudgetAbort("invalid_record_mixed_registration")
        if (config.get("execution_plan") != (REFERENCE16_PRO_TEACHING_PLAN if teaching else REFERENCE16_PRO_PLAN if reference16 else FULL140_E2_PLAN if e2 else UNIQUENESS_PLAN if uniqueness else SEMANTIC4_PLAN if public_quality else REFERENCE21_V4_PLAN if reference21 else MIXED_PLAN if self._mixed else "full140-grounded-v4-source-v2")
                or config.get("reference_version") != "source-fidelity-v2"
                or config.get("mode") != (REFERENCE16_PRO_TEACHING_MODE if teaching else REFERENCE16_PRO_MODE if reference16 else FULL140_E2_MODE if e2 else UNIQUENESS_MODE if uniqueness else SEMANTIC4_MODE if public_quality else REFERENCE21_V4_MODE if reference21 else MIXED_MODE if self._mixed else "deepseek_bounded_full140_v4_source_v2")
                or config.get("stage") != (REFERENCE16_PRO_TEACHING_STAGE if teaching else REFERENCE16_PRO_STAGE if reference16 else FULL140_E2_STAGE if e2 else UNIQUENESS_STAGE if uniqueness else SEMANTIC4_STAGE if public_quality else REFERENCE21_V4_STAGE if reference21 else MIXED_STAGE if self._mixed else "full140-v4-source-v2")
                or self._extraction_mode != ("grounded-v2" if e2 else "grounded-v4")
                or config.get("verification_mode") != ("legacy-v4" if public_quality or e2 else "nullable-proof-v1")
                or config.get("tool_choice") != {
                    "extraction": {"mode": "forced" if reference16 else "omitted", "name": "GroundedMemoryLabels" if e2 else "GroundedMemoryLabelsV4"},
                    "verification": {"mode": "forced" if self._mixed or reference16 else "omitted", "name": "SourceVerificationOutput"},
                }
                or type(config.get("max_retries")) is not int or config["max_retries"] != 0
                or self._manifest["request_limit"] != cap
                or not isinstance(positions, (list, tuple))
                or any(type(position) is not int for position in positions)
                or tuple(positions) != tuple(range(count))
                or any(type(item["case_position"]) is not int for item in plan)
                or len(cases) != count or plan != expected):
            raise EvaluationBudgetAbort("invalid_record_full140_v4_registration")
        if e2:
            from .evaluation_offline import _verification_contract
            prompt, schema = _verification_contract("legacy-v4")
            if (type(config.get("temperature")) not in (int, float) or config["temperature"] != 0
                    or config.get("stream") is not False or config.get("fallback") is not False
                    or type(config.get("timeout")) is not float or config["timeout"] != 300.0
                    or config.get("response_identity_policy") != STRICT_RESPONSE_IDENTITY_POLICY
                    or config.get("verification_prompt_sha256") != canonical_sha256(prompt)
                    or config.get("verification_schema_sha256") != canonical_sha256(schema)):
                raise EvaluationBudgetAbort("invalid_record_verification_prompt_contract")
        if uniqueness or e2:
            from .evaluation_extraction import extraction_contract
            contracts = [extraction_contract("grounded-v2" if e2 else "grounded-v4", build_window(case), prompt_profile=self._extraction_prompt_profile)
                         for case in cases]
            if config.get("extraction_window_contracts") != [
                {"input_sha256": item["input_sha256"], "prompt_sha256": canonical_sha256(prompt),
                 "schema_sha256": canonical_sha256(schema)} for item, (prompt, schema) in zip(expected, contracts)
            ]:
                raise EvaluationBudgetAbort("invalid_record_extraction_prompt_contract")
            if e2 and (config.get("extraction_prompt_sha256") != canonical_sha256(contracts[0][0])
                    or config.get("extraction_schema_sha256") != canonical_sha256(tuple(schema for _, schema in contracts))):
                raise EvaluationBudgetAbort("invalid_record_extraction_prompt_contract")

    @property
    def execution_plan(self) -> str:
        return self._execution_plan

    def formal_task_binding(self, case_position: int) -> dict:
        """调用者取得冻结行的副本，不能经返回对象改写本场任务配置。"""
        if (self._execution_plan != BOUNDED_RUNTIME_PLAN or type(case_position) is not int
                or not 0 <= case_position < len(self._formal_tasks)):
            raise EvaluationBudgetAbort("invalid_formal_task_position")
        return json.loads(_canonical(self._formal_tasks[case_position]))

    @property
    def gold_sha256(self) -> str | None:
        """仅返回新固定15场注册时复制的摘要，不替调用者认证Gold质量。"""
        return self._gold_sha256

    @property
    def reference_version(self) -> str:
        """省略新计划／版本字段的旧记录仍按legacy解释。"""
        return self._reference_version

    def belongs_to(self, budget: EvaluationBudget) -> bool:
        return self._budget is budget

    @property
    def extraction_mode(self) -> str:
        """无版本字段的旧冻结文件只表示旧十四槽。"""
        return self._extraction_mode

    @property
    def extraction_prompt_profile(self) -> str:
        return self._extraction_prompt_profile

    def extraction_contract_hashes(self, case_position: int) -> dict[str, str]:
        """返回注册时复制的逐窗合同；不得由当前运行时重新定义冻结值。"""
        if type(case_position) is not int or not 0 <= case_position < len(self._extraction_contracts):
            raise EvaluationBudgetAbort("invalid_record_extraction_position")
        frozen = {key: self._extraction_contracts[case_position][key]
                  for key in ("prompt_sha256", "schema_sha256")}
        if any(not isinstance(value, str) or len(value) != 64
               or any(char not in "0123456789abcdef" for char in value)
               for value in frozen.values()):
            raise EvaluationBudgetAbort("invalid_record_extraction_freeze")
        return frozen

    @contextmanager
    def _directory(self) -> Iterator[int]:
        descriptor = os.open(
            self._output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        try:
            value = os.fstat(descriptor)
            current = self._output.lstat()
            if (
                not stat.S_ISDIR(value.st_mode)
                or value.st_uid != os.getuid()
                or stat.S_IMODE(value.st_mode) != 0o700
                or [value.st_dev, value.st_ino] != self._manifest["output_identity"]
                or (current.st_dev, current.st_ino) != (value.st_dev, value.st_ino)
            ):
                raise EvaluationBudgetAbort("record_directory_changed")
            yield descriptor
        finally:
            os.close(descriptor)

    def _stop(self, reason: str) -> NoReturn:
        self._failed = True
        self._stop_reason = reason
        try:
            self._budget.close()
        except EvaluationBudgetAbort:
            pass
        raise EvaluationBudgetAbort(reason) from None

    def _write(self, filename: str, value: dict, *, terminal: bool = False) -> dict:
        if self._completion_digest is not None:
            raise EvaluationBudgetAbort("record_store_finalized")
        if self._failed and not (
            terminal and self._stop_reason in {
                "request_redaction_unavailable", "response_redaction_unavailable",
            }
        ):
            raise EvaluationBudgetAbort("record_store_stopped")
        try:
            content = _canonical(value)
            if len(content) > _MAX_RECORD_BYTES:
                raise EvaluationBudgetAbort("record_payload_too_large")
            with self._directory() as directory:
                descriptor = os.open(
                    filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600, dir_fd=directory,
                )
                with os.fdopen(descriptor, "wb") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                os.fsync(directory)
            return json.loads(content)
        except BaseException:
            self._stop("evaluation_record_write_failed")

    @contextmanager
    def stage(self, case_position: int, purpose: str) -> Iterator[None]:
        if (
            type(case_position) is not int
            or not 0 <= case_position < len(self._plan)
            or purpose not in _PURPOSES
        ):
            self._stop("invalid_record_stage")
        token = self._stage.set((case_position, purpose))
        try:
            yield
        finally:
            self._stage.reset(token)

    def _event(
        self, *, kind: str, payload: Any, request_sequence: int | None = None,
    ) -> dict:
        stage = self._stage.get()
        if kind not in _EVENT_KINDS or stage is None:
            self._stop("unattributed_record_forbidden")
        position, purpose = stage
        if kind == "formal_task_execution":
            value = _json_value(payload)
            if (self._execution_plan != BOUNDED_RUNTIME_PLAN or purpose != "case"
                    or type(value) is not dict or set(value) != {"task", "worker_results", "trace", "memory_api"}
                    or type(value["task"]) is not dict or type(value["worker_results"]) is not list
                    or type(value["trace"]) is not dict or type(value["memory_api"]) is not dict
                    or set(value["memory_api"]) != {"path", "status_code", "body"}):
                self._stop("invalid_formal_task_execution")
            binding = self.formal_task_binding(position)
            if any(canonical_sha256(value["task"].get(key)) != canonical_sha256(binding[key]) for key in (
                    "owner_id", "contact_id", "task_id", "extraction_runtime_config")):
                self._stop("formal_task_execution_binding_changed")
            api = value["memory_api"]
            if (api["path"] != f"/api/contacts/{binding['contact_id']}/memory-candidates"
                    or type(api["status_code"]) is not int or not 100 <= api["status_code"] <= 599
                    or type(api["body"]) not in (dict, list)):
                self._stop("formal_task_memory_api_binding_changed")
        sanitized, removed = _redact(
            _json_value(payload), request=kind == "provider_request"
        )
        event = {
            "run_id": self._manifest["run_id"],
            "config_sha256": self._manifest["config_sha256"],
            "event_sequence": len(self._files) + 1,
            "request_sequence": request_sequence,
            "case_position": position,
            "case_name": self._plan[position]["case_name"],
            "purpose": purpose, "kind": kind,
            "payload": sanitized, "removed_paths": removed,
        }
        event["payload_sha256"] = canonical_sha256(event["payload"])
        return event

    def record(
        self, *, kind: str, payload: Any, request_sequence: int | None = None,
    ) -> dict:
        event = self._event(kind=kind, payload=payload, request_sequence=request_sequence)
        return self._persist(event)

    def _persist(self, event: dict) -> dict:
        filename = f"event-{event['event_sequence']:06d}.json"
        receipt = self._write(filename, event)
        self._files.append((filename, canonical_sha256(receipt)))
        return receipt

    def _check_response_sequence(self, sequence: int) -> None:
        if self._strict_response and (type(sequence) is not int or not 1 <= sequence <= self._manifest["request_limit"]):
            self._stop("invalid_mixed_request_sequence")

    def _capture(self, body: bytes) -> dict:
        metadata = {
            "capture_layer": "sdk_http_body", "capture_form": "redacted_json",
            "redaction_version": 1,
            "original_bytes_sha256": hashlib.sha256(body).hexdigest(),
            "original_bytes_length": len(body),
        }
        try:
            parsed = json.loads(body)
            _redact(parsed)
            if len(body) > _MAX_RECORD_BYTES:
                raise ValueError("too_large")
            return {**metadata, "body": parsed}
        except (ValueError, UnicodeError, RecursionError):
            return {
                **metadata, "capture_form": "digest_only",
                "body_not_saved": "redaction_unavailable",
            }

    def capture_request(self, sequence: int, request: httpx.Request) -> dict:
        self._check_response_sequence(sequence)
        captured = self._capture(request.content)
        receipt = self.record(
            kind="provider_request", request_sequence=sequence,
            payload={
                **captured, "method": request.method,
                "endpoint": str(request.url),
            },
        )
        if "body_not_saved" in captured:
            self._stop("request_redaction_unavailable")
        return receipt

    def capture_response(self, sequence: int, response: httpx.Response) -> dict:
        self._check_response_sequence(sequence)
        if self._strict_response:
            self._response_sequences.add(sequence)
            metadata = {
                "capture_layer": "sdk_http_body", "capture_form": "digest_only", "redaction_version": 1,
                "original_bytes_sha256": hashlib.sha256(response.content).hexdigest(),
                "original_bytes_length": len(response.content), "status_code": response.status_code,
                "response_obtained": True,
            }
            try:
                captured = self._capture(response.content)
                payload = {**captured, "status_code": response.status_code, "response_obtained": True}
                event = self._event(kind="provider_response", request_sequence=sequence, payload=payload)
                _canonical(event)
            except Exception:
                payload = {**metadata, "body_not_saved": "redaction_unavailable"}
                event = self._event(kind="provider_response", request_sequence=sequence, payload=payload)
            # I/O发布在保护之外；落盘失败不得补写同一终态。
            receipt = self._persist(event)
            if "body_not_saved" in payload:
                self._stop("response_redaction_unavailable")
            return receipt
        captured = self._capture(response.content)
        receipt = self.record(
            kind="provider_response", request_sequence=sequence,
            payload={**captured, "status_code": response.status_code},
        )
        if "body_not_saved" in captured:
            self._stop("response_redaction_unavailable")
        return receipt

    def capture_failure(self, sequence: int, kind: str) -> dict:
        self._check_response_sequence(sequence)
        return self.record(
            kind="provider_failure", request_sequence=sequence,
            payload={"failure_kind": kind, "response_obtained": self._strict_response and sequence in self._response_sequences},
        )

    def events(self) -> tuple[dict, ...]:
        """只读已持久成功的记录；失败的半文件不冒充成功事件。"""
        result = []
        try:
            with self._directory() as directory:
                for filename, expected_digest in self._files:
                    event = self._read_saved(directory, filename, expected_digest)
                    if canonical_sha256(event["payload"]) != event["payload_sha256"]:
                        raise EvaluationBudgetAbort("record_payload_changed")
                    result.append(event)
            return tuple(result)
        except BaseException:
            self._stop("evaluation_record_read_failed")

    def _read_saved(self, directory: int, filename: str, expected_digest: str) -> dict:
        descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as source:
            identity = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(identity.st_mode)
                or identity.st_uid != os.getuid()
                or stat.S_IMODE(identity.st_mode) != 0o600
                or identity.st_nlink != 1
            ):
                raise EvaluationBudgetAbort("unsafe_record_file")
            content = source.read(_MAX_RECORD_BYTES + 1)
            if len(content) > _MAX_RECORD_BYTES:
                raise EvaluationBudgetAbort("record_payload_too_large")
            value = json.loads(content)
            if canonical_sha256(value) != expected_digest:
                raise EvaluationBudgetAbort("record_payload_changed")
            return value

    def finalize(self, *, outcomes: tuple[dict, ...], budget_closed: bool) -> dict:
        """先核对真正持久关闭和完整分母，再写收据；不由调用方代签关闭。"""
        try:
            if budget_closed is not True:
                raise EvaluationBudgetAbort("budget_close_unconfirmed")
            closed = self._budget.closed_receipt()
            sanitized_outcomes, removed = _redact(_json_value(outcomes))
            outcomes = tuple(sanitized_outcomes)
            if len(outcomes) != len(self._plan) or any(
                outcome.get("case_position") != index
                or outcome.get("case_name") != self._plan[index]["case_name"]
                or outcome.get("input_sha256") != self._plan[index]["input_sha256"]
                or not set(outcome) <= {
                    "case_position", "case_name", "input_sha256", "status", "result",
                }
                or outcome.get("status") not in {
                    "completed", "empty", "failed", "unknown", "unrun",
                }
                for index, outcome in enumerate(outcomes)
            ):
                raise EvaluationBudgetAbort("outcomes_do_not_match_frozen_plan")
            events = self.events()
            started = {
                event["case_position"] for event in events
                if event["kind"] == "case_started"
            }
            results = {
                event["case_position"] for event in events
                if event["kind"] == "case_result"
            }
            result_payloads: dict[int, list[dict]] = {}
            for event in events:
                if event["kind"] == "case_result":
                    result_payloads.setdefault(event["case_position"], []).append(event["payload"])
            for index, outcome in enumerate(outcomes):
                recorded = result_payloads.get(index, [])
                result = outcome.get("result")
                if (
                    len(recorded) > 1
                    or (bool(recorded) != (result is not None))
                    or (recorded and canonical_sha256(recorded[0]) != canonical_sha256(result))
                    or (
                        outcome["status"] in {"completed", "empty"}
                        and (not isinstance(result, dict) or result.get("failure_reason") is not None)
                    )
                    or (outcome["status"] == "unrun" and result is not None)
                ):
                    raise EvaluationBudgetAbort("outcome_result_changed")
            if any(
                (outcome["status"] in {"completed", "empty"} and index not in results)
                or (outcome["status"] != "unrun" and index not in started)
                or (outcome["status"] == "unrun" and index in started)
                for index, outcome in enumerate(outcomes)
            ):
                raise EvaluationBudgetAbort("outcome_evidence_incomplete")
            requests = [
                event["request_sequence"] for event in events
                if event["kind"] == "provider_request"
            ]
            terminal = [
                event["request_sequence"] for event in events
                if event["kind"] in {"provider_response", "provider_failure"}
            ]
            if (
                requests != list(range(1, closed["reserved_requests"] + 1))
                or sorted(terminal) != requests
            ):
                raise EvaluationBudgetAbort("request_records_incomplete")
            completed = sum(
                outcome["status"] in {"completed", "empty"} for outcome in outcomes
            )
            receipt = {
                "budget": closed, "plan_sha256": canonical_sha256(self._plan),
                "outcomes": outcomes, "event_count": len(events),
                "plan_complete": completed == len(self._plan),
                "quality_certified": False,
                "capture_form": "redacted_json",
                "removed_paths": removed,
                "capture_gaps": tuple({
                    "event_sequence": event["event_sequence"],
                    "case_position": event["case_position"],
                    "request_sequence": event["request_sequence"],
                    "kind": event["kind"],
                    **{key: event["payload"][key] for key in (
                        "capture_form", "body_not_saved", "original_bytes_sha256",
                        "original_bytes_length", "status_code", "response_obtained",
                    ) if key in event["payload"]},
                } for event in events
                    if event["kind"] in {"provider_request", "provider_response"}
                    and isinstance(event["payload"], dict)
                    and "body_not_saved" in event["payload"]),
            }
            if self._completion_digest is not None:
                if canonical_sha256(receipt) != self._completion_digest:
                    raise EvaluationBudgetAbort("completion_outcomes_changed")
                with self._directory() as directory:
                    return self._read_saved(
                        directory, "completion.json", self._completion_digest,
                    )
            saved = self._write("completion.json", receipt, terminal=True)
            self._completion_digest = canonical_sha256(saved)
            return saved
        except BaseException:
            self._stop("evaluation_completion_unavailable")
