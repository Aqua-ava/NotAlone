"""本人整理的真实 HTTP、来源删除与迟到结果安全合同。"""

import unittest
from dataclasses import fields
from threading import Event, Thread

import psycopg

from notalone.memory.models import FactSubject
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server import test_owner_memory_overview as owner_support
from tests.integration.server import test_layered_profile_management as profile_support
from tests.integration.server.test_layered_memory_management import ControlledProposal, ControlledVerification


class RecordingProposal(ControlledProposal):
    def __init__(self):
        super().__init__()
        self.contexts = []

    def propose(self, *, memories, scenarios, budget, deadline):
        self.contexts.append(scenarios)
        return super().propose(memories=memories, budget=budget, deadline=deadline)


class RecordingVerification(ControlledVerification):
    def __init__(self):
        self.inputs = []
        self.contexts = []
        self.proposals = []

    def verify(self, *, memories, scenarios, proposal, deadline):
        self.inputs.append(memories)
        self.contexts.append(scenarios)
        self.proposals.append(proposal)
        return super().verify(memories=memories, proposal=proposal, deadline=deadline)


class OwnerLayeredSafetyHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    path = '/api/memories/owner/layered-memory'
    import_self = owner_support.OwnerMemoryOverviewHttpTest.import_self

    def prepare_self(self, text):
        contact, source, message = self.import_self(text)
        memory = self.confirm(contact, text, message, subject=FactSubject.SELF)
        return contact, source, memory

    def controlled(self, **options):
        return profile_support.LayeredProfileHttpTest.controlled(self, **options)

    def read(self, backend):
        return self._get(backend, self.path)['layered_memory']

    def enable(self, backend):
        status, result = backend.request(self.path + '/enable', {
            'settings_generation': self.read(backend)['settings_generation'],
            'purpose_confirmed': True})
        self.assertEqual(status, 200, result)
        return result['layered_memory']

    def test_two_contact_self_sources_share_one_owner_input_and_all_four_boundaries(self):
        originals = ['仅供来源核对的原话甲：本人曾完成合成课程。',
                     '仅供来源核对的原话乙：本人曾完成合成练习。']
        prepared = []
        for original, normalized in zip(originals, ['本人曾完成合成课程。', '本人曾完成合成练习。']):
            contact, source, message = self.import_self(original)
            memory = self.confirm(contact, normalized, message, subject=FactSubject.SELF)
            prepared.append((contact, source, memory))
        first, second = prepared
        self.assertNotEqual(first[0], second[0])
        status, other = self.backend.request('/api/memories/manual-contact', {
            'contact_id': first[0], 'text': '对方独有的合成秘密。', 'category': 'common_fact'})
        self.assertEqual(status, 200, other)
        verifier = RecordingVerification()
        proposer = RecordingProposal()
        backend = self.controlled(scenario_proposer=proposer, scenario_verifier=verifier)
        ready = self.enable(backend)
        self.assertEqual((ready['status'], ready['covered_count'], ready['model_calls_used']),
                         ('ready', 2, 4))
        self.assertIsNone(ready['contact_id'])
        expected = {first[2]['memory_id'], second[2]['memory_id']}
        boundaries = [self.scenario_proposer.inputs[0], verifier.inputs[0],
                      self.profile_proposer.inputs[0][1], self.profile_verifier.inputs[0][1]]
        for memories in boundaries:
            self.assertEqual({str(item.memory_id) for item in memories}, expected)
            for item in memories:
                self.assertEqual({field.name for field in fields(item)},
                                 {'memory_id', 'revision', 'text', 'timing'})
                self.assertEqual(set(item.to_payload()), {'memory_id', 'revision', 'text', 'timing'})
        # 检查四步实际接收的业务载荷，含提案与已生成的 L2 上下文。
        forbidden_keys = {'owner_id', 'contact_id', 'lineage', 'source_refs', 'source_ids',
                          'source_candidate_id', 'source_document_id', 'message_id',
                          'source_message_id', 'quote', 'original_text', 'raw_text',
                          'locator', 'external_id', 'sender_wxid', 'talker', 'evidence'}
        forbidden_values = {str(self.owner_id), first[0], second[0], first[1], second[1],
                            *originals, *self.contact_locators.values(),
                            '合成联系人私密资料：对方最近在安排合成行程。', '对方独有的合成秘密。'}
        for contact, _, _ in prepared:
            messages = self._get(self.backend, f'/api/contacts/{contact}/messages')['messages']
            forbidden_values.update(item['message_id'] for item in messages)

        def assert_clean(value):
            if hasattr(value, 'to_payload'):
                value = value.to_payload()
            if isinstance(value, dict):
                self.assertFalse(forbidden_keys.intersection(value), value)
                if 'references' in value:
                    for reference in value['references']:
                        self.assertIn(set(reference), ({'memory_id', 'revision'}, {'memory_id', 'revision', 'timing'}))
                for child in value.values():
                    assert_clean(child)
            elif isinstance(value, (list, tuple)):
                for child in value:
                    assert_clean(child)
            elif isinstance(value, str):
                for forbidden in forbidden_values:
                    self.assertNotIn(forbidden, value)

        actual_inputs = [
            (proposer.inputs[0], proposer.contexts[0]),
            (verifier.inputs[0], verifier.contexts[0], verifier.proposals[0]),
            self.profile_proposer.inputs[0], self.profile_verifier.inputs[0],
        ]
        self.assertTrue(self.profile_proposer.inputs[0][0], 'L3 须实际接收非空 L2 上下文')
        self.assertIn('event', self.profile_proposer.inputs[0][0][0]['paragraphs'][0]['references'][0]['timing'])
        for actual in actual_inputs:
            assert_clean(actual)
        with psycopg.connect(self.database_url) as db:
            rows = db.execute("SELECT scope_kind, contact_id FROM public.background_task "
                              "WHERE owner_id=%s AND task_type='layered_memory'", (self.owner_id,)).fetchall()
        self.assertEqual(rows, [('owner', None)])

    def test_deleting_uncited_self_source_erases_both_layers(self):
        self.prepare_self('本人曾完成合成课程。')
        contact, source, memory = self.prepare_self('本人曾完成另一合成练习。')
        backend = self.controlled()
        ready = self.enable(backend)
        self.assertEqual(ready['covered_count'], 2)
        self.assertTrue(ready['profile'])
        references = [reference['memory_id'] for entry in ready['profile']['entries']
                      for reference in entry['references']]
        self.assertNotIn(memory['memory_id'], references)
        from uuid import UUID
        from notalone.scopes import OwnerScope
        snapshot = self.service.capture(OwnerScope(self.owner_id))
        with psycopg.connect(self.database_url) as db:
            old_batches = [row[0] for row in db.execute(
                "SELECT id FROM public.layered_profile_batch WHERE owner_id=%s AND scope_kind='owner'",
                (self.owner_id,)).fetchall()]
        self.delete_source(contact, source)
        current = self.read(backend)
        self.assertFalse(self.service.validate(snapshot))
        self.assertTrue({row['version_id'] for row in ready['scenarios']}.isdisjoint(
            row['version_id'] for row in current['scenarios']))
        self.assertNotIn(memory['memory_id'], str(current))
        if current['profile']:
            self.assertNotEqual(current['profile']['version_id'], ready['profile']['version_id'])
        # 自动维护可用剩余合法资料生成新版本；被删除输入参与的旧版本必须物理清除。
        with psycopg.connect(self.database_url) as db:
            for table, ids in (
                ('layered_profile_batch', old_batches),
                ('layered_profile_version', [UUID(ready['profile']['version_id'])]),
                ('scenario_document_version', [UUID(row['version_id']) for row in ready['scenarios']]),
            ):
                self.assertEqual(db.execute(f'SELECT count(*) FROM public.{table} WHERE id=ANY(%s)',
                    (ids,)).fetchone()[0], 0, table)
            self.assertEqual(db.execute("SELECT count(*) FROM public.layered_memory_generation "
                "WHERE owner_id=%s AND scope_kind='owner' AND organization_generation=%s",
                (self.owner_id, ready['organization_generation'])).fetchone()[0], 0)
            for table in ('layered_memory_batch', 'layered_profile_batch'):
                self.assertEqual(db.execute(f'SELECT count(*) FROM public.{table} '
                    "WHERE owner_id=%s AND scope_kind='owner' AND dependency_ids && %s::uuid[]",
                    (self.owner_id, [UUID(memory['memory_id']), UUID(source)])).fetchone()[0], 0, table)

    def test_disabled_generation_rejects_late_profile_response(self):
        self.prepare_self('本人曾完成合成课程。')
        entered, release = Event(), Event()
        self.addCleanup(release.set)

        def block():
            entered.set()
            if not release.wait(8):
                raise RuntimeError('合成响应门等待超时')

        backend = self.controlled(profile_proposer=profile_support.ProfileProposal(hook=block))
        responses = []
        worker = Thread(target=lambda: responses.append(backend.request(self.path + '/enable', {
            'settings_generation': 0, 'purpose_confirmed': True})), daemon=True)
        worker.start()
        self.assertTrue(entered.wait(5))
        state = self.read(self.backend)
        status, result = self.backend.request(self.path + '/disable', {
            'settings_generation': state['settings_generation']})
        self.assertEqual(status, 200, result)
        release.set()
        worker.join(8)
        self.assertFalse(worker.is_alive())
        state = self.read(backend)
        self.assertFalse(state['enabled'])
        self.assertIsNone(state['profile'])
        self.assertEqual(len(responses), 1)

    def test_owner_scope_completes_while_contact_lock_is_held(self):
        from uuid import UUID
        from notalone.persistence.locks import lock_contact_scope, lock_owner_scope

        contact, _, _ = self.prepare_self('本人曾完成合成课程。')
        backend = self.controlled()
        responses = []
        with psycopg.connect(self.database_url) as deletion:
            deletion.execute("SET LOCAL lock_timeout='2s'")
            lock_contact_scope(deletion, owner_id=self.owner_id, contact_id=UUID(contact))
            worker = Thread(target=lambda: responses.append(backend.request(self.path + '/enable', {
                'settings_generation': 0, 'purpose_confirmed': True})), daemon=True)
            worker.start()
            worker.join(5)
            completed_without_contact_lock = not worker.is_alive()
            # 删除路径仍可按 contact → owner 次序取锁，不形成反向锁环。
            lock_owner_scope(deletion, owner_id=self.owner_id)
        worker.join(5)
        self.assertTrue(completed_without_contact_lock)
        self.assertFalse(worker.is_alive())
        self.assertEqual(responses[0][0], 200, responses)
        self.assertEqual(responses[0][1]['layered_memory']['status'], 'ready')

    def test_other_owner_cannot_read_or_delete_source_owner_artifacts(self):
        from uuid import uuid4
        from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory

        _, _, memory = self.prepare_self('本人曾完成合成课程。')
        backend = self.controlled()
        ready = self.enable(backend)
        other_id = uuid4()
        PostgresOwnerDirectory(self.database_url).create_owner(other_id, '隔离合成本人')

        def remove_other():
            with psycopg.connect(self.database_url) as db:
                db.execute('DELETE FROM public.owner WHERE id=%s', (other_id,))

        self.addCleanup(remove_other)
        other = self._backend(other_id)
        state = self.read(other)
        self.assertEqual((state['eligible_count'], state['scenarios'], state['profile']), (0, [], None))
        status, _ = other.request('/api/memories/owner/' + memory['memory_id'] + '/delete', {})
        self.assertEqual(status, 404)
        status, result = other.request(self.path + '/delete', {
            'settings_generation': state['settings_generation']})
        self.assertEqual(status, 200, result)
        current = self.read(backend)
        self.assertEqual(current['profile'], ready['profile'])
        self.assertEqual(current['scenarios'], ready['scenarios'])

    def test_source_erased_during_profile_call_cannot_return_as_late_artifact(self):
        from notalone.scopes import OwnerScope
        contact, source, _ = self.prepare_self('本人曾完成合成课程。')
        receipts = []

        def request_deletion():
            snapshot = self.service.capture(OwnerScope(self.owner_id))
            status, result = self.backend.request(
                f'/api/contacts/{contact}/sources/{source}', method='DELETE')
            visible = self.read(self.backend)
            receipts.append((status, result, snapshot, self.service.validate(snapshot), visible))

        backend = self.controlled(profile_proposer=profile_support.ProfileProposal(hook=request_deletion))
        returned = self.enable(backend)
        self.assertEqual(len(receipts), 1)
        status, _, snapshot, valid, visible = receipts[0]
        self.assertEqual(status, 202)
        self.assertIsNotNone(snapshot)
        self.assertFalse(valid)
        self.assertEqual((visible['eligible_count'], visible['scenarios'], visible['profile']), (0, [], None))
        self.assertEqual((returned['scenarios'], returned['profile']), ([], None))
        # 同一Worker全局锁仍由模型批次持有时，只确认公开删除门禁，不等待删除Worker抢锁。
        self.delete_source(contact, source)
        state = self.read(backend)
        self.assertFalse(self.service.validate(snapshot))
        self.assertEqual((state['eligible_count'], state['scenarios'], state['profile']), (0, [], None))
        with psycopg.connect(self.database_url) as db:
            for table in ('layered_memory_batch', 'layered_profile_batch', 'layered_profile_version'):
                self.assertEqual(db.execute(f'SELECT count(*) FROM public.{table} '
                    "WHERE owner_id=%s AND scope_kind='owner'", (self.owner_id,)).fetchone()[0], 0, table)
            self.assertEqual(db.execute("SELECT count(*) FROM public.layered_memory_job "
                "WHERE owner_id=%s AND scope_kind='owner' AND target_manifest <> '[]'::jsonb",
                (self.owner_id,)).fetchone()[0], 0)

    def test_restart_after_l2_commit_recovers_owner_profile_without_repeating_l2(self):
        self.prepare_self('本人曾完成合成课程。')
        with psycopg.connect(self.database_url) as db:
            db.execute('CREATE SEQUENCE synthetic_owner_profile_fault')
            db.execute("""CREATE FUNCTION synthetic_owner_profile_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.contact_id IS NULL AND nextval('synthetic_owner_profile_fault')=1 THEN
                        RAISE EXCEPTION 'synthetic owner process interruption';
                    END IF;
                    RETURN NEW;
                END; $$""")
            db.execute('CREATE TRIGGER synthetic_owner_profile_fault BEFORE INSERT ON public.layered_profile_batch '
                       'FOR EACH ROW EXECUTE FUNCTION synthetic_owner_profile_interrupt()')

        def remove_fault():
            with psycopg.connect(self.database_url) as db:
                db.execute('DROP TRIGGER synthetic_owner_profile_fault ON public.layered_profile_batch')
                db.execute('DROP FUNCTION synthetic_owner_profile_interrupt()')
                db.execute('DROP SEQUENCE synthetic_owner_profile_fault')

        self.addCleanup(remove_fault)
        backend = self.controlled()
        failed = self.enable(backend)
        self.assertEqual((failed['status'], failed['covered_count'], failed['model_calls_used']), ('failed', 1, 2))
        self.assertIsNone(failed['profile'])
        backend.close()
        restarted = self.controlled()
        status, result = restarted.request(self.path + '/refresh', {
            'settings_generation': failed['settings_generation']})
        self.assertEqual(status, 200, result)
        ready = result['layered_memory']
        self.assertEqual((ready['work_id'], ready['status'], ready['model_calls_used']),
                         (failed['work_id'], 'ready', 4))
        self.assertEqual(ready['scenarios'], failed['scenarios'])
        self.assertEqual(self.scenario_proposer.inputs, [])
        self.assertTrue(ready['profile'])

    def asynchronous(self):
        from tests.integration.server import test_layered_memory_management as scenario_support
        return scenario_support.LayeredMemoryManagementHttpTest.controlled(
            self, proposer=scenario_support.EchoProposal(), asynchronous=True)

    def test_real_worker_owner_auto_maintenance_and_restart_dirty_scope(self):
        self.prepare_self('本人曾完成合成课程。')
        backend = self.asynchronous()
        self.enable(backend)
        self.assertTrue(self.task_finished.wait(8), 'owner 首批真实 Worker 未完成')
        ready = self.read(backend)
        self.assertEqual((ready['status'], ready['covered_count']), ('ready', 1))
        self.task_finished.clear()
        self.task_idle.clear()
        status, result = self.backend.request('/api/memories/manual-owner', {
            'text': '本人又完成合成练习。', 'category': 'common_fact'})
        self.assertEqual(status, 200, result)
        self.assertTrue(self.task_finished.wait(8), '提交后应自动唤醒 owner，不依赖 GET 轮询')
        updated = self.read(backend)
        self.assertEqual((updated['status'], updated['covered_count']), ('ready', 2))
        self.assertNotEqual(updated['work_id'], ready['work_id'])
        backend.close()
        status, result = self.backend.request('/api/memories/manual-owner', {
            'text': '本人继续整理合成笔记。', 'category': 'common_fact'})
        self.assertEqual(status, 200, result)
        restarted = self.asynchronous()
        self.assertTrue(self.task_finished.wait(8), '重启须发现 owner maintenance_due')
        recovered = self.read(restarted)
        self.assertEqual((recovered['status'], recovered['covered_count']), ('ready', 3))

    def test_real_worker_restart_recovers_owner_queued_task_and_expired_lease(self):
        from notalone.persistence.locks import try_acquire_global_worker_lock, release_global_worker_lock

        self.prepare_self('本人曾完成合成课程。')
        with psycopg.connect(self.database_url, autocommit=True) as blocker:
            self.assertTrue(try_acquire_global_worker_lock(blocker))
            backend = self.asynchronous()
            queued = self.enable(backend)
            backend.close()
            with psycopg.connect(self.database_url) as db:
                # 外部故障夹具：已领取任务的进程失联，持久租约过期后从重启入口回收。
                db.execute("UPDATE public.background_task SET status='running' WHERE id=%s", (queued['work_id'],))
                db.execute("UPDATE public.background_task_step SET status='running', attempt_count=1, "
                           "worker_id='00000000-0000-4000-8000-000000000005', lease_generation=1, "
                           "lease_expires_at=now()-interval '1 second' WHERE task_id=%s",
                           (queued['work_id'],))
            release_global_worker_lock(blocker)
        restarted = self.asynchronous()
        self.assertTrue(self.task_finished.wait(8), '重启须主动发现 pending_scopes 中 owner 任务')
        recovered = self.read(restarted)
        self.assertEqual((recovered['work_id'], recovered['status'], recovered['covered_count']),
                         (queued['work_id'], 'ready', 1))
        self.assertEqual(len(self.proposal.inputs), 1)
        with psycopg.connect(self.database_url) as db:
            scope, contact, attempts = db.execute(
                'SELECT t.scope_kind,t.contact_id,s.attempt_count FROM public.background_task t '
                'JOIN public.background_task_step s ON s.task_id=t.id WHERE t.id=%s',
                (queued['work_id'],)).fetchone()
        self.assertEqual((scope, contact, attempts), ('owner', None, 2))
