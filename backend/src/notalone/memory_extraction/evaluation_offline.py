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

from notalone.memory_extraction.adapters import (
    EXTRACTION_SCHEMA,
    EXTRACTION_SYSTEM_PROMPT,
    LangChainExtractionRuntime,
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
from notalone.memory_extraction.flow import _to_fact
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES
from notalone.memory_extraction.verification_adapters import (
    SOURCE_VERIFICATION_SCHEMA,
    SOURCE_VERIFICATION_SYSTEM_PROMPT,
    LangChainSourceVerificationRuntime,
)
from notalone.memory_trace.context import current_trace

_BASE_URL = "https://evaluation.invalid/v1"
_ENDPOINT = f"{_BASE_URL}/chat/completions"
_REQUEST_MODEL = "synthetic-request-alias"


class _BatchStopped(Exception):
    """已保存的明确失败或安全结果结束后续位置。"""


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
                 purpose: str | None = None, invocation_scope: Callable | None = None):
        self._model = model
        self._store = store
        self._position = position
        self._window = window
        self._call_state = call_state
        self._purpose = purpose
        self._invocation_scope = invocation_scope

    def bind_tools(self, tools: list[dict], **options: Any) -> _RecordedModel:
        purpose = {
            EXTRACTION_SCHEMA["title"]: "extraction",
            SOURCE_VERIFICATION_SCHEMA["title"]: "verification",
        }.get(options.get("tool_choice"))
        if purpose is None or len(tools) != 1:
            raise EvaluationBudgetAbort("offline_tool_contract_changed")
        return _RecordedModel(
            self._model.bind_tools(tools, **options), self._store,
            self._position, self._window, self._call_state, purpose,
            self._invocation_scope,
        )

    def invoke(self, messages: list[dict]) -> Any:
        if self._purpose is None:
            raise EvaluationBudgetAbort("offline_unbound_model")
        scope = (self._invocation_scope(self._purpose, messages)
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
            expected = (EXTRACTION_SCHEMA if self._purpose == "extraction"
                        else SOURCE_VERIFICATION_SCHEMA)["title"]
            if (not isinstance(calls, list) or len(calls) != 1
                    or calls[0].get("name") != expected):
                raise ExtractionInvalidOutputError("离线模型未返回唯一具名工具结果。")
            if self._purpose == "extraction":
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


def _frozen_config(plan: tuple[dict, ...]) -> dict:
    return {
        "mode": "offline_mock", "synthetic_only": True,
        "base_url": _BASE_URL, "endpoint": _ENDPOINT,
        "request_model": _REQUEST_MODEL, "temperature": 0.0,
        "timeout": 60.0, "max_retries": 2,
        "thinking": {"type": "enabled"}, "stream": False,
        "plan_sha256": canonical_sha256(plan),
        "extraction_prompt_sha256": canonical_sha256(EXTRACTION_SYSTEM_PROMPT),
        "extraction_schema_sha256": canonical_sha256(EXTRACTION_SCHEMA),
        "verification_prompt_sha256": canonical_sha256(SOURCE_VERIFICATION_SYSTEM_PROMPT),
        "verification_schema_sha256": canonical_sha256(SOURCE_VERIFICATION_SCHEMA),
        "versions": {name: version(name) for name in
                     ("openai", "langchain_deepseek", "httpx")},
        "omitted_parameters": [
            "reasoning_effort", "response_format", "strict", "parallel_tool_calls",
            "max_tokens", "max_completion_tokens",
        ],
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


def run_offline_evaluation(
    *, cases: tuple[EvaluationCase, ...], output_directory: Path, run_id: UUID,
    request_limit: int, synthetic_transport: httpx.MockTransport,
) -> dict:
    """串行执行 Mock E/V、原评分与可靠退场；不接受真实端点或模型配置。"""
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
        "input_sha256": canonical_sha256(window),
    } for position, (case, window) in enumerate(zip(cases, windows)))
    config = {**_frozen_config(plan), "public_cases_sha256": canonical_sha256(cases)}
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
    )


