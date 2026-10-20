"""指定任务在实际Worker、优先级包装和CLI接缝中的配置传播。"""

from __future__ import annotations

from contextlib import ExitStack
from contextlib import redirect_stderr
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import os
import io
import socket
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.application.model_priority import (
    AccountedExtractionRunner, MemoryCallAccounting, ModelPriorityControl,
    ModelWorkStopped, PriorityVerificationRuntime,
)
from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.memory_extraction.command import ExtractionRunStats
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
from tests.unit.memory_extraction.test_command import RecordingOwnerPort, RecordingWatermark


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
