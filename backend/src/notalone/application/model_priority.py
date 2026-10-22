"""本后端内的前台回复优先许可；不依赖模型或编排框架。"""

from __future__ import annotations

from contextlib import AbstractContextManager, contextmanager
from datetime import datetime, timezone
from threading import Condition, Event, Lock, get_ident, local
from typing import Any, Callable, Iterator, Protocol
import time
from uuid import UUID, uuid4

from notalone.application.reply_service import ReplyPort
from notalone.ledger.models import LedgerEntry, LedgerOutcome
from notalone.ledger.ports import OutboundLedgerPort
from notalone.memory_extraction.command import ExtractionRunStats
from notalone.memory_extraction.adjudication import (
    AdjudicationDecision, AdjudicationRuntime, SimilarMemory,
)
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
from notalone.memory_extraction.runtime import ExtractionPayload, MemoryExtractionRuntime
from notalone.memory_extraction.verification import SourceVerificationMode, SourceVerificationRuntime
from notalone.memory_trace.context import current_trace
from notalone.persistence.background_tasks import BackgroundTaskPersistenceError
from notalone.reply.interface import GenerateReply, ReplyOutcome
from notalone.scopes import ContactScope, VerifiedConversationScope
from notalone.tasks.models import ExtractionRuntimeConfig


_RETRY_GUARD_INTERVAL_SECONDS = 1.0


class ModelWorkStopped(RuntimeError):
    """协作停止，不属于模型失败或业务成功。"""


class ModelPriorityControl:
    """整次前台回复优先于尚未开始的后台物理请求；后台请求可有限并发。"""

    def __init__(self, background_limit: int = 1) -> None:
        """background_limit 为同时允许的在途后台物理调用数；默认 1 保持原串行许可。"""
        if isinstance(background_limit, bool) or not isinstance(background_limit, int):
            raise TypeError("后台并发上限必须是整数。")
        if background_limit < 1:
            raise ValueError("后台并发上限至少为 1。")
        self._condition = Condition()
        self._stopped = Event()
        self._reply_waiters = 0
        self._reply_active = False
        self._background_active = 0
        self._background_limit = background_limit
        self._background_scope = local()

    @property
    def stop_event(self) -> Event:
        return self._stopped

    @property
    def background_limit(self) -> int:
        return self._background_limit

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

        previous = getattr(self._background_scope, "guard", None)
        self._background_scope.guard = guard
        try:
            yield
        finally:
            self._background_scope.guard = previous

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
                while self._background_active > 0 or self._reply_active:
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
            # 前台登记或活跃时让路；在途后台数达到上限时等待空位。
            while (
                self._reply_waiters or self._reply_active
                or self._background_active >= self._background_limit
            ):
                self._condition.wait()
                self.check_running()
            self.check_running()
            self._background_active += 1
        try:
            self._check_background_scope()
            self.check_running()
            yield
            # 已开始的 SDK 调用不能强行中断；停止后的晚结果不进入采纳路径。
            self.check_running()
            self._check_background_scope()
        finally:
            with self._condition:
                self._background_active -= 1
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

    def wait_for_retry(self, seconds: float) -> None:
        """停止事件即时唤醒；持久来源／租约复验最多每秒一次。

        默认30秒退避至多31次复验；下一物理请求仍在许可边界强制复验。
        """
        expires_at = time.monotonic() + seconds
        while True:
            self.check_running()
            self._check_background_scope()
            remaining = expires_at - time.monotonic()
            if remaining <= 0:
                return
            self._stopped.wait(min(remaining, _RETRY_GUARD_INTERVAL_SECONDS))


