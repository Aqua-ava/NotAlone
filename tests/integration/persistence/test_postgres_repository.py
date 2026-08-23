"""PostgreSQL 聊天记录导入事务集成测试。"""

from __future__ import annotations

import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg

from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.models import (
    ExistingContactSelection,
    ImportBatch,
    ImportConfirmationRequest,
    NewContactSelection,
)
from notalone.ingest.normalizer import normalize_document
from notalone.persistence.background_tasks import (
    BackgroundTaskStatus,
    BackgroundTaskNotFoundError,
    BackgroundTaskStepName,
    BackgroundTaskStepStatus,
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.postgres_repository import (
    ChannelIdentityConflictError,
    ImportPersistenceError,
    OverlappingSourceError,
    OwnerChannelIdentityConflictError,
    OwnerNotFoundError,
    PostgresIngestRepository,
    SourceStateConflictError,
)


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


class PostgresIngestRepositoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error

        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.repository = PostgresIngestRepository(TEST_DATABASE_URL)
        self.task_repository = PostgresBackgroundTaskRepository(TEST_DATABASE_URL)
        self.batch = self._load_batch()
        self.owner_ids: set[UUID] = set()

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            database_name = connection.execute(
                "SELECT current_database()"
            ).fetchone()[0]
            if not database_name.endswith("_test"):
                raise RuntimeError("拒绝清理非测试数据库。")
            for owner_id in self.owner_ids:
                connection.execute(
                    "DELETE FROM public.owner WHERE id = %s",
                    (owner_id,),
                )

    def test_imports_contact_source_and_messages_in_one_transaction(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")

        result = self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=self._confirmation(contact_id),
        )

        self.assertEqual(result.outcome, "imported")
        self.assertEqual(result.contact_id, contact_id)
        self.assertEqual(result.confirmation_method, "manual_select")
        self.assertNotEqual(
            str(result.channel_identity_id),
            self.batch.channel_identity.external_id,
        )
        self.assertEqual(result.message_count, 6)
        task = self.task_repository.get_task(
            owner_id=owner_id,
            contact_id=contact_id,
            task_id=result.task_id,
        )
        self.assertEqual(task.task_id, result.task_id)
        self.assertEqual(task.owner_id, owner_id)
        self.assertEqual(task.contact_id, contact_id)
        self.assertEqual(task.source_document_id, result.source_document_id)
        self.assertEqual(task.status, BackgroundTaskStatus.QUEUED)
        self.assertEqual(task.current_step, BackgroundTaskStepName.PARSE)
        self.assertEqual(task.message_count, 6)
        sensitive_columns = self._scalar(
            """
            SELECT count(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('background_task', 'background_task_step')
              AND column_name IN (
                  'text_content',
                  'raw_payload',
                  'model_input',
                  'model_output',
                  'prompt',
                  'response'
              )
            """,
            (),
        )
        self.assertEqual(sensitive_columns, 0)
        self.assertEqual(
            tuple(step.name for step in task.steps),
            (
                BackgroundTaskStepName.PARSE,
                BackgroundTaskStepName.NORMALIZE,
                BackgroundTaskStepName.EXTRACT_MEMORY,
                BackgroundTaskStepName.INDEX,
                BackgroundTaskStepName.VERIFY,
            ),
        )
        self.assertEqual(
            tuple(step.status for step in task.steps),
            (BackgroundTaskStepStatus.PENDING,) * 5,
        )
        self.assertEqual(self._count("contact", owner_id), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)
        self.assertEqual(
            self._scalar(
                "SELECT m.speaker FROM public.message AS m "
                "JOIN public.wechat_message_metadata AS wm "
                "ON wm.message_id = m.id "
                "WHERE m.owner_id = %s AND wm.external_local_id = 102",
                (owner_id,),
            ),
            "user",
        )

    def test_first_import_creates_contact_and_manual_confirmation(self) -> None:
        owner_id = self._create_owner("合成用户甲")

        result = self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=ImportConfirmationRequest(
                selection=NewContactSelection(display_name="新建合成联系人")
            ),
        )

        self.assertEqual(result.outcome, "imported")
        self.assertEqual(result.confirmation_method, "manual_create")
        self.assertEqual(self._count("contact", owner_id), 1)
        self.assertEqual(self._count("channel_identity", owner_id), 1)
        self.assertEqual(self._count("import_confirmation", owner_id), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)
        self.assertEqual(
            self._scalar(
                "SELECT display_name FROM public.contact "
                "WHERE owner_id = %s AND id = %s",
                (owner_id, result.contact_id),
            ),
            "新建合成联系人",
        )

    def test_wechat_fields_are_stored_as_adapter_metadata(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")

        result = self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=self._confirmation(contact_id),
        )

        with psycopg.connect(TEST_DATABASE_URL) as connection:
            stored = connection.execute(
                """
                SELECT
                    m.source_locator,
                    m.text_content,
                    m.media_placeholder,
                    wm.external_local_id,
                    wm.external_server_id,
                    wm.external_talker,
                    wm.source_create_time,
                    wm.raw_payload
                FROM public.message AS m
                JOIN public.wechat_message_metadata AS wm
                  ON wm.message_id = m.id
                WHERE m.source_document_id = %s
                  AND m.source_locator = 'jsonl:2'
                """,
                (result.source_document_id,),
            ).fetchone()
            old_columns = connection.execute(
                """
                SELECT count(*)
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'message'
                  AND column_name IN (
                      'external_local_id',
                      'external_server_id',
                      'external_talker',
                      'source_create_time',
                      'raw_payload'
                  )
                """
            ).fetchone()[0]

        self.assertEqual(stored[:7], (
            "jsonl:2",
            "",
            "[图片]",
            102,
            "server-102",
            "wxid_synthetic_contact",
            1786500060,
        ))
        self.assertEqual(stored[7]["text"], "[图片]")
        self.assertEqual(old_columns, 0)

    def test_known_media_placeholder_type_is_persisted(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        media_message = replace(
            self.batch.messages[0],
            message_type="voice",
            text_content="",
            media_placeholder="[语音] 5.2s",
        )
        media_batch = replace(
            self.batch,
            file_name="voice-placeholder.jsonl",
            content_sha256="e" * 64,
            messages=(media_message,),
        )

        self.repository.import_document(
            owner_id=owner_id,
            document=media_batch,
            confirmation=self._confirmation(contact_id),
        )

        self.assertEqual(
            self._scalar(
                "SELECT message_type || ':' || media_placeholder "
                "FROM public.message WHERE owner_id = %s",
                (owner_id,),
            ),
            "voice:[语音] 5.2s",
        )

    def test_same_file_is_idempotent(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        confirmation = self._confirmation(contact_id)

        first = self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=confirmation,
        )
        second = self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=confirmation,
        )

        self.assertEqual(first.outcome, "imported")
        self.assertEqual(second.outcome, "already_imported")
        self.assertEqual(first.source_document_id, second.source_document_id)
        self.assertEqual(first.confirmation_id, second.confirmation_id)
        self.assertEqual(first.task_id, second.task_id)
        self.assertEqual(second.message_count, 6)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)
        self.assertEqual(self._count("background_task", owner_id), 1)
        self.assertEqual(self._count("background_task_step", owner_id), 5)

    def test_different_file_with_existing_local_ids_is_rejected(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        confirmation = self._confirmation(contact_id)
        overlapping_batch = replace(
            self.batch,
            file_name="overlapping.jsonl",
            content_sha256="b" * 64,
        )
        self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=confirmation,
        )

        with self.assertRaises(OverlappingSourceError):
            self.repository.import_document(
                owner_id=owner_id,
                document=overlapping_batch,
                confirmation=confirmation,
            )

        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_different_file_with_reused_local_id_and_new_time_is_imported(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        confirmation = self._confirmation(contact_id)
        reused_batch = self._batch_with_reused_local_id()

        self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=confirmation,
        )
        result = self.repository.import_document(
            owner_id=owner_id,
            document=reused_batch,
            confirmation=confirmation,
        )

        self.assertEqual(result.outcome, "imported")
        self.assertEqual(result.message_count, 1)
        self.assertEqual(self._count("source_document", owner_id), 2)
        self.assertEqual(self._count("message", owner_id), 7)

    def test_concurrent_same_file_imports_only_one_source(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        confirmation = self._confirmation(contact_id)
        worker_count = 4
        barrier = Barrier(worker_count)

        def import_same_document() -> str:
            barrier.wait()
            return self.repository.import_document(
                owner_id=owner_id,
                document=self.batch,
                confirmation=confirmation,
            ).outcome

        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            outcomes = list(executor.map(lambda _: import_same_document(), range(4)))

        self.assertEqual(outcomes.count("imported"), 1)
        self.assertEqual(outcomes.count("already_imported"), 3)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)
        self.assertEqual(self._count("background_task", owner_id), 1)
        self.assertEqual(self._count("background_task_step", owner_id), 5)

    def test_concurrent_overlapping_files_import_only_one_source(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        confirmation = self._confirmation(contact_id)
        batches = (
            self.batch,
            replace(
                self.batch,
                file_name="overlapping.jsonl",
                content_sha256="c" * 64,
            ),
        )
        barrier = Barrier(2)

        def import_batch(batch: ImportBatch) -> str:
            barrier.wait()
            try:
                return self.repository.import_document(
                    owner_id=owner_id,
                    document=batch,
                    confirmation=confirmation,
                ).outcome
            except OverlappingSourceError:
                return "overlap"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(import_batch, batches))

        self.assertEqual(outcomes.count("imported"), 1)
        self.assertEqual(outcomes.count("overlap"), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_existing_contact_display_name_is_not_overwritten(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "人工修正名称")

        self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=self._confirmation(contact_id),
        )

        self.assertEqual(
            self._scalar(
                "SELECT display_name FROM public.contact "
                "WHERE owner_id = %s AND id = %s",
                (owner_id, contact_id),
            ),
            "人工修正名称",
        )

    def test_missing_owner_leaves_all_tables_unchanged(self) -> None:
        missing_owner_id = uuid4()
        contact_id = uuid4()
        with self.assertRaises(OwnerNotFoundError):
            self.repository.import_document(
                owner_id=missing_owner_id,
                document=self.batch,
                confirmation=self._confirmation(contact_id),
            )

        self.assertEqual(self._count("owner", missing_owner_id), 0)
        self.assertEqual(self._count("contact", missing_owner_id), 0)
        self.assertEqual(self._count("source_document", missing_owner_id), 0)
        self.assertEqual(self._count("message", missing_owner_id), 0)

    def test_message_failure_rolls_back_contact_source_and_prior_messages(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        invalid_message = replace(self.batch.messages[1], speaker="invalid")
        invalid_batch = replace(
            self.batch,
            messages=(self.batch.messages[0], invalid_message),
        )

        with self.assertRaises(ImportPersistenceError) as raised:
            self.repository.import_document(
                owner_id=owner_id,
                document=invalid_batch,
                confirmation=self._confirmation(contact_id),
            )

        self.assertEqual(str(raised.exception), "数据库导入失败，未写入任何数据。")
        self.assertEqual(self._count("contact", owner_id), 1)
        self.assertEqual(self._count("channel_identity", owner_id), 0)
        self.assertEqual(self._count("import_confirmation", owner_id), 0)
        self.assertEqual(self._count("source_document", owner_id), 0)
        self.assertEqual(self._count("message", owner_id), 0)
        self.assertEqual(self._count("wechat_message_metadata", owner_id), 0)
        self.assertEqual(self._count("background_task", owner_id), 0)
        self.assertEqual(self._count("background_task_step", owner_id), 0)

    def test_new_contact_is_rolled_back_when_message_import_fails(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        invalid_message = replace(self.batch.messages[1], speaker="invalid")
        invalid_batch = replace(
            self.batch,
            messages=(self.batch.messages[0], invalid_message),
        )

        with self.assertRaises(ImportPersistenceError):
            self.repository.import_document(
                owner_id=owner_id,
                document=invalid_batch,
                confirmation=ImportConfirmationRequest(
                    selection=NewContactSelection(display_name="新建合成联系人")
                ),
            )

        self.assertEqual(self._count("contact", owner_id), 0)
        self.assertEqual(self._count("channel_identity", owner_id), 0)
        self.assertEqual(self._count("import_confirmation", owner_id), 0)
        self.assertEqual(self._count("source_document", owner_id), 0)
        self.assertEqual(self._count("message", owner_id), 0)
        self.assertEqual(self._count("wechat_message_metadata", owner_id), 0)
        self.assertEqual(self._count("background_task", owner_id), 0)
        self.assertEqual(self._count("background_task_step", owner_id), 0)

    def test_task_failure_rolls_back_the_whole_import_transaction(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")

        with patch(
            "notalone.persistence.postgres_repository."
            "PostgresBackgroundTaskRepository.create_import_task",
            side_effect=RuntimeError("synthetic task failure"),
        ):
            with self.assertRaises(ImportPersistenceError):
                self.repository.import_document(
                    owner_id=owner_id,
                    document=self.batch,
                    confirmation=self._confirmation(contact_id),
                )

        self.assertEqual(self._count("channel_identity", owner_id), 0)
        self.assertEqual(self._count("import_confirmation", owner_id), 0)
        self.assertEqual(self._count("source_document", owner_id), 0)
        self.assertEqual(self._count("message", owner_id), 0)
        self.assertEqual(self._count("wechat_message_metadata", owner_id), 0)
        self.assertEqual(self._count("background_task", owner_id), 0)
        self.assertEqual(self._count("background_task_step", owner_id), 0)

    def test_invalid_raw_payload_rolls_back_without_exposing_content(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        metadata = self.batch.messages[0].wechat_metadata
        self.assertIsNotNone(metadata)
        invalid_message = replace(
            self.batch.messages[0],
            wechat_metadata=replace(
                metadata,
                raw_payload_json='{"private":"不应出现在错误信息中",',
            ),
        )
        invalid_batch = replace(self.batch, messages=(invalid_message,))

        with self.assertRaises(ImportPersistenceError) as raised:
            self.repository.import_document(
                owner_id=owner_id,
                document=invalid_batch,
                confirmation=self._confirmation(contact_id),
            )

        self.assertEqual(str(raised.exception), "数据库导入失败，未写入任何数据。")
        self.assertNotIn("不应出现在错误信息中", str(raised.exception))
        self.assertEqual(self._count("contact", owner_id), 1)
        self.assertEqual(self._count("channel_identity", owner_id), 0)
        self.assertEqual(self._count("import_confirmation", owner_id), 0)
        self.assertEqual(self._count("source_document", owner_id), 0)
        self.assertEqual(self._count("message", owner_id), 0)
        self.assertEqual(self._count("wechat_message_metadata", owner_id), 0)

    def test_non_active_duplicate_source_requires_explicit_resolution(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "已选合成联系人")
        confirmation = self._confirmation(contact_id)
        first = self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=confirmation,
        )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                UPDATE public.source_document
                SET status = 'delete_failed',
                    deletion_error_code = 'synthetic_failure'
                WHERE id = %s
                """,
                (first.source_document_id,),
            )

        with self.assertRaises(SourceStateConflictError):
            self.repository.import_document(
                owner_id=owner_id,
                document=self.batch,
                confirmation=confirmation,
            )

        self.assertEqual(self._count("source_document", owner_id), 1)
        self.assertEqual(self._count("message", owner_id), 6)

    def test_same_contact_id_is_isolated_between_owners(self) -> None:
        first_owner = self._create_owner("合成用户甲")
        second_owner = self._create_owner(
            "合成用户乙", external_id="wxid_synthetic_owner_2"
        )
        contact_id = uuid4()
        self._create_contact(first_owner, "已选合成联系人", contact_id=contact_id)
        self._create_contact(second_owner, "已选合成联系人", contact_id=contact_id)
        confirmation = self._confirmation(contact_id)

        first_result = self.repository.import_document(
            owner_id=first_owner,
            document=self.batch,
            confirmation=confirmation,
        )
        second_batch = replace(
            self.batch,
            owner_channel_identity=replace(
                self.batch.owner_channel_identity,
                external_id="wxid_synthetic_owner_2",
            ),
        )
        second_result = self.repository.import_document(
            owner_id=second_owner,
            document=second_batch,
            confirmation=confirmation,
        )

        self.assertEqual(self._count("contact", first_owner), 1)
        self.assertEqual(self._count("contact", second_owner), 1)
        self.assertEqual(self._count("source_document", first_owner), 1)
        self.assertEqual(self._count("source_document", second_owner), 1)
        self.assertEqual(self._count("background_task", first_owner), 1)
        self.assertEqual(self._count("background_task", second_owner), 1)
        with self.assertRaises(BackgroundTaskNotFoundError):
            self.task_repository.get_task(
                owner_id=second_owner,
                contact_id=contact_id,
                task_id=first_result.task_id,
            )
        self.assertNotEqual(first_result.task_id, second_result.task_id)
        self.assertEqual(
            self._scalar(
                "SELECT count(*) FROM public.message WHERE owner_id = %s",
                (first_owner,),
            ),
            6,
        )
        self.assertEqual(
            self._scalar(
                "SELECT count(*) FROM public.message WHERE owner_id = %s",
                (second_owner,),
            ),
            6,
        )

    def test_same_wechat_identity_cannot_bind_to_a_second_contact(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        first_contact_id = self._create_contact(owner_id, "合成联系人甲")
        second_contact_id = self._create_contact(owner_id, "合成联系人乙")
        self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=self._confirmation(first_contact_id),
        )

        with self.assertRaises(ChannelIdentityConflictError):
            self.repository.import_document(
                owner_id=owner_id,
                document=self.batch,
                confirmation=self._confirmation(second_contact_id),
            )

        self.assertEqual(self._count("channel_identity", owner_id), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)

    def test_existing_wechat_identity_prevents_creating_a_second_contact(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "合成联系人甲")
        self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=self._confirmation(contact_id),
        )

        with self.assertRaises(ChannelIdentityConflictError):
            self.repository.import_document(
                owner_id=owner_id,
                document=self.batch,
                confirmation=ImportConfirmationRequest(
                    selection=NewContactSelection(display_name="合成联系人乙")
                ),
            )

        self.assertEqual(self._count("contact", owner_id), 1)
        self.assertEqual(self._count("channel_identity", owner_id), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)

    def test_contact_cannot_silently_switch_wechat_identity(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "合成联系人甲")
        self.repository.import_document(
            owner_id=owner_id,
            document=self.batch,
            confirmation=self._confirmation(contact_id),
        )
        changed_identity_batch = replace(
            self.batch,
            channel_identity=replace(
                self.batch.channel_identity,
                external_id="wxid_other_synthetic_contact",
            ),
            file_name="other-synthetic.jsonl",
            content_sha256="c" * 64,
        )

        with self.assertRaises(ChannelIdentityConflictError):
            self.repository.import_document(
                owner_id=owner_id,
                document=changed_identity_batch,
                confirmation=self._confirmation(contact_id),
            )

        self.assertEqual(self._count("channel_identity", owner_id), 1)
        self.assertEqual(self._count("source_document", owner_id), 1)

    def test_owner_cannot_silently_switch_wechat_identity(self) -> None:
        owner_id = self._create_owner("合成用户甲")
        contact_id = self._create_contact(owner_id, "合成联系人甲")
        changed_identity_batch = replace(
            self.batch,
            owner_channel_identity=replace(
                self.batch.owner_channel_identity,
                external_id="wxid_other_synthetic_owner",
            ),
            content_sha256="f" * 64,
        )

        with self.assertRaises(OwnerChannelIdentityConflictError):
            self.repository.import_document(
                owner_id=owner_id,
                document=changed_identity_batch,
                confirmation=self._confirmation(contact_id),
            )

        self.assertEqual(self._count("source_document", owner_id), 0)
        self.assertEqual(self._count("message", owner_id), 0)

    def test_overlap_unique_constraint_exists(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            constraint = connection.execute(
                """
                SELECT pg_get_constraintdef(oid)
                FROM pg_constraint
                WHERE conrelid = 'public.wechat_message_metadata'::regclass
                  AND conname = 'wechat_message_metadata_contact_local_time_unique'
                """
            ).fetchone()

        self.assertIsNotNone(constraint)
        self.assertEqual(
            constraint[0],
            "UNIQUE (owner_id, contact_id, external_local_id, source_create_time)",
        )

    def _batch_with_reused_local_id(self) -> ImportBatch:
        first_metadata = self.batch.messages[0].wechat_metadata
        reused_message = self.batch.messages[1]
        reused_metadata = reused_message.wechat_metadata
        self.assertIsNotNone(first_metadata)
        self.assertIsNotNone(reused_metadata)

        raw_payload = json.loads(reused_metadata.raw_payload_json)
        raw_payload["id"]["local_id"] = first_metadata.external_local_id
        updated_metadata = replace(
            reused_metadata,
            external_local_id=first_metadata.external_local_id,
            raw_payload_json=json.dumps(
                raw_payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
        )
        return replace(
            self.batch,
            file_name="reused-local-id.jsonl",
            content_sha256="d" * 64,
            messages=(replace(reused_message, wechat_metadata=updated_metadata),),
        )

    @staticmethod
    def _load_batch() -> ImportBatch:
        document = read_jsonl(FIXTURES_DIR / "valid_single_contact.jsonl")
        return normalize_document(document)

    def _create_owner(
        self,
        display_name: str,
        *,
        external_id: str = "wxid_synthetic_owner",
    ) -> UUID:
        return self._create_owner_with_identity(
            display_name, external_id=external_id
        )

    def _create_owner_with_identity(
        self, display_name: str, *, external_id: str
    ) -> UUID:
        owner_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (owner_id, display_name),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity "
                "(owner_id, channel, external_id, observed_name) "
                "VALUES (%s, 'wechat', %s, %s)",
                (owner_id, external_id, display_name),
            )
        self.owner_ids.add(owner_id)
        return owner_id

    @staticmethod
    def _create_contact(
        owner_id: UUID,
        display_name: str,
        *,
        contact_id: UUID | None = None,
    ) -> UUID:
        selected_contact_id = contact_id or uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (owner_id, selected_contact_id, display_name),
            )
        return selected_contact_id

    @staticmethod
    def _confirmation(contact_id: UUID) -> ImportConfirmationRequest:
        return ImportConfirmationRequest(
            selection=ExistingContactSelection(contact_id=contact_id)
        )

    @staticmethod
    def _count(table_name: str, owner_id: UUID) -> int:
        allowed_tables = {
            "owner",
            "contact",
            "channel_identity",
            "source_document",
            "import_confirmation",
            "message",
            "wechat_message_metadata",
            "background_task",
            "background_task_step",
        }
        if table_name not in allowed_tables:
            raise ValueError("不允许查询未知表。")
        if table_name == "background_task_step":
            query = (
                "SELECT count(*) FROM public.background_task_step AS step "
                "JOIN public.background_task AS task ON task.id = step.task_id "
                "WHERE task.owner_id = %s"
            )
        else:
            owner_column = "id" if table_name == "owner" else "owner_id"
            query = (
                f"SELECT count(*) FROM public.{table_name} "
                f"WHERE {owner_column} = %s"
            )
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(query, (owner_id,)).fetchone()[0]

    @staticmethod
    def _scalar(query: str, parameters: tuple[object, ...]) -> object:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            return connection.execute(query, parameters).fetchone()[0]


if __name__ == "__main__":
    unittest.main()
