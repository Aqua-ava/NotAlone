"""可信成功预算回执的纯 codec；不计量、不读模型输出、不保存正文。"""

from __future__ import annotations

from collections.abc import Mapping

from notalone.reply.input_budget import (
    BudgetState,
    InputBudgetDecision,
    TokenMeasurementKind,
)


_FIELDS = frozenset({
    "state", "allowed", "model_id", "context_window_tokens", "input_tokens",
    "output_reserve_tokens", "total_tokens", "measurement_kind", "measurement_id",
    "reason",
})


def decode_input_budget_receipt(payload: object) -> InputBudgetDecision:
    """重读已保存的成功回执；不使用当前 profile 重算历史提醒状态。"""

    try:
        if not isinstance(payload, Mapping) or set(payload) not in (
            _FIELDS, _FIELDS | {"safety_margin_tokens"},
        ):
            raise ValueError
        if payload["allowed"] is not True or payload["reason"] is not None:
            raise ValueError
        for key in ("state", "model_id", "measurement_kind", "measurement_id"):
            value = payload[key]
            if type(value) is not str or not value.strip():
                raise ValueError
        state = BudgetState(payload["state"])
        kind = TokenMeasurementKind(payload["measurement_kind"])
        if state not in (BudgetState.READY, BudgetState.WARNING):
            raise ValueError
        for key in (
            "context_window_tokens", "input_tokens", "output_reserve_tokens",
            "total_tokens",
        ):
            if type(payload[key]) is not int:
                raise ValueError
        capacity = payload["context_window_tokens"]
        measured = payload["input_tokens"]
        reserve = payload["output_reserve_tokens"]
        total = payload["total_tokens"]
        margin = payload.get("safety_margin_tokens", 0)
        if type(margin) is not int or margin < 0:
            raise ValueError
        if kind is TokenMeasurementKind.APPROXIMATE and margin == 0:
            raise ValueError
        if (
            capacity <= 0 or measured < 0 or not 0 < reserve < capacity
            or reserve + margin >= capacity
            or total != measured + reserve + margin or total > capacity
        ):
            raise ValueError
        return InputBudgetDecision(
            state=state, model_id=payload["model_id"],
            context_window_tokens=capacity, input_tokens=measured,
            output_reserve_tokens=reserve, total_tokens=total,
            measurement_kind=kind, measurement_id=payload["measurement_id"],
            safety_margin_tokens=margin,
        )
    except Exception:
        raise ValueError("输入预算回执结构无效。") from None


def validate_input_budget_receipt(
    value: InputBudgetDecision | None,
) -> InputBudgetDecision | None:
    """内部结果只接受不可变守卫值；None 仅兼容尚无回执的旧结果。"""

    if value is None:
        return None
    try:
        if type(value) is not InputBudgetDecision:
            raise ValueError
        if type(value.safety_margin_tokens) is not int or value.safety_margin_tokens < 0:
            raise ValueError
        return decode_input_budget_receipt(value.to_payload())
    except Exception:
        raise ValueError("输入预算回执结构无效。") from None


def input_budget_receipt_payload(
    value: InputBudgetDecision | None,
) -> dict[str, object] | None:
    """序列化严格纯元数据；缺少旧回执时由调用方省略字段。"""

    receipt = validate_input_budget_receipt(value)
    return receipt.to_payload() if receipt is not None else None
