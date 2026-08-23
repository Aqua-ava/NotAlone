"""本地微信 CLI 观察来源与联系人级 cursor 的 PostgreSQL 持久化。

只保存一次只读增量读取的来源元数据与水位，不保存消息正文。
首次读取没有水位；水位只随成功返回的 cursor/local_id 单调前移，
同一批次重试幂等，不重复创建来源或移动水位。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

import psycopg

from notalone.scopes import ContactScope


class ObservationPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或会话内容的观察持久化错误。"""


class ObservationNotFoundError(ObservationPersistenceError):
    """指定隔离范围内不存在该观察来源。"""


class ObservationWatermarkError(ObservationPersistenceError):
    """水位非法：首次读取不允许 0，水位只能单调前移。"""


class ObservationMode(StrEnum):
    """观察来源模式：实时读取或切回联系人后的补读。"""

    LIVE = "live"
    CLI_CATCHUP = "cli_catchup"


@dataclass(frozen=True, slots=True)
class ObservationCursor:
    """一个联系人的独立增量读取水位；重启后从这里恢复。"""

    scope: ContactScope
    binding_id: UUID
    conversation_locator: str
    last_local_id: int
    last_cursor: str
    updated_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.scope, ContactScope):
            raise TypeError("cursor 必须携带联系人范围。")
        if not isinstance(self.binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        if not isinstance(self.last_local_id, int) or self.last_local_id <= 0:
            raise ObservationWatermarkError("水位 local_id 必须是正整数。")
        if not isinstance(self.last_cursor, str) or not self.last_cursor.strip():
            raise ObservationWatermarkError("水位 cursor 必须来自成功返回。")


@dataclass(frozen=True, slots=True)
class PersistedObservation:
    """一次 CLI 增量读取的来源元数据投影；不含消息正文。"""

    observation_id: UUID
    scope: ContactScope
    binding_id: UUID
    mode: ObservationMode
    cli_version: str
    conversation_locator: str
    read_at: datetime
    last_local_id: int
    last_cursor: str
    record_count: int
    since_local_id: int | None = None
    since_cursor: str | None = None


_OBSERVATION_COLUMNS = (
    "id, owner_id, contact_id, binding_id, mode, cli_version, "
    "conversation_locator, read_at, since_local_id, last_local_id, "
    "since_cursor, last_cursor, record_count"
)


class PostgresObservationStore:
    """按 owner/contact 范围保存观察来源与独立水位。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def read_cursor(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
    ) -> ObservationCursor | None:
        """读取联系人独立水位；首次读取返回 None，不产生 0 起始值。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT binding_id, conversation_locator,
                           last_local_id, last_cursor, updated_at
                    FROM public.wechat_observation_cursor
                    WHERE owner_id = %s AND contact_id = %s
                    """,
                    (owner_id, contact_id),
                ).fetchone()
        except psycopg.Error:
            raise ObservationPersistenceError("观察水位读取失败。") from None
        if row is None:
            return None
        binding_id, locator, last_local_id, last_cursor, updated_at = row
        return ObservationCursor(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            binding_id=binding_id,
            conversation_locator=locator,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            updated_at=updated_at,
        )

    def record_batch(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        mode: ObservationMode,
        cli_version: str,
        conversation_locator: str,
        last_local_id: int,
        last_cursor: str,
        record_count: int,
        since_local_id: int | None = None,
        since_cursor: str | None = None,
    ) -> PersistedObservation:
        """在同一事务写入来源并前移水位；同一批次重试保持幂等。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        if not isinstance(mode, ObservationMode):
            raise ValueError("观察模式只能是 live 或 cli_catchup。")
        self._validate_text(cli_version, "cli_version")
        self._validate_text(conversation_locator, "conversation_locator")
        self._validate_text(last_cursor, "last_cursor")
        if not isinstance(last_local_id, int) or last_local_id <= 0:
            raise ObservationWatermarkError("成功水位 local_id 必须是正整数。")
        if not isinstance(record_count, int) or record_count < 0:
            raise ValueError("record_count 必须是非负整数。")
        if since_local_id is not None and (
            not isinstance(since_local_id, int) or since_local_id <= 0
        ):
            # 首次读取不传起始值；绝不允许非法的 since_local_id=0。
            raise ObservationWatermarkError("起始 local_id 必须是正整数或为空。")
        if since_local_id is not None and since_local_id > last_local_id:
            raise ObservationWatermarkError("起始水位不能晚于成功水位。")
        if since_local_id is None and since_cursor is not None:
            raise ObservationWatermarkError("首次读取不携带起始 cursor。")
        if since_cursor is not None:
            self._validate_text(since_cursor, "since_cursor")

        try:
            with self._connect() as connection:
                self._assert_binding_active(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                )
                inserted = connection.execute(
                    f"""
                    INSERT INTO public.local_wechat_observation (
                        owner_id, contact_id, binding_id, mode, cli_version,
                        conversation_locator, since_local_id, last_local_id,
                        since_cursor, last_cursor, record_count
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (owner_id, contact_id, binding_id, mode,
                                 COALESCE(since_local_id, 0), last_local_id)
                    DO NOTHING
                    RETURNING {_OBSERVATION_COLUMNS}
                    """,
                    (
                        owner_id,
                        contact_id,
                        binding_id,
                        str(mode),
                        cli_version,
                        conversation_locator,
                        since_local_id,
                        last_local_id,
                        since_cursor,
                        last_cursor,
                        record_count,
                    ),
                ).fetchone()
                if inserted is None:
                    # 同一批次重试：返回既有来源，不移动水位。
                    existing = connection.execute(
                        f"""
                        SELECT {_OBSERVATION_COLUMNS}
                        FROM public.local_wechat_observation
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND binding_id = %s
                          AND mode = %s
                          AND COALESCE(since_local_id, 0) = %s
                          AND last_local_id = %s
                        """,
                        (
                            owner_id,
                            contact_id,
                            binding_id,
                            str(mode),
                            0 if since_local_id is None else since_local_id,
                            last_local_id,
                        ),
                    ).fetchone()
                    if existing is None:
                        raise ObservationPersistenceError(
                            "无法确认观察来源写入结果。"
                        )
                    connection.commit()
                    return self._from_row(existing)
                self._advance_cursor(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                    conversation_locator=conversation_locator,
                    last_local_id=last_local_id,
                    last_cursor=last_cursor,
                )
                connection.commit()
                return self._from_row(inserted)
        except (
            ObservationNotFoundError,
            ObservationPersistenceError,
            ObservationWatermarkError,
        ):
            raise
        except psycopg.Error:
            raise ObservationPersistenceError(
                "观察来源写入失败，未移动水位。"
            ) from None

    def delete_observation(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        observation_id: UUID,
    ) -> None:
        """按来源级删除路径移除一条观察来源；水位保持不动。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(observation_id, UUID):
            raise TypeError("observation_id 必须是 UUID。")
        try:
            with self._connect() as connection:
                deleted = connection.execute(
                    """
                    DELETE FROM public.local_wechat_observation
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING id
                    """,
                    (owner_id, contact_id, observation_id),
                ).fetchone()
                if deleted is None:
                    raise ObservationNotFoundError("指定范围内不存在该观察来源。")
                connection.commit()
        except ObservationNotFoundError:
            raise
        except psycopg.Error:
            raise ObservationPersistenceError("观察来源删除失败。") from None

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
            SELECT owner_id, contact_id, status
            FROM public.conversation_binding
            WHERE id = %s
            FOR KEY SHARE
            """,
            (binding_id,),
        ).fetchone()
        if row is None or row[0] != owner_id or row[1] != contact_id:
            raise ObservationNotFoundError("绑定不属于该联系人的有效范围。")
        if row[2] != "active":
            raise ObservationNotFoundError("绑定已撤销，不能记录观察来源。")

    @staticmethod
    def _advance_cursor(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        conversation_locator: str,
        last_local_id: int,
        last_cursor: str,
    ) -> None:
        result = connection.execute(
            """
            INSERT INTO public.wechat_observation_cursor (
                owner_id, contact_id, binding_id, conversation_locator,
                last_local_id, last_cursor
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (owner_id, contact_id)
            DO UPDATE SET
                binding_id = EXCLUDED.binding_id,
                conversation_locator = EXCLUDED.conversation_locator,
                last_local_id = EXCLUDED.last_local_id,
                last_cursor = EXCLUDED.last_cursor,
                updated_at = now()
            WHERE wechat_observation_cursor.last_local_id
                < EXCLUDED.last_local_id
            RETURNING last_local_id
            """,
            (
                owner_id,
                contact_id,
                binding_id,
                conversation_locator,
                last_local_id,
                last_cursor,
            ),
        ).fetchone()
        if result is None:
            raise ObservationWatermarkError("观察水位只能单调前移。")

    @staticmethod
    def _validate_scope(*, owner_id: UUID, contact_id: UUID) -> None:
        if not isinstance(owner_id, UUID) or not isinstance(contact_id, UUID):
            raise TypeError("owner_id 和 contact_id 必须是 UUID。")

    @staticmethod
    def _validate_text(value: str, field_name: str) -> None:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field_name} 不能为空。")

    @staticmethod
    def _from_row(row: tuple[object, ...]) -> PersistedObservation:
        (
            observation_id,
            owner_id,
            contact_id,
            binding_id,
            mode_text,
            cli_version,
            conversation_locator,
            read_at,
            since_local_id,
            last_local_id,
            since_cursor,
            last_cursor,
            record_count,
        ) = row
        if not all(
            isinstance(value, UUID)
            for value in (observation_id, owner_id, contact_id, binding_id)
        ):
            raise ObservationPersistenceError("数据库返回的观察范围无效。")
        if not isinstance(read_at, datetime):
            raise ObservationPersistenceError("数据库返回的读取时间无效。")
        try:
            mode = ObservationMode(mode_text)
        except ValueError as error:
            raise ObservationPersistenceError("数据库返回的观察模式无效。") from error
        return PersistedObservation(
            observation_id=observation_id,
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            binding_id=binding_id,
            mode=mode,
            cli_version=cli_version,
            conversation_locator=conversation_locator,
            read_at=read_at,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            record_count=record_count,
            since_local_id=since_local_id,
            since_cursor=since_cursor,
        )

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._database_url)
