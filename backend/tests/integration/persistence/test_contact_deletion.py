"""显式联系人删除的隔离 PostgreSQL 与本机自有文件反例。"""

import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg

from notalone.persistence.contact_deletion import delete_contact
from notalone.database_adoption import _owned_database, _run_pg
from notalone.database_migrations import MigrationError
from notalone.managed_update_backups import ManagedUpdateBackupError
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.observation_store import ObservationMode, PostgresObservationStore
from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
from notalone.scopes import ContactScope
from tests.integration.media import test_lifecycle as media_fixture
from tests.integration.persistence import test_managed_update_backup_deletion as backup_fixture
from tests.integration.persistence import test_all_source_deletion as dependency_fixture
from tests.support.media_fixtures import SyntheticReader


class ContactDeletionTest(unittest.TestCase):
    # 复用纯合成媒体夹具；不继承其测试方法，不读取真实微信或业务库。
    setUpClass = classmethod(media_fixture.MediaLifecycleTest.setUpClass.__func__)
    _drop_database = classmethod(media_fixture.MediaLifecycleTest._drop_database.__func__)
    setUp = media_fixture.MediaLifecycleTest.setUp
    tearDown = media_fixture.MediaLifecycleTest.tearDown
    import_source = media_fixture.MediaLifecycleTest.import_source
    service = media_fixture.MediaLifecycleTest.service
    _source = dependency_fixture.AllSourceDeletionTest._source
    _record = dependency_fixture.AllSourceDeletionTest._record
    _request = dependency_fixture.AllSourceDeletionTest._request

    def test_contact_delete_erases_registered_media_and_preserves_other_scopes(self):
        other = ContactScope(self.scope.owner_id, uuid4())
        with psycopg.connect(self.database_url) as connection:
            connection.execute('INSERT INTO public.media_request_tombstone(owner_id,contact_id,request_key_hash) VALUES(%s,%s,%s)',
                               (other.owner_id, other.contact_id, '0' * 64))
            connection.execute(
                "INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成其他联系人')",
                (other.owner_id, other.contact_id),
            )
        _, other_message, _ = self.import_source(scope=other, talker='synthetic_other_talker')
        service = self.service(reader=SyntheticReader(self.source_file))
        own = service.extract_media(self.scope, self.message_id, 'original', 'contact-own')
        kept = service.extract_media(other, other_message, 'original', 'contact-kept')
        self.assertEqual((own.status, kept.status), ('ready', 'ready'))
        artifact = own.artifacts[0].artifact_id
        owned_path = next(self.cache_root.rglob(artifact.hex + '.data'))

        self.assertFalse(delete_contact(self.database_url, ContactScope(uuid4(), self.scope.contact_id)))
        self.assertTrue(owned_path.exists())
        self.assertTrue(delete_contact(self.database_url, self.scope))
        self.assertFalse(owned_path.exists(), '联系人级联不得留下已登记的媒体正文')
        self.assertFalse(delete_contact(self.database_url, self.scope))
        self.assertEqual(service.read_media(other, kept.resource_id, kept.artifacts[0].artifact_id).data,
                         b'synthetic source unchanged')
        self.assertEqual(self.source_file.read_bytes(), b'synthetic source unchanged')
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                'SELECT count(*) FROM public.media_attempt WHERE owner_id=%s AND contact_id=%s',
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone(), (0,))
            self.assertEqual(connection.execute(
                'SELECT count(*) FROM public.media_request_tombstone WHERE owner_id=%s AND contact_id=%s',
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone(), (0,), '联系人删除不得保留媒体墓碑中的联系人身份')
            self.assertEqual(connection.execute(
                'SELECT count(*) FROM public.media_request_tombstone WHERE owner_id=%s AND contact_id=%s',
                (other.owner_id, other.contact_id),
            ).fetchone(), (1,))
            self.assertIsNotNone(connection.execute(
                'SELECT id FROM public.contact WHERE owner_id=%s AND id=%s',
                (other.owner_id, other.contact_id),
            ).fetchone())

    def test_contact_delete_erases_owner_bodies_and_cross_contact_dependencies(self):
        # 直接SQL只构造历史依赖与删除反例，不签来源语义或模拟模型采纳。
        self.url, self.owner, self.contact = self.database_url, self.scope.owner_id, self.scope.contact_id
        self.other = uuid4()
        with psycopg.connect(self.url) as connection:
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成保留联系人')",
                               (self.owner, self.other))
        source, self.target = self._source('合成本人资料的导入依据。')
        _, self.context = self._source('合成本人资料的观察依据。')
        binding = PostgresConversationBindingRepository(self.url).create_binding(
            owner_id=self.owner, contact_id=self.contact, channel='wechat',
            account_scope='synthetic-delete-contact', conversation_locator=self.talker,
        )
        observation = PostgresObservationStore(self.url).record_batch(
            owner_id=self.owner, contact_id=self.contact, binding_id=binding.binding_id,
            mode=ObservationMode.LIVE, cli_version='synthetic/1', conversation_locator=self.talker,
            since_local_id=None, last_local_id=1, last_cursor='synthetic:1', record_count=1,
        )
        with psycopg.connect(self.url) as connection:
            connection.execute('DELETE FROM public.message_source_ref WHERE message_id=%s', (self.context,))
            connection.execute("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload) VALUES(%s,%s,%s,'local_wechat_observation',%s,'synthetic:observed','{}')",
                               (self.context, self.owner, self.contact, observation.observation_id))
        candidate = self._record('memory_candidate', status='confirmed')
        erased = [self._record('owner_memory', status=status, candidate=candidate if status == 'active' else None)
                  for status in ('active', 'invalidated', 'deleted')]
        erased.append(self._record('owner_memory', mode='any', source_ids=[self.target]))
        self.contact = self.other
        _, other_message = self._source('其他联系人独立支持的合成资料。')
        self.contact = self.scope.contact_id
        kept_any = self._record('owner_memory', mode='any', source_ids=[self.target, other_message])
        kept_manual = self._record('owner_memory', mode='any', source_ids=[self.owner])
        root, reply_binding = self._request()
        any_root, any_binding = self._request()
        sample, independent_sample = uuid4(), uuid4()
        with psycopg.connect(self.url) as connection:
            for request, memory, binding in ((root, erased[1], reply_binding), (any_root, erased[-1], any_binding)):
                connection.execute("INSERT INTO public.reply_context_evidence(reply_request_id,evidence_id,owner_id,contact_id,conversation_binding_id,ordinal,kind,evidence_text,source_ids) VALUES(%s,%s,%s,%s,%s,0,'owner_memory','合成本人资料副本','[]')",
                                   (request, memory, self.owner, self.other, binding))
            for identifier, sources in ((sample, [source, self.context]), (independent_sample, [])):
                connection.execute("INSERT INTO public.style_sample(id,owner_id,contact_id,save_key,final_text,origin_kind,source_ids) VALUES(%s,%s,%s,%s,'合成表达副本','manual',%s)",
                                   (identifier, self.owner, self.other, uuid4(), sources))
        independent, _ = self._request()
        self.assertTrue(delete_contact(self.url, self.scope))
        with psycopg.connect(self.url) as connection:
            for identifier in erased:
                self.assertIsNone(connection.execute('SELECT id FROM public.owner_memory WHERE owner_id=%s AND id=%s',
                                                    (self.owner, identifier)).fetchone(), '本人正文不得借候选FK置空残留')
            self.assertEqual(connection.execute('SELECT source_ids FROM public.owner_memory WHERE id=%s', (kept_any,)).fetchone(), ([other_message],))
            self.assertIsNotNone(connection.execute('SELECT id FROM public.owner_memory WHERE id=%s', (kept_manual,)).fetchone())
            self.assertIsNone(connection.execute('SELECT id FROM public.reply_request WHERE id=%s', (root,)).fetchone())
            self.assertIsNone(connection.execute('SELECT id FROM public.reply_request WHERE id=%s', (any_root,)).fetchone())
            self.assertIsNotNone(connection.execute('SELECT id FROM public.reply_request WHERE id=%s', (independent,)).fetchone())
            self.assertEqual(connection.execute('SELECT status,final_text,source_ids FROM public.style_sample WHERE id=%s', (sample,)).fetchone(), ('deleted', None, []))
            self.assertEqual(connection.execute('SELECT status FROM public.style_sample WHERE id=%s', (independent_sample,)).fetchone(), ('active',))

    def test_media_cleanup_failure_keeps_manifest_and_contact_for_explicit_retry(self):
        service = self.service(reader=SyntheticReader(self.source_file))
        ready = service.extract_media(self.scope, self.message_id, 'original', 'contact-retry')
        self.assertEqual(ready.status, 'ready')
        artifact_name = ready.artifacts[0].artifact_id.hex + '.data'
        unlink = os.unlink

        def fail_registered_file(path, *args, **kwargs):
            if path == artifact_name:
                raise OSError('synthetic owned media cleanup failure')
            return unlink(path, *args, **kwargs)

        with patch('notalone.media.cache.os.unlink', side_effect=fail_registered_file):
            with self.assertRaises(OSError):
                delete_contact(self.database_url, self.scope)
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNotNone(connection.execute('SELECT id FROM public.contact WHERE owner_id=%s AND id=%s',
                                                   (self.scope.owner_id, self.scope.contact_id)).fetchone())
            self.assertEqual(connection.execute('SELECT count(*) FROM public.media_attempt WHERE resource_id=%s',
                                                (ready.resource_id,)).fetchone(), (1,))
        self.assertTrue(next(self.cache_root.rglob(artifact_name)).is_file())
        self.assertTrue(delete_contact(self.database_url, self.scope))
        self.assertFalse(list(self.cache_root.rglob('*.data')))

    def test_repeat_delete_finishes_owned_media_left_by_an_old_contact_cascade(self):
        ready = self.service(reader=SyntheticReader(self.source_file)).extract_media(
            self.scope, self.message_id, 'original', 'contact-old-cascade',
        )
        self.assertEqual(ready.status, 'ready')
        owned_path = next(self.cache_root.rglob(ready.artifacts[0].artifact_id.hex + '.data'))
        with psycopg.connect(self.database_url) as connection:
            connection.execute('DELETE FROM public.contact WHERE owner_id=%s AND id=%s',
                               (self.scope.owner_id, self.scope.contact_id))
        self.assertTrue(owned_path.is_file())
        self.assertFalse(delete_contact(self.database_url, self.scope))
        self.assertFalse(owned_path.exists(), '无FK媒体清单仍能证明归属，重复删除须收尾')
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.media_attempt WHERE resource_id=%s',
                                                (ready.resource_id,)).fetchone(), (0,))

    def test_repeat_delete_clears_tombstones_when_no_contact_or_media_attempt_remains(self):
        ready = self.service(reader=SyntheticReader(self.source_file)).extract_media(
            self.scope, self.message_id, 'original', 'contact-tombstone-only',
        )
        self.assertEqual(ready.status, 'ready')
        PostgresSourceDeletionRepository(self.database_url).delete_source(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id, source_document_id=self.source_id,
        )
        with psycopg.connect(self.database_url) as connection:
            connection.execute('DELETE FROM public.contact WHERE owner_id=%s AND id=%s',
                               (self.scope.owner_id, self.scope.contact_id))
            self.assertEqual(connection.execute('SELECT count(*) FROM public.media_attempt WHERE owner_id=%s AND contact_id=%s',
                                               (self.scope.owner_id, self.scope.contact_id)).fetchone(), (0,))
            self.assertEqual(connection.execute('SELECT count(*) FROM public.media_request_tombstone WHERE owner_id=%s AND contact_id=%s',
                                               (self.scope.owner_id, self.scope.contact_id)).fetchone(), (1,))
        self.assertFalse(delete_contact(self.database_url, self.scope))
        self.assertFalse(delete_contact(self.database_url, self.scope))
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.media_request_tombstone WHERE owner_id=%s AND contact_id=%s',
                                               (self.scope.owner_id, self.scope.contact_id)).fetchone(), (0,))


