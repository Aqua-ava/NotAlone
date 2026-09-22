"""候选回复 ReplyStore 的 PostgreSQL 持久化适配器。"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.locks import lock_owner_scope

from notalone.reply.context import (
    ContextEvidence,
    ContinuedReplyCandidate,
    ReplyContext,
    ToolCallTrace,
)
from notalone.reply.errors import (
    ReplyContinuationError,
    ReplyIdempotencyConflictError,
    ReplyPersistenceError,
    ReplyStoreInvariantError,
)
from notalone.reply.interface import (
    ContextReceipt,
    GenerateReply,
    ReplyCandidate,
    ReplyGenerated,
    SkillUse,
)
from notalone.reply.runtime import RuntimeCandidate
from notalone.reply.store import (
    ReplyAttempt,
    ReplyAttemptState,
    ReplyRequest,
    ReplyRequestState,
    ReplyStart,
    StoredReplyRequest,
    ValidatedReply,
    _normalize_input,
    _safe_failure_reason,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PostgresReplyStore:
    """按联系人范围原子保存回复请求、上下文快照和候选结果。"""

    __slots__ = (
        "_clock",
        "_database_url",
        "_id_factory",
        "_lease_duration",
    )

    def __init__(
        self,
        database_url: str,
        *,
        clock: Callable[[], datetime] = _utc_now,
        id_factory: Callable[[], UUID] = uuid4,
        lease_duration: timedelta = timedelta(seconds=30),
    ) -> None:
        if not isinstance(database_url, str) or not database_url.strip():
            raise ValueError("database_url 不能为空。")
        if not callable(clock) or not callable(id_factory):
            raise TypeError("ReplyStore 的时钟和标识生成器必须可调用。")
        if (
            not isinstance(lease_duration, timedelta)
            or lease_duration <= timedelta(0)
        ):
            raise ValueError("回复运行租约必须是正时间段。")
        self._database_url = database_url
        self._clock = clock
        self._id_factory = id_factory
        self._lease_duration = lease_duration

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart:
        """在一个事务中完成幂等领取、重放判断和租约重试。"""

        self._validate_start_input(command, verified_scope)
        normalized_input = _normalize_input(command)
        now = self._now()
        try:
            with self._connect() as connection:
                # 与来源删除串行化领取、继续候选和结果写入，避免旧副本复活。
                lock_owner_scope(connection, owner_id=verified_scope.owner_id)
                request_id = self._new_uuid()
                lease_expires_at = now + self._lease_duration
                inserted = connection.execute(
                    """
                    INSERT INTO public.reply_request (
                        id, owner_id, contact_id, conversation_binding_id,
                        idempotency_key, normalized_input, state, attempt,
                        lease_expires_at, continued_from_candidate_id
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, 'running', 1, %s, %s
                    )
                    ON CONFLICT (owner_id, contact_id, idempotency_key)
                    DO NOTHING
                    RETURNING id, owner_id, contact_id,
                              conversation_binding_id, idempotency_key,
                              normalized_input, state, attempt,
                              lease_expires_at, continued_from_candidate_id,
                              context_snapshot, skill_library_revision,
                              skill_id, skill_version_id, skill_name,
                              skill_selection_method,
                              skill_selection_reason,
                              skill_load_state,
                              skill_loaded_resources
                    """,
                    (
                        request_id,
                        verified_scope.owner_id,
                        verified_scope.contact_id,
                        verified_scope.conversation_binding_id,
                        command.idempotency_key,
                        normalized_input,
                        lease_expires_at,
                        command.continued_from_candidate_id,
                    ),
                ).fetchone()
                if inserted is not None:
                    continuation = self._resolve_continuation(
                        connection,
                        command,
                        verified_scope,
                    )
                    request = self._request_from_row(inserted)
                    connection.execute(
                        """
                        INSERT INTO public.reply_attempt (
                            reply_request_id, number, state,
                            started_at, lease_expires_at
                        )
                        VALUES (%s, 1, 'running', %s, %s)
                        """,
                        (request.request_id, now, lease_expires_at),
                    )
                    outcome = ReplyStart(
                        state=ReplyRequestState.STARTED,
                        request=request,
                        continued_candidate=continuation,
                    )
                else:
                    existing = connection.execute(
                        """
                        SELECT id, owner_id, contact_id,
                               conversation_binding_id, idempotency_key,
                               normalized_input, state, attempt,
                               lease_expires_at, continued_from_candidate_id,
                               context_snapshot, skill_library_revision,
                               skill_id, skill_version_id, skill_name,
                               skill_selection_method,
                               skill_selection_reason,
                               skill_load_state,
                               skill_loaded_resources
                        FROM public.reply_request
                        WHERE owner_id = %s
                          AND contact_id = %s
                          AND idempotency_key = %s
                        FOR UPDATE
                        """,
                        (
                            verified_scope.owner_id,
                            verified_scope.contact_id,
                            command.idempotency_key,
                        ),
                    ).fetchone()
                    if existing is None:
                        raise ReplyStoreInvariantError(
                            "回复请求幂等记录读取不一致。"
                        )
                    request = self._request_from_row(existing)
                    self._ensure_same_request(
                        request,
                        command,
                        normalized_input,
                    )
                    continuation = self._resolve_continuation(
                        connection,
                        command,
                        verified_scope,
                    )
                    state = self._state_from_row(existing)
                    if state is ReplyAttemptState.COMPLETED:
                        result = self._read_result(connection, existing)
                        outcome = ReplyStart(
                            state=ReplyRequestState.REPLAYED,
                            request=request,
                            result=result,
                            continued_candidate=continuation,
                        )
                    elif (
                        state is ReplyAttemptState.RUNNING
                        and now < request.lease_expires_at
                    ):
                        outcome = ReplyStart(
                            state=ReplyRequestState.IN_PROGRESS,
                            request=request,
                            continued_candidate=continuation,
                        )
                    else:
                        if state is ReplyAttemptState.RUNNING:
                            self._mark_attempt_expired(
                                connection,
                                request_id=request.request_id,
                                attempt=request.attempt,
                            )
                        next_attempt = request.attempt + 1
                        next_lease = now + self._lease_duration
                        connection.execute(
                            """
                            DELETE FROM public.reply_candidate
                            WHERE reply_request_id = %s
                            """,
                            (request.request_id,),
                        )
                        connection.execute(
                            """
                            DELETE FROM public.reply_context_evidence
                            WHERE reply_request_id = %s
                            """,
                            (request.request_id,),
                        )
                        retried = connection.execute(
                            """
                            UPDATE public.reply_request
                            SET state = 'running', attempt = %s,
                                lease_expires_at = %s,
                                context_snapshot = NULL,
                                skill_library_revision = NULL,
                                skill_id = NULL, skill_version_id = NULL,
                                skill_name = NULL,
                                skill_selection_method = NULL,
                                skill_selection_reason = NULL,
                                skill_load_state = NULL,
                                skill_loaded_resources = NULL,
                                updated_at = now()
                            WHERE id = %s
                            RETURNING id, owner_id, contact_id,
                                      conversation_binding_id,
                                      idempotency_key, normalized_input,
                                      state, attempt, lease_expires_at,
                                      continued_from_candidate_id,
                                      context_snapshot,
                                      skill_library_revision, skill_id,
                                      skill_version_id, skill_name,
                                      skill_selection_method,
                                      skill_selection_reason,
                                      skill_load_state,
                                      skill_loaded_resources
                            """,
                            (next_attempt, next_lease, request.request_id),
                        ).fetchone()
                        if retried is None:
                            raise ReplyStoreInvariantError(
                                "回复请求重试状态写入不一致。"
                            )
                        connection.execute(
                            """
                            INSERT INTO public.reply_attempt (
                                reply_request_id, number, state,
                                started_at, lease_expires_at
                            )
                            VALUES (%s, %s, 'running', %s, %s)
                            """,
                            (
                                request.request_id,
                                next_attempt,
                                now,
                                next_lease,
                            ),
                        )
                        outcome = ReplyStart(
                            state=ReplyRequestState.STARTED,
                            request=self._request_from_row(retried),
                            continued_candidate=continuation,
                        )
        except ReplyPersistenceError:
            raise
        except psycopg.Error:
            raise ReplyPersistenceError(
                "回复请求状态持久化失败。"
            ) from None
        return outcome

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        """在一个事务中写入上下文、候选、引用和 Skill 摘要。"""

        if not isinstance(request, ReplyRequest):
            raise ReplyStoreInvariantError("回复请求租约结构无效。")
        try:
            with self._connect() as connection:
                lock_owner_scope(connection, owner_id=request.scope.owner_id)
                row = connection.execute(
                    """
                    SELECT id, owner_id, contact_id,
                           conversation_binding_id, idempotency_key,
                           normalized_input, state, attempt,
                           lease_expires_at, continued_from_candidate_id,
                           context_snapshot, skill_library_revision,
                           skill_id, skill_version_id, skill_name,
                           skill_selection_method,
                           skill_selection_reason,
                           skill_load_state,
                           skill_loaded_resources
                    FROM public.reply_request
                    WHERE id = %s
                    FOR UPDATE
                    """,
                    (request.request_id,),
                ).fetchone()
                if row is None:
                    raise ReplyStoreInvariantError("回复请求租约已失效。")
                persisted_request = self._request_from_row(row)
                if persisted_request != request:
                    raise ReplyStoreInvariantError("回复请求租约已失效。")
                state = self._state_from_row(row)
                if state is ReplyAttemptState.COMPLETED:
                    result = self._read_result(connection, row)
                else:
                    if state is not ReplyAttemptState.RUNNING:
                        raise ReplyStoreInvariantError(
                            "回复请求当前不允许保存结果。"
                        )
                    if self._now() >= request.lease_expires_at:
                        self._mark_attempt_expired(
                            connection,
                            request_id=request.request_id,
                            attempt=request.attempt,
                        )
                        raise ReplyStoreInvariantError("回复请求租约已过期。")
                    evidence = self._validate_context(
                        connection,
                        request,
                        context,
                    )
                    self._validate_reply(reply, evidence_ids=evidence)
                    candidates: list[ReplyCandidate] = []
                    candidate_ids: set[UUID] = set()
                    for runtime_candidate in reply.candidates:
                        candidate_id = self._new_uuid()
                        if candidate_id in candidate_ids:
                            raise ReplyStoreInvariantError(
                                "候选标识发生冲突。"
                            )
                        if connection.execute(
                            "SELECT 1 FROM public.reply_candidate WHERE id = %s",
                            (candidate_id,),
                        ).fetchone():
                            raise ReplyStoreInvariantError(
                                "候选标识发生冲突。"
                            )
                        candidate_ids.add(candidate_id)
                        candidates.append(
                            ReplyCandidate(
                                candidate_id=candidate_id,
                                text=runtime_candidate.text,
                                basis=runtime_candidate.basis,
                                citation_ids=runtime_candidate.citation_ids,
                                risk_notes=runtime_candidate.risk_notes,
                            )
                        )
                    evidence_ids = tuple(
                        dict.fromkeys(
                            evidence_id
                            for candidate in candidates
                            for evidence_id in candidate.citation_ids
                        )
                    )
                    result = ReplyGenerated(
                        reply_request_id=request.request_id,
                        candidates=tuple(candidates),
                        context_receipt=ContextReceipt(
                            evidence_ids=evidence_ids,
                        ),
                        used_skill=reply.used_skill,
                    )
                    self._insert_evidence(connection, request, context)
                    self._insert_candidates(connection, request, result)
                    skill_columns = self._skill_columns(reply.used_skill)
                    updated = connection.execute(
                        """
                        UPDATE public.reply_request
                        SET state = 'completed',
                            context_snapshot = %s,
                            skill_library_revision = %s,
                            skill_id = %s, skill_version_id = %s,
                            skill_name = %s,
                            skill_selection_method = %s,
                            skill_selection_reason = %s,
                            skill_load_state = %s,
                            skill_loaded_resources = %s,
                            updated_at = now()
                        WHERE id = %s
                        RETURNING id
                        """,
                        (
                            Jsonb(self._context_snapshot(context)),
                            context.skill_library_revision,
                            skill_columns["skill_id"],
                            skill_columns["version_id"],
                            skill_columns["name"],
                            skill_columns["selection_method"],
                            skill_columns["selection_reason"],
                            skill_columns["load_state"],
                            (
                                Jsonb(skill_columns["loaded_resources"])
                                if skill_columns["loaded_resources"] is not None
                                else None
                            ),
                            request.request_id,
                        ),
                    ).fetchone()
                    if updated is None:
                        raise ReplyStoreInvariantError(
                            "回复请求完成状态写入不一致。"
                        )
                    completed_attempt = connection.execute(
                        """
                        UPDATE public.reply_attempt
                        SET state = 'completed', failure_reason = NULL
                        WHERE reply_request_id = %s AND number = %s
                          AND state = 'running'
                        RETURNING reply_request_id
                        """,
                        (request.request_id, request.attempt),
                    ).fetchone()
                    if completed_attempt is None:
                        raise ReplyStoreInvariantError(
                            "回复尝试完成状态写入不一致。"
                        )
        except ReplyPersistenceError:
            raise
        except psycopg.Error:
            raise ReplyPersistenceError("候选回复持久化失败。") from None
        return result

    def fail(self, request: ReplyRequest, *, reason: str) -> None:
        """把当前运行尝试标记为失败或租约过期。"""

        if not isinstance(request, ReplyRequest):
            raise ReplyStoreInvariantError("回复请求租约结构无效。")
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT id, owner_id, contact_id,
                           conversation_binding_id, idempotency_key,
                           normalized_input, state, attempt,
                           lease_expires_at, continued_from_candidate_id,
                           context_snapshot, skill_library_revision,
                           skill_id, skill_version_id, skill_name,
                           skill_selection_method,
                           skill_selection_reason,
                           skill_load_state,
                           skill_loaded_resources
                    FROM public.reply_request
                    WHERE id = %s
                    FOR UPDATE
                    """,
                    (request.request_id,),
                ).fetchone()
                if row is None:
                    raise ReplyStoreInvariantError("回复请求租约已失效。")
                persisted_request = self._request_from_row(row)
                if persisted_request != request:
                    raise ReplyStoreInvariantError("回复请求租约已失效。")
                state = self._state_from_row(row)
                if state is ReplyAttemptState.COMPLETED:
                    return
                if state is not ReplyAttemptState.RUNNING:
                    return
                if self._now() >= request.lease_expires_at:
                    self._mark_attempt_expired(
                        connection,
                        request_id=request.request_id,
                        attempt=request.attempt,
                    )
                    return
                updated = connection.execute(
                    """
                    UPDATE public.reply_request
                    SET state = 'failed', updated_at = now()
                    WHERE id = %s AND state = 'running'
                    RETURNING id
                    """,
                    (request.request_id,),
                ).fetchone()
                if updated is None:
                    raise ReplyStoreInvariantError(
                        "回复请求失败状态写入不一致。"
                    )
                attempt = connection.execute(
                    """
                    UPDATE public.reply_attempt
                    SET state = 'failed', failure_reason = %s
                    WHERE reply_request_id = %s AND number = %s
                      AND state = 'running'
                    RETURNING reply_request_id
                    """,
                    (
                        _safe_failure_reason(reason),
                        request.request_id,
                        request.attempt,
                    ),
                ).fetchone()
                if attempt is None:
                    raise ReplyStoreInvariantError(
                        "回复尝试失败状态写入不一致。"
                    )
        except ReplyPersistenceError:
            raise
        except psycopg.Error:
            raise ReplyPersistenceError(
                "回复请求失败状态持久化失败。"
            ) from None

    def read(self, request_id: UUID, scope: ContactScope) -> StoredReplyRequest:
        """按 owner/contact 读取请求、尝试、证据和已完成候选。"""

        if not isinstance(request_id, UUID) or not isinstance(scope, ContactScope):
            raise ReplyStoreInvariantError("回复请求读取范围结构无效。")
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    SELECT id, owner_id, contact_id,
                           conversation_binding_id, idempotency_key,
                           normalized_input, state, attempt,
                           lease_expires_at, continued_from_candidate_id,
                           context_snapshot, skill_library_revision,
                           skill_id, skill_version_id, skill_name,
                           skill_selection_method,
                           skill_selection_reason,
                           skill_load_state,
                           skill_loaded_resources
                    FROM public.reply_request
                    WHERE id = %s AND owner_id = %s AND contact_id = %s
                    FOR UPDATE
                    """,
                    (request_id, scope.owner_id, scope.contact_id),
                ).fetchone()
                if row is None:
                    raise ReplyStoreInvariantError(
                        "回复请求不属于当前联系人范围。"
                    )
                request = self._request_from_row(row)
                if request.scope != scope:
                    raise ReplyStoreInvariantError(
                        "回复请求不属于当前联系人范围。"
                    )
                stored = StoredReplyRequest(
                    request=request,
                    state=self._state_from_row(row),
                    attempts=self._read_attempts(connection, request_id),
                    evidence=self._read_evidence(connection, request_id, scope),
                    result=(
                        self._read_result(connection, row)
                        if self._state_from_row(row)
                        is ReplyAttemptState.COMPLETED
                        else None
                    ),
                )
        except ReplyPersistenceError:
            raise
        except psycopg.Error:
            raise ReplyPersistenceError("回复请求读取失败。") from None
        return stored

    def _connect(self) -> Any:
        return psycopg.connect(self._database_url, row_factory=dict_row)

    def _new_uuid(self) -> UUID:
        try:
            value = self._id_factory()
        except Exception:
            raise ReplyStoreInvariantError("ReplyStore 标识生成失败。") from None
        if not isinstance(value, UUID):
            raise ReplyStoreInvariantError("ReplyStore 标识结构无效。")
        return value

    def _now(self) -> datetime:
        try:
            value = self._clock()
        except Exception:
            raise ReplyStoreInvariantError("ReplyStore 时钟读取失败。") from None
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
            request.conversation_binding_id != command.conversation_binding_id
            or request.normalized_input != normalized_input
        ):
            raise ReplyIdempotencyConflictError(
                "回复请求幂等键与输入不一致。"
            )

    @staticmethod
    def _state_from_row(row: dict[str, Any]) -> ReplyAttemptState:
        try:
            return ReplyAttemptState(row["state"])
        except (KeyError, TypeError, ValueError):
            raise ReplyStoreInvariantError(
                "回复请求状态结构无效。"
            ) from None

    @staticmethod
    def _request_from_row(row: dict[str, Any]) -> ReplyRequest:
        try:
            return ReplyRequest(
                request_id=row["id"],
                idempotency_key=row["idempotency_key"],
                normalized_input=row["normalized_input"],
                scope=ContactScope(row["owner_id"], row["contact_id"]),
                conversation_binding_id=row["conversation_binding_id"],
                attempt=row["attempt"],
                lease_expires_at=row["lease_expires_at"],
                continued_from_candidate_id=row[
                    "continued_from_candidate_id"
                ],
            )
        except (KeyError, TypeError, ValueError):
            raise ReplyStoreInvariantError(
                "回复请求数据结构无效。"
            ) from None

    @staticmethod
    def _resolve_continuation(
        connection: Any,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ContinuedReplyCandidate | None:
        candidate_id = command.continued_from_candidate_id
        if candidate_id is None:
            return None
        row = connection.execute(
            """
            SELECT id, owner_id, contact_id,
                   conversation_binding_id, candidate_text
            FROM public.reply_candidate
            WHERE id = %s
              AND owner_id = %s
              AND contact_id = %s
              AND conversation_binding_id = %s
            """,
            (
                candidate_id,
                verified_scope.owner_id,
                verified_scope.contact_id,
                verified_scope.conversation_binding_id,
            ),
        ).fetchone()
        if row is None:
            raise ReplyContinuationError(
                "历史候选不属于当前已验证联系人会话。"
            )
        return ContinuedReplyCandidate(
            candidate_id=row["id"],
            scope=ContactScope(row["owner_id"], row["contact_id"]),
            conversation_binding_id=row["conversation_binding_id"],
            text=row["candidate_text"],
        )

    @staticmethod
    def _mark_attempt_expired(
        connection: Any,
        *,
        request_id: UUID,
        attempt: int,
    ) -> None:
        updated_request = connection.execute(
            """
            UPDATE public.reply_request
            SET state = 'expired', updated_at = now()
            WHERE id = %s AND state = 'running'
            RETURNING id
            """,
            (request_id,),
        ).fetchone()
        if updated_request is None:
            raise ReplyStoreInvariantError("回复请求过期状态写入不一致。")
        updated_attempt = connection.execute(
            """
            UPDATE public.reply_attempt
            SET state = 'expired', failure_reason = 'lease_expired'
            WHERE reply_request_id = %s AND number = %s
              AND state = 'running'
            RETURNING reply_request_id
            """,
            (request_id, attempt),
        ).fetchone()
        if updated_attempt is None:
            raise ReplyStoreInvariantError("回复尝试过期状态写入不一致。")

    def _validate_context(
        self,
        connection: Any,
        request: ReplyRequest,
        context: ReplyContext,
    ) -> set[UUID]:
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
            and isinstance(context.evidence, tuple)
            and context.evidence
            and isinstance(context.skill_library_revision, int)
            and context.skill_library_revision >= 0
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
            and isinstance(context.risk_notes, tuple)
            and all(
                isinstance(note, str) and note.strip()
                for note in context.risk_notes
            )
            and isinstance(context.tool_calls, tuple)
        ):
            raise ReplyStoreInvariantError(
                "回复上下文不属于当前持久化请求。"
            )
        evidence_ids: set[UUID] = set()
        for item in context.evidence:
            if (
                not isinstance(item, ContextEvidence)
                or item.scope != request.scope
                or item.kind
                not in (
                    "message",
                    "confirmed_memory",
                    "owner_memory",
                    "user_draft",
                    "continued_candidate",
                )
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
        else:
            candidate = connection.execute(
                """
                SELECT candidate_text
                FROM public.reply_candidate
                WHERE id = %s
                  AND owner_id = %s
                  AND contact_id = %s
                  AND conversation_binding_id = %s
                """,
                (
                    request.continued_from_candidate_id,
                    request.scope.owner_id,
                    request.scope.contact_id,
                    request.conversation_binding_id,
                ),
            ).fetchone()
            if (
                candidate is None
                or len(continuation_evidence) != 1
                or continuation_evidence[0].evidence_id
                != request.continued_from_candidate_id
                or continuation_evidence[0].text != candidate["candidate_text"]
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
        for candidate in reply.candidates:
            if not (
                isinstance(candidate.text, str)
                and bool(candidate.text.strip())
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
        if reply.used_skill is not None and not (
            isinstance(reply.used_skill, SkillUse)
            and isinstance(reply.used_skill.skill_id, UUID)
            and isinstance(reply.used_skill.version_id, UUID)
            and isinstance(reply.used_skill.name, str)
            and bool(reply.used_skill.name.strip())
            and reply.used_skill.selection_method in ("auto", "user")
            and isinstance(reply.used_skill.selection_reason, str)
            and bool(reply.used_skill.selection_reason.strip())
            and isinstance(reply.used_skill.resource_paths, tuple)
            and all(
                isinstance(path, str) and bool(path.strip())
                for path in reply.used_skill.resource_paths
            )
            and reply.used_skill.load_state in ("loaded", "resource_failed")
        ):
            raise ReplyStoreInvariantError("Skill 使用摘要结构无效。")

    @staticmethod
    def _context_snapshot(context: ReplyContext) -> dict[str, Any]:
        direction: dict[str, str] | None = None
        if context.direction is not None:
            direction = {
                "text": context.direction.text,
                "source": context.direction.source.value,
            }
        return {
            "scope": {
                "owner_id": str(context.scope.owner_id),
                "contact_id": str(context.scope.contact_id),
            },
            "current_text": context.current_text,
            "direction": direction,
            "risk_notes": list(context.risk_notes),
            "skill_library_revision": context.skill_library_revision,
            "memory_revision": context.memory_revision,
            "index_revision": context.index_revision,
            "tool_calls": [
                {
                    "tool_name": trace.tool_name,
                    "status": trace.status,
                    "evidence_ids": [
                        str(evidence_id) for evidence_id in trace.evidence_ids
                    ],
                    "latency_ms": trace.latency_ms,
                }
                for trace in context.tool_calls
            ],
            "evidence": [
                {
                    "evidence_id": str(item.evidence_id),
                    "kind": item.kind,
                    "text": item.text,
                    "source_ids": [
                        str(source_id) for source_id in item.source_ids
                    ],
                    "selection_reason": item.selection_reason,
                    "status": item.status,
                    "valid_at": (
                        item.valid_at.isoformat()
                        if item.valid_at is not None
                        else None
                    ),
                    "invalid_at": (
                        item.invalid_at.isoformat()
                        if item.invalid_at is not None
                        else None
                    ),
                    "revision": item.revision,
                }
                for item in context.evidence
            ],
        }

    @staticmethod
    def _skill_columns(
        skill: SkillUse | None,
    ) -> dict[str, Any]:
        if skill is None:
            return {
                "skill_id": None,
                "version_id": None,
                "name": None,
                "selection_method": None,
                "selection_reason": None,
                "load_state": None,
                "loaded_resources": None,
            }
        return {
            "skill_id": skill.skill_id,
            "version_id": skill.version_id,
            "name": skill.name,
            "selection_method": skill.selection_method,
            "selection_reason": skill.selection_reason or None,
            "load_state": skill.load_state,
            "loaded_resources": (
                list(skill.resource_paths) if skill.resource_paths else None
            ),
        }

    @staticmethod
    def _insert_evidence(
        connection: Any,
        request: ReplyRequest,
        context: ReplyContext,
    ) -> None:
        for ordinal, item in enumerate(context.evidence):
            connection.execute(
                """
                INSERT INTO public.reply_context_evidence (
                    reply_request_id, evidence_id, owner_id, contact_id,
                    conversation_binding_id, ordinal, kind, evidence_text,
                    source_ids, selection_reason, evidence_status,
                    evidence_valid_at, evidence_invalid_at, evidence_revision
                )
                VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s
                )
                """,
                (
                    request.request_id,
                    item.evidence_id,
                    request.scope.owner_id,
                    request.scope.contact_id,
                    request.conversation_binding_id,
                    ordinal,
                    item.kind,
                    item.text,
                    Jsonb([str(source_id) for source_id in item.source_ids]),
                    item.selection_reason,
                    item.status,
                    item.valid_at,
                    item.invalid_at,
                    item.revision,
                ),
            )

    @staticmethod
    def _insert_candidates(
        connection: Any,
        request: ReplyRequest,
        result: ReplyGenerated,
    ) -> None:
        for candidate_ordinal, candidate in enumerate(result.candidates):
            connection.execute(
                """
                INSERT INTO public.reply_candidate (
                    id, reply_request_id, owner_id, contact_id,
                    conversation_binding_id, ordinal, candidate_text,
                    basis, risk_notes
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    candidate.candidate_id,
                    request.request_id,
                    request.scope.owner_id,
                    request.scope.contact_id,
                    request.conversation_binding_id,
                    candidate_ordinal,
                    candidate.text,
                    candidate.basis,
                    Jsonb(list(candidate.risk_notes)),
                ),
            )
            for citation_ordinal, evidence_id in enumerate(candidate.citation_ids):
                connection.execute(
                    """
                    INSERT INTO public.reply_candidate_citation (
                        reply_request_id, candidate_id, evidence_id, ordinal
                    )
                    VALUES (%s, %s, %s, %s)
                    """,
                    (
                        request.request_id,
                        candidate.candidate_id,
                        evidence_id,
                        citation_ordinal,
                    ),
                )

    @staticmethod
    def _read_attempts(
        connection: Any,
        request_id: UUID,
    ) -> tuple[ReplyAttempt, ...]:
        rows = connection.execute(
            """
            SELECT number, state, started_at, lease_expires_at, failure_reason
            FROM public.reply_attempt
            WHERE reply_request_id = %s
            ORDER BY number
            """,
            (request_id,),
        ).fetchall()
        attempts: list[ReplyAttempt] = []
        for row in rows:
            try:
                attempts.append(
                    ReplyAttempt(
                        number=row["number"],
                        state=ReplyAttemptState(row["state"]),
                        started_at=row["started_at"],
                        lease_expires_at=row["lease_expires_at"],
                        failure_reason=row["failure_reason"],
                    )
                )
            except (KeyError, TypeError, ValueError):
                raise ReplyStoreInvariantError(
                    "回复尝试数据结构无效。"
                ) from None
        return tuple(attempts)

    @staticmethod
    def _read_evidence(
        connection: Any,
        request_id: UUID,
        scope: ContactScope,
    ) -> tuple[ContextEvidence, ...]:
        rows = connection.execute(
            """
            SELECT evidence_id, owner_id, contact_id, kind, evidence_text,
                   source_ids, selection_reason, evidence_status,
                   evidence_valid_at, evidence_invalid_at, evidence_revision
            FROM public.reply_context_evidence
            WHERE reply_request_id = %s
              AND owner_id = %s
              AND contact_id = %s
            ORDER BY ordinal
            """,
            (request_id, scope.owner_id, scope.contact_id),
        ).fetchall()
        evidence: list[ContextEvidence] = []
        for row in rows:
            source_ids = PostgresReplyStore._read_uuid_array(row["source_ids"])
            try:
                evidence.append(
                    ContextEvidence(
                        evidence_id=row["evidence_id"],
                        kind=row["kind"],
                        text=row["evidence_text"],
                        scope=ContactScope(row["owner_id"], row["contact_id"]),
                        source_ids=source_ids,
                        selection_reason=row["selection_reason"],
                        status=row["evidence_status"],
                        valid_at=row["evidence_valid_at"],
                        invalid_at=row["evidence_invalid_at"],
                        revision=row["evidence_revision"],
                    )
                )
            except (KeyError, TypeError, ValueError):
                raise ReplyStoreInvariantError(
                    "回复证据数据结构无效。"
                ) from None
        return tuple(evidence)

    @staticmethod
    def _read_uuid_array(value: Any) -> tuple[UUID, ...]:
        if not isinstance(value, list):
            raise ReplyStoreInvariantError("回复证据来源结构无效。")
        converted: list[UUID] = []
        for item in value:
            try:
                converted.append(item if isinstance(item, UUID) else UUID(item))
            except (TypeError, ValueError):
                raise ReplyStoreInvariantError(
                    "回复证据来源结构无效。"
                ) from None
        return tuple(converted)

    @staticmethod
    def _read_string_array(value: Any) -> tuple[str, ...]:
        if not isinstance(value, list) or any(
            not isinstance(item, str) for item in value
        ):
            raise ReplyStoreInvariantError("回复数组字段结构无效。")
        return tuple(value)

    @staticmethod
    def _read_resource_paths(value: Any) -> tuple[str, ...]:
        if value is None:
            return ()
        if not isinstance(value, list) or any(
            not isinstance(item, str) or not item.strip() for item in value
        ):
            raise ReplyStoreInvariantError("Skill 资源路径摘要结构无效。")
        paths = tuple(value)
        if len(paths) != len(set(paths)):
            raise ReplyStoreInvariantError("Skill 资源路径摘要重复。")
        return paths

    def _read_result(
        self,
        connection: Any,
        request_row: dict[str, Any],
    ) -> ReplyGenerated:
        if request_row["context_snapshot"] is None:
            raise ReplyStoreInvariantError("已完成回复缺少上下文快照。")
        candidate_rows = connection.execute(
            """
            SELECT id, candidate_text, basis, risk_notes
            FROM public.reply_candidate
            WHERE reply_request_id = %s
            ORDER BY ordinal
            """,
            (request_row["id"],),
        ).fetchall()
        if not candidate_rows:
            raise ReplyStoreInvariantError("已完成回复缺少候选结果。")
        citation_rows = connection.execute(
            """
            SELECT candidate_id, evidence_id
            FROM public.reply_candidate_citation
            WHERE reply_request_id = %s
            ORDER BY candidate_id, ordinal
            """,
            (request_row["id"],),
        ).fetchall()
        citations_by_candidate: dict[UUID, list[UUID]] = {
            row["id"]: [] for row in candidate_rows
        }
        for row in citation_rows:
            if row["candidate_id"] not in citations_by_candidate:
                raise ReplyStoreInvariantError("候选引用关系结构无效。")
            citations_by_candidate[row["candidate_id"]].append(
                row["evidence_id"]
            )

        candidates: list[ReplyCandidate] = []
        evidence_ids: list[UUID] = []
        for row in candidate_rows:
            citation_ids = tuple(citations_by_candidate[row["id"]])
            if not citation_ids:
                raise ReplyStoreInvariantError("候选回复缺少依据引用。")
            candidates.append(
                ReplyCandidate(
                    candidate_id=row["id"],
                    text=row["candidate_text"],
                    basis=row["basis"],
                    citation_ids=citation_ids,
                    risk_notes=self._read_string_array(row["risk_notes"]),
                )
            )
            for evidence_id in citation_ids:
                if evidence_id not in evidence_ids:
                    evidence_ids.append(evidence_id)

        skill_id = request_row["skill_id"]
        skill_version_id = request_row["skill_version_id"]
        skill_name = request_row["skill_name"]
        if skill_id is None and skill_version_id is None and skill_name is None:
            used_skill = None
        elif (
            isinstance(skill_id, UUID)
            and isinstance(skill_version_id, UUID)
            and isinstance(skill_name, str)
            and skill_name.strip()
        ):
            used_skill = SkillUse(
                skill_id=skill_id,
                version_id=skill_version_id,
                name=skill_name,
                selection_method=(
                    request_row["skill_selection_method"]
                    if request_row.get("skill_selection_method") in ("auto", "user")
                    else "auto"
                ),
                selection_reason=(
                    request_row["skill_selection_reason"]
                    if isinstance(
                        request_row.get("skill_selection_reason"),
                        str,
                    )
                    else ""
                ),
                resource_paths=self._read_resource_paths(
                    request_row.get("skill_loaded_resources")
                ),
                load_state=(
                    request_row["skill_load_state"]
                    if request_row.get("skill_load_state")
                    in ("loaded", "resource_failed")
                    else "loaded"
                ),
            )
        else:
            raise ReplyStoreInvariantError("Skill 使用摘要结构无效。")
        if not isinstance(request_row["skill_library_revision"], int):
            raise ReplyStoreInvariantError("已完成回复缺少 Skill 修订号。")
        return ReplyGenerated(
            reply_request_id=request_row["id"],
            candidates=tuple(candidates),
            context_receipt=ContextReceipt(evidence_ids=tuple(evidence_ids)),
            used_skill=used_skill,
        )


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


__all__ = ["PostgresReplyStore"]
