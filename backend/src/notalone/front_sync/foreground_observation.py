"""一次前台观察的最小投影，不保存身份候选、图帧或历史。"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4


@dataclass(frozen=True, slots=True)
class FreshForegroundObservation:
    observation_id: UUID
    observed_at: datetime
    phase: Literal["confirmed", "paused", "manual-required", "unavailable"]
    reason: str
    probe_available: bool
    wechat_in_front: bool
    binding_id: UUID | None = None
    contact_id: UUID | None = None
    recognized_name: str | None = None
    recognition_confidence: float | None = None

    def __post_init__(self) -> None:
        if self.phase == "confirmed":
            if (not self.probe_available or not self.wechat_in_front
                    or not isinstance(self.binding_id, UUID)
                    or not isinstance(self.contact_id, UUID)):
                raise ValueError("已确认观察必须携带有效绑定与联系人。")
        elif self.binding_id is not None or self.contact_id is not None:
            raise ValueError("未确认观察不能携带身份。")
        if self.recognized_name is not None:
            confidence = self.recognition_confidence
            if (self.phase not in ("confirmed", "manual-required")
                    or not self.wechat_in_front or not self.probe_available
                    or not isinstance(self.recognized_name, str)
                    or not self.recognized_name.strip() or len(self.recognized_name) > 256
                    or "\n" in self.recognized_name or "\r" in self.recognized_name
                    or isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                    or not math.isfinite(confidence) or not 0 <= confidence <= 1):
                raise ValueError("名称预览必须来自当前有效的前台观察。")
        elif self.recognition_confidence is not None:
            raise ValueError("名称和置信度必须成对提供。")

    @classmethod
    def create(
        cls, *, phase: Literal["confirmed", "paused", "manual-required", "unavailable"],
        reason: str, probe_available: bool, wechat_in_front: bool,
        binding_id: UUID | None = None, contact_id: UUID | None = None,
        observed_at: datetime | None = None,
        recognized_name: str | None = None, recognition_confidence: float | None = None,
    ) -> FreshForegroundObservation:
        return cls(
            observation_id=uuid4(),
            observed_at=observed_at if observed_at is not None else datetime.now(timezone.utc),
            phase=phase, reason=reason, probe_available=probe_available,
            wechat_in_front=wechat_in_front,
            binding_id=binding_id, contact_id=contact_id,
            recognized_name=recognized_name, recognition_confidence=recognition_confidence,
        )
