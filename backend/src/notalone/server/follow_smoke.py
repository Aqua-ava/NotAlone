"""真实微信 follow 人工验证的本地诊断接缝。

这个模块只编排人工验证，不改变正式同步策略。界面能够显式
观察全局流、记录元数据检查点和中断当前流；联系人正文始终
不进入诊断状态或检查点。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol
from uuid import UUID

import psycopg

from notalone.front_sync.sync_engine import FrontSyncCycleReport
from notalone.front_sync.tail_lifecycle import FollowRuntimeStatus
from notalone.server.sync_host import LatestValidForegroundObservation


FOLLOW_SMOKE_CHECKPOINT_LABELS = frozenset(
    {
        "baseline",
        "before_follow",
        "after_live_message",
        "after_idle",
        "after_follow_restart",
        "wechat_background",
        "after_reenable",
        "final",
    }
)


class FollowSmokeHostPort(Protocol):
    """人工验证控制器依赖的同步宿主最小接口。"""

    def sync_enabled(self) -> bool:
        """读取正式同步开关；不会自动替用户开启。"""

    def status(self) -> FrontSyncCycleReport | None:
        """读取最近一次正式同步报告。"""

    def enable_follow_smoke(self) -> FrontSyncCycleReport:
        """开启 follow 优先策略并运行一轮。"""

    def disable_follow_smoke(self) -> FrontSyncCycleReport:
        """关闭 follow 优先策略并恢复轮询。"""

    def interrupt_follow_stream(self) -> FrontSyncCycleReport:
        """中断当前 follow 流并运行一轮。"""

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        """读取 follow 运行时投影。"""

    def last_valid_observation(self) -> LatestValidForegroundObservation | None:
        """读取最近一次有效前台观察的元数据。"""


class FollowSmokeSnapshotPort(Protocol):
    """读取联系人级验证元数据的最小接口。"""

    def snapshot(
        self,
        *,
        owner_id: UUID,
    ) -> tuple[FollowSmokeContactSnapshot, ...]:
        """只返回计数、绑定、水位和去重统计。"""


class FollowSmokeRequestInvalid(ValueError):
    """人工验证请求不符合固定契约。"""


class FollowSmokeRejected(RuntimeError):
    """人工验证操作因当前生命周期被拒绝。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


class FollowSmokeSnapshotError(RuntimeError):
    """诊断快照读取失败，不暴露 SQL 或数据库连接细节。"""


@dataclass(frozen=True, slots=True)
class FollowSmokeContactSnapshot:
    """一个联系人在验证时的最小数据库投影；不含联系人名称和正文。"""

    contact_id: UUID
    bound: bool
    message_count: int
    observation_ref_count: int
    watermark: int | None
    latest_mode: str
    duplicate_identities: int


@dataclass(frozen=True, slots=True)
class FollowSmokeCheckpoint:
    """人工确认的一个元数据检查点。"""

    label: str
    recorded_at: datetime
    contacts: tuple[FollowSmokeContactSnapshot, ...]

    @property
    def watermark(self) -> int | None:
        """返回首个联系人水位，便于单联系人冒烟结果快速查看。"""

        return self.contacts[0].watermark if self.contacts else None


@dataclass(frozen=True, slots=True)
class FollowSmokeStatus:
    """供 App 展示和人工记录的验证状态；不含消息正文。"""

    active: bool
    runtime: FollowRuntimeStatus
    report: FrontSyncCycleReport | None
    last_valid_observation: LatestValidForegroundObservation | None
    contacts: tuple[FollowSmokeContactSnapshot, ...]
    checkpoints: tuple[FollowSmokeCheckpoint, ...]

    @property
    def follow_stream_active(self) -> bool:
        """兼容界面使用的扁平化流状态。"""

        return self.runtime.stream_active


