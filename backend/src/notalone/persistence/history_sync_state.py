"""首绑完整历史同步覆盖状态的 PostgreSQL 持久化。

覆盖状态按 ``owner_id + contact_id + binding_id`` 独立保存，只包含阶段、
固定水位、检查点、计数和失败原因等元数据，不保存聊天正文。行不存在表示
“尚未开始”；``syncing`` 表示仍有页面待读；``complete`` 只在本机可读历史
追到启动时水位后由来源批次事务写入；``incomplete`` 带稳定原因，绝不能
被折算成完整。

历史页的来源、规范消息与检查点必须由同一个事务提交，因此本模块同时提供
``advance_history_checkpoint``：它由观察存储在已开启的事务内调用，不自行
提交。这样中途退出只会回到上一个已提交检查点，不会出现“消息已写入但
覆盖状态未推进”或相反的情况。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

import psycopg

from notalone.scopes import ContactScope


class HistorySyncStatePersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或聊天内容的历史覆盖状态错误。"""


class HistorySyncPhase(StrEnum):
    """首绑历史同步的持久化覆盖阶段。"""

    SYNCING = "syncing"
    COMPLETE = "complete"
    INCOMPLETE = "incomplete"


class HistoryCoveragePhase(StrEnum):
    """状态接口的覆盖阶段；行不存在时为尚未开始。"""

    NOT_STARTED = "not_started"
    SYNCING = "syncing"
    COMPLETE = "complete"
    INCOMPLETE = "incomplete"


@dataclass(frozen=True, slots=True)
class HistorySyncState:
    """一个绑定首次完整历史同步的最小状态投影。"""

    scope: ContactScope
    binding_id: UUID
    phase: HistorySyncPhase
    watermark_at: datetime
    message_count: int
    non_text_count: int
    page_count: int
    last_local_id: int | None
    last_cursor: str | None
    failure_code: str | None
    started_at: datetime
    completed_at: datetime | None
    updated_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.scope, ContactScope):
            raise TypeError("历史覆盖状态必须携带联系人范围。")
        if not isinstance(self.binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        if not isinstance(self.phase, HistorySyncPhase):
            raise TypeError("phase 必须是 HistorySyncPhase。")
        if not isinstance(self.watermark_at, datetime) or self.watermark_at.tzinfo is None:
            raise TypeError("watermark_at 必须是带时区的 datetime。")
        for name in ("message_count", "non_text_count", "page_count"):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"{name} 必须是非负整数。")
        if self.last_local_id is not None and (
            not isinstance(self.last_local_id, int) or self.last_local_id <= 0
        ):
            raise ValueError("历史检查点 local_id 必须是正整数或为空。")
        if self.last_cursor is not None and not self.last_cursor.strip():
            raise ValueError("历史检查点 cursor 不能为空字符串。")
        if not isinstance(self.started_at, datetime):
            raise TypeError("started_at 必须是 datetime。")


@dataclass(frozen=True, slots=True)
class HistoryCoverage:
    """状态接口按绑定输出的历史覆盖元数据；不含消息正文。"""

    binding_id: UUID
    contact_id: UUID
    phase: HistoryCoveragePhase
    failure_code: str | None
    message_count: int
    non_text_count: int
    page_count: int
    last_local_id: int | None
    last_cursor: str | None
    watermark_at: datetime | None
    started_at: datetime | None
    completed_at: datetime | None
    updated_at: datetime | None


@dataclass(frozen=True, slots=True)
class HistoryPageCheckpoint:
    """一个已成功读取历史页的检查点增量。"""

    complete: bool
    message_count: int
    non_text_count: int
    last_local_id: int
    last_cursor: str

    def __post_init__(self) -> None:
        if not isinstance(self.complete, bool):
            raise TypeError("complete 必须是 bool。")
        for name in ("message_count", "non_text_count"):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"{name} 必须是非负整数。")
        if not isinstance(self.last_local_id, int) or isinstance(self.last_local_id, bool):
            raise ValueError("历史页检查点 local_id 必须是正整数。")
        if self.last_local_id <= 0:
            raise ValueError("历史页检查点 local_id 必须是正整数。")
        if not isinstance(self.last_cursor, str) or not self.last_cursor.strip():
            raise ValueError("历史页检查点 cursor 不能为空。")


