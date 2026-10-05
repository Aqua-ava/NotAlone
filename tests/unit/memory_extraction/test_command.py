"""提取命令核心逻辑测试：分批、水位续跑与统计聚合。"""

from __future__ import annotations

import unittest
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

from langchain_core.messages import AIMessage

from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerOutcome
from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory.models import (
    AdoptionMethod,
    ConfirmedMemory,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.command import (
    extract_main,
    memory_add_main,
    memory_delete_main,
    memory_list_main,
    run_extraction,
)
from notalone.memory_extraction.dimensions import RELEASE_ALL_DIMENSIONS
from notalone.memory_extraction.errors import (
    ExtractionInvalidOutputError,
    ExtractionRuntimeError,
)
from notalone.memory_extraction.models import (
    ExtractionFailureKind,
    MessageRef,
    MessageSender,
)
from notalone.memory_extraction.recovery import (
    ExtractionFailureState,
    FailureRange,
)
from notalone.memory_extraction.verification_adapters import (
    LangChainSourceVerificationRuntime,
)
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.verification_helpers import (
    FixedSourceVerifier,
    SyntheticSupportingVerifier,
    verification_result,
)
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")


def _messages(count: int):
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    return tuple(
        MessageRef(
            message_id=uuid4(),
            text=f"合成消息 {index}",
            sender=MessageSender.CONTACT,
            occurred_at=base + timedelta(minutes=index),
        )
        for index in range(count)
    )


class NullRuntime:
    """返回空候选（不产出事实）的确定性运行时。"""

    def extract(self, window: object) -> tuple:
        return ()


class FailingRuntime:
    def extract(self, window: object) -> tuple:
        raise ExtractionRuntimeError("模型调用失败，未生成记忆。")


class InvalidOutputRuntime:
    def extract(self, window: object) -> tuple:
        raise ExtractionInvalidOutputError("模型未返回可解析的结构化事实。")


class UnavailableRuntime:
    def extract(self, window: object) -> tuple:
        raise ExtractionRuntimeError("模型调用失败，未生成记忆。")


class ScriptedRuntime:
    """按序抛出预置失败或返回空候选。"""

    def __init__(self, outcomes: list[object]) -> None:
        self.outcomes = list(outcomes)

    def extract(self, window: object) -> tuple:
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return ()


class RecordingWindowRuntime(NullRuntime):
    def __init__(self) -> None:
        self.windows = []

    def extract(self, window: object) -> tuple:
        self.windows.append(window)
        return ()


def _payload(message_id: UUID) -> dict:
    return {
        "text": "他习惯直接打电话沟通",
        "category": "common_fact",
        "subject": "contact",
        "topic": "other",
        "source_message_ids": [str(message_id)],
        "confidence": 0.9,
        "risk_flags": [],
        "valid_at": None,
        "invalid_at": None,
        "speech_act": "assertion",
        "assertion_status": "asserted",
        "figurative_type": "literal",
        "alternatives": [],
        "interpretation_reason": "消息以确定语气表达一个关系主张。",
    }


class PayloadRuntime:
    """按窗口目标消息返回一条可自动采纳的事实。"""

    def __init__(self, **overrides: object) -> None:
        self.overrides = overrides

    def extract(self, window) -> tuple:
        message_id = (
            window.target_message_ids[0]
            if window.target_message_ids
            else window.messages[0].message_id
        )
        return ({**_payload(message_id), **self.overrides},)


class SyntheticCallClock:
    """确定性推进模型调用时间，不等待真实时钟。"""

    def __init__(self) -> None:
        self.origin = datetime(2026, 10, 2, tzinfo=timezone.utc)
        self.elapsed_seconds = 0.0

    def perf_counter(self) -> float:
        return self.elapsed_seconds

    def now(self, tz) -> datetime:
        return self.origin + timedelta(seconds=self.elapsed_seconds)


class TimedPayloadRuntime(PayloadRuntime):
    """合成首次提取固定耗时，允许模拟供应商失败。"""

    def __init__(self, clock: SyntheticCallClock, error: Exception | None = None) -> None:
        super().__init__()
        self.clock = clock
        self.error = error

    def extract(self, window) -> tuple:
        self.clock.elapsed_seconds += 2.0
        if self.error is not None:
            raise self.error
        return super().extract(window)


class TimedVerificationModel:
    """有独立耗时的外部模型替身，不执行真实模型请求。"""

    model_name = "verification-fake"

    def __init__(
        self, clock: SyntheticCallClock, response: AIMessage,
        error: Exception | None = None,
    ) -> None:
        self.clock = clock
        self.response = response
        self.error = error

    def bind_tools(self, tools, **kwargs):
        return self

    def invoke(self, messages):
        self.clock.elapsed_seconds += 5.0
        if self.error is not None:
            raise self.error
        return self.response


class FailingAdjudicationRuntime:
    """写入裁决调用失败的确定性替身。"""

    def __init__(self, error: Exception) -> None:
        self.error = error

    def adjudicate(self, *, candidate_text, similar):
        raise self.error


class UnavailableVerificationModel:
    """外部核验供应商的合成替身，第一次调用不可用。"""

    def bind_tools(self, tools, **kwargs):
        return self

    def invoke(self, messages):
        raise TimeoutError("synthetic provider timeout")


class RecordingMemoryPort:
    def __init__(self) -> None:
        self.calls = []

    def list_confirmed(self, scope):
        return ()

    def deleted_texts(self, scope):
        return ()

    def create_candidate(self, candidate):
        self.calls.append(("candidate", candidate.text))
        return candidate

    def confirm(self, *, scope, candidate_id, adoption_method=None):
        self.calls.append(("confirm", str(candidate_id)))

    def invalidate(self, *, scope, memory_id):
        self.calls.append(("invalidate", str(memory_id)))


class SimilarMemoryPort(RecordingMemoryPort):
    """返回一条与候选相似的联系人记忆，触发写入裁决。"""

    def __init__(self, memory: ConfirmedMemory) -> None:
        super().__init__()
        self.memory = memory

    def list_confirmed(self, scope):
        return (self.memory,)


class RecordingOwnerPort(RecordingMemoryPort):
    def list_active(self, owner_id):
        return ()

    def delete(self, owner_id, memory_id):
        self.calls.append(("owner_delete", str(memory_id)))

    def invalidate(self, owner_id, memory_id):
        self.calls.append(("owner_invalidate", str(memory_id)))

    def deleted_texts(self, owner_id):
        return ()

    def create(self, memory):
        self.calls.append(("owner_create", memory.text))


class RecordingWatermark:
    def __init__(self) -> None:
        self.values = []
        self.failure: ExtractionFailureState | None = None
        self.skips = []

    def get(self, scope):
        return self.values[-1] if self.values else None

    def set(self, scope, message_id):
        self.values.append(message_id)
        self.failure = None

    def get_failure(self, scope):
        return self.failure

    def save_failure(self, scope, state):
        self.failure = state

    def mark_skipped(self, scope, failure_range):
        self.values.append(failure_range.to_message_id)
        self.failure = None
        self.skips.append(failure_range)


class RunExtractionTest(unittest.TestCase):
    """只用合成窗口与空候选；不调用真实模型。"""

    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.memory_port = RecordingMemoryPort()
        self.owner_port = RecordingOwnerPort()
        self.watermark = RecordingWatermark()
        # 本类验证原有三道门槛与批次统计，显式放行全部维度；
        # 默认收紧（空放行表）由 test_adoption 单独覆盖。
        self.dimension_release = RELEASE_ALL_DIMENSIONS

    def test_ledger_keeps_extraction_and_verification_latency_and_start_separate(self) -> None:
        messages = (replace(_messages(1)[0], text="我习惯直接打电话沟通"),)
        clock = SyntheticCallClock()
        ledger = InMemoryOutboundLedger()
        store = InMemoryMemoryStore()
        response = AIMessage(content="", tool_calls=[{
            "name": "SourceVerificationOutput", "id": "verify-timing",
            "args": {"results": [verification_result(
                evidence=((messages[0].message_id, messages[0].text),),
            )]},
        }])
        verifier = LangChainSourceVerificationRuntime(
            model=TimedVerificationModel(clock, response), ledger=ledger,
        )
        with patch(
            "notalone.memory_extraction.command.time.perf_counter",
            side_effect=clock.perf_counter,
        ), patch(
            "notalone.memory_extraction.command.datetime",
            SimpleNamespace(now=clock.now),
        ), patch(
            "notalone.memory_extraction.verification_adapters.datetime",
            SimpleNamespace(now=clock.now),
        ):
            stats = run_extraction(
                scope=self.scope,
                messages=messages,
                watermark_message_id=None,
                runtime=TimedPayloadRuntime(clock),
                verification_runtime=verifier,
                memory_port=store,
                owner_memory_port=self.owner_port,
                ledger=ledger,
                model_name="extraction-fake",
                dimension_release=self.dimension_release,
            )

        self.assertEqual(stats.adopted, 1)
        entries = {entry.model_name: entry for entry in ledger.list_by_owner(OWNER_ID)}
        self.assertEqual(set(entries), {"extraction-fake", "verification-fake"})
        self.assertEqual(entries["extraction-fake"].latency_ms, 2000)
        self.assertEqual(entries["extraction-fake"].called_at, clock.origin)
        self.assertEqual(entries["verification-fake"].latency_ms, 5000)
        self.assertEqual(
            entries["verification-fake"].called_at,
            clock.origin + timedelta(seconds=2),
        )

    def test_failed_stages_keep_initial_call_timing_and_own_outcome(self) -> None:
        messages = (replace(_messages(1)[0], text="我习惯直接打电话沟通"),)
        for stage, extraction_error, verification_error, initial_outcome, names in (
            (
                "extract", ExtractionRuntimeError("合成提取模型失败。"), None,
                LedgerOutcome.RUN_FAILED, {"extraction-fake"},
            ),
            (
                "verify", None, TimeoutError("synthetic verifier timeout"),
                LedgerOutcome.SUCCEEDED, {"extraction-fake", "verification-fake"},
            ),
        ):
            with self.subTest(stage=stage):
                clock = SyntheticCallClock()
                ledger = InMemoryOutboundLedger()
                store = InMemoryMemoryStore()
                watermark = RecordingWatermark()
                response = AIMessage(content="", tool_calls=[{
                    "name": "SourceVerificationOutput", "id": "verify-failure-timing",
                    "args": {"results": [verification_result(
                        evidence=((messages[0].message_id, messages[0].text),),
                    )]},
                }])
                verifier = LangChainSourceVerificationRuntime(
                    model=TimedVerificationModel(clock, response, verification_error),
                    ledger=ledger,
                )
                with patch(
                    "notalone.memory_extraction.command.time.perf_counter",
                    side_effect=clock.perf_counter,
                ), patch(
                    "notalone.memory_extraction.command.datetime",
                    SimpleNamespace(now=clock.now),
                ), patch(
                    "notalone.memory_extraction.verification_adapters.datetime",
                    SimpleNamespace(now=clock.now),
                ):
                    stats = run_extraction(
                        scope=self.scope,
                        messages=messages,
                        watermark_message_id=None,
                        runtime=TimedPayloadRuntime(clock, extraction_error),
                        verification_runtime=verifier,
                        memory_port=store,
                        owner_memory_port=self.owner_port,
                        ledger=ledger,
                        watermark_port=watermark,
                        model_name="extraction-fake",
                    )

                self.assertEqual(stats.failed_batches, 1)
                self.assertEqual(store.list_confirmed(self.scope), ())
                self.assertEqual(store.list_pending_candidates(self.scope), ())
                self.assertEqual(watermark.values, [])
                entries = {entry.model_name: entry for entry in ledger.list_by_owner(OWNER_ID)}
                self.assertEqual(set(entries), names)
                self.assertEqual(entries["extraction-fake"].outcome, initial_outcome)
                self.assertEqual(entries["extraction-fake"].latency_ms, 2000)
                self.assertEqual(entries["extraction-fake"].called_at, clock.origin)
                if stage == "verify":
                    self.assertEqual(entries["verification-fake"].outcome, LedgerOutcome.RUN_FAILED)
                    self.assertEqual(entries["verification-fake"].latency_ms, 5000)
                    self.assertEqual(
                        entries["verification-fake"].called_at,
                        clock.origin + timedelta(seconds=2),
                    )

    def test_supported_candidate_keeps_auto_adoption_sources_and_watermark(self) -> None:
        messages = (replace(_messages(1)[0], text="我习惯直接打电话沟通"),)
        store = InMemoryMemoryStore()
        ledger = InMemoryOutboundLedger()

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            verification_runtime=SyntheticSupportingVerifier(),
            memory_port=store,
            owner_memory_port=self.owner_port,
            ledger=ledger,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
        )

        self.assertEqual(stats.adopted, 1)
        memory, = store.list_confirmed(self.scope)
        self.assertEqual(memory.text, "他习惯直接打电话沟通")
        self.assertEqual(memory.adoption_method, AdoptionMethod.AUTO)
        self.assertEqual(memory.source_ids, (messages[0].message_id,))
        self.assertEqual(self.watermark.values, [messages[0].message_id])
        entry, = ledger.list_by_owner(OWNER_ID)
        self.assertEqual(entry.outcome, LedgerOutcome.SUCCEEDED)

    def test_missing_verifier_retains_candidate_as_pending_with_risk(self) -> None:
        messages = _messages(1)
        store = InMemoryMemoryStore()

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            memory_port=store,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
        )

        self.assertEqual(stats.adopted, 0)
        self.assertEqual(stats.pending, 1)
        self.assertEqual(store.list_confirmed(self.scope), ())
        candidate, = store.list_pending_candidates(self.scope)
        self.assertIn("semantic:unverified", candidate.risk_flags)
        self.assertEqual(self.watermark.values, [messages[0].message_id])

    def test_uncertain_verification_retains_original_candidate_as_pending(self) -> None:
        messages = _messages(1)
        store = InMemoryMemoryStore()
        verifier = FixedSourceVerifier((verification_result(
            verdict="uncertain", issues=("insufficient_evidence",),
        ),))

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            verification_runtime=verifier,
            memory_port=store,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
        )

        self.assertEqual(stats.pending, 1)
        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(store.list_confirmed(self.scope), ())
        candidate, = store.list_pending_candidates(self.scope)
        self.assertEqual(candidate.text, "他习惯直接打电话沟通")
        self.assertEqual(candidate.source_ids, (messages[0].message_id,))
        self.assertIn("semantic:insufficient_evidence", candidate.risk_flags)
        self.assertEqual(self.watermark.values, [messages[0].message_id])

    def test_all_unsupported_is_successful_rejection_and_advances_watermark(self) -> None:
        messages = _messages(1)
        store = InMemoryMemoryStore()
        ledger = InMemoryOutboundLedger()
        verifier = FixedSourceVerifier((verification_result(
            verdict="unsupported", issues=("meaning",),
        ),))

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            verification_runtime=verifier,
            memory_port=store,
            owner_memory_port=self.owner_port,
            ledger=ledger,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
        )

        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(stats.rejected_by_contract, 1)
        self.assertEqual(stats.extracted, 0)
        self.assertEqual(store.list_confirmed(self.scope), ())
        self.assertEqual(store.list_pending_candidates(self.scope), ())
        self.assertEqual(self.watermark.values, [messages[0].message_id])
        entry, = ledger.list_by_owner(OWNER_ID)
        self.assertEqual(entry.outcome, LedgerOutcome.SUCCEEDED)

    def test_verification_failure_keeps_extraction_success_and_can_retry(self) -> None:
        messages = (replace(_messages(1)[0], text="我习惯直接打电话沟通"),)
        store = InMemoryMemoryStore()
        ledger = InMemoryOutboundLedger()
        kwargs = dict(
            scope=self.scope,
            messages=messages,
            runtime=PayloadRuntime(),
            memory_port=store,
            owner_memory_port=self.owner_port,
            ledger=ledger,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
        )

        failed = run_extraction(
            **kwargs,
            watermark_message_id=None,
            verification_runtime=LangChainSourceVerificationRuntime(
                model=UnavailableVerificationModel(), ledger=ledger,
            ),
        )

        self.assertEqual(failed.failed_batches, 1)
        self.assertEqual(store.list_confirmed(self.scope), ())
        self.assertEqual(store.list_pending_candidates(self.scope), ())
        self.assertEqual(self.watermark.values, [])
        self.assertIsNone(self.watermark.failure)
        self.assertEqual(self.watermark.skips, [])
        self.assertCountEqual(
            [entry.outcome for entry in ledger.list_by_owner(OWNER_ID)],
            [LedgerOutcome.SUCCEEDED, LedgerOutcome.RUN_FAILED],
        )

        retry_model = ToolCallingFakeModel(responses=[
            AIMessage(content="", tool_calls=[{
                "name": "SourceVerificationOutput", "id": "verify-retry",
                "args": {"results": [verification_result(
                    evidence=((messages[0].message_id, messages[0].text),),
                )]},
            }]),
        ])

        retried = run_extraction(
            **kwargs,
            watermark_message_id=self.watermark.get(self.scope),
            verification_runtime=LangChainSourceVerificationRuntime(
                model=retry_model, ledger=ledger,
            ),
        )

        self.assertEqual(retried.failed_batches, 0)
        self.assertEqual(retried.adopted, 1)
        self.assertEqual(len(store.list_confirmed(self.scope)), 1)
        self.assertEqual(self.watermark.values, [messages[0].message_id])
        self.assertCountEqual(
            [entry.outcome for entry in ledger.list_by_owner(OWNER_ID)],
            [LedgerOutcome.RUN_FAILED] + [LedgerOutcome.SUCCEEDED] * 3,
        )

    def test_invalid_verification_output_skips_visibly_after_three_failures(self) -> None:
        messages = _messages(1)
        store = InMemoryMemoryStore()
        ledger = InMemoryOutboundLedger()
        invalid_response = AIMessage(content="", tool_calls=[{
            "name": "SourceVerificationOutput", "id": "verify-invalid",
            "args": {"results": [verification_result(
                evidence=((messages[0].message_id, "原文不存在的核验片段"),),
            )]},
        }])
        verifier = LangChainSourceVerificationRuntime(
            model=ToolCallingFakeModel(responses=[invalid_response] * 3),
            ledger=ledger,
        )

        for attempt in (1, 2, 3):
            stats = run_extraction(
                scope=self.scope,
                messages=messages,
                watermark_message_id=self.watermark.get(self.scope),
                runtime=PayloadRuntime(),
                verification_runtime=verifier,
                memory_port=store,
                owner_memory_port=self.owner_port,
                ledger=ledger,
                watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            )
            if attempt < 3:
                self.assertEqual(stats.failed_batches, 1)
                self.assertEqual(self.watermark.failure.count, attempt)
                self.assertEqual(self.watermark.values, [])

        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(stats.skipped_batches, 1)
        self.assertEqual(stats.skipped_ranges, (FailureRange(
            from_message_id=messages[0].message_id,
            to_message_id=messages[0].message_id,
            code=ExtractionFailureKind.INVALID_OUTPUT,
        ),))
        self.assertEqual(self.watermark.values, [messages[0].message_id])
        self.assertEqual(self.watermark.skips, list(stats.skipped_ranges))
        self.assertIsNone(self.watermark.failure)
        self.assertEqual(store.list_confirmed(self.scope), ())
        self.assertEqual(store.list_pending_candidates(self.scope), ())
        self.assertCountEqual(
            [entry.outcome for entry in ledger.list_by_owner(OWNER_ID)],
            [LedgerOutcome.REJECTED_BY_VALIDATION] * 3
            + [LedgerOutcome.SUCCEEDED] * 3,
        )

    def test_supported_verification_keeps_existing_adoption_gates(self) -> None:
        messages = _messages(1)
        for overrides in (
            {"confidence": 0.6},
            {"risk_flags": ["health"]},
            {"speech_act": "plan"},
        ):
            with self.subTest(overrides=overrides):
                store = InMemoryMemoryStore()
                stats = run_extraction(
                    scope=self.scope,
                    messages=messages,
                    watermark_message_id=None,
                    runtime=PayloadRuntime(**overrides),
                    verification_runtime=SyntheticSupportingVerifier(),
                    memory_port=store,
                    owner_memory_port=self.owner_port,
                )

                self.assertEqual(stats.adopted, 0)
                self.assertEqual(stats.pending, 1)
                self.assertEqual(store.list_confirmed(self.scope), ())
                candidate, = store.list_pending_candidates(self.scope)
                self.assertEqual(candidate.text, "他习惯直接打电话沟通")
                if "risk_flags" in overrides:
                    self.assertIn("health", candidate.risk_flags)

    def test_full_run_batches_and_watermark(self) -> None:
        messages = _messages(7)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=NullRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 3)
        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(self.watermark.values[-1], messages[-1].message_id)
        self.assertEqual(len(self.watermark.values), 3)

    def test_incremental_run_resumes_from_watermark(self) -> None:
        messages = _messages(7)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=messages[4].message_id,
            runtime=NullRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(self.watermark.values[-1], messages[-1].message_id)

    def test_watermark_absent_message_runs_full(self) -> None:
        messages = _messages(3)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=uuid4(),
            runtime=NullRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)

    def test_failed_batch_is_counted_without_advancing_watermark(self) -> None:
        messages = _messages(6)
        ledger = InMemoryOutboundLedger()

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=FailingRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            ledger=ledger,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.adopted, 0)
        self.assertEqual(self.watermark.values, [])
        entry, = ledger.list_by_owner(OWNER_ID)
        self.assertEqual(entry.outcome, LedgerOutcome.RUN_FAILED)

    def test_model_window_has_bounded_context_and_explicit_targets(self) -> None:
        messages = _messages(45)
        runtime = RecordingWindowRuntime()

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=runtime,
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            batch_size=20,
        )

        self.assertEqual(stats.batches, 3)
        self.assertEqual(len(runtime.windows), 3)
        for window in runtime.windows:
            self.assertLessEqual(len(window.messages), 60)
            self.assertGreaterEqual(len(window.target_message_ids), 1)
            self.assertTrue(
                window.target_message_id_set <= window.message_id_set
            )

    def test_context_side_cannot_exceed_twenty_messages(self) -> None:
        with self.assertRaises(ValueError):
            run_extraction(
                scope=self.scope,
                messages=_messages(1),
                watermark_message_id=None,
                runtime=NullRuntime(),
                memory_port=self.memory_port,
                owner_memory_port=self.owner_port,
                context_before=21,
            )

    def test_invalid_output_below_threshold_stops_without_advancing(self) -> None:
        messages = _messages(6)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=InvalidOutputRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertEqual(stats.skipped_ranges, ())
        self.assertEqual(self.watermark.values, [])
        self.assertIsNotNone(self.watermark.failure)
        self.assertEqual(self.watermark.failure.count, 1)
        self.assertEqual(
            self.watermark.failure.failure_range,
            FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )

    def test_invalid_output_skips_after_three_same_range_failures(self) -> None:
        messages = _messages(6)
        self.watermark.failure = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )
        runtime = ScriptedRuntime(
            [
                ExtractionInvalidOutputError("模型未返回可解析的结构化事实。"),
                (),
            ]
        )

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=runtime,
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 2)
        self.assertEqual(stats.failed_batches, 0)
        self.assertEqual(stats.skipped_batches, 1)
        self.assertEqual(stats.processed_messages, 6)
        self.assertEqual(len(stats.skipped_ranges), 1)
        self.assertEqual(
            stats.skipped_ranges[0],
            FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )
        self.assertEqual(
            self.watermark.skips,
            [
                FailureRange(
                    from_message_id=messages[0].message_id,
                    to_message_id=messages[2].message_id,
                    code=ExtractionFailureKind.INVALID_OUTPUT,
                )
            ],
        )
        self.assertEqual(
            self.watermark.values,
            [messages[2].message_id, messages[5].message_id],
        )
        self.assertIsNone(self.watermark.failure)

    def test_unavailable_failure_never_counts_or_skips(self) -> None:
        messages = _messages(6)
        previous = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=messages[0].message_id,
                to_message_id=messages[2].message_id,
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )
        self.watermark.failure = previous

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=FailingRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertEqual(self.watermark.values, [])
        self.assertEqual(self.watermark.skips, [])
        self.assertIs(self.watermark.failure, previous)

    def test_shifted_range_with_same_code_reaches_skip_threshold(self) -> None:
        # 已计数的失败区间在 batch_size 或消息集合变化后端点漂移：
        # 同分类仍连续计数并达阈值跳过，不再因端点漂移永远卡在重试。
        messages = _messages(6)
        self.watermark.failure = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=uuid4(),
                to_message_id=uuid4(),
                code=ExtractionFailureKind.INVALID_OUTPUT,
            ),
        )

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=InvalidOutputRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 1)
        # 第一个坏批次达阈值被跳过；运行继续到第二个批次（新计数）失败后停止。
        self.assertEqual(self.watermark.failure.count, 1)
        self.assertEqual(self.watermark.skips[-1].to_message_id, messages[2].message_id)

    def test_unavailable_failure_does_not_count_or_skip(self) -> None:
        messages = _messages(3)
        self.watermark.failure = ExtractionFailureState(
            count=2,
            failure_range=FailureRange(
                from_message_id=uuid4(),
                to_message_id=uuid4(),
                code=ExtractionFailureKind.UNAVAILABLE,
            ),
        )

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=UnavailableRuntime(),
            memory_port=self.memory_port,
            owner_memory_port=self.owner_port,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        # 不可用属于环境问题：不参与计数，已有的 INVALID_OUTPUT 计数保留。
        self.assertEqual(self.watermark.failure.count, 2)

    def _similar_memory(self) -> ConfirmedMemory:
        return ConfirmedMemory(
            memory_id=uuid4(),
            scope=self.scope,
            text="他习惯直接打电话",
            category=MemoryCategory.COMMON_FACT,
            source_ids=(uuid4(),),
            source_candidate_id=None,
            adoption_method=AdoptionMethod.AUTO,
            topic=MemoryTopic.OTHER,
        )

    def test_adjudication_invalid_output_counts_toward_skip(self) -> None:
        messages = _messages(3)

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            verification_runtime=SyntheticSupportingVerifier(),
            memory_port=SimilarMemoryPort(self._similar_memory()),
            owner_memory_port=self.owner_port,
            adjudication_runtime=FailingAdjudicationRuntime(
                ExtractionInvalidOutputError("裁决模型未返回结构化结果。")
            ),
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertEqual(self.watermark.values, [])
        self.assertIsNotNone(self.watermark.failure)
        self.assertEqual(self.watermark.failure.count, 1)
        self.assertIs(
            self.watermark.failure.failure_range.code,
            ExtractionFailureKind.INVALID_OUTPUT,
        )

    def test_adjudication_unavailable_never_counts(self) -> None:
        messages = _messages(3)
        ledger = InMemoryOutboundLedger()

        stats = run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=PayloadRuntime(),
            verification_runtime=SyntheticSupportingVerifier(),
            memory_port=SimilarMemoryPort(self._similar_memory()),
            owner_memory_port=self.owner_port,
            adjudication_runtime=FailingAdjudicationRuntime(
                ExtractionRuntimeError("裁决模型调用失败。")
            ),
            ledger=ledger,
            watermark_port=self.watermark,
            dimension_release=self.dimension_release,
            batch_size=3,
        )

        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.skipped_batches, 0)
        self.assertIsNone(self.watermark.failure)
        self.assertEqual(self.watermark.values, [])
        self.assertCountEqual(
            [entry.outcome for entry in ledger.list_by_owner(OWNER_ID)],
            [LedgerOutcome.RUN_FAILED, LedgerOutcome.SUCCEEDED],
        )


