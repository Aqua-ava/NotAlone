"""显式v3指代主集16窗的固定32次墙钟合同。"""
from pathlib import Path
from typing import Callable

from .evaluation_owned_deadline import _OwnedPublicDeadline


class Main16Deadline(_OwnedPublicDeadline):
    CALL_SECONDS = 600
    BATCH_SECONDS = 43180
    REQUEST_LIMIT = 32
    CODE_PREFIX = "main16"

    def __init__(self, *, receipt: Path, clock: Callable[[], float] | None = None,
                 exit_worker: Callable[[int], object] | None = None,
                 remaining_batch_seconds: float = 43180):
        super().__init__(receipt=receipt, clock=clock, exit_worker=exit_worker,
                         remaining_batch_seconds=remaining_batch_seconds)
