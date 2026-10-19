"""后端进程内的前台同步宿主：在常驻进程里驱动同步循环。

菜单栏不再每 3 秒拉起子进程执行 ``front-sync status``；同步循环的权威
驱动方变为后端常驻进程（ADR-020）。SyncHost 持有应用层 FrontSyncEngine，
启动时播种初始化报告，同步开启时按有界切片推进，空闲后等待心跳，
并缓存最近一次报告供状态 API 返回。
"""

from __future__ import annotations

import threading
from time import monotonic
from dataclasses import dataclass
from datetime import datetime, timezone
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Protocol
from uuid import UUID

from notalone.front_sync.foreground_observation import FreshForegroundObservation
from notalone.front_sync.observation_budget import FOREGROUND_OBSERVATION_SECONDS
from notalone.front_sync.cli_binding import (
    CliBindingCandidateView,
    CliBindingSelection,
)
from notalone.front_sync.sync_engine import (
    BindingConfirmationError,
    FrontSyncCycleReport,
)
from notalone.front_sync.tail_lifecycle import FrontSyncPhase, FollowRuntimeStatus
from notalone.persistence.conversation_repository import PersistedConversationBinding


@dataclass(frozen=True, slots=True)
class LatestValidForegroundObservation:
    """最近一次通过前台、定位和 CLI 门禁的最小验证投影。"""

    observed_at: datetime
    contact_id: UUID
    display_name: str | None
    watermark: int | None
    batch_message_count: int


class SyncEnginePort(Protocol):
    """SyncHost 需要的最小引擎接口。"""

    def cycle(self) -> FrontSyncCycleReport:
        """执行一次前台观察与增量读取。"""

    def enable_sync(self) -> None:
        """手动开启前台同步。"""

    def disable_sync(self) -> None:
        """手动关闭前台同步。"""

    def observe_foreground(self, *, deadline: float, check_current: Callable[[], None] | None = None) -> FreshForegroundObservation:
        """取得一次不驱动后台正文读取的新观察。"""

    def sync_enabled(self) -> bool:
        """读取当前同步开关（不触发探针或 CLI）。"""

    def request_sync_check(self) -> None:
        """请求一次有界后台同步检查。"""

    def set_priority_contact(self, contact_id: UUID | None) -> None:
        """设置当前应用查看联系人，供下一轮后台读取优先处理。"""

    def pause_backfill(self) -> None:
        """暂停后台补齐。"""

    def retry_backfill(self) -> None:
        """恢复后台补齐。"""

    def close(self) -> None:
        """关闭进程内读取资源，但不修改持久化同步开关。"""

    def list_cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        """读取 CLI 可见的私聊会话候选；不要求微信在前台。"""

    def list_cli_bindings(self) -> tuple[PersistedConversationBinding, ...]:
        """读取当前运行范围的 active 绑定目录。"""

    def revoke_cli_binding(
        self, *, contact_id: UUID, binding_id: UUID,
    ) -> PersistedConversationBinding:
        """撤销当前运行范围内的一个绑定。"""

    def confirm_cli_bindings(
        self,
        selections: Sequence[CliBindingSelection],
    ) -> FrontSyncCycleReport:
        """一次性确认 CLI 私聊绑定并返回最新状态。"""

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        """启用人工验证用 follow 优先策略并立即运行一轮。"""

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        """关闭人工验证用 follow 优先策略并恢复轮询。"""

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        """中断当前 follow 流并运行一轮恢复逻辑。"""

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        """读取 follow 运行时最小状态。"""

    def confirm_binding(
        self,
        *,
        contact_id: UUID,
        locator: str,
    ) -> FrontSyncCycleReport:
        """在当前前台会话上完成一次性绑定选择。"""

    def confirm_pending_binding(
        self,
        *,
        contact_id: UUID,
        locator: str,
    ) -> FrontSyncCycleReport:
        """消费最近一次微信前台观察产生的待确认绑定证据。"""