def not_started_coverage(*, binding_id: UUID, contact_id: UUID) -> HistoryCoverage:
    """尚未创建历史任务时的稳定元数据投影。"""

    return HistoryCoverage(
        binding_id=binding_id,
        contact_id=contact_id,
        phase=HistoryCoveragePhase.NOT_STARTED,
        failure_code=None,
        message_count=0,
        non_text_count=0,
        page_count=0,
        last_local_id=None,
        last_cursor=None,
        watermark_at=None,
        started_at=None,
        completed_at=None,
        updated_at=None,
    )


def coverage_from_state(state: HistorySyncState) -> HistoryCoverage:
    """把持久化状态投影为状态接口可输出的元数据。"""

    return HistoryCoverage(
        binding_id=state.binding_id,
        contact_id=state.scope.contact_id,
        phase=HistoryCoveragePhase(state.phase.value),
        failure_code=state.failure_code,
        message_count=state.message_count,
        non_text_count=state.non_text_count,
        page_count=state.page_count,
        last_local_id=state.last_local_id,
        last_cursor=state.last_cursor,
        watermark_at=state.watermark_at,
        started_at=state.started_at,
        completed_at=state.completed_at,
        updated_at=state.updated_at,
    )


_STATE_COLUMNS = (
    "owner_id, contact_id, binding_id, phase, watermark_at, message_count, "
    "non_text_count, page_count, last_local_id, last_cursor, failure_code, "
    "started_at, completed_at, updated_at"
)


def advance_history_checkpoint(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
    binding_id: UUID,
    checkpoint: HistoryPageCheckpoint,
) -> None:
    """在调用方事务内推进历史检查点；只允许从既有行前进。

    完成页的增量游标定位由观察存储在同一事务内完成，本函数只维护
    历史覆盖状态本身。
    """

    if not isinstance(checkpoint, HistoryPageCheckpoint):
        raise TypeError("checkpoint 必须是 HistoryPageCheckpoint。")
    row = connection.execute(
        """
        UPDATE public.cli_history_sync_state
        SET phase = %s,
            message_count = message_count + %s,
            non_text_count = non_text_count + %s,
            page_count = page_count + 1,
            last_local_id = %s,
            last_cursor = %s,
            failure_code = NULL,
            completed_at = CASE WHEN %s THEN now() ELSE NULL END,
            updated_at = now()
        WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
        RETURNING 1
        """,
        (
            (
                HistorySyncPhase.COMPLETE.value
                if checkpoint.complete
                else HistorySyncPhase.SYNCING.value
            ),
            checkpoint.message_count,
            checkpoint.non_text_count,
            checkpoint.last_local_id,
            checkpoint.last_cursor,
            checkpoint.complete,
            owner_id,
            contact_id,
            binding_id,
        ),
    ).fetchone()
    if row is None:
        raise HistorySyncStatePersistenceError("历史覆盖状态不存在，拒绝推进检查点。")


