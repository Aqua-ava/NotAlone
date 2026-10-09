"""处理执行边界的文件适配器：读取当时规则摘要与结束时刻。"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from notalone.source_processing.models import execution


def capture_execution(
    started_at: datetime, rule_path: str, *, status: str = "succeeded"
) -> dict[str, Any]:
    """每次读取当前规则文件，不缓存版本或把持久化时刻当处理时刻。"""

    finished_at = datetime.now(timezone.utc)
    rule_version = hashlib.sha256(Path(rule_path).read_bytes()).hexdigest()
    return execution(
        started_at,
        finished_at=finished_at,
        rule_version=rule_version,
        status=status,
    )
