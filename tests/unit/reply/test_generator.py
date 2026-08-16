"""通过 ReplyGenerator public seam 验证候选回复行为。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass, replace
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
from notalone.reply.contracts import (
    ContextEvidence,
    PreparedReply,
    PreviousUnsentCandidate,
    ReplyRuntimeResult,
    RuntimeCandidate,
    ValidatedReply,
)
from notalone.reply.errors import (
    ReplyInvariantError,
    ReplyPersistenceError,
    ReplyRunError,
)
from notalone.scopes import ContactScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("22222222-2222-2222-2222-333333333333")
BINDING_ID = UUID("33333333-3333-3333-3333-333333333333")
MESSAGE_ID = UUID("44444444-4444-4444-4444-444444444444")
REQUEST_KEY = UUID("55555555-5555-5555-5555-555555555555")
REQUEST_ID = UUID("66666666-6666-6666-6666-666666666666")
CANDIDATE_ID = UUID("77777777-7777-7777-7777-777777777777")
UNKNOWN_EVIDENCE_ID = UUID("88888888-8888-8888-8888-888888888888")


@dataclass
class RecordingReplyStore:
    prepared: PreparedReply
    saved: ValidatedReply | None = None

    def prepare(self, command: GenerateReply) -> PreparedReply:
        del command
        return self.prepared

    def save(
        self,
        prepared: PreparedReply,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        self.saved = reply
        candidate = reply.candidates[0]
        return ReplyGenerated(
            reply_request_id=prepared.reply_request_id,
            candidates=(
                ReplyCandidate(
                    candidate_id=CANDIDATE_ID,
                    text=candidate.text,
                    basis=candidate.basis,
                    citation_ids=candidate.citation_ids,
                    risk_notes=candidate.risk_notes,
                ),
            ),
            context_receipt=ContextReceipt(
                evidence_ids=tuple(item.evidence_id for item in prepared.evidence),
            ),
            used_skill=reply.used_skill,
        )


@dataclass
class CorruptingReplyStore(RecordingReplyStore):
    def save(
        self,
        prepared: PreparedReply,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        persisted = super().save(prepared, reply)
        corrupted = replace(persisted.candidates[0], text="被 Store 篡改的候选")
        return replace(persisted, candidates=(corrupted,))


@dataclass
class ExplodingReplyStore(RecordingReplyStore):
    fail_during: str = "prepare"

    def prepare(self, command: GenerateReply) -> PreparedReply:
        if self.fail_during == "prepare":
            raise RuntimeError("postgresql://private-credential")
        return super().prepare(command)

    def save(
        self,
        prepared: PreparedReply,
        reply: ValidatedReply,
    ) -> ReplyGenerated:
        if self.fail_during == "save":
            raise RuntimeError("private persisted candidate body")
        return super().save(prepared, reply)


@dataclass
class ScriptedReplyRuntime:
    result: ReplyRuntimeResult
    received: PreparedReply | None = None

    def generate(self, prepared: PreparedReply) -> ReplyRuntimeResult:
        self.received = prepared
        return self.result


class ExplodingReplyRuntime:
    def generate(self, prepared: PreparedReply) -> ReplyRuntimeResult:
        del prepared
        raise RuntimeError("private provider response")


class ReplyGeneratorTest(unittest.TestCase):
    def _valid_case(self) -> tuple[GenerateReply, PreparedReply]:
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
        return command, PreparedReply(
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
        prepared = PreparedReply(
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

        result = ReplyGenerator(store=store, runtime=runtime).generate(command)

        self.assertIsInstance(result, ReplyGenerated)
        self.assertEqual(result.reply_request_id, REQUEST_ID)
        self.assertEqual(result.candidates[0].text, "可以呀，明天见。")
        self.assertEqual(result.context_receipt.evidence_ids, (MESSAGE_ID,))
        self.assertIs(runtime.received, prepared)
        self.assertIsNotNone(store.saved)

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
        prepared = PreparedReply(
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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

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
        prepared = PreparedReply(
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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

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
        )
        prepared = PreparedReply(
            reply_request_id=REQUEST_ID,
            command=command,
            scope=scope,
            current_text="合成消息",
            direction=direction,
            evidence=(ContextEvidence(MESSAGE_ID, "message", "合成消息", scope),),
            skill_library_revision=1,
            previous_unsent_candidates=(
                PreviousUnsentCandidate(
                    candidate_id=CANDIDATE_ID,
                    scope=other_scope,
                    conversation_binding_id=BINDING_ID,
                    text="另一联系人的未发送候选",
                ),
            ),
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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

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
        prepared = PreparedReply(
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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

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
        prepared = PreparedReply(
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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

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
        prepared = PreparedReply(
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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

    def test_hides_prepare_error_details(self) -> None:
        command, prepared = self._valid_case()
        store = ExplodingReplyStore(prepared=prepared, fail_during="prepare")

        with self.assertRaises(ReplyPersistenceError) as caught:
            ReplyGenerator(
                store=store,
                runtime=ExplodingReplyRuntime(),
            ).generate(command)

        self.assertNotIn("private-credential", str(caught.exception))

    def test_hides_model_error_details(self) -> None:
        command, prepared = self._valid_case()
        store = RecordingReplyStore(prepared=prepared)

        with self.assertRaises(ReplyRunError) as caught:
            ReplyGenerator(
                store=store,
                runtime=ExplodingReplyRuntime(),
            ).generate(command)

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
            ReplyGenerator(store=store, runtime=runtime).generate(command)

        self.assertNotIn("private persisted", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
