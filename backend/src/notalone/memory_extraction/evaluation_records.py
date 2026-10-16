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
    MIXED_PLAN, MIXED_MODE, MIXED_STAGE, MIXED_REQUEST_VERSION, mixed_phase_policy,
    REFERENCE21_V4_PLAN, REFERENCE21_V4_MODE, REFERENCE21_V4_STAGE, PHASE_SPLIT_PLANS,
)


_EVENT_KINDS = frozenset({
    "case_started", "adapter_output", "case_result", "case_failed",
    "provider_request", "provider_response", "provider_failure",
    "semantic_audit", "verification_program", "extraction_program",
})
_PURPOSES = frozenset({"case", "extraction", "verification"})
_MAX_RECORD_BYTES = 8 * 1024 * 1024
_PRIVATE_FIELDS = frozenset({
    "reasoning_content", "reasoning_details", "chain_of_thought", "analysis",
    "thinking", "headers", "response_headers", "request_headers",
    "authorization", "api_key", "apikey", "secret", "password", "passwd",
    "token", "access_token", "refresh_token", "client_secret", "private_key",
    "credentials", "credential", "database_url", "connection_string",
})
_CONFIG_FIELDS = frozenset({
    "mode", "synthetic_only", "base_url", "endpoint", "request_model",
    "temperature", "timeout", "max_retries", "thinking", "stream", "reasoning_effort",
    "plan_sha256", "public_cases_sha256", "extraction_prompt_sha256",
    "extraction_schema_sha256", "verification_prompt_sha256",
    "verification_schema_sha256", "versions", "omitted_parameters",
    "deadline_utc", "source_hashes", "gold_sha256", "stage",
    "response_identity_policy", "request_contract_version", "tool_choice",
    "fallback", "baseline_commit", "selected_case_positions", "verification_mode",
    "extraction_mode", "extraction_window_contracts", "execution_plan", "reference_version",
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
            if key == "arguments" and isinstance(item, str):
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
    ):
        self._budget = budget
        self._manifest = budget.snapshot()
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
                    "legacy-v4", "nullable-proof-v1",
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
        self._mixed = type(self._execution_plan) is str and self._execution_plan in PHASE_SPLIT_PLANS
        if not self._mixed and {"phase_request_version", "phase_request_policy"} & set(frozen_config):
            raise EvaluationBudgetAbort("invalid_record_mixed_registration")
        self._response_sequences: set[int] = set()
        self._reference_version = "legacy-v1"
        if (self._extraction_mode == "grounded-v4"
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

    def _validate_fixed_v4_registration(self, config: dict, plan: tuple[dict, ...]) -> None:
        """v4只注册固定21／140身份；不能从通用记录字段扩成任意运行。"""
        from .evaluation import build_window
        from .evaluation_cases import CASES
        from .evaluation_reference import public_window_projection, _fixed_case_sets
        from .semantic_evaluation_cases import SEMANTIC_CASES

        reference21 = self._execution_plan == REFERENCE21_V4_PLAN
        cases = _fixed_case_sets()[0] if reference21 else (*CASES, *SEMANTIC_CASES)
        count, cap = (21, 42) if reference21 else (140, 280)
        expected = tuple({
            "case_position": position, "case_name": case.name,
            "input_sha256": canonical_sha256(public_window_projection(build_window(case))),
        } for position, case in enumerate(cases))
        positions = config.get("selected_case_positions")
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
        if (config.get("execution_plan") != (REFERENCE21_V4_PLAN if reference21 else MIXED_PLAN if self._mixed else "full140-grounded-v4-source-v2")
                or config.get("reference_version") != "source-fidelity-v2"
                or config.get("mode") != (REFERENCE21_V4_MODE if reference21 else MIXED_MODE if self._mixed else "deepseek_bounded_full140_v4_source_v2")
                or config.get("stage") != (REFERENCE21_V4_STAGE if reference21 else MIXED_STAGE if self._mixed else "full140-v4-source-v2")
                or self._extraction_mode != "grounded-v4"
                or config.get("verification_mode") != "nullable-proof-v1"
                or config.get("tool_choice") != {
                    "extraction": {"mode": "omitted", "name": "GroundedMemoryLabelsV4"},
                    "verification": {"mode": "forced" if self._mixed else "omitted", "name": "SourceVerificationOutput"},
                }
                or type(config.get("max_retries")) is not int or config["max_retries"] != 0
                or self._manifest["request_limit"] != cap
                or not isinstance(positions, (list, tuple))
                or any(type(position) is not int for position in positions)
                or tuple(positions) != tuple(range(count))
                or any(type(item["case_position"]) is not int for item in plan)
                or len(cases) != count or plan != expected):
            raise EvaluationBudgetAbort("invalid_record_full140_v4_registration")

    @property
    def execution_plan(self) -> str:
        return self._execution_plan

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
        if self._mixed and (type(sequence) is not int or not 1 <= sequence <= self._manifest["request_limit"]):
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
        if self._mixed:
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
            payload={"failure_kind": kind, "response_obtained": self._mixed and sequence in self._response_sequences},
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
