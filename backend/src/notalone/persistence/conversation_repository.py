"""conversation_binding 的 PostgreSQL 持久化与验证适配器。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from collections.abc import Sequence
from typing import Any, Mapping
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.conversation import (
    ConversationBinding,
    ConversationBindingStatus,
    ConversationObservation,
    ConversationObservationState,
    ConversationResolution,
    VerificationReason,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


class ConversationBindingPersistenceError(RuntimeError):
    """不暴露 SQL、连接信息或会话定位内容的持久化错误。"""


class ConversationBindingNotFoundError(ConversationBindingPersistenceError):
    """指定的 owner、联系人或会话绑定不存在。"""


class ConversationBindingConflictError(ConversationBindingPersistenceError):
    """会话定位标识已经绑定到其他有效会话。"""


@dataclass(frozen=True, slots=True)
class CliBindingCreation:
    """一次 CLI 批量确认中的联系人与会话绑定写入项。"""

    conversation_locator: str
    display_name: str
    contact_id: UUID | None = None


# 统一的绑定列清单，保证读写字段顺序一致。
_BINDING_COLUMNS = (
    "id, owner_id, contact_id, channel, account_scope, conversation_locator, "
    "display_name, metadata_summary, visual_fingerprint, status, "
    "last_verified_at, created_at, updated_at"
)


@dataclass(frozen=True, slots=True)
class PersistedConversationBinding:
    """数据库中会话绑定的最小非聊天内容投影。"""

    binding_id: UUID
    scope: ContactScope
    channel: str
    account_scope: str
    conversation_locator: str
    status: ConversationBindingStatus
    last_verified_at: datetime
    created_at: datetime
    updated_at: datetime
    display_name: str | None = None
    metadata_summary: Mapping[str, Any] | None = None
    visual_fingerprint: str | None = None

    def as_domain(self) -> ConversationBinding:
        """转换成 ConversationPort 使用的最小绑定实体。"""

        return ConversationBinding(
            binding_id=self.binding_id,
            scope=self.scope,
            status=self.status,
        )


class PostgresConversationBindingRepository:
    """按 owner/contact 范围读写用户确认的会话绑定。"""

    __slots__ = ("_database_url",)

    def __init__(self, database_url: str) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        self._database_url = database_url

    def create_binding(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        channel: str,
        account_scope: str,
        conversation_locator: str,
        display_name: str | None = None,
        metadata_summary: Mapping[str, Any] | None = None,
        visual_fingerprint: str | None = None,
        binding_id: UUID | None = None,
    ) -> PersistedConversationBinding:
        """创建一条已经由用户确认的会话绑定。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        self._validate_text(channel, "channel")
        self._validate_text(account_scope, "account_scope")
        self._validate_text(conversation_locator, "conversation_locator")
        self._validate_optional_text(display_name, "display_name")
        self._validate_optional_text(visual_fingerprint, "visual_fingerprint")
        if metadata_summary is not None and not isinstance(metadata_summary, Mapping):
            raise TypeError("metadata_summary 必须是键值映射或 None。")
        selected_binding_id = binding_id or uuid4()
        if not isinstance(selected_binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")

        try:
            with psycopg.connect(self._database_url) as connection:
                self._assert_contact_exists(
                    connection=connection,
                    owner_id=owner_id,
                    contact_id=contact_id,
                )
                row = connection.execute(
                    f"""
                    INSERT INTO public.conversation_binding (
                        id,
                        owner_id,
                        contact_id,
                        channel,
                        account_scope,
                        conversation_locator,
                        display_name,
                        metadata_summary,
                        visual_fingerprint
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING {_BINDING_COLUMNS}
                    """,
                    (
                        selected_binding_id,
                        owner_id,
                        contact_id,
                        channel,
                        account_scope,
                        conversation_locator,
                        display_name,
                        None if metadata_summary is None else Jsonb(dict(metadata_summary)),
                        visual_fingerprint,
                    ),
                ).fetchone()
                if row is None:
                    raise ConversationBindingPersistenceError(
                        "无法确认会话绑定写入结果。"
                    )
                return self._from_row(row)
        except (
            ConversationBindingConflictError,
            ConversationBindingNotFoundError,
            ConversationBindingPersistenceError,
        ):
            raise
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name in {
                "conversation_binding_active_locator_unique",
                "conversation_binding_pkey",
            }:
                raise ConversationBindingConflictError(
                    "会话定位已经存在有效绑定，未写入新绑定。"
                ) from None
            raise ConversationBindingPersistenceError(
                "会话绑定写入失败，未写入绑定。"
            ) from None
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "会话绑定写入失败，未写入绑定。"
            ) from None

    def read_binding(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> PersistedConversationBinding:
        """按完整 owner/contact/binding 范围读取绑定。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    f"""
                    SELECT {_BINDING_COLUMNS}
                    FROM public.conversation_binding
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    """,
                    (owner_id, contact_id, binding_id),
                ).fetchone()
                if row is None:
                    raise ConversationBindingNotFoundError(
                        "会话绑定不存在。"
                    )
                return self._from_row(row)
        except ConversationBindingNotFoundError:
            raise
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "会话绑定读取失败。"
            ) from None

    def revoke_binding(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
    ) -> PersistedConversationBinding:
        """撤销完整范围内的绑定；重复撤销保持幂等。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    f"""
                    UPDATE public.conversation_binding
                    SET status = 'revoked',
                        revoked_at = COALESCE(revoked_at, now()),
                        updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING {_BINDING_COLUMNS}
                    """,
                    (owner_id, contact_id, binding_id),
                ).fetchone()
                if row is None:
                    raise ConversationBindingNotFoundError(
                        "会话绑定不存在。"
                    )
                return self._from_row(row)
        except ConversationBindingNotFoundError:
            raise
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "会话绑定撤销失败。"
            ) from None

    def read_for_verification(
        self,
        *,
        owner_id: UUID,
        binding_id: UUID,
    ) -> PersistedConversationBinding | None:
        """读取当前用户的绑定并刷新 active 绑定的最近验证时间。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    f"""
                    SELECT {_BINDING_COLUMNS}
                    FROM public.conversation_binding
                    WHERE owner_id = %s AND id = %s
                    FOR UPDATE
                    """,
                    (owner_id, binding_id),
                ).fetchone()
                if row is None:
                    return None
                binding = self._from_row(row)
                if binding.status is ConversationBindingStatus.REVOKED:
                    return binding
                refreshed = connection.execute(
                    f"""
                    UPDATE public.conversation_binding
                    SET last_verified_at = now(), updated_at = now()
                    WHERE owner_id = %s AND id = %s
                    RETURNING {_BINDING_COLUMNS}
                    """,
                    (owner_id, binding_id),
                ).fetchone()
                if refreshed is None:
                    raise ConversationBindingPersistenceError(
                        "无法确认会话绑定验证时间。"
                    )
                return self._from_row(refreshed)
        except ConversationBindingPersistenceError:
            raise
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "会话绑定验证读取失败。"
            ) from None

    def read_active_by_locator(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        conversation_locator: str,
    ) -> PersistedConversationBinding | None:
        """按外部会话定位标识读取当前 owner 的 active 绑定。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        self._validate_text(channel, "channel")
        self._validate_text(account_scope, "account_scope")
        self._validate_text(conversation_locator, "conversation_locator")
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    f"""
                    SELECT {_BINDING_COLUMNS}
                    FROM public.conversation_binding
                    WHERE owner_id = %s AND channel = %s
                      AND account_scope = %s AND conversation_locator = %s
                      AND status = 'active'
                    """,
                    (owner_id, channel, account_scope, conversation_locator),
                ).fetchone()
                if row is None:
                    return None
                return self._from_row(row)
        except ConversationBindingPersistenceError:
            raise
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "会话绑定定位读取失败。"
            ) from None

    def list_active_bindings(
        self,
        *,
        owner_id: UUID,
        channel: str | None = None,
        account_scope: str | None = None,
    ) -> tuple[PersistedConversationBinding, ...]:
        """列出当前 owner 的 active 绑定，供匹配层投影为证据。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if channel is not None:
            self._validate_text(channel, "channel")
        if account_scope is not None:
            self._validate_text(account_scope, "account_scope")
        clauses = ["owner_id = %s", "status = 'active'"]
        parameters: list[object] = [owner_id]
        if channel is not None:
            clauses.append("channel = %s")
            parameters.append(channel)
        if account_scope is not None:
            clauses.append("account_scope = %s")
            parameters.append(account_scope)
        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(
                    f"""
                    SELECT {_BINDING_COLUMNS}
                    FROM public.conversation_binding
                    WHERE {' AND '.join(clauses)}
                    ORDER BY updated_at DESC
                    """,
                    tuple(parameters),
                ).fetchall()
                return tuple(self._from_row(row) for row in rows)
        except ConversationBindingPersistenceError:
            raise
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "会话绑定列表读取失败。"
            ) from None

    def create_cli_bindings_batch(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        items: Sequence[CliBindingCreation],
        baseline_at: datetime,
    ) -> tuple[PersistedConversationBinding, ...]:
        """在一个事务内创建 CLI 批量确认的联系人、绑定和 baseline。"""

        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        self._validate_text(channel, "channel")
        self._validate_text(account_scope, "account_scope")
        if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
            raise TypeError("items 必须是序列。")
        if not items:
            return ()
        if not isinstance(baseline_at, datetime) or baseline_at.tzinfo is None:
            raise TypeError("baseline_at 必须是带时区的 datetime。")
        seen: set[str] = set()
        for item in items:
            if not isinstance(item, CliBindingCreation):
                raise TypeError("CLI 批量绑定项结构无效。")
            self._validate_text(item.conversation_locator, "conversation_locator")
            self._validate_text(item.display_name, "display_name")
            if item.conversation_locator in seen:
                raise ValueError("CLI 批量绑定项不能重复会话定位标识。")
            if item.contact_id is not None and not isinstance(item.contact_id, UUID):
                raise TypeError("contact_id 必须是 UUID 或 None。")
            seen.add(item.conversation_locator)

        created: list[PersistedConversationBinding] = []
        try:
            with psycopg.connect(self._database_url) as connection:
                for item in items:
                    contact_id = item.contact_id
                    if contact_id is None:
                        contact_id = connection.execute(
                            """
                            INSERT INTO public.contact (owner_id, display_name)
                            VALUES (%s, %s)
                            RETURNING id
                            """,
                            (owner_id, item.display_name),
                        ).fetchone()[0]
                    else:
                        self._assert_contact_exists(
                            connection=connection,
                            owner_id=owner_id,
                            contact_id=contact_id,
                        )
                    row = connection.execute(
                        f"""
                        INSERT INTO public.conversation_binding (
                            id,
                            owner_id,
                            contact_id,
                            channel,
                            account_scope,
                            conversation_locator,
                            display_name
                        )
                        VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s)
                        RETURNING {_BINDING_COLUMNS}
                        """,
                        (
                            owner_id,
                            contact_id,
                            channel,
                            account_scope,
                            item.conversation_locator,
                            item.display_name,
                        ),
                    ).fetchone()
                    if row is None:
                        raise ConversationBindingPersistenceError(
                            "无法确认 CLI 批量绑定写入结果。"
                        )
                    binding = self._from_row(row)
                    connection.execute(
                        """
                        INSERT INTO public.wechat_observation_baseline (
                            owner_id, contact_id, binding_id,
                            conversation_locator, baseline_at
                        )
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            owner_id,
                            contact_id,
                            binding.binding_id,
                            item.conversation_locator,
                            baseline_at,
                        ),
                    )
                    created.append(binding)
                connection.commit()
        except (
            ConversationBindingConflictError,
            ConversationBindingNotFoundError,
            ConversationBindingPersistenceError,
        ):
            raise
        except psycopg.errors.UniqueViolation as error:
            if error.diag.constraint_name in {
                "conversation_binding_active_locator_unique",
                "conversation_binding_pkey",
            }:
                raise ConversationBindingConflictError(
                    "批量绑定存在会话冲突，未写入任何绑定。"
                ) from None
            raise ConversationBindingPersistenceError(
                "CLI 批量绑定写入失败，未写入任何绑定。"
            ) from None
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "CLI 批量绑定写入失败，未写入任何绑定。"
            ) from None
        return tuple(created)

    def update_matching_metadata(
        self,
        *,
        owner_id: UUID,
        contact_id: UUID,
        binding_id: UUID,
        display_name: str | None = None,
        metadata_summary: Mapping[str, Any] | None = None,
        visual_fingerprint: str | None = None,
    ) -> PersistedConversationBinding:
        """用户确认后更新绑定的匹配证据；只更新传入的字段。"""

        self._validate_scope(owner_id=owner_id, contact_id=contact_id)
        if not isinstance(binding_id, UUID):
            raise TypeError("binding_id 必须是 UUID。")
        self._validate_optional_text(display_name, "display_name")
        self._validate_optional_text(visual_fingerprint, "visual_fingerprint")
        if metadata_summary is not None and not isinstance(metadata_summary, Mapping):
            raise TypeError("metadata_summary 必须是键值映射或 None。")
        if display_name is None and metadata_summary is None and visual_fingerprint is None:
            raise ValueError("至少需要更新一个匹配证据字段。")

        assignments: list[str] = []
        parameters: list[object] = []
        if display_name is not None:
            assignments.append("display_name = %s")
            parameters.append(display_name)
        if metadata_summary is not None:
            assignments.append("metadata_summary = %s")
            parameters.append(Jsonb(dict(metadata_summary)))
        if visual_fingerprint is not None:
            assignments.append("visual_fingerprint = %s")
            parameters.append(visual_fingerprint)
        parameters.extend([owner_id, contact_id, binding_id])
        try:
            with psycopg.connect(self._database_url) as connection:
                row = connection.execute(
                    f"""
                    UPDATE public.conversation_binding
                    SET {', '.join(assignments)}, updated_at = now()
                    WHERE owner_id = %s AND contact_id = %s AND id = %s
                    RETURNING {_BINDING_COLUMNS}
                    """,
                    tuple(parameters),
                ).fetchone()
                if row is None:
                    raise ConversationBindingNotFoundError(
                        "会话绑定不存在。"
                    )
                return self._from_row(row)
        except ConversationBindingNotFoundError:
            raise
        except psycopg.Error:
            raise ConversationBindingPersistenceError(
                "会话绑定证据更新失败。"
            ) from None

    @staticmethod
    def _assert_contact_exists(
        *,
        connection: psycopg.Connection[Any],
        owner_id: UUID,
        contact_id: UUID,
    ) -> None:
        row = connection.execute(
            """
            SELECT 1
            FROM public.contact
            WHERE owner_id = %s AND id = %s
            FOR KEY SHARE
            """,
            (owner_id, contact_id),
        ).fetchone()
        if row is None:
            raise ConversationBindingNotFoundError(
                "指定的 owner/contact 范围不存在。"
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
    def _validate_optional_text(value: str | None, field_name: str) -> None:
        if value is None:
            return
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field_name} 必须是非空字符串或 None。")

    @staticmethod
    def _from_row(row: tuple[object, ...]) -> PersistedConversationBinding:
        (
            binding_id,
            owner_id,
            contact_id,
            channel,
            account_scope,
            conversation_locator,
            display_name,
            metadata_summary,
            visual_fingerprint,
            status,
            last_verified_at,
            created_at,
            updated_at,
        ) = row
        if not all(
            isinstance(value, UUID)
            for value in (binding_id, owner_id, contact_id)
        ):
            raise ConversationBindingPersistenceError(
                "数据库返回的会话绑定范围无效。"
            )
        if not all(
            isinstance(value, str)
            for value in (
                channel,
                account_scope,
                conversation_locator,
                status,
            )
        ) or not all(
            isinstance(value, datetime)
            for value in (last_verified_at, created_at, updated_at)
        ):
            raise ConversationBindingPersistenceError(
                "数据库返回的会话绑定字段无效。"
            )
        if display_name is not None and not isinstance(display_name, str):
            raise ConversationBindingPersistenceError(
                "数据库返回的 display_name 无效。"
            )
        if metadata_summary is not None and not isinstance(metadata_summary, Mapping):
            raise ConversationBindingPersistenceError(
                "数据库返回的匹配证据摘要无效。"
            )
        if visual_fingerprint is not None and not isinstance(visual_fingerprint, str):
            raise ConversationBindingPersistenceError(
                "数据库返回的视觉指纹无效。"
            )
        try:
            binding_status = ConversationBindingStatus(status)
        except ValueError as error:
            raise ConversationBindingPersistenceError(
                "数据库返回的会话绑定状态无效。"
            ) from error
        return PersistedConversationBinding(
            binding_id=binding_id,
            scope=ContactScope(owner_id=owner_id, contact_id=contact_id),
            channel=channel,
            account_scope=account_scope,
            conversation_locator=conversation_locator,
            status=binding_status,
            last_verified_at=last_verified_at,
            created_at=created_at,
            updated_at=updated_at,
            display_name=display_name,
            metadata_summary=metadata_summary,
            visual_fingerprint=visual_fingerprint,
        )


