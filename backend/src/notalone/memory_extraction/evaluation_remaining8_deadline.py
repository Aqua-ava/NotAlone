"""仅供剩余公开8窗独占worker的墙钟退场；不接收凭据或正文。"""

from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import stat
import threading
import time
from typing import Callable, Iterator

from .evaluation_http_budget import EvaluationBudget, EvaluationBudgetAbort


class Remaining8Deadline:
    CALL_SECONDS = 600
    BATCH_SECONDS = 2380

    def __init__(self, *, receipt: Path, clock: Callable[[], float] | None = None,
                 exit_worker: Callable[[int], object] | None = None,
                 remaining_batch_seconds: float = 2380):
        self._clock = clock or time.monotonic
        self._exit = exit_worker or os._exit
        self.live_worker = clock is None and exit_worker is None and os.getpgrp() == os.getpid()
        self._pid = os.getpid()
        self._receipt = receipt
        parent = receipt.parent.lstat()
        if (not receipt.is_absolute() or receipt != receipt.resolve()
                or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
                or stat.S_IMODE(parent.st_mode) != 0o700 or os.path.lexists(receipt)):
            raise EvaluationBudgetAbort("remaining8_private_receipt_required")
        self._parent_identity = (parent.st_dev, parent.st_ino)
        self._began = self._clock()
        if (not math.isfinite(self._began) or self._began < 0
                or type(remaining_batch_seconds) not in (int, float)
                or not math.isfinite(remaining_batch_seconds) or not 0 < remaining_batch_seconds <= self.BATCH_SECONDS):
            raise EvaluationBudgetAbort("remaining8_clock_invalid")
        self._batch_seconds = remaining_batch_seconds
        self._active: float | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._budget: EvaluationBudget | None = None
        self._run_id: str | None = None
        self._triggered = False

    def start(self, budget: EvaluationBudget, *, synthetic: bool = False) -> None:
        if self._budget is not None or self._pid != os.getpid() or not synthetic and not self.live_worker:
            raise EvaluationBudgetAbort("remaining8_owned_worker_required")
        snapshot = budget.snapshot()
        if (snapshot["request_limit"] != 16 or snapshot["reserved_requests"] != 0
                or snapshot["allowed_endpoints"] != ["https://api.deepseek.com/chat/completions"]
                or not (Path.home() / ".notalone-memory-evaluations" / snapshot["run_id"] / "claimed").is_file()):
            raise EvaluationBudgetAbort("remaining8_claimed_budget_required")
        self._budget, self._run_id = budget, snapshot["run_id"]
        self._thread = threading.Thread(target=self._watch, name="remaining8-deadline", daemon=True)
        self._thread.start()

    @contextmanager
    def invocation(self) -> Iterator[None]:
        with self._lock:
            if self._budget is None or self._triggered or self._active is not None:
                raise EvaluationBudgetAbort("remaining8_invocation_invalid")
            self._active = self._clock()
        try:
            self.checkpoint()
            yield
        finally:
            self.checkpoint()
            with self._lock:
                self._active = None

    def _watch(self) -> None:
        while not self._stop.wait(0.02):
            self.checkpoint()

    def checkpoint(self) -> None:
        with self._lock:
            if self._budget is None or self._triggered or self._stop.is_set():
                return
            now = self._clock()
            reason = ("clock_invalid" if not math.isfinite(now) or now < self._began or self._active is not None and now < self._active else
                      "batch_wall_deadline" if now - self._began >= self._batch_seconds else
                      "call_wall_deadline" if self._active is not None and now - self._active >= self.CALL_SECONDS else None)
            if reason is None:
                return
            self._triggered = True
        # 不取网络锁；原预算先fsync closed标记，再更新SQLite。
        closed, reserved = False, None
        try:
            self._budget.close()
            proof = self._budget.closed_receipt()
            closed, reserved = proof["closed"] is True, proof["reserved_requests"]
        except BaseException:
            pass
        receipt_saved = False
        try:
            self._publish({"run_id": self._run_id, "reason": reason, "closed": closed,
                           "request_limit": 16, "reserved_requests": reserved, "worker_pid": self._pid})
            receipt_saved = True
        except BaseException:
            pass
        if self._pid == os.getpid():
            self._exit(124 if closed and receipt_saved else 125)

    def _publish(self, value: dict) -> None:
        parent = self._receipt.parent.lstat()
        if ((parent.st_dev, parent.st_ino) != self._parent_identity or not stat.S_ISDIR(parent.st_mode)
                or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700):
            raise EvaluationBudgetAbort("remaining8_receipt_parent_changed")
        descriptor = os.open(self._receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(json.dumps(value, sort_keys=True).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        descriptor = os.open(self._receipt.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def finish(self) -> None:
        if self._budget is None:
            return
        self._budget.closed_receipt()
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
            if self._thread.is_alive():
                raise EvaluationBudgetAbort("remaining8_watchdog_shutdown_unknown")