class FollowSmokeController:
    """把 App 的人工点击映射到唯一的常驻同步宿主。"""

    __slots__ = (
        "_clock",
        "_host",
        "_owner_id",
        "_active",
        "_checkpoints",
        "_snapshots",
    )

    def __init__(
        self,
        *,
        owner_id: UUID,
        host: FollowSmokeHostPort,
        snapshots: FollowSmokeSnapshotPort,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        self._owner_id = owner_id
        self._host = host
        self._snapshots = snapshots
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._active = False
        self._checkpoints: list[FollowSmokeCheckpoint] = []

    def status(self) -> FollowSmokeStatus:
        """读取当前验证状态和 owner 范围内的元数据快照。"""

        return FollowSmokeStatus(
            active=self._active,
            runtime=self._host.follow_runtime_status(),
            report=self._host.status(),
            last_valid_observation=self._host.last_valid_observation(),
            contacts=self._snapshots.snapshot(owner_id=self._owner_id),
            checkpoints=tuple(self._checkpoints),
        )

    def start(self) -> FollowSmokeStatus:
        """显式开启 follow 验证；正式同步关闭时拒绝，不自动开启。"""

        if self._active:
            raise FollowSmokeRejected(
                "already_active", "follow 验证已经在进行中。"
            )
        if not self._host.sync_enabled():
            raise FollowSmokeRejected(
                "sync_disabled",
                "请先在 App 中开启同步，再开始全局流验证。",
            )
        self._checkpoints.clear()
        try:
            self._host.enable_follow_smoke()
        except Exception:
            # 首轮失败时结束诊断，避免留下半开启状态；正式同步策略不变。
            try:
                self._host.disable_follow_smoke()
            except Exception:
                pass
            raise
        self._active = True
        return self.status()

    def stop(self) -> FollowSmokeStatus:
        """结束诊断；正常后台同步继续，不能视为关闭读取。"""

        if self._active:
            self._host.disable_follow_smoke()
        self._active = False
        return self.status()

    def interrupt(self) -> FollowSmokeStatus:
        """显式中断 follow 流，保留验证会话以便观察恢复。"""

        if not self._active:
            raise FollowSmokeRejected(
                "not_active", "follow 验证尚未开始。"
            )
        if not self._host.follow_runtime_status().stream_active:
            raise FollowSmokeRejected(
                "follow_stream_not_active", "当前没有可中断的 follow 流。"
            )
        self._host.interrupt_follow_stream()
        return self.status()

    def checkpoint(self, label: str) -> FollowSmokeStatus:
        """记录固定标签的元数据检查点，不接受自由文本。"""

        if not isinstance(label, str) or label not in FOLLOW_SMOKE_CHECKPOINT_LABELS:
            raise FollowSmokeRequestInvalid()
        if not self._active:
            raise FollowSmokeRejected(
                "not_active", "follow 验证尚未开始。"
            )
        contacts = self._snapshots.snapshot(owner_id=self._owner_id)
        self._checkpoints.append(
            FollowSmokeCheckpoint(
                label=label,
                recorded_at=self._clock(),
                contacts=contacts,
            )
        )
        return self.status()


class PostgresFollowSmokeSnapshotReader:
    """从 PostgreSQL 读取人工验证所需的 owner/contact 元数据。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def snapshot(
        self,
        *,
        owner_id: UUID,
    ) -> tuple[FollowSmokeContactSnapshot, ...]:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(
                    """
                    SELECT c.id,
                           EXISTS (
                               SELECT 1
                               FROM public.conversation_binding b
                               WHERE b.owner_id = c.owner_id
                                 AND b.contact_id = c.id
                                 AND b.channel = 'wechat'
                                 AND b.status = 'active'
                           ) AS bound,
                           (SELECT count(*) FROM public.message m
                            WHERE m.owner_id = c.owner_id
                              AND m.contact_id = c.id),
                           (SELECT count(*) FROM public.message_source_ref ref
                            WHERE ref.owner_id = c.owner_id
                              AND ref.contact_id = c.id
                              AND ref.source_kind = 'local_wechat_observation'),
                           (SELECT cur.last_local_id
                            FROM public.wechat_observation_cursor cur
                            WHERE cur.owner_id = c.owner_id
                              AND cur.contact_id = c.id),
                           COALESCE((
                               SELECT obs.mode
                               FROM public.local_wechat_observation obs
                               WHERE obs.owner_id = c.owner_id
                                 AND obs.contact_id = c.id
                               ORDER BY obs.read_at DESC
                               LIMIT 1
                           ), 'none'),
                           (SELECT count(*) FROM (
                               SELECT metadata.external_local_id,
                                      COALESCE(metadata.source_create_time, -1)
                               FROM public.wechat_message_metadata metadata
                               WHERE metadata.owner_id = c.owner_id
                                 AND metadata.contact_id = c.id
                               GROUP BY metadata.external_local_id,
                                        COALESCE(metadata.source_create_time, -1)
                               HAVING count(*) > 1
                           ) duplicate_identities)
                    FROM public.contact c
                    WHERE c.owner_id = %s
                    ORDER BY c.id
                    """,
                    (owner_id,),
                ).fetchall()
        except psycopg.Error:
            raise FollowSmokeSnapshotError("人工验证快照读取失败。") from None
        return tuple(
            FollowSmokeContactSnapshot(
                contact_id=row[0],
                bound=bool(row[1]),
                message_count=int(row[2]),
                observation_ref_count=int(row[3]),
                watermark=None if row[4] is None else int(row[4]),
                latest_mode=str(row[5]),
                duplicate_identities=int(row[6]),
            )
            for row in rows
        )
