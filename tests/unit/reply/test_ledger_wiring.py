"""候选回复外层接线出站台账的三态记录测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from uuid import uuid4

from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerOutcome
from notalone.reply.context import ContextEvidence, ReplyContext
from notalone.reply.errors import (
    ReplyInvariantError,
    ReplyRunError,
)
from notalone.reply.generator import ReplyGenerator
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.reply.runtime import (
    ReplyRuntimeResult,
    RuntimeCandidate,
    RuntimeUsage,
)
from notalone.scopes import ContactScope, VerifiedConversationScope

from tests.unit.reply.test_langchain_vertical_slice import (
    BINDING_ID,
    CONTACT_ID,
    EmptySkillPort,
    InMemoryReplyStore,
    MESSAGE_ID,
    OWNER_ID,
    REQUEST_ID,
    REQUEST_KEY,
    RecordingReplyContext,
    VERIFIED_SCOPE,
)

_SKILL_REVISION = 4


def _make_command() -> GenerateReply:
    return GenerateReply(
        idempotency_key=REQUEST_KEY,
        scope=ContactScope(OWNER_ID, CONTACT_ID),
        conversation_binding_id=BINDING_ID,
        content=RewriteDraft(draft_text="我明天有空，晚点见"),
    )


def _make_context(command: GenerateReply) -> ReplyContext:
    scope = ContactScope(OWNER_ID, CONTACT_ID)
    return ReplyContext(
        reply_request_id=REQUEST_ID,
        command=command,
        scope=scope,
        current_text="我明天有空，晚点见",
        direction=None,
        evidence=(
            ContextEvidence(
                evidence_id=MESSAGE_ID,
                kind="user_draft",
                text="我明天有空，晚点见",
                scope=scope,
            ),
        ),
        skill_library_revision=_SKILL_REVISION,
    )


class SuccessfulRuntime:
    """返回带用量信息的合法单候选。"""

    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:  # noqa: ARG002
        return ReplyRuntimeResult(
            candidates=(
                RuntimeCandidate(
                    text="我明天有空，晚点见。",
                    basis="保留原意润色",
                    citation_ids=(MESSAGE_ID,),
                    risk_notes=(),
                ),
            ),
            used_skill=None,
            usage=RuntimeUsage(
                provider="deepseek",
                model_name="ecnu-max",
                input_tokens=100,
                output_tokens=20,
            ),
        )


class FailingRuntime:
    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:  # noqa: ARG002
        raise RuntimeError("synthetic network failure")


class TimeoutRuntime:
    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:  # noqa: ARG002
        raise TimeoutError("synthetic provider timeout")


class MalformedOutputRuntime:
    """模拟运行时内部结构化输出解析失败抛出的不变量错误。"""

    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:  # noqa: ARG002
        raise ReplyInvariantError("模型未返回结构化候选。")


class InvalidOutputRuntime:
    """返回结构非法的候选，触发确定性校验拒绝。"""

    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:  # noqa: ARG002
        return ReplyRuntimeResult(candidates=(), used_skill=None)


def _generator(
    runtime: object,
    ledger: InMemoryOutboundLedger,
) -> ReplyGenerator:
    command = _make_command()
    return ReplyGenerator(
        store=InMemoryReplyStore(_make_context(command)),
        runtime=runtime,
        context=RecordingReplyContext(prepared=_make_context(command)),
        ledger=ledger,
    )


class LedgerWiringTest(unittest.TestCase):
    """只用合成数据；不发起外部模型调用。"""

    def setUp(self) -> None:
        self.ledger = InMemoryOutboundLedger()

    def test_success_records_succeeded_entry_with_usage(self) -> None:
        result = _generator(SuccessfulRuntime(), self.ledger).generate(
            _make_command(), verified_scope=VERIFIED_SCOPE
        )

        self.assertTrue(result.candidates)
        entries = self.ledger.list_by_owner(OWNER_ID)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry.outcome, LedgerOutcome.SUCCEEDED)
        self.assertEqual(entry.provider, "deepseek")
        self.assertEqual(entry.model_name, "ecnu-max")
        self.assertEqual(entry.input_tokens, 100)
        self.assertEqual(entry.output_tokens, 20)
        self.assertEqual(entry.contact_id, CONTACT_ID)
        self.assertGreaterEqual(entry.latency_ms, 0)
        self.assertIsInstance(entry.called_at, datetime)

    def test_runtime_failure_records_run_failed_and_reraises(self) -> None:
        with self.assertRaises(ReplyRunError):
            _generator(FailingRuntime(), self.ledger).generate(
                _make_command(), verified_scope=VERIFIED_SCOPE
            )

        entries = self.ledger.list_by_owner(OWNER_ID)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].outcome, LedgerOutcome.RUN_FAILED)

    def test_validation_rejection_records_rejected_entry(self) -> None:
        with self.assertRaises(ReplyInvariantError):
            _generator(InvalidOutputRuntime(), self.ledger).generate(
                _make_command(), verified_scope=VERIFIED_SCOPE
            )

        entries = self.ledger.list_by_owner(OWNER_ID)
        self.assertEqual(len(entries), 1)
        self.assertEqual(
            entries[0].outcome, LedgerOutcome.REJECTED_BY_VALIDATION
        )

    def test_timeout_maps_to_run_failed(self) -> None:
        with self.assertRaises(ReplyRunError):
            _generator(TimeoutRuntime(), self.ledger).generate(
                _make_command(), verified_scope=VERIFIED_SCOPE
            )

        entries = self.ledger.list_by_owner(OWNER_ID)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].outcome, LedgerOutcome.RUN_FAILED)

    def test_malformed_structured_output_counts_as_rejection(self) -> None:
        with self.assertRaises(ReplyInvariantError):
            _generator(MalformedOutputRuntime(), self.ledger).generate(
                _make_command(), verified_scope=VERIFIED_SCOPE
            )

        entries = self.ledger.list_by_owner(OWNER_ID)
        self.assertEqual(len(entries), 1)
        self.assertEqual(
            entries[0].outcome, LedgerOutcome.REJECTED_BY_VALIDATION
        )

    def test_replayed_request_does_not_record_new_entry(self) -> None:
        from notalone.reply.store import ReplyRequestState, ReplyStart

        command = _make_command()
        prepared = _make_context(command)

        class ReplayingStore(InMemoryReplyStore):
            def start(self, cmd: object, verified: object) -> ReplyStart:
                started = super().start(cmd, verified)
                return ReplyStart(
                    state=ReplyRequestState.REPLAYED,
                    request=started.request,
                    result=None,
                )

        generator = ReplyGenerator(
            store=ReplayingStore(prepared),
            runtime=SuccessfulRuntime(),
            context=RecordingReplyContext(prepared=prepared),
            ledger=self.ledger,
        )
        with self.assertRaises(ReplyInvariantError):
            generator.generate(command, verified_scope=VERIFIED_SCOPE)

        self.assertEqual(self.ledger.list_by_owner(OWNER_ID), ())

    def test_ledger_failure_fails_the_call(self) -> None:
        class BrokenLedger(InMemoryOutboundLedger):
            def record(self, entry: object) -> object:
                raise RuntimeError("synthetic ledger outage")

        with self.assertRaises(ReplyRunError):
            _generator(FailingRuntime(), BrokenLedger()).generate(
                _make_command(), verified_scope=VERIFIED_SCOPE
            )


if __name__ == "__main__":
    unittest.main()
