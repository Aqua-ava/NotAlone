"""通过统一 Reply seam 验证回复和改写两种输入。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from notalone.application import CandidateReplyFlow
from notalone.conversation import (
    ConversationResolution,
)
from notalone.reply import (
    ContextReceipt,
    GenerateReply,
    ReplyCandidate,
    ReplyGenerated,
    ReplyGenerator,
    RewriteDraft,
)
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import ReplyInvariantError
from notalone.reply.runtime import ReplyRuntimeResult, RuntimeCandidate
from notalone.reply.store import (
    ReplyRequest,
    ReplyRequestState,
    ReplyStart,
    ValidatedReply,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
BINDING_ID = UUID("cccccccc-3333-3333-3333-333333333333")
DRAFT_EVIDENCE_ID = UUID("dddddddd-4444-4444-4444-444444444444")
REQUEST_KEY = UUID("eeeeeeee-5555-5555-5555-555555555555")
REQUEST_ID = UUID("ffffffff-6666-6666-6666-666666666666")
CANDIDATE_ID = UUID("11111111-7777-7777-7777-777777777777")


@dataclass
class RecordingReplyStore:
    prepared: ReplyContext
    saved: ValidatedReply | None = None

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart:
        if command != self.prepared.command:
            raise AssertionError("unexpected synthetic command")
        return ReplyStart(
            state=ReplyRequestState.STARTED,
            request=ReplyRequest(
                request_id=self.prepared.reply_request_id,
                idempotency_key=command.idempotency_key,
                normalized_input="synthetic-input",
                scope=self.prepared.scope,
                conversation_binding_id=verified_scope.conversation_binding_id,
                attempt=1,
                lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=1),
                continued_from_candidate_id=command.continued_from_candidate_id,
            ),
        )

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        if request.request_id != context.reply_request_id:
            raise AssertionError("unexpected synthetic request")
        self.saved = reply
        return ReplyGenerated(
            reply_request_id=context.reply_request_id,
            candidates=tuple(
                ReplyCandidate(
                    candidate_id=CANDIDATE_ID,
                    text=candidate.text,
                    basis=candidate.basis,
                    citation_ids=candidate.citation_ids,
                    risk_notes=candidate.risk_notes,
                )
                for candidate in reply.candidates
            ),
            context_receipt=ContextReceipt(
                evidence_ids=tuple(
                    citation_id
                    for candidate in reply.candidates
                    for citation_id in candidate.citation_ids
                ),
            ),
            used_skill=reply.used_skill,
        )

    def fail(self, request: ReplyRequest, *, reason: str) -> None:
        del request, reason


@dataclass
class RecordingReplyRuntime:
    received: ReplyContext | None = None

    def generate(self, prepared: ReplyContext) -> ReplyRuntimeResult:
        self.received = prepared
        return ReplyRuntimeResult(
            candidates=(
                RuntimeCandidate(
                    text="我明天有空，晚点见。",
                    basis="保留草稿原意并做基础润色",
                    citation_ids=(DRAFT_EVIDENCE_ID,),
                    risk_notes=(),
                ),
            ),
            used_skill=None,
        )


@dataclass
class RecordingReplyContext:
    prepared: ReplyContext

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        reply_request_id: UUID | None = None,
        continued_candidate: object | None = None,
    ) -> ReplyContext:
        del command, verified_scope, reply_request_id, continued_candidate
        return self.prepared


class UnifiedReplyInputTest(unittest.TestCase):
    @staticmethod
    def _verified_scope() -> VerifiedConversationScope:
        return VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID)

    def _rewrite_command(self) -> tuple[GenerateReply, ReplyContext]:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = RewriteDraft(
            draft_text="我明天有空，晚点见",
            user_instruction="更自然一点",
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=content,
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text=content.draft_text,
            direction=None,
            evidence=(
                ContextEvidence(
                    evidence_id=DRAFT_EVIDENCE_ID,
                    kind="user_draft",
                    text=content.draft_text,
                    scope=scope,
                ),
            ),
            skill_library_revision=1,
        )
        return command, prepared

    def test_rewrite_draft_is_generated_and_saved_through_same_reply_entry(
        self,
    ) -> None:
        command, prepared = self._rewrite_command()
        store = RecordingReplyStore(prepared=prepared)
        runtime = RecordingReplyRuntime()

        result = ReplyGenerator(
            store=store,
            runtime=runtime,
            context=RecordingReplyContext(prepared=prepared),
        ).generate(
            command,
            verified_scope=self._verified_scope(),
        )

        self.assertEqual(result.candidates[0].text, "我明天有空，晚点见。")
        self.assertIs(runtime.received, prepared)
        self.assertEqual(runtime.received.command.content, command.content)
        self.assertEqual(result.context_receipt.evidence_ids, (DRAFT_EVIDENCE_ID,))
        self.assertIsNotNone(store.saved)

    def test_rewrite_instruction_is_request_data_not_a_long_term_preference(
        self,
    ) -> None:
        command, prepared = self._rewrite_command()
        runtime = RecordingReplyRuntime()

        ReplyGenerator(
            store=RecordingReplyStore(prepared=prepared),
            runtime=runtime,
            context=RecordingReplyContext(prepared=prepared),
        ).generate(command, verified_scope=self._verified_scope())

        self.assertIsInstance(runtime.received.command.content, RewriteDraft)
        self.assertEqual(
            runtime.received.command.content.user_instruction,
            "更自然一点",
        )

    def test_rewrite_without_instruction_is_valid_basic_polish_request(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = RewriteDraft(draft_text="我明天有空，晚点见")
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=content,
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text=content.draft_text,
            direction=None,
            evidence=(
                ContextEvidence(
                    evidence_id=DRAFT_EVIDENCE_ID,
                    kind="user_draft",
                    text=content.draft_text,
                    scope=scope,
                ),
            ),
            skill_library_revision=1,
        )

        result = ReplyGenerator(
            store=RecordingReplyStore(prepared=prepared),
            runtime=RecordingReplyRuntime(),
            context=RecordingReplyContext(prepared=prepared),
        ).generate(command, verified_scope=self._verified_scope())

        self.assertEqual(result.candidates[0].citation_ids, (DRAFT_EVIDENCE_ID,))
        self.assertIsNone(content.user_instruction)

    def test_default_rewrite_rejects_unrequested_long_term_memory(self) -> None:
        command, prepared = self._rewrite_command()
        command = GenerateReply(
            idempotency_key=command.idempotency_key,
            scope=command.scope,
            conversation_binding_id=command.conversation_binding_id,
            content=RewriteDraft(draft_text=command.content.draft_text),
        )
        prepared = ReplyContext(
            reply_request_id=prepared.reply_request_id,
            command=command,
            scope=prepared.scope,
            current_text=prepared.current_text,
            direction=None,
            evidence=prepared.evidence
            + (
                ContextEvidence(
                    evidence_id=UUID("12121212-8888-8888-8888-888888888888"),
                    kind="confirmed_memory",
                    text="联系人喜欢旅行",
                    scope=prepared.scope,
                ),
            ),
            skill_library_revision=prepared.skill_library_revision,
        )
        runtime = RecordingReplyRuntime()

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=RecordingReplyStore(prepared=prepared),
                runtime=runtime,
                context=RecordingReplyContext(prepared=prepared),
            ).generate(command, verified_scope=self._verified_scope())

        self.assertIsNone(runtime.received)

    def test_explicit_rewrite_background_can_reach_runtime_once(self) -> None:
        command, prepared = self._rewrite_command()
        content = RewriteDraft(
            draft_text=command.content.draft_text,
            include_relationship_context=True,
        )
        command = GenerateReply(
            idempotency_key=command.idempotency_key,
            scope=command.scope,
            conversation_binding_id=command.conversation_binding_id,
            content=content,
        )
        prepared = ReplyContext(
            reply_request_id=prepared.reply_request_id,
            command=command,
            scope=prepared.scope,
            current_text=prepared.current_text,
            direction=None,
            evidence=prepared.evidence
            + (
                ContextEvidence(
                    evidence_id=UUID("12121212-8888-8888-8888-888888888888"),
                    kind="confirmed_memory",
                    text="联系人喜欢旅行",
                    scope=prepared.scope,
                ),
            ),
            skill_library_revision=prepared.skill_library_revision,
        )
        runtime = RecordingReplyRuntime()

        result = ReplyGenerator(
            store=RecordingReplyStore(prepared=prepared),
            runtime=runtime,
            context=RecordingReplyContext(prepared=prepared),
        ).generate(command, verified_scope=self._verified_scope())

        self.assertEqual(result.candidates[0].text, "我明天有空，晚点见。")
        self.assertIsNotNone(runtime.received)

    def test_reply_rejects_scope_mismatch_before_context_or_runtime(self) -> None:
        command, prepared = self._rewrite_command()
        store = RecordingReplyStore(prepared=prepared)
        runtime = RecordingReplyRuntime()
        wrong_scope = VerifiedConversationScope(
            OWNER_ID,
            UUID("bbbbbbbb-2222-2222-2222-333333333333"),
            BINDING_ID,
        )

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=store,
                runtime=runtime,
                context=RecordingReplyContext(prepared=prepared),
            ).generate(
                command,
                verified_scope=wrong_scope,
            )

        self.assertIsNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_application_flow_accepts_rewrite_draft_after_scope_verification(
        self,
    ) -> None:
        from dataclasses import dataclass

        @dataclass
        class RecordingReplyPort:
            calls: int = 0
            command: GenerateReply | None = None
            outcome: object = "合成候选"

            def generate(
                self,
                *,
                command: GenerateReply,
                verified_scope: VerifiedConversationScope,
            ) -> object:
                self.calls += 1
                self.command = command
                del verified_scope
                return self.outcome

        command, _ = self._rewrite_command()
        conversation = ConversationResolution.ready(
            VerifiedConversationScope(OWNER_ID, CONTACT_ID, BINDING_ID),
        )

        class RecordingConversation:
            def verify_current(self) -> ConversationResolution:
                return conversation

        reply = RecordingReplyPort()
        result = CandidateReplyFlow(
            conversation=RecordingConversation(),
        ).execute(reply=reply, command=command)

        self.assertEqual(result.reply, "合成候选")
        self.assertEqual(reply.calls, 1)
        self.assertIs(reply.command, command)

    def test_rewrite_draft_rejects_empty_text(self) -> None:
        with self.assertRaises((TypeError, ValueError)):
            RewriteDraft(draft_text=" ")

    def test_rewrite_instruction_rejects_blank_text(self) -> None:
        with self.assertRaises((TypeError, ValueError)):
            RewriteDraft(draft_text="我有空", user_instruction=" ")


if __name__ == "__main__":
    unittest.main()
