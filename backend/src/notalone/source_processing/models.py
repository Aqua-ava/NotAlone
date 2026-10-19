"""独立于提取任务的来源处理快照，正文不进入 repr。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4


@dataclass(frozen=True, slots=True, repr=False)
class ProcessingRecord:
    """取得时即固定的记录，持久化时再关联真实消息与来源引用。"""

    record_id: UUID
    locator: str
    payload_json: str

    @classmethod
    def capture(
        cls, locator: str, payload: dict[str, Any]
    ) -> ProcessingRecord:
        return cls(
            uuid4(), locator,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        )

    def payload(self) -> dict[str, Any]:
        return json.loads(self.payload_json)

    def with_fields(self, **fields: Any) -> ProcessingRecord:
        return ProcessingRecord(
            self.record_id,
            self.locator,
            json.dumps(
                {**self.payload(), **fields},
                ensure_ascii=False, separators=(",", ":"),
            ),
        )


def execution(
    started_at: datetime,
    *,
    finished_at: datetime,
    rule_version: str,
    status: str = "succeeded",
) -> dict[str, Any]:
    """用执行边界提供的实际时刻和摘要构造纯快照。"""

    return {
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "status": status,
        "rule_version": rule_version,
    }


def message_snapshot(message: Any) -> dict[str, Any]:
    """适配器的规范化输出；不声称是已有规范消息的权威版本。"""

    return {
        "speaker": message.speaker,
        "message_type": message.message_type,
        "text_content": message.text_content,
        "media_placeholder": message.media_placeholder,
        "occurred_at": (
            message.occurred_at.isoformat() if message.occurred_at else None
        ),
    }
