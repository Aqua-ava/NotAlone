"""完整140窗v4来源保真v2的固定280次墙钟合同。"""
from pathlib import Path
from typing import Callable

from .evaluation_owned_deadline import _OwnedPublicDeadline


class Full140V4Deadline(_OwnedPublicDeadline):
    CALL_SECONDS = 600
    BATCH_SECONDS = 86380
    REQUEST_LIMIT = 280
    CODE_PREFIX = "full140_v4"

    def __init__(self, *, receipt: Path, clock: Callable[[], float] | None = None,
                 exit_worker: Callable[[int], object] | None = None,
                 remaining_batch_seconds: float = 86380):
        super().__init__(receipt=receipt, clock=clock, exit_worker=exit_worker,
                         remaining_batch_seconds=remaining_batch_seconds)
