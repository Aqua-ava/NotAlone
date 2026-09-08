"""后端进程内的前台同步宿主：在常驻进程里驱动同步循环。

菜单栏不再每 3 秒拉起子进程执行 ``front-sync status``；同步循环的权威
驱动方变为后端常驻进程（ADR-020）。SyncHost 持有应用层 FrontSyncEngine，
启动时播种一轮初始化报告，之后只在同步开启时按心跳间隔执行 cycle，
并缓存最近一次报告供状态 API 返回。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from collections.abc import Sequence
from typing import Protocol
from uuid import UUID

from notalone.front_sync.cli_binding import (
    CliBindingCandidateView,
    CliBindingSelection,
)
from notalone.front_sync.sync_engine import (
    BindingConfirmationError,
    FrontSyncCycleReport,
)
from notalone.front_sync.tail_lifecycle import FrontSyncPhase, FollowRuntimeStatus


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

    def sync_enabled(self) -> bool:
        """读取当前同步开关（不触发探针或 CLI）。"""

    def request_sync_check(self) -> None:
        """请求一次有界后台同步检查。"""

    def pause_backfill(self) -> None:
        """暂停后台补齐。"""

    def retry_backfill(self) -> None:
        """恢复后台补齐。"""

    def close(self) -> None:
        """关闭进程内读取资源，但不修改持久化同步开关。"""

    def list_cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        """读取 CLI 可见的私聊会话候选；不要求微信在前台。"""

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

    def status(self) -> FrontSyncCycleReport | None:
        """返回最近一次循环报告；尚未运行过循环时返回 None。"""

    def enable(self) -> FrontSyncCycleReport:
        """开启同步并立即执行一轮，返回最新报告。"""

    def disable(self) -> FrontSyncCycleReport:
        """关闭同步并立即执行一轮，返回最新报告。"""

    def check(self) -> FrontSyncCycleReport:
        """立即执行一轮并返回最新报告。"""

    def pause_backfill(self) -> FrontSyncCycleReport:
        """暂停后台补齐并返回最新报告。"""

    def retry_backfill(self) -> FrontSyncCycleReport:
        """恢复后台补齐并返回最新报告。"""

    def cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        """读取 CLI 可见的私聊会话候选。"""

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


class SyncHost:
    """常驻同步宿主：后台线程按心跳驱动引擎循环，接口层操作受锁保护。

    引擎（FrontSyncEngine）不是线程安全的；所有 engine 调用都在同一把锁
    内完成。循环策略：启动时播种一轮初始化报告（即使同步关闭也执行一次，
    让状态 API 尽快有值）；之后只在同步开启时按心跳执行 cycle，关闭期间
    不循环也不拉起探针子进程。
    """

    __slots__ = (
        "_engine",
        "_follow_smoke_active",
        "_interval",
        "_engine_lock",
        "_state_lock",
        "_latest",
        "_runtime_status",
        "_last_valid_observation",
        "_stop_event",
        "_thread",
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
        self._state_lock = threading.Lock()
        self._latest: FrontSyncCycleReport | None = None
        self._runtime_status = FollowRuntimeStatus(
            enabled=False,
            stream_active=False,
        )
        self._last_valid_observation: LatestValidForegroundObservation | None = None
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def start(self) -> None:
        """启动后台循环线程；重复启动会抛出 RuntimeError。"""

        with self._state_lock:
            if self._thread is not None:
                raise RuntimeError("同步宿主已经启动。")
            self._stop_event.clear()
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
            thread = self._thread
            self._thread = None
        if thread is not None:
            self._stop_event.set()
            # 同步线程可能正阻塞在 CLI 一次性命令里；先调用一个只负责
            # 终止 I/O 的可选钩子，再等待线程，避免退出时被命令超时拖住。
            cancel = getattr(self._engine, "cancel_pending_io", None)
            if callable(cancel):
                cancel()
            thread.join(timeout=max(self._interval * 2, 5.0))
        with self._engine_lock:
            close = getattr(self._engine, "close", None)
            if callable(close):
                close()

    # ------------------------------------------------------------------
    # 状态与控制端口
    # ------------------------------------------------------------------

    def status(self) -> FrontSyncCycleReport | None:
        with self._state_lock:
            return self._latest

    def enable(self) -> FrontSyncCycleReport:
        with self._engine_lock:
            self._engine.enable_sync()
            return self._run_cycle_locked()

    def disable(self) -> FrontSyncCycleReport:
        with self._engine_lock:
            self._engine.disable_sync()
            return self._run_cycle_locked()

    def check(self) -> FrontSyncCycleReport:
        with self._engine_lock:
            # CLI 全量同步的安全对账是低频的；用户点击“立即检查”时
            # 明确表达了要立刻执行一次，但仍由引擎保持固定批量上限。
            request = getattr(self._engine, "request_sync_check", None)
            if callable(request):
                request()
            return self._run_cycle_locked()

    def pause_backfill(self) -> FrontSyncCycleReport:
        with self._engine_lock:
            pause = getattr(self._engine, "pause_backfill", None)
            if not callable(pause):
                raise RuntimeError("后台补齐控制不可用。")
            pause()
            return self._run_cycle_locked()

    def retry_backfill(self) -> FrontSyncCycleReport:
        with self._engine_lock:
            retry = getattr(self._engine, "retry_backfill", None)
            if not callable(retry):
                raise RuntimeError("后台补齐控制不可用。")
            retry()
            return self._run_cycle_locked()

    def cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        with self._engine_lock:
            return self._engine.list_cli_sessions()

    def confirm_cli_bindings(
        self,
        selections: Sequence[CliBindingSelection],
    ) -> FrontSyncCycleReport:
        with self._engine_lock:
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
        with self._engine_lock:
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
        with self._engine_lock:
            report = self._engine.confirm_pending_binding(
                contact_id=contact_id,
                locator=locator,
            )
            self._cache_report_locked(report)
            return report

    def sync_enabled(self) -> bool:
        with self._engine_lock:
            return self._engine.sync_enabled()

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        with self._engine_lock:
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
        with self._engine_lock:
            report = self._engine.disable_follow_smoke()
            with self._state_lock:
                self._follow_smoke_active = False
            self._cache_report_locked(report)
            return report

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        with self._engine_lock:
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

    def _loop(self) -> None:
        # 启动先播种一轮初始化报告；随后只在同步开启时按心跳循环。
        with self._engine_lock:
            self._run_cycle_guarded()
        while True:
            with self._state_lock:
                interval = 0.25 if self._follow_smoke_active else self._interval
            if self._stop_event.wait(interval):
                return
            with self._engine_lock:
                if self._engine.sync_enabled():
                    self._run_cycle_guarded()

    def _run_cycle_guarded(self) -> FrontSyncCycleReport | None:
        """执行一轮 cycle；持久化等瞬时异常只丢弃本轮，不让循环线程死亡。"""

        try:
            return self._run_cycle_locked()
        except Exception:
            # 不泄露异常细节：本轮失败按无报告处理，下个心跳重试。
            return None

    def _run_cycle_locked(self) -> FrontSyncCycleReport:
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