class ContactBackupDeletionTest(unittest.TestCase):
    _fingerprint = staticmethod(backup_fixture.ManagedUpdateBackupDeletionTest._fingerprint)
    _historical_archive = backup_fixture.ManagedUpdateBackupDeletionTest._historical_archive
    setUp = backup_fixture.ManagedUpdateBackupDeletionTest.setUp

    def test_contact_delete_erases_real_app_dump_that_can_restore_the_contact(self):
        archive = self.backup / 'database.dump'
        with _owned_database(self.target['database_url'], 'contact_before', synthetic=False) as restored:
            _run_pg('pg_restore', restored, ['--single-transaction', '--exit-on-error', str(archive)])
            with psycopg.connect(restored) as connection:
                self.assertEqual(connection.execute(
                    'SELECT display_name FROM public.contact WHERE id=%s',
                    (self.scope['contact_id'],),
                ).fetchone(), ('合成联系人',))
        scope = ContactScope(self.scope['owner_id'], self.scope['contact_id'])
        with patch.dict(os.environ, NOTALONE_MANAGED_USER_DATA=str(self.user_data)):
            self.assertTrue(delete_contact(self.target['database_url'], scope))
        self.assertFalse(archive.exists(), 'App归档仍能恢复已删除联系人及原始正文')
        with _owned_database(self.target['database_url'], 'contact_after', synthetic=False) as restored:
            with self.assertRaisesRegex(MigrationError, 'backup_restore_failed'):
                _run_pg('pg_restore', restored, ['--single-transaction', '--exit-on-error', str(archive)])
        with psycopg.connect(self.target['database_url']) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM public.contact').fetchone(), (0,))

    def test_unknown_backup_blocks_contact_delete_and_preserves_all_unknown_files(self):
        unknown = self.user_data / 'updates/unknown'
        unknown.mkdir(mode=0o700)
        marker = unknown / 'unrelated.txt'
        marker.write_text('本例未知文件必须保留')
        archive = self.backup / 'database.dump'
        before = archive.read_bytes()
        scope = ContactScope(self.scope['owner_id'], self.scope['contact_id'])
        with patch.dict(os.environ, NOTALONE_MANAGED_USER_DATA=str(self.user_data)):
            self.assertFalse(delete_contact(self.target['database_url'], ContactScope(uuid4(), scope.contact_id)))
            with self.assertRaises(ManagedUpdateBackupError):
                delete_contact(self.target['database_url'], scope)
        self.assertEqual(marker.read_text(), '本例未知文件必须保留')
        self.assertEqual(archive.read_bytes(), before)
        with psycopg.connect(self.target['database_url']) as connection:
            self.assertIsNotNone(connection.execute('SELECT id FROM public.contact WHERE owner_id=%s AND id=%s',
                                                   (scope.owner_id, scope.contact_id)).fetchone())
