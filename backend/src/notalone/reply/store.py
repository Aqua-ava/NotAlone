"""候选回复请求和结果的持久化合同。"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from hashlib import sha256
from threading import RLock
from typing import Callable, Protocol
from uuid import UUID, uuid4

from notalone.reply.context import (
    ContextEvidence,
    ContinuedReplyCandidate,
    EVIDENCE_KINDS,
    ReplyContext,
    ToolCallTrace,
    evidence_contract_is_valid,
)
from notalone.reply.errors import (
    ReplyContinuationError,
    ReplyIdempotencyConflictError,
    ReplyStoreInvariantError,
)
from notalone.reply.interface import (
    ContextReceipt,
    GenerateReply,
    candidate_message_group,
    ReplyCandidate,
    ReplyGenerated,
    ReplyToMessage,
    InitiateConversation,
    NoSkill,
    RewriteDraft,
    SkillUse,
    UserSkillChoice,
)
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.retrieval_receipt import ReplyRetrievalReceipt, require_receipt_evidence
from notalone.reply.input_budget import InputBudgetDecision
from notalone.reply.input_budget_receipt import validate_input_budget_receipt
from notalone.scopes import ContactScope, VerifiedConversationScope


class ReplyRequestState(StrEnum):
    """ReplyStore.start 对一次请求的决定。"""

    STARTED = "started"
    REPLAYED = "replayed"
    IN_PROGRESS = "in_progress"


class ReplyAttemptState(StrEnum):
    """一个回复请求尝试的持久化状态。"""

    RUNNING = "running"
    FAILED = "failed"
    EXPIRED = "expired"
    COMPLETED = "completed"


@dataclass(frozen=True, slots=True)
class ReplyRequest:
    """已领取一次运行租约的最小请求摘要。"""

    request_id: UUID
    idempotency_key: UUID
    normalized_input: str
    scope: ContactScope
    conversation_binding_id: UUID
    attempt: int
    lease_expires_at: datetime
    continued_from_candidate_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ReplyStart:
    """ReplyStore 对开始请求的原子决定。"""

    state: ReplyRequestState
    request: ReplyRequest
    result: ReplyGenerated | None = None
    continued_candidate: ContinuedReplyCandidate | None = None


@dataclass(frozen=True, slots=True)
class ReplyAttempt:
    """一次运行尝试的审计摘要，不保存底层异常正文。"""

    number: int
    state: ReplyAttemptState
    started_at: datetime
    lease_expires_at: datetime
    failure_reason: str | None = None


@dataclass(frozen=True, slots=True)
class StoredReplyRequest:
    """用于重放和审计的最小回复请求快照。"""

    request: ReplyRequest
    state: ReplyAttemptState
    attempts: tuple[ReplyAttempt, ...]
    evidence: tuple[ContextEvidence, ...]
    result: ReplyGenerated | None
    retrieval: ReplyRetrievalReceipt | None = None
    layered_context: dict | None = None
    layered_status: str = "quality_closed"
    layered_scenario_reads: tuple[dict, ...] = ()


@dataclass(frozen=True, slots=True, repr=False)
class ValidatedReply:
    """已经通过确定性校验、允许持久化的运行结果。"""

    candidates: tuple[RuntimeCandidate, ...]
    used_skill: SkillUse | None
    input_budget: InputBudgetDecision | None = None


class ReplyStore(Protocol):
    """候选回复的持久化 seam。

    Store 只接收外层已经验证的范围和 Context 结果。它不组装上下文、不调用
    Runtime、不读写 Memory、不识别联系人，也不发送外部消息。
    """

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart: ...

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated: ...

    def prepare_context(self, request: ReplyRequest, context: ReplyContext) -> None: ...

    def require_current(self, request: ReplyRequest) -> None: ...

    def fail(self, request: ReplyRequest, *, reason: str) -> None: ...

    def read(self, request_id: UUID, scope: ContactScope) -> StoredReplyRequest: ...


@dataclass(slots=True)
class _MutableReplyRecord:
    request: ReplyRequest
    state: ReplyAttemptState
    attempts: list[ReplyAttempt]
    evidence: tuple[ContextEvidence, ...] = ()
    result: ReplyGenerated | None = None
    retrieval: ReplyRetrievalReceipt | None = None


@dataclass(frozen=True, slots=True)
class _StoredCandidate:
    scope: ContactScope
    conversation_binding_id: UUID
    text: str


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class InMemoryReplyStore:
    """用于当前纵切和单元测试的进程内 ReplyStore adapter。

    锁内完成幂等判断、租约领取和结果写入，模拟未来 PostgreSQL adapter 需要提供的
    原子边界。它只保存 Context 已选出的证据快照，不负责检索或联系人识别。
    """

    __slots__ = (
        "_clock",
        "_id_factory",
        "_lease_duration",
        "_lock",
        "_records_by_key",
        "_records_by_id",
        "_candidates",
    )

    def __init__(
        self,
        *,
        clock: Callable[[], datetime] = _utc_now,
        id_factory: Callable[[], UUID] = uuid4,
        lease_duration: timedelta = timedelta(seconds=30),
    ) -> None:
        if not callable(clock) or not callable(id_factory):
            raise TypeError("ReplyStore 的时钟和标识生成器必须可调用。")
        if (
            not isinstance(lease_duration, timedelta)
            or lease_duration <= timedelta(0)
        ):
            raise ValueError("回复运行租约必须是正时间段。")
        self._clock = clock
        self._id_factory = id_factory
        self._lease_duration = lease_duration
        self._lock = RLock()
        self._records_by_key: dict[tuple[UUID, UUID, UUID], _MutableReplyRecord] = {}
        self._records_by_id: dict[UUID, _MutableReplyRecord] = {}
        self._candidates: dict[UUID, _StoredCandidate] = {}

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart:
        self._validate_start_input(command, verified_scope)
        normalized_input = _normalize_input(command)
        key = (
            verified_scope.owner_id,
            verified_scope.contact_id,
            command.idempotency_key,
        )
        with self._lock:
            record = self._records_by_key.get(key)
            if record is None:
                continuation = self._resolve_continuation(command, verified_scope)
                request = self._new_request(
                    command=command,
                    verified_scope=verified_scope,
                    normalized_input=normalized_input,
                    attempt=1,
                )
                started_at = self._now()
                record = _MutableReplyRecord(
                    request=request,
                    state=ReplyAttemptState.RUNNING,
                    attempts=[
                        ReplyAttempt(
                            number=1,
                            state=ReplyAttemptState.RUNNING,
                            started_at=started_at,
                            lease_expires_at=request.lease_expires_at,
                        )
                    ],
                )
                self._records_by_key[key] = record
                self._records_by_id[request.request_id] = record
                return ReplyStart(
                    state=ReplyRequestState.STARTED,
                    request=request,
                    continued_candidate=continuation,
                )

            self._ensure_same_request(record.request, command, normalized_input)
            continuation = self._resolve_continuation(command, verified_scope)
            now = self._now()
            if record.state is ReplyAttemptState.COMPLETED:
                return ReplyStart(
                    state=ReplyRequestState.REPLAYED,
                    request=record.request,
                    result=record.result,
                    continued_candidate=continuation,
                )
            if (
                record.state is ReplyAttemptState.RUNNING
                and now < record.request.lease_expires_at
            ):
                return ReplyStart(
                    state=ReplyRequestState.IN_PROGRESS,
                    request=record.request,
                    continued_candidate=continuation,
                )

            previous = record.attempts[-1]
            expired_state = (
                ReplyAttemptState.EXPIRED
                if record.state is ReplyAttemptState.RUNNING
                else record.state
            )
            if previous.state is ReplyAttemptState.RUNNING:
                record.attempts[-1] = replace(
                    previous,
                    state=expired_state,
                    failure_reason=(
                        "lease_expired"
                        if expired_state is ReplyAttemptState.EXPIRED
                        else previous.failure_reason
                    ),
                )
            request = self._new_request(
                command=command,
                verified_scope=verified_scope,
                normalized_input=normalized_input,
                attempt=record.request.attempt + 1,
                request_id=record.request.request_id,
            )
            record.request = request
            record.state = ReplyAttemptState.RUNNING
            record.result = None
            record.evidence = ()
            record.retrieval = None
            record.attempts.append(
                ReplyAttempt(
                    number=request.attempt,
                    state=ReplyAttemptState.RUNNING,
                    started_at=now,
                    lease_expires_at=request.lease_expires_at,
                )
            )
            return ReplyStart(
                state=ReplyRequestState.STARTED,
                request=request,
                continued_candidate=continuation,
            )

    def prepare_context(self, request: ReplyRequest, context: ReplyContext) -> None:
        """内存适配器只验证结构，不宣称拥有 PostgreSQL 原始来源快照。"""
        self._validate_context(request, context)

    def require_current(self, request: ReplyRequest) -> None:
        """额外模型轮只能沿同一次仍活动的实际领取继续。"""
        with self._lock:
            record = self._record_for_request(request)
            if (record.state is not ReplyAttemptState.RUNNING
                    or self._now() >= request.lease_expires_at
                    or not any(attempt.number == request.attempt
                               and attempt.state is ReplyAttemptState.RUNNING
                               and attempt.lease_expires_at == request.lease_expires_at
                               for attempt in record.attempts)):
                raise ReplyStoreInvariantError('回复请求租约已失效。')

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        with self._lock:
            record = self._record_for_request(request)
            if record.state is ReplyAttemptState.COMPLETED:
                if record.result is None:
                    raise ReplyStoreInvariantError("已完成回复缺少结果。")
                return record.result
            if record.state is not ReplyAttemptState.RUNNING:
                raise ReplyStoreInvariantError(
                    "回复请求当前不允许保存结果。"
                )
            if self._now() >= request.lease_expires_at:
                self._expire_record(record)
                raise ReplyStoreInvariantError("回复请求租约已过期。")
            context_evidence_ids = self._validate_context(request, context)
            self._validate_reply(reply, evidence_ids=context_evidence_ids)

            candidates: list[ReplyCandidate] = []
            for runtime_candidate in reply.candidates:
                candidate_id = self._new_uuid()
                if candidate_id in self._candidates:
                    raise ReplyStoreInvariantError("候选标识发生冲突。")
                candidates.append(
                    ReplyCandidate(
                        candidate_id=candidate_id,
                        text=runtime_candidate.text,
                        basis=runtime_candidate.basis,
                        citation_ids=runtime_candidate.citation_ids,
                        risk_notes=runtime_candidate.risk_notes,
                        messages=candidate_message_group(candidate_id, runtime_candidate.message_texts, self._new_uuid),
                    )
                )
            evidence_ids = tuple(
                dict.fromkeys(
                    evidence_id
                    for candidate in candidates
                    for evidence_id in candidate.citation_ids
                )
            )
            from notalone.reply.expression_preferences import preference_receipts

            result = ReplyGenerated(
                reply_request_id=request.request_id,
                candidates=tuple(candidates),
                context_receipt=ContextReceipt(evidence_ids=evidence_ids,
                                               style_sample_ids=tuple(sorted(item.sample_id for item in context.style_references)),
                                               expression_preference_ids=tuple(sorted(item.preference_id for item in context.expression_preferences)),
                                               expression_preferences=preference_receipts(context.expression_preferences)),
                used_skill=reply.used_skill,
                input_budget=reply.input_budget,
            )
            record.evidence = tuple(context.evidence)
            record.retrieval = context.retrieval
            record.result = result
            record.state = ReplyAttemptState.COMPLETED
            record.attempts[-1] = replace(
                record.attempts[-1],
                state=ReplyAttemptState.COMPLETED,
            )
            for candidate in result.candidates:
                self._candidates[candidate.candidate_id] = _StoredCandidate(
                    scope=request.scope,
                    conversation_binding_id=request.conversation_binding_id,
                    text=candidate.text,
                )
            return result

    def fail(self, request: ReplyRequest, *, reason: str) -> None:
        with self._lock:
            record = self._record_for_request(request)
            if record.state is ReplyAttemptState.COMPLETED:
                return
            if record.state is not ReplyAttemptState.RUNNING:
                return
            if self._now() >= request.lease_expires_at:
                self._expire_record(record)
                return
            failure_reason = _safe_failure_reason(reason)
            record.state = ReplyAttemptState.FAILED
            record.attempts[-1] = replace(
                record.attempts[-1],
                state=ReplyAttemptState.FAILED,
                failure_reason=failure_reason,
            )

    def read(self, request_id: UUID, scope: ContactScope) -> StoredReplyRequest:
        with self._lock:
            if not isinstance(request_id, UUID) or not isinstance(scope, ContactScope):
                raise ReplyStoreInvariantError("回复请求读取范围结构无效。")
            record = self._records_by_id.get(request_id)
            if record is None or record.request.scope != scope:
                raise ReplyStoreInvariantError(
                    "回复请求不属于当前联系人范围。"
                )
            return StoredReplyRequest(
                request=record.request,
                state=record.state,
                attempts=tuple(record.attempts),
                evidence=record.evidence,
                result=record.result,
                retrieval=record.retrieval,
            )

    def _record_for_request(self, request: ReplyRequest) -> _MutableReplyRecord:
        if not isinstance(request, ReplyRequest):
            raise ReplyStoreInvariantError("回复请求租约结构无效。")
        record = self._records_by_id.get(request.request_id)
        if record is None or record.request != request:
            raise ReplyStoreInvariantError("回复请求租约已失效。")
        return record

    def _resolve_continuation(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ContinuedReplyCandidate | None:
        candidate_id = command.continued_from_candidate_id
        if candidate_id is None:
            return None
        candidate = self._candidates.get(candidate_id)
        expected_scope = ContactScope(
            verified_scope.owner_id,
            verified_scope.contact_id,
        )
        if (
            candidate is None
            or candidate.scope != expected_scope
            or candidate.conversation_binding_id
            != verified_scope.conversation_binding_id
        ):
            raise ReplyContinuationError(
                "历史候选不属于当前已验证联系人会话。"
            )
        return ContinuedReplyCandidate(
            candidate_id=candidate_id,
            scope=candidate.scope,
            conversation_binding_id=candidate.conversation_binding_id,
            text=candidate.text,
        )

    def _new_request(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        normalized_input: str,
        attempt: int,
        request_id: UUID | None = None,
    ) -> ReplyRequest:
        return ReplyRequest(
            request_id=request_id or self._new_uuid(),
            idempotency_key=command.idempotency_key,
            normalized_input=normalized_input,
            scope=ContactScope(verified_scope.owner_id, verified_scope.contact_id),
            conversation_binding_id=verified_scope.conversation_binding_id,
            attempt=attempt,
            lease_expires_at=self._now() + self._lease_duration,
            continued_from_candidate_id=command.continued_from_candidate_id,
        )

    def _new_uuid(self) -> UUID:
        try:
            value = self._id_factory()
        except Exception:
            raise ReplyStoreInvariantError("ReplyStore 标识生成失败。") from None
        if not isinstance(value, UUID):
            raise ReplyStoreInvariantError("ReplyStore 标识结构无效。")
        return value

    def _now(self) -> datetime:
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ReplyStoreInvariantError(
                "ReplyStore 时钟必须返回带时区时间。"
            )
        return value.astimezone(timezone.utc)

    @staticmethod
    def _validate_start_input(
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> None:
        if not (
            isinstance(command, GenerateReply)
            and isinstance(verified_scope, VerifiedConversationScope)
            and isinstance(command.idempotency_key, UUID)
            and command.has_valid_content()
            and command.matches_verified_scope(verified_scope)
        ):
            raise ReplyStoreInvariantError("回复请求范围或输入结构无效。")

    @staticmethod
    def _ensure_same_request(
        request: ReplyRequest,
        command: GenerateReply,
        normalized_input: str,
    ) -> None:
        if (
            request.conversation_binding_id
            != command.conversation_binding_id
            or request.normalized_input != normalized_input
        ):
            raise ReplyIdempotencyConflictError(
                "回复请求幂等键与输入不一致。"
            )

    def _validate_context(
        self,
        request: ReplyRequest,
        context: ReplyContext,
    ) -> set[UUID]:
        """校验上下文快照并返回证据标识集合；与 PostgreSQL adapter 同契约。"""

        try:
            require_receipt_evidence(context.retrieval, context.evidence)
        except (AttributeError, TypeError, ValueError):
            raise ReplyStoreInvariantError("回复检索回执与实际依据不一致。") from None

        if not (
            isinstance(context, ReplyContext)
            and isinstance(context.command, GenerateReply)
            and context.reply_request_id == request.request_id
            and context.scope == request.scope
            and context.command.scope == request.scope
            and context.command.has_valid_content()
            and context.command.idempotency_key == request.idempotency_key
            and context.command.conversation_binding_id
            == request.conversation_binding_id
            and context.command.continued_from_candidate_id
            == request.continued_from_candidate_id
            and _normalize_input(context.command) == request.normalized_input
            and isinstance(context.current_text, str)
            and bool(context.current_text.strip())
            and isinstance(context.skill_library_revision, int)
            and context.skill_library_revision >= 0
            and isinstance(context.risk_notes, tuple)
            and all(
                isinstance(note, str) and note.strip()
                for note in context.risk_notes
            )
            and isinstance(context.evidence, tuple)
            and context.evidence
            and (
                context.memory_revision is None
                or (
                    isinstance(context.memory_revision, int)
                    and context.memory_revision >= 0
                )
            )
            and (
                context.index_revision is None
                or (
                    isinstance(context.index_revision, int)
                    and context.index_revision >= 0
                )
            )
            and isinstance(context.tool_calls, tuple)
            and all(
                isinstance(item, ContextEvidence) and item.scope == request.scope
                for item in context.evidence
            )
        ):
            raise ReplyStoreInvariantError(
                "回复上下文不属于当前持久化请求。"
            )
        evidence_ids: set[UUID] = set()
        for item in context.evidence:
            if (
                item.kind not in EVIDENCE_KINDS
                or not isinstance(item.evidence_id, UUID)
                or item.evidence_id in evidence_ids
                or not isinstance(item.text, str)
                or not item.text.strip()
                or not isinstance(item.source_ids, tuple)
                or any(
                    not isinstance(source_id, UUID)
                    for source_id in item.source_ids
                )
                or not isinstance(item.selection_reason, str)
                or not isinstance(item.status, str)
                or not item.status.strip()
                or not evidence_contract_is_valid(
                    kind=item.kind,
                    status=item.status,
                    selection_reason=item.selection_reason,
                )
                or (
                    item.valid_at is not None
                    and not isinstance(item.valid_at, datetime)
                )
                or (
                    item.invalid_at is not None
                    and not isinstance(item.invalid_at, datetime)
                )
                or (
                    item.valid_at is not None
                    and item.invalid_at is not None
                    and item.invalid_at < item.valid_at
                )
                or (
                    item.revision is not None
                    and (
                        not isinstance(item.revision, int)
                        or item.revision < 1
                    )
                )
            ):
                raise ReplyStoreInvariantError("回复证据快照结构无效。")
            evidence_ids.add(item.evidence_id)
        for trace in context.tool_calls:
            if not _valid_tool_call_trace(trace):
                raise ReplyStoreInvariantError("回复 Tool 轨迹结构无效。")
            if not set(trace.evidence_ids) <= evidence_ids:
                raise ReplyStoreInvariantError("回复 Tool 轨迹引用了未知证据。")
        continuation_evidence = tuple(
            item for item in context.evidence if item.kind == "continued_candidate"
        )
        if request.continued_from_candidate_id is None:
            if continuation_evidence:
                raise ReplyStoreInvariantError(
                    "历史候选必须由用户显式选择。"
                )
            return evidence_ids
        candidate = self._candidates.get(request.continued_from_candidate_id)
        if (
            candidate is None
            or len(continuation_evidence) != 1
            or continuation_evidence[0].evidence_id
            != request.continued_from_candidate_id
            or continuation_evidence[0].text != candidate.text
        ):
            raise ReplyStoreInvariantError(
                "继续候选快照与已保存候选不一致。"
            )
        return evidence_ids

    @staticmethod
    def _validate_reply(
        reply: ValidatedReply,
        *,
        evidence_ids: set[UUID],
    ) -> None:
        if not (
            isinstance(reply, ValidatedReply)
            and isinstance(reply.candidates, tuple)
            and 1 <= len(reply.candidates) <= 3
            and all(
                isinstance(candidate, RuntimeCandidate)
                for candidate in reply.candidates
            )
        ):
            raise ReplyStoreInvariantError("回复结果结构无效。")
        try:
            validate_input_budget_receipt(reply.input_budget)
        except ValueError:
            raise ReplyStoreInvariantError("回复预算回执结构无效。") from None
        for candidate in reply.candidates:
            if not (
                isinstance(candidate.text, str)
                and bool(candidate.text.strip())
                and candidate.has_valid_message_group()
                and isinstance(candidate.basis, str)
                and bool(candidate.basis.strip())
                and isinstance(candidate.citation_ids, tuple)
                and bool(candidate.citation_ids)
                and all(isinstance(item, UUID) for item in candidate.citation_ids)
                and set(candidate.citation_ids) <= evidence_ids
                and isinstance(candidate.risk_notes, tuple)
                and all(
                    isinstance(note, str) and bool(note.strip())
                    for note in candidate.risk_notes
                )
            ):
                raise ReplyStoreInvariantError("回复结果结构无效。")

    def _expire_record(self, record: _MutableReplyRecord) -> None:
        if record.state is not ReplyAttemptState.RUNNING:
            return
        record.state = ReplyAttemptState.EXPIRED
        record.attempts[-1] = replace(
            record.attempts[-1],
            state=ReplyAttemptState.EXPIRED,
            failure_reason="lease_expired",
        )


def canonical_reply_input(command: GenerateReply) -> str:
    """会话投影与请求摘要共用同一用户输入表示。"""

    content = command.content
    if isinstance(content, ReplyToMessage):
        payload = {
            "mode": "reply_to_message",
            "target_message_id": str(content.target_message_id),
            "direction": content.direction.text.strip(),
            "direction_source": content.direction.source.value,
        }
    elif isinstance(content, InitiateConversation):
        payload = {
            "mode": "initiate_conversation", "purpose": content.purpose.text.strip(),
            "purpose_source": content.purpose.source.value,
        }
    elif isinstance(content, RewriteDraft):
        payload = {
            "mode": "rewrite_draft",
            "draft_text": content.draft_text.strip(),
            "user_instruction": (
                content.user_instruction.strip()
                if content.user_instruction is not None
                else None
            ),
            "include_relationship_context": content.include_relationship_context,
        }
        if content.input_kind == "current_chat":
            payload["input_kind"] = "current_chat"
            payload["pasted_direction"] = content.pasted_direction.strip()
    else:
        raise ReplyStoreInvariantError("回复输入模式无效。")
    if isinstance(content, (ReplyToMessage, InitiateConversation)):
        direction = content.direction if isinstance(content, ReplyToMessage) else content.purpose
        if direction.suggestion is not None:
            reference = direction.suggestion
            payload["suggestion"] = {"task_id": str(reference.task_id),
                                     "input_version": str(reference.input_version)
                                     if isinstance(reference.input_version, UUID) else reference.input_version,
                                     "suggestion_id": str(reference.suggestion_id)}
        for name in ("understanding_correction", "user_instruction", "clarification_answer"):
            declaration = getattr(content, name)
            if declaration:
                payload[name] = declaration.strip()
    payload["continued_from_candidate_id"] = (
        str(command.continued_from_candidate_id)
        if command.continued_from_candidate_id is not None
        else None
    )
    # Skill 选择决定生成路径，属于请求输入的一部分；同一幂等键换用
    # 不同 Skill 必须冲突，不能静默重放旧选择生成的候选。
    payload["skill"] = (
        f"user_choice:{command.skill.version_id}"
        if isinstance(command.skill, UserSkillChoice)
        else "disabled" if isinstance(command.skill, NoSkill) else "auto"
    )
    if command.scene is not None:
        payload['scene'] = command.scene
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _normalize_input(command: GenerateReply) -> str:
    normalized = canonical_reply_input(command)
    # 新建议协议在来源核验前领取幂等键，只保存指纹，拒绝路径不留派生正文。
    # 成功快照与完整删除依赖由上下文保存；既有无建议请求保持原指纹兼容。
    content = command.content
    if (isinstance(content, ReplyToMessage) and content.direction.suggestion is not None
            or isinstance(content, InitiateConversation) and content.purpose.suggestion is not None):
        return "suggestion-sha256:" + sha256(normalized.encode("utf-8")).hexdigest()
    return normalized


def _safe_failure_reason(reason: str) -> str:
    if not isinstance(reason, str) or not reason.strip():
        return "unknown_failure"
    value = reason.strip()
    if len(value) > 64 or any(char.isspace() for char in value):
        return "unknown_failure"
    return value


def _valid_tool_call_trace(trace: object) -> bool:
    return (
        isinstance(trace, ToolCallTrace)
        and isinstance(trace.tool_name, str)
        and bool(trace.tool_name.strip())
        and len(trace.tool_name) <= 64
        and trace.status
        in (
            "succeeded",
            "empty",
            "failed",
            "timeout",
            "budget_exceeded",
        )
        and isinstance(trace.evidence_ids, tuple)
        and len(trace.evidence_ids) == len(set(trace.evidence_ids))
        and all(isinstance(item, UUID) for item in trace.evidence_ids)
        and (
            trace.latency_ms is None
            or isinstance(trace.latency_ms, int)
            and trace.latency_ms >= 0
        )
    )
