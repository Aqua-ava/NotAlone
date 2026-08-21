"""通过 ReplyStore 公共合同验证请求和候选生命周期。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from uuid import UUID

from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import (
    ReplyContinuationError,
    ReplyIdempotencyConflictError,
    ReplyRunError,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyCandidate,
    ReplyGenerated,
    ReplyToMessage,
)
from notalone.reply.generator import ReplyGenerator
from notalone.reply.runtime import ReplyRuntimeResult, RuntimeCandidate
from notalone.reply.store import (
    ReplyAttemptState,
    ReplyRequestState,
    ValidatedReply,
)
from notalone.reply.adapters.in_memory_store import InMemoryReplyStore
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
CONTACT_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
OTHER_CONTACT_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
BINDING_ID = UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")
OTHER_BINDING_ID = UUID("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
MESSAGE_ID = UUID("11111111-1111-1111-1111-111111111111")
REQUEST_KEY = UUID("22222222-2222-2222-2222-222222222222")
SECOND_REQUEST_KEY = UUID("33333333-3333-3333-3333-333333333333")
REQUEST_ID = UUID("44444444-4444-4444-4444-444444444444")
CANDIDATE_ID = UUID("55555555-5555-5555-5555-555555555555")
SECOND_CANDIDATE_ID = UUID("66666666-6666-6666-6666-666666666666")


class FakeClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value


@dataclass
class CountingContext:
    template: ReplyContext
    calls: int = 0

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        reply_request_id: UUID | None = None,
        continued_candidate: object | None = None,
    ) -> ReplyContext:
        del command, verified_scope, continued_candidate
        self.calls += 1
        return replace(
            self.template,
            reply_request_id=reply_request_id or self.template.reply_request_id,
        )


@dataclass
class CountingRuntime:
    calls: int = 0

    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:
        self.calls += 1
        return ReplyRuntimeResult(
            candidates=(
                RuntimeCandidate(
                    text="可以呀，明天见。",
                    basis="回应当前消息",
                    citation_ids=(MESSAGE_ID,),
                    risk_notes=(),
                ),
            ),
            used_skill=None,
        )


@dataclass
class FailOnceRuntime:
    calls: int = 0

    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:
        del context
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("synthetic runtime failure")
        return ReplyRuntimeResult(
            candidates=(
                RuntimeCandidate(
                    text="第二次成功。",
                    basis="重试后生成",
                    citation_ids=(MESSAGE_ID,),
                    risk_notes=(),
                ),
            ),
            used_skill=None,
        )


class ReplyStoreLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        ids = iter(
            (
                REQUEST_ID,
                CANDIDATE_ID,
                SECOND_CANDIDATE_ID,
                UUID("77777777-7777-7777-7777-777777777777"),
            )
        )
        self.store = InMemoryReplyStore(
            clock=self.clock,
            lease_duration=timedelta(seconds=30),
            id_factory=lambda: next(ids),
        )
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.verified_scope = VerifiedConversationScope(
            OWNER_ID,
            CONTACT_ID,
            BINDING_ID,
        )

    def _command(
        self,
        *,
        key: UUID = REQUEST_KEY,
        direction: str = "自然地答应",
        continued_from_candidate_id: UUID | None = None,
        binding_id: UUID = BINDING_ID,
        contact_id: UUID = CONTACT_ID,
    ) -> GenerateReply:
        return GenerateReply(
            idempotency_key=key,
            scope=ContactScope(OWNER_ID, contact_id),
            conversation_binding_id=binding_id,
            content=ReplyToMessage(
                target_message_id=MESSAGE_ID,
                direction=ConfirmedDirection(
                    text=direction,
                    source=DirectionSource.DIRECT_INPUT,
                ),
            ),
            continued_from_candidate_id=continued_from_candidate_id,
        )

    def _context(
        self,
        command: GenerateReply,
        *,
        request_id: UUID = REQUEST_ID,
        evidence_id: UUID = MESSAGE_ID,
    ) -> ReplyContext:
        evidence = ContextEvidence(
            evidence_id=evidence_id,
            kind="message",
            text="明天一起吃饭吗？",
            scope=self.scope,
        )
        return ReplyContext(
            reply_request_id=request_id,
            command=command,
            scope=self.scope,
            current_text="明天一起吃饭吗？",
            direction=command.content.direction,
            evidence=(evidence,),
            skill_library_revision=1,
        )

    @staticmethod
    def _reply(text: str = "可以呀，明天见。") -> ValidatedReply:
        return ValidatedReply(
            candidates=(
                RuntimeCandidate(
                    text=text,
                    basis="回应当前消息",
                    citation_ids=(MESSAGE_ID,),
                    risk_notes=(),
                ),
            ),
            used_skill=None,
        )

    def _save_first(self) -> ReplyGenerated:
        command = self._command()
        started = self.store.start(command, self.verified_scope)
        return self.store.save(
            started.request,
            self._context(command, request_id=started.request.request_id),
            self._reply(),
        )

    def test_completed_request_replays_without_creating_new_request(self) -> None:
        command = self._command()
        first = self.store.start(command, self.verified_scope)
        saved = self.store.save(
            first.request,
            self._context(command, request_id=first.request.request_id),
            self._reply(),
        )

        replay = self.store.start(command, self.verified_scope)

        self.assertEqual(replay.state, ReplyRequestState.REPLAYED)
        self.assertEqual(replay.request.request_id, first.request.request_id)
        self.assertEqual(replay.result, saved)

    def test_generator_replay_does_not_call_context_or_runtime_again(self) -> None:
        command = self._command()
        ids = iter((REQUEST_ID, CANDIDATE_ID))
        store = InMemoryReplyStore(
            clock=self.clock,
            id_factory=lambda: next(ids),
            lease_duration=timedelta(seconds=30),
        )
        context = CountingContext(template=self._context(command))
        runtime = CountingRuntime()
        generator = ReplyGenerator(
            store=store,
            context=context,
            runtime=runtime,
        )

        first = generator.generate(command, verified_scope=self.verified_scope)
        replay = generator.generate(command, verified_scope=self.verified_scope)

        self.assertEqual(replay, first)
        self.assertEqual(context.calls, 1)
        self.assertEqual(runtime.calls, 1)

    def test_generator_marks_failure_then_retries_same_request(self) -> None:
        command = self._command()
        ids = iter((REQUEST_ID, CANDIDATE_ID))
        store = InMemoryReplyStore(
            clock=self.clock,
            id_factory=lambda: next(ids),
            lease_duration=timedelta(seconds=30),
        )
        context = CountingContext(template=self._context(command))
        runtime = FailOnceRuntime()
        generator = ReplyGenerator(
            store=store,
            context=context,
            runtime=runtime,
        )

        with self.assertRaises(ReplyRunError):
            generator.generate(command, verified_scope=self.verified_scope)
        failed = store.read(REQUEST_ID, self.scope)
        self.assertEqual(failed.state, ReplyAttemptState.FAILED)

        result = generator.generate(command, verified_scope=self.verified_scope)

        self.assertEqual(result.candidates[0].text, "第二次成功。")
        self.assertEqual(runtime.calls, 2)
        completed = store.read(REQUEST_ID, self.scope)
        self.assertEqual(
            tuple(attempt.state for attempt in completed.attempts),
            (ReplyAttemptState.FAILED, ReplyAttemptState.COMPLETED),
        )

    def test_same_key_with_different_normalized_input_is_stable_conflict(self) -> None:
        command = self._command()
        first = self.store.start(command, self.verified_scope)

        with self.assertRaises(ReplyIdempotencyConflictError) as caught:
            self.store.start(
                self._command(direction="拒绝邀请，但保持礼貌"),
                self.verified_scope,
            )

        self.assertEqual(str(caught.exception), "回复请求幂等键与输入不一致。")
        self.assertEqual(
            self.store.read(first.request.request_id, self.scope).state,
            ReplyAttemptState.RUNNING,
        )

    def test_valid_lease_returns_in_progress_without_a_second_attempt(self) -> None:
        command = self._command()
        first = self.store.start(command, self.verified_scope)

        processing = self.store.start(command, self.verified_scope)

        self.assertEqual(processing.state, ReplyRequestState.IN_PROGRESS)
        self.assertEqual(processing.request.request_id, first.request.request_id)
        record = self.store.read(first.request.request_id, self.scope)
        self.assertEqual(record.request.attempt, 1)
        self.assertEqual(len(record.attempts), 1)

    def test_failed_request_retries_with_same_request_and_preserves_attempts(self) -> None:
        command = self._command()
        first = self.store.start(command, self.verified_scope)
        self.store.fail(first.request, reason="runtime_failed")

        retry = self.store.start(command, self.verified_scope)

        self.assertEqual(retry.state, ReplyRequestState.STARTED)
        self.assertEqual(retry.request.request_id, first.request.request_id)
        self.assertEqual(retry.request.attempt, 2)
        record = self.store.read(retry.request.request_id, self.scope)
        self.assertEqual(
            tuple(attempt.state for attempt in record.attempts),
            (ReplyAttemptState.FAILED, ReplyAttemptState.RUNNING),
        )

        saved = self.store.save(
            retry.request,
            self._context(command, request_id=retry.request.request_id),
            self._reply(),
        )
        replay = self.store.start(command, self.verified_scope)
        self.assertEqual(replay.result, saved)
        self.assertEqual(len(self.store.read(saved.reply_request_id, self.scope).attempts), 2)

    def test_expired_lease_is_retried_as_a_new_attempt(self) -> None:
        command = self._command()
        first = self.store.start(command, self.verified_scope)
        self.clock.value += timedelta(seconds=31)

        retry = self.store.start(command, self.verified_scope)

        self.assertEqual(retry.state, ReplyRequestState.STARTED)
        self.assertEqual(retry.request.attempt, 2)
        record = self.store.read(retry.request.request_id, self.scope)
        self.assertEqual(
            tuple(attempt.state for attempt in record.attempts),
            (ReplyAttemptState.EXPIRED, ReplyAttemptState.RUNNING),
        )

    def test_only_explicit_continuation_loads_a_historical_candidate(self) -> None:
        first = self._save_first()
        self.assertIsNotNone(first.candidates)

        command = self._command(
            key=SECOND_REQUEST_KEY,
            direction="把选中的上一条改得更直接",
            continued_from_candidate_id=first.candidates[0].candidate_id,
        )
        started = self.store.start(command, self.verified_scope)

        self.assertEqual(started.state, ReplyRequestState.STARTED)
        self.assertIsNotNone(started.continued_candidate)
        self.assertEqual(
            started.continued_candidate.candidate_id,
            first.candidates[0].candidate_id,
        )

        ordinary = self.store.start(
            self._command(key=UUID("77777777-7777-7777-7777-777777777777")),
            self.verified_scope,
        )
        self.assertIsNone(ordinary.continued_candidate)

    def test_continuation_rechecks_contact_and_binding_scope(self) -> None:
        first = self._save_first()

        with self.assertRaises(ReplyContinuationError):
            self.store.start(
                self._command(
                    key=SECOND_REQUEST_KEY,
                    continued_from_candidate_id=first.candidates[0].candidate_id,
                    binding_id=OTHER_BINDING_ID,
                ),
                VerifiedConversationScope(OWNER_ID, CONTACT_ID, OTHER_BINDING_ID),
            )

        with self.assertRaises(ReplyContinuationError):
            self.store.start(
                self._command(
                    key=SECOND_REQUEST_KEY,
                    continued_from_candidate_id=first.candidates[0].candidate_id,
                    contact_id=OTHER_CONTACT_ID,
                ),
                VerifiedConversationScope(OWNER_ID, OTHER_CONTACT_ID, BINDING_ID),
            )

    def test_store_has_no_context_preparation_or_external_send_surface(self) -> None:
        self.assertFalse(hasattr(self.store, "prepare"))
        self.assertFalse(hasattr(self.store, "generate"))
        self.assertFalse(hasattr(self.store, "send"))


if __name__ == "__main__":
    unittest.main()
