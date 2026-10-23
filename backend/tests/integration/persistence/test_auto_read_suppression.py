"""自动同步删除不复活；仅允许显式合成测试库，不连接微信或模型。"""
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4
import psycopg
from tests.integration.persistence.test_observation_store import PostgresObservationStoreTest as Base, TEST_DATABASE_URL as url
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
from notalone.persistence.source_tasks import PostgresSourceTasks
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository, SourceDeletionError
from notalone.wechat_cli.models import CliMessageEvent, MessageIdentifier
from notalone.wechat_cli.normalizer import normalize_cli_events

class AutoReadSuppressionTest(unittest.TestCase):
    setUpClass = classmethod(Base.setUpClass.__func__)
    setUp = Base.setUp
    tearDown = Base.tearDown

    def messages(self, ids=(6,), time=42):
        return normalize_cli_events([CliMessageEvent(MessageIdentifier(i, 'wxid_observation_a'), '合成需删除正文' + str(i), 'text', None, None, False, time, None, None) for i in ids])

    def save(self, ids=(6,), cursor=None, mode=ObservationMode.CLI_BACKGROUND):
        return self.store.record_batch_with_messages(owner_id=self.owner_id, contact_id=self.contact_a, binding_id=self.binding_a.binding_id, mode=mode, cli_version='synthetic-v1', conversation_locator='wxid_observation_a', last_local_id=max(ids), last_cursor=cursor or uuid4().hex, record_count=len(ids), messages=self.messages(ids))

    def delete(self, observation):
        self.store.delete_observation(owner_id=self.owner_id, contact_id=self.contact_a, observation_id=observation)

    def n(self, table):
        with psycopg.connect(url) as c:
            return c.execute('SELECT count(*) FROM public.' + table + ' WHERE owner_id=%s AND contact_id=%s' + (' AND payload IS NOT NULL' if table == 'source_processing_record' else ''), (self.owner_id, self.contact_a)).fetchone()[0]

    def source(self, message):
        source = uuid4()
        with psycopg.connect(url) as c:
            c.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status) VALUES(%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1,'active')", (source, self.owner_id, self.contact_a, uuid4().hex * 2))
            c.execute("INSERT INTO public.message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES(%s,%s,%s,%s,'source_document',%s,'row:1','{}')", (uuid4(), message, self.owner_id, self.contact_a, source))
        return source

    def test_new_capture_history_and_mixed_page(self):
        first = self.save()
        self.delete(first.observation.observation_id)
        replay = self.save(mode=ObservationMode.CLI_HISTORY)
        self.assertEqual(replay.message_ids, ())
        self.assertEqual(self.n('source_processing_record'), 0)
        mixed = self.save((6, 7))
        self.assertEqual(len(mixed.message_ids), 1)
        self.assertEqual(self.n('message'), 1)
        with psycopg.connect(url) as c:
            self.assertNotIn('合成需删除正文6', str(c.execute('SELECT payload FROM public.source_processing_record WHERE owner_id=%s', (self.owner_id,)).fetchall()))
            self.assertEqual(c.execute('SELECT last_cursor FROM public.wechat_observation_cursor WHERE owner_id=%s AND contact_id=%s', (self.owner_id, self.contact_a)).fetchone()[0], mixed.observation.last_cursor)

    def test_separate_automatic_entry(self):
        first = self.save()
        self.delete(first.observation.observation_id)
        batch = self.store.record_batch(owner_id=self.owner_id, contact_id=self.contact_a, binding_id=self.binding_a.binding_id, mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic', conversation_locator='wxid_observation_a', last_local_id=6, last_cursor=uuid4().hex, record_count=1)
        ids = self.store.record_cli_messages(owner_id=self.owner_id, contact_id=self.contact_a, observation_id=batch.observation_id, messages=self.messages())
        self.assertEqual(ids, ())
        self.assertEqual(self.n('source_processing_record'), 0)

    def test_queued_source_blocks_while_other_source_survives(self):
        first = self.save()
        source = self.source(first.message_ids[0])
        PostgresSourceTasks(url).request_delete(self.owner_id, self.contact_a, source)
        self.assertEqual(self.save().message_ids, ())
        self.assertEqual(self.n('message'), 1)
        self.delete(first.observation.observation_id)
        PostgresSourceDeletionRepository(url).delete_source(owner_id=self.owner_id, contact_id=self.contact_a, source_document_id=source)
        self.assertEqual(self.save().message_ids, ())
        self.assertEqual(self.n('message'), 0)

    def test_transaction_failure_rolls_back_suppression(self):
        first = self.save()
        source = self.source(first.message_ids[0])
        with psycopg.connect(url) as c:
            c.execute("CREATE FUNCTION public.reject_guard_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$")
            c.execute('CREATE TRIGGER reject_guard_task BEFORE INSERT ON public.background_task FOR EACH ROW EXECUTE FUNCTION public.reject_guard_task()')
        try:
            with self.assertRaises(SourceDeletionError):
                PostgresSourceTasks(url).request_delete(self.owner_id, self.contact_a, source)
            self.assertEqual(self.n('wechat_auto_read_suppression'), 0)
            self.assertEqual(len(self.save().message_ids), 1)
        finally:
            with psycopg.connect(url) as c:
                c.execute('DROP TRIGGER reject_guard_task ON public.background_task')
                c.execute('DROP FUNCTION public.reject_guard_task()')

    def test_scope_cascade_and_identity_time(self):
        first = self.save()
        self.delete(first.observation.observation_id)
        different = self.store.record_cli_messages
        messages = self.messages(time=43)
        batch = self.store.record_batch(owner_id=self.owner_id, contact_id=self.contact_a, binding_id=self.binding_a.binding_id, mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic', conversation_locator='wxid_observation_a', last_local_id=6, last_cursor=uuid4().hex, record_count=1)
        self.assertEqual(len(different(owner_id=self.owner_id, contact_id=self.contact_a, observation_id=batch.observation_id, messages=messages)), 1)
        other = normalize_cli_events([CliMessageEvent(MessageIdentifier(6, 'wxid_observation_b'), '其他联系人合成文字', 'text', None, None, False, 42, None, None)])
        other_batch = self.store.record_batch_with_messages(owner_id=self.owner_id, contact_id=self.contact_b, binding_id=self.binding_b.binding_id, mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic', conversation_locator='wxid_observation_b', last_local_id=6, last_cursor=uuid4().hex, record_count=1, messages=other)
        self.assertEqual(len(other_batch.message_ids), 1)
        from notalone.persistence.contact_deletion import delete_contact
        from notalone.scopes import ContactScope
        self.assertTrue(delete_contact(url, ContactScope(self.owner_id, self.contact_a)))
        self.assertEqual(self.n('wechat_auto_read_suppression'), 0)
        with psycopg.connect(url) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM public.message WHERE owner_id=%s AND contact_id=%s', (self.owner_id, self.contact_b)).fetchone()[0], 1)

    def test_rebinding_does_not_clear_guard(self):
        first = self.save()
        self.delete(first.observation.observation_id)
        from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
        bindings = PostgresConversationBindingRepository(url)
        bindings.revoke_binding(owner_id=self.owner_id, contact_id=self.contact_a, binding_id=self.binding_a.binding_id)
        self.binding_a = bindings.create_binding(owner_id=self.owner_id, contact_id=self.contact_a, channel='wechat', account_scope='synthetic-account', conversation_locator='wxid_observation_a')
        self.store = PostgresObservationStore(url)
        self.assertEqual(self.save().message_ids, ())

    def test_explicit_import_creates_new_source_without_clearing_guard(self):
        import json
        from notalone.ingest.jsonl_reader import read_jsonl
        from notalone.ingest.normalizer import normalize_document
        from notalone.ingest.models import ExistingContactSelection, ImportConfirmationRequest
        from notalone.persistence.postgres_repository import PostgresIngestRepository
        first = self.save()
        self.delete(first.observation.observation_id)
        with psycopg.connect(url) as c:
            c.execute("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES(%s,'wechat','synthetic-owner','合成本人')", (self.owner_id,))
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / ('synthetic-' + uuid4().hex + '.jsonl')
        path.write_text(json.dumps({'id': {'local_id': 6, 'talker': 'wxid_observation_a', 'server_id_str': 'synthetic-server'}, 'create_time': 42, 'is_from_me': False, 'kind': 'text', 'sender': '合成联系人', 'sender_wxid': 'wxid_observation_a', 'text': '明确重新导入合成文字', 'time': '1970-01-01 00:00:42', 'time_iso': '1970-01-01T00:00:42Z'}) + '\n')
        owner_record = json.loads(path.read_text())
        owner_record.update(is_from_me=True, sender='合成本人', sender_wxid='synthetic-owner')
        owner_record['id']['local_id'] = 7
        owner_record['id']['server_id_str'] = 'synthetic-owner-server'
        path.write_text(path.read_text() + json.dumps(owner_record) + '\n')
        result = PostgresIngestRepository(url).import_document(owner_id=self.owner_id, document=normalize_document(read_jsonl(path)), confirmation=ImportConfirmationRequest(selection=ExistingContactSelection(contact_id=self.contact_a)))
        self.assertNotEqual(result.source_document_id, first.observation.observation_id)
        self.assertEqual(self.n('message'), 2)
        self.assertEqual(self.n('wechat_auto_read_suppression'), 1)
        self.assertEqual(self.save().message_ids, ())

    def test_concurrent_save_waits_for_delete_transaction(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        from notalone.persistence.auto_read_suppression import suppress_source
        from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
        first = self.save()
        started = Event()
        with ThreadPoolExecutor(max_workers=1) as executor:
            with psycopg.connect(url) as c:
                lock_contact_scope(c, owner_id=self.owner_id, contact_id=self.contact_a)
                lock_owner_scope(c, owner_id=self.owner_id)
                suppress_source(c, owner_id=self.owner_id, contact_id=self.contact_a, source_id=first.observation.observation_id)

                def work():
                    started.set()
                    return self.save()
                future = executor.submit(work)
                self.assertTrue(started.wait(2))
                import time
                deadline = time.monotonic() + 3
                waiting = False
                while time.monotonic() < deadline:
                    with psycopg.connect(url) as watcher:
                        waiting = watcher.execute("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'SELECT pg_advisory_xact_lock%')").fetchone()[0]
                    if waiting:
                        break
                self.assertTrue(waiting, '未观察到保存事务等待联系人锁')
                self.assertFalse(future.done())
            self.assertEqual(future.result(timeout=5).message_ids, ())

    def test_raw_capture_and_independent_receipts_are_filtered(self):
        import json
        from notalone.wechat_cli.adapter import _parse_follow_line
        from notalone.source_processing.models import ProcessingRecord
        first = self.save()
        self.delete(first.observation.observation_id)
        events = []
        records = []
        for identity in (6, 7):
            line = json.dumps({'type': 'message', 'cursor': 'opaque-' + str(identity), 'message': {'id': {'local_id': identity, 'talker': 'wxid_observation_a', 'server_id_str': 'synthetic'}, 'kind': 'text', 'text': '原始删除正文' + str(identity), 'is_from_me': False, 'create_time': identity + 36, 'sender': None, 'sender_wxid': None, 'time': None, 'time_iso': None}})
            item = _parse_follow_line(line, expected_talker='wxid_observation_a')
            events.append(item.event)
        messages = normalize_cli_events(events, processing_receipts=records)
        records.append(ProcessingRecord.capture('cli:6', records[0].payload()))
        string_payload = records[0].payload()
        string_payload['parsed']['message']['id']['local_id'] = '6'
        string_payload['parsed']['message']['create_time'] = '42'
        records.append(ProcessingRecord.capture('cli:6', string_payload))
        batch = self.store.record_batch_with_messages(owner_id=self.owner_id, contact_id=self.contact_a, binding_id=self.binding_a.binding_id, mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic', conversation_locator='wxid_observation_a', last_local_id=7, last_cursor=uuid4().hex, record_count=2, messages=messages, processing_records=tuple(records))
        self.assertEqual(sum((value is not None for value in batch.created_message_ids)), 1)
        self.assertEqual(batch.created_message_ids, (None, batch.message_ids[0]))
        self.assertEqual(batch.observation.record_count, 1)
        from types import SimpleNamespace
        from notalone.front_sync.cli_sync import CliBackgroundSync
        published = []
        publisher = SimpleNamespace(_message_events=SimpleNamespace(publish_message_created=lambda **event: published.append(event)))
        CliBackgroundSync._publish_message_events(publisher, scope=SimpleNamespace(contact_id=self.contact_a), messages=messages, message_ids=batch.created_message_ids)
        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]['message_id'], batch.message_ids[0])
        self.assertEqual(published[0]['occurred_at'], messages[1].occurred_at)
        with psycopg.connect(url) as c:
            payload = str(c.execute('SELECT payload FROM public.source_processing_record WHERE owner_id=%s', (self.owner_id,)).fetchall())
            self.assertNotIn('原始删除正文6', payload)
            self.assertIn('原始删除正文7', payload)
            self.assertEqual(c.execute('SELECT count(*) FROM public.message_source_ref WHERE observation_id=%s', (batch.observation.observation_id,)).fetchone()[0], 1)
            self.assertEqual(c.execute('SELECT count(*) FROM public.memory_extraction_receipt WHERE observation_id=%s', (batch.observation.observation_id,)).fetchone()[0], 1)

    def test_owner_delete_cascades_guard(self):
        first = self.save()
        self.delete(first.observation.observation_id)
        self.assertEqual(self.n('wechat_auto_read_suppression'), 1)
        with psycopg.connect(url) as c:
            c.execute('DELETE FROM public.owner WHERE id=%s', (self.owner_id,))
        self.assertEqual(self.n('wechat_auto_read_suppression'), 0)

    def test_unknown_time_identity_is_exact(self):
        messages = self.messages(time=None)
        first = self.store.record_batch_with_messages(owner_id=self.owner_id, contact_id=self.contact_a, binding_id=self.binding_a.binding_id, mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic', conversation_locator='wxid_observation_a', last_local_id=6, last_cursor=uuid4().hex, record_count=1, messages=messages)
        self.delete(first.observation.observation_id)
        batch = self.store.record_batch(owner_id=self.owner_id, contact_id=self.contact_a, binding_id=self.binding_a.binding_id, mode=ObservationMode.CLI_BACKGROUND, cli_version='synthetic', conversation_locator='wxid_observation_a', last_local_id=6, last_cursor=uuid4().hex, record_count=1)
        self.assertEqual(self.store.record_cli_messages(owner_id=self.owner_id, contact_id=self.contact_a, observation_id=batch.observation_id, messages=self.messages(time=None)), ())
        self.assertEqual(len(self.save().message_ids), 1)

    def test_history_checkpoint_counts_only_accepted_messages(self):
        from datetime import datetime, timezone
        from notalone.persistence.history_sync_state import (
            HistoryPageCheckpoint, PostgresHistorySyncStateStore,
        )
        first = self.save()
        self.delete(first.observation.observation_id)
        history = PostgresHistorySyncStateStore(url)
        history.ensure_scope_started(
            owner_id=self.owner_id, channel="wechat",
            account_scope="synthetic-account", watermark_at=datetime.now(timezone.utc),
        )
        for ids, expected_count, complete in (((6,), 0, False), ((6, 7), 1, True)):
            cursor = uuid4().hex
            batch = self.store.record_batch_with_messages(
                owner_id=self.owner_id, contact_id=self.contact_a,
                binding_id=self.binding_a.binding_id, mode=ObservationMode.CLI_HISTORY,
                cli_version="synthetic", conversation_locator="wxid_observation_a",
                last_local_id=max(ids), last_cursor=cursor, record_count=len(ids),
                messages=self.messages(ids), advance_cursor=False,
                history_checkpoint=HistoryPageCheckpoint(
                    complete=complete, message_count=len(ids), non_text_count=0,
                    last_local_id=max(ids), last_cursor=cursor,
                ),
            )
            state = history.read(
                owner_id=self.owner_id, contact_id=self.contact_a,
                binding_id=self.binding_a.binding_id,
            )
            self.assertEqual(state.message_count, expected_count)
            self.assertEqual(state.last_cursor, cursor)
            self.assertEqual(batch.observation.record_count, expected_count)
        self.assertEqual(state.page_count, 2)
        self.assertEqual(state.phase.value, "complete")
        with psycopg.connect(url) as connection:
            self.assertEqual(connection.execute(
                "SELECT last_cursor FROM public.wechat_observation_cursor "
                "WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_a),
            ).fetchone()[0], cursor)
