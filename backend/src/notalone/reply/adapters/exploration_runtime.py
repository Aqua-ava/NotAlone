"""单次模型探索：只读静态输入，只允许结构化输出，没有业务 Tool 循环。"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from contextlib import nullcontext
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain.agents.middleware.types import ModelRequest

from notalone.reply.adapters.async_runner import run_with_timeout
from notalone.reply.adapters.input_budget_middleware import InputBudgetMiddleware
from notalone.reply.exploration import ExplorationContext, ExplorationError, ExplorationPriority, validate_exploration_output
from notalone.reply.input_budget import (
    InputBudgetDecision, InputBudgetExceededError, InputBudgetProfile,
    InputBudgetUnavailableError, InputTokenCounter,
)
from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort


EXPLORATION_PROMPT = """为已确认联系人解释当前消息或探索主动联系目的，不生成候选回复。
一句理解须列明真实依据和歧义，不确定深层动机、心理或关系结果。correction 是用户纠正，
requirements/confirmed_intent 优先；纠正不替换已明确意愿，回答不等于确认意愿。
提供2至4个不同意愿，不用同立场语气变体；允许拒绝、接受、保留、暂不回应等合理立场。
previous_intents 用于换组，应提供新的不同方向，不能凭历史排除合理立场。
recommended 不代表选定；没有真实依据不能推荐，无依据的方向只说明适用条件。
普通时间地点缺失先给不虚构细节的方向；仅未知项改变立场、形成承诺或有实质歧义时
返回一个question，impact只能stance/commitment/ambiguity。用户回答后若已明确意愿可继续，
仍不明确则继续探索。current_step说明复杂目的这次推进的一步，tradeoffs说明目的与说法
冲突，保留用户目标，不保证对方反应。skill只辅助当前场景，不确定用户意愿。
禁止外部查询、脚本、业务Tool、发送、提醒、风格样本或长期记忆写入。
仅调用ExplorationOutput返回understanding、ambiguities、citation_ids、options、question、
current_step、tradeoffs；每个options含intent、label、reason、citation_ids、recommended、pause。
引用必须原样使用当前evidence_id；question不需要时null，文本/列表均短小。
"""

OUTPUT_TOOL = {
    "name": "ExplorationOutput", "description": "输出理解与未确认意愿的方向或关键问题。",
    "parameters": {
        "type": "object", "properties": {
            "understanding": {"type": "string"}, "ambiguities": {"type": "array", "items": {"type": "string"}},
            "citation_ids": {"type": "array", "items": {"type": "string"}},
            "options": {"type": "array", "maxItems": 4, "items": {
                "type": "object", "properties": {
                    "intent": {"type": "string"}, "label": {"type": "string"}, "reason": {"type": "string"},
                    "citation_ids": {"type": "array", "items": {"type": "string"}},
                    "recommended": {"type": "boolean"}, "pause": {"type": "boolean"},
                }, "required": ["intent", "label", "reason", "citation_ids", "recommended", "pause"], "additionalProperties": False,
            }},
            "question": {"anyOf": [{"type": "null"}, {"type": "object", "properties": {
                "text": {"type": "string"}, "impact": {"type": "string", "enum": ["stance", "commitment", "ambiguity"]},
            }, "required": ["text", "impact"], "additionalProperties": False}]},
            "current_step": {"type": "string"}, "tradeoffs": {"type": "array", "items": {"type": "string"}},
        }, "required": ["understanding", "ambiguities", "citation_ids", "options", "question", "current_step", "tradeoffs"], "additionalProperties": False,
    },
}


class LangChainExplorationRuntime:
    def __init__(self, *, model: BaseChatModel, ledger: OutboundLedgerPort,
                 timeout_seconds: float = 8, priority: ExplorationPriority | None = None,
                 input_budget_profile: InputBudgetProfile | None = None,
                 input_token_counter: InputTokenCounter | None = None,
                 on_input_budget: Callable[[InputBudgetDecision], None] | None = None) -> None:
        if not 0 < timeout_seconds <= 20:
            raise ValueError("探索超时预算无效。")
        if ledger is None:
            raise ValueError("探索必须提供出站台账。")
        self._model = model
        self._timeout = timeout_seconds
        self._priority, self._ledger = priority, ledger
        if input_budget_profile is not None and not isinstance(input_budget_profile, InputBudgetProfile):
            raise TypeError("探索预算能力必须显式提供已核实的profile。")
        name = getattr(model, "model_name", None)
        profile = input_budget_profile or InputBudgetProfile(
            model_id=name if isinstance(name, str) and name.strip() else "unidentified_model",
            context_window_tokens=None, output_reserve_tokens=None, warning_ratio=0.8,
            measurement_kind=None, measurement_id=None,
        )
        self._budget = InputBudgetMiddleware(profile=profile, counter=input_token_counter,
                                             on_decision=on_input_budget)

    def explore(self, context: ExplorationContext) -> dict[str, Any]:
        payload = {"input_mode": "direction_exploration", "scene": context.input.scene, **context.input.payload(),
                   "purpose_hint": context.input.purpose_hint,
                   "evidence": list(context.evidence), "skill": context.skill,
                   "previous_intents": list(context.previous_intents)}
        request = ModelRequest(model=self._model, system_message=SystemMessage(EXPLORATION_PROMPT),
                               messages=[HumanMessage(json.dumps(payload, ensure_ascii=False))],
                               tools=[OUTPUT_TOOL], tool_choice="ExplorationOutput")
        called_at, started = datetime.now(timezone.utc), time.perf_counter()
        outcome = LedgerOutcome.RUN_FAILED
        called = False
        try:
            with self._priority.foreground() if self._priority else nullcontext():
                request = self._budget.require_request(request)
                model = request.model.bind_tools(request.tools, tool_choice=request.tool_choice,
                                                 **request.model_settings)
                called = True
                result = run_with_timeout(model.ainvoke([request.system_message, *request.messages]),
                                          seconds=self._timeout)
                if self._priority:
                    self._priority.check_running()
            outcome = LedgerOutcome.REJECTED_BY_VALIDATION
            if len(result.tool_calls) != 1 or result.tool_calls[0]["name"] != "ExplorationOutput":
                raise ExplorationError("探索结果没有有效的结构化输出。")
            validated = validate_exploration_output(result.tool_calls[0]["args"], context)
            outcome = LedgerOutcome.SUCCEEDED
            return validated
        except TimeoutError:
            raise ExplorationError("探索超时，请手动重试。") from None
        except (InputBudgetExceededError, InputBudgetUnavailableError):
            raise
        except Exception:
            raise ExplorationError("探索失败，请手动重试。") from None
        finally:
            if called:
                self._ledger.record(LedgerEntry(
                    entry_id=uuid4(), owner_id=context.scope.owner_id, contact_id=context.scope.contact_id,
                    provider="deepseek", model_name=getattr(self._model, "model_name", None) or "unreported",
                    input_tokens=None, output_tokens=None, latency_ms=int((time.perf_counter()-started)*1000),
                    outcome=outcome, called_at=called_at,
                ))
