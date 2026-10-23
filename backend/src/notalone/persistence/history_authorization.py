"""历史同步授权版本的 PostgreSQL 持久化。

授权按 ``owner_id + channel + account_scope`` 保存，只记录用户明确作出的
决定和当时展示的版本。行不存在表示旧授权：它只允许增量同步，不能按范围、
总开关或既有绑定推断历史读取资格。版本低于当前值同样回到“待确认”。

同一授权范围的并发确认由主键冲突串行化；``accepted`` 一旦写入，迟到的
``declined`` 不会把它降级，因此响应丢失或并发刷新不会收回历史读取资格。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Literal, Protocol
from uuid import UUID

import psycopg


HISTORY_SYNC_AUTHORIZATION_VERSION = 1
HistoryAuthorizationDecision = Literal["accepted", "declined"]


class HistoryAuthorizationStorePort(Protocol):
    """同步引擎使用的授权版本读写端口。"""

    def read(
        self, *, owner_id: UUID, channel: str, account_scope: str
    ) -> "HistoryAuthorization": ...

    def decide(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        decision: HistoryAuthorizationDecision,
        at: datetime,
    ) -> "HistoryAuthorization": ...

    def history_sync_authorized(
        self, *, owner_id: UUID, channel: str, account_scope: str
    ) -> bool: ...


class HistoryAuthorizationState(StrEnum):
    """一个账号范围当前的历史读取授权状态。"""

    REQUIRED = "required"
    ACCEPTED = "accepted"
    DECLINED = "declined"


@dataclass(frozen=True, slots=True)
class HistoryAuthorization:
    """授权版本投影；``version`` 是用户最近一次明确决定对应的版本。"""

    state: HistoryAuthorizationState
    version: int | None = None
    current_version: int = field(
        default_factory=lambda: HISTORY_SYNC_AUTHORIZATION_VERSION
    )

    def __post_init__(self) -> None:
        if not isinstance(self.state, HistoryAuthorizationState):
            raise TypeError("state 必须是 HistoryAuthorizationState。")
        if self.version is not None and (
            not isinstance(self.version, int) or isinstance(self.version, bool) or self.version <= 0
        ):
            raise ValueError("授权版本必须是正整数或 None。")
        if (
            not isinstance(self.current_version, int)
            or isinstance(self.current_version, bool)
            or self.current_version <= 0
        ):
            raise ValueError("当前授权版本必须是正整数。")

    @property
    def authorized(self) -> bool:
        return self.state is HistoryAuthorizationState.ACCEPTED


def _state_from_row(
    version: object, decision: object
) -> HistoryAuthorization:
    if not isinstance(version, int):
        raise ValueError("数据库返回的授权版本无效。")
    if decision not in (
        HistoryAuthorizationState.ACCEPTED.value,
        HistoryAuthorizationState.DECLINED.value,
    ):
        raise ValueError("数据库返回的授权决定无效。")
    if version < HISTORY_SYNC_AUTHORIZATION_VERSION:
        # 旧版本确认不包含本次扩大后的读取范围，必须重新明确同意。
        return HistoryAuthorization(HistoryAuthorizationState.REQUIRED, version=version)
    return HistoryAuthorization(HistoryAuthorizationState(decision), version)


class PostgresHistorySyncAuthorizationStore:
    """保存与读取一个账号范围的历史同步授权版本。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def read(
        self, *, owner_id: UUID, channel: str, account_scope: str
    ) -> HistoryAuthorization:
        self._validate(owner_id=owner_id, channel=channel, account_scope=account_scope)
        with psycopg.connect(self._database_url, connect_timeout=2) as connection:
            connection.execute("SET LOCAL statement_timeout = '2000ms'")
            row = connection.execute(
                """
                SELECT version, decision
                FROM public.wechat_history_sync_authorization
                WHERE owner_id = %s AND channel = %s AND account_scope = %s
                """,
                (owner_id, channel, account_scope),
            ).fetchone()
        if row is None:
            return HistoryAuthorization(HistoryAuthorizationState.REQUIRED)
        return _state_from_row(row[0], row[1])

    def history_sync_authorized(
        self, *, owner_id: UUID, channel: str, account_scope: str
    ) -> bool:
        """HistorySyncAuthorizationPort：只有当前版本的明确同意才返回真。"""

        return self.read(
            owner_id=owner_id, channel=channel, account_scope=account_scope
        ).authorized

    def decide(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        decision: HistoryAuthorizationDecision,
        at: datetime,
    ) -> HistoryAuthorization:
        """写入一次明确决定；重复确认与并发刷新保持幂等。

        ``declined`` 只在该版本尚未被同意时生效。已同意后重复确认不会重置
        授权时间，也不会因为迟到的拒绝而停止既有历史读取。
        """

        self._validate(owner_id=owner_id, channel=channel, account_scope=account_scope)
        if decision not in ("accepted", "declined"):
            raise ValueError("授权决定无效。")
        if not isinstance(at, datetime) or at.tzinfo is None:
            raise ValueError("授权时间必须带时区。")
        with psycopg.connect(self._database_url, connect_timeout=2) as connection:
            connection.execute("SET LOCAL statement_timeout = '3000ms'")
            connection.execute(
                """
                INSERT INTO public.wechat_history_sync_authorization
                    (owner_id, channel, account_scope, version, decision, decided_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (owner_id, channel, account_scope) DO UPDATE SET
                    version = EXCLUDED.version,
                    decision = EXCLUDED.decision,
                    decided_at = CASE
                        WHEN wechat_history_sync_authorization.decision = 'accepted'
                         AND wechat_history_sync_authorization.version = EXCLUDED.version
                        THEN wechat_history_sync_authorization.decided_at
                        ELSE EXCLUDED.decided_at
                    END,
                    updated_at = now()
                WHERE (EXCLUDED.decision = 'accepted'
                       AND wechat_history_sync_authorization.version <= EXCLUDED.version)
                   OR (EXCLUDED.decision = 'declined'
                       AND wechat_history_sync_authorization.version < EXCLUDED.version)
                """,
                (
                    owner_id,
                    channel,
                    account_scope,
                    HISTORY_SYNC_AUTHORIZATION_VERSION,
                    decision,
                    at,
                ),
            )
            row = connection.execute(
                """
                SELECT version, decision
                FROM public.wechat_history_sync_authorization
                WHERE owner_id = %s AND channel = %s AND account_scope = %s
                """,
                (owner_id, channel, account_scope),
            ).fetchone()
            connection.commit()
        if row is None:
            raise RuntimeError("历史同步授权写入失败。")
        return _state_from_row(row[0], row[1])

    @staticmethod
    def _validate(*, owner_id: UUID, channel: str, account_scope: str) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        for name, value in (("channel", channel), ("account_scope", account_scope)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} 不能为空。")
        if channel != "wechat":
            raise ValueError("未知渠道。")
