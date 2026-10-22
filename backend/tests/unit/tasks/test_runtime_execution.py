"""指定任务在实际Worker、优先级包装和CLI接缝中的配置传播。"""

from __future__ import annotations

from contextlib import ExitStack, nullcontext
from contextlib import redirect_stderr
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import io
import os
import socket
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.application.model_priority import (
    AccountedExtractionRunner, MemoryCallAccounting, ModelPriorityControl,
    ModelWorkStopped, PriorityExtractionRuntime, PriorityVerificationRuntime,
)
from notalone.ledger.models import LedgerOutcome
from notalone.persistence.background_tasks import BackgroundTaskLeaseError
from tests.support.ledger_adapters import InMemoryOutboundLedger
from notalone.memory_extraction.command import ExtractionRunStats, run_extraction
from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.models import MessageRef, MessageSender
from notalone.memory_extraction.verification import SourceVerificationMode
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.scopes import ContactScope
from notalone.tasks.models import (
    ExtractionRuntimeConfig, ExtractionRuntimeMode, ClaimedBackgroundTaskStep, BackgroundTaskStepName,
)
from notalone.tasks.worker import BackgroundTaskWorker, PostgresMemoryExtractionRunner
from notalone.tasks.command import run_worker, worker_main, WorkerCommandStatus
from notalone.tasks.worker import WorkerRunResult, WorkerRunOutcome
from tests.unit.memory_extraction.test_command import (
    BatchBarrierRuntime,
    RecordingOwnerPort,
    RecordingWatermark,
    _messages,
    _payload,
)
from tests.unit.memory_extraction.verification_helpers import (
    SyntheticSupportingVerifier,
)


class ModeVerifier:
    """只记录实际一次核验的合成边界，不调用模型。"""

    def __init__(self, mode=SourceVerificationMode.LEGACY_V4, calls=None):
        self.verification_mode = mode
        self.calls = calls if calls is not None else []

    def for_mode(self, mode):
        return ModeVerifier(mode, self.calls)

    def verify(self, *, window, facts):
        self.calls.append(self.verification_mode)
        return ()


class RuntimeExecutionTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for obj, key in ((socket.socket, "connect"), (socket.socket, "connect_ex"), (socket, "getaddrinfo")):
            guards.enter_context(patch.object(obj, key, side_effect=AssertionError("禁止真实网络")))

    def test_priority_mode_clone_preserves_control_and_invokes_only_selected_verifier(self) -> None:
        control = ModelPriorityControl()
        verifier = ModeVerifier()
        runtime = PriorityVerificationRuntime(verifier, control)

        selected = runtime.for_mode(SourceVerificationMode.NULLABLE_PROOF_V2)

        self.assertEqual(selected.verification_mode, SourceVerificationMode.NULLABLE_PROOF_V2)
        self.assertEqual(runtime.verification_mode, SourceVerificationMode.LEGACY_V4)
        self.assertEqual(selected.verify(window=None, facts=()), ())
        self.assertEqual(verifier.calls, [SourceVerificationMode.NULLABLE_PROOF_V2])
        control.stop()
        with self.assertRaises(ModelWorkStopped):
            selected.verify(window=None, facts=())
        self.assertEqual(len(verifier.calls), 1)

    def test_saved_legacy_selection_preserves_omission_and_rejects_raw_configuration(self) -> None:
        from notalone.tasks.extraction_runtime import validate_runtime_config, verification_runtime_for_config

        runtime = ModeVerifier(SourceVerificationMode.NULLABLE_PROOF_V2)
        self.assertIs(verification_runtime_for_config(runtime, None), runtime)
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)
        selected = verification_runtime_for_config(runtime, config)
        self.assertEqual(selected.verification_mode, SourceVerificationMode.LEGACY_V4)
        self.assertEqual(runtime.calls, [])
        validate_runtime_config(None)
        for raw in (config.to_payload(), "legacy", False):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                validate_runtime_config(raw)

    def test_accounting_runner_preserves_saved_task_configuration_and_legacy_omission(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        task_id = uuid4()
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)
        calls = []

        class Runner:
            model_version = "synthetic"

            def run(self, **kwargs):
                calls.append(kwargs)
                return ExtractionRunStats(processed_messages=2)

        runner = AccountedExtractionRunner(Runner(), MemoryCallAccounting(InMemoryOutboundLedger()))
        self.assertEqual(runner.run(scope=scope, task_id=task_id, extraction_runtime_config=config).processed_messages, 2)
        runner.run(scope=scope)
        self.assertEqual(calls, [
            {"scope": scope, "task_id": task_id, "extraction_runtime_config": config},
            {"scope": scope},
        ])

    def test_postgres_runner_executes_saved_legacy_config_through_existing_trace(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        task_id = uuid4()
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)
        message = MessageRef(uuid4(), "合成来源。", MessageSender.CONTACT, datetime(2026, 10, 17, tzinfo=timezone.utc))
        windows = []

        class Extraction:
            def extract(self, window):
                windows.append(window)
                return ()

        traces = InMemoryTraceStore()
        runner = PostgresMemoryExtractionRunner(
            "postgresql:///synthetic_unused_test", runtime=Extraction(), verification_runtime=ModeVerifier(),
            memory_port=InMemoryMemoryStore(), owner_memory_port=RecordingOwnerPort(),
            ledger=InMemoryOutboundLedger(), watermark_port=RecordingWatermark(), trace_store=traces,
        )
        with patch("notalone.memory_extraction.cli_support.load_contact_messages", return_value=(message,)), \
                patch("notalone.persistence.memory_processing.PostgresMemoryProcessingStore.targets",
                      return_value=((message.message_id,), (message.message_id,), 1)) as targets:
            result = runner.run(scope=scope, task_id=task_id, extraction_runtime_config=config)
        targets.assert_called_once_with(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task_id)

        self.assertEqual(result.processed_messages, 1)
        self.assertEqual(windows[0].messages, (message,))
        detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
        metadata = [event["payload"]["task_runtime"] for event in detail["events"]
                    if "task_runtime" in event["payload"]]
        self.assertTrue(metadata)
        self.assertTrue(all(item == {"task_id": str(task_id), "mode": "legacy", "config_version": 1,
                                    "rule_set_sha256": None, "lease_generation": 1} for item in metadata))

    def test_worker_command_commits_selected_config_inside_global_lock_before_claim(self) -> None:
        events = []
        scope = ContactScope(uuid4(), uuid4())
        task_id = uuid4()

        class Repository:
            def configure_extraction_runtime(self, **kwargs):
                self.saved = kwargs
                events.append("config_committed")

        class Worker:
            def run_once(self, **kwargs):
                self.claim = kwargs
                events.append("claim")
                return WorkerRunResult(WorkerRunOutcome.IDLE)

        repository, worker = Repository(), Worker()
        with patch("notalone.tasks.command.try_acquire_global_worker_lock", side_effect=lambda _: events.append("lock") or True), \
                patch("notalone.tasks.command.release_global_worker_lock", side_effect=lambda _: events.append("unlock")):
            result = run_worker(worker=worker, lock_connection=object(), owner_id=scope.owner_id,
                contact_id=scope.contact_id, worker_id=uuid4(), task_id=task_id,
                extraction_runtime_mode=ExtractionRuntimeMode.LEGACY, configuration_repository=repository)

        self.assertEqual(result.status, WorkerCommandStatus.IDLE)
        self.assertEqual(events, ["lock", "config_committed", "claim", "unlock"])
        self.assertEqual(repository.saved, {"owner_id": scope.owner_id, "contact_id": scope.contact_id,
            "task_id": task_id, "config": ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)})
        self.assertEqual(worker.claim["task_id"], task_id)

    def test_busy_or_retry_override_cannot_initialize_a_new_configuration(self) -> None:
        class Repository:
            def configure_extraction_runtime(self, **kwargs):
                raise AssertionError("未取得锁或失败恢复不得修改模式")

        repository = Repository()
        options = {"worker": object(), "lock_connection": object(), "owner_id": uuid4(),
                   "contact_id": uuid4(), "worker_id": uuid4(), "task_id": uuid4(),
                   "extraction_runtime_mode": ExtractionRuntimeMode.LEGACY,
                   "configuration_repository": repository}
        with patch("notalone.tasks.command.try_acquire_global_worker_lock", return_value=False):
            self.assertEqual(run_worker(**options).status, WorkerCommandStatus.BUSY)
        with self.assertRaises(ValueError):
            run_worker(**options, retry_repository=repository)

    def test_configuration_conflict_releases_lock_without_claiming_or_retrying(self) -> None:
        from notalone.persistence.background_tasks import BackgroundTaskStateError

        class Repository:
            def configure_extraction_runtime(self, **kwargs):
                raise BackgroundTaskStateError("合成配置冲突")

        with patch("notalone.tasks.command.try_acquire_global_worker_lock", return_value=True), \
                patch("notalone.tasks.command.release_global_worker_lock") as release:
            with self.assertRaises(BackgroundTaskStateError):
                run_worker(worker=object(), lock_connection=object(), owner_id=uuid4(), contact_id=uuid4(),
                    worker_id=uuid4(), task_id=uuid4(), extraction_runtime_mode=ExtractionRuntimeMode.LEGACY,
                    configuration_repository=Repository())
        release.assert_called_once()

    def test_cli_accepts_paired_selection_before_preflight_and_rejects_retry_overrides(self) -> None:
        contact_id, task_id = uuid4(), uuid4()
        base = ["--contact-id", str(contact_id)]
        with redirect_stderr(io.StringIO()) as stderr:
            code = worker_main(base + ["--task-id", str(task_id), "--extraction-runtime-mode", "legacy"])
        self.assertEqual(code, 2)
        self.assertIn("NOTALONE_DATABASE_URL", stderr.getvalue())
        for tail in (
            ["--task-id", str(task_id)],
            ["--extraction-runtime-mode", "legacy"],
            ["--retry-task-id", str(task_id), "--extraction-runtime-mode", "legacy"],
            ["--retry-task-id", str(task_id), "--task-id", str(task_id), "--extraction-runtime-mode", "legacy"],
        ):
            with self.subTest(tail=tail), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                worker_main(base + tail)
            self.assertEqual(caught.exception.code, 2)

    def test_worker_claims_current_rules_and_uses_only_extract_claim_configuration(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        task_id, worker_id = uuid4(), uuid4()
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)
        claims = [ClaimedBackgroundTaskStep(task_id=task_id, owner_id=scope.owner_id,
            contact_id=scope.contact_id, source_document_id=uuid4(), step_id=uuid4(), name=name,
            worker_id=worker_id, attempt_count=1, message_count=2,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(seconds=30),
            extraction_runtime_config=config)
            for name in (BackgroundTaskStepName.PARSE, BackgroundTaskStepName.NORMALIZE, BackgroundTaskStepName.EXTRACT_MEMORY)]

        class Repository:
            def claim_next_step(repo, **kwargs):
                self.assertEqual(len(kwargs["runtime_rule_set_sha256"]), 64)
                return claims.pop(0)

            def complete_step(repo, *args, **kwargs):
                pass

        class Runner:
            model_version = "synthetic"

            def __init__(runner):
                runner.calls = []

            def run(runner, **kwargs):
                runner.calls.append(kwargs)
                return ExtractionRunStats(processed_messages=2)

        runner = Runner()
        worker = BackgroundTaskWorker(repository=Repository(), extraction_runner=runner)
        for _ in range(2):
            result = worker.run_once(owner_id=scope.owner_id, contact_id=scope.contact_id, worker_id=worker_id)
            self.assertEqual(result.outcome, WorkerRunOutcome.SUCCEEDED)
            self.assertEqual(runner.calls, [])
        result = worker.run_once(owner_id=scope.owner_id, contact_id=scope.contact_id, worker_id=worker_id)
        self.assertEqual(result.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(runner.calls, [{"scope": scope, "task_id": task_id, "extraction_runtime_config": config}])

    def test_bounded_selection_uses_current_saved_hash_and_never_falls_back(self) -> None:
        from notalone.tasks.extraction_runtime import (
            runtime_config_for_mode, validate_runtime_config, verification_runtime_for_config,
        )

        config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        runtime = PriorityVerificationRuntime(ModeVerifier(), ModelPriorityControl())
        selected = verification_runtime_for_config(runtime, config)
        self.assertEqual(selected.verification_mode, SourceVerificationMode.NULLABLE_PROOF_V3)
        self.assertEqual(selected.verify(window=None, facts=()), ())
        self.assertEqual(runtime.verification_mode, SourceVerificationMode.LEGACY_V4)
        with self.assertRaises(ValueError):
            validate_runtime_config(replace(config, rule_set_sha256="f" * 64))
        with self.assertRaises(ValueError):
            verification_runtime_for_config(None, config)
        with self.assertRaises(ValueError):
            verification_runtime_for_config(object(), config)

    def test_runner_passes_configured_batch_concurrency_to_extraction_command(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        for value in (1, 3, 4):
            with self.subTest(value=value):
                runner = PostgresMemoryExtractionRunner(
                    "postgresql:///synthetic_unused_test",
                    runtime=object(), verification_runtime=ModeVerifier(),
                    memory_port=InMemoryMemoryStore(),
                    owner_memory_port=RecordingOwnerPort(),
                    ledger=InMemoryOutboundLedger(),
                    watermark_port=RecordingWatermark(),
                    trace_store=InMemoryTraceStore(),
                    batch_concurrency=value,
                )
                expected = ExtractionRunStats(processed_messages=1)
                with patch(
                    "notalone.tasks.worker.run_extraction", return_value=expected
                ) as run, patch(
                    "notalone.memory_extraction.cli_support.load_contact_messages",
                    return_value=(),
                ):
                    self.assertIs(runner.run(scope=scope), expected)
                self.assertEqual(run.call_args.kwargs["batch_concurrency"], value)

    def test_runner_rejects_batch_concurrency_outside_hard_limit(self) -> None:
        for value in (0, 5, -1, True, 1.5, None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                PostgresMemoryExtractionRunner(
                    "postgresql:///synthetic_unused_test",
                    batch_concurrency=value,
                )

    def test_worker_passes_lease_guard_factory_to_extraction_runner(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        claim = ClaimedBackgroundTaskStep(
            task_id=uuid4(), owner_id=scope.owner_id,
            contact_id=scope.contact_id, source_document_id=uuid4(),
            step_id=uuid4(), name=BackgroundTaskStepName.EXTRACT_MEMORY,
            worker_id=uuid4(), attempt_count=1, message_count=1,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(seconds=30),
        )

        class Repository:
            def __init__(self) -> None:
                self.lease_checks = 0
                self.completed = None

            def claim_next_step(self, **kwargs):
                return claim

            def check_step_lease(self, claimed):
                self.lease_checks += 1

            def renew_step_lease(self, claimed, *, lease_duration):
                pass

            def complete_step(self, claimed, **kwargs):
                self.completed = kwargs

        class Runner:
            model_version = "synthetic"

            def __init__(self) -> None:
                self.options = None

            def run(self, **kwargs):
                self.options = kwargs
                factory = kwargs.get("background_scope_factory")
                if factory is not None:
                    # 工厂必须可调用，并在进入后把租约复验接到模型许可边界。
                    with factory(), control.background_call():
                        pass
                return ExtractionRunStats(batches=1, processed_messages=1)

        repository, runner = Repository(), Runner()
        control = ModelPriorityControl()
        worker = BackgroundTaskWorker(
            repository=repository,
            extraction_runner=runner,
            model_priority=control,
        )

        result = worker.run_once(
            owner_id=scope.owner_id, contact_id=scope.contact_id,
            worker_id=uuid4(),
        )

        self.assertEqual(result.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertIsNotNone(runner.options)
        self.assertTrue(callable(runner.options["background_scope_factory"]))
        self.assertGreaterEqual(repository.lease_checks, 1)

    def test_pipeline_enters_lease_guard_factory_in_multiple_worker_threads(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        messages = _messages(2)
        entered: list[int] = []
        entered_lock = threading.Lock()

        def factory():
            with entered_lock:
                entered.append(threading.get_ident())
            return nullcontext()

        stats = run_extraction(
            trace_store=InMemoryTraceStore(),
            scope=scope,
            messages=messages,
            watermark_message_id=None,
            runtime=BatchBarrierRuntime(parties=2),
            memory_port=InMemoryMemoryStore(),
            owner_memory_port=RecordingOwnerPort(),
            watermark_port=RecordingWatermark(),
            batch_size=1,
            batch_concurrency=2,
            background_scope_factory=factory,
        )

        self.assertEqual(stats.batches, 2)
        self.assertGreaterEqual(len(set(entered)), 2)

    def test_pipeline_lease_guard_failure_aborts_before_adoption_or_watermark(self) -> None:
        from notalone.memory_extraction.command import _BatchWriteGate

        scope = ContactScope(uuid4(), uuid4())
        messages = _messages(2)
        gate_aborted = threading.Event()
        second_entered = threading.Event()
        entries = 0
        entries_lock = threading.Lock()
        original_abort = _BatchWriteGate.abort

        def abort(gate):
            gate_aborted.set()
            original_abort(gate)

        def factory():
            nonlocal entries
            with entries_lock:
                entries += 1
                current = entries
            if current == 1:
                # 第二线程抛出后仍需等闸门中止，避免第一批抢先提交。
                if not gate_aborted.wait(timeout=2.0):
                    raise AssertionError("并发批次未在预期时间内中止。")
                return nullcontext()
            second_entered.set()
            raise BackgroundTaskLeaseError("合成步骤租约已失效。")

        class FactRuntime:
            def extract(self, window):
                message_id = window.target_message_ids[0]
                return ({**_payload(message_id), "text": "不应写入的合成事实"},)

        memory = InMemoryMemoryStore()
        watermark = RecordingWatermark()
        with patch.object(_BatchWriteGate, "abort", abort):
            with self.assertRaises(BackgroundTaskLeaseError):
                run_extraction(
                    trace_store=InMemoryTraceStore(),
                    scope=scope,
                    messages=messages,
                    watermark_message_id=None,
                    runtime=FactRuntime(),
                    verification_runtime=SyntheticSupportingVerifier(),
                    memory_port=memory,
                    owner_memory_port=RecordingOwnerPort(),
                    watermark_port=watermark,
                    batch_size=1,
                    batch_concurrency=2,
                    background_scope_factory=factory,
                )

        self.assertTrue(second_entered.is_set())
        self.assertGreaterEqual(entries, 2)
        self.assertEqual(memory.list_confirmed(scope), ())
        self.assertEqual(memory.list_pending_candidates(scope), ())
        self.assertEqual(watermark.values, [])

    def test_parallel_stop_accounts_returned_extraction_calls_without_attribute_error(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        messages = _messages(2)
        ledger = InMemoryOutboundLedger()
        accounting = MemoryCallAccounting(ledger, model_name="synthetic")

        class StopOnWaitControl(ModelPriorityControl):
            def wait_for_foreground(self) -> None:
                self.stop()
                super().wait_for_foreground()

        class EmptyRuntime:
            def extract(self, window):
                return ()

        control = StopOnWaitControl(background_limit=2)
        runtime = PriorityExtractionRuntime(
            EmptyRuntime(), control, accounting=accounting,
        )
        runner = PostgresMemoryExtractionRunner(
            "postgresql:///synthetic_unused_test",
            runtime=runtime,
            memory_port=InMemoryMemoryStore(),
            owner_memory_port=RecordingOwnerPort(),
            ledger=ledger,
            watermark_port=RecordingWatermark(),
            trace_store=InMemoryTraceStore(),
            batch_concurrency=2,
        )
        with patch(
            "notalone.memory_extraction.cli_support.load_contact_messages",
            return_value=messages,
        ), self.assertRaises(ModelWorkStopped):
            AccountedExtractionRunner(runner, accounting).run(scope=scope)

        entries = ledger.list_by_owner(scope.owner_id)
        self.assertTrue(entries, "停止时已返回的提取调用必须补记台账。")
        self.assertTrue(
            all(entry.contact_id == scope.contact_id for entry in entries)
        )
        self.assertEqual(
            {entry.outcome for entry in entries}, {LedgerOutcome.RUN_FAILED}
        )

    def test_task_host_builder_passes_batch_concurrency_to_accounted_runner(self) -> None:
        from types import SimpleNamespace

        from notalone.server.command import _build_task_host
        from notalone.server.event_bus import EventBus

        components = SimpleNamespace(
            ledger=InMemoryOutboundLedger(),
            model=object(),
            model_name="synthetic",
            watermark=RecordingWatermark(),
        )

        class FakeTaskHost:
            def __init__(self, *, worker_builder, **kwargs) -> None:
                self.worker_builder = worker_builder

        with patch(
            "notalone.application.import_service.TaskHost", FakeTaskHost
        ), patch(
            "notalone.persistence.background_tasks.PostgresBackgroundTaskRepository"
        ), patch(
            "notalone.persistence.contact_memory_index.PostgresContactMemoryIndexRepository"
        ), patch(
            "notalone.persistence.source_deletion.PostgresSourceDeletionRepository"
        ), patch(
            "notalone.persistence.skill_learning.PostgresSkillLearningStore"
        ), patch(
            "notalone.memory_extraction.cli_support.build_extraction_components",
            return_value=components,
        ), patch(
            "notalone.memory_extraction.direct_adapter.DirectExtractionRuntime"
        ), patch(
            "notalone.memory_extraction.adjudication_adapters.LangChainAdjudicationRuntime"
        ), patch(
            "notalone.memory_extraction.verification_adapters.LangChainSourceVerificationRuntime"
        ), patch(
            "notalone.application.skill_learning.SkillLearningTaskRunner"
        ), patch(
            "notalone.skills.learning_runtime.LangChainSkillProposalRuntime"
        ):
            host = _build_task_host(
                "postgresql:///synthetic_unused_test", EventBus(),
                model_priority=ModelPriorityControl(background_limit=3),
                batch_concurrency=3,
            )
            worker = host.worker_builder()

        self.assertIsInstance(worker._extraction_runner, AccountedExtractionRunner)
        self.assertEqual(
            worker._extraction_runner._runner._batch_concurrency, 3
        )

    def test_serial_extraction_ignores_parallel_lease_guard_factory(self) -> None:
        scope = ContactScope(uuid4(), uuid4())

        class EmptyRuntime:
            def extract(self, window):
                return ()

        def factory():
            raise AssertionError("串行路径不得进入并行租约工厂。")

        stats = run_extraction(
            trace_store=InMemoryTraceStore(),
            scope=scope,
            messages=_messages(2),
            watermark_message_id=None,
            runtime=EmptyRuntime(),
            memory_port=InMemoryMemoryStore(),
            owner_memory_port=RecordingOwnerPort(),
            watermark_port=RecordingWatermark(),
            batch_size=1,
            batch_concurrency=1,
            background_scope_factory=factory,
        )

        self.assertEqual(stats.batches, 2)
        self.assertEqual(stats.processed_messages, 2)

    def test_accounted_runner_forwards_background_scope_factory(self) -> None:
        scope = ContactScope(uuid4(), uuid4())
        factory = nullcontext

        class Runner:
            model_version = "synthetic"

            def __init__(self) -> None:
                self.options = None

            def run(self, **kwargs):
                self.options = kwargs
                return ExtractionRunStats()

        delegate = Runner()
        runner = AccountedExtractionRunner(
            delegate, MemoryCallAccounting(InMemoryOutboundLedger())
        )

        runner.run(scope=scope, background_scope_factory=factory)

        self.assertIs(delegate.options["background_scope_factory"], factory)

    def test_worker_cli_rejects_invalid_batch_concurrency_before_database_setup(self) -> None:
        with patch.dict(
            os.environ,
            {
                "NOTALONE_DISABLE_DOTENV": "1",
                "NOTALONE_EXTRACTION_BATCH_CONCURRENCY": "5",
            },
            clear=True,
        ), redirect_stderr(io.StringIO()) as stderr:
            code = worker_main(["--contact-id", str(uuid4())])

        self.assertEqual(code, 2)
        self.assertIn(
            "NOTALONE_EXTRACTION_BATCH_CONCURRENCY", stderr.getvalue()
        )

    def test_explicit_runner_configuration_rejects_missing_task_before_reading_messages(self) -> None:
        runner = PostgresMemoryExtractionRunner(
            "postgresql:///synthetic_unused_test", runtime=object(), verification_runtime=ModeVerifier(),
            memory_port=InMemoryMemoryStore(), owner_memory_port=RecordingOwnerPort(),
            ledger=InMemoryOutboundLedger(), watermark_port=RecordingWatermark(),
            trace_store=InMemoryTraceStore(),
        )
        config = ExtractionRuntimeConfig(ExtractionRuntimeMode.LEGACY, None)
        with patch("notalone.memory_extraction.cli_support.load_contact_messages") as load:
            with self.assertRaises(ValueError):
                runner.run(scope=ContactScope(uuid4(), uuid4()), extraction_runtime_config=config)
        load.assert_not_called()
