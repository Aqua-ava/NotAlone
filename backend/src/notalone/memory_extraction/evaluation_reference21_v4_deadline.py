"""原公开21窗v4基线的固定42次、4小时墙钟合同。"""
from pathlib import Path
from typing import Callable

from .evaluation_owned_deadline import _OwnedPublicDeadline


class Reference21V4Deadline(_OwnedPublicDeadline):
    CALL_SECONDS = 600
    BATCH_SECONDS = 14380
    REQUEST_LIMIT = 42
    CODE_PREFIX = "reference21_v4"

    def __init__(self, *, receipt: Path, clock: Callable[[], float] | None = None,
                 exit_worker: Callable[[int], object] | None = None,
                 remaining_batch_seconds: float = 14380):
        super().__init__(receipt=receipt, clock=clock, exit_worker=exit_worker,
                         remaining_batch_seconds=remaining_batch_seconds)