class ExtractMainTest(unittest.TestCase):
    def test_default_cli_verification_rejects_reversed_claim_and_records_both_calls(self) -> None:
        message = replace(_messages(1)[0], text="我不喝酒")
        payload = {**_payload(message.message_id), "text": "他喜欢喝酒"}
        model = ToolCallingFakeModel(responses=[
            AIMessage(content="", tool_calls=[{
                "name": "MemoryExtractionOutput", "id": "extract-1",
                "args": {"facts": [payload]},
            }]),
            AIMessage(content="", tool_calls=[{
                "name": "SourceVerificationOutput", "id": "verify-1",
                "args": {"results": [verification_result(
                    verdict="unsupported", issues=("negation",),
                    evidence=((message.message_id, "不喝酒"),),
                )]},
            }]),
        ])
        store = InMemoryMemoryStore()
        ledger = InMemoryOutboundLedger()
        watermark = RecordingWatermark()
        output = StringIO()
        environment = {
            "NOTALONE_DATABASE_URL": "postgresql:///synthetic_unused_test",
            "NOTALONE_OWNER_ID": str(OWNER_ID),
            "NOTALONE_DISABLE_DOTENV": "1",
        }
        support = "notalone.memory_extraction.cli_support."
        boundaries = {
            "build_deepseek_model": model,
            "PostgresMemoryStore": store,
            "PostgresOwnerMemoryStore": RecordingOwnerPort(),
            "PostgresOutboundLedger": ledger,
            "PostgresWatermarkStore": watermark,
            "contact_exists": True,
            "load_contact_messages": (message,),
        }
        with ExitStack() as stack:
            stack.enter_context(patch.dict("os.environ", environment, clear=True))
            stack.enter_context(patch("sys.stdout", output))
            for name, value in boundaries.items():
                stack.enter_context(patch(support + name, return_value=value))
            exit_code = extract_main(["--contact-id", str(CONTACT_ID)])

        self.assertEqual(exit_code, 0)
        self.assertIn("extracted=0 adopted=0 updated=0 pending=0", output.getvalue())
        self.assertEqual(store.list_confirmed(ContactScope(OWNER_ID, CONTACT_ID)), ())
        self.assertEqual(store.list_pending_candidates(ContactScope(OWNER_ID, CONTACT_ID)), ())
        self.assertEqual(watermark.values, [message.message_id])
        self.assertEqual(
            [entry.outcome for entry in ledger.list_by_owner(OWNER_ID)],
            [LedgerOutcome.SUCCEEDED, LedgerOutcome.SUCCEEDED],
        )

    def test_rejects_invalid_batch_size_before_runtime_setup(self) -> None:
        output = StringIO()

        with patch(
            "notalone.memory_extraction.command.load_project_env"
        ), patch("sys.stdout", output):
            exit_code = extract_main(
                ["--contact-id", str(CONTACT_ID), "--batch-size", "0"]
            )

        self.assertEqual(exit_code, 1)
        self.assertIn("--batch-size 必须在 1 到 20 之间", output.getvalue())

    def test_missing_contact_is_not_reported_as_empty_success(self) -> None:
        output = StringIO()
        environment = {
            "NOTALONE_DATABASE_URL": "postgresql:///notalone_test",
            "NOTALONE_OWNER_ID": str(OWNER_ID),
        }

        with patch(
            "notalone.memory_extraction.command.load_project_env"
        ), patch.dict("os.environ", environment, clear=True), patch(
            "notalone.memory_extraction.cli_support.build_extraction_components",
            return_value=SimpleNamespace(),
        ), patch(
            "notalone.memory_extraction.cli_support.contact_exists",
            return_value=False,
        ), patch("sys.stdout", output):
            exit_code = extract_main(["--contact-id", str(CONTACT_ID)])

        self.assertEqual(exit_code, 1)
        self.assertIn("联系人不存在或不在当前用户范围内", output.getvalue())

    def test_contact_lookup_failure_returns_stable_preparation_error(self) -> None:
        output = StringIO()
        environment = {
            "NOTALONE_DATABASE_URL": "postgresql:///notalone_test",
            "NOTALONE_OWNER_ID": str(OWNER_ID),
        }

        with patch(
            "notalone.memory_extraction.command.load_project_env"
        ), patch.dict("os.environ", environment, clear=True), patch(
            "notalone.memory_extraction.cli_support.build_extraction_components",
            return_value=SimpleNamespace(),
        ), patch(
            "notalone.memory_extraction.cli_support.contact_exists",
            side_effect=RuntimeError("synthetic database outage"),
        ), patch("sys.stdout", output):
            exit_code = extract_main(["--contact-id", str(CONTACT_ID)])

        self.assertEqual(exit_code, 1)
        self.assertIn("记忆提取准备失败", output.getvalue())


