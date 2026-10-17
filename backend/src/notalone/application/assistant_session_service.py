"""默认助手会话的公开应用边界，复用既有单次候选回复流程。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol
from uuid import UUID

from notalone.application.assistant_generation_lifecycle import AssistantGenerationReceipt, AssistantPreparationFormatReceipt
from notalone.application.assistant_message_adoption import AssistantMessageAdoptionRequest
from notalone.application.reply_service import ReplyService, ReplyServiceRequest
from notalone.reply.errors import ReplyInProgressError
from notalone.reply.interface import ReplyGenerated
from notalone.scopes import ContactScope

if TYPE_CHECKING:
    from notalone.application.assistant_interrupted_recovery import RecoverInterruptedAssistantGeneration
    from notalone.application.assistant_candidate_carry import CarriedAssistantSession, CarryAssistantCandidate
    from notalone.persistence.assistant_session_inputs import AssistantInput
    from notalone.application.assistant_continuation import (
        AssistantContinuationPort, AssistantContinuationReservation, ContinueAssistantSession,
    )


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
    generation_active: bool | None = None
    requires_reprepare: bool = False


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

    def new_with_candidate(
        self, scope: ContactScope, session_id: UUID, command: CarryAssistantCandidate,
    ) -> CarriedAssistantSession: ...

    def list_sessions(self, scope: ContactScope) -> tuple[AssistantSessionSummary, ...]: ...

    def select(self, scope: ContactScope, session_id: UUID) -> UUID: ...


class AssistantSessionStore(Protocol):
    def preparation_format(self, scope: ContactScope, session_id: UUID, request_key: UUID,
                           input_version_id: UUID) -> AssistantPreparationFormatReceipt: ...
    def require_prepared_format(self, scope: ContactScope, session_id: UUID, request_key: UUID) -> None: ...
    def reject_unavailable_preparation(self, scope: ContactScope, session_id: UUID, request_key: UUID) -> None: ...
    def has_prepared_context(self, scope: ContactScope, receipt: AssistantGenerationReceipt) -> bool: ...

    def prepared_request(self, scope: ContactScope, receipt: AssistantGenerationReceipt) -> ReplyServiceRequest: ...

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
        self, scope: ContactScope, session_id: UUID, request_key: UUID, input_version_id: UUID, reason: str = "app_quit",
    ) -> AssistantGenerationReceipt: ...

    def reserve(
        self, scope: ContactScope, session_id: UUID, request: ReplyServiceRequest,
    ) -> UUID: ...

    def reserve_prepared(
        self, scope: ContactScope, session_id: UUID, request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt: ...

    def reserve_message_adoption(
        self, scope: ContactScope, session_id: UUID, request: AssistantMessageAdoptionRequest,
        running_request_key: UUID | None = None,
    ) -> AssistantContinuationReservation: ...

    def prepare_message_adoption(
        self, scope: ContactScope, session_id: UUID, request: AssistantMessageAdoptionRequest,
        running_request_key: UUID | None = None,
    ) -> AssistantGenerationReceipt: ...

    def prepare_interrupted(
        self, scope: ContactScope, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantGenerationReceipt: ...

    def reserve_interrupted(
        self, scope: ContactScope, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantContinuationReservation: ...

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
        continuation_store: AssistantContinuationPort | None = None,
    ) -> None:
        self._store = store
        self._reply = reply
        self._catalog = catalog
        self._continuation_store = continuation_store

    def default(self, *, owner_id: UUID, contact_id: UUID) -> UUID:
        return self._store.default(ContactScope(owner_id, contact_id))

    def _catalog_port(self) -> AssistantSessionCatalogPort:
        if self._catalog is None:
            raise AssistantSessionPersistenceError("助手会话目录尚不可用。")
        return self._catalog

    def new(self, *, owner_id: UUID, contact_id: UUID) -> UUID:
        return self._catalog_port().new(ContactScope(owner_id, contact_id))

    def new_with_candidate(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: CarryAssistantCandidate,
    ) -> CarriedAssistantSession:
        return self._catalog_port().new_with_candidate(ContactScope(owner_id, contact_id), session_id, command)

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

        scope = ContactScope(owner_id, contact_id)
        self._store.require_prepared_format(scope, session_id, request.idempotency_key)
        if self._reply is None:
            self._store.reject_unavailable_preparation(scope, session_id, request.idempotency_key)
            raise AssistantSessionRejected("reply_unavailable")
        if isinstance(request, AssistantMessageAdoptionRequest):
            receipt = self._store.prepare_message_adoption(scope, session_id, request)
        else:
            receipt = self._store.reserve_prepared(scope, session_id, request)
        return self._fixed_receipt(scope, receipt)

    def _fixed_receipt(self, scope: ContactScope, receipt: AssistantGenerationReceipt) -> AssistantGenerationReceipt:
        self._store.require_prepared_format(scope, receipt.session_id, receipt.request_key)
        # 已完成或已有固定材料的失败回执只重放身份；预检失败但无材料时仍须补齐准备。
        if receipt.state == "completed" or (receipt.state == "failed"
                and self._store.has_prepared_context(scope, receipt)):
            return receipt
        try:
            request = self._store.prepared_request(scope, receipt)
            result = self._reply.generate(owner_id=scope.owner_id, contact_id=scope.contact_id,
                                          request=request, prepare_only=True)
            if result.reason is not None:
                raise AssistantSessionRejected(result.reason)
        except Exception:
            self._store.fail(scope, receipt.turn_id)
            raise
        return receipt

    def interrupt(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request_key: UUID, input_version_id: UUID, reason: str = "app_quit",
    ) -> AssistantGenerationReceipt:
        return self._store.interrupt(ContactScope(owner_id, contact_id), session_id, request_key, input_version_id, reason=reason)

    def preparation_format(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request_key: UUID, input_version_id: UUID,
    ) -> AssistantPreparationFormatReceipt:
        return self._store.preparation_format(ContactScope(owner_id, contact_id), session_id,
                                              request_key, input_version_id)

    def generate(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        request: ReplyServiceRequest,
    ) -> AssistantTurn:
        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        if isinstance(request, AssistantMessageAdoptionRequest):
            reserved = self._store.reserve_message_adoption(scope, session_id, request)
            return self._generate_reserved(scope, session_id, reserved.turn_id, reserved.request)
        turn_id = self._store.reserve(scope, session_id, request)
        return self._generate_reserved(scope, session_id, turn_id, request)

    def continue_completed(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: ContinueAssistantSession,
    ) -> AssistantTurn:
        if self._reply is None or self._continuation_store is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        reserved = self._continuation_store.reserve_continuation(scope, session_id, command)
        return self._generate_reserved(scope, session_id, reserved.turn_id, reserved.request)

    def prepare_continuation(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: ContinueAssistantSession,
    ) -> AssistantGenerationReceipt:
        if self._reply is None or self._continuation_store is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        return self._fixed_receipt(scope, self._continuation_store.prepare_continuation(scope, session_id, command))

    def prepare_interrupted(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantGenerationReceipt:
        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        return self._fixed_receipt(scope, self._store.prepare_interrupted(scope, session_id, command))

    def recover_interrupted(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID, command: RecoverInterruptedAssistantGeneration,
    ) -> AssistantTurn:
        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        reserved = self._store.reserve_interrupted(scope, session_id, command)
        return self._generate_reserved(scope, session_id, reserved.turn_id, reserved.request)

    def prepare_replacement(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        running_request_key: UUID, request: ReplyServiceRequest,
    ) -> AssistantGenerationReceipt:
        """原事务内失效显式旧键并领取新输入；这里只返回实际身份。"""

        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        if isinstance(request, AssistantMessageAdoptionRequest):
            receipt = self._store.prepare_message_adoption(scope, session_id, request, running_request_key)
        else:
            receipt = self._store.reserve_replacement_prepared(scope, session_id, running_request_key, request)
        return self._fixed_receipt(scope, receipt)

    def replace(
        self, *, owner_id: UUID, contact_id: UUID, session_id: UUID,
        running_request_key: UUID, request: ReplyServiceRequest,
    ) -> AssistantTurn:
        """显式旧请求失效后继续既有生成流程，候选仍须可靠保存。"""

        if self._reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        scope = ContactScope(owner_id, contact_id)
        if isinstance(request, AssistantMessageAdoptionRequest):
            reserved = self._store.reserve_message_adoption(scope, session_id, request, running_request_key)
            return self._generate_reserved(scope, session_id, reserved.turn_id, reserved.request)
        turn_id = self._store.reserve_replacement(scope, session_id, running_request_key, request)
        return self._generate_reserved(scope, session_id, turn_id, request)

    def _generate_reserved(
        self, scope: ContactScope, session_id: UUID, turn_id: UUID, request: ReplyServiceRequest,
    ) -> AssistantTurn:
        reply = self._reply
        if reply is None:
            raise AssistantSessionRejected("reply_unavailable")
        self._store.require_prepared_format(scope, session_id, request.idempotency_key)
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
