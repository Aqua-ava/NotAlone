"""本地微信 CLI 观察来源与联系人级 cursor 的 PostgreSQL 持久化。

只保存一次只读增量读取的来源元数据与水位，不保存消息正文。
首次读取没有水位；水位只随成功返回的 cursor/local_id 单调前移，
同一批次重试幂等，不重复创建来源或移动水位。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.models import NormalizedMessage
from notalone.persistence.extraction_trace import erase_source_traces
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.message_cleanup import (
    cleanup_derived_data,
    collect_orphan_message_ids,
    delete_messages,
)
from notalone.persistence.reply_cleanup import (
    ReplyCleanupError,
    delete_source_replies,
)
from notalone.persistence.source_processing import (
    erase_source_processing,
    save_processing_batch,
)
from notalone.scopes import ContactScope
from notalone.source_processing.models import ProcessingRecord, execution


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
    CLI_BACKGROUND = "cli_background"


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
        if (
            not isinstance(self.last_cursor, str)
            or not self.last_cursor.strip()
        ):
            raise ObservationWatermarkError("水位 cursor 必须来自成功返回。")


@dataclass(frozen=True, slots=True)
class ObservationBaseline:
    """一个绑定首次启用后台 CLI 读取时的时间基线。"""

    scope: ContactScope
    binding_id: UUID
    conversation_locator: str
    baseline_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.scope, ContactScope):
            raise TypeError("baseline 必须携带联系人范围。")
        if not isinstance(self.binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        if (
            not isinstance(self.conversation_locator, str)
            or not self.conversation_locator.strip()
        ):
            raise ValueError("baseline 必须携带会话定位标识。")
        if (
            not isinstance(self.baseline_at, datetime)
            or self.baseline_at.tzinfo is None
        ):
            raise TypeError("baseline_at 必须是带时区的 datetime。")


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
    event_count: int = 0
    non_text_count: int = 0
    is_reliable: bool = False


@dataclass(frozen=True, slots=True)
class RecordedObservationBatch:
    """同一事务内写入的观察来源与其规范消息结果。"""

    observation: PersistedObservation
    message_ids: tuple[UUID, ...]
    created_message_ids: tuple[UUID | None, ...]


@dataclass(frozen=True, slots=True)
class _CliMessagesWrite:
    """一批 CLI 消息按输入顺序对齐的写入结果。

    ``created_message_ids`` 中重复复用的消息位置为 ``None``，
    只表示"本次新建"；两元组长度始终与输入消息相同。
    """

    message_ids: tuple[UUID, ...]
    created_message_ids: tuple[UUID | None, ...]
    processing_receipts: tuple[dict[str, Any], ...] = ()


def assert_binding_active(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
    binding_id: UUID,
    conversation_locator: str | None = None,
) -> None:
    """能记录观察的前提：绑定属于该范围且处于 active 状态。"""

    row = connection.execute(
        """
        SELECT owner_id, contact_id, status, conversation_locator
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
    if conversation_locator is not None and row[3] != conversation_locator:
        raise ObservationNotFoundError("观察会话与已确认绑定不一致。")


def advance_observation_cursor(
    connection: psycopg.Connection[Any],
    *,
    owner_id: UUID,
    contact_id: UUID,
    binding_id: UUID,
    conversation_locator: str,
    last_local_id: int,
    last_cursor: str,
) -> None:
    """在同一事务内单调前移联系人水位；倒退时拒绝。"""

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
            <= EXCLUDED.last_local_id
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
        # 持平（空批次）视为无害无操作；只有倒退才拒绝。
        raise ObservationWatermarkError("观察水位只能单调前移。")


