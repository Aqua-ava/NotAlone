"""CLI 后台补齐状态的 PostgreSQL 持久化。

这里只保存补齐范围、触发时间、状态、计数、游标和失败原因等审计元数据；
不保存聊天正文。状态与来源批次分开保存，但补齐状态只有在来源批次成功提交
后才会进入 ``complete``，因此失败或进程重启不会伪装成覆盖完整。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

import psycopg

from notalone.persistence.observation_store import (
    ObservationPersistenceError,
    assert_binding_active,
)
from notalone.scopes import ContactScope


class BackfillStatePersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或聊天正文的补齐状态持久化错误。"""


class BackfillPhase(StrEnum):
    """一次可检测缺口的持久化生命周期。"""

    GAP_DETECTED = "gap_detected"
    BACKFILLING = "backfilling"
    COMPLETE = "complete"
    FAILED = "failed"
    INCOMPLETE = "incomplete"
    PAUSED = "paused"


@dataclass(frozen=True, slots=True)
class BackfillState:
    """一个已确认联系人最近一次补齐触发的最小状态投影。"""

    scope: ContactScope
    binding_id: UUID
    phase: BackfillPhase
    trigger_at: datetime
    message_count: int
    last_local_id: int | None
    last_cursor: str | None
    failure_code: str | None
    started_at: datetime | None
    completed_at: datetime | None
    updated_at: datetime
    non_text_count: int = 0

    def __post_init__(self) -> None:
        if not isinstance(self.scope, ContactScope):
            raise TypeError("补齐状态必须携带联系人范围。")
        if not isinstance(self.binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        if not isinstance(self.trigger_at, datetime):
            raise TypeError("trigger_at 必须是 datetime。")
        if not isinstance(self.message_count, int) or self.message_count < 0:
            raise ValueError("补齐消息计数必须是非负整数。")
        if (
            not isinstance(self.non_text_count, int)
            or isinstance(self.non_text_count, bool)
            or self.non_text_count < 0
        ):
            raise ValueError("补齐非文字计数必须是非负整数。")
        if self.last_local_id is not None and (
            not isinstance(self.last_local_id, int) or self.last_local_id <= 0
        ):
            raise ValueError("补齐状态的 local_id 必须是正整数或为空。")
        if self.last_cursor is not None and not self.last_cursor.strip():
            raise ValueError("补齐状态的 cursor 不能为空字符串。")
        if not isinstance(self.updated_at, datetime):
            raise TypeError("updated_at 必须是 datetime。")


_STATE_COLUMNS = (
    "owner_id, contact_id, binding_id, phase, trigger_at, message_count, "
    "last_local_id, last_cursor, failure_code, started_at, completed_at, "
    "updated_at, non_text_count"
)


class PostgresBackfillStateStore:
    """按 ``owner_id + contact_id + binding_id`` 保存补齐状态。"""

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
    ) -> BackfillState | None:
        """读取指定绑定最近一次补齐状态；没有状态时返回 None。"""

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
                    FROM public.cli_backfill_state
                    WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                    """,
                    (owner_id, contact_id, binding_id),
                ).fetchone()
        except psycopg.Error:
            raise BackfillStatePersistenceError("补齐状态读取失败。") from None
        return None if row is None else self._from_row(row)

    def list_active(
        self,
        *,
        owner_id: UUID,
        channel: str | None = None,
        account_scope: str | None = None,
    ) -> tuple[BackfillState, ...]:
        """列出当前 owner/渠道下仍 active 的补齐状态，不返回聊天正文。"""

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
                           state.phase, state.trigger_at, state.message_count,
                           state.last_local_id, state.last_cursor,
                           state.failure_code, state.started_at,
                           state.completed_at, state.updated_at,
                           state.non_text_count
                    FROM public.cli_backfill_state AS state
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
            raise BackfillStatePersistenceError("补齐状态列表读取失败。") from None
        return tuple(self._from_row(row) for row in rows)

    def ensure_started(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        trigger_at: datetime,
    ) -> BackfillState:
        """为一次恢复、重启或手动检查触发建立状态；重复心跳不重置进行中状态。"""

        self._validate_scope(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
        )
        if not isinstance(trigger_at, datetime):
            raise TypeError("trigger_at 必须是 datetime。")
        try:
            with self._connect() as connection:
                try:
                    assert_binding_active(
                        connection,
                        owner_id=owner_id,
                        contact_id=contact_id,
                        binding_id=binding_id,
                    )
                except ObservationPersistenceError as error:
                    raise BackfillStatePersistenceError(
                        "补齐状态只能属于 active 绑定。"
                    ) from error
                row = connection.execute(
                    f"""
                    SELECT {_STATE_COLUMNS}
                    FROM public.cli_backfill_state
                    WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                    FOR UPDATE
                    """,
                    (owner_id, contact_id, binding_id),
                ).fetchone()
                if row is None:
                    row = connection.execute(
                        f"""
                        INSERT INTO public.cli_backfill_state (
                            owner_id, contact_id, binding_id, phase, trigger_at
                        )
                        VALUES (%s, %s, %s, %s, %s)
                        RETURNING {_STATE_COLUMNS}
                        """,
                        (
                            owner_id,
                            contact_id,
                            binding_id,
                            BackfillPhase.GAP_DETECTED.value,
                            trigger_at,
                        ),
                    ).fetchone()
                else:
                    existing = self._from_row(row)
                    if existing.phase != BackfillPhase.PAUSED and (
                        existing.trigger_at < trigger_at or (
                            existing.trigger_at == trigger_at
                            and existing.phase
                            in {BackfillPhase.FAILED, BackfillPhase.INCOMPLETE}
                        )
                    ):
                        row = connection.execute(
                            f"""
                            UPDATE public.cli_backfill_state
                            SET phase = %s,
                                trigger_at = %s,
                                message_count = 0,
                                non_text_count = 0,
                                last_local_id = NULL,
                                last_cursor = NULL,
                                failure_code = NULL,
                                started_at = NULL,
                                completed_at = NULL,
                                updated_at = now()
                            WHERE owner_id = %s
                              AND contact_id = %s
                              AND binding_id = %s
                            RETURNING {_STATE_COLUMNS}
                            """,
                            (
                                BackfillPhase.GAP_DETECTED.value,
                                trigger_at,
                                owner_id,
                                contact_id,
                                binding_id,
                            ),
                        ).fetchone()
                connection.commit()
        except BackfillStatePersistenceError:
            raise
        except psycopg.Error:
            raise BackfillStatePersistenceError("补齐状态初始化失败。") from None
        if row is None:
            raise BackfillStatePersistenceError("无法确认补齐状态初始化结果。")
        return self._from_row(row)

    def mark_running(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> BackfillState:
        """标记补齐已开始；状态更新不包含聊天正文。"""

        return self._update(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            sql_set=(
                "phase = %s, started_at = COALESCE(started_at, now()), "
                "updated_at = now()"
            ),
            values=(BackfillPhase.BACKFILLING.value,),
            error_message="补齐状态启动失败。",
        )

    def mark_progress(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        message_count: int,
        last_local_id: int | None,
        last_cursor: str | None,
        non_text_count: int = 0,
    ) -> BackfillState:
        """在每页来源提交后保存累计进度，尚有后续页时不标记完成。"""

        self._validate_count(message_count)
        self._validate_count(non_text_count)
        self._validate_watermark(last_local_id=last_local_id, last_cursor=last_cursor)
        return self._update(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            sql_set=(
                "phase = %s, message_count = %s, last_local_id = %s, "
                "last_cursor = %s, failure_code = NULL, completed_at = NULL, "
                "updated_at = now(), non_text_count = %s"
            ),
            values=(
                BackfillPhase.BACKFILLING.value,
                message_count,
                last_local_id,
                last_cursor,
                non_text_count,
            ),
            error_message="补齐分页进度写入失败。",
        )

    def mark_complete(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        message_count: int,
        last_local_id: int | None,
        last_cursor: str | None,
        non_text_count: int = 0,
    ) -> BackfillState:
        """在来源批次提交后标记完成，并保存批次计数和游标。"""

        self._validate_count(message_count)
        self._validate_count(non_text_count)
        self._validate_watermark(last_local_id=last_local_id, last_cursor=last_cursor)
        return self._update(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            sql_set=(
                "phase = %s, message_count = %s, last_local_id = %s, "
                "last_cursor = %s, failure_code = NULL, completed_at = now(), "
                "updated_at = now(), non_text_count = %s"
            ),
            values=(
                BackfillPhase.COMPLETE.value,
                message_count,
                last_local_id,
                last_cursor,
                non_text_count,
            ),
            error_message="补齐状态完成写入失败。",
        )

    def mark_failed(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        failure_code: str,
    ) -> BackfillState:
        """记录失败原因；失败状态不能被当作覆盖完整。"""

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
            values=(BackfillPhase.FAILED.value, failure_code.strip()),
            error_message="补齐失败状态写入失败。",
        )

    def mark_incomplete(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        failure_code: str,
    ) -> BackfillState:
        """记录 CLI 不可用或 freshness 未知；不能声称覆盖完整。"""

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
            values=(BackfillPhase.INCOMPLETE.value, failure_code.strip()),
            error_message="补齐不完整状态写入失败。",
        )

    def mark_paused(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> BackfillState:
        """暂停当前补齐任务；暂停状态不能被视为完成。"""

        return self._update(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            sql_set=(
                "phase = %s, failure_code = NULL, completed_at = NULL, "
                "updated_at = now()"
            ),
            values=(BackfillPhase.PAUSED.value,),
            error_message="补齐暂停状态写入失败。",
        )

    def mark_retry(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        trigger_at: datetime,
    ) -> BackfillState:
        """为失败、暂停或不完整状态建立新的补齐尝试。"""

        self._validate_scope(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
        )
        if not isinstance(trigger_at, datetime):
            raise TypeError("trigger_at 必须是 datetime。")
        try:
            with self._connect() as connection:
                try:
                    assert_binding_active(
                        connection,
                        owner_id=owner_id,
                        contact_id=contact_id,
                        binding_id=binding_id,
                    )
                except ObservationPersistenceError as error:
                    raise BackfillStatePersistenceError(
                        "补齐状态只能属于 active 绑定。"
                    ) from error
                row = connection.execute(
                    f"""
                    UPDATE public.cli_backfill_state
                    SET phase = %s,
                        trigger_at = %s,
                        message_count = 0,
                        non_text_count = 0,
                        last_local_id = NULL,
                        last_cursor = NULL,
                        failure_code = NULL,
                        started_at = NULL,
                        completed_at = NULL,
                        updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                    RETURNING {_STATE_COLUMNS}
                    """,
                    (
                        BackfillPhase.GAP_DETECTED.value,
                        trigger_at,
                        owner_id,
                        contact_id,
                        binding_id,
                    ),
                ).fetchone()
                if row is None:
                    raise BackfillStatePersistenceError("指定补齐状态不存在。")
                connection.commit()
        except BackfillStatePersistenceError:
            raise
        except psycopg.Error:
            raise BackfillStatePersistenceError("补齐重试状态写入失败。") from None
        return self._from_row(row)

    def _update(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        sql_set: str,
        values: tuple[object, ...],
        error_message: str,
    ) -> BackfillState:
        self._validate_scope(
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
        )
        try:
            with self._connect() as connection:
                try:
                    assert_binding_active(
                        connection,
                        owner_id=owner_id,
                        contact_id=contact_id,
                        binding_id=binding_id,
                    )
                except ObservationPersistenceError as error:
                    raise BackfillStatePersistenceError(
                        "补齐状态只能属于 active 绑定。"
                    ) from error
                row = connection.execute(
                    f"""
                    UPDATE public.cli_backfill_state
                    SET {sql_set}
                    WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                    RETURNING {_STATE_COLUMNS}
                    """,
                    (*values, owner_id, contact_id, binding_id),
                ).fetchone()
                if row is None:
                    raise BackfillStatePersistenceError("指定补齐状态不存在。")
                connection.commit()
        except BackfillStatePersistenceError:
            raise
        except psycopg.Error:
            raise BackfillStatePersistenceError(error_message) from None
        return self._from_row(row)

    @staticmethod
    def _from_row(row: tuple[object, ...]) -> BackfillState:
        (
            owner_id,
            contact_id,
            binding_id,
            phase_text,
            trigger_at,
            message_count,
            last_local_id,
            last_cursor,
            failure_code,
            started_at,
            completed_at,
            updated_at,
            non_text_count,
        ) = row
        if not all(
            isinstance(value, UUID)
            for value in (owner_id, contact_id, binding_id)
        ):
            raise BackfillStatePersistenceError("数据库返回的补齐范围无效。")
        try:
            phase = BackfillPhase(phase_text)
        except ValueError as error:
            raise BackfillStatePersistenceError("数据库返回的补齐状态无效。") from error
        if not isinstance(trigger_at, datetime) or not isinstance(updated_at, datetime):
            raise BackfillStatePersistenceError("数据库返回的补齐时间无效。")
        if not isinstance(message_count, int) or isinstance(message_count, bool):
            raise BackfillStatePersistenceError("数据库返回的补齐计数无效。")
        if message_count < 0:
            raise BackfillStatePersistenceError("数据库返回的补齐计数无效。")
        if (
            not isinstance(non_text_count, int)
            or isinstance(non_text_count, bool)
            or non_text_count < 0
        ):
            raise BackfillStatePersistenceError("数据库返回的非文字计数无效。")
        return BackfillState(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            binding_id=binding_id,
            phase=phase,
            trigger_at=trigger_at,
            message_count=message_count,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            failure_code=failure_code,
            started_at=started_at,
            completed_at=completed_at,
            updated_at=updated_at,
            non_text_count=non_text_count,
        )

    @staticmethod
    def _validate_scope(*, owner_id: UUID, contact_id: UUID, binding_id: UUID) -> None:
        if not isinstance(owner_id, UUID) or not isinstance(contact_id, UUID):
            raise TypeError("owner_id 和 contact_id 必须是 UUID。")
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")

    @staticmethod
    def _validate_count(message_count: int) -> None:
        if not isinstance(message_count, int) or isinstance(message_count, bool):
            raise TypeError("message_count 必须是整数。")
        if message_count < 0:
            raise ValueError("message_count 必须是非负整数。")

    @staticmethod
    def _validate_watermark(
        *, last_local_id: int | None, last_cursor: str | None
    ) -> None:
        if last_local_id is None and last_cursor is None:
            return
        if not isinstance(last_local_id, int) or isinstance(last_local_id, bool):
            raise ValueError("last_local_id 必须是正整数或同时为空。")
        if last_local_id <= 0:
            raise ValueError("last_local_id 必须是正整数。")
        if not isinstance(last_cursor, str) or not last_cursor.strip():
            raise ValueError("last_cursor 必须和 local_id 一起提供。")

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._database_url)