class SyncControlPort(Protocol):
    """后端向 HTTP 应用层暴露的同步控制端口。"""

    def observe_foreground(self) -> FreshForegroundObservation:
        """有界读取本次前台投影，不返回历史报告。"""

    def status(self) -> FrontSyncCycleReport | None:
        """返回最近一次循环报告；尚未运行过循环时返回 None。"""

    def enable(self) -> FrontSyncCycleReport:
        """开启同步并立即执行一轮，返回最新报告。"""

    def disable(self) -> FrontSyncCycleReport:
        """关闭同步并立即执行一轮，返回最新报告。"""

    def check(self) -> FrontSyncCycleReport:
        """立即执行一轮并返回最新报告。"""

    def set_priority_contact(
        self, contact_id: UUID | None
    ) -> FrontSyncCycleReport | None:
        """更新当前应用查看联系人，供后台下一轮读取优先处理。"""

    def pause_backfill(self) -> FrontSyncCycleReport:
        """暂停后台补齐并返回最新报告。"""

    def retry_backfill(self) -> FrontSyncCycleReport:
        """恢复后台补齐并返回最新报告。"""

    def cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        """读取 CLI 可见的私聊会话候选。"""

    def cli_bindings(self) -> tuple[PersistedConversationBinding, ...]:
        """读取当前运行范围的 active 绑定目录。"""

    def revoke_cli_binding(
        self, *, contact_id: UUID, binding_id: UUID,
    ) -> PersistedConversationBinding:
        """有界等待循环收尾后撤销；成功返回后不再新增该绑定的读取。"""

    def confirm_cli_bindings(
        self,
        selections: Sequence[CliBindingSelection],
    ) -> FrontSyncCycleReport:
        """一次性确认 CLI 私聊绑定并返回最新状态。"""

    def confirm(
        self,
        *,
        contact_id: UUID,
        locator: str,
    ) -> FrontSyncCycleReport:
        """完成一次性绑定确认并立即执行一轮，返回最新报告。"""

    def confirm_pending(
        self,
        *,
        contact_id: UUID,
        locator: str,
    ) -> FrontSyncCycleReport:
        """消费待确认绑定证据并立即执行一轮，返回最新报告。"""


class SyncHostStopped(RuntimeError):
    """运行时正在停止或已停止，不能重新触发读取。"""


class SyncHostBusy(RuntimeError):
    """本轮同步尚未收尾；未取得锁时不执行授权变更。"""