class PostgresConversationPort:
    """使用 PostgreSQL 已确认绑定验证当前会话的 ConversationPort。"""

    __slots__ = ("_owner_id", "_observation", "_repository")

    def __init__(
        self,
        database_url: str,
        *,
        owner_id: UUID,
        observation: ConversationObservation,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        if not isinstance(observation, ConversationObservation):
            raise TypeError("observation 必须是 ConversationObservation。")
        self._owner_id = owner_id
        self._observation = observation
        self._repository = PostgresConversationBindingRepository(database_url)

    def verify_current(self) -> ConversationResolution:
        """先处理观察状态，再按 owner 隔离查询确认过的绑定。"""

        observation = self._observation
        state_reasons = {
            ConversationObservationState.FIRST_BINDING: (
                ConversationResolution.needs_user_confirmation(
                    VerificationReason.FIRST_BINDING
                )
            ),
            ConversationObservationState.CONVERSATION_CHANGED: (
                ConversationResolution.needs_user_confirmation(
                    VerificationReason.CONVERSATION_CHANGED
                )
            ),
            ConversationObservationState.AMBIGUOUS: (
                ConversationResolution.needs_user_confirmation(
                    VerificationReason.AMBIGUOUS_MATCH
                )
            ),
            ConversationObservationState.LOW_CONFIDENCE: (
                ConversationResolution.needs_user_confirmation(
                    VerificationReason.LOW_CONFIDENCE
                )
            ),
            ConversationObservationState.UNAVAILABLE: (
                ConversationResolution.rejected(
                    VerificationReason.NO_ACTIVE_BINDING
                )
            ),
        }
        if observation.state in state_reasons:
            return state_reasons[observation.state]
        if observation.binding_id is None:
            return ConversationResolution.rejected(
                VerificationReason.NO_ACTIVE_BINDING
            )

        binding = self._repository.read_for_verification(
            owner_id=self._owner_id,
            binding_id=observation.binding_id,
        )
        if binding is None:
            return ConversationResolution.rejected(
                VerificationReason.NO_ACTIVE_BINDING
            )
        if binding.status is ConversationBindingStatus.REVOKED:
            return ConversationResolution.rejected(
                VerificationReason.BINDING_REVOKED
            )
        return ConversationResolution.ready(
            VerifiedConversationScope(
                owner_id=binding.scope.owner_id,
                contact_id=binding.scope.contact_id,
                conversation_binding_id=binding.binding_id,
            )
        )
