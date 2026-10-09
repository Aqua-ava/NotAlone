"""通过 ReplyGenerator public seam 验证候选回复行为。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from uuid import UUID

from notalone.reply import (
    ConfirmedDirection,
    ContextReceipt,
    DirectionSource,
    GenerateReply,
    ReplyCandidate,
    ReplyGenerated,
    ReplyGenerator,
    ReplyToMessage,
)
from notalone.reply.context import (
    ContextEvidence,
    ReplyContext,
    ToolCallTrace,
)
from notalone.reply.runtime import (
    ReplyRuntimeResult,
    RuntimeCandidate,
    RuntimeUsage,
)
from notalone.reply.store import (
    ReplyRequest,
    ReplyRequestState,
    ReplyStart,
    ValidatedReply,
)
from notalone.reply.errors import (
    ReplyContextError,
    ReplyInvariantError,
    ReplyPersistenceError,
    ReplyRunError,
)
from notalone.scopes import ContactScope, VerifiedConversationScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("22222222-2222-2222-2222-333333333333")
BINDING_ID = UUID("33333333-3333-3333-3333-333333333333")
VERIFIED_SCOPE = VerifiedConversationScope(
    OWNER_ID,
    CONTACT_ID,
    BINDING_ID,
)
MESSAGE_ID = UUID("44444444-4444-4444-4444-444444444444")
REQUEST_KEY = UUID("55555555-5555-5555-5555-555555555555")
REQUEST_ID = UUID("66666666-6666-6666-6666-666666666666")
CANDIDATE_ID = UUID("77777777-7777-7777-7777-777777777777")
UNKNOWN_EVIDENCE_ID = UUID("88888888-8888-8888-8888-888888888888")


@dataclass
class RecordingReplyStore:
    prepared: ReplyContext
    saved: ValidatedReply | None = None
    saved_context: ReplyContext | None = None

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart:
        request = ReplyRequest(
            request_id=self.prepared.reply_request_id,
            idempotency_key=command.idempotency_key,
            normalized_input="synthetic-input",
            scope=command.scope,
            conversation_binding_id=verified_scope.conversation_binding_id,
            attempt=1,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            continued_from_candidate_id=command.continued_from_candidate_id,
        )
        return ReplyStart(state=ReplyRequestState.STARTED, request=request)

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        if request.request_id != context.reply_request_id:
            raise AssertionError("unexpected synthetic request")
        self.saved = reply
        self.saved_context = context
        return ReplyGenerated(
            reply_request_id=context.reply_request_id,
            candidates=(
                ReplyCandidate(
                    candidate_id=CANDIDATE_ID,
                    text=reply.candidates[0].text,
                    basis=reply.candidates[0].basis,
                    citation_ids=reply.candidates[0].citation_ids,
                    risk_notes=reply.candidates[0].risk_notes,
                ),
            ),
            context_receipt=ContextReceipt(
                evidence_ids=tuple(
                    evidence_id
                    for candidate in reply.candidates
                    for evidence_id in candidate.citation_ids
                ),
            ),
            used_skill=reply.used_skill,
        )

    def fail(self, request: ReplyRequest, *, reason: str) -> None:
        del request, reason


@dataclass
class FailingFailReplyStore(RecordingReplyStore):
    """fail() 自身出错，用于验证标记失败不会静默。"""

    def fail(self, request: ReplyRequest, *, reason: str) -> None:
        raise RuntimeError("synthetic fail() outage")


@dataclass
class CorruptingReplyStore(RecordingReplyStore):
    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        persisted = super().save(request, context, reply)
        corrupted = replace(persisted.candidates[0], text="被 Store 篡改的候选")
        return replace(persisted, candidates=(corrupted,))


@dataclass
class ExplodingReplyStore(RecordingReplyStore):
    fail_during: str = "start"

    def start(
        self,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
    ) -> ReplyStart:
        if self.fail_during == "start":
            raise RuntimeError("postgresql://private-credential")
        return super().start(command, verified_scope)

    def save(
        self,
        request: ReplyRequest,
        context: ReplyContext,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        if self.fail_during == "save":
            raise RuntimeError("private persisted candidate body")
        return super().save(request, context, reply)


@dataclass
class ScriptedReplyRuntime:
    result: ReplyRuntimeResult
    received: ReplyContext | None = None

    def generate(self, prepared: ReplyContext) -> ReplyRuntimeResult:
        self.received = prepared
        return self.result


class ExplodingReplyRuntime:
    def generate(self, prepared: ReplyContext) -> ReplyRuntimeResult:
        del prepared
        raise RuntimeError("private provider response")


@dataclass
class RecordingReplyContext:
    prepared: ReplyContext
    calls: int = 0

    def build(
        self,
        *,
        command: GenerateReply,
        verified_scope: VerifiedConversationScope,
        reply_request_id: UUID | None = None,
        continued_candidate: object | None = None,
    ) -> ReplyContext:
        del command, verified_scope, reply_request_id, continued_candidate
        self.calls += 1
        return self.prepared


@dataclass
class FreshnessRecordingContext(RecordingReplyContext):
    freshness_calls: int = 0
    fail_on_call: int | None = None

    def validate_current(self, context: ReplyContext) -> None:
        if context != self.prepared:
            raise AssertionError("unexpected context for freshness validation")
        self.freshness_calls += 1
        if self.fail_on_call == self.freshness_calls:
            raise ReplyInvariantError("合成来源已失效")


class ReplyGeneratorTest(unittest.TestCase):
    @staticmethod
    def _generator(
        *,
        store: RecordingReplyStore,
        runtime: object,
        prepared: ReplyContext,
    ) -> ReplyGenerator:
        return ReplyGenerator(
            store=store,
            runtime=runtime,
            context=RecordingReplyContext(prepared=prepared),
        )

    def _valid_case(self) -> tuple[GenerateReply, ReplyContext]:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        return command, ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="合成消息",
            direction=direction,
            evidence=(ContextEvidence(MESSAGE_ID, "message", "合成消息", scope),),
            skill_library_revision=1,
        )

    def test_generates_and_persists_candidate_for_confirmed_contact(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="想答应，但不要显得太主动",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(
                target_message_id=MESSAGE_ID,
                direction=direction,
            ),
        )
        evidence = ContextEvidence(
            evidence_id=MESSAGE_ID,
            kind="message",
            text="明天一起吃饭吗？",
            scope=scope,
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="明天一起吃饭吗？",
            direction=direction,
            evidence=(evidence,),
            skill_library_revision=3,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="可以呀，明天见。",
                        basis="回应邀请并保持自然",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        result = self._generator(
            store=store,
            runtime=runtime,
            prepared=prepared,
        ).generate(
            command,
            verified_scope=VERIFIED_SCOPE,
        )

        self.assertIsInstance(result, ReplyGenerated)
        self.assertEqual(result.reply_request_id, REQUEST_ID)
        self.assertEqual(result.candidates[0].text, "可以呀，明天见。")
        self.assertEqual(result.context_receipt.evidence_ids, (MESSAGE_ID,))
        self.assertIs(runtime.received, prepared)
        self.assertIsNotNone(store.saved)

    def test_explicit_context_is_used_without_store_preparation(self) -> None:
        command, prepared = self._valid_case()
        context = RecordingReplyContext(prepared=prepared)
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="可以呀。",
                        basis="回应合成消息",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        result = ReplyGenerator(
            store=store,
            runtime=runtime,
            context=context,
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertEqual(context.calls, 1)
        self.assertEqual(result.candidates[0].text, "可以呀。")

    def test_revalidates_context_before_and_after_runtime(self) -> None:
        command, prepared = self._valid_case()
        context = FreshnessRecordingContext(prepared=prepared)
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="可以呀。",
                        basis="回应当前消息",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        result = ReplyGenerator(
            store=store,
            runtime=runtime,
            context=context,
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertEqual(result.candidates[0].text, "可以呀。")
        self.assertEqual(context.freshness_calls, 2)

    def test_rejects_context_that_becomes_stale_after_model_run(self) -> None:
        command, prepared = self._valid_case()
        context = FreshnessRecordingContext(prepared=prepared, fail_on_call=2)
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="不应展示",
                        basis="来源已被删除",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=store,
                runtime=runtime,
                context=context,
            ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertIsNone(store.saved)

    def test_rejects_deleted_evidence_before_model_run(self) -> None:
        command, prepared = self._valid_case()
        deleted = replace(
            prepared,
            evidence=(replace(prepared.evidence[0], status="deleted"),),
        )
        store = RecordingReplyStore(prepared=deleted)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="不应展示",
                        basis="已删除依据",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            ReplyGenerator(
                store=store,
                runtime=runtime,
                context=RecordingReplyContext(prepared=deleted),
            ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertIsNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_tool_evidence_is_merged_into_the_same_reply_snapshot(self) -> None:
        command, prepared = self._valid_case()
        historical_id = UNKNOWN_EVIDENCE_ID
        historical = ContextEvidence(
            evidence_id=historical_id,
            kind="message",
            text="很久以前的合成历史",
            scope=prepared.scope,
            source_ids=(historical_id,),
            selection_reason="本轮 conversation_search 命中。",
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="记得那次安排，我们可以再确认一下。",
                        basis="使用本轮搜索到的历史证据",
                        citation_ids=(historical_id,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
                additional_evidence=(historical,),
                tool_calls=(
                    ToolCallTrace(
                        tool_name="conversation_search",
                        status="succeeded",
                        evidence_ids=(historical_id,),
                        latency_ms=1,
                    ),
                ),
            )
        )

        result = self._generator(
            store=store,
            runtime=runtime,
            prepared=prepared,
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertEqual(
            result.context_receipt.evidence_ids,
            (historical_id,),
        )
        assert store.saved_context is not None
        self.assertEqual(
            tuple(item.evidence_id for item in store.saved_context.evidence),
            (MESSAGE_ID, historical_id),
        )
        self.assertEqual(
            store.saved_context.tool_calls[0].tool_name,
            "conversation_search",
        )

    def test_rejects_cross_contact_preparation_before_model_run(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        other_scope = ContactScope(
            owner_id=OWNER_ID,
            contact_id=OTHER_CONTACT_ID,
        )
        direction = ConfirmedDirection(
            text="礼貌拒绝",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        malicious_command = replace(command, scope=other_scope)
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=malicious_command,
            scope=other_scope,
            current_text="另一位联系人的合成消息",
            direction=direction,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    kind="message",
                    text="另一位联系人的合成消息",
                    scope=other_scope,
                ),
            ),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="不应该生成",
                        basis="越界数据",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_rejects_cross_contact_evidence_before_model_run(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        other_scope = ContactScope(
            owner_id=OWNER_ID,
            contact_id=OTHER_CONTACT_ID,
        )
        direction = ConfirmedDirection(
            text="礼貌拒绝",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="另一位联系人的合成消息",
            direction=direction,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    scope=other_scope,
                    kind="message",
                    text="另一位联系人的合成消息",
                ),
            ),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="不应该生成",
                        basis="越界数据",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_rejects_previous_candidate_from_another_contact(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        other_scope = ContactScope(
            owner_id=OWNER_ID,
            contact_id=OTHER_CONTACT_ID,
        )
        direction = ConfirmedDirection(
            text="把上一条改得更直接",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
            continued_from_candidate_id=CANDIDATE_ID,
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="合成消息",
            direction=direction,
            evidence=(
                ContextEvidence(MESSAGE_ID, "message", "合成消息", scope),
                ContextEvidence(
                    CANDIDATE_ID,
                    "continued_candidate",
                    "另一联系人的未发送候选",
                    other_scope,
                ),
            ),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="不应该生成",
                        basis="越界旧候选",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_rejects_candidate_with_reference_outside_context_snapshot(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="明天一起吃饭吗？",
            direction=direction,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    kind="message",
                    text="明天一起吃饭吗？",
                    scope=scope,
                ),
            ),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="好呀，明天见。",
                        basis="引用了不存在的依据",
                        citation_ids=(UNKNOWN_EVIDENCE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNotNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_rejects_empty_candidate_set_before_persistence(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="明天一起吃饭吗？",
            direction=direction,
            evidence=(
                ContextEvidence(MESSAGE_ID, "message", "明天一起吃饭吗？", scope),
            ),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(candidates=(), used_skill=None)
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(store.saved)

    def test_rejects_malformed_candidate_without_leaking_type_error(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="自然地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="合成消息",
            direction=direction,
            evidence=(ContextEvidence(MESSAGE_ID, "message", "合成消息", scope),),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text=cast(Any, 42),
                        basis="无效类型",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(store.saved)

    def test_rejects_malformed_usage_without_leaking_attribute_error(self) -> None:
        command, prepared = self._valid_case()
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="可以呀。",
                        basis="合成依据",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
                usage=cast(
                    Any,
                    RuntimeUsage(
                        provider="deepseek",
                        model_name="deepseek-chat",
                        input_tokens=-1,
                    ),
                ),
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertIsNone(store.saved)

    def test_accepts_pending_candidate_evidence_cited_by_candidate(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="先问清楚是不是真的要换工作",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        message_evidence = ContextEvidence(
            evidence_id=MESSAGE_ID,
            kind="message",
            text="他下个月准备换工作吗？",
            scope=scope,
        )
        pending_evidence = ContextEvidence(
            evidence_id=CANDIDATE_ID,
            kind="pending_candidate",
            text="对方下个月准备换工作",
            scope=scope,
            source_ids=(MESSAGE_ID,),
            selection_reason="未确认候选、仅供参考、不得当作事实。",
            status="pending",
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="他下个月准备换工作吗？",
            direction=direction,
            evidence=(message_evidence, pending_evidence),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="听说你下个月要换工作，是真的吗？",
                        basis="对未确认候选只做确认式提问",
                        citation_ids=(MESSAGE_ID, CANDIDATE_ID),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        result = self._generator(
            store=store,
            runtime=runtime,
            prepared=prepared,
        ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertEqual(
            result.context_receipt.evidence_ids,
            (MESSAGE_ID, CANDIDATE_ID),
        )
        self.assertIsNotNone(store.saved)

    def test_rejects_pending_candidate_evidence_with_non_pending_status(self) -> None:
        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="关心一下近况",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="他下个月准备换工作吗？",
            direction=direction,
            evidence=(
                ContextEvidence(MESSAGE_ID, "message", "他下个月准备换工作吗？", scope),
                ContextEvidence(
                    CANDIDATE_ID,
                    "pending_candidate",
                    "对方下个月准备换工作",
                    scope,
                    source_ids=(MESSAGE_ID,),
                    selection_reason="假装已经确认",
                    status="active",
                ),
            ),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="你下个月要换工作了吧。",
                        basis="错误地把候选当成事实",
                        citation_ids=(CANDIDATE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        # 待确认轨只允许 pending 状态；active 说明适配器把它当成了已确认资料。
        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_rejects_pending_candidate_evidence_with_forged_annotation(self) -> None:
        """状态是 pending、理由写成「已确认」的伪造标注不能进入模型或落库。"""

        scope = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)
        direction = ConfirmedDirection(
            text="先问清楚是不是真的要换工作",
            source=DirectionSource.DIRECT_INPUT,
        )
        command = GenerateReply(
            idempotency_key=REQUEST_KEY,
            scope=scope,
            conversation_binding_id=BINDING_ID,
            content=ReplyToMessage(MESSAGE_ID, direction),
        )
        prepared = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="他下个月准备换工作吗？",
            direction=direction,
            evidence=(
                ContextEvidence(MESSAGE_ID, "message", "他下个月准备换工作吗？", scope),
                ContextEvidence(
                    CANDIDATE_ID,
                    "pending_candidate",
                    "对方下个月准备换工作",
                    scope,
                    source_ids=(MESSAGE_ID,),
                    selection_reason="已确认、可以当作事实。",
                    status="pending",
                ),
            ),
            skill_library_revision=1,
        )
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="你下个月要换工作了吧。",
                        basis="错误地把候选当成事实",
                        citation_ids=(CANDIDATE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        # 强制未确认标注是可校验契约：pending 状态不能抵消被改写的理由。
        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(runtime.received)
        self.assertIsNone(store.saved)

    def test_rejects_candidate_without_any_citation(self) -> None:
        command, prepared = self._valid_case()
        store = RecordingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="可以呀。",
                        basis="声称有依据但没有引用",
                        citation_ids=(),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertIsNone(store.saved)

    def test_rejects_candidate_modified_by_persistence_adapter(self) -> None:
        command, prepared = self._valid_case()
        store = CorruptingReplyStore(prepared=prepared)
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="可以呀。",
                        basis="回应当前消息",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyInvariantError):
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

    def test_store_failure_marking_emits_warning_without_changing_error(self) -> None:
        command, prepared = self._valid_case()
        store = FailingFailReplyStore(prepared=prepared)
        runtime = ExplodingReplyRuntime()

        with self.assertLogs("notalone.reply.generator", level="WARNING") as logs:
            with self.assertRaises(ReplyRunError) as caught:
                ReplyGenerator(
                    store=store,
                    runtime=runtime,
                    context=RecordingReplyContext(prepared=prepared),
                ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertIn("标记失败", "\n".join(logs.output))
        self.assertNotIn("private provider response", str(caught.exception))

    def test_hides_store_start_error_details(self) -> None:
        command, prepared = self._valid_case()
        store = ExplodingReplyStore(prepared=prepared, fail_during="start")

        with self.assertRaises(ReplyPersistenceError) as caught:
            ReplyGenerator(
                store=store,
                runtime=ExplodingReplyRuntime(),
                context=RecordingReplyContext(prepared=prepared),
            ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertNotIn("private-credential", str(caught.exception))

    def test_hides_model_error_details(self) -> None:
        command, prepared = self._valid_case()
        store = RecordingReplyStore(prepared=prepared)

        with self.assertRaises(ReplyRunError) as caught:
            ReplyGenerator(
                store=store,
                runtime=ExplodingReplyRuntime(),
                context=RecordingReplyContext(prepared=prepared),
            ).generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertNotIn("private provider response", str(caught.exception))
        self.assertIsNone(store.saved)

    def test_hides_save_error_details(self) -> None:
        command, prepared = self._valid_case()
        store = ExplodingReplyStore(prepared=prepared, fail_during="save")
        runtime = ScriptedReplyRuntime(
            result=ReplyRuntimeResult(
                candidates=(
                    RuntimeCandidate(
                        text="可以呀。",
                        basis="回应当前消息",
                        citation_ids=(MESSAGE_ID,),
                        risk_notes=(),
                    ),
                ),
                used_skill=None,
            )
        )

        with self.assertRaises(ReplyPersistenceError) as caught:
            self._generator(
                store=store,
                runtime=runtime,
                prepared=prepared,
            ).generate(
                command,
                verified_scope=VERIFIED_SCOPE,
            )

        self.assertNotIn("private persisted", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
