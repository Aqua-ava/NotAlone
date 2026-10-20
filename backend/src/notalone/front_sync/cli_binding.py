"""CLI 私聊会话预览与一次性批量绑定。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Protocol
from uuid import UUID

from notalone.persistence.conversation_repository import (
    CliBindingCreation,
    ConversationBindingNotFoundError,
    PersistedConversationBinding,
    PostgresConversationBindingRepository,
)
from notalone.wechat_cli import LocalWechatCli
from notalone.wechat_cli.models import ChatCandidate


@dataclass(frozen=True, slots=True)
class CliBindingCandidateView:
    """批量绑定页面所需的最小会话投影。"""

    username: str
    display_name: str
    last_timestamp: int | None
    bound_contact_id: str | None


@dataclass(frozen=True, slots=True)
class CliBindingSelection:
    """用户在批量确认前对一个私聊会话的显式选择。"""

    locator: str
    contact_id: UUID | None = None
    display_name: str | None = None
    observed_display_name: str | None = None


class CliSessionSourcePort(Protocol):
    def sessions(
        self,
        *,
        type_filter: str | None = None,
        limit: int | None = None,
    ) -> tuple[ChatCandidate, ...]:
        """读取 CLI 会话元数据。"""


class CliBindingBatchRepositoryPort(Protocol):
    def read_binding(
        self, *, owner_id: UUID, contact_id: UUID, binding_id: UUID,
    ) -> PersistedConversationBinding:
        """按完整内部身份读取绑定。"""

    def revoke_binding(
        self, *, owner_id: UUID, contact_id: UUID, binding_id: UUID,
    ) -> PersistedConversationBinding:
        """幂等撤销完整内部身份范围的绑定。"""

    def create_cli_bindings_batch(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        items: Sequence[CliBindingCreation],
        baseline_at: datetime,
    ) -> tuple[PersistedConversationBinding, ...]:
        """在一个事务内创建联系人、绑定和 baseline。"""


class CliBindingCoordinator:
    """把 CLI 会话元数据转成一次性、可审计的绑定确认。"""

    __slots__ = (
        "_owner_id",
        "_channel",
        "_account_scope",
        "_cli",
        "_bindings",
        "_batch_repository",
        "_clock",
    )

    def __init__(
        self,
        *,
        owner_id: UUID,
        channel: str,
        account_scope: str,
        cli: CliSessionSourcePort | LocalWechatCli,
        bindings: object,
        batch_repository: CliBindingBatchRepositoryPort
        | PostgresConversationBindingRepository,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not isinstance(owner_id, UUID):
            raise TypeError("owner_id 必须是 UUID。")
        self._owner_id = owner_id
        self._channel = channel
        self._account_scope = account_scope
        self._cli = cli
        self._bindings = bindings
        self._batch_repository = batch_repository
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def list_candidates(self) -> tuple[CliBindingCandidateView, ...]:
        """返回 CLI 可见的一对一会话与已有绑定关系。"""

        sessions = self._private_sessions()
        active = self._active_bindings()
        bound_by_locator = {
            binding.conversation_locator: str(binding.scope.contact_id)
            for binding in active
        }
        return tuple(
            CliBindingCandidateView(
                username=candidate.username,
                display_name=candidate.display_name,
                last_timestamp=candidate.last_timestamp,
                bound_contact_id=bound_by_locator.get(candidate.username),
            )
            for candidate in sessions
        )

    def confirm(
        self,
        selections: Sequence[CliBindingSelection],
    ) -> tuple[PersistedConversationBinding, ...]:
        """校验当前预览后一次性写入所选未绑定会话。"""

        if not isinstance(selections, Sequence) or isinstance(selections, (str, bytes)):
            raise TypeError("批量绑定选择必须是序列。")
        normalized: list[CliBindingSelection] = []
        seen: set[str] = set()
        for selection in selections:
            if not isinstance(selection, CliBindingSelection):
                raise TypeError("批量绑定选择结构无效。")
            if not isinstance(selection.locator, str):
                raise TypeError("locator 必须是字符串。")
            locator = selection.locator.strip()
            if not locator or locator in seen:
                raise ValueError("批量绑定选择必须包含唯一的会话定位标识。")
            if selection.contact_id is not None and not isinstance(selection.contact_id, UUID):
                raise TypeError("contact_id 必须是 UUID 或 None。")
            if selection.display_name is not None and (
                not isinstance(selection.display_name, str)
                or not selection.display_name.strip()
            ):
                raise ValueError("display_name 必须是非空字符串或 None。")
            if selection.observed_display_name is not None and (
                not isinstance(selection.observed_display_name, str)
                or not selection.observed_display_name.strip()
            ):
                raise ValueError("observed_display_name 必须是非空字符串或 None。")
            seen.add(locator)
            normalized.append(
                CliBindingSelection(
                    locator=locator,
                    contact_id=selection.contact_id,
                    display_name=(
                        selection.display_name.strip()
                        if selection.display_name is not None
                        else None
                    ),
                    observed_display_name=selection.observed_display_name,
                )
            )

        if not normalized:
            return ()
        candidates = {candidate.username: candidate for candidate in self._private_sessions()}
        active = {
            binding.conversation_locator: binding for binding in self._active_bindings()
        }
        items: list[CliBindingCreation] = []
        for selection in normalized:
            candidate = candidates.get(selection.locator)
            if candidate is None:
                raise ValueError("所选会话不在当前 CLI 私聊列表中。")
            if (
                selection.observed_display_name is not None
                and selection.observed_display_name != candidate.display_name
            ):
                raise ValueError("所选会话显示名已经变化，须重新核对。")
            existing = active.get(selection.locator)
            if existing is not None:
                # App 明确新建的选择不能静默变成对已有联系人的确认；旧调用保持跳过兼容。
                if selection.observed_display_name is not None and selection.contact_id is None:
                    raise ValueError("所选会话已建立绑定，须重新核对联系人。")
                if (
                    selection.contact_id is not None
                    and selection.contact_id != existing.scope.contact_id
                ):
                    raise ValueError("已有会话绑定不能改绑到其他联系人。")
                continue
            items.append(
                CliBindingCreation(
                    conversation_locator=candidate.username,
                    display_name=selection.display_name or candidate.display_name,
                    contact_id=selection.contact_id,
                )
            )
        if not items:
            return ()
        return self._batch_repository.create_cli_bindings_batch(
            owner_id=self._owner_id,
            channel=self._channel,
            account_scope=self._account_scope,
            items=tuple(items),
            baseline_at=self._clock(),
        )

    def list_bindings(self, *, include_revoked: bool = False) -> tuple[PersistedConversationBinding, ...]:
        """默认只列有效授权；显式查看关联时包含已保存的撤销记录。"""

        if include_revoked:
            return tuple(self._bindings.list_saved_bindings(
                owner_id=self._owner_id, channel=self._channel,
                account_scope=self._account_scope,
            ))
        return self._active_bindings()

    def revoke_binding(
        self, *, contact_id: UUID, binding_id: UUID,
    ) -> PersistedConversationBinding:
        """按固定运行范围撤销；调用方须持有同步循环的同一互斥锁。"""

        binding = self._batch_repository.read_binding(
            owner_id=self._owner_id, contact_id=contact_id, binding_id=binding_id,
        )
        if (
            binding.channel != self._channel
            or binding.account_scope != self._account_scope
        ):
            raise ConversationBindingNotFoundError("会话绑定不在当前运行范围。")
        return self._batch_repository.revoke_binding(
            owner_id=self._owner_id, contact_id=contact_id, binding_id=binding_id,
        )

    def _private_sessions(self) -> tuple[ChatCandidate, ...]:
        sessions = self._cli.sessions(type_filter="private", limit=5000)
        return tuple(candidate for candidate in sessions if candidate.chat_type == "private")

    def _active_bindings(self) -> tuple[PersistedConversationBinding, ...]:
        return tuple(
            self._bindings.list_active_bindings(
                owner_id=self._owner_id,
                channel=self._channel,
                account_scope=self._account_scope,
            )
        )
