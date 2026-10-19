"""CLI 全量同步主引擎：后台正文读取与前台 OCR 定位双通道。"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime, timedelta, timezone
from typing import Protocol
from time import monotonic
from uuid import UUID

from notalone.front_sync.cli_binding import (
    CliBindingCandidateView,
    CliBindingCoordinator,
    CliBindingSelection,
)
from notalone.front_sync.cli_sync import (
    CLI_TASK_TIMEOUT_SECONDS,
    CliBackgroundSync,
    CliSyncCycleResult,
)
from notalone.front_sync.foreground_observation import FreshForegroundObservation
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
from notalone.persistence.conversation_repository import PersistedConversationBinding
from notalone.wechat_cli import CliAdapterError, LocalWechatCli


class SyncStatePort(Protocol):
    def read(self, *, owner_id: UUID) -> object:
        """读取用户同步开关。"""

    def read_bounded(self, *, owner_id: UUID) -> object:
        """有界读取新前台观察所需的同步总门禁。"""

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
    """面向 HTTP/App 的同步接口；后台 cycle 不触发视觉观察。"""

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
        "_cli_last_checked_at",
        "_priority_contact_id",
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
        self._cli_last_checked_at: datetime | None = None
        self._priority_contact_id: UUID | None = None

    def enable_sync(self) -> None:
        self._sync_state.enable(owner_id=self._owner_id, at=self._clock())
        self._cli_status = None
        self._cli_last_checked_at = None
        request = getattr(self._background, "request_backfill_check", None)
        if callable(request):
            request()

    def disable_sync(self) -> None:
        self._sync_state.disable(owner_id=self._owner_id, at=self._clock())
        self._background.close()

    def close(self) -> None:
        """关闭后台与兼容前台读取资源，但不改变持久化开关。"""

        self._background.close()
        close_fallback = getattr(self._fallback, "close", None)
        if callable(close_fallback):
            close_fallback()
        close_cli = getattr(self._cli, "close", None)
        if callable(close_cli):
            close_cli()

    def cancel_pending_io(self) -> None:
        """在同步线程退出前中断正在等待的 CLI 一次性命令。"""

        close_cli = getattr(self._cli, "close", None)
        if callable(close_cli):
            close_cli()

    def sync_enabled(self) -> bool:
        return bool(self._sync_state.read(owner_id=self._owner_id).enabled)

    def request_sync_check(self) -> None:
        """让手动检查绕过安全对账的低频等待，但仍按固定预算读取。"""

        self._cli_status = None
        self._cli_last_checked_at = None
        request = getattr(self._background, "request_backfill_check", None)
        if callable(request):
            request()
        else:
            self._background.request_safety_sweep()

    def pause_backfill(self) -> None:
        """暂停后台补齐，不改变同步开关或前台定位状态。"""

        pause = getattr(self._background, "pause_backfill", None)
        if not callable(pause):
            raise RuntimeError("后台补齐控制不可用。")
        pause()

    def retry_backfill(self) -> None:
        """恢复后台补齐并从可靠位置重新检查。"""

        self._cli_status = None
        self._cli_last_checked_at = None
        retry = getattr(self._background, "retry_backfill", None)
        if not callable(retry):
            raise RuntimeError("后台补齐控制不可用。")
        retry()

    def observe_foreground(self, *, deadline: float, check_current: Callable[[], None] | None = None) -> FreshForegroundObservation:
        """只读取本次前台投影，既有后台循环与缓存保持独立。"""

        if check_current is not None:
            check_current()
        if monotonic() >= deadline:
            return FreshForegroundObservation.create(
                phase="unavailable", reason="observation_timeout",
                probe_available=False, wechat_in_front=False,
            )
        read = getattr(self._sync_state, "read_bounded", None)
        if not callable(read):
            return FreshForegroundObservation.create(
                phase="unavailable", reason="sync_gate_unavailable",
                probe_available=False, wechat_in_front=False,
            )
        state = read(owner_id=self._owner_id)
        # DB的有界收尾可超过UI预算；过期后绝不晚启动视觉探针。
        remaining = deadline - monotonic()
        if remaining <= 0:
            return FreshForegroundObservation.create(
                phase="unavailable", reason="observation_timeout",
                probe_available=False, wechat_in_front=False,
            )
        if check_current is not None:
            check_current()
        if check_current is None:
            return self._foreground.observe_fresh(enabled=bool(state.enabled), deadline=deadline)
        return self._foreground.observe_fresh(
            enabled=bool(state.enabled), deadline=deadline, check_current=check_current,
        )

    def cycle(self) -> FrontSyncCycleReport:
        enabled = self.sync_enabled()
        background: CliSyncCycleResult = self._background.cycle(
            enabled=enabled,
            priority_contact_id=self._priority_contact_id,
        )
        return self._build_report(
            enabled=enabled,
            background=background,
            foreground=_unknown_foreground_status(enabled),
        )

    def cycle_step(
        self, *, priority_contact_id: UUID | None, priority_requested_at: float | None,
    ) -> FrontSyncCycleReport:
        """常驻宿主每次只读取一个绑定，随后归还控制以应用新的优先目标。"""
        self.set_priority_contact(priority_contact_id)
        return self._background_step(priority_requested_at=priority_requested_at)

    def _background_step(self, *, priority_requested_at: float | None = None) -> FrontSyncCycleReport:
        deadline = monotonic() + CLI_TASK_TIMEOUT_SECONDS
        enabled = self.sync_enabled()
        background = self._background.cycle(
            enabled=enabled, priority_contact_id=self._priority_contact_id,
            max_bindings=1, priority_requested_at=priority_requested_at,
            cli_deadline=deadline,
        )
        if background.cli_available is not None:
            self._cli_status = (background.cli_available, background.cli_failure_code)
            self._cli_last_checked_at = self._clock()
        return self._build_report(
            enabled=enabled, background=background,
            foreground=_unknown_foreground_status(enabled), refresh_cli=False,
        )

    def _build_report(
        self,
        *,
        enabled: bool,
        background: CliSyncCycleResult,
        foreground: ForegroundLocatorStatus,
        refresh_cli: bool = True,
    ) -> FrontSyncCycleReport:
        cli_available, cli_failure = (
            self._cli_availability() if refresh_cli else (self._cli_status or (False, None))
        )

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
            cli_priority_contact_id=background.status.priority_contact_id,
            cli_priority_last_success_at=background.status.priority_last_success_at,
            cli_priority_last_duration_ms=background.status.priority_last_duration_ms,
            cli_priority_last_cli_duration_ms=background.status.priority_last_cli_duration_ms,
            cli_priority_last_store_duration_ms=background.status.priority_last_store_duration_ms,
            cli_priority_last_failure_code=background.status.priority_last_failure_code,
            cli_priority_queue_wait_ms=background.status.priority_queue_wait_ms,
            cli_backfill_phase=background.status.backfill_phase,
            cli_backfill_contact_id=background.status.backfill_contact_id,
            cli_backfill_message_count=background.status.backfill_message_count,
            cli_backfill_non_text_count=background.status.backfill_non_text_count,
            cli_backfill_last_cursor=background.status.backfill_last_cursor,
            cli_backfill_failure_code=background.status.backfill_failure_code,
            cli_backfill_total_contacts=background.status.backfill_total_contacts,
            cli_backfill_completed_contacts=background.status.backfill_completed_contacts,
            cli_backfill_succeeded_contacts=background.status.backfill_succeeded_contacts,
            cli_backfill_skipped_contacts=background.status.backfill_skipped_contacts,
            cli_backfill_failed_contacts=background.status.backfill_failed_contacts,
            cli_backfill_incomplete_contacts=background.status.backfill_incomplete_contacts,
            cli_backfill_pending_contacts=background.status.backfill_pending_contacts,
            cli_backfill_total_message_count=background.status.backfill_total_message_count,
            cli_backfill_total_non_text_count=background.status.backfill_total_non_text_count,
            foreground_phase=foreground.phase.value,
            foreground_failure_code=foreground.failure_code,
        )
        return report

    def set_priority_contact(self, contact_id: UUID | None) -> None:
        """设置当前应用查看联系人，供后台下一轮读取时优先处理。"""

        if contact_id is not None and not isinstance(contact_id, UUID):
            raise TypeError("contact_id 必须是 UUID 或 None。")
        self._priority_contact_id = contact_id

    def list_cli_sessions(self) -> tuple[CliBindingCandidateView, ...]:
        """读取批量绑定预览；不要求微信在前台。"""

        return self._binding_coordinator.list_candidates()

    def list_cli_bindings(self) -> tuple[PersistedConversationBinding, ...]:
        """读取当前运行范围的有效授权，不调用 CLI 或探针。"""

        return self._binding_coordinator.list_bindings()

    def revoke_cli_binding(
        self, *, contact_id: UUID, binding_id: UUID,
    ) -> PersistedConversationBinding:
        """撤销授权，不主动执行读取；下一轮使用新的 active 快照。"""

        return self._binding_coordinator.revoke_binding(
            contact_id=contact_id, binding_id=binding_id,
        )

    def confirm_cli_bindings(
        self,
        selections: Sequence[CliBindingSelection],
    ) -> FrontSyncCycleReport:
        """提交一次性批量绑定，然后返回双通道最新状态。"""

        self._binding_coordinator.confirm(selections)
        # 新绑定不应等待下一次低频安全对账；仍由后台自己的 cursor、
        # 初始 baseline 和固定批量上限决定实际读取范围。
        request = getattr(self._background, "request_backfill_check", None)
        if callable(request):
            request()
        else:
            self._background.request_safety_sweep()
        # 批量绑定在 NotAlone 界面完成，不应为了返回状态再次触发
        # 屏幕录制/OCR，也不以旧前台身份刷新当前联系人。
        return self._background_step()

    # ------------------------------------------------------------------
    # 当前全局流诊断；绑定确认仍保留旧兼容入口
    # ------------------------------------------------------------------

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        if not self.sync_enabled():
            raise ValueError("同步未开启，不能开始全局流诊断。")
        self._background.enable_follow_smoke()
        return self._follow_diagnostic_report()

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        self._background.disable_follow_smoke()
        return self._follow_diagnostic_report()

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        if not self.sync_enabled():
            raise ValueError("同步未开启，不能中断全局流。")
        self._background.interrupt_follow_stream()
        return self._follow_diagnostic_report()

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        return self._background.follow_runtime_status()

    def _follow_diagnostic_report(self) -> FrontSyncCycleReport:
        """诊断只刷新正式后台通道，不调用OCR或旧前台引擎。"""
        return self._background_step()

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
        now = self._clock()
        retry_unavailable = (
            self._cli_status is not None
            and not self._cli_status[0]
            and (
                self._cli_last_checked_at is None
                or now >= self._cli_last_checked_at + timedelta(seconds=15)
            )
        )
        if self._cli_status is None or retry_unavailable:
            try:
                self._cli.version(timeout_seconds=CLI_TASK_TIMEOUT_SECONDS)
            except CliAdapterError as error:
                self._cli_status = (False, error.code)
            else:
                self._cli_status = (True, None)
            self._cli_last_checked_at = now
        return self._cli_status


def _unknown_foreground_status(enabled: bool) -> ForegroundLocatorStatus:
    # 兼容布尔字段仅表示没有有效观察；固定原因明确区分未观察与实测非前台。
    return ForegroundLocatorStatus(
        phase=(
            FrontSyncPhase.UNAVAILABLE
            if enabled
            else FrontSyncPhase.SYNC_DISABLED
        ),
        probe_available=False,
        wechat_in_front=False,
        failure_code="foreground_not_observed",
        active_contact_id=None,
        active_binding_display_name=None,
        decision_reason=None,
        candidates=(),
    )
