"""保存决策的合成事务端口；真实SQL、隔离及恢复另由公开PG用例覆盖。"""

from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.persistence.skill_learning import PostgresSkillLearningStore
from notalone.scopes import ContactScope
from notalone.skills.learning import LearningBatch, SkillLearningInvalid, content_digest
from tests.unit.skills.test_learning import proposal
from tests.unit.skills.test_learning_materials import MaterialRows


class DraftWriteQueries:
    def __init__(self, scope, *, name_exists):
        self.scope, self.name_exists = scope, name_exists
        self.writes = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, query, params):
        if query.startswith('SELECT display_name FROM public.contact'):
            return MaterialRows([])
        if query.startswith('SELECT 1 FROM public.reply_skill'):
            if (params != (self.scope.owner_id, self.scope.contact_id, 'confirm-meaning')
                    or 'contact_id IS NULL OR contact_id=%s' not in query
                    or "status<>'deleted'" not in query):
                raise AssertionError('重名门须核对本owner及适用联系人范围的未删目录。')
            return MaterialRows([(1,)] if self.name_exists else [])
        if query.startswith(('INSERT INTO public.skill_draft', 'INSERT INTO public.skill_method_identity',
                             'INSERT INTO public.skill_learning_batch', 'INSERT INTO public.skill_learning_receipt',
                             'UPDATE public.background_task')):
            self.writes.append(query)
            return MaterialRows([(uuid4(),)] if 'RETURNING id' in query else [])
        raise AssertionError('合成草稿事务出现未声明查询。')


class LearningStoreTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        material = {'material_id': str(uuid4()), 'priority': 'correction',
                    'content': {'correction': '先问清楚'}}
        material['digest'] = content_digest(material)
        self.batch = LearningBatch((material,), (), (), 1)
        self.claim = SimpleNamespace(task_id=uuid4())

    def _save(self, connection):
        with ExitStack() as stack:
            module = 'notalone.persistence.skill_learning.'
            stack.enter_context(patch(module+'psycopg.connect', return_value=connection))
            stack.enter_context(patch(module+'lock_contact_scope'))
            stack.enter_context(patch(module+'lock_owner_scope'))
            stack.enter_context(patch(module+'PostgresBackgroundTaskRepository._assert_valid_claim'))
            stack.enter_context(patch(module+'learning_allowed', return_value=True))
            stack.enter_context(patch(module+'select_learning_batch', side_effect=[
                self.batch, LearningBatch((), (), (), 1)]))
            return PostgresSkillLearningStore('synthetic-only').save(
                self.scope, self.claim, self.batch, proposal())

    def test_same_name_outside_bounded_input_is_rejected_before_any_workflow_write(self):
        connection = DraftWriteQueries(self.scope, name_exists=True)
        with self.assertRaises(SkillLearningInvalid):
            self._save(connection)
        self.assertEqual(connection.writes, [])

    def test_new_name_can_still_create_one_pending_draft_and_consume_only_its_material(self):
        connection = DraftWriteQueries(self.scope, name_exists=False)
        self.assertEqual(self._save(connection), 1)
        for table in ('skill_draft', 'skill_learning_batch', 'skill_learning_receipt'):
            self.assertEqual(sum(query.startswith('INSERT INTO public.'+table+'(')
                                 for query in connection.writes), 1)


class RecoveryQueries:
    def __init__(self, scope, task_id, *, matching=True, draft=True, receipt_count=1,
                 current_run=True, empty_proposal=False):
        self.scope, self.task_id = scope, task_id
        self.batch_id, self.draft_id = uuid4(), uuid4() if draft else None
        self.matching, self.receipt_count = matching, receipt_count
        self.current_run, self.empty_proposal = current_run, empty_proposal
        self.attempted_key = None
        self.writes = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, query, params):
        if query.startswith('SELECT id,status FROM public.background_task'):
            return MaterialRows([(self.task_id, 'failed')])
        if query.startswith('SELECT step_name FROM public.background_task_step'):
            return MaterialRows([('propose_skill',)])
        if query.startswith('SELECT last_attempt_key FROM public.skill_learning_scope'):
            return MaterialRows([(self.attempted_key,)])
        if query.startswith('UPDATE public.skill_learning_scope AS setting SET last_attempt_key='):
            if params[1:] != (self.scope.owner_id, self.scope.contact_id, self.task_id):
                raise AssertionError('入队尝试必须匹配原范围和任务。')
            self.attempted_key = params[0]
            return MaterialRows([])
        if query.startswith('SELECT batch.id,batch.dependency_ids'):
            if (params != (self.scope.owner_id, self.scope.contact_id, self.task_id)
                    or 'batch.batch_key=setting.last_attempt_key' not in query
                    or "batch.outcome<>'invalidated'" not in query):
                raise AssertionError('恢复必须限定同范围任务的最后一次已提交批次。')
            current = self.current_run or 'batch.created_at>=proposed.started_at' not in query
            return MaterialRows([(self.batch_id, [uuid4()], self.draft_id,
                                  'pending' if self.draft_id else None,
                                  {'version': 1} if self.draft_id else None)] if self.matching and current else [])
        if query.startswith('SELECT 1 FROM public.background_task_step AS proposed'):
            if params != (self.task_id,) or 'proposed.processed_count=0' not in query:
                raise AssertionError('空材料恢复必须依据当前提案已成功且实际计数为零。')
            return MaterialRows([(1,)] if self.empty_proposal else [])
        if query.startswith('SELECT count(*),count(digest) FROM public.skill_learning_receipt'):
            if params != (self.scope.owner_id, self.scope.contact_id, self.batch_id):
                raise AssertionError('恢复只能使用该范围该批次的消费回执。')
            return MaterialRows([(1, self.receipt_count)])
        if query.startswith('UPDATE public.background_task'):
            self.writes.append((query, params))
            return MaterialRows([])
        raise AssertionError('恢复事务出现未声明查询。')


class LearningRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.scope, self.task_id = ContactScope(uuid4(), uuid4()), uuid4()

    def _resume(self, connection, *, dependencies=True, generation=True, batch=None, force_retry=True):
        with ExitStack() as stack:
            module = 'notalone.persistence.skill_learning.'
            stack.enter_context(patch(module+'psycopg.connect', return_value=connection))
            stack.enter_context(patch(module+'lock_contact_scope'))
            stack.enter_context(patch(module+'lock_owner_scope'))
            stack.enter_context(patch(module+'learning_allowed', return_value=True))
            stack.enter_context(patch(module+'select_learning_batch', return_value=batch or LearningBatch((), (), (), 1)))
            stack.enter_context(patch(module+'dependencies_current', return_value=dependencies))
            stack.enter_context(patch('notalone.persistence.skill_learning_generation.generation_current',
                                      return_value=generation))
            return PostgresSkillLearningStore('synthetic-only').enqueue(self.scope, force_retry=force_retry)

    def test_committed_proposal_restores_truthful_progress_and_only_requeues_verification(self):
        connection = RecoveryQueries(self.scope, self.task_id)
        self.assertEqual(self._resume(connection), self.task_id)
        self.assertEqual(len(connection.writes), 3)
        receipt, verify, task = connection.writes
        self.assertIn("status='succeeded'", receipt[0])
        self.assertIn('processed_count=%s,total_count=%s', receipt[0])
        self.assertEqual(receipt[1], (1, 1, self.task_id))
        self.assertIn('lease_generation=lease_generation+1', receipt[0])
        self.assertIn("step_name='verify_skill_drafts'", verify[0])
        self.assertIn("current_step='verify_skill_drafts'", task[0])
        self.assertFalse(any('INSERT' in query for query, _ in connection.writes))

    def test_old_batch_deleted_receipt_or_changed_source_never_reconciles_progress(self):
        for changes in ({'matching': False}, {'receipt_count': 0}, {'dependencies': False}, {'generation': False}):
            with self.subTest(changes=changes):
                arguments = dict(changes)
                dependencies, generation = arguments.pop('dependencies', True), arguments.pop('generation', True)
                connection = RecoveryQueries(self.scope, self.task_id, **arguments)
                self.assertIsNone(self._resume(connection, dependencies=dependencies, generation=generation))
                self.assertEqual(connection.writes, [])

    def test_bodyless_no_change_receipt_can_finish_without_inventing_a_draft(self):
        connection = RecoveryQueries(self.scope, self.task_id, draft=False)
        self.assertEqual(self._resume(connection), self.task_id)
        self.assertEqual(len(connection.writes), 3)

    def test_empty_successful_proposal_can_resume_its_unfinished_verification(self):
        connection = RecoveryQueries(self.scope, self.task_id, matching=False, empty_proposal=True)
        self.assertEqual(self._resume(connection), self.task_id)
        self.assertEqual(len(connection.writes), 2)
        self.assertFalse(any("status='succeeded'" in query for query, _ in connection.writes))

    def test_previous_run_batch_never_supplies_progress_for_failed_new_capture(self):
        connection = RecoveryQueries(self.scope, self.task_id, current_run=False)
        self.assertIsNone(self._resume(connection))
        self.assertEqual(connection.writes, [])

    def test_new_attempt_is_marked_before_capture_so_failed_authority_reads_do_not_reset_it(self):
        material = {'material_id': str(uuid4()), 'priority': 'correction', 'content': {'correction': '合成新纠正'}}
        material['digest'] = content_digest(material)
        batch = LearningBatch((material,), (), (), 1)
        connection = RecoveryQueries(self.scope, self.task_id, matching=False)
        self.assertEqual(self._resume(connection, batch=batch, force_retry=False), self.task_id)
        self.assertEqual(connection.attempted_key, batch.key)
        previous = len(connection.writes)
        self.assertIsNone(self._resume(connection, batch=batch, force_retry=False))
        self.assertEqual(len(connection.writes), previous)