class SyncHost:
    """常驻同步宿主：后台线程按心跳驱动引擎循环，接口层操作受锁保护。

    后台引擎调用串行；只读前台观察独立单航班，授权变更同时隔离两条路径。
    循环策略：启动时播种一轮初始化报告（即使同步关闭也执行一次，
    让状态 API 尽快有值）；之后只在同步开启时按心跳执行 cycle，关闭期间
    不循环也不拉起探针子进程。
    """

    __slots__ = (
        "_engine",
        "_follow_smoke_active",
        "_interval",
        "_engine_lock",
        "_foreground_lock",
        "_observation_generation",
        "_observation_mutations",
        "_state_lock",
        "_latest",
        "_runtime_status",
        "_last_valid_observation",
        "_stop_event",
        "_wake_event",
        "_priority_contact_id",
        "_priority_requested_at",
        "_priority_revision",
        "_applied_priority_revision",
        "_thread",
        "_closed",
    )

    def __init__(self, *, engine: SyncEnginePort, interval: float = 3.0) -> None:
        if not isinstance(interval, (int, float)) or isinstance(interval, bool):
            raise TypeError("interval 必须是数字。")
        if interval <= 0:
            raise ValueError("interval 必须大于零。")
        self._engine = engine
        self._follow_smoke_active = False
        self._interval = float(interval)
        # 同步周期会做 CLI、探针和数据库 I/O，可能持续数秒甚至更久。
        # engine_lock 只保护不可并发的引擎调用；状态快照使用独立锁，
        # 这样 /api/sync/status 不会因为一轮慢同步而超时。
        self._engine_lock = threading.Lock()
        self._foreground_lock = threading.Lock()
        self._observation_generation = 0
        self._observation_mutations = 0
        self._state_lock = threading.Lock()
        self._latest: FrontSyncCycleReport | None = None
        self._runtime_status = FollowRuntimeStatus(
            enabled=False,
            stream_active=False,
        )
        self._last_valid_observation: LatestValidForegroundObservation | None = None
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._priority_contact_id: UUID | None = None
        self._priority_requested_at: float | None = None
        self._priority_revision = 0
        self._applied_priority_revision = 0
        self._thread: threading.Thread | None = None
        self._closed = False

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def start(self) -> None:
        """启动后台循环线程；重复启动会抛出 RuntimeError。"""

        with self._state_lock:
            if self._stop_event.is_set():
                raise SyncHostStopped("已停止的同步宿主不可重启。")
            if self._thread is not None:
                raise RuntimeError("同步宿主已经启动。")
            thread = threading.Thread(
                target=self._loop,
                name="notalone-front-sync-host",
                daemon=True,
            )
            self._thread = thread
            thread.start()

    def stop(self) -> None:
        """停止后台循环并关闭引擎读取资源；未启动时也会清理资源。"""

        with self._state_lock:
            self._stop_event.set()
            self._wake_event.set()
            thread = self._thread
            self._thread = None
        # HTTP 手动检查也可能阻塞在 CLI 中；没有循环线程时同样取消 I/O。
        cancel = getattr(self._engine, "cancel_pending_io", None)
        if callable(cancel):
            cancel()
        if thread is not None:
            thread.join(timeout=max(self._interval * 2, 5.0))
        with self._engine_lock, self._foreground_lock:
            if self._closed:
                return
            close = getattr(self._engine, "close", None)
            if callable(close):
                close()
            self._closed = True

    # ------------------------------------------------------------------
    # 状态与控制端口
    # ------------------------------------------------------------------

    def observe_foreground(self) -> FreshForegroundObservation:
        """前台锁预算200ms、单轮预算3.2秒；后台正文 I/O 不占前台锁。"""

        deadline = monotonic() + FOREGROUND_OBSERVATION_SECONDS
        with self._active_foreground() as check_current:
            if monotonic() >= deadline:
                raise SyncHostBusy("本次前台观察预算已过期。")
            result = self._engine.observe_foreground(deadline=deadline, check_current=check_current)
            try:
                check_current()
            except BaseException:
                cancel = getattr(self._engine, "cancel_foreground_observation", None)
                if callable(cancel):
                    cancel()
                raise
            return result

    def status(self) -> FrontSyncCycleReport | None:
        with self._state_lock:
            return self._latest

    def enable(self) -> FrontSyncCycleReport:
        with self._authority_change():
            self._engine.enable_sync()
            return self._run_cycle_locked()

    def disable(self) -> FrontSyncCycleReport:
        with self._authority_change():
            self._engine.disable_sync()
            return self._run_cycle_locked()

    def check(self) -> FrontSyncCycleReport:
        with self._active_engine():
            # CLI 全量同步的安全对账是低频的；用户点击“立即检查”时
            # 明确表达了要立刻执行一次，但仍由引擎保持固定批量上限。
            request = getattr(self._engine, "request_sync_check", None)
            if callable(request):
                request()
            return self._run_cycle_locked()

    def set_priority_contact(
        self, contact_id: UUID | None
    ) -> FrontSyncCycleReport | None:
        """快速登记最新查看联系人，唤醒单 worker 在下一切片应用。"""

        if contact_id is not None and not isinstance(contact_id, UUID):
            raise TypeError("contact_id 必须是 UUID 或 None。")
        with self._state_lock:
            if self._stop_event.is_set():
                raise SyncHostStopped("同步宿主已停止。")
            self._priority_contact_id = contact_id
            self._priority_requested_at = monotonic()
            self._priority_revision += 1
            self._wake_event.set()
            return self._latest

    def pause_backfill(self) -> FrontSyncCycleReport:
        with self._active_engine():
            pause = getattr(self._engine, "pause_backfill", None)
            if not callable(pause):
                raise RuntimeError("后台补齐控制不可用。")
            pause()
            return self._run_cycle_locked()

    def retry_backfill(self) -> FrontSyncCycleReport:
        with self._active_engine():
            retry = getattr(self._engine, "retry_backfill", None)
            if not callable(retry):
                raise RuntimeError("后台补齐控制不可用。")
            retry()
            return self._run_cycle_locked()

    def cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        with self._active_engine():
            return self._engine.list_cli_sessions()

    def cli_bindings(self) -> tuple[PersistedConversationBinding, ...]:
        with self._active_engine():
            return self._engine.list_cli_bindings()

    def revoke_cli_binding(
        self, *, contact_id: UUID, binding_id: UUID,
    ) -> PersistedConversationBinding:
        if not isinstance(contact_id, UUID) or not isinstance(binding_id, UUID):
            raise TypeError("绑定和联系人必须是 UUID。")
        with self._authority_change(timeout=4.0):
            return self._engine.revoke_cli_binding(
                contact_id=contact_id, binding_id=binding_id,
            )

    def confirm_cli_bindings(
        self,
        selections: Sequence[CliBindingSelection],
    ) -> FrontSyncCycleReport:
        with self._authority_change():
            report = self._engine.confirm_cli_bindings(selections)
            self._cache_report_locked(report)
            return report

    def confirm(
        self,
        *,
        contact_id: UUID,
        locator: str,
    ) -> FrontSyncCycleReport:
        """完成一次性绑定确认；确认被拒绝时抛出 BindingConfirmationError。"""

        if not isinstance(contact_id, UUID):
            raise TypeError("contact_id 必须是 UUID。")
        if not isinstance(locator, str) or not locator.strip():
            raise ValueError("locator 不能为空。")
        with self._authority_change():
            report = self._engine.confirm_binding(
                contact_id=contact_id,
                locator=locator,
            )
            self._cache_report_locked(report)
            return report

    def confirm_pending(
        self,
        *,
        contact_id: UUID,
        locator: str,
    ) -> FrontSyncCycleReport:
        """消费最近一次前台候选；确认时不重新要求微信仍在前台。"""

        if not isinstance(contact_id, UUID):
            raise TypeError("contact_id 必须是 UUID。")
        if not isinstance(locator, str) or not locator.strip():
            raise ValueError("locator 不能为空。")
        with self._authority_change():
            report = self._engine.confirm_pending_binding(
                contact_id=contact_id,
                locator=locator,
            )
            self._cache_report_locked(report)
            return report

    def sync_enabled(self) -> bool:
        with self._active_engine():
            return self._engine.sync_enabled()

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        with self._active_engine():
            # 每轮验证只展示本轮的最近有效观测，避免把上一次验证的结果
            # 误当成当前会话已经重新通过门禁。
            with self._state_lock:
                self._last_valid_observation = None
            report = self._engine.enable_follow_smoke()
            with self._state_lock:
                self._follow_smoke_active = True
            self._cache_report_locked(report)
            return report

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        with self._active_engine():
            report = self._engine.disable_follow_smoke()
            with self._state_lock:
                self._follow_smoke_active = False
            self._cache_report_locked(report)
            return report

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        with self._active_engine():
            report = self._engine.interrupt_follow_stream()
            self._cache_report_locked(report)
            return report

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        with self._state_lock:
            return self._runtime_status

    def last_valid_observation(self) -> LatestValidForegroundObservation | None:
        """读取最近一次有效前台观察；只返回元数据，不含消息正文。"""

        with self._state_lock:
            return self._last_valid_observation

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    @contextmanager
    def _authority_change(self, *, timeout: float | None = None) -> Iterator[None]:
        # 在排队等待后台 I/O 前撤销旧观察；多个授权操作不能互相提前开门。
        with self._state_lock:
            self._observation_generation += 1
            self._observation_mutations += 1
        try:
            with self._active_engine(timeout=timeout), self._foreground_lock:
                # 等待前台观察收尾期间也可能停机；拿齐锁后再次关闭门禁。
                if self._stop_event.is_set():
                    raise SyncHostStopped("同步宿主已停止。")
                yield
        finally:
            with self._state_lock:
                self._observation_mutations -= 1
                self._wake_event.set()

    @contextmanager
    def _active_foreground(self) -> Iterator[Callable[[], None]]:
        with self._state_lock:
            generation = self._observation_generation

        def check_current() -> None:
            with self._state_lock:
                if self._stop_event.is_set():
                    raise SyncHostStopped("同步宿主已停止。")
                if self._observation_mutations or generation != self._observation_generation:
                    raise SyncHostBusy("观察授权已变化，请重新观察。")

        check_current()
        if not self._foreground_lock.acquire(timeout=0.2):
            raise SyncHostBusy("前台观察仍在收尾，请重试。")
        try:
            check_current()
            yield check_current
        finally:
            self._foreground_lock.release()

    @contextmanager
    def _active_engine(self, *, timeout: float | None = None) -> Iterator[None]:
        # stop 先设事件；已排队的 API 获得同一锁后也不能重启读取。
        acquired = (
            self._engine_lock.acquire()
            if timeout is None
            else self._engine_lock.acquire(timeout=timeout)
        )
        if not acquired:
            raise SyncHostBusy("同步仍在收尾，请重试。")
        try:
            if self._stop_event.is_set():
                raise SyncHostStopped("同步宿主已停止。")
            yield
        finally:
            self._engine_lock.release()

    def _loop(self) -> None:
        # 启动先播种一轮初始化报告；随后只在同步开启时按心跳循环。
        with self._engine_lock:
            if self._stop_event.is_set():
                return
            self._run_cycle_guarded()
        while True:
            with self._state_lock:
                continuing = (
                    self._latest is not None and self._latest.sync_enabled
                    and self._latest.cli_pending_count > 0
                )
                authority_pending = self._observation_mutations > 0
                interval = (
                    None if authority_pending else 0 if continuing
                    else 0.25 if self._follow_smoke_active else self._interval
                )
            self._wake_event.wait(interval)
            self._wake_event.clear()
            if self._stop_event.is_set():
                return
            with self._engine_lock:
                if self._stop_event.is_set():
                    return
                with self._state_lock:
                    authority_pending = self._observation_mutations > 0
                if authority_pending:
                    continue
                try:
                    enabled = self._engine.sync_enabled()
                except Exception:
                    # 开关读取（查库）瞬时失败按关闭处理：本轮不执行
                    # cycle，线程保持存活，下个心跳重试；不泄露细节。
                    enabled = False
                if enabled:
                    self._run_cycle_guarded()

    def _run_cycle_guarded(self) -> FrontSyncCycleReport | None:
        """执行一轮 cycle；持久化等瞬时异常只丢弃本轮，不让循环线程死亡。"""

        try:
            return self._run_cycle_locked()
        except Exception:
            # 不泄露异常细节：本轮失败按无报告处理，下个心跳重试。
            return None

    def _run_cycle_locked(self) -> FrontSyncCycleReport:
        with self._state_lock:
            priority = self._priority_contact_id
            requested_at = self._priority_requested_at
            revision = self._priority_revision
        step = getattr(self._engine, "cycle_step", None)
        if callable(step):
            report = step(priority_contact_id=priority, priority_requested_at=requested_at)
        else:
            if revision != self._applied_priority_revision:
                self._engine.set_priority_contact(priority)
                self._applied_priority_revision = revision
            report = self._engine.cycle()
        self._cache_report_locked(report)
        return report

    def _cache_report_locked(self, report: FrontSyncCycleReport) -> None:
        """缓存当前报告，并在所有读取门禁通过时更新最近有效观测。"""

        runtime = self._engine.follow_runtime_status()
        with self._state_lock:
            self._latest = report
            self._runtime_status = runtime
            if not (
                report.sync_enabled
                and report.phase is FrontSyncPhase.ACTIVE
                and report.probe_available
                and report.wechat_in_front
                and report.cli_available
                and report.failure_code is None
                and report.active_contact_id is not None
            ):
                return
            self._last_valid_observation = LatestValidForegroundObservation(
                observed_at=datetime.now(timezone.utc),
                contact_id=report.active_contact_id,
                display_name=report.active_binding_display_name,
                watermark=runtime.watermark,
                batch_message_count=report.batch_message_count,
            )
