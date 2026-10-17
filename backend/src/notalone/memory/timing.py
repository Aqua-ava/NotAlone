"""来源消息时间与保存时间；不替代事实有效期或事件发生时间。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime


CURRENT_STATUSES = frozenset({
    "current_verified", "current_unverified", "historical", "stable",
})
UNKNOWN_CURRENT_REASON = "当前未核实；原话和保存时间不能证明状态现在仍成立。"


def _aware_time(value: datetime | None) -> None:
    if value is not None and (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise ValueError("记忆时间必须是带时区的 datetime。")


@dataclass(frozen=True, slots=True)
class MemoryTiming:
    """可核实的聊天来源范围及独立的记忆保存时间。"""

    recorded_at: datetime | None = None
    source_started_at: datetime | None = None
    source_ended_at: datetime | None = None
    source_time_complete: bool = False
    current_status: str = "current_unverified"
    current_status_reason: str = UNKNOWN_CURRENT_REASON

    def __post_init__(self) -> None:
        for value in (
            self.recorded_at, self.source_started_at, self.source_ended_at,
        ):
            _aware_time(value)
        if type(self.source_time_complete) is not bool:
            raise ValueError("来源时间完整标记必须是 bool。")
        if (self.source_started_at is None) != (self.source_ended_at is None):
            raise ValueError("来源时间起止必须同时提供。")
        if (
            self.source_started_at is not None
            and self.source_ended_at is not None
            and self.source_ended_at < self.source_started_at
        ):
            raise ValueError("来源时间结束不能早于开始。")
        if self.source_time_complete and self.source_started_at is None:
            raise ValueError("完整来源时间必须有可核实范围。")
        if self.current_status not in CURRENT_STATUSES:
            raise ValueError("记忆当前核实状态无效。")
        if (not isinstance(self.current_status_reason, str)
                or not self.current_status_reason.strip()):
            raise ValueError("记忆当前核实依据不能为空。")

    def to_payload(self) -> dict[str, object]:
        """返回不含来源正文的 JSON 时间元数据。"""
        return {
            "recorded_at": (
                self.recorded_at.isoformat() if self.recorded_at else None
            ),
            "source_started_at": (
                self.source_started_at.isoformat()
                if self.source_started_at else None
            ),
            "source_ended_at": (
                self.source_ended_at.isoformat() if self.source_ended_at else None
            ),
            "source_time_complete": self.source_time_complete,
            "current_status": self.current_status,
            "current_status_reason": self.current_status_reason,
        }

    @classmethod
    def from_payload(cls, payload: object | None) -> MemoryTiming:
        """旧快照缺失时间时返回未知；显式非法时间结构必须报错。"""
        if payload is None:
            return cls()
        fields = {
            "recorded_at", "source_started_at", "source_ended_at",
            "source_time_complete",
        }
        extended = fields | {"current_status", "current_status_reason"}
        if not isinstance(payload, dict) or set(payload) not in (fields, extended):
            raise ValueError("记忆时间元数据结构无效。")

        def parse(field: str) -> datetime | None:
            value = payload[field]
            if value is None:
                return None
            if not isinstance(value, str):
                raise ValueError("记忆时间元数据必须是 ISO 字符串或 null。")
            return datetime.fromisoformat(value)

        return cls(
            recorded_at=parse("recorded_at"),
            source_started_at=parse("source_started_at"),
            source_ended_at=parse("source_ended_at"),
            source_time_complete=payload["source_time_complete"],
            current_status=payload.get("current_status", "current_unverified"),
            current_status_reason=payload.get("current_status_reason", UNKNOWN_CURRENT_REASON),
        )

    @classmethod
    def from_source_times(
        cls,
        source_times: Sequence[datetime | None],
        *,
        recorded_at: datetime | None = None,
    ) -> MemoryTiming:
        """只汇总直接证据中已知的时间，并明确标记缺失证据时间。"""
        for value in source_times:
            _aware_time(value)
        known = tuple(value for value in source_times if value is not None)
        return cls(
            recorded_at=recorded_at,
            source_started_at=min(known) if known else None,
            source_ended_at=max(known) if known else None,
            source_time_complete=(
                bool(source_times) and len(known) == len(source_times)
            ),
        )
