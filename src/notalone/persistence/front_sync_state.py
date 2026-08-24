"""前台同步开关状态的 PostgreSQL 持久化。

同步只能由用户手动开启或关闭；开关状态必须跨应用重启保留，
异常重启后仍开启时生命周期从联系人水位恢复读取。最近一次关闭
与开启的时间戳共同界定手动关闭期间的消息窗口：重新开启后读到
的该窗口内消息只前移水位、不写入，对每个联系人独立生效。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

import psycopg


class FrontSyncStatePersistenceError(RuntimeError):
    """不暴露 SQL 或连接信息的同步开关持久化错误。"""


@dataclass(frozen=True, slots=True)
class FrontSyncState:
    """一个 owner 的前台同步开关状态与最近开关时间。"""

    owner_id: UUID
    enabled: bool
    enabled_at: datetime | None = None
    disabled_at: datetime | None = None
    updated_at: datetime | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")


class PostgresFrontSyncStateStore:
    """按 owner 保存前台同步开关；没有记录时视为关闭。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def read(self, *, owner_id: UUID) -> FrontSyncState:
        """读取开关状态；没有记录或 owner 已删除时返回默认关闭。"""

        self._validate_owner(owner_id)
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT enabled, enabled_at, disabled_at, updated_at
                    FROM public.front_sync_state
                    WHERE owner_id = %s
                    """,
                    (owner_id,),
                ).fetchone()
        except psycopg.Error:
            raise FrontSyncStatePersistenceError("同步开关读取失败。") from None
        if row is None:
            return FrontSyncState(owner_id=owner_id, enabled=False)
        enabled, enabled_at, disabled_at, updated_at = row
        return FrontSyncState(
            owner_id=owner_id,
            enabled=bool(enabled),
            enabled_at=enabled_at,
            disabled_at=disabled_at,
            updated_at=updated_at,
        )

    def enable(
        self,
        *,
        owner_id: UUID,
        at: datetime | None = None,
    ) -> FrontSyncState:
        """用户手动开启同步；记录开启时间，关闭窗口由两个时间戳界定。"""

        return self._set_enabled(owner_id, enabled=True, at=at)

    def disable(
        self,
        *,
        owner_id: UUID,
        at: datetime | None = None,
    ) -> FrontSyncState:
        """用户手动关闭同步；记录关闭时间，其后的消息窗口不被写入。"""

        return self._set_enabled(owner_id, enabled=False, at=at)

    def _set_enabled(
        self,
        owner_id: UUID,
        *,
        enabled: bool,
        at: datetime | None,
    ) -> FrontSyncState:
        self._validate_owner(owner_id)
        if at is not None and not isinstance(at, datetime):
            raise TypeError("开关时间必须是 datetime 或 None。")
        moment = "COALESCE(%s, now())"
        timestamp_column = "enabled_at" if enabled else "disabled_at"
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"""
                    INSERT INTO public.front_sync_state (
                        owner_id, enabled, {timestamp_column}
                    )
                    VALUES (%s, %s, {moment})
                    ON CONFLICT (owner_id) DO UPDATE
                    SET enabled = EXCLUDED.enabled,
                        {timestamp_column} = COALESCE(EXCLUDED.{timestamp_column}, now()),
                        updated_at = now()
                    RETURNING owner_id, enabled, enabled_at, disabled_at, updated_at
                    """,
                    (owner_id, enabled, at),
                ).fetchone()
                connection.commit()
        except psycopg.errors.ForeignKeyViolation:
            raise FrontSyncStatePersistenceError(
                "同步开关只能保存在存在的用户范围上。"
            ) from None
        except psycopg.Error:
            raise FrontSyncStatePersistenceError("同步开关写入失败。") from None
        if row is None:
            raise FrontSyncStatePersistenceError("无法确认同步开关写入结果。")
        _, state_enabled, enabled_at, disabled_at, updated_at = row
        return FrontSyncState(
            owner_id=owner_id,
            enabled=bool(state_enabled),
            enabled_at=enabled_at,
            disabled_at=disabled_at,
            updated_at=updated_at,
        )

    @staticmethod
    def _validate_owner(owner_id: UUID) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(self._database_url)