class OwnerIdAndAdoptionFailureTest(unittest.TestCase):
    """非法 owner 配置与写入裁决失败时的稳定错误、统计保真。"""

    def test_invalid_owner_id_returns_error_instead_of_traceback(self) -> None:
        entries: tuple[tuple[str, Callable[[list[str] | None], int], list[str]], ...] = (
            (
                "memory-add",
                memory_add_main,
                ["--text", "合成记忆", "--category", "common_fact"],
            ),
            ("memory-list", memory_list_main, []),
            (
                "memory-delete",
                memory_delete_main,
                ["--memory-id", str(uuid4()), "--owner"],
            ),
        )
        for label, entry, arguments in entries:
            with self.subTest(entry=label):
                output = StringIO()
                environment = {
                    "NOTALONE_DATABASE_URL": "postgresql:///notalone_test",
                    "NOTALONE_OWNER_ID": "not-a-uuid",
                }
                with patch(
                    "notalone.memory_extraction.command.load_project_env"
                ), patch.dict("os.environ", environment, clear=True), patch(
                    "sys.stdout", output
                ):
                    exit_code = entry(arguments)

                printed = output.getvalue()
                self.assertEqual(exit_code, 1)
                self.assertIn("NOTALONE_OWNER_ID", printed)
                self.assertIn("UUID", printed)
                self.assertNotIn("Traceback", printed)

    def test_adoption_failure_keeps_batch_extraction_stats(self) -> None:
        messages = _messages(1)
        store = InMemoryMemoryStore()
        ledger = InMemoryOutboundLedger()
        verifier = FixedSourceVerifier((verification_result(
            verdict="unsupported", issues=("meaning",),
        ),))

        class FailingAdoption:
            def __init__(self, **kwargs) -> None:
                pass

            def adopt(self, scope, outcome):
                raise ExtractionRuntimeError(
                    "合成写入裁决失败", ExtractionFailureKind.UNAVAILABLE,
                )

        with patch(
            "notalone.memory_extraction.command.MemoryAdoption", FailingAdoption
        ):
            stats = run_extraction(
                scope=ContactScope(OWNER_ID, CONTACT_ID),
                messages=messages,
                watermark_message_id=None,
                runtime=PayloadRuntime(),
                verification_runtime=verifier,
                memory_port=store,
                owner_memory_port=RecordingOwnerPort(),
                ledger=ledger,
                watermark_port=RecordingWatermark(),
            )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.extracted, 0)
        self.assertEqual(stats.rejected_by_contract, 1)


