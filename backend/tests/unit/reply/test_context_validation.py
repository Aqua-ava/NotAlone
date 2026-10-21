"""共享上下文校验：generator / InMemory / PostgreSQL 三处一致且 fail closed。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Callable
from unittest.mock import patch
from uuid import UUID, uuid4

from notalone.reply.assistant_discussion import (
    DiscussionContext,
    DiscussionSnapshot,
)
from notalone.reply.context import (
    ContextEvidence,
    ContinuedReplyCandidate,
    ReplyContext,
    ToolCallTrace,
)
from notalone.reply.context_validation import (
    normalize_reply_input,
    validate_reply_context,
)
from notalone.reply.errors import (
    ReplyInvariantError,
    ReplyStoreInvariantError,
)
from notalone.reply.generator import ReplyGenerator
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    InitiateConversation,
    ReplyToMessage,
    RewriteDraft,
)
from notalone.scopes import ContactScope

OWNER_ID = UUID("91000000-0000-0000-0000-000000000001")
CONTACT_ID = UUID("91000000-0000-0000-0000-000000000002")
OTHER_CONTACT_ID = UUID("91000000-0000-0000-0000-000000000003")
BINDING_ID = UUID("91000000-0000-0000-0000-000000000004")
REQUEST_KEY = UUID("91000000-0000-0000-0000-000000000005")
REQUEST_ID = UUID("91000000-0000-0000-0000-000000000006")
SECOND_REQUEST_KEY = UUID("91000000-0000-0000-0000-000000000007")
MESSAGE_ID = UUID("91000000-0000-0000-0000-000000000008")
CANDIDATE_ID = UUID("91000000-0000-0000-0000-000000000009")
SOURCE_ID = UUID("91000000-0000-0000-0000-00000000000a")
NOW = datetime(2026, 10, 22, tzinfo=timezone.utc)

SCOPE = ContactScope(OWNER_ID, CONTACT_ID)
MESSAGE_TEXT = "明天一起吃饭吗？"
DRAFT_TEXT = "想约对方周末徒步。"


def _reply_command(
    *, key: UUID = REQUEST_KEY, continued_from_candidate_id: UUID | None = None,
) -> GenerateReply:
    return GenerateReply(
        idempotency_key=key,
        scope=SCOPE,
        conversation_binding_id=BINDING_ID,
        content=ReplyToMessage(
            target_message_id=MESSAGE_ID,
            direction=ConfirmedDirection("自然地答应", DirectionSource.DIRECT_INPUT),
        ),
        continued_from_candidate_id=continued_from_candidate_id,
    )


def _initiate_command() -> GenerateReply:
    return GenerateReply(
        idempotency_key=REQUEST_KEY,
        scope=SCOPE,
        conversation_binding_id=BINDING_ID,
        content=InitiateConversation(
            purpose=ConfirmedDirection("问候近况", DirectionSource.DIRECT_INPUT),
        ),
    )


def _draft_command(*, include_relationship_context: bool = False) -> GenerateReply:
    return GenerateReply(
        idempotency_key=REQUEST_KEY,
        scope=SCOPE,
        conversation_binding_id=BINDING_ID,
        content=RewriteDraft(
            draft_text=DRAFT_TEXT,
            include_relationship_context=include_relationship_context,
        ),
    )


def _message_evidence(*, text: str = MESSAGE_TEXT) -> ContextEvidence:
    return ContextEvidence(
        evidence_id=MESSAGE_ID,
        kind="message",
        text=text,
        scope=SCOPE,
        source_ids=(SOURCE_ID,),
        selection_reason="当前目标消息",
    )


def _reply_context(
    command: GenerateReply | None = None,
    *,
    evidence: tuple[ContextEvidence, ...] | None = None,
) -> ReplyContext:
    command = command or _reply_command()
    return ReplyContext(
        reply_request_id=REQUEST_ID,
        command=command,
        scope=SCOPE,
        current_text=MESSAGE_TEXT,
        direction=command.content.direction,
        evidence=evidence if evidence is not None else (_message_evidence(),),
        skill_library_revision=1,
    )


def _initiate_context() -> ReplyContext:
    command = _initiate_command()
    purpose_text = command.content.purpose.text
    evidence = ContextEvidence(
        evidence_id=uuid4(),
        kind="user_purpose",
        text=purpose_text,
        scope=SCOPE,
        selection_reason="用户本次明确的主动联系目的。",
        status="user_input",
    )
    return ReplyContext(
        reply_request_id=REQUEST_ID,
        command=command,
        scope=SCOPE,
        current_text=purpose_text,
        direction=command.content.purpose,
        evidence=(evidence,),
        skill_library_revision=1,
    )


def _draft_context(
    command: GenerateReply | None = None,
    *,
    evidence: tuple[ContextEvidence, ...] | None = None,
) -> ReplyContext:
    command = command or _draft_command()
    draft_evidence = ContextEvidence(
        evidence_id=uuid4(),
        kind="user_draft",
        text=DRAFT_TEXT,
        scope=SCOPE,
        selection_reason="本次用户原句。",
    )
    return ReplyContext(
        reply_request_id=REQUEST_ID,
        command=command,
        scope=SCOPE,
        current_text=DRAFT_TEXT,
        direction=None,
        evidence=evidence if evidence is not None else (draft_evidence,),
        skill_library_revision=1,
    )


class _CandidateRowConnection:
    """只回放一条候选正文的合成连接；不连接数据库。"""

    def __init__(self, candidate_text: str | None) -> None:
        self.candidate_text = candidate_text

    def execute(self, _sql: str, _params: object) -> "_CandidateRowConnection":
        return self

    def fetchone(self) -> dict[str, str] | None:
        if self.candidate_text is None:
            return None
        return {"candidate_text": self.candidate_text}


def _request_for(command: GenerateReply):
    from notalone.reply.store import ReplyRequest

    return ReplyRequest(
        request_id=REQUEST_ID,
        idempotency_key=command.idempotency_key,
        normalized_input=normalize_reply_input(command),
        scope=command.scope,
        conversation_binding_id=command.conversation_binding_id,
        attempt=1,
        lease_expires_at=NOW + timedelta(seconds=30),
        continued_from_candidate_id=command.continued_from_candidate_id,
    )


@dataclass(frozen=True)
class _Case:
    name: str
    build: Callable[[], tuple[GenerateReply, ReplyContext]]
    accepted: bool


class ReplyContextValidationConsistencyTest(unittest.TestCase):
    """同一合成上下文在三个入口得到相同接受/拒绝结论。"""

    def _cases(self) -> tuple[_Case, ...]:
        other_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        discussion_session = uuid4()
        discussion_input = uuid4()
        discussion_turn = uuid4()
        wrong_scope_discussion = DiscussionContext(
            other_scope,
            discussion_session,
            REQUEST_KEY,
            discussion_input,
            (),
            DiscussionSnapshot(
                other_scope, discussion_session, REQUEST_KEY,
                discussion_input, discussion_turn, "1" * 64, (),
            ),
        )
        draft_with_history = _draft_context(
            evidence=(
                ContextEvidence(uuid4(), "user_draft", DRAFT_TEXT, SCOPE),
                _message_evidence(text="历史消息"),
            ),
        )
        draft_without_draft = _draft_context(
            _draft_command(include_relationship_context=True),
            evidence=(_message_evidence(text="历史消息"),),
        )
        continuation_valid = _reply_context(
            _reply_command(continued_from_candidate_id=CANDIDATE_ID),
            evidence=(
                _message_evidence(),
                ContextEvidence(
                    evidence_id=CANDIDATE_ID,
                    kind="continued_candidate",
                    text="旧候选正文",
                    scope=SCOPE,
                ),
            ),
        )
        continuation_no_selection = _reply_context(
            evidence=(
                _message_evidence(),
                ContextEvidence(
                    evidence_id=CANDIDATE_ID,
                    kind="continued_candidate",
                    text="旧候选正文",
                    scope=SCOPE,
                ),
            ),
        )
        continuation_wrong_id = _reply_context(
            _reply_command(continued_from_candidate_id=CANDIDATE_ID),
            evidence=(
                _message_evidence(),
                ContextEvidence(
                    evidence_id=uuid4(),
                    kind="continued_candidate",
                    text="旧候选正文",
                    scope=SCOPE,
                ),
            ),
        )
        return (
            _Case("valid_reply", lambda: (_reply_command(), _reply_context()), True),
            _Case("valid_initiate", lambda: (_initiate_command(), _initiate_context()), True),
            _Case("valid_draft", lambda: (_draft_command(), _draft_context()), True),
            _Case(
                "target_text_mismatch",
                lambda: (
                    _reply_command(),
                    replace(_reply_context(), current_text="另一句话"),
                ),
                False,
            ),
            _Case(
                "direction_mismatch",
                lambda: (_reply_command(), replace(_reply_context(), direction=None)),
                False,
            ),
            _Case(
                "initiate_evidence_text_mismatch",
                lambda: (
                    _initiate_command(),
                    replace(
                        _initiate_context(),
                        evidence=(
                            replace(_initiate_context().evidence[0], text="另一句目的"),
                        ),
                    ),
                ),
                False,
            ),
            _Case(
                "draft_history_without_authorization",
                lambda: (_draft_command(), draft_with_history),
                False,
            ),
            _Case(
                "draft_missing_draft_evidence",
                lambda: (_draft_command(include_relationship_context=True), draft_without_draft),
                False,
            ),
            _Case(
                "duplicate_evidence_id",
                lambda: (
                    _reply_command(),
                    replace(_reply_context(), evidence=(_message_evidence(), _message_evidence(text="重复"))),
                ),
                False,
            ),
            _Case(
                "foreign_evidence_scope",
                lambda: (
                    _reply_command(),
                    replace(
                        _reply_context(),
                        evidence=(
                            replace(_message_evidence(), scope=other_scope),
                        ),
                    ),
                ),
                False,
            ),
            _Case(
                "tool_trace_unknown_evidence",
                lambda: (
                    _reply_command(),
                    replace(
                        _reply_context(),
                        tool_calls=(ToolCallTrace("search_messages", "succeeded", (uuid4(),)),),
                    ),
                ),
                False,
            ),
            _Case(
                "discussion_scope_mismatch",
                lambda: (
                    _reply_command(),
                    replace(_reply_context(), assistant_discussion=wrong_scope_discussion),
                ),
                False,
            ),
            _Case(
                "continuation_valid",
                lambda: (
                    _reply_command(continued_from_candidate_id=CANDIDATE_ID),
                    continuation_valid,
                ),
                True,
            ),
            _Case(
                "continuation_without_selection",
                lambda: (_reply_command(), continuation_no_selection),
                False,
            ),
            _Case(
                "continuation_wrong_id",
                lambda: (
                    _reply_command(continued_from_candidate_id=CANDIDATE_ID),
                    continuation_wrong_id,
                ),
                False,
            ),
        )

    def _generator_accepts(self, command: GenerateReply, context: ReplyContext) -> bool:
        candidate = None
        for item in context.evidence:
            if (item.kind == "continued_candidate"
                    and item.evidence_id == command.continued_from_candidate_id):
                candidate = ContinuedReplyCandidate(
                    item.evidence_id, context.scope, command.conversation_binding_id, item.text,
                )
        try:
            ReplyGenerator._validate_context(
                command, context, continued_candidate=candidate,
            )
        except ReplyInvariantError:
            return False
        return True

    def _in_memory_accepts(self, command: GenerateReply, context: ReplyContext) -> bool:
        from notalone.reply.adapters.in_memory_store import InMemoryReplyStore
        from notalone.reply.store import _StoredCandidate

        store = InMemoryReplyStore()
        store._candidates[CANDIDATE_ID] = _StoredCandidate(SCOPE, BINDING_ID, "旧候选正文")
        try:
            store._validate_context(_request_for(command), context)
        except ReplyStoreInvariantError:
            return False
        return True

    def _postgres_accepts(self, command: GenerateReply, context: ReplyContext) -> bool:
        from notalone.persistence.reply_store import PostgresReplyStore

        store = PostgresReplyStore("postgresql:///unused_validation")
        with patch("notalone.persistence.explored_generation.require_explored_context", lambda *_args, **_kwargs: None):
            try:
                store._validate_context(
                    _CandidateRowConnection("旧候选正文"),
                    _request_for(command),
                    context,
                )
            except ReplyStoreInvariantError:
                return False
        return True

    def test_three_implementations_agree_on_accept_and_reject(self) -> None:
        for case in self._cases():
            command, context = case.build()
            for name, verdict in (
                ("generator", self._generator_accepts),
                ("in_memory", self._in_memory_accepts),
                ("postgres", self._postgres_accepts),
            ):
                with self.subTest(case=case.name, implementation=name):
                    self.assertEqual(verdict(command, context), case.accepted)

    def test_shared_validator_requires_an_authority(self) -> None:
        with self.assertRaises(TypeError):
            validate_reply_context(_reply_context())

    def test_shared_validator_returns_validated_evidence_ids(self) -> None:
        evidence_ids = validate_reply_context(_reply_context(), command=_reply_command())

        self.assertEqual(evidence_ids, frozenset({MESSAGE_ID}))

    def test_store_wrappers_report_shared_error_text(self) -> None:
        from notalone.persistence.reply_store import PostgresReplyStore

        command = _reply_command()
        context = replace(_reply_context(), direction=None)
        request = _request_for(command)
        messages = []
        with self.assertRaises(ReplyStoreInvariantError) as in_memory:
            from notalone.reply.adapters.in_memory_store import InMemoryReplyStore

            InMemoryReplyStore()._validate_context(request, context)
        messages.append(str(in_memory.exception))
        with patch("notalone.persistence.explored_generation.require_explored_context", lambda *_args, **_kwargs: None):
            with self.assertRaises(ReplyStoreInvariantError) as postgres:
                PostgresReplyStore("postgresql:///unused_validation")._validate_context(
                    object(), request, context,
                )
        messages.append(str(postgres.exception))
        self.assertEqual(messages[0], messages[1])

    def test_generator_wrapper_keeps_explored_unrelated_domain_error(self) -> None:
        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator._validate_context(_reply_command(), {"invalid": "context"})

    def test_generator_rejects_continuation_text_not_matching_store_snapshot(self) -> None:
        command = _reply_command(continued_from_candidate_id=CANDIDATE_ID)
        context = _reply_context(
            command,
            evidence=(
                _message_evidence(),
                ContextEvidence(CANDIDATE_ID, "continued_candidate", "上下文里的旧候选", SCOPE),
            ),
        )
        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator._validate_context(
                command,
                context,
                continued_candidate=ContinuedReplyCandidate(
                    CANDIDATE_ID, SCOPE, BINDING_ID, "存储里的另一份旧候选",
                ),
            )

    def test_store_binding_rejects_stale_normalized_input(self) -> None:
        from notalone.reply.adapters.in_memory_store import InMemoryReplyStore
        from notalone.persistence.reply_store import PostgresReplyStore

        command = _reply_command()
        context = _reply_context()
        stale = replace(_request_for(command), normalized_input="stale-input")
        with self.assertRaises(ReplyStoreInvariantError):
            InMemoryReplyStore()._validate_context(stale, context)
        with patch("notalone.persistence.explored_generation.require_explored_context", lambda *_args, **_kwargs: None):
            with self.assertRaises(ReplyStoreInvariantError):
                PostgresReplyStore("postgresql:///unused_validation")._validate_context(
                    object(), stale, context,
                )

    def test_store_binding_rejects_request_id_mismatch(self) -> None:
        from notalone.reply.adapters.in_memory_store import InMemoryReplyStore

        command = _reply_command()
        context = replace(_reply_context(), reply_request_id=uuid4())
        with self.assertRaises(ReplyStoreInvariantError):
            InMemoryReplyStore()._validate_context(_request_for(command), context)

    def test_postgres_wrapper_keeps_explored_generation_recheck(self) -> None:
        from notalone.persistence.reply_store import PostgresReplyStore

        command = _reply_command()
        with patch("notalone.persistence.explored_generation.require_explored_context") as explored:
            PostgresReplyStore("postgresql:///unused_validation")._validate_context(
                object(), _request_for(command), _reply_context(),
            )
        explored.assert_called_once()

    def test_postgres_wrapper_compares_continuation_text_with_persisted_candidate(self) -> None:
        from notalone.persistence.reply_store import PostgresReplyStore

        command = _reply_command(continued_from_candidate_id=CANDIDATE_ID)
        context = _reply_context(
            command,
            evidence=(
                _message_evidence(),
                ContextEvidence(CANDIDATE_ID, "continued_candidate", "被篡改的旧候选", SCOPE),
            ),
        )
        with patch("notalone.persistence.explored_generation.require_explored_context", lambda *_args, **_kwargs: None):
            with self.assertRaises(ReplyStoreInvariantError):
                PostgresReplyStore("postgresql:///unused_validation")._validate_context(
                    _CandidateRowConnection("真实的旧候选"),
                    _request_for(command),
                    context,
                )

    def test_in_memory_wrapper_compares_continuation_text_with_saved_candidate(self) -> None:
        from notalone.reply.adapters.in_memory_store import InMemoryReplyStore
        from notalone.reply.runtime import RuntimeCandidate
        from notalone.reply.store import ValidatedReply
        from notalone.scopes import VerifiedConversationScope

        store = InMemoryReplyStore()
        verified = VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID)
        first_command = _reply_command()
        first = store.start(first_command, verified)
        first_context = replace(_reply_context(), reply_request_id=first.request.request_id)
        saved = store.save(first.request, first_context, ValidatedReply(
            candidates=(RuntimeCandidate(
                text="可以呀，明天见。", basis="回应当前消息",
                citation_ids=(MESSAGE_ID,), risk_notes=(),
            ),),
            used_skill=None,
        ))
        candidate_id = saved.candidates[0].candidate_id
        second_command = _reply_command(key=SECOND_REQUEST_KEY, continued_from_candidate_id=candidate_id)
        second = store.start(second_command, verified)
        tampered = replace(
            _reply_context(
                second_command,
                evidence=(
                    _message_evidence(),
                    ContextEvidence(candidate_id, "continued_candidate", "被篡改的旧候选", SCOPE),
                ),
            ),
            reply_request_id=second.request.request_id,
        )
        with self.assertRaises(ReplyStoreInvariantError):
            store.save(second.request, tampered, ValidatedReply(
                candidates=(RuntimeCandidate(
                    text="好呀。", basis="回应当前消息",
                    citation_ids=(MESSAGE_ID,), risk_notes=(),
                ),),
                used_skill=None,
            ))


if __name__ == "__main__":
    unittest.main()
