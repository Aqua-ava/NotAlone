"""CLI 来源定位需区分同编号不同时间的消息；仅使用合成资料与隔离库。"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.persistence.observation_store import ObservationMode, ObservationNotFoundError
from notalone.persistence.history_sync_state import (
    HistoryPageCheckpoint,
    PostgresHistorySyncStateStore,
)
from notalone.persistence.source_processing import SourceProcessingWriteError
from notalone.source_processing.models import ProcessingRecord
from tests.integration.persistence import test_observation_store as observations


class CliSourceLocatorIdentityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        observations.PostgresObservationStoreTest.setUpClass()

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="notalone-locator-behavior-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for child in ("managed", "skills"):
            (root / child).mkdir(mode=0o700)
        environment = patch.dict(os.environ, {
            "NOTALONE_MANAGED_USER_DATA": str(root / "managed"),
            "NOTALONE_SKILLS_DIR": str(root / "skills"),
            "OPENAI_API_KEY": "",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.fixture = observations.PostgresObservationStoreTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def message(self, stamp: int | None, *, local_id: int = 7, talker="wxid_observation_a"):
        text = f"合成消息{stamp}"
        return NormalizedMessage(
            source_locator=f"cli:{local_id}", speaker="contact", message_type="text",
            text_content=text, media_placeholder=None, occurred_at=None,
            wechat_metadata=WechatMessageMetadata(
                external_local_id=local_id, external_server_id=f"synthetic-server-{stamp}",
                external_talker=talker, source_create_time=stamp,
                raw_payload_json=json.dumps({"text": text}),
            ),
            processing_record=ProcessingRecord.capture(f"cli:{local_id}", {
                "capture_layer": "parsed_only", "record_text": None,
                "parsed": {"local_id": local_id, "create_time": stamp, "text": text},
                "outcome": "normalized",
            }),
        )

    def write(self, messages, *, cursor="opaque:first", binding=None, checkpoint=None):
        binding = binding or self.fixture.binding_a
        previous = None if checkpoint else self.fixture.store.read_cursor(
            owner_id=binding.scope.owner_id, contact_id=binding.scope.contact_id,
        )
        return self.fixture.store.record_batch_with_messages(
            owner_id=binding.scope.owner_id, contact_id=binding.scope.contact_id,
            binding_id=binding.binding_id,
            mode=ObservationMode.CLI_HISTORY if checkpoint else ObservationMode.CLI_BACKGROUND,
            cli_version="synthetic-locator", conversation_locator=binding.conversation_locator,
            since_local_id=previous.last_local_id if previous else None,
            since_cursor=previous.last_cursor if previous else None,
            last_local_id=messages[-1].wechat_metadata.external_local_id,
            last_cursor=cursor, cursor_ordered=True, advance_cursor=checkpoint is None,
            record_count=len(messages), event_count=len(messages), non_text_count=0,
            messages=messages, history_checkpoint=checkpoint,
        )

    def rows(self, statement, parameters=()):
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            return connection.execute(statement, parameters).fetchall()

    def refs(self, observation_id):
        return self.rows(
            "SELECT id,message_id,source_locator,raw_payload FROM public.message_source_ref "
            "WHERE owner_id=%s AND contact_id=%s AND observation_id=%s ORDER BY id",
            (self.fixture.owner_id, self.fixture.contact_a, observation_id),
        )

    def start_history(self):
        history = PostgresHistorySyncStateStore(observations.TEST_DATABASE_URL)
        history.ensure_bindings_started(
            owner_id=self.fixture.owner_id, channel="wechat", account_scope="synthetic-account",
            binding_ids=(self.fixture.binding_a.binding_id,),
            watermark_at=datetime(2026, 10, 23, tzinfo=timezone.utc),
        )
        return history

    def history_state(self, history):
        return history.read(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_a,
            binding_id=self.fixture.binding_a.binding_id,
        )

    def counts(self):
        return {
            table: self.rows(
                f"SELECT count(*) FROM public.{table} WHERE owner_id=%s AND contact_id=%s",
                (self.fixture.owner_id, self.fixture.contact_a),
            )[0][0]
            for table in ("message", "message_source_ref", "local_wechat_observation",
                          "source_processing_batch", "source_processing_record")
        }

    def test_same_local_id_with_distinct_times_keeps_both_messages_and_refs(self) -> None:
        messages = tuple(
            NormalizedMessage(
                source_locator="cli:7",
                speaker="contact",
                message_type="text",
                text_content=f"合成消息{stamp}",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=7,
                    external_server_id=f"synthetic-server-{stamp}",
                    external_talker="wxid_observation_a",
                    source_create_time=stamp,
                    raw_payload_json='{"text":"合成来源"}',
                ),
            )
            for stamp in (1000, 2000)
        )
        self.fixture.store.record_batch_with_messages(
            owner_id=self.fixture.owner_id,
            contact_id=self.fixture.contact_a,
            binding_id=self.fixture.binding_a.binding_id,
            mode=ObservationMode.CLI_BACKGROUND,
            cli_version="synthetic-locator",
            conversation_locator="wxid_observation_a",
            since_local_id=None,
            last_local_id=7,
            last_cursor="opaque:two-messages",
            cursor_ordered=True,
            record_count=2,
            event_count=2,
            non_text_count=0,
            messages=messages,
        )
        with psycopg.connect(observations.TEST_DATABASE_URL) as connection:
            rows = connection.execute(
                """
                SELECT message.id, ref.source_locator, metadata.source_create_time
                FROM public.message AS message
                JOIN public.message_source_ref AS ref ON ref.message_id=message.id
                JOIN public.wechat_message_metadata AS metadata ON metadata.message_id=message.id
                WHERE message.owner_id=%s AND message.contact_id=%s
                ORDER BY metadata.source_create_time
                """,
                (self.fixture.owner_id, self.fixture.contact_a),
            ).fetchall()
        self.assertEqual([row[2] for row in rows], [1000, 2000])
        self.assertEqual(len({row[0] for row in rows}), 2)
        self.assertEqual(len({row[1] for row in rows}), 2)
        cursor = self.fixture.store.read_cursor(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_a,
        )
        self.assertEqual(cursor.last_cursor, "opaque:two-messages")

    def test_duplicate_identity_reuses_message_and_ref_but_links_both_captures(self) -> None:
        messages = (self.message(1000), self.message(1000))
        batch = self.write(messages)
        self.assertEqual(len(set(batch.message_ids)), 1)
        refs = self.refs(batch.observation.observation_id)
        self.assertEqual(len(refs), 1)
        records = self.rows(
            "SELECT record.message_id,record.source_ref_id,record.payload,record.outcome "
            "FROM public.source_processing_record record JOIN public.source_processing_batch batch "
            "USING(batch_id,owner_id,contact_id) WHERE batch.source_id=%s ORDER BY position",
            (batch.observation.observation_id,),
        )
        self.assertEqual(len(records), 2)
        self.assertEqual([row[3] for row in records], ["message_created", "message_reused"])
        self.assertEqual({row[0] for row in records}, {refs[0][1]})
        self.assertEqual({row[1] for row in records}, {refs[0][0]})
        self.assertEqual(
            {row[2]["capture_record_id"] for row in records},
            {str(message.processing_record.record_id) for message in messages},
        )

    def test_unknown_and_known_times_keep_distinct_messages_while_unknown_repeats_deduplicate(self) -> None:
        batch = self.write((self.message(None), self.message(1000), self.message(None)))
        self.assertEqual(batch.message_ids[0], batch.message_ids[2])
        self.assertNotEqual(batch.message_ids[0], batch.message_ids[1])
        refs = self.refs(batch.observation.observation_id)
        self.assertEqual(len(refs), 2)
        self.assertEqual(len({row[2] for row in refs}), 2)
        stamps = self.rows(
            "SELECT source_create_time FROM public.wechat_message_metadata "
            "WHERE owner_id=%s AND contact_id=%s",
            (self.fixture.owner_id, self.fixture.contact_a),
        )
        self.assertEqual({row[0] for row in stamps}, {None, 1000})

    def test_legacy_reference_replay_preserves_locator_payload_and_id_and_new_source_reuses_message(self) -> None:
        first = self.write((self.message(1000),))
        observation_id = first.observation.observation_id
        # 只在隔离夹具中模拟升级前引用；产品写入不得重写这行。
        self.rows(
            "UPDATE public.message_source_ref SET source_locator=%s,raw_payload=%s "
            "WHERE observation_id=%s RETURNING id",
            ("cli:7", Jsonb({"legacy": "合成旧引用"}), observation_id),
        )
        legacy = self.refs(observation_id)

        replay_ids = self.fixture.store.record_cli_messages(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_a,
            observation_id=observation_id, messages=(self.message(1000),),
        )
        self.assertEqual(replay_ids, first.message_ids)
        self.assertEqual(self.refs(observation_id), legacy)

        second = self.write((self.message(1000),), cursor="opaque:second-source")
        self.assertEqual(second.message_ids, first.message_ids)
        self.assertEqual(self.refs(observation_id), legacy)
        new_refs = self.refs(second.observation.observation_id)
        self.assertEqual(len(new_refs), 1)
        self.assertNotEqual(new_refs[0][0], legacy[0][0])
        self.assertEqual(new_refs[0][1], legacy[0][1])
        self.assertNotEqual(new_refs[0][2], legacy[0][2])
        receipts = self.rows(
            "SELECT record.source_ref_id,record.payload->'persistence' "
            "FROM public.source_processing_record record JOIN public.source_processing_batch batch "
            "USING(batch_id,owner_id,contact_id) WHERE batch.source_id=%s ORDER BY batch.recorded_at DESC LIMIT 1",
            (observation_id,),
        )
        self.assertEqual(receipts[0][0], legacy[0][0])
        self.assertEqual(receipts[0][1]["source_ref_locator"], legacy[0][2])
        self.assertFalse(receipts[0][1]["source_ref_added"])

    def test_same_capture_locator_with_distinct_times_links_each_message_and_reference(self) -> None:
        messages = (self.message(1000), self.message(2000))
        batch = self.write(messages)
        rows = self.rows(
            "SELECT record.message_id,record.source_ref_id,record.locator,record.payload,"
            "ref.message_id,ref.source_locator,metadata.source_create_time "
            "FROM public.source_processing_record record "
            "JOIN public.source_processing_batch batch USING(batch_id,owner_id,contact_id) "
            "JOIN public.message_source_ref ref ON ref.id=record.source_ref_id "
            "JOIN public.wechat_message_metadata metadata ON metadata.message_id=record.message_id "
            "WHERE batch.source_id=%s ORDER BY position",
            (batch.observation.observation_id,),
        )
        self.assertEqual(len(rows), 2)
        for row, message in zip(rows, messages):
            self.assertEqual(row[0], row[4])
            self.assertEqual(row[2], message.source_locator)
            self.assertEqual(row[3]["capture_record_id"], str(message.processing_record.record_id))
            self.assertEqual(row[3]["parsed"], message.processing_record.payload()["parsed"])
            self.assertEqual(row[3]["persistence"]["source_ref_locator"], row[5])
            self.assertEqual(row[6], message.wechat_metadata.source_create_time)
        self.assertEqual(len({row[0] for row in rows}), 2)
        self.assertEqual(len({row[1] for row in rows}), 2)

    def test_history_page_commits_both_same_number_messages_and_checkpoint_together(self) -> None:
        history = self.start_history()
        checkpoint = HistoryPageCheckpoint(
            complete=True, message_count=2, non_text_count=0,
            last_local_id=7, last_cursor="opaque:history-complete",
        )
        batch = self.write((self.message(1000), self.message(2000)),
                           cursor=checkpoint.last_cursor, checkpoint=checkpoint)

        state = self.history_state(history)
        self.assertEqual(state.phase.value, "complete")
        self.assertEqual((state.message_count, state.page_count), (2, 1))
        self.assertEqual(state.last_cursor, checkpoint.last_cursor)
        self.assertIsNotNone(state.completed_at)
        self.assertEqual(len(set(batch.message_ids)), 2)
        self.assertEqual(len(self.refs(batch.observation.observation_id)), 2)
        self.assertEqual(self.fixture.store.read_cursor(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_a,
        ).last_cursor, checkpoint.last_cursor)

    def test_deleting_legacy_then_new_source_preserves_other_contact_and_clears_orphan_trace(self) -> None:
        legacy = self.write((self.message(1000),))
        legacy_id = legacy.observation.observation_id
        self.rows("UPDATE public.message_source_ref SET source_locator=%s WHERE observation_id=%s RETURNING id",
                  ("cli:7", legacy_id))
        current = self.write((self.message(1000),), cursor="opaque:current-source")
        other = self.write((self.message(1000, talker="wxid_observation_b"),),
                           binding=self.fixture.binding_b, cursor="opaque:other-contact")
        self.assertEqual(current.message_ids, legacy.message_ids)
        self.assertNotEqual(current.message_ids, other.message_ids)
        with self.assertRaises(ObservationNotFoundError):
            self.fixture.store.delete_observation(
                owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_b,
                observation_id=legacy_id,
            )

        for observation_id, remaining_messages in (
            (legacy_id, 1), (current.observation.observation_id, 0),
        ):
            self.fixture.store.delete_observation(
                owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_a,
                observation_id=observation_id,
            )
            self.assertEqual(self.counts()["message"], remaining_messages)
            self.assertEqual(self.counts()["message_source_ref"], remaining_messages)
            self.assertEqual(self.rows(
                "SELECT id FROM public.message WHERE owner_id=%s AND contact_id=%s",
                (self.fixture.owner_id, self.fixture.contact_b),
            ), [(other.message_ids[0],)])
            traces = self.rows(
                "SELECT batch.status,record.payload,record.locator FROM public.source_processing_batch batch "
                "JOIN public.source_processing_record record USING(batch_id,owner_id,contact_id) "
                "WHERE batch.owner_id=%s AND batch.contact_id=%s AND batch.source_id=%s",
                (self.fixture.owner_id, self.fixture.contact_a, observation_id),
            )
            self.assertTrue(traces)
            self.assertTrue(all(row == ("deleted", None, None) for row in traces))

    def test_processing_failure_rolls_back_messages_refs_cursor_and_history_checkpoint(self) -> None:
        self.write((self.message(1000),), cursor="opaque:before-failure")
        history = self.start_history()
        before_counts = self.counts()
        before_history = self.history_state(history)
        invalid = ProcessingRecord(uuid4(), "cli:8", "合成无效JSON")
        message = replace(self.message(2000, local_id=8), processing_record=invalid)
        checkpoint = HistoryPageCheckpoint(
            complete=True, message_count=1, non_text_count=0,
            last_local_id=8, last_cursor="opaque:must-not-commit",
        )

        with self.assertRaises(SourceProcessingWriteError):
            self.write((message,), cursor=checkpoint.last_cursor, checkpoint=checkpoint)

        self.assertEqual(self.counts(), before_counts)
        self.assertEqual(self.history_state(history), before_history)
        self.assertEqual(self.fixture.store.read_cursor(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_a,
        ).last_cursor, "opaque:before-failure")