class MemoryCallAccounting:
    """仅补记被停止或原任务 guard 丢弃的已返回调用；普通持久失败不补记。"""

    def __init__(
        self, ledger: OutboundLedgerPort, *, provider: str = "deepseek",
        model_name: str = "unreported",
    ) -> None:
        self._ledger, self._provider, self._model_name = ledger, provider, model_name
        self._run = local()
        # 提取范围属于整次运行：并行 worker 线程共享 scope，单次调用
        # 记录仍按线程归属，避免跨线程读取线程本地状态。
        self._scope: ContactScope | None = None
        self._pending_extractions: dict[
            int, tuple[LedgerEntry, Any]
        ] = {}
        self._pending_lock = Lock()

    @contextmanager
    def run_scope(self, scope: ContactScope) -> Iterator[None]:
        previous_scope = self._scope
        self._scope = scope
        self._run.extraction_record = None
        self._run.extraction_trace = None
        with self._pending_lock:
            self._pending_extractions.clear()
        try:
            yield
        except (ModelWorkStopped, BackgroundTaskPersistenceError):
            # 只控制/guard 中断会绕过原 E 台账；水位错误发生在原台账之后。
            self._record_unconsumed_extractions()
            raise
        finally:
            with self._pending_lock:
                self._pending_extractions.clear()
            del self._run.extraction_record
            del self._run.extraction_trace
            self._scope = previous_scope

    def _record_unconsumed_extractions(self) -> None:
        """停止时补记各线程最后一次已返回、尚未进入原 E 台账的调用。"""

        with self._pending_lock:
            pending = tuple(self._pending_extractions.values())
            self._pending_extractions.clear()
        for entry, trace in pending:
            if trace is not None and self._trace_accounted(trace):
                continue
            self._ledger.record(entry)

    @staticmethod
    def _trace_accounted(trace: Any) -> bool:
        """追踪已完成调用或已关联台账时不要重复补记。"""

        calls = getattr(trace, "calls", None)
        call_id = calls.get("extraction") if isinstance(calls, dict) else None
        observations = getattr(trace, "observations", None)
        observation = (
            observations.get(call_id)
            if call_id is not None and isinstance(observations, dict)
            else None
        )
        if observation is not None and getattr(
            observation, "ledger_entry", None
        ) is not None:
            return True
        store = getattr(trace, "store", None)
        if store is None:
            return False
        try:
            batch = store.get_batch(trace.scope, trace.trace_id)
        except Exception:
            return False
        # 这些终态批都已在提交段写入原 E 台账（停止批除外）。
        return batch.get("status") in {"succeeded", "skipped", "model_failed"}

    def extraction_started(self) -> None:
        self._run.extraction_record = None
        self._run.extraction_trace = current_trace()
        with self._pending_lock:
            self._pending_extractions.pop(get_ident(), None)

    def extraction_returned(self, called_at: datetime, latency_ms: int) -> None:
        entry = self._entry(called_at, latency_ms)
        self._run.extraction_record = entry
        trace = self._run.extraction_trace
        with self._pending_lock:
            self._pending_extractions[get_ident()] = (entry, trace)

    def record_discarded(self, called_at: datetime, latency_ms: int) -> None:
        if current_trace() is None:
            self._ledger.record(self._entry(called_at, latency_ms))

    def _entry(self, called_at: datetime, latency_ms: int) -> LedgerEntry:
        scope = self._scope
        if scope is None:
            raise RuntimeError("模型调用记账不在提取运行范围内。")
        return LedgerEntry(
            entry_id=uuid4(), owner_id=scope.owner_id, contact_id=scope.contact_id,
            provider=self._provider, model_name=self._model_name,
            input_tokens=None, output_tokens=None, latency_ms=latency_ms,
            outcome=LedgerOutcome.RUN_FAILED, called_at=called_at,
        )


class ExtractionRunnerPort(Protocol):
    @property
    def model_version(self) -> str: ...

    def run(
        self, *, scope: ContactScope, task_id: UUID | None = None,
        extraction_runtime_config: ExtractionRuntimeConfig | None = None,
        background_scope_factory: (
            Callable[[], AbstractContextManager] | None
        ) = None,
    ) -> ExtractionRunStats: ...


class AccountedExtractionRunner:
    """在真实提取运行期间封装丢弃调用的账本收尾。"""

    def __init__(self, runner: ExtractionRunnerPort, accounting: MemoryCallAccounting) -> None:
        self._runner, self._accounting = runner, accounting

    @property
    def model_version(self) -> str:
        return self._runner.model_version

    def run(
        self, *, scope: ContactScope, task_id: UUID | None = None,
        extraction_runtime_config: ExtractionRuntimeConfig | None = None,
        background_scope_factory: (
            Callable[[], AbstractContextManager] | None
        ) = None,
    ) -> ExtractionRunStats:
        with self._accounting.run_scope(scope):
            options: dict[str, Any] = {}
            if background_scope_factory is not None:
                options["background_scope_factory"] = background_scope_factory
            if task_id is None and extraction_runtime_config is None:
                return self._runner.run(scope=scope, **options)
            return self._runner.run(
                scope=scope, task_id=task_id,
                extraction_runtime_config=extraction_runtime_config,
                **options,
            )