class AdoptionFailureStatsTest(unittest.TestCase):
    """采纳阶段失败时，本批已通过提取与拒绝的候选都要留在统计里。"""

    def test_failed_adoption_keeps_passed_and_rejected_counts(self) -> None:
        messages = _messages(2)

        class TwoCandidateRuntime:
            def extract(self, window) -> tuple:
                return tuple(
                    _payload(message_id)
                    for message_id in window.target_message_ids
                )

        verifier = FixedSourceVerifier((
            verification_result(evidence=(
                (messages[0].message_id, messages[0].text),
            )),
            verification_result(
                candidate_index=1,
                verdict="unsupported", issues=("meaning",),
            ),
        ))

        class FailingAdoption:
            def __init__(self, **kwargs) -> None:
                pass

            def adopt(self, scope, outcome):
                raise ExtractionRuntimeError(
                    "合成写入裁决失败", ExtractionFailureKind.UNAVAILABLE,
                )

        with patch(
            "notalone.memory_extraction.command.MemoryAdoption", FailingAdoption
        ):
            stats = run_extraction(
                scope=ContactScope(OWNER_ID, CONTACT_ID),
                messages=messages,
                watermark_message_id=None,
                runtime=TwoCandidateRuntime(),
                verification_runtime=verifier,
                memory_port=InMemoryMemoryStore(),
                owner_memory_port=RecordingOwnerPort(),
                ledger=InMemoryOutboundLedger(),
                watermark_port=RecordingWatermark(),
                batch_size=20,
            )

        self.assertEqual(stats.batches, 1)
        self.assertEqual(stats.failed_batches, 1)
        self.assertEqual(stats.extracted, 1)
        self.assertEqual(stats.rejected_by_contract, 1)


if __name__ == "__main__":
    unittest.main()
