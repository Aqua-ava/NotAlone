"""通过导入与查询入口核对真实来源处理，不读取私人资料。"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import psycopg

from notalone.ingest.import_command import import_file
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportConfirmationRequest,
)
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.persistence.source_processing import (
    PostgresSourceProcessingStore,
)
from notalone.scopes import ContactScope

DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")


class SourceProcessingTraceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式提供本任务隔离测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[
                0
            ]
        if not name.endswith("_test"):
            raise RuntimeError("来源处理测试只允许隔离测试库。")

    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.owner_external_id = f"synthetic_owner_{uuid4().hex}"
        self.contact_external_id = f"synthetic_contact_{uuid4().hex}"
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成用户')",
                (self.scope.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) VALUES (%s, %s, '合成联系人')",
                (self.scope.owner_id, self.scope.contact_id),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity (owner_id, channel, external_id, observed_name) VALUES (%s, 'wechat', %s, '合成用户')",
                (self.scope.owner_id, self.owner_external_id),
            )
        self.addCleanup(self.cleanup)
        self.repository = PostgresIngestRepository(DATABASE_URL)
        self.processing = PostgresSourceProcessingStore(DATABASE_URL)
        self.confirmation = ImportConfirmationRequest(
            ExistingContactSelection(self.scope.contact_id)
        )

    def cleanup(self):
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id=%s", (self.scope.owner_id,)
            )

    def records(self):
        return [
            {
                "id": {
                    "local_id": 101,
                    "server_id_str": "synthetic-101",
                    "talker": self.contact_external_id,
                },
                "create_time": 1786500000,
                "is_from_me": False,
                "kind": "text",
                "sender": "合成联系人",
                "sender_wxid": self.contact_external_id,
                "text": "  合成原话，保留空白  ",
                "time": "2026-08-12 10:00:00",
                "time_iso": "2026-08-12T10:00:00+08:00",
                "extra": {"synthetic": True},
            },
            {
                "id": {
                    "local_id": 102,
                    "server_id_str": "synthetic-102",
                    "talker": self.contact_external_id,
                },
                "create_time": 1786500060,
                "is_from_me": True,
                "kind": "text",
                "sender": "合成用户",
                "sender_wxid": self.owner_external_id,
                "text": "合成回答",
                "time": "2026-08-12 10:01:00",
                "time_iso": "2026-08-12T10:01:00+08:00",
            },
        ]

    def import_lines(self, lines):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_bytes("".join(lines).encode("utf-8"))
            return import_file(
                path=path,
                owner_id=self.scope.owner_id,
                confirmation=self.confirmation,
                repository=self.repository,
            )

    def test_confirmed_import_reveals_exact_record_and_actual_conversions(
        self,
    ):
        records = self.records()
        lines = [
            "  " + json.dumps(records[0], ensure_ascii=False) + "  \r\n",
            json.dumps(records[1], ensure_ascii=False) + "\n",
        ]
        before = datetime.now(timezone.utc)
        result = self.import_lines(lines)
        after = datetime.now(timezone.utc)
        batches = self.processing.list_batches(self.scope)
        self.assertEqual(len(batches), 1)
        detail = self.processing.get_batch(self.scope, batches[0]["batch_id"])
        self.assertEqual(detail["source_id"], str(result.source_document_id))
        first = detail["records"][0]
        self.assertEqual(first["locator"], "jsonl:1")
        self.assertEqual(first["payload"]["record_text"], lines[0])
        self.assertEqual(first["payload"]["parsed"], records[0])
        self.assertEqual(
            first["payload"]["capture_layer"], "jsonl_record_text"
        )
        self.assertEqual(first["payload"]["converted"]["speaker"], "contact")
        self.assertEqual(
            first["payload"]["converted"]["occurred_at"],
            "2026-08-12T10:00:00+08:00",
        )
        self.assertEqual(
            first["payload"]["converted"]["text_content"],
            "  合成原话，保留空白  ",
        )
        self.assertTrue(first["message_id"])
        self.assertTrue(first["source_ref_id"])
        self.assertEqual(first["outcome"], "message_created")
        self.assertEqual(first["payload"]["model_read_status"], "not_claimed")
        for stage in ("parse", "normalize"):
            execution = first["payload"][stage]
            self.assertGreaterEqual(
                datetime.fromisoformat(execution["started_at"]), before
            )
            self.assertLessEqual(
                datetime.fromisoformat(execution["finished_at"]), after
            )
            self.assertTrue(execution["rule_version"])

    def test_imported_record_is_connected_to_actual_extraction_window(self):
        from notalone.memory_extraction.cli_support import (
            load_contact_messages,
        )
        from notalone.memory_extraction.command import run_extraction
        from notalone.persistence.extraction_trace import (
            PostgresExtractionTraceStore,
        )
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.persistence.owner_memory_store import (
            PostgresOwnerMemoryStore,
        )
        from notalone.persistence.watermark_store import PostgresWatermarkStore

        lines = [
            json.dumps(record, ensure_ascii=False) + "\n"
            for record in self.records()
        ]
        self.import_lines(lines)
        messages = load_contact_messages(self.scope, DATABASE_URL)
        original = messages[0].source_snapshots[0]
        self.assertEqual(original["processing_status"], "recorded")
        self.assertEqual(
            original["processing_record"]["payload"]["record_text"], lines[0]
        )

        class ZeroCandidateRuntime:
            def extract(self, window):
                return ()

        traces = PostgresExtractionTraceStore(DATABASE_URL)
        run_extraction(
            scope=self.scope,
            messages=messages,
            watermark_message_id=None,
            runtime=ZeroCandidateRuntime(),
            memory_port=PostgresMemoryStore(DATABASE_URL),
            owner_memory_port=PostgresOwnerMemoryStore(DATABASE_URL),
            watermark_port=PostgresWatermarkStore(DATABASE_URL),
            trace_store=traces,
        )
        detail = traces.get_batch(
            self.scope, traces.list_batches(self.scope)[0]["trace_id"]
        )
        window = next(
            event["payload"]
            for event in detail["events"]
            if event["stage"] == "window"
        )
        self.assertEqual(
            window["messages"][0]["source_snapshots"][0]["processing_record"][
                "payload"
            ]["record_text"],
            lines[0],
        )
        self.assertEqual(
            original["processing_record"]["payload"]["model_read_status"],
            "not_claimed",
        )

    def test_repeat_import_records_reused_message_and_source_reference(self):
        lines = [
            json.dumps(record, ensure_ascii=False) + "\n"
            for record in self.records()
        ]
        first = self.import_lines(lines)
        second = self.import_lines(lines)
        self.assertEqual(second.source_document_id, first.source_document_id)
        self.assertEqual(second.outcome, "already_imported")
        batches = self.processing.list_batches(self.scope)
        self.assertEqual(len(batches), 2)
        repeated = self.processing.get_batch(
            self.scope, batches[0]["batch_id"]
        )
        self.assertEqual(
            [row["outcome"] for row in repeated["records"]],
            ["source_and_message_reused", "source_and_message_reused"],
        )
        self.assertFalse(
            repeated["records"][0]["payload"]["persistence"][
                "source_ref_added"
            ]
        )

    def test_source_deletion_erases_source_processing_body_in_same_public_operation(
        self,
    ):
        from notalone.persistence.source_deletion import (
            PostgresSourceDeletionRepository,
        )

        lines = [
            json.dumps(record, ensure_ascii=False) + "\n"
            for record in self.records()
        ]
        imported = self.import_lines(lines)
        batch = self.processing.get_batch(
            self.scope, self.processing.list_batches(self.scope)[0]["batch_id"]
        )
        message_id = batch["records"][0]["message_id"]
        PostgresSourceDeletionRepository(DATABASE_URL).delete_source(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            source_document_id=imported.source_document_id,
        )
        deleted = self.processing.get_batch(self.scope, batch["batch_id"])
        self.assertEqual(deleted["status"], "deleted")
        self.assertTrue(
            all(
                row["payload"] is None and row["locator"] is None
                for row in deleted["records"]
            )
        )
        self.assertEqual(
            self.processing.find_record(self.scope, "message", message_id)[
                "availability"
            ],
            "deleted",
        )

    def test_manual_processing_deletion_clears_copied_trace_but_preserves_messages(
        self,
    ):
        from notalone.memory_extraction.cli_support import (
            load_contact_messages,
        )
        from notalone.persistence.extraction_trace import (
            PostgresExtractionTraceStore,
        )

        self.test_imported_record_is_connected_to_actual_extraction_window()
        traces = PostgresExtractionTraceStore(DATABASE_URL)
        trace_id = traces.list_batches(self.scope)[0]["trace_id"]
        batch_id = self.processing.list_batches(self.scope)[0]["batch_id"]
        self.processing.delete_batch(self.scope, batch_id)
        detail = traces.get_batch(self.scope, trace_id)
        self.assertEqual(detail["status"], "deleted")
        self.assertEqual(detail["events"], [])
        messages = load_contact_messages(self.scope, DATABASE_URL)
        self.assertEqual(len(messages), 2)
        self.assertEqual(
            messages[0].source_snapshots[0]["processing_status"], "deleted"
        )
        self.assertIsNone(
            messages[0].source_snapshots[0]["processing_record"]["payload"]
        )

    def test_cached_original_record_cannot_reappear_after_manual_deletion(
        self,
    ):
        from notalone.memory_extraction.cli_support import (
            load_contact_messages,
        )
        from notalone.memory_extraction.command import run_extraction
        from notalone.memory_trace.ports import TraceWriteError
        from notalone.persistence.extraction_trace import (
            PostgresExtractionTraceStore,
        )
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.persistence.owner_memory_store import (
            PostgresOwnerMemoryStore,
        )
        from notalone.persistence.watermark_store import PostgresWatermarkStore

        self.import_lines(
            [
                json.dumps(record, ensure_ascii=False) + "\n"
                for record in self.records()
            ]
        )
        cached = load_contact_messages(self.scope, DATABASE_URL)
        self.processing.delete_batch(
            self.scope, self.processing.list_batches(self.scope)[0]["batch_id"]
        )

        class ForbiddenRuntime:
            def extract(self, window):
                raise AssertionError("已删除原行的缓存不能进入模型。")

        traces = PostgresExtractionTraceStore(DATABASE_URL)
        with self.assertRaises(TraceWriteError):
            run_extraction(
                scope=self.scope,
                messages=cached,
                watermark_message_id=None,
                runtime=ForbiddenRuntime(),
                memory_port=PostgresMemoryStore(DATABASE_URL),
                owner_memory_port=PostgresOwnerMemoryStore(DATABASE_URL),
                watermark_port=PostgresWatermarkStore(DATABASE_URL),
                trace_store=traces,
            )
        self.assertEqual(traces.list_batches(self.scope), ())

    def test_confirmed_cli_records_before_projection_and_filters_media_without_body(
        self,
    ):
        from notalone.persistence.conversation_repository import (
            PostgresConversationBindingRepository,
        )
        from notalone.persistence.observation_store import (
            ObservationMode,
            PostgresObservationStore,
        )
        from notalone.wechat_cli import LocalWechatCli
        from notalone.wechat_cli.normalizer import normalize_cli_events
        from tests.integration.front_sync.cli_fakes import ScriptedCliRunner

        binding = PostgresConversationBindingRepository(
            DATABASE_URL
        ).create_binding(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            channel="wechat",
            account_scope="synthetic",
            conversation_locator=self.contact_external_id,
        )
        runner = ScriptedCliRunner()
        text_event = {
            "type": "message",
            "cursor": "synthetic:201",
            "message": {
                "id": {"local_id": 201, "talker": self.contact_external_id},
                "kind": "text",
                "text": "合成CLI原话",
                "is_from_me": True,
                "time_iso": "2026-08-12T10:00:00",
                "extra_before_projection": "合成额外字段",
            },
        }
        first_line = (
            "  " + json.dumps(text_event, ensure_ascii=False) + "  \r\n"
        )
        media_event = {
            "type": "message",
            "cursor": "synthetic:202",
            "message": {
                "id": {"local_id": 202, "talker": self.contact_external_id},
                "kind": "image",
                "text": "不保存的合成媒体正文",
                "images": ["不保存的合成路径"],
            },
        }
        runner.tail_queues[self.contact_external_id].append(
            first_line + json.dumps(media_event, ensure_ascii=False) + "\n"
        )
        result = LocalWechatCli(runner=runner).tail(self.contact_external_id)
        receipts = []
        messages = normalize_cli_events(
            result.events, processing_receipts=receipts
        )
        PostgresObservationStore(DATABASE_URL).record_batch_with_messages(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            binding_id=binding.binding_id,
            mode=ObservationMode.CLI_BACKGROUND,
            cli_version="synthetic-1",
            conversation_locator=self.contact_external_id,
            last_local_id=result.last_local_id,
            last_cursor=result.cursor,
            record_count=len(messages),
            event_count=result.event_count,
            non_text_count=result.non_text_count,
            messages=messages,
            processing_records=tuple(receipts) + result.filtered_records,
        )
        detail = self.processing.get_batch(
            self.scope, self.processing.list_batches(self.scope)[0]["batch_id"]
        )
        text_record = next(
            row for row in detail["records"] if row["locator"] == "cli:201"
        )
        self.assertEqual(text_record["payload"]["record_text"], first_line)
        self.assertEqual(text_record["payload"]["parsed"], text_event)
        self.assertEqual(
            text_record["payload"]["converted"]["speaker"], "user"
        )
        self.assertEqual(
            text_record["payload"]["converted"]["occurred_at"],
            "2026-08-12T10:00:00+00:00",
        )
        media = next(
            row for row in detail["records"] if row["locator"] == "cli:202"
        )
        self.assertEqual(media["outcome"], "non_text_filtered")
        self.assertIsNone(media["message_id"])
        self.assertNotIn(
            "不保存的合成媒体正文", json.dumps(detail, ensure_ascii=False)
        )
        self.assertNotIn(
            "不保存的合成路径", json.dumps(detail, ensure_ascii=False)
        )

    def test_cli_cannot_attach_another_talker_body_to_confirmed_binding(self):
        from notalone.persistence.conversation_repository import (
            PostgresConversationBindingRepository,
        )
        from notalone.persistence.observation_store import (
            ObservationMode,
            ObservationPersistenceError,
            PostgresObservationStore,
        )
        from notalone.wechat_cli.models import (
            CliMessageEvent,
            MessageIdentifier,
        )
        from notalone.wechat_cli.normalizer import normalize_cli_events

        binding = PostgresConversationBindingRepository(
            DATABASE_URL
        ).create_binding(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            channel="wechat",
            account_scope="synthetic",
            conversation_locator=self.contact_external_id,
        )
        event = CliMessageEvent(
            MessageIdentifier(201, "another_synthetic_talker"),
            "其他合成会话正文",
            "text",
            None,
            None,
            False,
            1786500000,
            None,
            None,
        )
        messages = normalize_cli_events((event,))
        with self.assertRaises(ObservationPersistenceError):
            PostgresObservationStore(DATABASE_URL).record_batch_with_messages(
                owner_id=self.scope.owner_id,
                contact_id=self.scope.contact_id,
                binding_id=binding.binding_id,
                mode=ObservationMode.CLI_BACKGROUND,
                cli_version="synthetic-1",
                conversation_locator=self.contact_external_id,
                last_local_id=201,
                last_cursor="synthetic:201",
                record_count=1,
                messages=messages,
            )
        self.assertEqual(self.processing.list_batches(self.scope), ())

    def test_background_sync_persists_each_filtered_event_and_reuse_receipt(
        self,
    ):
        from notalone.front_sync.cli_sync import CliBackgroundSync
        from notalone.persistence.conversation_repository import (
            PostgresConversationBindingRepository,
        )
        from notalone.persistence.observation_store import (
            PostgresObservationStore,
        )
        from notalone.wechat_cli import LocalWechatCli
        from tests.integration.front_sync.cli_fakes import (
            ScriptedCliRunner,
            tail_stdout,
        )

        bindings = PostgresConversationBindingRepository(DATABASE_URL)
        binding = bindings.create_binding(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            channel="wechat",
            account_scope="synthetic",
            conversation_locator=self.contact_external_id,
        )
        runner = ScriptedCliRunner()
        text = (
            tail_stdout(
                self.contact_external_id, [(201, "合成同步原话", False)]
            )
            + "\n"
        )
        media = (
            json.dumps(
                {
                    "type": "message",
                    "cursor": "synthetic:202",
                    "message": {
                        "id": {
                            "local_id": 202,
                            "talker": self.contact_external_id,
                        },
                        "kind": "video",
                        "text": "不保存的合成视频正文",
                    },
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        runner.tail_queues[self.contact_external_id].append(text + media)
        runner.tail_queues[self.contact_external_id].append(text + media)
        sync = CliBackgroundSync(
            owner_id=self.scope.owner_id,
            channel="wechat",
            account_scope="synthetic",
            cli=LocalWechatCli(runner=runner),
            bindings=bindings,
            observation_store=PostgresObservationStore(DATABASE_URL),
        )
        self.addCleanup(sync.close)
        sync.cycle(enabled=True)
        first = self.processing.get_batch(
            self.scope, self.processing.list_batches(self.scope)[0]["batch_id"]
        )
        self.assertEqual(
            [row["outcome"] for row in first["records"]],
            ["message_created", "non_text_filtered"],
        )
        sync.request_safety_sweep()
        sync.cycle(enabled=True)
        second = self.processing.get_batch(
            self.scope, self.processing.list_batches(self.scope)[0]["batch_id"]
        )
        self.assertEqual(second["records"][0]["outcome"], "message_reused")
        self.assertTrue(
            second["records"][0]["payload"]["persistence"]["source_ref_added"]
        )
        self.assertEqual(
            second["records"][0]["message_id"],
            first["records"][0]["message_id"],
        )

    def test_invalid_import_records_only_real_failure_location_without_body(
        self,
    ):
        from notalone.ingest.errors import ImportPreviewError

        with self.assertRaises(ImportPreviewError):
            self.import_lines(
                [
                    json.dumps(self.records()[0], ensure_ascii=False) + "\n",
                    '{"text":"不得存储的合成损坏正文"\n',
                ]
            )
        batches = self.processing.list_batches(self.scope)
        self.assertEqual(len(batches), 1)
        detail = self.processing.get_batch(self.scope, batches[0]["batch_id"])
        self.assertEqual(detail["status"], "failed")
        self.assertIsNone(detail["source_id"])
        failure = detail["records"][0]
        self.assertEqual(failure["locator"], "jsonl:2")
        self.assertEqual(failure["outcome"], "input_rejected")
        self.assertEqual(
            failure["payload"]["capture_status"], "withheld_unverified_input"
        )
        self.assertNotIn(
            "不得存储的合成损坏正文", json.dumps(detail, ensure_ascii=False)
        )
        self.assertNotIn("合成原话", json.dumps(detail, ensure_ascii=False))

    def test_observation_deletion_clears_record_without_destroying_other_source(
        self,
    ):
        from notalone.persistence.observation_store import (
            PostgresObservationStore,
        )

        self.test_background_sync_persists_each_filtered_event_and_reuse_receipt()
        batches = self.processing.list_batches(self.scope)
        selected = self.processing.get_batch(
            self.scope, batches[0]["batch_id"]
        )
        other = self.processing.get_batch(self.scope, batches[1]["batch_id"])
        PostgresObservationStore(DATABASE_URL).delete_observation(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            observation_id=__import__("uuid").UUID(selected["source_id"]),
        )
        deleted = self.processing.get_batch(self.scope, selected["batch_id"])
        self.assertEqual(deleted["status"], "deleted")
        self.assertTrue(
            all(row["payload"] is None for row in deleted["records"])
        )
        self.assertEqual(
            self.processing.get_batch(self.scope, other["batch_id"])["status"],
            "recorded",
        )

    def test_foreground_poll_keeps_media_filter_record_without_body(self):
        from notalone.conversation.matcher import FrontSessionEvidence
        from notalone.front_sync.tail_lifecycle import TailLifecycle
        from notalone.persistence.conversation_repository import (
            PostgresConversationBindingRepository,
        )
        from notalone.persistence.front_sync_state import (
            PostgresFrontSyncStateStore,
        )
        from notalone.persistence.observation_store import (
            PostgresObservationStore,
        )
        from notalone.wechat_cli import LocalWechatCli
        from tests.integration.front_sync.cli_fakes import (
            ScriptedCliRunner,
            candidate_json,
            tail_stdout,
        )

        bindings = PostgresConversationBindingRepository(DATABASE_URL)
        binding = bindings.create_binding(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            channel="wechat",
            account_scope="synthetic",
            conversation_locator=self.contact_external_id,
            display_name="合成联系人",
        )
        runner = ScriptedCliRunner()
        text = (
            tail_stdout(
                self.contact_external_id,
                [(201, "合成前台观察", False)],
                base_time=2000000000,
            )
            + "\n"
        )
        media = (
            json.dumps(
                {
                    "type": "message",
                    "cursor": "synthetic:202",
                    "message": {
                        "id": {
                            "local_id": 202,
                            "talker": self.contact_external_id,
                        },
                        "kind": "voice",
                        "text": "不保存的合成语音内容",
                    },
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        runner.tail_queues[self.contact_external_id].append(text + media)
        runner.candidates_by_query["合成联系人"] = [
            candidate_json(self.contact_external_id, "合成联系人")
        ]
        lifecycle = TailLifecycle(
            owner_id=self.scope.owner_id,
            channel="wechat",
            account_scope="synthetic",
            cli=LocalWechatCli(runner=runner),
            bindings=bindings,
            observation_store=PostgresObservationStore(DATABASE_URL),
            sync_state=PostgresFrontSyncStateStore(DATABASE_URL),
            clock=lambda: 1000000000.0,
        )
        self.addCleanup(lifecycle.close)
        lifecycle.enable_sync()
        lifecycle.observe_front_session(
            wechat_in_front=True,
            evidence=FrontSessionEvidence(display_name="合成联系人"),
        )
        lifecycle.poll()
        detail = self.processing.get_batch(
            self.scope, self.processing.list_batches(self.scope)[0]["batch_id"]
        )
        self.assertEqual(
            [row["outcome"] for row in detail["records"]],
            ["message_created", "non_text_filtered"],
        )
        self.assertNotIn(
            "不保存的合成语音内容", json.dumps(detail, ensure_ascii=False)
        )

    def test_cli_parse_failure_reveals_only_position_and_does_not_advance_cursor(
        self,
    ):
        from notalone.front_sync.cli_sync import CliBackgroundSync
        from notalone.persistence.conversation_repository import (
            PostgresConversationBindingRepository,
        )
        from notalone.persistence.observation_store import (
            PostgresObservationStore,
        )
        from notalone.wechat_cli import LocalWechatCli
        from tests.integration.front_sync.cli_fakes import ScriptedCliRunner

        bindings = PostgresConversationBindingRepository(DATABASE_URL)
        binding = bindings.create_binding(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            channel="wechat",
            account_scope="synthetic",
            conversation_locator=self.contact_external_id,
        )
        runner = ScriptedCliRunner()
        runner.tail_queues[self.contact_external_id].append(
            '{"type":"message","text":"不保存的损坏CLI正文"\n'
        )
        observations = PostgresObservationStore(DATABASE_URL)
        sync = CliBackgroundSync(
            owner_id=self.scope.owner_id,
            channel="wechat",
            account_scope="synthetic",
            cli=LocalWechatCli(runner=runner),
            bindings=bindings,
            observation_store=observations,
        )
        self.addCleanup(sync.close)
        result = sync.cycle(enabled=True)
        self.assertEqual(result.status.failure_code, "cli_output_invalid")
        batches = self.processing.list_batches(self.scope)
        self.assertEqual(len(batches), 1)
        detail = self.processing.get_batch(self.scope, batches[0]["batch_id"])
        self.assertEqual(detail["status"], "failed")
        self.assertEqual(detail["records"][0]["locator"], "cli_event:1")
        self.assertNotIn(
            "不保存的损坏CLI正文", json.dumps(detail, ensure_ascii=False)
        )
        self.assertIsNone(
            observations.read_cursor(
                owner_id=self.scope.owner_id, contact_id=self.scope.contact_id
            )
        )


if __name__ == "__main__":
    unittest.main()
