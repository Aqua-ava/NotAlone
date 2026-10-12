"""完整模型请求的纯预算守卫；不裁剪正文、不调用模型、不持久化。"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import StrEnum
from fractions import Fraction
from typing import Mapping, Protocol

from notalone.reply.errors import ReplyBudgetError


class TokenMeasurementKind(StrEnum):
    """明确区分精确计量、已核实上界与带安全余量的输入估算。"""

    EXACT = "exact"
    VERIFIED_UPPER_BOUND = "verified_upper_bound"
    APPROXIMATE = "approximate"


class InputComponent(StrEnum):
    """计量器必须覆盖的完整出站组成。"""

    SYSTEM = "system"
    MESSAGES = "messages"
    TOOLS = "tools"
    RESPONSE_SCHEMA = "response_schema"
    MODEL_SETTINGS = "model_settings"
    PROVIDER_FRAMING = "provider_framing"


class BudgetState(StrEnum):
    """公开预算状态；不可核实与明确超限分别呈现。"""

    READY = "ready"
    WARNING = "warning"
    EXCEEDED = "exceeded"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class InputBudgetProfile:
    """某一配置模型已核实的能力；未知项保留为空，不能使用猜测值。"""

    model_id: str
    context_window_tokens: int | None
    output_reserve_tokens: int | None
    warning_ratio: float
    measurement_kind: TokenMeasurementKind | None
    measurement_id: str | None
    safety_margin_tokens: int = 0

    def __post_init__(self) -> None:
        if not isinstance(self.model_id, str) or not self.model_id.strip():
            raise ValueError("预算配置的模型标识不能为空。")
        for value in (self.context_window_tokens, self.output_reserve_tokens):
            if value is not None and (
                not isinstance(value, int)
                or isinstance(value, bool)
                or value <= 0
            ):
                raise ValueError("模型能力与输出预留必须是正整数或未知。")
        if (
            self.context_window_tokens is not None
            and self.output_reserve_tokens is not None
            and self.output_reserve_tokens >= self.context_window_tokens
        ):
            raise ValueError("输出预留必须小于模型上下文能力。")
        if (
            not isinstance(self.warning_ratio, (int, float))
            or isinstance(self.warning_ratio, bool)
            or not 0 < self.warning_ratio < 1
            or not math.isfinite(self.warning_ratio)
        ):
            raise ValueError("预算提醒比例必须是 0 到 1 之间的有限数。")
        if self.measurement_kind is not None and not isinstance(
            self.measurement_kind, TokenMeasurementKind
        ):
            raise ValueError("预算计量方式尚未核实。")
        if self.measurement_id is not None and (
            not isinstance(self.measurement_id, str)
            or not self.measurement_id.strip()
        ):
            raise ValueError("预算计量配置标识不能为空。")
        if type(self.safety_margin_tokens) is not int or self.safety_margin_tokens < 0:
            raise ValueError("输入预算安全余量必须是非负整数。")
        if (
            self.measurement_kind is TokenMeasurementKind.APPROXIMATE
            and self.safety_margin_tokens == 0
        ):
            raise ValueError("输入估算必须明确配置正数安全余量。")
        if (
            self.context_window_tokens is not None
            and self.output_reserve_tokens is not None
            and self.output_reserve_tokens + self.safety_margin_tokens >= self.context_window_tokens
        ):
            raise ValueError("输出预留与安全余量之和必须小于模型上下文能力。")


@dataclass(frozen=True, slots=True, repr=False)
class InputBudgetRequest:
    """最终调用的完整输入；讨论、检索与 Skill 均包含在完整消息中。

    适配器应在动态系统指令、工具和输出 schema 已加入后构造本对象。
    model_settings 是最终生效设置，output_token_limit 是实际绑定的输出上限。
    本对象仅在调用前的内存中传递，不是可写入台账的预算元数据。
    """

    model_id: str
    system_message: Mapping[str, object] | None
    messages: tuple[Mapping[str, object], ...]
    tool_schemas: tuple[Mapping[str, object], ...]
    response_schema: Mapping[str, object] | None
    model_settings: Mapping[str, object]
    output_token_limit: int | None


@dataclass(frozen=True, slots=True)
class InputTokenMeasurement:
    """完整请求的计量或估算结论，必须关联同一模型与明确计量配置。"""

    model_id: str
    input_tokens: int
    kind: TokenMeasurementKind
    measurement_id: str
    covered_components: frozenset[InputComponent]


class InputTokenCounter(Protocol):
    """供应商边界负责完整协议计量，不得只统计请求正文。"""

    def measure(self, request: InputBudgetRequest) -> InputTokenMeasurement: ...


class ModelBoundInputTokenCounter(InputTokenCounter, Protocol):
    """SDK 适配器的计量器必须核实实际模型实例及其当前有效配置。

    同名模型不能替代该绑定；measure 还须读取本轮有效默认参数与完整 framing。
    纯预算守卫只消费编码请求，模型对象绑定由调用边界检查。
    """

    def is_bound_to(self, model: object) -> bool: ...


@dataclass(frozen=True, slots=True)
class InputBudgetDecision:
    """只含模型能力、计量和状态的公开预算元数据。"""

    state: BudgetState
    model_id: str
    context_window_tokens: int | None
    input_tokens: int | None
    output_reserve_tokens: int | None
    total_tokens: int | None
    measurement_kind: TokenMeasurementKind | None
    measurement_id: str | None
    reason: str | None = None
    safety_margin_tokens: int = 0

    @property
    def allowed(self) -> bool:
        return self.state in (BudgetState.READY, BudgetState.WARNING)

    def to_payload(self) -> dict[str, object]:
        """供公开响应使用的纯元数据；不能包含计量请求或正文。"""

        payload: dict[str, object] = {
            "state": self.state.value,
            "allowed": self.allowed,
            "model_id": self.model_id,
            "context_window_tokens": self.context_window_tokens,
            "input_tokens": self.input_tokens,
            "output_reserve_tokens": self.output_reserve_tokens,
            "total_tokens": self.total_tokens,
            "measurement_kind": (
                self.measurement_kind.value
                if self.measurement_kind is not None
                else None
            ),
            "measurement_id": self.measurement_id,
            "reason": self.reason,
        }
        if self.safety_margin_tokens > 0:
            payload["safety_margin_tokens"] = self.safety_margin_tokens
        return payload


class InputBudgetExceededError(ReplyBudgetError):
    """输入与实际输出预留合计超出模型能力，未允许本轮调用。"""

    def __init__(self, decision: InputBudgetDecision) -> None:
        self.decision = decision
        super().__init__("当前讨论超出模型输入预算，请新开助手会话。")


class InputBudgetUnavailableError(ReplyBudgetError):
    """配置模型的能力或完整计量不可核实，未允许本轮调用。"""

    def __init__(self, decision: InputBudgetDecision) -> None:
        self.decision = decision
        super().__init__("当前模型的完整输入计量配置不可用，暂不能生成。")


class InputBudgetGuard:
    """所有调用入口复用的总预算判定；每轮均重新接收完整请求。"""

    __slots__ = ("_profile", "_counter")

    def __init__(
        self,
        *,
        profile: InputBudgetProfile,
        counter: InputTokenCounter | None,
    ) -> None:
        if not isinstance(profile, InputBudgetProfile):
            raise TypeError("输入预算守卫必须显式指定模型能力配置。")
        self._profile = profile
        self._counter = counter

    def assess(self, request: InputBudgetRequest) -> InputBudgetDecision:
        if (
            not isinstance(request, InputBudgetRequest)
            or (
                request.system_message is not None
                and not isinstance(request.system_message, Mapping)
            )
            or not isinstance(request.messages, tuple)
            or any(not isinstance(message, Mapping) for message in request.messages)
            or not isinstance(request.tool_schemas, tuple)
            or any(not isinstance(tool, Mapping) for tool in request.tool_schemas)
            or (
                request.response_schema is not None
                and not isinstance(request.response_schema, Mapping)
            )
            or not isinstance(request.model_settings, Mapping)
        ):
            return self._unavailable("invalid_request")
        if request.model_id != self._profile.model_id:
            return self._unavailable("model_mismatch")
        if (
            self._profile.context_window_tokens is None
            or self._profile.output_reserve_tokens is None
            or self._profile.measurement_kind is None
            or self._profile.measurement_id is None
        ):
            return self._unavailable("model_capability_unknown")
        if (
            not isinstance(request.output_token_limit, int)
            or isinstance(request.output_token_limit, bool)
            or request.output_token_limit != self._profile.output_reserve_tokens
        ):
            return self._unavailable("output_reserve_mismatch")
        if self._counter is None:
            return self._unavailable("counter_unavailable")
        try:
            measurement = self._counter.measure(request)
        except Exception:
            return self._unavailable("measurement_failed")
        if (
            not isinstance(measurement, InputTokenMeasurement)
            or not isinstance(measurement.input_tokens, int)
            or isinstance(measurement.input_tokens, bool)
            or measurement.input_tokens < 0
            or measurement.model_id != self._profile.model_id
            or not isinstance(measurement.kind, TokenMeasurementKind)
            or measurement.kind is not self._profile.measurement_kind
            or measurement.measurement_id != self._profile.measurement_id
            or not isinstance(measurement.covered_components, frozenset)
            or any(
                not isinstance(component, InputComponent)
                for component in measurement.covered_components
            )
        ):
            return self._unavailable("invalid_measurement")
        if not frozenset(InputComponent) <= measurement.covered_components:
            return self._unavailable("incomplete_measurement")
        total = (
            measurement.input_tokens + self._profile.output_reserve_tokens
            + self._profile.safety_margin_tokens
        )
        warning_ratio = Fraction(str(self._profile.warning_ratio))
        warning_threshold = (
            self._profile.context_window_tokens * warning_ratio.numerator
            + warning_ratio.denominator - 1
        ) // warning_ratio.denominator
        if total > self._profile.context_window_tokens:
            state = BudgetState.EXCEEDED
        elif total >= warning_threshold:
            state = BudgetState.WARNING
        else:
            state = BudgetState.READY
        return InputBudgetDecision(
            state=state,
            model_id=self._profile.model_id,
            context_window_tokens=self._profile.context_window_tokens,
            input_tokens=measurement.input_tokens,
            output_reserve_tokens=self._profile.output_reserve_tokens,
            total_tokens=total,
            measurement_kind=measurement.kind,
            measurement_id=measurement.measurement_id,
            reason="context_window_exceeded" if state is BudgetState.EXCEEDED else None,
            safety_margin_tokens=self._profile.safety_margin_tokens,
        )

    def require(self, request: InputBudgetRequest) -> InputBudgetDecision:
        """紧邻实际模型调用使用；拒绝时只抛出不含正文的预算错误。"""

        decision = self.assess(request)
        if decision.state is BudgetState.EXCEEDED:
            raise InputBudgetExceededError(decision)
        if not decision.allowed:
            raise InputBudgetUnavailableError(decision)
        return decision

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
            safety_margin_tokens=self._profile.safety_margin_tokens,
        )