def _run_evaluation_batch(
    *, cases: tuple[EvaluationCase, ...], windows: tuple[ExtractionWindow, ...],
    plan: tuple[dict, ...], budget: EvaluationBudget, store: EvaluationRecordStore,
    base_url: str, request_model: str, api_key: str,
    synthetic_transport: httpx.MockTransport | None, provider: str,
    contract: Any = None, invocation_scope: Callable | None = None,
    semantic_audit: Callable[[dict], dict] | None = None,
    gold_reference: dict | None = None, code_prefix: str = "offline",
    credential_loader: Callable[[], str] | None = None,
) -> dict:
    """P0/P1共用记录与收尾；真实配置与独审验证由各入口负责。"""
    outcomes = [{**item, "status": "unrun"} for item in plan]
    results: list[EvaluationResult] = []
    audits: list[dict] = []
    current_position: int | None = None
    stopped_code: str | None = None
    sync_client = None
    async_client = None
    cleanup_error_codes: list[str] = []
    try:
        from langsmith import tracing_context

        with budget.batch(), tracing_context(enabled=False, parent=False):
            if credential_loader is not None:
                try:
                    api_key = credential_loader()
                    if not isinstance(api_key, str) or not api_key.strip():
                        raise ValueError("empty_credential")
                except BaseException:
                    raise _BatchStopped("ecnu_credential_unavailable") from None
            transport_options = {"contract": contract} if contract is not None else {}
            sync_client = httpx.Client(
                transport=EvaluationTransport(
                    budget, synthetic_transport=synthetic_transport, records=store,
                    **transport_options,
                ), trust_env=False, follow_redirects=False,
            )
            async_client = httpx.AsyncClient(
                transport=EvaluationAsyncTransport(
                    budget, synthetic_transport=synthetic_transport, records=store,
                    **transport_options,
                ), trust_env=False, follow_redirects=False,
            )
            from langchain_deepseek import ChatDeepSeek
            from langchain_core.language_models import BaseChatModel
            from pydantic import SecretStr

            model = ChatDeepSeek(
                api_key=SecretStr(api_key), base_url=base_url,
                model=request_model, temperature=0.0, timeout=60.0, max_retries=2,
                extra_body={"thinking": {"type": "enabled"}},
                http_client=sync_client, http_async_client=async_client,
            )
            for position, (case, window) in enumerate(zip(cases, windows)):
                current_position = position
                outcomes[position]["status"] = "unknown"
                with store.stage(position, "case"):
                    started = store.record(kind="case_started", payload={"window": window})
                call_state: dict = {}
                recorded_model = _RecordedModel(
                    model, store, position, window, call_state,
                    invocation_scope=invocation_scope,
                )
                # 原adapter只消费bind_tools/invoke；评测代理不成为产品模型实现。
                adapter_model = cast(BaseChatModel, recorded_model)
                result = evaluate_case(
                    case, window, LangChainExtractionRuntime(model=adapter_model),
                    verification_runtime=LangChainSourceVerificationRuntime(
                        model=adapter_model, provider=provider,
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
                    audited = semantic_audit({
                        "case_position": position, "case_name": case.name,
                        "window": started["payload"]["window"],
                        "original_result": recorded_result["payload"],
                        "adapter_outputs": tuple(event["payload"] for event in current_events
                                                 if event["kind"] == "adapter_output"),
                        "provider_responses": tuple(event["payload"] for event in current_events
                                                    if event["kind"] == "provider_response"),
                        "gold_reference": dict(gold_reference or {}),
                    })
                    with store.stage(position, "case"):
                        store.record(kind="semantic_audit", payload=audited)
                    audits.append(audited)
                    if audited["decision"] in {"safety_error", "unknown"}:
                        raise _BatchStopped("case_semantic_audit_" + audited["decision"])
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
    if semantic_audit is not None:
        summary["semantic_audit"] = {
            "audited": len(audits),
            **{decision: sum(item["decision"] == decision for item in audits)
               for decision in ("safe", "general_error", "safety_error", "unknown")},
            "quality_certified": False,
        }
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
    return {
        "synthetic_only": True, "quality_certified": False,
        "summary": summary, "outcomes": tuple(outcomes), "receipt": receipt,
        "receipt_error_code": receipt_error_code, "stopped_code": stopped_code,
        "cleanup_error_codes": tuple(cleanup_error_codes),
        "records_error_code": records_error_code, "events": events,
        **({"audits": tuple(audits)} if semantic_audit is not None else {}),
    }
