"""剩余公开8窗的固定16次墙钟合同，保留原公开入口。"""
from pathlib import Path
from typing import Callable

from .evaluation_owned_deadline import _OwnedPublicDeadline


class Remaining8Deadline(_OwnedPublicDeadline):
    CALL_SECONDS = 600
    BATCH_SECONDS = 2380
    REQUEST_LIMIT = 16
    CODE_PREFIX = "remaining8"

    def __init__(self, *, receipt: Path, clock: Callable[[], float] | None = None,
                 exit_worker: Callable[[int], object] | None = None,
                 remaining_batch_seconds: float = 2380):
        super().__init__(receipt=receipt, clock=clock, exit_worker=exit_worker,
                         remaining_batch_seconds=remaining_batch_seconds)
