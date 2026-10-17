"""受控联系人清理先擦除新工作副本；仅合成事务口，不连接PG。"""

from contextlib import ExitStack
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.persistence.contact_deletion import delete_contact
from notalone.scopes import ContactScope


class Rows:
    def __init__(self, rows=(), *, rowcount=0):
        self.rows, self.rowcount = rows, rowcount

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class ContactQueries:
    def __init__(self, scope, *, present=True):
        self.scope, self.present = scope, present
        self.identifiers, self.events = {}, []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, query, params):
        if params != (self.scope.owner_id, self.scope.contact_id):
            raise AssertionError('联系人清理只能查询原owner/contact。')
        if query.startswith('SELECT 1 FROM public.contact'):
            return Rows([{'present': 1}] if self.present else [])
        if query.startswith('SELECT source_document_id,message_id FROM public.media_attempt'):
            return Rows()
        if query.startswith('SELECT 1 FROM public.media_request_tombstone') or query.startswith('DELETE FROM public.media_request_tombstone'):
            return Rows()
        if query.startswith('SELECT id FROM public.') or query.startswith('SELECT version.id FROM public.reply_skill_version'):
            if 'text_content' in query or 'content ' in query:
                raise AssertionError('依赖清理只收集身份。')
            identifier = self.identifiers.setdefault(query, uuid4())
            self.events.append('identity')
            return Rows([{'id': identifier}])
        if query.startswith('SELECT id,status FROM public.expression_preference'):
            return Rows()
        if query.startswith('UPDATE public.expression_preference SET contact_id=NULL'):
            return Rows()
        if query.startswith('DELETE FROM public.contact'):
            self.events.append('contact_delete')
            return Rows(rowcount=int(self.present))
        raise AssertionError('受控联系人清理出现未声明查询。')


class UpgradeContactErasureTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())

    def _delete(self, connection, *, fail=False):
        def erase(kind, **request):
            self.assertEqual(request['owner_id'], self.scope.owner_id)
            self.assertEqual(request['removed_ids'], {self.scope.contact_id, *connection.identifiers.values()})
            connection.events.append(kind)
            if fail:
                raise RuntimeError('合成新工作擦除失败。')
        with ExitStack() as stack:
            module = 'notalone.persistence.contact_deletion.'
            stack.enter_context(patch(module+'psycopg.connect', return_value=connection))
            stack.enter_context(patch(module+'lock_contact_scope'))
            stack.enter_context(patch(module+'lock_owner_scope'))
            stack.enter_context(patch(module+'_erase_preferences'))
            stack.enter_context(patch(module+'_erase_contact_sources'))
            stack.enter_context(patch('notalone.persistence.memory_upgrade.erase_memory_upgrades',
                side_effect=lambda _, **request: erase('upgrade_erased', **request)))
            stack.enter_context(patch('notalone.persistence.skill_learning.erase_skill_learning',
                side_effect=lambda _, **request: erase('learning_erased', **request)))
            return delete_contact('synthetic-only', self.scope)

    def test_cross_contact_work_is_erased_before_contact_cascade_without_reading_bodies(self):
        connection = ContactQueries(self.scope)
        self.assertTrue(self._delete(connection))
        self.assertGreater(len(connection.identifiers), 5)
        self.assertEqual(connection.events[-3:], ['upgrade_erased', 'learning_erased', 'contact_delete'])

    def test_other_scope_never_collects_or_erases_private_work(self):
        connection = ContactQueries(self.scope, present=False)
        self.assertFalse(self._delete(connection))
        self.assertEqual(connection.events, [])

    def test_erasure_error_stops_contact_delete_in_the_same_transaction(self):
        connection = ContactQueries(self.scope)
        with self.assertRaises(RuntimeError):
            self._delete(connection, fail=True)
        self.assertNotIn('contact_delete', connection.events)
