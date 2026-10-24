"""物理HTTP尝试的持久预约与旧台账关联；只传作用域和用量元数据。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID, uuid4

from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.ledger.models import LedgerEntry


@dataclass(frozen=True)
class ModelCallAssociation:
    attempt_id: UUID
    permit_id: UUID
    request_id: UUID
    owner_id: UUID
    contact_id: UUID | None
    scope_kind: str
    provider: str
    model: str
    called_at: datetime
    # trace.call_id用于原观察记录对应，不用它冒充transport物理尝试编号。
    call_id: UUID

    def receipt(self) -> dict:
        return {key: str(getattr(self, key)) if getattr(self, key) is not None else None for key in (
            "attempt_id", "permit_id", "request_id", "owner_id", "contact_id"
        )} | {"scope_kind": self.scope_kind, "provider": self.provider, "model": self.model,
             "called_at": self.called_at.isoformat(), "latency_ms": None, "input_budget": None,
             "dispatch": "authorized_unconfirmed", "outcome": "pending", "usage": None,
             "cost": {"status": "unknown", "amount": None, "currency": None,
                      "pricing_version": None}}


class SharedModelCallAccounting:
    def __init__(self, control: SharedModelPriorityControl):
        self._control = control

    def reserve(self, *, request_id: UUID, owner_id: UUID, contact_id: UUID | None,
                call_id: UUID, provider: str, model: str,
                called_at: datetime, scope_kind: str = "contact") -> ModelCallAssociation:
        """每个实际HTTP request hook调用一次；内部重试也需独立预约，ACK后才派发。"""
        identity = self._control.current_call_identity
        if identity is None or not identity.get("attempt_id"):
            raise RuntimeError("后台模型调用尚未领取物理许可。")
        if called_at.tzinfo is None:
            raise ValueError("模型调用时间必须带时区。")
        if (contact_id is None and scope_kind != "owner_memory") or (contact_id is not None and scope_kind != "contact"):
            raise ValueError("模型调用范围用途不匹配。")
        association = ModelCallAssociation(uuid4(), UUID(identity["permit_id"]),
            request_id, owner_id, contact_id, scope_kind, provider, model, called_at, call_id)
        self._control.reserve_physical_call(association.receipt())
        return association

    def record_unknown(self, association: ModelCallAssociation, *, response_observed: bool = False) -> None:
        self._control.record_physical_call(association.receipt() | {
            "dispatch": "response_observed" if response_observed else "authorized_unconfirmed",
            "outcome": "unknown"})

    def record_result(self, association: ModelCallAssociation, *, outcome: str,
                      response_observed: bool, latency_ms: int | None = None,
                      usage: dict | None = None) -> None:
        """本人记忆等无旧LedgerEntry的路径直接结算完整详情，未知费用保持空。"""
        if outcome not in ("succeeded", "failed", "cancelled", "unknown"):
            raise ValueError("模型调用结果无效。")
        self._control.record_physical_call(association.receipt() | {
            "dispatch": "response_observed" if response_observed else "authorized_unconfirmed",
            "outcome": outcome if response_observed else "unknown",
            "latency_ms": latency_ms, "usage": usage})

    def link_existing(self, association: ModelCallAssociation, entry: LedgerEntry, *,
                      response_observed: bool) -> None:
        """沿原UUID关联；仅收到HTTP响应才投影确认请求，网络异常保留未知发送。"""
        if (entry.owner_id, entry.contact_id, entry.provider, entry.model_name, entry.called_at) != (
            association.owner_id, association.contact_id, association.provider,
            association.model, association.called_at):
            raise ValueError("旧台账与模型尝试身份不匹配。")
        usage = None
        if entry.input_tokens is not None and entry.output_tokens is not None:
            usage = {"input_tokens": entry.input_tokens, "output_tokens": entry.output_tokens,
                     "cache_read_tokens": None, "cache_write_tokens": None}
        outcome = entry.outcome.value
        self._control.record_physical_call(association.receipt() | {
            "ledger_entry_id": str(entry.entry_id), "legacy_outcome": outcome,
            "dispatch": "response_observed" if response_observed else "authorized_unconfirmed",
            "outcome": ("succeeded" if outcome == "succeeded" else "failed") if response_observed else "unknown",
            "latency_ms": entry.latency_ms, "usage": usage})
