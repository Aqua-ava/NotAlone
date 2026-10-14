"""本后端内的前台回复优先许可；不依赖模型或编排框架。"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from threading import Condition, Event, local
from typing import Any, Callable, Iterator, Protocol
import time
from uuid import uuid4

from notalone.application.reply_service import ReplyPort
from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort
from notalone.memory_extraction.command import ExtractionRunStats
from notalone.memory_extraction.adjudication import (
    AdjudicationDecision, AdjudicationRuntime, SimilarMemory,
)
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
from notalone.memory_extraction.runtime import ExtractionPayload, MemoryExtractionRuntime
from notalone.memory_extraction.verification import SourceVerificationRuntime
from notalone.memory_trace.context import current_trace
from notalone.persistence.background_tasks import BackgroundTaskPersistenceError
from notalone.reply.interface import GenerateReply, ReplyOutcome
from notalone.scopes import ContactScope, VerifiedConversationScope


class ModelWorkStopped(RuntimeError):
    """协作停止，不属于模型失败或业务成功。"""


class ModelPriorityControl:
    """整次前台回复优先于尚未开始的一次后台适配器调用。"""

    def __init__(self) -> None:
        self._condition = Condition()
        self._stopped = Event()
        self._reply_waiters = 0
        self._reply_active = False
        self._background_active = False
        self._background_scope = local()

    @property
    def stop_event(self) -> Event:
        return self._stopped

    def stop(self) -> None:
        with self._condition:
            self._stopped.set()
            self._condition.notify_all()

    def check_running(self) -> None:
        if self._stopped.is_set():
            raise ModelWorkStopped("本后端正在停止模型工作。")

    @contextmanager
    def background_scope(
        self, guard: Callable[[], None],
    ) -> Iterator[None]:
        """来源与步骤租约的复验仍由持久层负责，不进入模型适配器。"""

        self._background_scope.guard = guard
        try:
            yield
        finally:
            del self._background_scope.guard

    def _check_background_scope(self) -> None:
        guard = getattr(self._background_scope, "guard", None)
        if guard is not None:
            guard()

    @contextmanager
    def foreground(self) -> Iterator[None]:
        with self._condition:
            self.check_running()
            self._reply_waiters += 1
            try:
                while self._background_active or self._reply_active:
                    self._condition.wait()
                    self.check_running()
                self.check_running()
                self._reply_active = True
            finally:
                self._reply_waiters -= 1
                self._condition.notify_all()
        try:
            self.check_running()
            yield
        finally:
            with self._condition:
                self._reply_active = False
                self._condition.notify_all()

    @contextmanager
    def background_call(self) -> Iterator[None]:
        with self._condition:
            self.check_running()
            while self._reply_waiters or self._reply_active or self._background_active:
                self._condition.wait()
                self.check_running()
            self.check_running()
            self._background_active = True
        try:
            self._check_background_scope()
            self.check_running()
            yield
            # 已开始的 SDK 调用不能强行中断；停止后的晚结果不进入采纳路径。
            self.check_running()
            self._check_background_scope()
        finally:
            with self._condition:
                self._background_active = False
                self._condition.notify_all()

    def wait_for_foreground(self) -> None:
        """释放模型许可后，让已登记回复完成再消费后台返回结果。"""

        with self._condition:
            self.check_running()
            while self._reply_waiters or self._reply_active:
                self._condition.wait()
                self.check_running()
            self.check_running()
        # 等待不持有模型许可；返回前复验原来源与步骤租约。
        self._check_background_scope()


class MemoryCallAccounting:
    """仅补记被停止或原任务 guard 丢弃的已返回调用；普通持久失败不补记。"""

    def __init__(
        self, ledger: OutboundLedgerPort, *, provider: str = "deepseek",
        model_name: str = "unreported",
    ) -> None:
        self._ledger, self._provider, self._model_name = ledger, provider, model_name
        self._run = local()

    @contextmanager
    def run_scope(self, scope: ContactScope) -> Iterator[None]:
        self._run.scope = scope
        self._run.extraction_record = None
        self._run.extraction_trace = None
        try:
            yield
        except (ModelWorkStopped, BackgroundTaskPersistenceError):
            # 只控制/guard 中断会绕过原 E 台账；水位错误发生在原台账之后。
            entry = self._run.extraction_record
            if entry is not None and self._run.extraction_trace is None:
                self._ledger.record(entry)
            raise
        finally:
            del self._run.scope
            del self._run.extraction_record
            del self._run.extraction_trace

    def extraction_started(self) -> None:
        self._run.extraction_record = None
        self._run.extraction_trace = current_trace()

    def extraction_returned(self, called_at: datetime, latency_ms: int) -> None:
        self._run.extraction_record = self._entry(called_at, latency_ms)

    def record_discarded(self, called_at: datetime, latency_ms: int) -> None:
        if current_trace() is None:
            self._ledger.record(self._entry(called_at, latency_ms))

    def _entry(self, called_at: datetime, latency_ms: int) -> LedgerEntry:
        scope = self._run.scope
        return LedgerEntry(
            entry_id=uuid4(), owner_id=scope.owner_id, contact_id=scope.contact_id,
            provider=self._provider, model_name=self._model_name,
            input_tokens=None, output_tokens=None, latency_ms=latency_ms,
            outcome=LedgerOutcome.RUN_FAILED, called_at=called_at,
        )


class ExtractionRunnerPort(Protocol):
    @property
    def model_version(self) -> str: ...

    def run(self, *, scope: ContactScope) -> ExtractionRunStats: ...


class AccountedExtractionRunner:
    """在真实提取运行期间封装丢弃调用的账本收尾。"""

    def __init__(self, runner: ExtractionRunnerPort, accounting: MemoryCallAccounting) -> None:
        self._runner, self._accounting = runner, accounting

    @property
    def model_version(self) -> str:
        return self._runner.model_version

    def run(self, *, scope: ContactScope) -> ExtractionRunStats:
        with self._accounting.run_scope(scope):
            return self._runner.run(scope=scope)


class PriorityExtractionRuntime:
    def __init__(
        self, runtime: MemoryExtractionRuntime, control: ModelPriorityControl, *,
        accounting: MemoryCallAccounting | None = None,
    ) -> None:
        self._runtime, self._control = runtime, control
        self._accounting = accounting

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        if self._accounting is not None:
            self._accounting.extraction_started()
        with self._control.background_call():
            called_at, started = datetime.now(timezone.utc), time.perf_counter()
            result = self._runtime.extract(window)
            if self._accounting is not None:
                self._accounting.extraction_returned(
                    called_at, max(0, int((time.perf_counter() - started) * 1000)),
                )
        self._control.wait_for_foreground()
        return result


class PriorityVerificationRuntime:
    def __init__(self, runtime: SourceVerificationRuntime, control: ModelPriorityControl) -> None:
        self._runtime, self._control = runtime, control

    def verify(
        self, *, window: ExtractionWindow, facts: tuple[ExtractedFact, ...],
    ) -> tuple[dict[str, Any], ...]:
        returned = False
        try:
            with self._control.background_call():
                result = self._runtime.verify(window=window, facts=facts)
                returned = True
            self._control.wait_for_foreground()
            return result
        except (ModelWorkStopped, BackgroundTaskPersistenceError):
            trace = current_trace()
            if returned and trace is not None:
                trace.discard_call("verification")
            raise


class PriorityAdjudicationRuntime:
    def __init__(
        self, runtime: AdjudicationRuntime, control: ModelPriorityControl, *,
        accounting: MemoryCallAccounting | None = None,
    ) -> None:
        self._runtime, self._control = runtime, control
        self._accounting = accounting

    def adjudicate(
        self, *, candidate_text: str, similar: tuple[SimilarMemory, ...],
    ) -> AdjudicationDecision:
        returned = False
        called_at, latency_ms = datetime.now(timezone.utc), 0
        try:
            with self._control.background_call():
                called_at, started = datetime.now(timezone.utc), time.perf_counter()
                result = self._runtime.adjudicate(candidate_text=candidate_text, similar=similar)
                returned = True
                latency_ms = max(0, int((time.perf_counter() - started) * 1000))
            self._control.wait_for_foreground()
            return result
        except (ModelWorkStopped, BackgroundTaskPersistenceError):
            if returned and self._accounting is not None:
                self._accounting.record_discarded(called_at, latency_ms)
            raise


class PriorityReplyPort:
    def prepare(self, command: GenerateReply, verified_scope: VerifiedConversationScope) -> None:
        self._reply.prepare(command=command, verified_scope=verified_scope)

    def __init__(self, reply: ReplyPort, control: ModelPriorityControl) -> None:
        self._reply, self._control = reply, control

    def generate(
        self, command: GenerateReply, verified_scope: VerifiedConversationScope,
    ) -> ReplyOutcome:
        # 登记和等待都在 ReplyGenerator.start、请求租约与 runtime 计时之前。
        with self._control.foreground():
            return self._reply.generate(command=command, verified_scope=verified_scope)
