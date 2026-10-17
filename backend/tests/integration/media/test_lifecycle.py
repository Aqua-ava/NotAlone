"""仅在随机自建数据库与合成文件中验证公共媒体合同。"""
from pathlib import Path
import os
import tempfile
import unittest
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from uuid import uuid4
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from notalone.database_migrations import migrate
from notalone.ingest.models import ChannelIdentityCandidate, ExistingContactSelection, ImportBatch, ImportConfirmationRequest, NormalizedMessage, OwnerChannelIdentityCandidate, WechatMessageMetadata
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.scopes import ContactScope

class MediaLifecycleTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        instance = os.environ['NOTALONE_TEST_DATABASE_URL']
        cls.database_name = f'notalone_media_{uuid4().hex}_test'
        cls.database_url = make_conninfo(instance, dbname=cls.database_name)
        cls.admin = psycopg.connect(instance, dbname='postgres', autocommit=True)
        try:
            cls.admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(cls.database_name)))
        except BaseException:
            cls.admin.close()
            raise
        cls.addClassCleanup(cls._drop_database)
        binding = patch.dict(os.environ, NOTALONE_DATABASE_URL=cls.database_url,
                             NOTALONE_TEST_DATABASE_URL=cls.database_url,
                             NOTALONE_EXPECTED_TEST_DATABASE=cls.database_name,
                             NOTALONE_DISABLE_DOTENV='1')
        binding.start()
        cls.addClassCleanup(binding.stop)
        migrations = Path(__file__).resolve().parents[3] / 'database/migrations'
        expected = tuple(sorted(path.name for path in migrations.glob('*.sql')))
        if migrate(cls.database_url, migrations) != expected or migrate(cls.database_url, migrations):
            raise RuntimeError('媒体回归须完整执行当前正式迁移，重复执行为零。')

    @classmethod
    def _drop_database(cls):
        try:
            cls.admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(cls.database_name)))
            if cls.admin.execute('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)',
                                 (cls.database_name,)).fetchone()[0]:
                raise AssertionError('媒体自有测试库未清理。')
        finally:
            cls.admin.close()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache_root = Path(self.directory.name) / 'managed'
        self.source_file = Path(self.directory.name) / 'borrowed'
        self.source_file.write_bytes(b'synthetic source unchanged')
        self.scope = ContactScope(uuid4(), uuid4())
        self.owner_external = f'synthetic_owner_{uuid4().hex}'
        self.talker = f'synthetic_contact_{uuid4().hex}'
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner (id,display_name) VALUES (%s,'合成用户')", (self.scope.owner_id,))
            connection.execute("INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'合成联系人')", (self.scope.owner_id, self.scope.contact_id))
            connection.execute("INSERT INTO public.owner_channel_identity (owner_id,channel,external_id,observed_name) VALUES (%s,'wechat',%s,'合成本人')", (self.scope.owner_id, self.owner_external))
        self.source_id, self.message_id, self.ref_id = self.import_source()

    def tearDown(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute('DELETE FROM public.owner WHERE id=%s', (self.scope.owner_id,))

    def import_source(self, *, kind='image', local_id=7, scope=None, talker=None, owner_external=None):
        scope = scope or self.scope
        talker = talker or self.talker
        owner_external = owner_external or self.owner_external
        batch = ImportBatch(
            file_name='synthetic.jsonl', content_sha256=uuid4().hex * 2,
            owner_channel_identity=OwnerChannelIdentityCandidate('wechat', owner_external, '合成本人', 1),
            channel_identity=ChannelIdentityCandidate('wechat', talker, '合成联系人', 1),
            messages=(NormalizedMessage(
                'synthetic:1', 'contact', kind, '', '合成媒体', None,
                WechatMessageMetadata(
                    local_id, 'server-7', talker, 1700000000,
                    '{"images":[{"path":"/never/open/raw-path"}]}',
                ),
            ),),
        )
        imported = PostgresIngestRepository(self.database_url).import_document(owner_id=scope.owner_id, document=batch, confirmation=ImportConfirmationRequest(ExistingContactSelection(scope.contact_id)))
        with psycopg.connect(self.database_url) as connection:
            row = connection.execute('SELECT message_id,id FROM public.message_source_ref WHERE source_document_id=%s', (imported.source_document_id,)).fetchone()
        return (imported.source_document_id, row[0], row[1])

    def add_source_reference(self):
        source_id, ref_id = (uuid4(), uuid4())
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.source_document (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES (%s,%s,%s,'wechat_jsonl','synthetic-other.jsonl',%s,1)", (source_id, self.scope.owner_id, self.scope.contact_id, uuid4().hex * 2))
            connection.execute("INSERT INTO public.import_confirmation (owner_id,contact_id,source_document_id,channel_identity_id,method) SELECT owner_id,contact_id,%s,channel_identity_id,'manual_select' FROM public.import_confirmation WHERE source_document_id=%s", (source_id, self.source_id))
            connection.execute("INSERT INTO public.message_source_ref (id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES (%s,%s,%s,%s,'source_document',%s,'synthetic:1','{}')", (ref_id, self.message_id, self.scope.owner_id, self.scope.contact_id, source_id))
        return (source_id, ref_id)

    def service(self, **kwargs):
        from notalone.media.service import MediaService
        return MediaService(self.database_url, self.cache_root, **kwargs)

    def test_unverified_production_reader_refuses_without_creating_cache(self):
        result = self.service().extract_media(self.scope, self.message_id, 'image', 'request-1')
        self.assertEqual(result.status, 'upstream_unverified')
        self.assertEqual(result.source_ref_id, self.ref_id)
        self.assertFalse(self.cache_root.exists())
        self.assertEqual(self.source_file.read_bytes(), b'synthetic source unchanged')

    def test_original_copy_is_readable_only_in_its_scope_and_result(self):
        from tests.support.media_fixtures import SyntheticReader
        service = self.service(reader=SyntheticReader(self.source_file))
        result = service.extract_media(self.scope, self.message_id, 'original', 'copy-1')
        self.assertEqual(result.status, 'ready')
        self.assertEqual(len(result.artifacts), 1)
        artifact = result.artifacts[0]
        self.assertEqual(artifact.role, 'managed_original')
        read = service.read_media(self.scope, result.resource_id, artifact.artifact_id)
        self.assertEqual(read.status, 'ready')
        self.assertEqual(read.data, b'synthetic source unchanged')
        self.assertEqual(service.read_media(ContactScope(uuid4(), self.scope.contact_id), result.resource_id, artifact.artifact_id).status, 'resource_unavailable')
        self.assertEqual(service.read_media(self.scope, result.resource_id, uuid4()).status, 'resource_unavailable')
        self.assertEqual(self.source_file.read_bytes(), b'synthetic source unchanged')

    def delete_source(self, source_id=None):
        from notalone.application.source_service import SourceService
        service = SourceService(self.database_url)
        service.delete(self.scope.owner_id, self.scope.contact_id, source_id or self.source_id)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            row = next((row for row in service.list_sources(self.scope.owner_id, self.scope.contact_id) if row['source_id'] == str(source_id or self.source_id)))
            if row['task_status'] in ('succeeded', 'failed'):
                return row
            time.sleep(0.01)
        self.fail('合成来源删除未在预算内完成')

    def test_source_service_delete_removes_ready_files_and_verifies_unreadable(self):
        from tests.support.media_fixtures import SyntheticReader
        service = self.service(reader=SyntheticReader(self.source_file))
        result = service.extract_media(self.scope, self.message_id, 'original', 'delete-1')
        self.assertEqual(result.status, 'ready')
        self.assertTrue(list(self.cache_root.rglob('*.data')))
        deletion = self.delete_source()
        self.assertEqual(deletion['task_status'], 'succeeded')
        self.assertEqual(deletion['status'], 'deleted')
        self.assertFalse(list(self.cache_root.rglob('*.data')))
        self.assertEqual(service.read_media(self.scope, result.resource_id, result.artifacts[0].artifact_id).status, 'resource_unavailable')
        self.assertEqual(self.source_file.read_bytes(), b'synthetic source unchanged')

    def test_delete_during_reader_prevents_late_publication_and_directory_recreation(self):
        from tests.support.media_fixtures import BlockingReader
        reader = BlockingReader(self.source_file)
        service = self.service(reader=reader)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(service.extract_media, self.scope, self.message_id, 'original', 'race-1')
            try:
                self.assertTrue(reader.started.wait(3))
                self.assertEqual(self.delete_source()['task_status'], 'succeeded')
            finally:
                reader.release.set()
            self.assertEqual(pending.result(timeout=3).status, 'attempt_invalidated')
        self.assertFalse(list(self.cache_root.rglob('*.data')))
        self.assertFalse(list(self.cache_root.rglob('*.part')))
        self.assertEqual(list(self.cache_root.iterdir()), [])

    def test_variants_offer_safe_choices_but_never_hide_message_ambiguity(self):
        from dataclasses import replace
        from tests.support.media_fixtures import SyntheticReader

        class Variants(SyntheticReader):

            def locate(self, authorization, target):
                original = super().locate(authorization, target)[0]
                return (original, replace(original, variant='thumbnail', resource_row='row-10'))
        service = self.service(reader=Variants(self.source_file))
        choice = service.extract_media(self.scope, self.message_id, 'original', 'variants-1')
        self.assertEqual(choice.status, 'variant_ambiguous')
        self.assertEqual(choice.variant_options, ('original', 'thumbnail'))
        self.assertFalse(self.cache_root.exists())
        result = service.extract_media(self.scope, self.message_id, 'original', 'variants-2', variant='thumbnail')
        self.assertEqual(result.status, 'ready')

        class ConflictingMessages(Variants):

            def locate(self, authorization, target):
                first, second = super().locate(authorization, target)
                return (first, replace(second, message_shard='another-message-shard'))
        conflict = self.service(reader=ConflictingMessages(self.source_file)).extract_media(self.scope, self.message_id, 'original', 'variants-3', variant='original')
        self.assertEqual(conflict.status, 'association_ambiguous')

    def test_specific_source_deletion_never_rebinds_same_request_to_surviving_source(self):
        from tests.support.media_fixtures import SyntheticReader
        service = self.service(reader=SyntheticReader(self.source_file))
        original = service.extract_media(self.scope, self.message_id, 'original', 'fixed-source')
        second_source, second_ref = self.add_source_reference()
        ambiguous = service.extract_media(self.scope, self.message_id, 'original', 'choose-source')
        self.assertEqual(ambiguous.status, 'source_ambiguous')
        self.assertEqual({option.source_ref_id for option in ambiguous.source_options}, {self.ref_id, second_ref})
        selected = service.extract_media(self.scope, self.message_id, 'original', 'explicit-source', source_ref_id=second_ref)
        self.assertEqual(selected.status, 'ready')
        self.assertEqual(self.delete_source()['status'], 'deleted')
        self.assertEqual(service.read_media(self.scope, original.resource_id, original.artifacts[0].artifact_id).status, 'resource_unavailable')
        replay = service.extract_media(self.scope, self.message_id, 'original', 'fixed-source')
        self.assertEqual(replay.status, 'attempt_invalidated')
        self.assertEqual(service.read_media(self.scope, selected.resource_id, selected.artifacts[0].artifact_id).status, 'ready')
        fresh = service.extract_media(self.scope, self.message_id, 'original', 'new-source')
        self.assertEqual(fresh.source_ref_id, second_ref)
        self.assertEqual(fresh.status, 'ready')
        self.assertNotEqual(fresh.resource_id, original.resource_id)

    def test_failed_request_retries_once_then_replays_without_extra_files(self):
        from notalone.media.models import MediaError, OriginalMediaProducer
        from tests.support.media_fixtures import SyntheticReader

        class FailOnce(OriginalMediaProducer):
            failed = False

            def produce(self, source, target, budgets):
                if not self.failed:
                    self.failed = True
                    raise MediaError('invalid_output')
                return super().produce(source, target, budgets)
        service = self.service(reader=SyntheticReader(self.source_file), producer=FailOnce())
        self.assertEqual(service.extract_media(self.scope, self.message_id, 'original', 'retry-1').status, 'invalid_output')
        result = service.extract_media(self.scope, self.message_id, 'original', 'retry-1')
        self.assertEqual(result.status, 'ready')
        replay = service.extract_media(self.scope, self.message_id, 'original', 'retry-1')
        self.assertEqual(replay, result)
        self.assertEqual(len(list(self.cache_root.rglob('*.data'))), 1)
        conflict = service.extract_media(self.scope, self.message_id, 'image', 'retry-1')
        self.assertEqual(conflict.status, 'request_conflict')

    def test_crash_after_staging_write_is_recovered_on_explicit_retry(self):
        from datetime import datetime, timedelta, timezone
        from notalone.media.cache import ManagedMediaCache
        from tests.support.media_fixtures import SyntheticReader

        class CrashAfterWrite(ManagedMediaCache):

            def write(self, fd, artifact_id, data):
                super().write(fd, artifact_id, data)
                raise SystemExit('synthetic process loss')
        now = datetime.now(timezone.utc)
        crash = self.service(reader=SyntheticReader(self.source_file), clock=lambda: now, cache=CrashAfterWrite(self.cache_root.resolve()))
        with self.assertRaises(SystemExit):
            crash.extract_media(self.scope, self.message_id, 'original', 'crash-1')
        self.assertEqual(len(list(self.cache_root.rglob('*.part'))), 1)
        recovery = self.service(reader=SyntheticReader(self.source_file), clock=lambda: now + timedelta(seconds=61))
        result = recovery.extract_media(self.scope, self.message_id, 'original', 'crash-1')
        self.assertEqual(result.status, 'ready')
        self.assertFalse(list(self.cache_root.rglob('*.part')))
        self.assertEqual(len(list(self.cache_root.rglob('*.data'))), 1)

    def test_unlink_failure_keeps_delete_failed_and_explicit_retry_cleans_manifest(self):
        import os
        from unittest.mock import patch
        from tests.support.media_fixtures import SyntheticReader
        service = self.service(reader=SyntheticReader(self.source_file))
        result = service.extract_media(self.scope, self.message_id, 'original', 'unlink-1')
        unlink = os.unlink

        def refuse_data(path, *args, **kwargs):
            if str(path).endswith('.data'):
                raise PermissionError('synthetic private path')
            return unlink(path, *args, **kwargs)
        with patch('os.unlink', side_effect=refuse_data):
            failed = self.delete_source()
        self.assertEqual(failed['status'], 'delete_failed')
        self.assertEqual(failed['task_status'], 'failed')
        self.assertTrue(list(self.cache_root.rglob('*.data')))
        self.assertNotEqual(service.read_media(self.scope, result.resource_id, result.artifacts[0].artifact_id).status, 'ready')
        recovered = self.delete_source()
        self.assertEqual(recovered['status'], 'deleted')
        self.assertEqual(recovered['task_status'], 'succeeded')
        self.assertFalse(list(self.cache_root.rglob('*.data')))

    def test_rename_followed_by_database_commit_failure_cleans_and_can_retry(self):
        from tests.support.media_fixtures import SyntheticReader
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""
                CREATE FUNCTION synthetic_media_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'synthetic private database detail'; END $$;
                CREATE CONSTRAINT TRIGGER synthetic_media_commit_failure
                AFTER UPDATE ON public.media_attempt DEFERRABLE INITIALLY DEFERRED
                FOR EACH ROW WHEN (NEW.status='ready') EXECUTE FUNCTION synthetic_media_commit_failure();
            """)
        try:
            service = self.service(reader=SyntheticReader(self.source_file))
            failed = service.extract_media(self.scope, self.message_id, 'original', 'commit-1')
            self.assertEqual(failed.status, 'storage_failed')
            self.assertFalse(list(self.cache_root.rglob('*.data')))
            self.assertFalse(list(self.cache_root.rglob('*.part')))
            self.assertEqual(self.source_file.read_bytes(), b'synthetic source unchanged')
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute('DROP TRIGGER synthetic_media_commit_failure ON public.media_attempt; DROP FUNCTION synthetic_media_commit_failure()')
        self.assertEqual(service.extract_media(self.scope, self.message_id, 'original', 'commit-1').status, 'ready')

    def test_voice_result_requires_two_roles_in_one_collection(self):
        from notalone.media.models import ProducedArtifact
        from tests.support.media_fixtures import SyntheticReader
        source_id, message_id, ref_id = self.import_source(kind='voice', local_id=8)

        class SyntheticVoiceProducer:

            def __init__(self, complete):
                self.complete = complete

            def produce(self, source, target, budgets):
                playable = ProducedArtifact('playable_wav', 'audio/wav', b'synthetic-wav', 1.0)
                return (ProducedArtifact('original_silk', 'audio/silk', b'synthetic-silk', None), playable) if self.complete else (playable,)
        incomplete = self.service(reader=SyntheticReader(self.source_file), producer=SyntheticVoiceProducer(False))
        self.assertEqual(incomplete.extract_media(self.scope, message_id, 'voice', 'voice-incomplete').status, 'invalid_output')
        complete = self.service(reader=SyntheticReader(self.source_file), producer=SyntheticVoiceProducer(True))
        result = complete.extract_media(self.scope, message_id, 'voice', 'voice-complete')
        self.assertEqual(result.status, 'ready')
        self.assertEqual({item.role for item in result.artifacts}, {'original_silk', 'playable_wav'})
        self.assertEqual({complete.read_media(self.scope, result.resource_id, item.artifact_id).data for item in result.artifacts}, {b'synthetic-silk', b'synthetic-wav'})
        self.assertEqual(self.delete_source(source_id)['status'], 'deleted')
        self.assertFalse(list(self.cache_root.rglob('*.data')))

    def test_retry_cannot_change_initially_selected_variant_or_physical_resource(self):
        from dataclasses import replace
        from notalone.media.models import MediaError, OriginalMediaProducer
        from tests.support.media_fixtures import SyntheticReader

        class MutableLocation(SyntheticReader):
            resource_row = 'row-9'

            def locate(self, authorization, target):
                return (replace(super().locate(authorization, target)[0], resource_row=self.resource_row),)

        class RejectOutput(OriginalMediaProducer):

            def produce(self, source, target, budgets):
                raise MediaError('invalid_output')
        reader = MutableLocation(self.source_file)
        failed = self.service(reader=reader, producer=RejectOutput()).extract_media(self.scope, self.message_id, 'original', 'frozen-resource')
        self.assertEqual(failed.status, 'invalid_output')
        reader.resource_row = 'different-resource-row'
        retry = self.service(reader=reader).extract_media(self.scope, self.message_id, 'original', 'frozen-resource')
        self.assertEqual(retry.status, 'association_ambiguous')
        self.assertFalse(list(self.cache_root.rglob('*.data')))

    def test_scope_concurrency_budget_rejects_additional_reader(self):
        from notalone.media.models import MediaBudgets
        from tests.support.media_fixtures import BlockingReader, SyntheticReader
        reader = BlockingReader(self.source_file)
        budgets = MediaBudgets(max_concurrent_per_scope=1)
        first = self.service(reader=reader, budgets=budgets)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(first.extract_media, self.scope, self.message_id, 'original', 'busy-1')
            try:
                self.assertTrue(reader.started.wait(3))
                second = self.service(reader=SyntheticReader(self.source_file), budgets=budgets)
                result = second.extract_media(self.scope, self.message_id, 'original', 'busy-2')
                self.assertEqual(result.status, 'scope_busy')
            finally:
                reader.release.set()
            self.assertEqual(pending.result(timeout=3).status, 'ready')

    def test_delete_retains_manifest_when_writer_adds_file_after_directory_listing(self):
        import os
        from queue import Queue
        from threading import Event
        from unittest.mock import patch

        from notalone.media.cache import ManagedMediaCache
        from tests.support.media_fixtures import SyntheticReader

        entered = Event()
        writes = Queue()
        attempt_identity = None

        class InterruptedWriter(ManagedMediaCache):
            def write(self, fd, artifact_id, data):
                nonlocal attempt_identity
                info = os.fstat(fd)
                attempt_identity = (info.st_dev, info.st_ino)
                entered.set()
                while True:
                    acknowledgement = writes.get(timeout=5)
                    if acknowledgement is None:
                        raise SystemExit("synthetic writer interruption")
                    super().write(fd, uuid4(), data)
                    acknowledgement.set()

        cache = InterruptedWriter(self.cache_root.resolve())
        service = self.service(reader=SyntheticReader(self.source_file), cache=cache)
        listdir = os.listdir

        def list_then_allow_writer(path):
            names = listdir(path)
            if isinstance(path, int):
                info = os.fstat(path)
                if (info.st_dev, info.st_ino) == attempt_identity:
                    acknowledgement = Event()
                    writes.put(acknowledgement)
                    self.assertTrue(acknowledgement.wait(3))
            return names

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                service.extract_media, self.scope, self.message_id, "original", "late-part",
            )
            try:
                self.assertTrue(entered.wait(3))
                with patch("os.listdir", side_effect=list_then_allow_writer):
                    deletion = self.delete_source()
                self.assertEqual(deletion["status"], "delete_failed")
                self.assertEqual(deletion["task_status"], "failed")
                self.assertEqual(len(list(self.cache_root.rglob("*.part"))), 1)
            finally:
                writes.put(None)
                with self.assertRaises(SystemExit):
                    pending.result(timeout=3)
        self.assertEqual(self.delete_source()["status"], "deleted")
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertEqual(list(self.cache_root.iterdir()), [])

    def test_delete_finishes_remaining_files_after_other_cleaner_removes_one_and_stops(self):
        import os
        from unittest.mock import patch

        from tests.support.media_fixtures import SyntheticReader

        service = self.service(reader=SyntheticReader(self.source_file))
        result = service.extract_media(self.scope, self.message_id, "original", "two-cleaners")
        self.assertEqual(result.status, "ready")
        managed_file = next(self.cache_root.rglob("*.data"))
        (managed_file.parent / (uuid4().hex + ".part")).write_bytes(b"synthetic partial")
        unlink = os.unlink
        interrupted = False

        def remove_one_and_stop(path, *args, **kwargs):
            unlink(path, *args, **kwargs)
            raise SystemExit("synthetic cleaner interruption")

        def concurrent_unlink(path, *args, **kwargs):
            nonlocal interrupted
            if not interrupted and str(path).endswith((".data", ".part")):
                interrupted = True
                with ThreadPoolExecutor(max_workers=1) as pool:
                    stopped = pool.submit(remove_one_and_stop, path, *args, **kwargs)
                    with self.assertRaises(SystemExit):
                        stopped.result(timeout=3)
            return unlink(path, *args, **kwargs)

        with patch("os.unlink", side_effect=concurrent_unlink):
            deletion = self.delete_source()
        self.assertTrue(interrupted)
        self.assertEqual(deletion["status"], "deleted")
        self.assertEqual(deletion["task_status"], "succeeded")
        self.assertFalse(list(self.cache_root.rglob("*.data")))
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertEqual(list(self.cache_root.iterdir()), [])
        self.assertEqual(
            service.read_media(self.scope, result.resource_id, result.artifacts[0].artifact_id).status,
            "resource_unavailable",
        )

    def test_source_choice_filters_ineligible_confirmation_chain_before_ambiguity(self):
        from tests.support.media_fixtures import SyntheticReader

        _, eligible_ref = self.add_source_reference()
        service = self.service(reader=SyntheticReader(self.source_file))
        with psycopg.connect(self.database_url) as connection:
            revoked_identity = uuid4()
            connection.execute(
                "INSERT INTO public.channel_identity "
                "(id,owner_id,contact_id,channel,external_id,observed_name,status) "
                "VALUES (%s,%s,%s,'wechat',%s,'合成旧身份','revoked')",
                (revoked_identity, self.scope.owner_id, self.scope.contact_id, "revoked-" + uuid4().hex),
            )
        for label, identity in (("missing_identity", None), ("revoked_identity", revoked_identity)):
            with self.subTest(label=label):
                with psycopg.connect(self.database_url) as connection:
                    connection.execute(
                        "UPDATE public.import_confirmation SET channel_identity_id=%s "
                        "WHERE source_document_id=%s",
                        (identity, self.source_id),
                    )
                result = service.extract_media(self.scope, self.message_id, "original", label)
                self.assertEqual(result.status, "ready")
                self.assertEqual(result.source_ref_id, eligible_ref)
                self.assertEqual(result.source_options, ())
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "DELETE FROM public.import_confirmation WHERE source_document_id=%s",
                (self.source_id,),
            )
        missing = service.extract_media(self.scope, self.message_id, "original", "missing_confirmation")
        self.assertEqual(missing.status, "ready")
        self.assertEqual(missing.source_ref_id, eligible_ref)
        rejected = service.extract_media(
            self.scope, self.message_id, "original", "explicit_ineligible", source_ref_id=self.ref_id,
        )
        self.assertEqual(rejected.status, "source_unavailable")

    def test_new_request_recovers_expired_parts_only_in_requested_scope(self):
        from datetime import datetime, timedelta, timezone
        from notalone.media.cache import ManagedMediaCache
        from tests.support.media_fixtures import SyntheticReader

        class CrashAfterWrite(ManagedMediaCache):
            def write(self, fd, artifact_id, data):
                super().write(fd, artifact_id, data)
                raise SystemExit("synthetic interruption")

        now = datetime.now(timezone.utc)
        reader = SyntheticReader(self.source_file)
        ready_service = self.service(reader=reader, clock=lambda: now)
        kept = ready_service.extract_media(self.scope, self.message_id, "original", "kept-ready")
        other_scope = ContactScope(self.scope.owner_id, uuid4())
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'合成其他联系人')",
                (other_scope.owner_id, other_scope.contact_id),
            )
        _, other_message, _ = self.import_source(scope=other_scope, talker="synthetic_other_" + uuid4().hex)
        crash = self.service(
            reader=reader, clock=lambda: now,
            cache=CrashAfterWrite(self.cache_root.resolve()),
        )
        for scope, message, key in (
            (self.scope, self.message_id, "interrupted-own"),
            (other_scope, other_message, "interrupted-other"),
        ):
            with self.assertRaises(SystemExit):
                crash.extract_media(scope, message, "original", key)
        self.assertEqual(len(list(self.cache_root.rglob("*.part"))), 2)
        recovery = self.service(reader=reader, clock=lambda: now + timedelta(seconds=61))
        result = recovery.extract_media(self.scope, self.message_id, "original", "fresh-key")
        self.assertEqual(result.status, "ready")
        remaining = list(self.cache_root.rglob("*.part"))
        self.assertEqual(len(remaining), 1)
        self.assertIn(other_scope.contact_id.hex, remaining[0].parts)
        self.assertEqual(
            recovery.read_media(self.scope, kept.resource_id, kept.artifacts[0].artifact_id).data,
            b"synthetic source unchanged",
        )

    def test_expired_reader_cannot_publish_even_without_another_request(self):
        from datetime import datetime, timedelta, timezone
        from tests.support.media_fixtures import BlockingReader

        now = [datetime.now(timezone.utc)]
        reader = BlockingReader(self.source_file)
        service = self.service(reader=reader, clock=lambda: now[0])
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                service.extract_media, self.scope, self.message_id, "original", "expired-result",
            )
            try:
                self.assertTrue(reader.started.wait(3))
                now[0] += timedelta(seconds=61)
            finally:
                reader.release.set()
            self.assertEqual(pending.result(timeout=3).status, "attempt_invalidated")
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertFalse(list(self.cache_root.rglob("*.data")))

    def test_late_reader_success_and_failure_cannot_damage_same_key_new_attempt(self):
        from contextlib import contextmanager
        from datetime import datetime, timedelta, timezone
        from notalone.media.models import MediaError
        from tests.support.media_fixtures import BlockingReader, SyntheticReader

        class LateReader(BlockingReader):
            fail_after_release = False

            @contextmanager
            def open(self, location):
                with super().open(location) as source:
                    if self.fail_after_release:
                        raise MediaError("upstream_failed")
                    yield source

        for fails in (False, True):
            with self.subTest(late_failure=fails):
                now = datetime.now(timezone.utc)
                reader = LateReader(self.source_file)
                reader.fail_after_release = fails
                original = self.service(reader=reader, clock=lambda: now)
                key = "late-failure" if fails else "late-success"
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(
                        original.extract_media, self.scope, self.message_id, "original", key,
                    )
                    try:
                        self.assertTrue(reader.started.wait(3))
                        recovery = self.service(
                            reader=SyntheticReader(self.source_file),
                            clock=lambda: now + timedelta(seconds=61),
                        )
                        fresh = recovery.extract_media(self.scope, self.message_id, "original", key)
                        self.assertEqual(fresh.status, "ready")
                    finally:
                        reader.release.set()
                    self.assertEqual(pending.result(timeout=3).status, "attempt_invalidated")
                self.assertEqual(
                    recovery.read_media(self.scope, fresh.resource_id, fresh.artifacts[0].artifact_id).data,
                    b"synthetic source unchanged",
                )
                self.assertEqual(recovery.extract_media(self.scope, self.message_id, "original", key), fresh)

    def test_recovery_cleanup_failure_blocks_new_reader_and_remains_recoverable(self):
        from datetime import datetime, timedelta, timezone
        import os
        from unittest.mock import patch

        from notalone.media.cache import ManagedMediaCache
        from tests.support.media_fixtures import SyntheticReader

        class CrashAfterWrite(ManagedMediaCache):
            def write(self, fd, artifact_id, data):
                super().write(fd, artifact_id, data)
                raise SystemExit("synthetic interruption")

        class RefuseUnexpectedRead(SyntheticReader):
            def open(self, location):
                raise AssertionError("recovery must finish before source I/O")

        now = datetime.now(timezone.utc)
        crashed = self.service(
            reader=SyntheticReader(self.source_file), clock=lambda: now,
            cache=CrashAfterWrite(self.cache_root.resolve()),
        )
        with self.assertRaises(SystemExit):
            crashed.extract_media(self.scope, self.message_id, "original", "recoverable-part")
        unlink = os.unlink

        def refuse_part(path, *args, **kwargs):
            if str(path).endswith(".part"):
                raise PermissionError("synthetic cleanup failure")
            return unlink(path, *args, **kwargs)

        blocked = self.service(
            reader=RefuseUnexpectedRead(self.source_file),
            clock=lambda: now + timedelta(seconds=61),
        )
        with patch("os.unlink", side_effect=refuse_part):
            for key in ("blocked-new-1", "blocked-new-2"):
                result = blocked.extract_media(self.scope, self.message_id, "original", key)
                self.assertEqual(result.status, "cleanup_pending")
                self.assertEqual(len(list(self.cache_root.rglob("*.part"))), 1)
                self.assertFalse(list(self.cache_root.rglob("*.data")))
        recovered = self.service(
            reader=SyntheticReader(self.source_file), clock=lambda: now + timedelta(seconds=61),
        ).extract_media(self.scope, self.message_id, "original", "recovered-new")
        self.assertEqual(recovered.status, "ready")
        self.assertFalse(list(self.cache_root.rglob("*.part")))

    def test_explicit_read_cleans_invalid_authorization_and_tombstones_old_key(self):
        from tests.support.media_fixtures import SyntheticReader

        _, independent_message, _ = self.import_source(local_id=8)
        service = self.service(reader=SyntheticReader(self.source_file))
        original = service.extract_media(self.scope, self.message_id, "original", "old-authorization")
        independent = service.extract_media(self.scope, independent_message, "original", "independent-import")
        original_file = next(
            path for path in self.cache_root.rglob("*.data")
            if path.name == original.artifacts[0].artifact_id.hex + ".data"
        )
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "DELETE FROM public.import_confirmation WHERE source_document_id=%s",
                (self.source_id,),
            )
        rejected = service.read_media(self.scope, original.resource_id, original.artifacts[0].artifact_id)
        self.assertNotEqual(rejected.status, "ready")
        self.assertFalse(original_file.exists())
        self.assertEqual(
            service.read_media(self.scope, independent.resource_id, independent.artifacts[0].artifact_id).data,
            b"synthetic source unchanged",
        )
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.import_confirmation "
                "(owner_id,contact_id,source_document_id,channel_identity_id,method) "
                "SELECT owner_id,contact_id,%s,id,'manual_select' FROM public.channel_identity "
                "WHERE owner_id=%s AND contact_id=%s AND status='active'",
                (self.source_id, self.scope.owner_id, self.scope.contact_id),
            )
        self.assertEqual(
            service.extract_media(self.scope, self.message_id, "original", "old-authorization").status,
            "attempt_invalidated",
        )
        self.assertEqual(
            service.extract_media(self.scope, self.message_id, "original", "new-authorization").status,
            "ready",
        )

    def test_cache_symlink_fifo_and_tampering_are_unreadable_and_source_delete_cleans_them(self):
        import os
        from tests.support.media_fixtures import SyntheticReader

        service = self.service(reader=SyntheticReader(self.source_file))
        for index, kind in enumerate(("symlink", "fifo", "tampered"), start=9):
            with self.subTest(cache_fault=kind):
                source_id, message_id, _ = self.import_source(local_id=index)
                ready = service.extract_media(self.scope, message_id, "original", "cache-" + kind)
                self.assertEqual(ready.status, "ready")
                artifact = ready.artifacts[0]
                path = next(
                    item for item in self.cache_root.rglob("*.data")
                    if item.name == artifact.artifact_id.hex + ".data"
                )
                if kind == "tampered":
                    path.write_bytes(b"synthetic source tampered!")
                else:
                    path.unlink()
                    if kind == "symlink":
                        path.symlink_to(self.source_file)
                    else:
                        os.mkfifo(path, 0o600)
                refused = service.read_media(self.scope, ready.resource_id, artifact.artifact_id)
                self.assertNotEqual(refused.status, "ready")
                self.assertIsNone(refused.data)
                self.assertEqual(self.delete_source(source_id)["status"], "deleted")
                self.assertFalse(os.path.lexists(path))
                self.assertEqual(self.source_file.read_bytes(), b"synthetic source unchanged")

    def test_disk_full_after_partial_write_cleans_files_and_allows_explicit_retry(self):
        import errno
        from notalone.media.cache import ManagedMediaCache
        from tests.support.media_fixtures import SyntheticReader

        class FullDisk(ManagedMediaCache):
            def write(self, fd, artifact_id, data):
                super().write(fd, artifact_id, data[:4])
                raise OSError(errno.ENOSPC, "synthetic private detail")

        failed = self.service(
            reader=SyntheticReader(self.source_file), cache=FullDisk(self.cache_root.resolve()),
        ).extract_media(self.scope, self.message_id, "original", "disk-full")
        self.assertEqual(failed.status, "storage_failed")
        self.assertNotIn("synthetic private detail", repr(failed))
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertFalse(list(self.cache_root.rglob("*.data")))
        self.assertEqual(self.source_file.read_bytes(), b"synthetic source unchanged")
        retried = self.service(reader=SyntheticReader(self.source_file)).extract_media(
            self.scope, self.message_id, "original", "disk-full",
        )
        self.assertEqual(retried.status, "ready")

    def test_killed_owned_runner_leaves_registered_part_for_new_key_recovery(self):
        from datetime import datetime, timedelta, timezone
        import os
        import select
        import subprocess
        import sys
        from tests.support.media_fixtures import SyntheticReader

        now = datetime.now(timezone.utc)
        program = """
from datetime import datetime
from pathlib import Path
import sys
import time
from uuid import UUID
from notalone.media.cache import ManagedMediaCache
from notalone.media.service import MediaService
from notalone.scopes import ContactScope
from tests.support.media_fixtures import SyntheticReader

class WaitAfterWrite(ManagedMediaCache):
    def write(self, fd, artifact_id, data):
        super().write(fd, artifact_id, data)
        print("staged", flush=True)
        while True:
            time.sleep(1)

database, root, source, owner, contact, message, timestamp = sys.argv[1:]
service = MediaService(
    database, Path(root), reader=SyntheticReader(Path(source)),
    cache=WaitAfterWrite(Path(root).resolve()),
    clock=lambda: datetime.fromisoformat(timestamp),
)
service.extract_media(ContactScope(UUID(owner), UUID(contact)), UUID(message), "original", "killed-runner")
"""
        process = subprocess.Popen(
            [sys.executable, "-c", program, self.database_url, str(self.cache_root),
             str(self.source_file), str(self.scope.owner_id), str(self.scope.contact_id),
             str(self.message_id), now.isoformat()],
            cwd=Path(__file__).resolve().parents[3],
            env=dict(os.environ, NOTALONE_ENV_FILE="/dev/null"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            readable, _, _ = select.select([process.stdout], [], [], 5)
            self.assertTrue(readable, "合成 runner 未在预算内落盘")
            self.assertEqual(process.stdout.readline().strip(), "staged")
            self.assertEqual(len(list(self.cache_root.rglob("*.part"))), 1)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)
        self.assertIsNotNone(process.returncode)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(len(list(self.cache_root.rglob("*.part"))), 1)
        recovered = self.service(
            reader=SyntheticReader(self.source_file), clock=lambda: now + timedelta(seconds=61),
        ).extract_media(self.scope, self.message_id, "original", "after-kill-new-key")
        self.assertEqual(recovered.status, "ready")
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertEqual(len(list(self.cache_root.rglob("*.data"))), 1)
        self.assertEqual(self.source_file.read_bytes(), b"synthetic source unchanged")

    def test_duplicate_external_ids_across_owners_never_authorize_foreign_message_or_artifact(self):
        from tests.support.media_fixtures import SyntheticReader

        other_scope = ContactScope(uuid4(), self.scope.contact_id)
        other_external = "synthetic_other_owner_" + uuid4().hex
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.owner (id,display_name) VALUES (%s,'合成其他用户')",
                (other_scope.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'合成同名联系人')",
                (other_scope.owner_id, other_scope.contact_id),
            )
            connection.execute(
                "INSERT INTO public.owner_channel_identity (owner_id,channel,external_id,observed_name) "
                "VALUES (%s,'wechat',%s,'合成其他本人')",
                (other_scope.owner_id, other_external),
            )

        def remove_owned_fixture():
            with psycopg.connect(self.database_url) as connection:
                connection.execute("DELETE FROM public.owner WHERE id=%s", (other_scope.owner_id,))

        self.addCleanup(remove_owned_fixture)
        _, other_message, other_ref = self.import_source(
            scope=other_scope, talker=self.talker, owner_external=other_external,
        )
        foreign_source = Path(self.directory.name) / "other-borrowed"
        foreign_source.write_bytes(b"synthetic other owner")

        class NoSourceReads(SyntheticReader):
            def open(self, location):
                raise AssertionError("foreign request must not open media")

        own = self.service(reader=SyntheticReader(self.source_file))
        foreign = self.service(reader=SyntheticReader(foreign_source))
        refusing = self.service(reader=NoSourceReads(self.source_file))
        refused = refusing.extract_media(self.scope, other_message, "original", "foreign-message")
        self.assertEqual(refused.status, "message_unavailable")
        wrong_ref = refusing.extract_media(
            self.scope, self.message_id, "original", "foreign-ref", source_ref_id=other_ref,
        )
        self.assertEqual(wrong_ref.status, "source_unavailable")
        own_ready = own.extract_media(self.scope, self.message_id, "original", "same-request-key")
        foreign_ready = foreign.extract_media(other_scope, other_message, "original", "same-request-key")
        self.assertEqual(own_ready.status, "ready")
        self.assertEqual(foreign_ready.status, "ready")
        self.assertEqual(
            own.read_media(self.scope, foreign_ready.resource_id, foreign_ready.artifacts[0].artifact_id).status,
            "resource_unavailable",
        )
        self.assertEqual(
            own.read_media(self.scope, own_ready.resource_id, own_ready.artifacts[0].artifact_id).data,
            b"synthetic source unchanged",
        )
        self.assertEqual(
            foreign.read_media(other_scope, foreign_ready.resource_id, foreign_ready.artifacts[0].artifact_id).data,
            b"synthetic other owner",
        )

    def test_invalid_authorization_cleanup_failure_stays_invalid_after_confirmation_restored(self):
        import os
        from unittest.mock import patch
        from tests.support.media_fixtures import SyntheticReader

        service = self.service(reader=SyntheticReader(self.source_file))
        old = service.extract_media(self.scope, self.message_id, "original", "invalidated-key")
        with psycopg.connect(self.database_url) as connection:
            identity, verified_at = connection.execute(
                "SELECT id,verified_at FROM public.channel_identity "
                "WHERE owner_id=%s AND contact_id=%s AND status='active'",
                (self.scope.owner_id, self.scope.contact_id),
            ).fetchone()
            connection.execute(
                "UPDATE public.channel_identity SET verified_at=verified_at + interval '1 second' WHERE id=%s",
                (identity,),
            )
        unlink = os.unlink

        def refuse_data(path, *args, **kwargs):
            if str(path).endswith(".data"):
                raise PermissionError("synthetic cleanup denial")
            return unlink(path, *args, **kwargs)

        with patch("os.unlink", side_effect=refuse_data):
            self.assertEqual(
                service.read_media(self.scope, old.resource_id, old.artifacts[0].artifact_id).status,
                "cleanup_pending",
            )
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.channel_identity SET verified_at=%s WHERE id=%s",
                    (verified_at, identity),
                )
            self.assertEqual(
                service.read_media(self.scope, old.resource_id, old.artifacts[0].artifact_id).status,
                "cleanup_pending",
            )
            self.assertEqual(len(list(self.cache_root.rglob("*.data"))), 1)
        self.assertEqual(
            service.extract_media(self.scope, self.message_id, "original", "invalidated-key").status,
            "attempt_invalidated",
        )
        self.assertFalse(list(self.cache_root.rglob("*.data")))
        renewed = service.extract_media(self.scope, self.message_id, "original", "renewed-key")
        self.assertEqual(renewed.status, "ready")
        self.assertNotEqual(renewed.resource_id, old.resource_id)

    def test_authorization_revoked_during_read_never_revives_same_request_key(self):
        from contextlib import contextmanager
        from tests.support.media_fixtures import SyntheticReader

        class RevokingReader(SyntheticReader):
            @contextmanager
            def open(reader, location):
                with psycopg.connect(self.database_url) as connection:
                    connection.execute(
                        "UPDATE public.channel_identity SET status='revoked' "
                        "WHERE owner_id=%s AND contact_id=%s",
                        (self.scope.owner_id, self.scope.contact_id),
                    )
                with super(RevokingReader, reader).open(location) as source:
                    yield source

        failed = self.service(reader=RevokingReader(self.source_file)).extract_media(
            self.scope, self.message_id, "original", "revoked-during-read",
        )
        self.assertEqual(failed.status, "source_unavailable")
        self.assertFalse(list(self.cache_root.rglob("*.data")))
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.channel_identity SET status='active' WHERE owner_id=%s AND contact_id=%s",
                (self.scope.owner_id, self.scope.contact_id),
            )
        service = self.service(reader=SyntheticReader(self.source_file))
        self.assertEqual(
            service.extract_media(self.scope, self.message_id, "original", "revoked-during-read").status,
            "attempt_invalidated",
        )
        self.assertEqual(
            service.extract_media(self.scope, self.message_id, "original", "reconfirmed-new-key").status,
            "ready",
        )
    def wait_for_advisory_waiter(self, *, pid=None):
        deadline = time.monotonic() + 3
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            while time.monotonic() < deadline:
                waiting = connection.execute(
                    "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted "
                    "AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) "
                    "AND (%s::int IS NULL OR pid=%s)",
                    (pid, pid),
                ).fetchone()
                if waiting:
                    return
                time.sleep(0.01)
        self.fail("合成请求未在预算内进入范围锁等待")

    def test_publish_rechecks_lease_after_waiting_for_scope_lock(self):
        from datetime import datetime, timedelta, timezone
        from threading import Event
        from notalone.media.cache import ManagedMediaCache
        from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
        from tests.support.media_fixtures import SyntheticReader

        written, release_write = Event(), Event()
        now = [datetime.now(timezone.utc)]

        class PausedCache(ManagedMediaCache):
            def write(cache, fd, artifact_id, data):
                super().write(fd, artifact_id, data)
                written.set()
                if not release_write.wait(3):
                    raise TimeoutError("合成写入未获释放")

        service = self.service(
            reader=SyntheticReader(self.source_file), clock=lambda: now[0],
            cache=PausedCache(self.cache_root.resolve()),
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                service.extract_media, self.scope, self.message_id, "original", "lease-lock",
            )
            try:
                self.assertTrue(written.wait(3))
                with psycopg.connect(self.database_url) as blocker:
                    lock_contact_scope(
                        blocker, owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
                    )
                    lock_owner_scope(blocker, owner_id=self.scope.owner_id)
                    release_write.set()
                    self.wait_for_advisory_waiter()
                    now[0] += timedelta(seconds=61)
            finally:
                release_write.set()
            self.assertEqual(pending.result(timeout=3).status, "attempt_invalidated")
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertFalse(list(self.cache_root.rglob("*.data")))
        self.assertEqual(self.source_file.read_bytes(), b"synthetic source unchanged")

    def test_publish_rechecks_lease_after_cache_rename_and_fsync(self):
        from datetime import datetime, timedelta, timezone
        from notalone.media.cache import ManagedMediaCache
        from tests.support.media_fixtures import SyntheticReader

        now = [datetime.now(timezone.utc)]

        class ExpiringCache(ManagedMediaCache):
            def publish(cache, fd, artifact_id):
                super().publish(fd, artifact_id)
                now[0] += timedelta(seconds=61)

        service = self.service(
            reader=SyntheticReader(self.source_file), clock=lambda: now[0],
            cache=ExpiringCache(self.cache_root.resolve()),
        )
        result = service.extract_media(self.scope, self.message_id, "original", "lease-fsync")
        self.assertEqual(result.status, "attempt_invalidated")
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertFalse(list(self.cache_root.rglob("*.data")))
        self.assertEqual(self.source_file.read_bytes(), b"synthetic source unchanged")

    def assert_authorization_change_after_recovery_stays_invalid(self, operation):
        from datetime import datetime, timezone
        from threading import Event
        from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
        from tests.support.media_fixtures import SyntheticReader

        ready = self.service(reader=SyntheticReader(self.source_file)).extract_media(
            self.scope, self.message_id, "original", "recovery-gap",
        )
        self.assertEqual(ready.status, "ready")
        checking, finish_check = Event(), Event()

        class PausedClock:
            armed = True

            def __call__(clock):
                if clock.armed:
                    clock.armed = False
                    checking.set()
                    if not finish_check.wait(3):
                        raise TimeoutError("合成恢复检查未获释放")
                return datetime.now(timezone.utc)

        service = self.service(reader=SyntheticReader(self.source_file), clock=PausedClock())

        def access():
            if operation == "read":
                return service.read_media(
                    self.scope, ready.resource_id, ready.artifacts[0].artifact_id,
                )
            return service.extract_media(self.scope, self.message_id, "original", "recovery-gap")

        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(access)
            try:
                self.assertTrue(checking.wait(3))
                with psycopg.connect(self.database_url) as revoker:
                    def revoke():
                        lock_contact_scope(
                            revoker, owner_id=self.scope.owner_id,
                            contact_id=self.scope.contact_id,
                        )
                        lock_owner_scope(revoker, owner_id=self.scope.owner_id)
                        revoker.execute(
                            "UPDATE public.channel_identity SET status='revoked' "
                            "WHERE owner_id=%s AND contact_id=%s",
                            (self.scope.owner_id, self.scope.contact_id),
                        )
                        revoker.commit()

                    revocation = pool.submit(revoke)
                    self.wait_for_advisory_waiter(pid=revoker.info.backend_pid)
                    finish_check.set()
                    revocation.result(timeout=3)
                    self.assertEqual(pending.result(timeout=3).status, "source_unavailable")
            finally:
                finish_check.set()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.channel_identity SET status='active' WHERE owner_id=%s AND contact_id=%s",
                (self.scope.owner_id, self.scope.contact_id),
            )
        self.assertEqual(
            service.read_media(self.scope, ready.resource_id, ready.artifacts[0].artifact_id).status,
            "resource_unavailable",
        )
        self.assertEqual(
            service.extract_media(self.scope, self.message_id, "original", "recovery-gap").status,
            "attempt_invalidated",
        )
        self.assertFalse(list(self.cache_root.rglob("*.data")))
        self.assertFalse(list(self.cache_root.rglob("*.part")))
        self.assertEqual(self.source_file.read_bytes(), b"synthetic source unchanged")
        self.assertEqual(
            service.extract_media(self.scope, self.message_id, "original", "after-reconfirmation").status,
            "ready",
        )

    def test_read_persists_invalidation_when_authorization_changes_after_recovery(self):
        self.assert_authorization_change_after_recovery_stays_invalid("read")

    def test_replay_persists_invalidation_when_authorization_changes_after_recovery(self):
        self.assert_authorization_change_after_recovery_stays_invalid("replay")

if __name__ == '__main__':
    unittest.main()
