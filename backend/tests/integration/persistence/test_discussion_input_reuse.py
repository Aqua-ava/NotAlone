"""讨论嵌套遍历只复用同范围成功读取，下一公开遍历仍核验当前数据库。"""

from dataclasses import FrozenInstanceError
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence import assistant_discussion_context as discussion
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.reply_sources import _reply_source_validation_scope
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope
from tests.integration.persistence import test_assistant_discussion_context as support
from tests.integration.persistence import test_reply_discussion_dependencies as history_support


class DiscussionInputReuseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        support.AssistantDiscussionContextTest.setUpClass()

    def setUp(self):
        self.history = history_support.ReplyDiscussionDependenciesTest()
        self.addCleanup(self.history.doCleanups)
        self.history.setUp()
        self.fixture = self.history.fixture

    def _nested(self, *, source=None):
        self.history._seed_history(source=source)
        for _ in range(2):
            self.history._save(self.history._prepare())
        return self.history._prepare()[3].assistant_discussion

    def test_nested_public_validation_reads_each_input_once_per_policy(self):
        context = self._nested()
        with psycopg.connect(support.DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.fixture.owner_id)
            with patch.object(discussion, '_generation_input_available', wraps=discussion._generation_input_available) as available:
                with patch.object(discussion, '_read_generation_input_available', wraps=discussion._read_generation_input_available) as reads:
                    with patch.object(discussion, '_read_generation_dependencies', wraps=discussion._read_generation_dependencies) as dependencies:
                        first = discussion.require_assistant_discussion_current(connection, self.fixture.scope, context.snapshot)
                        keys = [(discussion._fingerprint(call.args[2]), call.kwargs.get('policy_current', False))
                                for call in reads.call_args_list]
                        self.assertEqual(len(keys), len(set(keys)))
                        self.assertGreater(available.call_count, reads.call_count)
                        dependency_keys = [discussion._fingerprint(call.args[2]) for call in dependencies.call_args_list]
                        self.assertEqual(len(dependency_keys), len(set(dependency_keys)))
                        previous = reads.call_count
                        self.assertEqual(discussion.require_assistant_discussion_current(connection, self.fixture.scope, context.snapshot), first)
                        self.assertGreater(reads.call_count, previous, '新公开遍历不能沿用旧有效性结论')
            with self.assertRaises(FrozenInstanceError):
                first.source_ids = ()

    def test_next_public_read_rejects_changed_body_and_source_deletion(self):
        for mutation in ('body', 'source'):
            with self.subTest(mutation=mutation):
                source = self.fixture._source()
                discussion_id = self.fixture._discussion(dependencies=(source[0],))
                context = self._nested(source=source)
                with psycopg.connect(support.DATABASE_URL) as connection:
                    lock_owner_scope(connection, owner_id=self.fixture.owner_id)
                    discussion.require_assistant_discussion_current(connection, self.fixture.scope, context.snapshot)
                    if mutation == 'body':
                        connection.execute('UPDATE assistant_session_input SET content=%s WHERE id=%s',
                            (Jsonb({'type': 'purpose_exploration', 'requirements': '已修改的合成正文。'}), discussion_id))
                    else:
                        connection.execute("UPDATE source_document SET status='delete_requested' WHERE id=%s", (source[0],))
                    with self.assertRaises(ReplyStoreInvariantError):
                        discussion.require_assistant_discussion_current(connection, self.fixture.scope, context.snapshot)
                    connection.rollback()

    def test_policy_current_and_next_read_do_not_reuse_historical_permission(self):
        source = self.fixture._source()
        _, _, turn_id = self.fixture._complete(source=source)
        memory_id = uuid4()
        with psycopg.connect(support.DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.fixture.owner_id)
            connection.execute("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) "
                "VALUES(%s,%s,%s,'合成过期偏好。','preference',%s,'auto')",
                (memory_id, self.fixture.owner_id, self.fixture.contact_id, [source[0]]))
            connection.execute('UPDATE assistant_session_turn SET dependency_ids=array_append(dependency_ids,%s) WHERE id=%s',
                               (memory_id, turn_id))
            row = next(item for item in discussion._input_rows(connection, self.fixture.scope, self.fixture.session_id)
                       if item['turn_id'] == turn_id)
            with _reply_source_validation_scope(connection, self.fixture.scope):
                self.assertTrue(discussion._generation_input_available(connection, self.fixture.scope, row, policy_current=True))
            connection.execute('UPDATE confirmed_memory SET invalid_at=now() WHERE id=%s', (memory_id,))
            with _reply_source_validation_scope(connection, self.fixture.scope):
                self.assertTrue(discussion._generation_input_available(connection, self.fixture.scope, row))
                self.assertFalse(discussion._generation_input_available(connection, self.fixture.scope, row, policy_current=True))

    def test_connection_scope_and_active_cycles_do_not_share_success(self):
        _, request_id, _ = self.fixture._complete()
        with psycopg.connect(support.DATABASE_URL, row_factory=dict_row) as first:
            lock_owner_scope(first, owner_id=self.fixture.owner_id)
            row = next(item for item in discussion._input_rows(first, self.fixture.scope, self.fixture.session_id)
                       if item['reply_request_id'] == request_id)
            with psycopg.connect(support.DATABASE_URL, row_factory=dict_row) as second:
                second.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
                with _reply_source_validation_scope(first, self.fixture.scope) as validation:
                    with patch.object(discussion, '_read_generation_input_available', wraps=discussion._read_generation_input_available) as reads:
                        self.assertTrue(discussion._generation_input_available(first, self.fixture.scope, row))
                        self.assertTrue(discussion._generation_input_available(first, self.fixture.scope, row))
                        self.assertEqual(reads.call_count, 1)
                        self.assertTrue(discussion._generation_input_available(second, self.fixture.scope, row))
                        self.assertEqual(reads.call_count, 2)
                        other = ContactScope(self.fixture.owner_id, self.fixture.other_contact_id)
                        discussion._generation_input_available(first, other, row)
                        self.assertEqual(reads.call_count, 3)
                        foreign = ContactScope(self.fixture.other_owner_id, self.fixture.contact_id)
                        self.assertFalse(discussion._generation_input_available(first, foreign, row))
                        self.assertEqual(reads.call_count, 4)
                        changed = {**row, 'input_payload': None}
                        self.assertFalse(discussion._generation_input_available(first, self.fixture.scope, changed))
                        validation.active.add(request_id)
                        self.assertFalse(discussion._generation_input_available(first, self.fixture.scope, row),
                                         '当前递归请求不能命中之前成功的输入缓存')
                        validation.active.remove(request_id)