_OBSERVATION_COLUMNS = (
    "id, owner_id, contact_id, binding_id, mode, cli_version, "
    "conversation_locator, read_at, since_local_id, last_local_id, "
    "since_cursor, last_cursor, record_count, event_count, non_text_count, "
    "is_reliable"
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

    def read_reliable_cursor(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> ObservationCursor | None:
        """读取该绑定最近一个成功提交的来源批次水位。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT conversation_locator, last_local_id, last_cursor, read_at
                    FROM public.local_wechat_observation
                    WHERE owner_id = %s
                      AND contact_id = %s
                      AND binding_id = %s
                      AND is_reliable
                    ORDER BY last_local_id DESC, read_at DESC, id DESC
                    LIMIT 1
                    """,
                    (owner_id, contact_id, binding_id),
                ).fetchone()
        except psycopg.Error:
            raise ObservationPersistenceError(
                "可靠观察水位读取失败。"
            ) from None
        if row is None:
            return None
        locator, last_local_id, last_cursor, updated_at = row
        if not isinstance(locator, str) or not isinstance(last_cursor, str):
            raise ObservationPersistenceError("数据库返回的可靠水位无效。")
        return ObservationCursor(
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            binding_id=binding_id,
            conversation_locator=locator,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            updated_at=updated_at,
        )

    def rewind_cursor(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        target: ObservationCursor | None,
    ) -> None:
        """把超前游标回退到可靠位置；没有可靠位置时回到 baseline。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        if target is not None:
            if not isinstance(target, ObservationCursor):
                raise TypeError("target 必须是 ObservationCursor 或 None。")
            if target.scope != ContactScope(
                owner_id=owner_id, contact_id=contact_id
            ):
                raise ObservationPersistenceError("可靠水位超出联系人范围。")
            if target.binding_id != binding_id:
                raise ObservationPersistenceError("可靠水位不属于当前绑定。")
        try:
            with self._connect() as connection:
                assert_binding_active(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                )
                lock_contact_scope(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                )
                if target is None:
                    connection.execute(
                        """
                        DELETE FROM public.wechat_observation_cursor
                        WHERE owner_id = %s AND contact_id = %s
                        """,
                        (owner_id, contact_id),
                    )
                else:
                    connection.execute(
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
                        """,
                        (
                            owner_id,
                            contact_id,
                            binding_id,
                            target.conversation_locator,
                            target.last_local_id,
                            target.last_cursor,
                        ),
                    )
                connection.commit()
        except ObservationPersistenceError:
            raise
        except psycopg.Error:
            raise ObservationPersistenceError("观察水位回退失败。") from None

    def ensure_baseline(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        conversation_locator: str,
        baseline_at: datetime,
    ) -> datetime:
        """创建或读取绑定 baseline；重复调用不会移动原始基线。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        self._validate_text(conversation_locator, "conversation_locator")
        if not isinstance(baseline_at, datetime) or baseline_at.tzinfo is None:
            raise TypeError("baseline_at 必须是带时区的 datetime。")
        try:
            with self._connect() as connection:
                assert_binding_active(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                )
                inserted = connection.execute(
                    """
                    INSERT INTO public.wechat_observation_baseline (
                        owner_id, contact_id, binding_id,
                        conversation_locator, baseline_at
                    )
                    SELECT %s, %s, binding.id, %s, %s
                    FROM public.conversation_binding AS binding
                    WHERE binding.id = %s
                      AND binding.owner_id = %s
                      AND binding.contact_id = %s
                      AND binding.status = 'active'
                      AND binding.conversation_locator = %s
                    ON CONFLICT (owner_id, contact_id, binding_id) DO NOTHING
                    RETURNING baseline_at
                    """,
                    (
                        owner_id,
                        contact_id,
                        conversation_locator,
                        baseline_at,
                        binding_id,
                        owner_id,
                        contact_id,
                        conversation_locator,
                    ),
                ).fetchone()
                if inserted is None:
                    existing = connection.execute(
                        """
                        SELECT baseline_at
                        FROM public.wechat_observation_baseline
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND binding_id = %s
                          AND conversation_locator = %s
                        """,
                        (
                            owner_id,
                            contact_id,
                            binding_id,
                            conversation_locator,
                        ),
                    ).fetchone()
                    if existing is None:
                        raise ObservationPersistenceError(
                            "无法确认观察 baseline 写入结果。"
                        )
                    selected = existing[0]
                else:
                    selected = inserted[0]
                connection.commit()
        except ObservationPersistenceError:
            raise
        except psycopg.Error:
            raise ObservationPersistenceError(
                "观察 baseline 写入失败。"
            ) from None
        if not isinstance(selected, datetime):
            raise ObservationPersistenceError(
                "数据库返回的 baseline 时间无效。"
            )
        return selected

    def read_baseline(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> datetime | None:
        """读取绑定 baseline；未建立时返回 None。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT baseline_at
                    FROM public.wechat_observation_baseline
                    WHERE owner_id = %s AND contact_id = %s AND binding_id = %s
                    """,
                    (owner_id, contact_id, binding_id),
                ).fetchone()
        except psycopg.Error:
            raise ObservationPersistenceError(
                "观察 baseline 读取失败。"
            ) from None
        if row is None:
            return None
        if not isinstance(row[0], datetime):
            raise ObservationPersistenceError(
                "数据库返回的 baseline 时间无效。"
            )
        return row[0]

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
        event_count: int | None = None,
        non_text_count: int = 0,
    ) -> PersistedObservation:
        """在同一事务写入来源并前移水位；同一批次重试保持幂等。"""

        self._validate_batch_arguments(
            binding_id=binding_id,
            mode=mode,
            cli_version=cli_version,
            conversation_locator=conversation_locator,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            record_count=record_count,
            since_local_id=since_local_id,
            since_cursor=since_cursor,
            event_count=event_count,
            non_text_count=non_text_count,
        )
        event_count = record_count if event_count is None else event_count
        self._validate_scope(owner_id=owner_id, contact_id=contact_id)

        try:
            with self._connect() as connection:
                assert_binding_active(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                    conversation_locator=conversation_locator,
                )
                observation, created = self._insert_observation(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                    mode=mode,
                    cli_version=cli_version,
                    conversation_locator=conversation_locator,
                    since_local_id=since_local_id,
                    last_local_id=last_local_id,
                    since_cursor=since_cursor,
                    last_cursor=last_cursor,
                    record_count=record_count,
                    event_count=event_count,
                    non_text_count=non_text_count,
                )
                if created:
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
                return observation
        except ObservationPersistenceError:
            raise
        except psycopg.Error:
            raise ObservationPersistenceError("观察来源记录失败。") from None

    def record_cli_messages(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        observation_id: UUID,
        messages: tuple[NormalizedMessage, ...],
    ) -> tuple[UUID, ...]:
        """将规范化的 CLI 消息写入数据库；跨来源去重复用既有规范消息。

        同一稳定消息身份 (owner_id, contact_id, external_local_id, source_create_time)
        只生成一个规范消息，可关联多个有效来源引用；缺失 create_time 的消息以 -1 参与去重。
        """

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(observation_id, UUID):
            raise TypeError("observation_id 必须是 UUID。")
        if not messages:
            return ()

        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                )
                write = self._write_cli_messages(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    observation_id=observation_id,
                    messages=messages,
                )
                connection.commit()
                return write.message_ids
        except ObservationPersistenceError:
            raise
        except psycopg.Error:
            raise ObservationPersistenceError("CLI 消息写入失败。") from None

    def record_batch_with_messages(
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
        messages: tuple[NormalizedMessage, ...],
        since_local_id: int | None = None,
        since_cursor: str | None = None,
        event_count: int | None = None,
        non_text_count: int = 0,
        processing_records: tuple[ProcessingRecord, ...] | None = None,
    ) -> RecordedObservationBatch:
        """在同一事务写入观察来源、前移水位并写入规范消息。

        来源与消息要么全部成功，要么全部不写入；崩溃重试同一批次时，
        来源由批次唯一索引幂等返回，消息按稳定身份去重，不产生重复。
        """

        self._validate_batch_arguments(
            binding_id=binding_id,
            mode=mode,
            cli_version=cli_version,
            conversation_locator=conversation_locator,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
            record_count=record_count,
            since_local_id=since_local_id,
            since_cursor=since_cursor,
            event_count=event_count,
            non_text_count=non_text_count,
        )
        event_count = record_count if event_count is None else event_count
        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if any(
            message.wechat_metadata is None
            or message.wechat_metadata.external_talker != conversation_locator
            for message in messages
        ):
            raise ObservationPersistenceError(
                "消息会话与已确认观察范围不一致。"
            )

        try:
            with self._connect() as connection:
                assert_binding_active(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                    conversation_locator=conversation_locator,
                )
                # 先拿联系人范围锁再动 cursor 行：rewind_cursor 的顺序
                # 是 contact advisory → cursor 行锁；反过来（行锁 →
                # advisory）会与跨进程的 rewind 互相等待形成锁环。
                lock_contact_scope(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                )
                observation, created = self._insert_observation(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                    mode=mode,
                    cli_version=cli_version,
                    conversation_locator=conversation_locator,
                    since_local_id=since_local_id,
                    last_local_id=last_local_id,
                    since_cursor=since_cursor,
                    last_cursor=last_cursor,
                    record_count=record_count,
                    event_count=event_count,
                    non_text_count=non_text_count,
                )
                self._advance_cursor_if_needed(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                    conversation_locator=conversation_locator,
                    last_local_id=last_local_id,
                    last_cursor=last_cursor,
                )
                write = (
                    self._write_cli_messages(
                        connection,
                        owner_id=owner_id,
                        contact_id=contact_id,
                        observation_id=observation.observation_id,
                        messages=messages,
                    )
                    if messages
                    else _CliMessagesWrite((), ())
                )
                records = (
                    processing_records
                    if processing_records is not None
                    else tuple(
                        message.processing_record
                        for message in messages
                        if message.processing_record is not None
                    )
                )
                if records:
                    save_processing_batch(
                        connection,
                        scope=ContactScope(owner_id, contact_id),
                        source_kind="local_wechat_observation",
                        source_id=observation.observation_id,
                        records=records,
                        receipts={
                            receipt["locator"]: receipt
                            for receipt in write.processing_receipts
                        },
                    )
                connection.commit()
                return RecordedObservationBatch(
                    observation=observation,
                    message_ids=write.message_ids,
                    created_message_ids=(
                        write.created_message_ids if created else ()
                    ),
                )
        except ObservationPersistenceError:
            raise
        except psycopg.Error:
            raise ObservationPersistenceError("观察批次写入失败。") from None

    def record_input_failure(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        conversation_locator: str,
        record: ProcessingRecord,
    ) -> None:
        """已确认绑定的损坏输入只保存真实、无正文失败定位。"""

        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection, owner_id=owner_id, contact_id=contact_id
                )
                assert_binding_active(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    binding_id=binding_id,
                    conversation_locator=conversation_locator,
                )
                save_processing_batch(
                    connection,
                    scope=ContactScope(owner_id, contact_id),
                    source_kind="local_wechat_observation",
                    source_id=None,
                    records=(record,),
                    receipts={},
                    status="failed",
                )
        except psycopg.Error:
            raise ObservationPersistenceError(
                "观察失败记录写入失败。"
            ) from None

    def delete_observation(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        observation_id: UUID,
    ) -> None:
        """按来源级删除路径移除一条观察来源及其消息引用；水位保持不动。

        删除观察来源只移除其 message_source_ref 引用；
        消息与派生资料仅在失去全部有效来源引用后清理。
        """

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(observation_id, UUID):
            raise TypeError("observation_id 必须是 UUID。")
        try:
            with self._connect() as connection:
                lock_contact_scope(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                )
                lock_owner_scope(connection, owner_id=owner_id)
                observed_message_ids = tuple(
                    row[0]
                    for row in connection.execute(
                        """
                        SELECT message_id
                        FROM public.message_source_ref
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND observation_id = %s
                        """,
                        (owner_id, contact_id, observation_id),
                    ).fetchall()
                )
                erase_source_traces(
                    connection, owner_id=owner_id, removed_ids={observation_id}
                )
                erase_source_processing(
                    connection,
                    scope=ContactScope(owner_id, contact_id),
                    source_id=observation_id,
                )
                deleted = connection.execute(
                    """
                    DELETE FROM public.local_wechat_observation
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING id
                    """,
                    (owner_id, contact_id, observation_id),
                ).fetchone()
                if deleted is None:
                    raise ObservationNotFoundError(
                        "指定范围内不存在该观察来源。"
                    )
                orphan_message_ids = collect_orphan_message_ids(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    candidate_message_ids=observed_message_ids,
                )
                delete_source_replies(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    removed_ids={observation_id, *orphan_message_ids},
                )
                cleanup_derived_data(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    removed_ids={observation_id, *orphan_message_ids},
                )
                delete_messages(
                    connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                    message_ids=orphan_message_ids,
                )
                connection.commit()
        except ObservationNotFoundError:
            raise
        except (psycopg.Error, ReplyCleanupError):
            raise ObservationPersistenceError("观察来源删除失败。") from None

    def _validate_batch_arguments(
        self,
        *,
        binding_id: UUID,
        mode: ObservationMode,
        cli_version: str,
        conversation_locator: str,
        last_local_id: int,
        last_cursor: str,
        record_count: int,
        since_local_id: int | None,
        since_cursor: str | None,
        event_count: int | None,
        non_text_count: int,
    ) -> None:
        """观察批次写入前的共享参数校验；非法水位失败关闭。"""

        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        if not isinstance(mode, ObservationMode):
            raise ValueError(
                "观察模式只能是 live、cli_catchup 或 cli_background。"
            )
        self._validate_text(cli_version, "cli_version")
        self._validate_text(conversation_locator, "conversation_locator")
        self._validate_text(last_cursor, "last_cursor")
        if not isinstance(last_local_id, int) or last_local_id <= 0:
            raise ObservationWatermarkError("成功水位 local_id 必须是正整数。")
        if not isinstance(record_count, int) or record_count < 0:
            raise ValueError("record_count 必须是非负整数。")
        if event_count is not None and (
            isinstance(event_count, bool)
            or not isinstance(event_count, int)
            or event_count < 0
        ):
            raise ValueError("event_count 必须是非负整数或 None。")
        if event_count is not None and event_count < record_count:
            raise ValueError("event_count 不能少于文字消息数。")
        if (
            isinstance(non_text_count, bool)
            or not isinstance(non_text_count, int)
            or non_text_count < 0
        ):
            raise ValueError("non_text_count 必须是非负整数。")
        if event_count is not None and non_text_count > event_count:
            raise ValueError("non_text_count 不能超过事件数。")
        if since_local_id is not None and (
            not isinstance(since_local_id, int) or since_local_id <= 0
        ):
            # 首次读取不传起始值；绝不允许非法的 since_local_id=0。
            raise ObservationWatermarkError(
                "起始 local_id 必须是正整数或为空。"
            )
        if since_local_id is not None and since_local_id > last_local_id:
            raise ObservationWatermarkError("起始水位不能晚于成功水位。")
        if since_local_id is None and since_cursor is not None:
            raise ObservationWatermarkError("首次读取不携带起始 cursor。")
        if since_cursor is not None:
            self._validate_text(since_cursor, "since_cursor")

    @staticmethod
    def _insert_observation(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        mode: ObservationMode,
        cli_version: str,
        conversation_locator: str,
        since_local_id: int | None,
        last_local_id: int,
        since_cursor: str | None,
        last_cursor: str,
        record_count: int,
        event_count: int,
        non_text_count: int,
    ) -> tuple[PersistedObservation, bool]:
        """幂等写入观察来源；返回来源与是否首次写入（决定是否前移水位）。"""

        inserted = connection.execute(
            f"""
            INSERT INTO public.local_wechat_observation (
                owner_id, contact_id, binding_id, mode, cli_version,
                conversation_locator, since_local_id, last_local_id,
                since_cursor, last_cursor, record_count,
                event_count, non_text_count, is_reliable
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, true)
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
                event_count,
                non_text_count,
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
                raise ObservationPersistenceError("无法确认观察来源写入结果。")
            updated = connection.execute(
                f"""
                UPDATE public.local_wechat_observation
                SET event_count = %s,
                    non_text_count = %s,
                    is_reliable = true
                WHERE id = %s
                RETURNING {_OBSERVATION_COLUMNS}
                """,
                (event_count, non_text_count, existing[0]),
            ).fetchone()
            if updated is None:
                raise ObservationPersistenceError("无法确认观察来源更新结果。")
            return PostgresObservationStore._from_row(updated), False
        return PostgresObservationStore._from_row(inserted), True

    @staticmethod
    def _write_cli_messages(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        observation_id: UUID,
        messages: tuple[NormalizedMessage, ...],
    ) -> _CliMessagesWrite:
        """在调用方事务内写入规范消息；调用前必须已锁定联系人范围。

        同一稳定消息身份 (owner_id, contact_id, external_local_id, source_create_time)
        只生成一个规范消息，可关联多个有效来源引用；缺失 create_time 的消息以 -1 参与去重。
        """

        message_ids: list[UUID] = []
        created_message_ids: list[UUID | None] = []
        processing_receipts: list[dict[str, Any]] = []
        for message in messages:
            started_at = datetime.now(timezone.utc)
            ref_added = False
            if message.wechat_metadata is None:
                raise ObservationPersistenceError(
                    "CLI 消息缺少微信来源元数据。"
                )
            metadata = message.wechat_metadata
            # 稳定消息身份：(owner_id, contact_id, external_local_id, source_create_time)
            # 缺失 create_time 以 -1 参与去重
            stable_create_time = (
                metadata.source_create_time
                if metadata.source_create_time is not None
                else -1
            )
            existing_metadata = connection.execute(
                """
                SELECT message_id
                FROM public.wechat_message_metadata
                WHERE owner_id = %s
                  AND contact_id = %s
                  AND external_local_id = %s
                  AND COALESCE(source_create_time, -1) = %s
                """,
                (
                    owner_id,
                    contact_id,
                    metadata.external_local_id,
                    stable_create_time,
                ),
            ).fetchone()

            if existing_metadata is not None:
                # 复用既有规范消息，只添加新的来源引用
                message_id = existing_metadata[0]
                # 检查是否已存在该 observation 的引用
                existing_ref = connection.execute(
                    """
                    SELECT 1
                    FROM public.message_source_ref
                    WHERE message_id = %s
                      AND observation_id = %s
                      AND source_locator = %s
                    """,
                    (
                        message_id,
                        observation_id,
                        f"cli:{metadata.external_local_id}",
                    ),
                ).fetchone()
                if existing_ref is None:
                    ref_added = True
                    connection.execute(
                        """
                        INSERT INTO public.message_source_ref (
                            message_id,
                            owner_id,
                            contact_id,
                            source_kind,
                            observation_id,
                            source_locator,
                            raw_payload
                        )
                        VALUES (%s, %s, %s, 'local_wechat_observation', %s, %s, %s::jsonb)
                        """,
                        (
                            message_id,
                            owner_id,
                            contact_id,
                            observation_id,
                            f"cli:{metadata.external_local_id}",
                            metadata.raw_payload_json,
                        ),
                    )
                created_message_ids.append(None)
            else:
                ref_added = True
                # 新规范消息：写入 message + wechat_metadata + message_source_ref
                message_id = uuid4()
                connection.execute(
                    """
                    INSERT INTO public.message (
                        id,
                        owner_id,
                        contact_id,
                        speaker,
                        message_type,
                        text_content,
                        media_placeholder,
                        occurred_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        message_id,
                        owner_id,
                        contact_id,
                        message.speaker,
                        message.message_type,
                        message.text_content,
                        message.media_placeholder,
                        message.occurred_at,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO public.wechat_message_metadata (
                        message_id,
                        owner_id,
                        contact_id,
                        external_local_id,
                        external_server_id,
                        external_talker,
                        source_create_time
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        message_id,
                        owner_id,
                        contact_id,
                        metadata.external_local_id,
                        metadata.external_server_id,
                        metadata.external_talker,
                        metadata.source_create_time,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO public.message_source_ref (
                        message_id,
                        owner_id,
                        contact_id,
                        source_kind,
                        observation_id,
                        source_locator,
                        raw_payload
                    )
                    VALUES (%s, %s, %s, 'local_wechat_observation', %s, %s, %s::jsonb)
                    """,
                    (
                        message_id,
                        owner_id,
                        contact_id,
                        observation_id,
                        f"cli:{metadata.external_local_id}",
                        metadata.raw_payload_json,
                    ),
                )
                created_message_ids.append(message_id)
            message_ids.append(message_id)
            ref = connection.execute(
                "SELECT id FROM public.message_source_ref WHERE owner_id=%s AND contact_id=%s AND message_id=%s AND observation_id=%s AND source_locator=%s",
                (
                    owner_id,
                    contact_id,
                    message_id,
                    observation_id,
                    message.source_locator,
                ),
            ).fetchone()
            processing_receipts.append(
                {
                    "locator": message.source_locator,
                    "message_id": message_id,
                    "source_ref_id": ref[0],
                    "outcome": (
                        "message_reused"
                        if existing_metadata is not None
                        else "message_created"
                    ),
                    "source_ref_added": ref_added,
                    "dedup_key": {
                        "owner_id": str(owner_id),
                        "contact_id": str(contact_id),
                        "external_local_id": metadata.external_local_id,
                        "source_create_time": stable_create_time,
                    },
                    "dedup_rule": "stable_local_id_and_create_time_or_minus_one",
                    "execution": execution(
                        started_at, __file__, status="prepared_for_commit"
                    ),
                }
            )
        return _CliMessagesWrite(
            message_ids=tuple(message_ids),
            created_message_ids=tuple(created_message_ids),
            processing_receipts=tuple(processing_receipts),
        )

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
        advance_observation_cursor(
            connection,
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            conversation_locator=conversation_locator,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
        )

    @staticmethod
    def _advance_cursor_if_needed(
        connection: psycopg.Connection[Any],
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        conversation_locator: str,
        last_local_id: int,
        last_cursor: str,
    ) -> None:
        """重试已存在批次时只在水位落后时前移，避免旧批次重试误报倒退。"""

        current = connection.execute(
            """
            SELECT last_local_id
            FROM public.wechat_observation_cursor
            WHERE owner_id = %s AND contact_id = %s
            """,
            (owner_id, contact_id),
        ).fetchone()
        if current is not None and current[0] >= last_local_id:
            return
        advance_observation_cursor(
            connection,
            owner_id=owner_id,
            contact_id=contact_id,
            binding_id=binding_id,
            conversation_locator=conversation_locator,
            last_local_id=last_local_id,
            last_cursor=last_cursor,
        )

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
            event_count,
            non_text_count,
            is_reliable,
        ) = row
        if not all(
            isinstance(value, UUID)
            for value in (observation_id, owner_id, contact_id, binding_id)
        ):
            raise ObservationPersistenceError("数据库返回的观察范围无效。")
        if not isinstance(read_at, datetime):
            raise ObservationPersistenceError("数据库返回的读取时间无效。")
        if not all(
            isinstance(value, int)
            and not isinstance(value, bool)
            and value >= 0
            for value in (record_count, event_count, non_text_count)
        ):
            raise ObservationPersistenceError("数据库返回的观察计数无效。")
        if event_count < record_count or non_text_count > event_count:
            raise ObservationPersistenceError("数据库返回的观察计数不一致。")
        if not isinstance(is_reliable, bool):
            raise ObservationPersistenceError("数据库返回的可靠性标记无效。")
        try:
            mode = ObservationMode(mode_text)
        except ValueError as error:
            raise ObservationPersistenceError(
                "数据库返回的观察模式无效。"
            ) from error
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
            event_count=event_count,
            non_text_count=non_text_count,
            is_reliable=is_reliable,
        )

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._database_url)
