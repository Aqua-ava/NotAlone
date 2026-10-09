"""一次前台观察的最小投影，不保存身份候选、图帧或历史。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4


@dataclass(frozen=True, slots=True)
class FreshForegroundObservation:
    observation_id: UUID
    observed_at: datetime
    phase: Literal["paused", "manual-required", "unavailable"]
    reason: str
    probe_available: bool
    wechat_in_front: bool

    @classmethod
    def create(
        cls, *, phase: Literal["paused", "manual-required", "unavailable"],
        reason: str, probe_available: bool, wechat_in_front: bool,
    ) -> FreshForegroundObservation:
        return cls(
            observation_id=uuid4(), observed_at=datetime.now(timezone.utc),
            phase=phase, reason=reason, probe_available=probe_available,
            wechat_in_front=wechat_in_front,
        )
