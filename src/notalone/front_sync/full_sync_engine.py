"""CLI 全量同步主引擎：后台正文读取与前台 OCR 定位双通道。"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from typing import Protocol
from uuid import UUID

from notalone.front_sync.cli_binding import (
    CliBindingCandidateView,
    CliBindingCoordinator,
    CliBindingSelection,
)
from notalone.front_sync.cli_sync import CliBackgroundSync, CliSyncCycleResult
from notalone.front_sync.foreground_locator import (
    ForegroundLocator,
    ForegroundLocatorStatus,
)
from notalone.front_sync.sync_engine import (
    BindingConfirmationError,
    FrontSyncCycleReport,
)
from notalone.front_sync.tail_lifecycle import FrontSyncPhase, FollowRuntimeStatus
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.wechat_cli import CliAdapterError, LocalWechatCli


class SyncStatePort(Protocol):
    def read(self, *, owner_id: UUID) -> object:
        """读取用户同步开关。"""

    def enable(self, *, owner_id: UUID, at: datetime | None = None) -> object:
        """开启用户同步开关。"""

    def disable(self, *, owner_id: UUID, at: datetime | None = None) -> object:
        """关闭用户同步开关。"""


class LegacyForegroundEnginePort(Protocol):
    """人工 Follow 与旧绑定确认的兼容入口。"""

    def enable_follow_smoke(self) -> FrontSyncCycleReport: ...

    def disable_follow_smoke(self) -> FrontSyncCycleReport: ...

    def interrupt_follow_stream(self) -> FrontSyncCycleReport: ...

    def follow_runtime_status(self) -> FollowRuntimeStatus: ...

    def confirm_binding(self, *, contact_id: UUID, locator: str) -> FrontSyncCycleReport: ...

    def confirm_pending_binding(
        self, *, contact_id: UUID, locator: str
    ) -> FrontSyncCycleReport: ...


class CliFullSyncEngine:
    """面向 HTTP/App 的同步接口；正常 cycle 不调用旧前台 tail。"""

    __slots__ = (
        "_owner_id",
        "_channel",
        "_account_scope",
        "_cli",
        "_sync_state",
        "_background",
        "_foreground",
        "_binding_coordinator",
        "_fallback",
        "_clock",
        "_cli_status",
        "_last_foreground_status",
    )

    def __init__(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        cli: LocalWechatCli,
        sync_state: SyncStatePort | PostgresFrontSyncStateStore,
        background: CliBackgroundSync,
        foreground: ForegroundLocator,
        binding_coordinator: CliBindingCoordinator,
        fallback: LegacyForegroundEnginePort,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        self._owner_id = owner_id
        self._channel = channel
        self._account_scope = account_scope
        self._cli = cli
        self._sync_state = sync_state
        self._background = background
        self._foreground = foreground
        self._binding_coordinator = binding_coordinator
        self._fallback = fallback
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._cli_status: tuple[bool, str | None] | None = None
        self._last_foreground_status: ForegroundLocatorStatus | None = None

    def enable_sync(self) -> None:
        self._sync_state.enable(owner_id=self._owner_id, at=self._clock())

    def disable_sync(self) -> None:
        self._sync_state.disable(owner_id=self._owner_id, at=self._clock())
        self._background.close()

    def close(self) -> None:
        """关闭后台与兼容前台读取资源，但不改变持久化开关。"""

        self._background.close()
        close_fallback = getattr(self._fallback, "close", None)
        if callable(close_fallback):
            close_fallback()

    def sync_enabled(self) -> bool:
        return bool(self._sync_state.read(owner_id=self._owner_id).enabled)

    def cycle(self) -> FrontSyncCycleReport:
        enabled = self.sync_enabled()
        background: CliSyncCycleResult = self._background.cycle(enabled=enabled)
        foreground: ForegroundLocatorStatus = self._foreground.observe(enabled=enabled)
        self._last_foreground_status = foreground
        return self._build_report(
            enabled=enabled,
            background=background,
            foreground=foreground,
        )

    def _build_report(
        self,
        *,
        enabled: bool,
        background: CliSyncCycleResult,
        foreground: ForegroundLocatorStatus,
    ) -> FrontSyncCycleReport:
        cli_available, cli_failure = self._cli_availability()

        if not enabled:
            phase = FrontSyncPhase.SYNC_DISABLED
        elif not cli_available:
            phase = FrontSyncPhase.FAILED
        elif background.status.bound_count == 0:
            phase = FrontSyncPhase.UNAVAILABLE
        else:
            # 全局 Follow 降级是后台通道的状态，不应把 OCR 是否前台
            # 重新变成整个同步的门禁。
            phase = FrontSyncPhase.ACTIVE
        report = FrontSyncCycleReport(
            sync_enabled=enabled,
            phase=phase,
            probe_available=foreground.probe_available,
            wechat_in_front=foreground.wechat_in_front,
            cli_available=cli_available,
            failure_code=cli_failure,
            active_contact_id=foreground.active_contact_id,
            active_binding_display_name=foreground.active_binding_display_name,
            decision_reason=foreground.decision_reason,
            candidates=foreground.candidates,
            batch_message_count=background.batch_message_count,
            sync_mode="cli_background",
            cli_sync_phase=background.status.phase.value,
            cli_sync_mode=background.status.stream_mode,
            cli_stream_active=background.status.stream_active,
            cli_bound_count=background.status.bound_count,
            cli_pending_count=background.status.pending_count,
            cli_batch_message_count=background.batch_message_count,
            cli_failure_code=background.status.failure_code,
            foreground_phase=foreground.phase.value,
            foreground_failure_code=foreground.failure_code,
        )
        return report

    def list_cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        """读取批量绑定预览；不要求微信在前台。"""

        return self._binding_coordinator.list_candidates()

    def confirm_cli_bindings(
        self,
        selections: Sequence[CliBindingSelection],
    ) -> FrontSyncCycleReport:
        """提交一次性批量绑定，然后返回双通道最新状态。"""

        self._binding_coordinator.confirm(selections)
        # 批量绑定在 NotAlone 界面完成，不应为了返回状态再次触发
        # 屏幕录制/OCR；沿用最近一次前台状态，后台通道立即刷新。
        enabled = self.sync_enabled()
        background = self._background.cycle(enabled=enabled)
        foreground = self._last_foreground_status or _unknown_foreground_status(enabled)
        return self._build_report(
            enabled=enabled,
            background=background,
            foreground=foreground,
        )

    # ------------------------------------------------------------------
    # 兼容旧人工验证与前台绑定确认
    # ------------------------------------------------------------------

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        return self._fallback.enable_follow_smoke()

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        return self._fallback.disable_follow_smoke()

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        return self._fallback.interrupt_follow_stream()

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        return self._fallback.follow_runtime_status()

    def confirm_binding(self, *, contact_id: UUID, locator: str) -> FrontSyncCycleReport:
        return self._fallback.confirm_binding(contact_id=contact_id, locator=locator)

    def confirm_pending_binding(
        self, *, contact_id: UUID, locator: str
    ) -> FrontSyncCycleReport:
        return self._fallback.confirm_pending_binding(
            contact_id=contact_id,
            locator=locator,
        )

    def _cli_availability(self) -> tuple[bool, str | None]:
        if self._cli_status is None:
            try:
                self._cli.version()
            except CliAdapterError as error:
                self._cli_status = (False, error.code)
            else:
                self._cli_status = (True, None)
        return self._cli_status


def _unknown_foreground_status(enabled: bool) -> ForegroundLocatorStatus:
    return ForegroundLocatorStatus(
        phase=(
            FrontSyncPhase.WAITING_FOREGROUND
            if enabled
            else FrontSyncPhase.SYNC_DISABLED
        ),
        probe_available=True,
        wechat_in_front=False,
        failure_code=None,
        active_contact_id=None,
        active_binding_display_name=None,
        decision_reason=None,
        candidates=(),
    )
