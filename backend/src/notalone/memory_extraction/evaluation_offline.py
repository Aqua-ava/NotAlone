"""只运行公开合成用例的 P0 离线协议，不提供供应商执行入口。"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import asdict
from importlib.metadata import version
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import httpx

from notalone.memory_extraction import verification_adapters
from notalone.memory_extraction.adapters import (
    EXTRACTION_SCHEMA,
    EXTRACTION_SYSTEM_PROMPT,
)
from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.evaluation import (
    ERROR_FALSE_FACT,
    ERROR_WRONG_SUBJECT,
    EvaluationResult,
    build_window,
    evaluate_case,
    summarize,
)
from notalone.memory_extraction.evaluation_cases import CASES, EvaluationCase
from notalone.memory_extraction.evaluation_formal_task import evaluate_task
from notalone.memory_extraction.evaluation_extraction import (
    EvaluationExtractionMode, extraction_contract, extraction_runtime, extraction_tool_name,
)
from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationAsyncTransport,
    EvaluationBudget,
    EvaluationBudgetAbort,
    EvaluationTransport,
)
from notalone.memory_extraction.evaluation_records import (
    EvaluationRecordStore,
    canonical_sha256,
)
from notalone.memory_extraction.evaluation_reference import public_window_projection, _fixed_case_sets
from notalone.memory_extraction.flow import _to_fact
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
from notalone.memory_extraction.runtime import MemoryExtractionRuntime, ExtractionPayload
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
from notalone.memory_extraction.verification_adapters import (
    SOURCE_VERIFICATION_SCHEMA, CORE_SOURCE_FIDELITY_PROFILE,
    LangChainSourceVerificationRuntime,
)
from notalone.memory_extraction.verification import (
    SourceVerificationMode, validate_source_verification,
)
from notalone.memory_trace.context import current_trace
from .evaluation_provider_contract import (
    MIXED_REQUEST_VERSION, mixed_phase_policy, FULL140_E2_PLAN, PHASE_SPLIT_PLANS, REFERENCE21_PLANS,
    SEMANTIC4_PROMPT_PROFILE, validate_semantic4_windows,
    PUBLIC_QUALITY_PLANS, validate_extraction_prompt_profile, REFERENCE16_PRO_PLANS,
    CORE_PROFILE_PLAN, ECNUEvaluationContract,
)

_BASE_URL = "https://evaluation.invalid/v1"
_ENDPOINT = f"{_BASE_URL}/chat/completions"
_REQUEST_MODEL = "synthetic-request-alias"


class _BatchStopped(Exception):
    """已保存的明确失败或安全结果结束后续位置。"""


def _verification_contract(mode: SourceVerificationMode | str, *, prompt_profile: str = "default") -> tuple[str, dict]:
    """从实际生产适配器取得所选合同；冻结与每次发送前核验共用。"""
    selected = SourceVerificationMode(mode)
    return verification_adapters.source_verification_contract(selected, prompt_profile=prompt_profile)


class _RecordedVerificationRuntime:
    """保留真实适配器原输出与程序核验差异，不增加模型调用或改写判定。"""

    def __init__(self, runtime: LangChainSourceVerificationRuntime,
                 store: EvaluationRecordStore, position: int,
                 invocation_scope: Callable | None = None, *, prompt_profile: str = "default"):
        self._prompt_profile = prompt_profile
        self._runtime = runtime
        self._store = store
        self._position = position
        self._invocation_scope = invocation_scope

    @property
    def verification_mode(self) -> SourceVerificationMode:
        return self._runtime.verification_mode

    def for_mode(self, mode: SourceVerificationMode | str) -> _RecordedVerificationRuntime:
        return _RecordedVerificationRuntime(
            self._runtime.for_mode(mode), self._store, self._position, self._invocation_scope,
            prompt_profile=self._prompt_profile,
        )

    def verify(self, *, window: ExtractionWindow,
               facts: tuple[ExtractedFact, ...]) -> tuple[dict[str, Any], ...]:
        if self._invocation_scope is None:
            payloads = self._runtime.verify(window=window, facts=facts)
        else:
            prompt, _ = _verification_contract(self.verification_mode, prompt_profile=self._prompt_profile)
            messages = [{"role": "system", "content": prompt}, {"role": "user", "content":
                        verification_adapters._verification_text(window, facts, include_position_guide=(
                            self.verification_mode is SourceVerificationMode.NULLABLE_PROOF_V3
                        ))}]
            with self._store.stage(self._position, "verification"), self._invocation_scope("verification", messages, window):
                payloads = self._runtime.verify(window=window, facts=facts)
        if self.verification_mode in {SourceVerificationMode.NULLABLE_PROOF_V1, SourceVerificationMode.NULLABLE_PROOF_V3}:
            results = validate_source_verification(
                payloads, window=window, facts=facts, mode=self.verification_mode,
            )
            with self._store.stage(self._position, "verification"):
                self._store.record(kind="verification_program", payload={
                    "verification_mode": self.verification_mode.value,
                    "results": [{
                        **asdict(result),
                        "proof_verification": ({
                            "status": result.proof_verification.status,
                            "reason": result.proof_verification.reason,
                            "semantic_basis": result.proof_verification.semantic_basis,
                        } if result.proof_verification is not None else None),
                    } for result in results],
                })
        return payloads


class _RecordedExtractionRuntime:
    """模型标签与编译十四槽分开保存；失败不生成替代候选。"""

    def __init__(self, runtime: MemoryExtractionRuntime, store: EvaluationRecordStore,
                 position: int, mode: EvaluationExtractionMode, state: dict,
                 invocation_scope: Callable | None = None):
        self._runtime, self._store, self._position = runtime, store, position
        self._mode, self._state = mode, state
        self._invocation_scope = invocation_scope

    @property
    def prompt_profile(self) -> str:
        return getattr(self._runtime, "prompt_profile", "default")

    def for_prompt_profile(self, prompt_profile: str) -> _RecordedExtractionRuntime:
        select = getattr(self._runtime, "for_prompt_profile", None)
        if not callable(select):
            raise ValueError("提取适配器不支持指定任务教学profile。")
        return _RecordedExtractionRuntime(select(prompt_profile), self._store, self._position,
            self._mode, self._state, invocation_scope=self._invocation_scope)

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        try:
            if self._invocation_scope is None:
                facts = self._runtime.extract(window)
            else:
                from .grounded_adapter import grounded_input

                prompt, _ = extraction_contract(self._mode, window, prompt_profile=self.prompt_profile)
                messages = [{"role": "system", "content": prompt},
                            {"role": "user", "content": grounded_input(window)}]
                with self._store.stage(self._position, "extraction"), self._invocation_scope("extraction", messages, window):
                    facts = self._runtime.extract(window)
        except ExtractionInvalidOutputError:
            if self._mode.is_grounded:
                with self._store.stage(self._position, "extraction"):
                    self._store.record(kind="extraction_program", payload={
                        "extraction_mode": self._mode.value, "status": "rejected",
                    })
            raise
        if self._mode.is_grounded:
            with self._store.stage(self._position, "extraction"):
                self._store.record(kind="extraction_program", payload={
                    "extraction_mode": self._mode.value, "status": "compiled", "facts": facts,
                })
        self._state["extraction_empty"] = not facts
        return facts


def _check_json_fact_types(payload: dict, schema: dict) -> None:
    """评测不让产品外壳的float/UUID/date转换掩盖原JSON类型错误。"""
    for name in ("text", "category", "subject", "topic", "speech_act",
                 "assertion_status", "figurative_type", "interpretation_reason"):
        if not isinstance(payload[name], str):
            raise ExtractionInvalidOutputError("评测候选字符串类型非法。")
        allowed = schema["properties"][name].get("enum")
        if allowed is not None and payload[name] not in allowed:
            raise ExtractionInvalidOutputError("评测候选枚举非法。")
    for name in ("source_message_ids", "risk_flags", "alternatives"):
        if (not isinstance(payload[name], list)
                or any(not isinstance(item, str) for item in payload[name])):
            raise ExtractionInvalidOutputError("评测候选数组类型非法。")
    for name in ("valid_at", "invalid_at"):
        if payload[name] is not None and not isinstance(payload[name], str):
            raise ExtractionInvalidOutputError("评测候选日期类型非法。")
    confidence = payload["confidence"]
    if type(confidence) not in (int, float) or not 0 <= confidence <= 1:
        raise ExtractionInvalidOutputError("评测候选置信度类型或范围非法。")


class _RecordedModel:
    """在 E/V 原解析器消费之前保存完整允许的适配器响应。"""

    def __init__(self, model: Any, store: EvaluationRecordStore, position: int,
                 window: ExtractionWindow, call_state: dict,
                 purpose: str | None = None, invocation_scope: Callable | None = None,
                 verification_tool_choice: str = "forced", extraction_tool_choice: str = "forced",
                 extraction_mode: EvaluationExtractionMode = EvaluationExtractionMode.LEGACY_E14):
        self._model = model
        self._store = store
        self._position = position
        self._window = window
        self._call_state = call_state
        self._purpose = purpose
        self._invocation_scope = invocation_scope
        self._verification_tool_choice = verification_tool_choice
        self._extraction_tool_choice = extraction_tool_choice
        self._extraction_mode = extraction_mode

    def bind_tools(self, tools: list[dict], **options: Any) -> _RecordedModel:
        purpose = {
            extraction_tool_name(self._extraction_mode): "extraction",
            SOURCE_VERIFICATION_SCHEMA["title"]: "verification",
        }.get(tools[0].get("title") if len(tools) == 1 else None)
        if purpose is None or len(tools) != 1:
            raise EvaluationBudgetAbort("offline_tool_contract_changed")
        if (purpose == "extraction"
                and (tools[0] != extraction_contract(self._extraction_mode, self._window)[1]
                     or canonical_sha256(tools[0]) !=
                     self._store.extraction_contract_hashes(self._position)["schema_sha256"])):
            raise EvaluationBudgetAbort("offline_tool_contract_changed")
        if options.get("tool_choice", tools[0]["title"]) != tools[0]["title"]:
            raise EvaluationBudgetAbort("offline_tool_contract_changed")
        if (purpose == "verification" and self._verification_tool_choice == "omitted"
                or purpose == "extraction" and self._extraction_tool_choice == "omitted"):
            # 仅评测代理省略绑定选项；返回仍须唯一具名工具，缺失不重试。
            options = {key: value for key, value in options.items() if key != "tool_choice"}
        else:
            options = {**options, "tool_choice": tools[0]["title"]}
        return _RecordedModel(
            self._model.bind_tools(tools, **options), self._store,
            self._position, self._window, self._call_state, purpose,
            self._invocation_scope,
            self._verification_tool_choice,
            self._extraction_tool_choice,
            self._extraction_mode,
        )

    def invoke(self, messages: list[dict]) -> Any:
        if self._purpose is None:
            raise EvaluationBudgetAbort("offline_unbound_model")
        if self._purpose == "extraction" and (
            not messages or set(messages[0]) != {"role", "content"}
            or messages[0]["role"] != "system"
            or canonical_sha256(messages[0]["content"]) !=
            self._store.extraction_contract_hashes(self._position)["prompt_sha256"]
        ):
            raise EvaluationBudgetAbort("offline_frozen_extraction_prompt_changed")
        scope = (self._invocation_scope(self._purpose, messages, self._window)
                 if self._invocation_scope is not None else nullcontext())
        with self._store.stage(self._position, self._purpose), scope:
            try:
                message = self._model.invoke(messages)
            except Exception as error:
                from openai import APIConnectionError, APITimeoutError

                self._call_state["failure_status"] = (
                    "unknown" if isinstance(error, (APIConnectionError, APITimeoutError))
                    else "failed"
                )
                raise
            self._store.record(kind="adapter_output", payload=message.model_dump())
            calls = getattr(message, "tool_calls", None)
            expected = (extraction_tool_name(self._extraction_mode) if self._purpose == "extraction"
                        else SOURCE_VERIFICATION_SCHEMA["title"])
            if (not isinstance(calls, list) or len(calls) != 1
                    or calls[0].get("name") != expected):
                raise ExtractionInvalidOutputError("离线模型未返回唯一具名工具结果。")
            if (self._purpose == "extraction" and
                    self._extraction_mode is EvaluationExtractionMode.LEGACY_E14):
                self._check_extraction(calls[0].get("args"))
                self._call_state["extraction_empty"] = not calls[0]["args"]["facts"]
            return message

    def _check_extraction(self, arguments: Any) -> None:
        """复用原外壳转换与来源规则；这里只提前阻止非法结构继续调用 V。"""
        if (not isinstance(arguments, dict) or set(arguments) != {"facts"}
                or not isinstance(arguments["facts"], list)):
            raise ExtractionInvalidOutputError("离线提取结构不符合原契约。")
        schema = EXTRACTION_SCHEMA["properties"]["facts"]["items"]
        for payload in arguments["facts"]:
            if (not isinstance(payload, dict)
                    or not set(schema["required"]) <= set(payload)
                    or not set(payload) <= set(schema["properties"])):
                raise ExtractionInvalidOutputError("离线候选结构不符合原契约。")
            _check_json_fact_types(payload, schema)
            try:
                fact = _to_fact(payload)
            except Exception:
                raise ExtractionInvalidOutputError("离线候选字段不符合原契约。") from None
            sources = set(fact.source_message_ids)
            if (not sources <= self._window.message_id_set
                    or not sources & self._window.target_message_id_set):
                raise ExtractionInvalidOutputError("离线候选来源不符合原契约。")


def _frozen_config(
    plan: tuple[dict, ...], *, request_timeout_seconds: float = 60.0,
    max_retries: int = 2,
    verification_mode: SourceVerificationMode | str = SourceVerificationMode.LEGACY_V4,
    extraction_mode: EvaluationExtractionMode | str = EvaluationExtractionMode.LEGACY_E14,
    windows: tuple[ExtractionWindow, ...] = (),
    prompt_profile: str = "default",
    extraction_prompt_profile: str = "default",
) -> dict:
    selected = SourceVerificationMode(verification_mode)
    verification_prompt, verification_schema = _verification_contract(selected, prompt_profile=prompt_profile)
    extraction_selected = EvaluationExtractionMode(extraction_mode)
    extraction_frozen: dict = {"extraction_mode": extraction_selected.value}
    if extraction_selected.is_grounded:
        if not windows or len(windows) != len(plan):
            raise EvaluationBudgetAbort("evaluation_grounded_windows_required")
        contracts = tuple(extraction_contract(extraction_selected, window, prompt_profile=extraction_prompt_profile) for window in windows)
        extraction_frozen.update({
            "extraction_prompt_sha256": canonical_sha256(contracts[0][0]),
            "extraction_schema_sha256": canonical_sha256(tuple(schema for _, schema in contracts)),
            "extraction_window_contracts": [{
                "input_sha256": item["input_sha256"], "prompt_sha256": canonical_sha256(prompt),
                "schema_sha256": canonical_sha256(schema),
            } for item, (prompt, schema) in zip(plan, contracts)],
        })
    return {
        "mode": "offline_mock", "synthetic_only": True,
        "base_url": _BASE_URL, "endpoint": _ENDPOINT,
        "request_model": _REQUEST_MODEL, "temperature": 0.0,
        "verification_mode": selected.value,
        **({"extraction_prompt_profile": extraction_prompt_profile} if extraction_prompt_profile != "default" else {}),
        **({"verification_prompt_profile": prompt_profile} if prompt_profile != "default" else {}),
        "timeout": request_timeout_seconds, "max_retries": max_retries,
        "thinking": {"type": "enabled"}, "stream": False,
        "plan_sha256": canonical_sha256(plan),
        "extraction_prompt_sha256": canonical_sha256(EXTRACTION_SYSTEM_PROMPT),
        "extraction_schema_sha256": canonical_sha256(EXTRACTION_SCHEMA),
        "verification_prompt_sha256": canonical_sha256(verification_prompt),
        "verification_schema_sha256": canonical_sha256(verification_schema),
        "versions": {name: version(name) for name in
                     ("openai", "langchain_deepseek", "httpx")},
        "omitted_parameters": [
            "reasoning_effort", "response_format", "strict", "parallel_tool_calls",
            "max_tokens", "max_completion_tokens",
        ],
        **extraction_frozen,
    }


def _summary(outcomes: list[dict], results: list[EvaluationResult]) -> dict:
    counts = {status: sum(item["status"] == status for item in outcomes)
              for status in ("completed", "empty", "failed", "unknown", "unrun")}
    completed = counts["completed"] + counts["empty"]
    return {
        "planned": len(outcomes), **counts, "completed": completed,
        "plan_complete": completed == len(outcomes),
        "dimensions": [asdict(item) for item in summarize(results)],
    }


def _known_raw_safety(events: tuple[dict, ...]) -> dict[str, int]:
    """RAW已封存的安全事实独立累计，不把未完成FULL的窗口加入质量分母。"""
    raw, final = {}, set()
    for event in events:
        if event["kind"] != "semantic_audit":
            continue
        payload = event["payload"]
        position = event["case_position"]
        if payload.get("phase") == "raw":
            raw[position] = payload["review"]
        elif payload.get("phase") == "final":
            final.add(position)
    rows = [row for review in raw.values() for row in review["e_rows"]]
    return {
        "raw_reviewed_windows": len(raw),
        "raw_false_fact": sum(row["safety"] == "false_fact" for row in rows),
        "raw_wrong_person": sum(row["safety"] == "wrong_person" for row in rows),
        "unsafe_windows": sum(any(row["safety"] in {"false_fact", "wrong_person"}
                                  for row in review["e_rows"]) for review in raw.values()),
        "without_final_review": len(set(raw) - final),
    }


def _audit_persist_capability(store: EvaluationRecordStore, case_position: int,
                              state: dict) -> Callable[[dict], dict]:
    """把窗口归属和失效状态固定在闭包中，不作为调用方可覆盖的参数。"""
    def persist_audit(payload: dict) -> dict:
        if not state["active"] or not isinstance(payload, dict):
            raise EvaluationBudgetAbort("audit_persist_capability_expired")
        phase = payload.get("phase")
        keys = ({"phase", "review"} if phase == "raw" else
                {"phase", "review", "report", "raw_receipt"})
        if (phase == "final" and "verification_protocol" in payload
                and state.get("verification_mode") in {"nullable-proof-v1", "nullable-proof-v3"}):
            keys = keys | {"verification_protocol"}
        if phase == "final" and state.get("execution_plan") == "bounded-runtime15-v1":
            keys = keys | {"axis_reviews"}
        if state.get("extraction_mode") in {"grounded-v2", "grounded-v3", "grounded-v4"}:
            keys = keys | {"extraction_protocol"}
        if (phase not in {"raw", "final"} or set(payload) != keys
                or (phase == "raw" and state["phase"] is not None)
                or (phase == "final" and state["phase"] != "raw")):
            raise EvaluationBudgetAbort("audit_persist_phase_invalid")
        with store.stage(case_position, "case"):
            receipt = store.record(kind="semantic_audit", payload=payload)
        if (receipt["removed_paths"] or receipt["payload"] != payload
                or receipt["payload_sha256"] != canonical_sha256(payload)):
            raise EvaluationBudgetAbort("audit_persist_payload_changed")
        state["phase"] = phase
        return receipt

    return persist_audit


def run_offline_evaluation(
    *, cases: tuple[EvaluationCase, ...], output_directory: Path, run_id: UUID,
    request_limit: int, synthetic_transport: httpx.MockTransport,
    verification_mode: SourceVerificationMode | str = SourceVerificationMode.LEGACY_V4,
    extraction_mode: EvaluationExtractionMode | str = EvaluationExtractionMode.LEGACY_E14,
) -> dict:
    """串行执行 Mock E/V、原评分与可靠退场；不接受真实端点或模型配置。"""
    try:
        selected = SourceVerificationMode(verification_mode)
    except (TypeError, ValueError):
        raise EvaluationBudgetAbort("offline_invalid_verification_mode") from None
    try:
        extraction_selected = EvaluationExtractionMode(extraction_mode)
    except (TypeError, ValueError):
        raise EvaluationBudgetAbort("offline_invalid_extraction_mode") from None
    if extraction_selected is EvaluationExtractionMode.GROUNDED_V4:
        raise EvaluationBudgetAbort("offline_v4_fixed_plan_required")
    public_cases = (*CASES, *SEMANTIC_CASES)
    if (current_trace() is not None
            or type(synthetic_transport) is not httpx.MockTransport
            or not isinstance(cases, tuple) or not cases
            or any(case not in public_cases for case in cases)
            or len({case.name for case in cases}) != len(cases)):
        raise EvaluationBudgetAbort("offline_public_plan_required")
    windows = tuple(build_window(case) for case in cases)
    plan = tuple({
        "case_position": position, "case_name": case.name,
        "input_sha256": canonical_sha256(public_window_projection(window)),
    } for position, (case, window) in enumerate(zip(cases, windows)))
    config = {**_frozen_config(plan, verification_mode=selected,
                             extraction_mode=extraction_selected, windows=windows),
              "public_cases_sha256": canonical_sha256(cases)}
    budget = EvaluationBudget.create(
        run_id=run_id, output_directory=output_directory, request_limit=request_limit,
        allowed_endpoints=(_ENDPOINT,), config_sha256=canonical_sha256(config),
    )
    store = EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
    return _run_evaluation_batch(
        cases=cases, windows=windows, plan=plan, budget=budget, store=store,
        base_url=_BASE_URL, request_model=_REQUEST_MODEL,
        api_key="synthetic-not-a-real-key", synthetic_transport=synthetic_transport,
        provider="synthetic-provider",
        verification_mode=selected,
        extraction_mode=extraction_selected,
    )


def _plain_invocation(purpose: str, messages: list[dict], window: ExtractionWindow):
    """仅合成协议控制省略外部请求合同，实际SDK仍走预算transport。"""
    return nullcontext()


def _formal_execution_payload(evaluated: Any, database_url: str) -> dict:
    from notalone.application.memory_service import MemoryService
    from notalone.persistence import PostgresMemoryStore, PostgresOwnerMemoryStore
    from notalone.server.app import create_app
    from notalone.server.testing import InProcessClient

    token = "bounded-evaluation-local"
    client = InProcessClient(create_app(
        database_url=database_url, owner_id=evaluated.window.owner_id, token=token,
        memory_service=MemoryService(contact_memory=PostgresMemoryStore(database_url),
                                     owner_memory=PostgresOwnerMemoryStore(database_url)),
    ))
    path = f"/api/contacts/{evaluated.window.contact_id}/memory-candidates"
    response = client.get(path, headers={"Authorization": "Bearer " + token})
    if response.status_code != 200:
        raise EvaluationBudgetAbort("evaluation_formal_memory_api_unavailable")
    return {"task": asdict(evaluated.task), "worker_results": [asdict(item) for item in evaluated.worker_results],
            "trace": evaluated.trace, "memory_api": {"path": path, "status_code": response.status_code,
                                                     "body": response.json()}}


def _failed_formal_task_payload(database_url: str, window: ExtractionWindow, task_id: UUID) -> dict:
    """首失败只读取原任务和实际追踪，不恢复租约或重新执行提取。"""
    from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
    from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
    from notalone.scopes import ContactScope

    scope = ContactScope(window.owner_id, window.contact_id)
    task = PostgresBackgroundTaskRepository(database_url).get_task(
        owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task_id,
    )
    traces = PostgresExtractionTraceStore(database_url)
    batches = traces.list_batches(scope, limit=2)
    return {"reason_code": "formal_task_first_execution_failed", "task": asdict(task),
            "actual_traces": [traces.get_batch(scope, row["trace_id"]) for row in batches]}


def _bounded_positive_delivery(execution: dict | None, position: int) -> set[str]:
    """只核六规则的实际交付；语义正确性由已封存独立审核负责。"""
    if execution is None:
        return set()
    expected_rules = ("BR_AUTHOR_ARRIVAL_V1", "BR_KIN_LEND_V1", "BR_COMPLETED_QA_V1", "BR_TWO_ROLES_V1",
                      "BR_REQUEST_V1", "BR_REQUEST_V1", "BR_COND_RUN_V1")
    items = execution["memory_api"]["body"]["candidates"]
    frames: set[str] = set()
    for item in items:
        evidence = item.get("dimension_evidence")
        basis = evidence.get("semantic_basis") if isinstance(evidence, dict) else None
        if (item.get("status") != "pending" or item.get("source_dependency_mode") != "all"
                or item.get("dimension_evidence_source_current") is not True
                or not isinstance(evidence, dict) or evidence.get("version") != 4
                or not isinstance(basis, dict) or basis.get("version") != 3
                or basis.get("rules") != [{"rule_id": expected_rules[position], "rule_version": 1}]):
            continue
        states = item.get("dimension_evidence_dimensions", {})
        if any(states.get(axis, {}).get("state") != "valid"
               for axis in ("subject", "time", "paraphrase", "reference", "media", "reported")):
            continue
        frames.add(basis["frame"])
    return frames


def _run_evaluation_batch(
    *, cases: tuple[EvaluationCase, ...], windows: tuple[ExtractionWindow, ...],
    plan: tuple[dict, ...], budget: EvaluationBudget, store: EvaluationRecordStore,
    base_url: str, request_model: str, api_key: str,
    synthetic_transport: httpx.MockTransport | None, provider: str,
    contract: Any = None, invocation_scope: Callable | None = None,
    semantic_audit: Callable[[dict], dict] | None = None,
    gold_reference: dict | None = None, code_prefix: str = "offline",
    credential_loader: Callable[[], str] | None = None,
    request_timeout_seconds: float = 60.0, max_retries: int = 2,
    verification_mode: SourceVerificationMode | str = SourceVerificationMode.LEGACY_V4,
    verification_tool_choice: str = "forced",
    reasoning_effort: str | None = None,
    extraction_tool_choice: str = "forced",
    extraction_mode: EvaluationExtractionMode | str = EvaluationExtractionMode.LEGACY_E14,
    execution_plan: str = "original",
    extraction_prompt_profile: str = "default",
    formal_task_ids: tuple[UUID, ...] = (),
    database_url: str | None = None,
) -> dict:
    """P0/P1共用记录与收尾；真实配置与独审验证由各入口负责。"""
    selected = SourceVerificationMode(verification_mode)
    extraction_selected = EvaluationExtractionMode(extraction_mode)
    from .evaluation_bounded_cases import BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_PLAN

    pro16 = type(execution_plan) is str and execution_plan in REFERENCE16_PRO_PLANS
    bounded = execution_plan == BOUNDED_RUNTIME_PLAN
    bounded_profile = store.bounded_provider_profile if bounded else None
    if bounded:
        from .evaluation_phased_audit import PhasedEvaluationAudit

        if (cases != BOUNDED_RUNTIME_CASES or len(windows) != 15 or len(plan) != 15
                or type(formal_task_ids) is not tuple or len(formal_task_ids) != 15
                or any(not isinstance(value, UUID) for value in formal_task_ids)
                or len(set(formal_task_ids)) != 15 or type(database_url) is not str or not database_url
                or extraction_selected is not EvaluationExtractionMode.GROUNDED_V2
                or selected is not SourceVerificationMode.NULLABLE_PROOF_V3
                or type(max_retries) is not int or max_retries != 0 or request_timeout_seconds != 300
                or extraction_tool_choice != "omitted" or verification_tool_choice != "forced"
                or bounded_profile is None or not bounded_profile.is_bounded
                or base_url != bounded_profile.base_url or request_model != bounded_profile.model
                or not isinstance(semantic_audit, PhasedEvaluationAudit)
                or semantic_audit.execution_plan != execution_plan
                or semantic_audit.reference_version != execution_plan
                or store.execution_plan != execution_plan or store.reference_version != execution_plan
                or semantic_audit.reference_sha256 != store.gold_sha256
                or not isinstance(gold_reference, dict)
                or gold_reference.get("criteria_sha256") != semantic_audit.criteria_sha256
                or reasoning_effort not in {None, "max"}
                or synthetic_transport is None and (contract is None or invocation_scope is None)):
            raise EvaluationBudgetAbort("evaluation_bounded_fixed_tasks_required")
        for position, (window, task_id) in enumerate(zip(windows, formal_task_ids, strict=True)):
            binding = store.formal_task_binding(position)
            if (binding["task_id"] != str(task_id) or binding["owner_id"] != str(window.owner_id)
                    or binding["contact_id"] != str(window.contact_id)
                    or binding["input_sha256"] != canonical_sha256(window)):
                raise EvaluationBudgetAbort("evaluation_bounded_task_binding_changed")
    elif formal_task_ids or database_url is not None:
        raise EvaluationBudgetAbort("evaluation_formal_tasks_require_bounded_plan")
    if pro16 and (store.execution_plan != execution_plan or store.reference_version != "source-fidelity-v2"
            or cases != _fixed_case_sets()[0][:16] or len(windows) != 16 or len(plan) != 16
            or extraction_selected is not EvaluationExtractionMode.GROUNDED_V2
            or selected is not SourceVerificationMode.LEGACY_V4
            or extraction_tool_choice != "forced" or verification_tool_choice != "forced"
            or reasoning_effort != "none" or request_model != "deepseek-v4-pro"
            or base_url != "https://api.deepseek.com" or request_timeout_seconds != 300
            or type(max_retries) is not int or max_retries != 0 or semantic_audit is None
            or contract is None or invocation_scope is None):
        raise EvaluationBudgetAbort("evaluation_reference16_pro_fixed_plan_required")
    mixed = execution_plan in PHASE_SPLIT_PLANS
    reference21_v4 = execution_plan in REFERENCE21_PLANS
    public_quality = execution_plan in PUBLIC_QUALITY_PLANS
    core = execution_plan == CORE_PROFILE_PLAN
    prompt_profile = CORE_SOURCE_FIDELITY_PROFILE if core else SEMANTIC4_PROMPT_PROFILE if public_quality else "default"
    validate_extraction_prompt_profile(execution_plan, extraction_prompt_profile)
    if store.extraction_prompt_profile != extraction_prompt_profile:
        raise EvaluationBudgetAbort("evaluation_frozen_extraction_prompt_profile_mismatch")
    if mixed != (store.execution_plan in PHASE_SPLIT_PLANS) or mixed and execution_plan != store.execution_plan:
        raise EvaluationBudgetAbort("evaluation_mixed_fixed_plan_required")
    if core or store.execution_plan == CORE_PROFILE_PLAN:
        if (not core or store.execution_plan != execution_plan or store.reference_version != CORE_PROFILE_PLAN
                or not store.belongs_to(budget) or len(cases) != len(windows) or len(plan) != len(windows)
                or any(case.name != item["case_name"] for case, item in zip(cases, plan, strict=True))
                or extraction_selected is not EvaluationExtractionMode.GROUNDED_V2
                or selected is not SourceVerificationMode.LEGACY_V4
                or type(max_retries) is not int or max_retries != 0
                or type(request_timeout_seconds) is not float or request_timeout_seconds != 300.0
                or extraction_tool_choice != "omitted" or verification_tool_choice != "omitted"
                or base_url != "https://api.deepseek.com" or request_model != "deepseek-flash"
                or reasoning_effort != "max" or not callable(semantic_audit)
                or not isinstance(gold_reference, dict) or gold_reference.get("gold_sha256") != store.gold_sha256
                or synthetic_transport is None and (contract is None or invocation_scope is None)):
            raise EvaluationBudgetAbort("evaluation_core_fixed_plan_required")
        store.validate_core_execution(windows, plan)
        if contract is not None and (not isinstance(contract, ECNUEvaluationContract)
                or contract.registration_binding() != store.core_contract_binding()):
            raise EvaluationBudgetAbort("evaluation_core_provider_binding_changed")
    if store.extraction_mode != extraction_selected.value:
        raise EvaluationBudgetAbort("evaluation_frozen_extraction_mode_mismatch")
    e2 = execution_plan == FULL140_E2_PLAN
    if (extraction_selected is EvaluationExtractionMode.GROUNDED_V4 or e2) and (
        extraction_selected is not (EvaluationExtractionMode.GROUNDED_V2 if e2 else EvaluationExtractionMode.GROUNDED_V4)
        or store.reference_version != "source-fidelity-v2"
        or cases != (_fixed_case_sets()[0] if reference21_v4 else (*CASES, *SEMANTIC_CASES))
        or len(windows) != (21 if reference21_v4 else 140) or len(plan) != (21 if reference21_v4 else 140)
        or selected is not (SourceVerificationMode.LEGACY_V4 if public_quality or e2 else SourceVerificationMode.NULLABLE_PROOF_V1)
        or extraction_tool_choice != "omitted" or verification_tool_choice != ("forced" if mixed else "omitted")
        or type(max_retries) is not int or max_retries != 0 or semantic_audit is None
    ):
        raise EvaluationBudgetAbort("evaluation_full140_v4_fixed_plan_required")
    if public_quality:
        validate_semantic4_windows(windows)
    outcomes = [{**item, "status": "unrun"} for item in plan]
    results: list[EvaluationResult] = []
    audits: list[dict] = []
    dimension_results: list[EvaluationResult] = []
    delivery_frames: set[str] = set()
    positive_delivered = 0
    current_position: int | None = None
    stopped_code: str | None = None
    sync_client = None
    async_client = None
    cleanup_error_codes: list[str] = []
    try:
        from langsmith import tracing_context

        with budget.batch(), tracing_context(enabled=False, parent=False):
            if credential_loader is not None:
                if contract is not None:
                    contract.check_preflight()
                try:
                    api_key = credential_loader()
                    if not isinstance(api_key, str) or not api_key.strip():
                        raise ValueError("empty_credential")
                except BaseException:
                    raise _BatchStopped("ecnu_credential_unavailable") from None
            transport_options = {"contract": contract} if contract is not None else {}
            event_hooks: dict[str, list[Callable[..., Any]]] | None = None
            if bounded:
                from notalone.memory_trace.transport import _request_hook, _response_hook

                event_hooks = {"request": [_request_hook], "response": [_response_hook]}
            sync_client = httpx.Client(
                transport=EvaluationTransport(
                    budget, synthetic_transport=synthetic_transport, records=store,
                    **transport_options,
                ), trust_env=False, follow_redirects=False,
                timeout=request_timeout_seconds, event_hooks=event_hooks,
            )
            async_client = httpx.AsyncClient(
                transport=EvaluationAsyncTransport(
                    budget, synthetic_transport=synthetic_transport, records=store,
                    **transport_options,
                ), trust_env=False, follow_redirects=False,
                timeout=request_timeout_seconds,
            )
            from langchain_deepseek import ChatDeepSeek
            from langchain_core.language_models import BaseChatModel
            from pydantic import SecretStr

            model = ChatDeepSeek(
                api_key=SecretStr(api_key), base_url=base_url,
                model=request_model, temperature=0.0,
                **({"max_tokens": 8192} if pro16 else bounded_profile.output_parameters if bounded_profile is not None else {}),
                timeout=request_timeout_seconds, max_retries=max_retries,
                extra_body={"thinking": {"type": "disabled" if pro16 else "enabled"},
                            **({"reasoning_effort": "max"} if bounded else
                               {"reasoning_effort": reasoning_effort} if reasoning_effort else {})},
                http_client=sync_client, http_async_client=async_client,
            )
            verification_model = ChatDeepSeek(
                api_key=SecretStr(api_key), base_url=base_url, model=request_model, temperature=0.0,
                **({"max_tokens": 8192} if pro16 else bounded_profile.output_parameters if bounded_profile is not None else {}),
                timeout=request_timeout_seconds, max_retries=max_retries,
                extra_body={"thinking": {"type": "disabled"}, "reasoning_effort": "none"},
                http_client=sync_client, http_async_client=async_client,
            ) if mixed or bounded else model
            for position, (case, window) in enumerate(zip(cases, windows)):
                current_position = position
                outcomes[position]["status"] = "unknown"
                with store.stage(position, "case"):
                    started = store.record(kind="case_started", payload={"window": window,
                        **({"formal_task_binding": store.formal_task_binding(position)} if bounded else {})})
                call_state: dict = {}
                formal_execution = None
                if bounded:
                    if database_url is None:
                        raise EvaluationBudgetAbort("evaluation_bounded_database_required")
                    # 记录放在runtime和HTTP边界，实际SDK对象直接交给原适配器。
                    evaluated_task = evaluate_task(
                        case, window, _RecordedExtractionRuntime(
                            extraction_runtime(extraction_selected, model, prompt_profile=extraction_prompt_profile), store, position,
                            extraction_selected, call_state, invocation_scope=invocation_scope or _plain_invocation,
                        ), database_url=database_url, task_id=formal_task_ids[position],
                        verification_runtime=_RecordedVerificationRuntime(
                            LangChainSourceVerificationRuntime(model=verification_model, provider=provider,
                                verification_mode=selected), store, position,
                            invocation_scope=invocation_scope or _plain_invocation,
                        ), provider=provider, model_name=request_model,
                    )
                    result = evaluated_task.result
                    formal_execution = _formal_execution_payload(evaluated_task, database_url)
                    with store.stage(position, "case"):
                        formal_execution = store.record(kind="formal_task_execution", payload=formal_execution)["payload"]
                        for event in evaluated_task.trace["events"]:
                            if event["stage"] == "model_response":
                                store.record(kind="adapter_output", payload=event["payload"]["raw"])
                else:
                    recorded_model = _RecordedModel(
                        model, store, position, window, call_state,
                        invocation_scope=invocation_scope,
                        verification_tool_choice=verification_tool_choice,
                        extraction_tool_choice=extraction_tool_choice,
                        extraction_mode=extraction_selected,
                    )
                    # 原adapter只消费bind_tools/invoke；评测代理不成为产品模型实现。
                    adapter_model = cast(BaseChatModel, recorded_model)
                    verification_adapter_model = cast(BaseChatModel, _RecordedModel(
                        verification_model, store, position, window, call_state,
                        invocation_scope=invocation_scope, verification_tool_choice=verification_tool_choice,
                        extraction_tool_choice=extraction_tool_choice, extraction_mode=extraction_selected,
                    )) if mixed else adapter_model
                    result = evaluate_case(
                        case, window, _RecordedExtractionRuntime(
                            extraction_runtime(extraction_selected, adapter_model, prompt_profile=extraction_prompt_profile),
                            store, position, extraction_selected, call_state,
                        ),
                        verification_runtime=_RecordedVerificationRuntime(
                            LangChainSourceVerificationRuntime(
                                model=verification_adapter_model, provider=provider,
                                verification_mode=selected,
                                prompt_profile=prompt_profile,
                            ), store, position, prompt_profile=prompt_profile,
                        ),
                    )
                with store.stage(position, "case"):
                    recorded_result = store.record(kind="case_result", payload=asdict(result))
                results.append(result)
                outcomes[position]["result"] = asdict(result)
                if result.failure_reason is not None:
                    outcomes[position]["status"] = call_state.get("failure_status", "failed")
                    raise _BatchStopped("case_contract_or_runtime_failed")
                outcomes[position]["status"] = (
                    "empty" if call_state.get("extraction_empty") else "completed"
                )
                if semantic_audit is not None:
                    current_events = tuple(event for event in store.events()
                                           if event["case_position"] == position)
                    audit_state = {"active": True, "phase": None,
                                   "verification_mode": selected.value,
                                   "extraction_mode": extraction_selected.value,
                                   "execution_plan": execution_plan}
                    persist_audit = _audit_persist_capability(store, position, audit_state)

                    bundle = {
                        "case_position": position, "case_name": case.name,
                        "window": started["payload"]["window"],
                        "original_result": recorded_result["payload"],
                        "adapter_outputs": tuple(event["payload"] for event in current_events
                                                 if event["kind"] == "adapter_output"),
                        "provider_responses": tuple(event["payload"] for event in current_events
                                                    if event["kind"] == "provider_response"),
                        "provider_requests": tuple(event["payload"] for event in current_events
                                                   if event["kind"] == "provider_request"),
                        "gold_reference": dict(gold_reference or {}),
                        "verification_mode": selected.value,
                        "verification_tool_choice": verification_tool_choice,
                        "extraction_tool_choice": extraction_tool_choice,
                        "extraction_mode": extraction_selected.value,
                        **({"extraction_prompt_profile": extraction_prompt_profile} if extraction_prompt_profile != "default" else {}),
                        **({"execution_plan": execution_plan, "phase_request_version": MIXED_REQUEST_VERSION,
                            "phase_request_policy": mixed_phase_policy()} if mixed else {}),
                        **({"reference_version": store.reference_version}
                           if store.reference_version == "source-fidelity-v2" or bounded or core else {}),
                        **({"execution_plan": execution_plan} if pro16 else {}),
                        **({"execution_plan": execution_plan, "formal_task_execution": formal_execution} if bounded else {}),
                        **({"execution_plan": execution_plan, "verification_prompt_profile": prompt_profile} if core else {}),
                        "extraction_program": tuple(
                            event["payload"] for event in current_events
                            if event["kind"] == "extraction_program"
                        ),
                        "verification_program": tuple(
                            event["payload"] for event in current_events
                            if event["kind"] == "verification_program"
                        ),
                        "persist_audit": persist_audit,
                    }
                    try:
                        audited = semantic_audit(bundle)
                    finally:
                        audit_state["active"] = False
                    with store.stage(position, "case"):
                        store.record(kind="semantic_audit", payload=audited)
                    audits.append(audited)
                    if bounded:
                        dimension_results.extend(EvaluationResult(**item) for item in audited["dimension_results"])
                    if audited["decision"] in {"safety_error", "unknown"}:
                        if pro16 and audited["decision"] == "unknown":
                            # 接收了模型结果不等于完成独审；末窗未知也不得签完整批次。
                            outcomes[position]["status"] = "unknown"
                        raise _BatchStopped("case_semantic_audit_" + audited["decision"])
                    if bounded and position < 7:
                        frames = _bounded_positive_delivery(formal_execution, position)
                        if not frames:
                            raise _BatchStopped("bounded_runtime_positive_delivery_missing")
                        delivery_frames.update(frames)
                        positive_delivered += 1
                        if position == 6 and not {"reported_request", "received_request"} <= delivery_frames:
                            raise _BatchStopped("bounded_runtime_request_frame_delivery_missing")
                elif (result.false_fact_count or result.wrong_subject_count
                        or result.error_kind in (ERROR_FALSE_FACT, ERROR_WRONG_SUBJECT)):
                    raise _BatchStopped("case_safety_error")
                current_position = None
    except _BatchStopped as error:
        stopped_code = str(error)
    except EvaluationBudgetAbort:
        stopped_code = f"{code_prefix}_hard_stop"
        if current_position is not None:
            outcomes[current_position]["status"] = "unknown"
    except Exception:
        stopped_code = f"{code_prefix}_result_unknown"
        if current_position is not None:
            outcomes[current_position]["status"] = "unknown"
    finally:
        if bounded and database_url is not None and current_position is not None:
            try:
                if not any(event["case_position"] == current_position and event["kind"] == "formal_task_execution"
                           for event in store.events()):
                    with store.stage(current_position, "case"):
                        store.record(kind="case_failed", payload=_failed_formal_task_payload(
                            database_url, windows[current_position], formal_task_ids[current_position],
                        ))
            except Exception:
                cleanup_error_codes.append("bounded_runtime_failed_task_snapshot_unavailable")
            except EvaluationBudgetAbort:
                cleanup_error_codes.append("bounded_runtime_failed_task_snapshot_unavailable")
        if sync_client is not None:
            try:
                sync_client.close()
            except Exception:
                cleanup_error_codes.append(f"{code_prefix}_sync_client_close_failed")
        if async_client is not None:
            try:
                asyncio.run(async_client.aclose())
            except Exception:
                cleanup_error_codes.append(f"{code_prefix}_async_client_close_failed")
    summary = _summary(outcomes, results)
    if bounded:
        summary["matcher_dimensions"] = summary["dimensions"]
        summary["dimensions"] = [asdict(item) for item in summarize(dimension_results)]
        summary["proof_delivery"] = {"required_positive_windows": 7, "delivered_positive_windows": positive_delivered,
                                     "frames": sorted(delivery_frames)}
    if semantic_audit is not None:
        summary["semantic_audit"] = {
            "audited": len(audits),
            **{decision: sum(item["decision"] == decision for item in audits)
               for decision in ("safe", "general_error", "safety_error", "unknown")},
            "quality_certified": False,
        }
    if e2:
        from .evaluation_reference import full_case_reference_positions
        mapping = full_case_reference_positions()
        cohorts = {}
        for name, source in (("main16", CASES), ("supplement3", SEMANTIC_CASES)):
            names = {case.name for case in source if case.dimension == "reference"}
            positions = [index for index, case in enumerate(cases) if case.name in names]
            reviews = [item for item in audits if item["case_position"] in positions]
            cohorts[name] = {
                **_summary([outcomes[index] for index in positions],
                           [result for result in results if result.name in names]),
                "case_positions": positions, "gold_positions": [mapping[index] for index in positions],
                "semantic_audit": {
                    "audited": len(reviews),
                    **{decision: sum(item["decision"] == decision for item in reviews)
                       for decision in ("safe", "general_error", "safety_error", "unknown")},
                    "quality_certified": False,
                },
            }
        summary["reference_cohorts"] = cohorts
    receipt = None
    receipt_error_code = None
    if cleanup_error_codes:
        receipt_error_code = f"{code_prefix}_completion_receipt_unavailable"
    else:
        try:
            budget.closed_receipt()
            receipt = store.finalize(
                outcomes=tuple(outcomes), budget_closed=True,
            )
        except EvaluationBudgetAbort:
            receipt_error_code = f"{code_prefix}_completion_receipt_unavailable"
    records_error_code = None
    try:
        events = store.events()
    except EvaluationBudgetAbort:
        events = ()
        records_error_code = f"{code_prefix}_records_unavailable"
        receipt = None
        receipt_error_code = f"{code_prefix}_completion_receipt_unavailable"
    if bounded:
        # 原件不可核时保留未知，不能用空事件流宣称已知错误为0。
        summary["known_raw_safety"] = _known_raw_safety(events) if records_error_code is None else None
    return {
        "synthetic_only": True, "quality_certified": False,
        "extraction_mode": extraction_selected.value,
        "summary": summary, "outcomes": tuple(outcomes), "receipt": receipt,
        "receipt_error_code": receipt_error_code, "stopped_code": stopped_code,
        "cleanup_error_codes": tuple(cleanup_error_codes),
        "records_error_code": records_error_code, "events": events,
        **({"audits": tuple(audits)} if semantic_audit is not None else {}),
    }
