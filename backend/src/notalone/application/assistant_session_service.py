"""默认助手会话的公开应用边界，复用既有单次候选回复流程。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol
from uuid import UUID

from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt
from notalone.application.reply_service import ReplyService, ReplyServiceRequest
from notalone.reply.errors import ReplyInProgressError
from notalone.reply.interface import ReplyGenerated
from notalone.scopes import ContactScope

if TYPE_CHECKING:
    from notalone.persistence.assistant_session_inputs import AssistantInput


class AssistantSessionError(RuntimeError):
    """会话错误只含稳定分类，不回显正文或驱动异常。"""


class AssistantSessionNotFound(AssistantSessionError):
    pass


class AssistantSessionConflict(AssistantSessionError):
    pass


class AssistantSessionPersistenceError(AssistantSessionError):
    pass


class AssistantSessionRejected(AssistantSessionError):
    def __init__(self, reason: str) -> None:
        super().__init__("助手会话请求被拒绝。")
        self.reason = reason


@dataclass(frozen=True, slots=True, repr=False)
class AssistantTurn:
    turn_id: UUID
    session_id: UUID
    input_version_id: UUID
    request_key: UUID
    state: str
    input: dict[str, Any] | None
    reply: ReplyGenerated | None
    interruption_reason: str | None = None


@dataclass(frozen=True, slots=True, repr=False)
class AssistantSessionSnapshot:
    session_id: UUID
    current_input_version_id: UUID | None
    turns: tuple[AssistantTurn, ...]
    inputs: tuple[AssistantInput, ...]


@dataclass(frozen=True, slots=True, repr=False)
class AssistantSessionSummary:
    session_id: UUID
    is_current: bool


class AssistantSessionCatalogPort(Protocol):
    def new(self, scope: ContactScope) -> UUID: ...

    def list_sessions(self, scope: ContactScope) -> tuple[AssistantSessionSummary, ...]: ...

    def select(self, scope: ContactScope, session_id: UUID) -> UUID: ...


class AssistantSessionStore(Protocol):
    def default(self, scope: ContactScope) -> UUID: ...

    def read(self, scope: ContactScope, session_id: UUID) -> tuple[AssistantTurn, ...]: ...

    def read_session(self, scope: ContactScope, session_id: UUID) -> AssistantSessionSnapshot: ...

    def delete(self, scope: ContactScope, session_id: UUID) -> None: ...

    def record_discussion_input(
        self, scope: ContactScope, session_id: UUID, content: dict[str, Any],
        expected_input_version_id: UUID | None = None,
        *, verified_dependencies: tuple[UUID, ...] = (),
    ) -> UUID: ...

    def is_current_input(self, scope: ContactScope, session_id: UUID, input_version_id: UUID) -> bool: ...

    def interrupt(
        self, scope: ContactScope, session_id: UUID, request_key: UUID, input_version_id: UUID,
    ) -> AssistantGenerationReceipt: ...

    def reserve(
        self, scope: ContactScope, session_id: UUID, request: ReplyServiceRequest,
    ) -> UUID: ...

    def reserve_prepared(
        self, scope: ContactScope, session_id: UUID, request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt: ...

    def reserve_replacement_prepared(
        self, scope: ContactScope, session_id: UUID, running_request_key: UUID,
        request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt: ...

    def reserve_replacement(
        self, scope: ContactScope, session_id: UUID, running_request_key: UUID,
        request: ReplyServiceRequest,
    ) -> UUID: ...

    def complete(
        self, scope: ContactScope, session_id: UUID, turn_id: UUID,
        reply: ReplyGenerated,
    ) -> AssistantTurn: ...

    def fail(self, scope: ContactScope, turn_id: UUID) -> None: ...


class AssistantSessionService:
    """未可靠保存的生成不能作为完成结果返回；失败重试沿用原请求身份。"""

    def __init__(
        self, *, store: AssistantSessionStore, reply: ReplyService | None,
        catalog: AssistantSessionCatalogPort | None = None,
    ) -> None:
        self._store = store
        self._reply = reply
        self._catalog = catalog

    def default(self, *, owner_id: UUID, contact_id: UUID) -> UUID:
        return self._store.default(ContactScope(owner_id, contact_id))

    def _catalog_port(self) -> AssistantSessionCatalogPort:
        if self._catalog is None:
            raise AssistantSessionPersistenceError("助手会话目录尚不可用。")
        return self._catalog

    def new(self, *, owner_id: UUID, contact_id: UUID) -> UUID:
        return self._catalog_port().new(ContactScope(owner_id, contact_id))

    def list_sessions(self, *, owner_id: UUID, contact_id: UUID) -> tuple[AssistantSessionSummary, ...]:
        return self._catalog_port().list_sessions(ContactScope(owner_id, contact_id))

    def select(self, *, owner_id: UUID, contact_id: UUID, session_id: UUID) -> UUID:
        return self._catalog_port().select(ContactScope(owner_id, contact_id), session_id)

    def read(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
    ) -> tuple[AssistantTurn, ...]:
        return self._store.read(ContactScope(owner_id, contact_id), session_id)

    def read_session(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
    ) -> AssistantSessionSnapshot:
        return self._store.read_session(ContactScope(owner_id, contact_id), session_id)

    def delete(self, *, owner_id: UUID, contact_id: UUID, session_id: UUID) -> None:
        self._store.delete(ContactScope(owner_id, contact_id), session_id)

    def record_discussion_input(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, content: dict[str, Any],
        expected_input_version_id: UUID | None = None,
        verified_dependencies: tuple[UUID, ...] = (),
    ) -> UUID:
        return self._store.record_discussion_input(
            ContactScope(owner_id, contact_id), session_id, content, expected_input_version_id,
            verified_dependencies=verified_dependencies,
        )

    def prepare(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt:
        """领取原生成输入并返回无正文身份，不启动模型或改写已有状态。"""

        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        return self._store.reserve_prepared(ContactScope(owner_id, contact_id), session_id, request)

    def interrupt(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request_key: UUID, input_version_id: UUID,
    ) -> AssistantGenerationReceipt:
        return self._store.interrupt(ContactScope(owner_id, contact_id), session_id, request_key, input_version_id)

    def generate(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request: ReplyServiceRequest,
    ) -> AssistantTurn:
        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        turn_id = self._store.reserve(scope, session_id, request)
        return self._generate_reserved(scope, session_id, turn_id, request)

    def prepare_replacement(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        running_request_key: UUID, request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt:
        """原事务内失效显式旧键并领取新输入；这里只返回实际身份。"""

        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        return self._store.reserve_replacement_prepared(
            ContactScope(owner_id, contact_id), session_id, running_request_key, request,
        )

    def replace(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        running_request_key: UUID, request: ReplyServiceRequest,
    ) -> AssistantTurn:
        """显式旧请求失效后继续既有生成流程，候选仍须可靠保存。"""

        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        turn_id = self._store.reserve_replacement(scope, session_id, running_request_key, request)
        return self._generate_reserved(scope, session_id, turn_id, request)

    def _generate_reserved(
        self, scope: ContactScope, session_id: UUID, turn_id: UUID, request: ReplyServiceRequest,
    ) -> AssistantTurn:
        reply = self._reply
        if reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        try:
            result = reply.generate(
                owner_id=scope.owner_id, contact_id=scope.contact_id, request=request,
            )
            if result.reply is None:
                raise AssistantSessionRejected(result.reason or "reply_rejected")
            if not isinstance(result.reply, ReplyGenerated):
                raise AssistantSessionRejected("reply_in_progress")
            return self._store.complete(scope, session_id, turn_id, result.reply)
        except ReplyInProgressError:
            raise
        except Exception:
            try:
                self._store.fail(scope, turn_id)
            except AssistantSessionError:
                pass
            raise
