"""后端进程内的前台同步宿主：在常驻进程里驱动同步循环。

菜单栏不再每 3 秒拉起子进程执行 ``front-sync status``；同步循环的权威
驱动方变为后端常驻进程（ADR-020）。SyncHost 持有应用层 FrontSyncEngine，
启动时播种一轮初始化报告，之后只在同步开启时按心跳间隔执行 cycle，
并缓存最近一次报告供状态 API 返回。
"""

from __future__ import annotations

import threading
from uuid import UUID
from typing import Protocol

from notalone.front_sync.sync_engine import (
    BindingConfirmationError,
    FrontSyncCycleReport,
)
from notalone.front_sync.tail_lifecycle import FollowRuntimeStatus


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

    def confirm(
        self,
        *,
        contact_id: UUID,
        locator: str,
    ) -> FrontSyncCycleReport:
        """完成一次性绑定确认并立即执行一轮，返回最新报告。"""


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
        "_lock",
        "_latest",
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
        self._lock = threading.Lock()
        self._latest: FrontSyncCycleReport | None = None
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def start(self) -> None:
        """启动后台循环线程；重复启动会抛出 RuntimeError。"""

        with self._lock:
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
        """停止后台循环并等待线程退出；未启动时无操作。"""

        with self._lock:
            thread = self._thread
            self._thread = None
        if thread is None:
            return
        self._stop_event.set()
        thread.join(timeout=max(self._interval * 2, 5.0))

    # ------------------------------------------------------------------
    # 状态与控制端口
    # ------------------------------------------------------------------

    def status(self) -> FrontSyncCycleReport | None:
        with self._lock:
            return self._latest

    def enable(self) -> FrontSyncCycleReport:
        with self._lock:
            self._engine.enable_sync()
            return self._run_cycle_locked()

    def disable(self) -> FrontSyncCycleReport:
        with self._lock:
            self._engine.disable_sync()
            return self._run_cycle_locked()

    def check(self) -> FrontSyncCycleReport:
        with self._lock:
            return self._run_cycle_locked()

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
        with self._lock:
            report = self._engine.confirm_binding(
                contact_id=contact_id,
                locator=locator,
            )
            self._latest = report
            return report

    def sync_enabled(self) -> bool:
        with self._lock:
            return self._engine.sync_enabled()

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        with self._lock:
            report = self._engine.enable_follow_smoke()
            self._follow_smoke_active = True
            self._latest = report
            return report

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        with self._lock:
            report = self._engine.disable_follow_smoke()
            self._follow_smoke_active = False
            self._latest = report
            return report

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        with self._lock:
            report = self._engine.interrupt_follow_stream()
            self._latest = report
            return report

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        with self._lock:
            return self._engine.follow_runtime_status()

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _loop(self) -> None:
        # 启动先播种一轮初始化报告；随后只在同步开启时按心跳循环。
        with self._lock:
            self._run_cycle_guarded()
        while True:
            with self._lock:
                interval = 0.25 if self._follow_smoke_active else self._interval
            if self._stop_event.wait(interval):
                return
            with self._lock:
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
        self._latest = report
        return report
