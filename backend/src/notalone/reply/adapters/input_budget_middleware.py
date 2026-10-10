"""LangChain 最内层模型预算检查；正文仅在本轮内存中编码和计量。"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Awaitable, Callable, Mapping

from langchain.agents.middleware import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
    TracePolicy,
    omit_payload,
)
from langchain.agents.structured_output import (
    OutputToolBinding,
    ProviderStrategy,
    ToolStrategy,
)
from langchain_core.messages import convert_to_openai_messages
from langchain_core.utils.function_calling import convert_to_openai_tool
from langchain_openai.chat_models.base import BaseChatOpenAI

from notalone.reply.input_budget import (
    BudgetState,
    InputBudgetDecision,
    InputBudgetExceededError,
    InputBudgetGuard,
    InputBudgetProfile,
    InputBudgetRequest,
    InputBudgetUnavailableError,
    ModelBoundInputTokenCounter,
)


def _output_tool_schemas(strategy: ToolStrategy[Any]) -> dict[str, dict[str, Any]]:
    """按已锁定版本的结构化输出工具构造规则保存完整 schema。"""

    return {
        spec.name: deepcopy(
            convert_to_openai_tool(OutputToolBinding.from_schema_spec(spec).tool)
        )
        for spec in strategy.schema_specs
    }


class InputBudgetMiddleware(AgentMiddleware):
    """每次实际模型 handler 前复用同一守卫，须放在中间件列表最后。

    与 create_agent 传入同一份显式 response_format。LangChain 1.3.15 的
    factory 在 handler 内按最初注册的 schema 追加输出工具；本适配器计入
    那份注册快照，不只统计 request.tools。版本变更后须重新核对并验证。
    计量器仍须核实实际配置模型的完整协议 framing；这里不提供供应商估算。
    """

    trace_policy = TracePolicy(
        process_inputs=omit_payload,
        process_outputs=omit_payload,
    )

    def __init__(
        self,
        *,
        profile: InputBudgetProfile,
        counter: ModelBoundInputTokenCounter | None,
        response_format: ToolStrategy[Any] | ProviderStrategy[Any] | None = None,
        on_decision: Callable[[InputBudgetDecision], None] | None = None,
    ) -> None:
        super().__init__()
        self._profile = profile
        self._counter = counter
        self._guard = InputBudgetGuard(profile=profile, counter=counter)
        self._output_tools = (
            _output_tool_schemas(response_format)
            if isinstance(response_format, ToolStrategy)
            else {}
        )
        self._output_bindings = (
            {
                spec.name: OutputToolBinding.from_schema_spec(spec).tool
                for spec in response_format.schema_specs
            }
            if isinstance(response_format, ToolStrategy)
            else {}
        )
        self._on_decision = on_decision

    def require_request(self, request: ModelRequest) -> ModelRequest:
        """绑定输出上限并检查完整请求；供 Agent 与单次模型适配器共用。"""

        try:
            if self._counter is not None and self._counter.is_bound_to(
                request.model
            ) is not True:
                raise ValueError("计量器未绑定实际配置模型。")
            self._validate_output_overrides(request)
            settings = dict(request.model_settings)
            if self._profile.output_reserve_tokens is not None:
                settings["max_tokens"] = self._profile.output_reserve_tokens
            bound = request.override(model_settings=settings)
            budget_request = self._encode(bound)
        except Exception:
            decision = self._unavailable("unmeasurable_model_request")
            if self._on_decision is not None:
                self._on_decision(decision)
            raise InputBudgetUnavailableError(decision) from None
        try:
            decision = self._guard.require(budget_request)
        except (InputBudgetExceededError, InputBudgetUnavailableError) as error:
            if self._on_decision is not None:
                self._on_decision(error.decision)
            raise
        if self._on_decision is not None:
            self._on_decision(decision)
        return bound

    def _validate_output_overrides(self, request: ModelRequest) -> None:
        """SDK 附加正文或输出别名不得覆盖已计量输入与实际输出预留。"""

        output_keys = {"max_tokens", "max_completion_tokens", "max_output_tokens"}
        input_keys = {"model", "messages", "tools", "response_format", "system", "input"}
        if (input_keys - {"response_format"}) & request.model_settings.keys():
            raise ValueError("模型参数覆盖了完整计量输入或模型路由。")
        nested = (
            getattr(request.model, "model_kwargs", None),
            getattr(request.model, "extra_body", None),
            request.model_settings.get("extra_body"),
        )
        visited: set[int] = set()

        def validate_options(options: object) -> None:
            if options is None:
                return
            if not isinstance(options, Mapping):
                raise ValueError("模型附加参数无法核实。")
            if id(options) in visited:
                raise ValueError("模型附加参数不能含循环或重复嵌套。")
            visited.add(id(options))
            if input_keys & options.keys():
                raise ValueError("模型附加参数覆盖了完整计量输入。")
            for key in output_keys & options.keys():
                value = options[key]
                if (
                    not isinstance(value, int)
                    or isinstance(value, bool)
                    or value != self._profile.output_reserve_tokens
                ):
                    raise ValueError("模型附加参数覆盖了实际输出预留。")
            validate_options(options.get("extra_body"))
            visited.remove(id(options))

        for options in nested:
            validate_options(options)
        for key in (output_keys - {"max_tokens"}) & request.model_settings.keys():
            value = request.model_settings[key]
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or value != self._profile.output_reserve_tokens
            ):
                raise ValueError("输出参数别名与实际预留不一致。")

    def _encode(self, request: ModelRequest) -> InputBudgetRequest:
        model_id = getattr(request.model, "model_name", "")
        final_tools = list(request.tools)
        settings = deepcopy(request.model_settings)
        response_schema = settings.pop("response_format", None)
        if isinstance(request.response_format, ToolStrategy):
            current = _output_tool_schemas(request.response_format)
            for name, schema in current.items():
                if self._output_tools.get(name) != schema:
                    raise ValueError("输出工具 schema 未通过最初注册快照验证。")
            final_tools.extend(
                binding for name, binding in self._output_bindings.items()
                if name in current
            )
            settings["tool_choice"] = "any"
        elif isinstance(request.response_format, ProviderStrategy):
            native = request.response_format.to_model_kwargs()["response_format"]
            response_schema = request.model_settings.get("response_format", native)
            settings["tool_choice"] = None
            # 1.3.15 factory 对 BaseChatOpenAI 兼容模型在此模式强制 strict；
            # bind_tools 会据此转换每个工具 schema，不能只计原始参数结构。
            if isinstance(request.model, BaseChatOpenAI) and not getattr(
                request.model, "use_responses_api", False
            ):
                settings["strict"] = True
        elif request.response_format is not None:
            raise ValueError("模型输出策略的最终协议尚未核实。")
        elif final_tools:
            settings["tool_choice"] = request.tool_choice
        if isinstance(request.model, BaseChatOpenAI):
            return self._encode_sdk(request, final_tools)
        source_messages = [*request.messages]
        if request.system_message is not None:
            source_messages.insert(0, request.system_message)
        if any(
            getattr(message, "additional_kwargs", None)
            or getattr(message, "invalid_tool_calls", None)
            for message in source_messages
        ):
            raise ValueError("通用消息转换无法核实这些扩展字段的完整出站表示。")
        messages = convert_to_openai_messages(request.messages)
        system_message = (
            convert_to_openai_messages(request.system_message)
            if request.system_message is not None
            else None
        )
        tools = [convert_to_openai_tool(item) for item in final_tools]
        return InputBudgetRequest(
            model_id=model_id,
            system_message=system_message,
            messages=tuple(messages),
            tool_schemas=tuple(tools),
            response_schema=response_schema,
            model_settings=settings,
            output_token_limit=request.model_settings.get("max_tokens"),
        )

    def _encode_sdk(
        self, request: ModelRequest, final_tools: list[Any],
    ) -> InputBudgetRequest:
        """按已核实 SDK 构造完整 Chat Completions 请求，不调用模型。

        官方源码与本地 langchain 1.3.15、core 1.5.5、openai 1.5.1、
        deepseek 1.1.0 已核对：factory 绑定工具后以原 BaseMessage 序列调用。
        通用消息 converter 会丢 invalid_tool_calls 并合并 system list，
        故复用实际模型的 SDK 序列化；该私有接口升级后须重新核对和验证。
        SDK transport 的 extra_body 合并与 Responses API 尚未核实，明确拒绝。
        token 与传输 framing 仍由绑定实际对象的已核实计量器负责。
        """

        if isinstance(request.response_format, ProviderStrategy):
            settings = {
                **request.response_format.to_model_kwargs(),
                **request.model_settings,
            }
            if not getattr(request.model, "use_responses_api", False):
                settings["strict"] = True
            bound_model = request.model.bind_tools(final_tools, **settings)
        elif isinstance(request.response_format, ToolStrategy):
            if not self._output_bindings:
                raise ValueError("空输出策略的绑定协议尚未核实。")
            bound_model = request.model.bind_tools(
                final_tools, tool_choice="any", **request.model_settings,
            )
        elif final_tools:
            bound_model = request.model.bind_tools(
                final_tools, tool_choice=request.tool_choice, **request.model_settings,
            )
        else:
            bound_model = request.model.bind(**request.model_settings)
        messages = list(request.messages)
        if request.system_message is not None:
            messages.insert(0, request.system_message)
        payload = request.model._get_request_payload(messages, **bound_model.kwargs)
        if not isinstance(payload, Mapping) or payload.get("extra_body"):
            raise ValueError("模型传输正文的最终合并协议尚未核实。")
        encoded = payload.get("messages")
        if (
            not isinstance(encoded, list)
            or len(encoded) != len(messages)
            or any(not isinstance(item, Mapping) for item in encoded)
            or payload.get("model") != request.model.model_name
        ):
            raise ValueError("完整模型输入或最终路由无法核实。")
        output_keys = {"max_tokens", "max_completion_tokens", "max_output_tokens"}
        limits = [payload[key] for key in output_keys if key in payload]
        if not limits or any(
            not isinstance(limit, int) or isinstance(limit, bool)
            or limit != self._profile.output_reserve_tokens
            for limit in limits
        ):
            raise ValueError("模型最终输出上限与实际预留不一致。")
        system_message = encoded[0] if request.system_message is not None else None
        return InputBudgetRequest(
            model_id=payload["model"],
            system_message=deepcopy(system_message),
            messages=tuple(deepcopy(
                encoded[1:] if system_message is not None else encoded,
            )),
            tool_schemas=tuple(deepcopy(payload.get("tools", []))),
            response_schema=deepcopy(payload.get("response_format")),
            model_settings=deepcopy({
                key: value for key, value in payload.items()
                if key not in {"model", "messages", "tools", "response_format"}
            }),
            output_token_limit=limits[0],
        )

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        return await handler(self.require_request(request))

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return handler(self.require_request(request))

    def _unavailable(self, reason: str) -> InputBudgetDecision:
        return InputBudgetDecision(
            state=BudgetState.UNAVAILABLE,
            model_id=self._profile.model_id,
            context_window_tokens=self._profile.context_window_tokens,
            input_tokens=None,
            output_reserve_tokens=self._profile.output_reserve_tokens,
            total_tokens=None,
            measurement_kind=self._profile.measurement_kind,
            measurement_id=self._profile.measurement_id,
            reason=reason,
        )
