"""受控歧义v3两窗的固定4次墙钟合同。"""
from pathlib import Path
from typing import Callable

from .evaluation_owned_deadline import _OwnedPublicDeadline


class Ambiguity2Deadline(_OwnedPublicDeadline):
    CALL_SECONDS = 600
    BATCH_SECONDS = 5380
    REQUEST_LIMIT = 4
    CODE_PREFIX = "ambiguity2"

    def __init__(self, *, receipt: Path, clock: Callable[[], float] | None = None,
                 exit_worker: Callable[[int], object] | None = None,
                 remaining_batch_seconds: float = 5380):
        super().__init__(receipt=receipt, clock=clock, exit_worker=exit_worker,
                         remaining_batch_seconds=remaining_batch_seconds)