class PriorityExtractionRuntime:
    def __init__(
        self, runtime: MemoryExtractionRuntime, control: ModelPriorityControl, *,
        accounting: MemoryCallAccounting | None = None,
    ) -> None:
        self._runtime, self._control = runtime, control
        self._accounting = accounting

    @property
    def prompt_profile(self) -> str:
        return getattr(self._runtime, "prompt_profile", "default")

    def for_prompt_profile(self, prompt_profile: str) -> PriorityExtractionRuntime:
        select = getattr(self._runtime, "for_prompt_profile", None)
        if not callable(select):
            raise ValueError("提取适配器不支持指定任务教学profile。")
        return PriorityExtractionRuntime(select(prompt_profile), self._control, accounting=self._accounting)

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        if self._accounting is not None:
            self._accounting.extraction_started()
        scheduled = getattr(self._runtime, "extract_scheduled", None)
        if callable(scheduled):
            result = scheduled(window, request_context=self._request,
                               retry_wait=self._control.wait_for_retry)
        else:
            # 合成及旧维度Runtime一次extract只有一次调用，保留原接缝。
            with self._request():
                result = self._runtime.extract(window)
        self._control.wait_for_foreground()
        return result

    @contextmanager
    def _request(self) -> Iterator[None]:
        with self._control.background_call():
            called_at, started = datetime.now(timezone.utc), time.perf_counter()
            yield
            if self._accounting is not None:
                self._accounting.extraction_returned(
                    called_at, max(0, int((time.perf_counter() - started) * 1000)),
                )


class PriorityVerificationRuntime:
    def __init__(self, runtime: SourceVerificationRuntime, control: ModelPriorityControl) -> None:
        self._runtime, self._control = runtime, control

    @property
    def verification_mode(self) -> SourceVerificationMode:
        return SourceVerificationMode(getattr(self._runtime, "verification_mode", SourceVerificationMode.LEGACY_V4))

    def for_mode(self, mode: SourceVerificationMode | str) -> PriorityVerificationRuntime:
        select = getattr(self._runtime, "for_mode", None)
        if not callable(select):
            raise ValueError("来源核验适配器不支持指定任务模式。")
        return PriorityVerificationRuntime(select(mode), self._control)

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
    @property
    def supports_evidence(self):
        return getattr(self._runtime, "supports_evidence", False)

    def __init__(
        self, runtime: AdjudicationRuntime, control: ModelPriorityControl, *,
        accounting: MemoryCallAccounting | None = None,
    ) -> None:
        self._runtime, self._control = runtime, control
        self._accounting = accounting

    def adjudicate(
        self, *, candidate_text: str, similar: tuple[SimilarMemory, ...], candidate=None,
    ) -> AdjudicationDecision:
        return self._invoke(lambda: self._runtime.adjudicate(candidate_text=candidate_text, similar=similar, **({"candidate": candidate} if self.supports_evidence else {})))

    def adjudicate_batch(self, *, candidates=None, memories=None, pool=None):
        batch = getattr(self._runtime, "adjudicate_batch", None)
        if memories is not None:
            if not callable(batch):
                raise TypeError("正式记忆裁决需要批量运行时。")
            return self._invoke(lambda: batch(memories=memories, pool=pool))
        if candidates is None:
            raise TypeError("批量裁决缺少候选。")
        if not callable(batch):
            return tuple(self.adjudicate(candidate_text=text, similar=similar) for text, similar in candidates)
        return self._invoke(lambda: batch(candidates=candidates))

    def _invoke(self, call):
        returned = False
        called_at, latency_ms = datetime.now(timezone.utc), 0
        try:
            with self._control.background_call():
                called_at, started = datetime.now(timezone.utc), time.perf_counter()
                result = call()
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
