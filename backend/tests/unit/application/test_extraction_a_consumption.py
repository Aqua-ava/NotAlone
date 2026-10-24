"""远端A/B账务归属、唯一finalize与宿主关闭边界。"""
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from uuid import uuid4

from notalone.application.extraction_remote import RemoteAdoptionReceipt
from notalone.application.import_service import TaskHost
from notalone.memory_extraction.adoption import AdoptionStats
from notalone.memory_extraction.command import _BatchExtraction, _RunProgress, _commit_batch
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractionFailureKind
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.context import TraceSession
from notalone.scopes import ContactScope
from tests.support.ledger_adapters import InMemoryOutboundLedger


class ExtractionAConsumptionTest(unittest.TestCase):
    def test_b_preserves_ts_accounting_and_execution_even_when_adoption_fails(self):
        for remote, failure in ((True, False), (True, True), (False, False)):
            with self.subTest(remote=remote, failure=failure):
                scope = ContactScope(uuid4(), uuid4())
                execution, message = uuid4(), uuid4()
                metadata = dict(model_accounting_owner="typescript", a_execution_id=execution,
                    a_input_sha256="a" * 64, a_rule_version="b" * 64) if remote else {}
                outcome = ExtractionOutcome(accepted=(), extraction_completed=True, **metadata)
                extraction = _BatchExtraction(outcome, True, 0, 1, datetime.now(timezone.utc))
                completed = []
                store = SimpleNamespace(complete=lambda *args, **kwargs: completed.append(kwargs))
                trace = TraceSession(store, scope, uuid4())
                def adopt(*_):
                    if failure:
                        raise ExtractionRuntimeError("合成采纳阶段不可用")
                    return AdoptionStats()
                ledger = InMemoryOutboundLedger()
                stopped = _commit_batch(SimpleNamespace(batch=(SimpleNamespace(message_id=message),),
                    next_watermark=message, previous_watermark=None), extraction,
                    trace=trace, progress=_RunProgress(None), adoption=SimpleNamespace(adopt=adopt),
                    scope=scope, ledger=ledger, watermark_port=None, provider="deepseek", model_name="synthetic")
                self.assertEqual(stopped, failure)
                self.assertEqual(len(ledger.list_by_owner(scope.owner_id)), 0 if remote else 1)
                payload = completed[0]["payload"]
                if remote:
                    self.assertEqual(payload["typescript_a_receipt"], {
                        "a_execution_id": str(execution), "a_input_sha256": "a" * 64, "a_rule_version": "b" * 64})
                else:
                    self.assertNotIn("typescript_a_receipt", payload)

    def test_finalized_remote_b_skips_python_adoption_and_all_finalization_writes(self):
        class RecordingWatermark:
            def __init__(self):
                self.values = []

            def set(self, scope, message_id):
                self.values.append(message_id)

        scope = ContactScope(uuid4(), uuid4())
        execution, message, task, trace_id = (
            uuid4(), uuid4(), uuid4(), uuid4(),
        )
        stats = AdoptionStats(
            adopted=1,
            updated=2,
            merged=3,
            pending=4,
            skipped_duplicate=5,
            skipped_deleted=6,
            skipped_noop=7,
        )
        receipt = RemoteAdoptionReceipt(
            payload={"receipt": {"watermark_after": str(message)}},
            stats=stats,
            task_id=task,
            batch_key="a" * 64,
            trace_id=trace_id,
            b_execution_id=uuid4(),
            watermark=message,
        )
        outcome = ExtractionOutcome(
            accepted=(),
            extraction_completed=True,
            model_accounting_owner="typescript",
            model_call_ids=(),
            a_execution_id=execution,
            a_input_sha256="b" * 64,
            a_rule_version="c" * 64,
            adoption_runtime="typescript",
            adoption_receipt=receipt,
        )
        verified = []
        writes = []
        store = SimpleNamespace(
            verify_typescript_b_finalization=(
                lambda *args, **kwargs: verified.append((args, kwargs))
            ),
            complete=lambda *args, **kwargs: writes.append(kwargs),
        )
        trace = TraceSession(store, scope, trace_id)
        adoption_calls = []
        def reject_python_adoption(*_):
            adoption_calls.append(True)
            raise AssertionError("远程B不得调用Python adoption")

        watermark = RecordingWatermark()
        progress = _RunProgress(None)
        stopped = _commit_batch(
            SimpleNamespace(
                batch=(SimpleNamespace(message_id=message),),
                next_watermark=message,
                previous_watermark=None,
            ),
            _BatchExtraction(
                outcome, True, 0, 1, datetime.now(timezone.utc),
            ),
            trace=trace,
            progress=progress,
            adoption=SimpleNamespace(adopt=reject_python_adoption),
            scope=scope,
            ledger=InMemoryOutboundLedger(),
            watermark_port=watermark,
            provider="deepseek",
            model_name="synthetic",
        )

        self.assertFalse(stopped)
        self.assertEqual(adoption_calls, [])
        self.assertEqual(watermark.values, [])
        self.assertEqual(writes, [])
        self.assertEqual(len(verified), 1)
        self.assertEqual(
            verified[0][1],
            {"task_id": task, "batch_key": "a" * 64},
        )
        self.assertEqual(progress.previous_watermark, message)
        self.assertEqual(
            (
                progress.adopted,
                progress.updated,
                progress.merged,
                progress.pending,
                progress.skipped_duplicate,
                progress.skipped_deleted,
                progress.skipped_noop,
            ),
            (1, 2, 3, 4, 5, 6, 7),
        )

    def test_remote_b_missing_receipt_fails_before_local_adoption_or_commit(self):
        scope = ContactScope(uuid4(), uuid4())
        outcome = ExtractionOutcome(
            accepted=(object(),),
            extraction_completed=True,
            model_accounting_owner="typescript",
            a_execution_id=uuid4(),
            a_input_sha256="b" * 64,
            a_rule_version="c" * 64,
            adoption_runtime="typescript",
        )
        calls = []
        completed = []
        with self.assertRaises(ExtractionRuntimeError):
            _commit_batch(
                SimpleNamespace(
                    batch=(SimpleNamespace(message_id=uuid4()),),
                    next_watermark=uuid4(),
                    previous_watermark=None,
                ),
                _BatchExtraction(
                    outcome, True, 0, 1, datetime.now(timezone.utc),
                ),
                trace=TraceSession(
                    SimpleNamespace(
                        complete=lambda *args, **kwargs: completed.append(kwargs),
                    ),
                    scope,
                    uuid4(),
                ),
                progress=_RunProgress(None),
                adoption=SimpleNamespace(
                    adopt=lambda *_: calls.append(True),
                ),
                scope=scope,
                ledger=None,
                watermark_port=None,
                provider="deepseek",
                model_name="synthetic",
            )
        self.assertEqual(calls, [])
        self.assertEqual(completed, [])

    def test_remote_b_null_adoption_keeps_existing_a_success_and_failure_finalization(self):
        for failure in (False, True):
            with self.subTest(failure=failure):
                scope = ContactScope(uuid4(), uuid4())
                message = uuid4()
                outcome = ExtractionOutcome(
                    accepted=(),
                    rejected_count=2,
                    extraction_completed=not failure,
                    failure_kind=(
                        ExtractionFailureKind.UNAVAILABLE if failure else None
                    ),
                    failure_reason="合成A不可用" if failure else None,
                    model_accounting_owner="typescript",
                    a_execution_id=uuid4(),
                    a_input_sha256="b" * 64,
                    a_rule_version="c" * 64,
                    adoption_runtime="typescript",
                )
                completed = []
                adoption_calls = []
                stopped = _commit_batch(
                    SimpleNamespace(
                        batch=(SimpleNamespace(message_id=message),),
                        next_watermark=message,
                        previous_watermark=None,
                    ),
                    _BatchExtraction(
                        outcome,
                        not failure,
                        0,
                        1,
                        datetime.now(timezone.utc),
                    ),
                    trace=TraceSession(
                        SimpleNamespace(
                            complete=lambda *args, **kwargs: (
                                completed.append(kwargs)
                            ),
                        ),
                        scope,
                        uuid4(),
                    ),
                    progress=_RunProgress(None),
                    adoption=SimpleNamespace(
                        adopt=lambda *_: adoption_calls.append(True),
                    ),
                    scope=scope,
                    ledger=None,
                    watermark_port=None,
                    provider="deepseek",
                    model_name="synthetic",
                )
                self.assertEqual(stopped, failure)
                self.assertEqual(adoption_calls, [])
                self.assertEqual(len(completed), 1)
                self.assertEqual(
                    completed[0]["status"],
                    "model_failed" if failure else "succeeded",
                )

    def test_unfinalized_remote_b_is_rejected_without_writes_or_stats(self):
        scope = ContactScope(uuid4(), uuid4())
        execution, message, task, trace_id = (
            uuid4(), uuid4(), uuid4(), uuid4(),
        )
        receipt = RemoteAdoptionReceipt(
            payload={"receipt": {}},
            stats=AdoptionStats(adopted=1),
            task_id=task,
            batch_key="a" * 64,
            trace_id=trace_id,
            b_execution_id=uuid4(),
            watermark=message,
        )
        outcome = ExtractionOutcome(
            accepted=(),
            extraction_completed=True,
            model_accounting_owner="typescript",
            a_execution_id=execution,
            a_input_sha256="b" * 64,
            a_rule_version="c" * 64,
            adoption_runtime="typescript",
            adoption_receipt=receipt,
        )
        calls = []
        writes = []
        failure_marks = []
        store = SimpleNamespace(
            verify_typescript_b_finalization=lambda *args, **kwargs: (
                (_ for _ in ()).throw(RuntimeError("not finalized"))
            ),
            complete=lambda *args, **kwargs: writes.append(kwargs),
            mark_failed=lambda *args, **kwargs: failure_marks.append(
                (args, kwargs),
            ),
        )
        progress = _RunProgress(None)
        with self.assertRaises(TraceWriteError):
            with TraceSession(store, scope, trace_id) as trace:
                _commit_batch(
                    SimpleNamespace(
                        batch=(SimpleNamespace(message_id=message),),
                        next_watermark=message,
                        previous_watermark=None,
                    ),
                    _BatchExtraction(
                        outcome, True, 0, 1, datetime.now(timezone.utc),
                    ),
                    trace=trace,
                    progress=progress,
                    adoption=SimpleNamespace(
                        adopt=lambda *_: calls.append(True),
                    ),
                    scope=scope,
                    ledger=None,
                    watermark_port=None,
                    provider="deepseek",
                    model_name="synthetic",
                )
        self.assertEqual(calls, [])
        self.assertEqual(writes, [])
        self.assertEqual(failure_marks, [])
        self.assertEqual(progress.batches, 0)
        self.assertEqual(progress.adopted, 0)

    def test_host_closes_owned_remote_before_join_and_only_once(self):
        events = []
        host = TaskHost(worker_builder=lambda: None, lock_connection_builder=lambda: None,
            event_publisher=lambda _: None,
            model_priority=SimpleNamespace(stop=lambda: events.append("priority_stop")),
            stop_callback=lambda: events.append("remote_close"))
        host.stop(timeout=0)
        host.stop(timeout=0)
        self.assertEqual(events.count("remote_close"), 1)
        self.assertEqual(events[:2], ["remote_close", "priority_stop"])