class PostgresHistorySyncStateStore:
    """按 ``owner_id + contact_id + binding_id`` 保存历史覆盖状态。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def read(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> HistorySyncState | None:
        """读取指定绑定的历史覆盖状态；行不存在表示尚未开始。"""

        self._validate_scope(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
        )
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"""
                    SELECT {_STATE_COLUMNS}
                    FROM public.cli_history_sync_state
                    WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                    """,
                    (owner_id, contact_id, binding_id),
                ).fetchone()
        except psycopg.Error:
            raise HistorySyncStatePersistenceError("历史覆盖状态读取失败。") from None
        return None if row is None else self._from_row(row)

    def list_active(
        self,
        *,
        owner_id: UUID,
        channel: str | None = None,
        account_scope: str | None = None,
    ) -> tuple[HistorySyncState, ...]:
        """列出当前 owner/渠道下 active 绑定的历史覆盖状态。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if channel is not None and (
            not isinstance(channel, str) or not channel.strip()
        ):
            raise ValueError("channel 不能为空。")
        if account_scope is not None and (
            not isinstance(account_scope, str) or not account_scope.strip()
        ):
            raise ValueError("account_scope 不能为空。")
        clauses = [
            "state.owner_id = %s",
            "binding.status = 'active'",
        ]
        parameters: list[object] = [owner_id]
        if channel is not None:
            clauses.append("binding.channel = %s")
            parameters.append(channel)
        if account_scope is not None:
            clauses.append("binding.account_scope = %s")
            parameters.append(account_scope)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    f"""
                    SELECT state.owner_id, state.contact_id, state.binding_id,
                           state.phase, state.watermark_at, state.message_count,
                           state.non_text_count, state.page_count,
                           state.last_local_id, state.last_cursor,
                           state.failure_code, state.started_at,
                           state.completed_at, state.updated_at
                    FROM public.cli_history_sync_state AS state
                    JOIN public.conversation_binding AS binding
                      ON binding.id = state.binding_id
                     AND binding.owner_id = state.owner_id
                     AND binding.contact_id = state.contact_id
                    WHERE {' AND '.join(clauses)}
                    ORDER BY state.updated_at DESC, state.contact_id
                    """,
                    tuple(parameters),
                ).fetchall()
        except psycopg.Error:
            raise HistorySyncStatePersistenceError("历史覆盖状态列表读取失败。") from None
        return tuple(self._from_row(row) for row in rows)

    def ensure_scope_started(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        watermark_at: datetime,
    ) -> int:
        """为授权范围内全部 active 绑定创建历史任务；已有任务不重置。

        返回本次新建的任务数量。新的私聊在后续周期再次调用时会自动纳入；
        已撤销、已排除或已完成的任务不受影响。
        """

        return self._ensure_started(
            owner_id=owner_id,
            channel=channel,
            account_scope=account_scope,
            watermark_at=watermark_at,
            binding_ids=None,
        )

    def ensure_bindings_started(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        binding_ids: Sequence[UUID],
        watermark_at: datetime,
    ) -> int:
        """为明确逐项确认的绑定创建历史任务；重复确认不重置检查点。

        只接受当前账号范围内仍为 active 的绑定；撤销、排除或超出范围的
        标识不会因此恢复。返回本次新建的任务数量。
        """

        if not isinstance(binding_ids, Sequence) or isinstance(
            binding_ids, (str, bytes)
        ):
            raise TypeError("binding_ids 必须是 UUID 序列。")
        if not binding_ids or any(not isinstance(item, UUID) for item in binding_ids):
            raise ValueError("binding_ids 必须包含至少一个 UUID。")
        return self._ensure_started(
            owner_id=owner_id,
            channel=channel,
            account_scope=account_scope,
            watermark_at=watermark_at,
            binding_ids=list(binding_ids),
        )

    def _ensure_started(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        watermark_at: datetime,
        binding_ids: list[UUID] | None,
    ) -> int:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        for name, value in (("channel", channel), ("account_scope", account_scope)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} 不能为空。")
        if not isinstance(watermark_at, datetime) or watermark_at.tzinfo is None:
            raise TypeError("watermark_at 必须是带时区的 datetime。")
        binding_filter = "" if binding_ids is None else " AND binding.id = ANY(%s)"
        parameters: list[object] = [
            HistorySyncPhase.SYNCING.value,
            watermark_at,
            owner_id,
            channel,
            account_scope,
        ]
        if binding_ids is not None:
            parameters.append(binding_ids)
        try:
            with self._connect() as connection:
                result = connection.execute(
                    f"""
                    INSERT INTO public.cli_history_sync_state (
                        owner_id, contact_id, binding_id, phase,
                        watermark_at, started_at
                    )
                    SELECT binding.owner_id, binding.contact_id, binding.id,
                           %s, %s, now()
                    FROM public.conversation_binding AS binding
                    WHERE binding.owner_id = %s
                      AND binding.channel = %s
                      AND binding.account_scope = %s
                      AND binding.status = 'active'
                      {binding_filter}
                    ON CONFLICT (owner_id, contact_id, binding_id) DO NOTHING
                    """,
                    tuple(parameters),
                )
                created = result.rowcount
                connection.commit()
        except psycopg.Error:
            raise HistorySyncStatePersistenceError("历史覆盖任务初始化失败。") from None
        return int(created)

    def mark_running(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> HistorySyncState:
        """在重试开始时恢复同步中；已完成状态不会回退。"""

        return self._update(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            sql_set=(
                "phase = %s, failure_code = NULL, completed_at = NULL, "
                "updated_at = now()"
            ),
            values=(HistorySyncPhase.SYNCING.value,),
            error_message="历史覆盖状态启动失败。",
            guard="AND phase <> 'complete'",
        )

    def mark_incomplete(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        failure_code: str,
    ) -> HistorySyncState:
        """记录不能标记完整的稳定原因，并保留已提交检查点。"""

        if not isinstance(failure_code, str) or not failure_code.strip():
            raise ValueError("failure_code 不能为空。")
        return self._update(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            sql_set=(
                "phase = %s, failure_code = %s, completed_at = NULL, "
                "updated_at = now()"
            ),
            values=(HistorySyncPhase.INCOMPLETE.value, failure_code.strip()),
            error_message="历史覆盖不完整状态写入失败。",
        )

    def _update(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        sql_set: str,
        values: tuple[object, ...],
        error_message: str,
        guard: str = "",
    ) -> HistorySyncState:
        self._validate_scope(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
        )
        try:
            with self._connect() as connection:
                self._assert_binding_active(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                )
                row = connection.execute(
                    f"""
                    UPDATE public.cli_history_sync_state
                    SET {sql_set}
                    WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                    {guard}
                    RETURNING {_STATE_COLUMNS}
                    """,
                    (*values, owner_id, contact_id, binding_id),
                ).fetchone()
                if row is None and guard:
                    row = connection.execute(
                        f"""
                        SELECT {_STATE_COLUMNS}
                        FROM public.cli_history_sync_state
                        WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                        """,
                        (owner_id, contact_id, binding_id),
                    ).fetchone()
                connection.commit()
        except HistorySyncStatePersistenceError:
            raise
        except psycopg.Error:
            raise HistorySyncStatePersistenceError(error_message) from None
        if row is None:
            raise HistorySyncStatePersistenceError("指定历史覆盖状态不存在。")
        return self._from_row(row)

    @staticmethod
    def _assert_binding_active(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> None:
        row = connection.execute(
            """
            SELECT status
            FROM public.conversation_binding
            WHERE id = %s AND owner_id = %s AND contact_id = %s
            FOR KEY SHARE
            """,
            (binding_id, owner_id, contact_id),
        ).fetchone()
        if row is None or row[0] != "active":
            raise HistorySyncStatePersistenceError(
                "历史覆盖状态只能属于 active 绑定。"
            )

    @staticmethod
    def _from_row(row: tuple[object, ...]) -> HistorySyncState:
        (
            owner_id,
            contact_id,
            binding_id,
            phase_text,
            watermark_at,
            message_count,
            non_text_count,
            page_count,
            last_local_id,
            last_cursor,
            failure_code,
            started_at,
            completed_at,
            updated_at,
        ) = row
        if not all(
            isinstance(value, UUID)
            for value in (owner_id, contact_id, binding_id)
        ):
            raise HistorySyncStatePersistenceError("数据库返回的历史覆盖范围无效。")
        try:
            phase = HistorySyncPhase(phase_text)
        except ValueError as error:
            raise HistorySyncStatePersistenceError("数据库返回的历史覆盖阶段无效。") from error
        for value in (watermark_at, started_at, updated_at):
            if not isinstance(value, datetime):
                raise HistorySyncStatePersistenceError("数据库返回的历史覆盖时间无效。")
        return HistorySyncState(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            binding_id=binding_id,
            phase=phase,
            watermark_at=watermark_at,
            message_count=message_count,
            non_text_count=non_text_count,
            page_count=page_count,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            failure_code=failure_code,
            started_at=started_at,
            completed_at=completed_at,
            updated_at=updated_at,
        )

    @staticmethod
    def _validate_scope(*, owner_id: UUID, contact_id: UUID, binding_id: UUID) -> None:
        if not isinstance(owner_id, UUID) or not isinstance(contact_id, UUID):
            raise TypeError("owner_id 和 contact_id 必须是 UUID。")
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._database_url)
