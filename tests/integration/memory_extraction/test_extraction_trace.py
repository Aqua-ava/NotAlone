"""通过提取和追踪查询接缝核对合成资料的完整处理过程。"""

from __future__ import annotations

import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.command import run_extraction
from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.watermark_store import PostgresWatermarkStore
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_command import _payload

DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class FixedRuntime:
    def __init__(self, payloads):
        self.payloads = payloads

    def extract(self, window):
        return self.payloads


class FailingTraceStore(PostgresExtractionTraceStore):
    """存储边界故障，不替换业务模块或模型语义。"""

    def __init__(self, stage):
        super().__init__(DATABASE_URL)
        self.stage = stage

    def append(self, *args, stage, **kwargs):
        if stage == self.stage:
            raise RuntimeError("合成追踪存储故障")
        return super().append(*args, stage=stage, **kwargs)


class ExtractionTraceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供本任务隔离测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[
                0
            ]
        if not name.endswith("_test"):
            raise RuntimeError("追踪测试只允许使用隔离测试库。")

    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.source_ids = [uuid4(), uuid4()]
        self.message_ids = [uuid4(), uuid4()]
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成用户')",
                (self.scope.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, '合成联系人')",
                (self.scope.owner_id, self.scope.contact_id),
            )
            for index, (source, message) in enumerate(
                zip(self.source_ids, self.message_ids)
            ):
                connection.execute(
                    "INSERT INTO public.source_document (id, owner_id, contact_id, source_type, file_name, content_sha256, record_count, status) VALUES (%s, %s, %s, 'wechat_jsonl', 'synthetic.jsonl', %s, 1, 'active')",
                    (
                        source,
                        self.scope.owner_id,
                        self.scope.contact_id,
                        ("a", "b")[index] * 64,
                    ),
                )
                connection.execute(
                    "INSERT INTO public.message (id, owner_id, contact_id, speaker, message_type, text_content, occurred_at) VALUES (%s, %s, %s, 'contact', 'text', %s, %s)",
                    (
                        message,
                        self.scope.owner_id,
                        self.scope.contact_id,
                        ("我习惯直接打电话", "合成后文")[index],
                        datetime(2026, 8, 1, tzinfo=timezone.utc)
                        + timedelta(minutes=index),
                    ),
                )
                connection.execute(
                    "INSERT INTO public.message_source_ref (message_id, owner_id, contact_id, source_kind, source_document_id, source_locator, raw_payload) VALUES (%s, %s, %s, 'source_document', %s, 'line-1', '{}'::jsonb)",
                    (
                        message,
                        self.scope.owner_id,
                        self.scope.contact_id,
                        source,
                    ),
                )
        self.messages = load_contact_messages(self.scope, DATABASE_URL)
        self.memory = PostgresMemoryStore(DATABASE_URL)
        self.owner_memory = PostgresOwnerMemoryStore(DATABASE_URL)
        self.watermark = PostgresWatermarkStore(DATABASE_URL)
        self.traces = PostgresExtractionTraceStore(DATABASE_URL)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.scope.owner_id,),
            )

    def run_batch(self, payloads, **options):
        return run_extraction(
            scope=self.scope,
            messages=self.messages,
            watermark_message_id=None,
            runtime=FixedRuntime(payloads),
            memory_port=self.memory,
            owner_memory_port=self.owner_memory,
            watermark_port=self.watermark,
            trace_store=self.traces,
            batch_size=2,
            **options,
        )

    def test_default_production_runner_records_filtering_when_no_model_window_is_eligible(
        self,
    ):
        from notalone.tasks.worker import PostgresMemoryExtractionRunner

        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.message SET speaker='system' WHERE id=%s",
                (self.message_ids[0],),
            )
            connection.execute(
                "UPDATE public.message SET occurred_at=NULL WHERE id=%s",
                (self.message_ids[1],),
            )

        class ForbiddenRuntime:
            def extract(self, window):
                raise AssertionError("筛选后无消息时不能调用模型。")

        runner = PostgresMemoryExtractionRunner(
            DATABASE_URL, runtime=ForbiddenRuntime()
        )
        self.assertEqual(runner.run(scope=self.scope).batches, 0)
        batches = self.traces.list_batches(self.scope)
        self.assertEqual(len(batches), 1)
        detail = self.traces.get_batch(self.scope, batches[0]["trace_id"])
        window = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "window"
        )
        self.assertEqual(window["target_count"], 0)
        self.assertEqual(
            [row["reason"] for row in window["selection_receipts"]],
            ["unsupported_sender", "missing_occurred_at"],
        )
        self.assertEqual(detail["status"], "skipped")
        self.assertIsNone(self.watermark.get(self.scope))

    def test_pending_candidate_can_reveal_original_window_and_each_processing_step(
        self,
    ):
        stats = self.run_batch((_payload(self.message_ids[0]),))
        self.assertEqual(stats.pending, 1)
        candidate = self.memory.list_pending_candidates(self.scope)[0]
        lookup = self.traces.find_record(
            self.scope, "candidate", candidate.candidate_id
        )
        self.assertEqual(lookup["availability"], "recorded")
        detail = self.traces.get_batch(
            self.scope, lookup["batches"][0]["trace_id"]
        )
        self.assertEqual(detail["status"], "succeeded")
        window = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "window"
        )
        self.assertEqual(
            [message["text"] for message in window["messages"]],
            ["我习惯直接打电话", "合成后文"],
        )
        self.assertEqual(window["target_count"], 2)
        self.assertEqual(window["sources_status"], "processing_missing")
        candidate_events = [
            event for event in detail["events"] if event["candidate_trace_id"]
        ]
        self.assertEqual(
            {
                event["candidate_trace_id"] for event in candidate_events
            }.__len__(),
            1,
        )
        stages = {event["stage"] for event in detail["events"]}
        self.assertTrue(
            {
                "candidate_raw",
                "parse",
                "source_contract",
                "timing",
                "pragmatics",
                "verification",
                "adoption_gates",
                "write_result",
                "batch_end",
            }
            <= stages
        )
        gates = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "adoption_gates"
        )
        self.assertEqual(gates["confidence"]["threshold"], 0.7)
        self.assertFalse(gates["dimension"]["passed"])
        self.assertEqual(
            detail["links"][0]["record_id"], str(candidate.candidate_id)
        )
        self.assertEqual(self.watermark.get(self.scope), self.message_ids[1])
        alien = ContactScope(self.scope.owner_id, uuid4())
        self.assertEqual(self.traces.list_batches(alien), ())
        with self.assertRaises(LookupError):
            self.traces.get_batch(alien, detail["trace_id"])

    def test_deleting_context_source_erases_trace_but_keeps_independent_candidate(
        self,
    ):
        from notalone.persistence.source_deletion import (
            PostgresSourceDeletionRepository,
        )

        run_extraction(
            scope=self.scope,
            messages=self.messages,
            watermark_message_id=None,
            runtime=FixedRuntime((_payload(self.message_ids[0]),)),
            memory_port=self.memory,
            owner_memory_port=self.owner_memory,
            trace_store=self.traces,
            watermark_port=self.watermark,
            batch_size=1,
            context_after=1,
        )
        candidate = self.memory.list_pending_candidates(self.scope)[0]
        batch = self.traces.find_record(
            self.scope, "candidate", candidate.candidate_id
        )["batches"][0]
        before = self.traces.get_batch(self.scope, batch["trace_id"])
        window = next(
            event["payload"]
            for event in before["events"]
            if event["stage"] == "window"
        )
        self.assertEqual(
            [message["role"] for message in window["messages"]],
            ["target", "context_after"],
        )
        PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            source_document_id=self.source_ids[1],
        )
        after = self.traces.get_batch(self.scope, batch["trace_id"])
        self.assertEqual(after["status"], "deleted")
        self.assertEqual(after["events"], [])
        self.assertEqual(after["deletion_reason"], "source_deleted")
        self.assertEqual(
            self.memory.get_candidate(
                scope=self.scope, candidate_id=candidate.candidate_id
            ).text,
            "他习惯直接打电话沟通",
        )

    def test_user_confirmed_extracted_candidate_retains_the_original_trace(
        self,
    ):
        from notalone.memory.models import AdoptionMethod

        self.run_batch((_payload(self.message_ids[0]),))
        candidate = self.memory.list_pending_candidates(self.scope)[0]
        memory = self.memory.confirm(
            scope=self.scope,
            candidate_id=candidate.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        found = self.traces.find_record(
            self.scope, "contact_memory", memory.memory_id
        )
        self.assertEqual(found["availability"], "recorded")
        self.traces.delete_batch(self.scope, found["batches"][0]["trace_id"])
        self.assertEqual(
            self.traces.find_record(
                self.scope, "contact_memory", memory.memory_id
            )["availability"],
            "deleted",
        )
        self.assertEqual(
            self.memory.list_confirmed(self.scope)[0].memory_id,
            memory.memory_id,
        )

    def test_discarding_a_pending_candidate_erases_its_trace_copy(self):
        self.run_batch((_payload(self.message_ids[0]),))
        candidate = self.memory.list_pending_candidates(self.scope)[0]
        self.memory.discard_candidate_with_fingerprint(
            scope=self.scope, candidate_id=candidate.candidate_id
        )
        found = self.traces.find_record(
            self.scope, "candidate", candidate.candidate_id
        )
        self.assertEqual(found["availability"], "deleted")
        self.assertEqual(
            self.traces.get_batch(self.scope, found["batches"][0]["trace_id"])[
                "events"
            ],
            [],
        )

    def test_response_record_failure_stops_before_business_and_never_counts_invalid_output(
        self,
    ):
        from notalone.memory_trace import TraceWriteError

        for _ in range(3):
            with self.assertRaises(TraceWriteError):
                run_extraction(
                    scope=self.scope,
                    messages=self.messages,
                    watermark_message_id=None,
                    runtime=FixedRuntime((_payload(self.message_ids[0]),)),
                    memory_port=self.memory,
                    owner_memory_port=self.owner_memory,
                    watermark_port=self.watermark,
                    trace_store=FailingTraceStore("extraction_return"),
                )
        self.assertEqual(self.memory.list_pending_candidates(self.scope), ())
        self.assertIsNone(self.watermark.get(self.scope))
        self.assertIsNone(self.watermark.get_failure(self.scope))
        batches = self.traces.list_batches(self.scope)
        self.assertEqual(len(batches), 3)
        self.assertTrue(
            all(batch["status"] == "trace_failed" for batch in batches)
        )
        self.assertEqual(batches[0]["retry_of"], batches[1]["trace_id"])

    def test_committed_candidate_remains_queryable_after_post_write_trace_fault_and_retry(
        self,
    ):
        from notalone.memory_trace import TraceWriteError

        with self.assertRaises(TraceWriteError):
            run_extraction(
                scope=self.scope,
                messages=self.messages,
                watermark_message_id=None,
                runtime=FixedRuntime(
                    (
                        _payload(self.message_ids[0]),
                        _payload(self.message_ids[1]),
                    )
                ),
                memory_port=self.memory,
                owner_memory_port=self.owner_memory,
                watermark_port=self.watermark,
                trace_store=FailingTraceStore("write_result"),
            )
        candidates = self.memory.list_pending_candidates(self.scope)
        self.assertEqual(len(candidates), 1)
        found = self.traces.find_record(
            self.scope, "candidate", candidates[0].candidate_id
        )
        detail = self.traces.get_batch(
            self.scope, found["batches"][0]["trace_id"]
        )
        self.assertEqual(detail["status"], "trace_failed")
        self.assertEqual(detail["links"][0]["commit_status"], "committed")
        self.assertTrue(detail["write_receipts"][0]["observed_after_failure"])
        self.assertIsNone(self.watermark.get(self.scope))
        stats = self.run_batch((_payload(self.message_ids[0]),))
        self.assertEqual(stats.skipped_duplicate, 1)
        self.assertEqual(
            len(self.memory.list_pending_candidates(self.scope)), 1
        )
        self.assertEqual(
            self.traces.list_batches(self.scope)[0]["retry_of"],
            detail["trace_id"],
        )

    def test_rejected_non_memory_and_pending_candidates_all_have_stable_dispositions(
        self,
    ):
        good = _payload(self.message_ids[0])
        self.run_batch(
            (
                {"text": "损坏的合成结构"},
                {**good, "source_message_ids": [str(uuid4())]},
                {**good, "text": "合成玩笑", "figurative_type": "joke"},
                {**good, "text": "合成待确认", "confidence": 0.4},
            )
        )
        detail = self.traces.get_batch(
            self.scope, self.traces.list_batches(self.scope)[0]["trace_id"]
        )
        self.assertEqual(
            [candidate["disposition"] for candidate in detail["candidates"]],
            ["structure_rejected", "source_rejected", "non_memory", "pending"],
        )
        self.assertEqual(
            len(
                {
                    candidate["candidate_trace_id"]
                    for candidate in detail["candidates"]
                }
            ),
            4,
        )
        self.assertEqual(
            len(self.memory.list_pending_candidates(self.scope)), 1
        )

    def test_source_of_old_memory_used_by_update_erases_trace_even_outside_new_window(
        self,
    ):
        from notalone.memory_extraction.adjudication import (
            AdjudicationAction,
            AdjudicationDecision,
        )
        from notalone.memory_extraction.dimensions import (
            RELEASE_ALL_DIMENSIONS,
        )
        from notalone.persistence.source_deletion import (
            PostgresSourceDeletionRepository,
        )
        from tests.unit.memory_extraction.verification_helpers import (
            SyntheticSupportingVerifier,
        )

        options = {
            "verification_runtime": SyntheticSupportingVerifier(),
            "dimension_release": RELEASE_ALL_DIMENSIONS,
        }
        run_extraction(
            scope=self.scope,
            messages=(self.messages[0],),
            watermark_message_id=None,
            runtime=FixedRuntime((_payload(self.message_ids[0]),)),
            memory_port=self.memory,
            owner_memory_port=self.owner_memory,
            trace_store=self.traces,
            **options,
        )
        old = self.memory.list_confirmed(self.scope)[0]

        class UpdateRuntime:
            def adjudicate(self, *, candidate_text, similar):
                return AdjudicationDecision(
                    AdjudicationAction.UPDATE, old.memory_id
                )

        newer = {
            **_payload(self.message_ids[1]),
            "text": "他现在习惯直接打电话沟通",
        }
        stats = run_extraction(
            scope=self.scope,
            messages=(self.messages[1],),
            watermark_message_id=None,
            runtime=FixedRuntime((newer,)),
            memory_port=self.memory,
            owner_memory_port=self.owner_memory,
            trace_store=self.traces,
            adjudication_runtime=UpdateRuntime(),
            **options,
        )
        self.assertEqual(stats.updated, 1)
        current = self.memory.list_confirmed(self.scope)[0]
        detail = self.traces.get_batch(
            self.scope,
            self.traces.find_record(
                self.scope, "contact_memory", current.memory_id
            )["batches"][0]["trace_id"],
        )
        replaced = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "write_result"
            and event["payload"]["operation"] == "invalidate"
        )
        self.assertEqual(
            replaced["previous"]["version"]["memory_id"], str(old.memory_id)
        )
        self.assertEqual(replaced["actual"]["status"], "invalidated")
        PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            source_document_id=self.source_ids[0],
        )
        self.assertEqual(
            self.traces.get_batch(self.scope, detail["trace_id"])["status"],
            "deleted",
        )
        self.assertEqual(
            self.memory.list_confirmed(self.scope)[0].memory_id,
            current.memory_id,
        )

    def test_deleting_a_memory_erases_its_trace_and_prevents_later_sensitive_appends(
        self,
    ):
        from notalone.memory_extraction.dimensions import (
            RELEASE_ALL_DIMENSIONS,
        )
        from notalone.memory_trace import TraceWriteError
        from tests.unit.memory_extraction.verification_helpers import (
            SyntheticSupportingVerifier,
        )

        self.run_batch(
            (_payload(self.message_ids[0]),),
            verification_runtime=SyntheticSupportingVerifier(),
            dimension_release=RELEASE_ALL_DIMENSIONS,
        )
        memory = self.memory.list_confirmed(self.scope)[0]
        batch = self.traces.find_record(
            self.scope, "contact_memory", memory.memory_id
        )["batches"][0]
        self.memory.delete(scope=self.scope, memory_id=memory.memory_id)
        detail = self.traces.get_batch(self.scope, batch["trace_id"])
        self.assertEqual(detail["status"], "deleted")
        self.assertEqual(detail["events"], [])
        with self.assertRaises(TraceWriteError):
            self.traces.append(
                self.scope,
                UUID(batch["trace_id"]),
                stage="model_response",
                payload={"synthetic": "不能复活正文"},
            )

    def test_invalid_verification_quote_exposes_the_actual_failed_contract_rule(
        self,
    ):
        from tests.unit.memory_extraction.verification_helpers import (
            FixedSourceVerifier,
            verification_result,
        )

        stats = self.run_batch(
            (_payload(self.message_ids[0]),),
            verification_runtime=FixedSourceVerifier(
                (
                    verification_result(
                        evidence=((self.message_ids[0], "不存在的合成片段"),)
                    ),
                )
            ),
        )
        self.assertEqual(stats.failed_batches, 1)
        detail = self.traces.get_batch(
            self.scope, self.traces.list_batches(self.scope)[0]["trace_id"]
        )
        checks = [
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "verification_contract"
        ]
        self.assertTrue(
            any(
                check.get("check") == "quote_in_message"
                and not check["passed"]
                for check in checks
            )
        )
        self.assertEqual(self.memory.list_pending_candidates(self.scope), ())
        self.assertIsNone(self.watermark.get(self.scope))

    def test_deleted_old_source_cannot_be_registered_late_and_resurrect_its_snapshot(
        self,
    ):
        from notalone.memory.models import (
            AdoptionMethod,
            MemoryCandidate,
            MemoryCategory,
        )
        from notalone.memory_trace import TraceWriteError
        from notalone.persistence.source_deletion import (
            PostgresSourceDeletionRepository,
        )

        old = self.memory.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=self.scope,
                text="只能来自旧来源的合成正文",
                category=MemoryCategory.COMMON_FACT,
                source_ids=(self.message_ids[0],),
            )
        )
        self.memory.confirm(
            scope=self.scope,
            candidate_id=old.candidate_id,
            adoption_method=AdoptionMethod.AUTO,
        )
        parent = self

        class DeletingTraceStore(PostgresExtractionTraceStore):
            def append(self, *args, stage, **kwargs):
                if stage == "memory_pool":
                    PostgresSourceDeletionRepository(
                        DATABASE_URL
                    ).delete_source(
                        owner_id=parent.scope.owner_id,
                        contact_id=parent.scope.contact_id,
                        source_document_id=parent.source_ids[0],
                    )
                return super().append(*args, stage=stage, **kwargs)

        with self.assertRaises(TraceWriteError):
            run_extraction(
                scope=self.scope,
                messages=(self.messages[1],),
                watermark_message_id=None,
                runtime=FixedRuntime(
                    (
                        {
                            **_payload(self.message_ids[1]),
                            "text": "来自新来源的独立合成主张",
                        },
                    )
                ),
                memory_port=self.memory,
                owner_memory_port=self.owner_memory,
                watermark_port=self.watermark,
                trace_store=DeletingTraceStore(DATABASE_URL),
            )
        detail = self.traces.get_batch(
            self.scope, self.traces.list_batches(self.scope)[0]["trace_id"]
        )
        self.assertEqual(detail["status"], "trace_failed")
        self.assertNotIn("只能来自旧来源的合成正文", str(detail))
        self.assertEqual(self.memory.list_pending_candidates(self.scope), ())
        self.assertIsNone(self.watermark.get(self.scope))

    def test_trace_and_watermark_end_roll_back_together_when_the_transaction_fails(
        self,
    ):
        from notalone.memory_trace import TraceWriteError

        class FailingWatermark(PostgresWatermarkStore):
            def finish_in_transaction(self, *args, **kwargs):
                super().finish_in_transaction(*args, **kwargs)
                raise RuntimeError("合成事务提交前故障")

        with self.assertRaises(TraceWriteError):
            run_extraction(
                scope=self.scope,
                messages=self.messages,
                watermark_message_id=None,
                runtime=FixedRuntime(()),
                memory_port=self.memory,
                owner_memory_port=self.owner_memory,
                watermark_port=FailingWatermark(DATABASE_URL),
                trace_store=self.traces,
            )
        self.assertIsNone(self.watermark.get(self.scope))
        detail = self.traces.get_batch(
            self.scope, self.traces.list_batches(self.scope)[0]["trace_id"]
        )
        self.assertEqual(detail["status"], "trace_failed")
        self.assertFalse(
            any(event["stage"] == "batch_end" for event in detail["events"])
        )

    def test_acknowledgement_loss_after_atomic_commit_preserves_actual_completion(
        self,
    ):
        from notalone.memory_trace import TraceWriteError

        class LostAcknowledgementStore(PostgresExtractionTraceStore):
            def complete(self, *args, **kwargs):
                super().complete(*args, **kwargs)
                raise RuntimeError("合成提交后回执遗失")

        with self.assertRaises(TraceWriteError):
            run_extraction(
                scope=self.scope,
                messages=self.messages,
                watermark_message_id=None,
                runtime=FixedRuntime(()),
                memory_port=self.memory,
                owner_memory_port=self.owner_memory,
                watermark_port=self.watermark,
                trace_store=LostAcknowledgementStore(DATABASE_URL),
            )
        detail = self.traces.get_batch(
            self.scope, self.traces.list_batches(self.scope)[0]["trace_id"]
        )
        self.assertEqual(detail["status"], "succeeded")
        self.assertEqual(self.watermark.get(self.scope), self.message_ids[1])
        self.assertTrue(
            any(event["stage"] == "batch_end" for event in detail["events"])
        )

    def test_pure_manual_material_is_not_applicable_while_old_extracted_material_is_missing(
        self,
    ):
        from notalone.memory.models import (
            AdoptionMethod,
            MemoryCandidate,
            MemoryCategory,
        )

        manual = self.memory.create_manual_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=self.scope,
                text="用户主动录入的合成资料",
                category=MemoryCategory.COMMON_FACT,
                source_ids=(uuid4(),),
            )
        )
        stored = self.memory.confirm(
            scope=self.scope,
            candidate_id=manual.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        self.assertEqual(
            self.traces.find_record(
                self.scope, "contact_memory", stored.memory_id
            )["availability"],
            "not_applicable",
        )
        old = self.memory.create_candidate(
            MemoryCandidate(
                candidate_id=uuid4(),
                scope=self.scope,
                text="旧合成候选",
                category=MemoryCategory.COMMON_FACT,
                source_ids=(self.message_ids[0],),
            )
        )
        older = self.memory.confirm(
            scope=self.scope,
            candidate_id=old.candidate_id,
            adoption_method=AdoptionMethod.MANUAL,
        )
        self.assertEqual(
            self.traces.find_record(
                self.scope, "contact_memory", older.memory_id
            )["availability"],
            "not_recorded",
        )
