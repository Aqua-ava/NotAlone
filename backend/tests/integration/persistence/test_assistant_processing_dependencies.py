"""完整来源处理依赖仅在同一授权范围、原来源仍有效时可用于助手回复。"""

import unittest
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.assistant_session_store import _dependencies_available
from notalone.scopes import ContactScope
from tests.integration.persistence import test_all_source_deletion as source_fixture


class AssistantProcessingDependenciesTest(unittest.TestCase):
    def setUp(self):
        self.fixture = source_fixture.AllSourceDeletionTest()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
        f = self.fixture
        self.batch = uuid4()
        with psycopg.connect(f.url) as connection:
            connection.execute(
                "INSERT INTO public.source_processing_batch(batch_id,owner_id,contact_id,source_kind,source_id) "
                "VALUES(%s,%s,%s,'source_document',%s)",
                (self.batch, f.owner, f.contact, f.target_source),
            )

    def _available(self, scope=None):
        f = self.fixture
        with psycopg.connect(f.url, row_factory=dict_row) as connection:
            return _dependencies_available(connection, scope or ContactScope(f.owner, f.contact),
                                           {self.batch}, historical=True)

    def test_active_batch_requires_matching_owner_contact_and_live_source(self):
        f = self.fixture
        self.assertTrue(self._available())
        self.assertFalse(self._available(ContactScope(f.owner, f.other)))
        self.assertFalse(self._available(ContactScope(uuid4(), f.contact)))
        with psycopg.connect(f.url) as connection:
            connection.execute("UPDATE public.source_document SET status='deleting' WHERE id=%s", (f.target_source,))
        self.assertFalse(self._available())

    def test_deleted_batch_is_unavailable_even_when_source_remains_active(self):
        f = self.fixture
        with psycopg.connect(f.url) as connection:
            connection.execute("UPDATE public.source_processing_batch SET status='deleted' WHERE batch_id=%s", (self.batch,))
        self.assertFalse(self._available())

    def test_registered_owner_navigation_allows_other_contact_but_not_other_owner(self):
        f = self.fixture
        scope = ContactScope(f.owner, f.other)
        self.assertFalse(self._available(scope))
        request, _ = f._request()
        # 模拟正式 writer 已冻结的本人导航；完整 HTTP 组合另覆盖真实生成。
        with psycopg.connect(f.url) as connection:
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s",
                               (Jsonb({"navigation_dependency_ids": [str(self.batch)]}), request))
        self.assertTrue(self._available(scope))
        self.assertFalse(self._available(ContactScope(uuid4(), f.other)))
        f._delete(f.target_source)
        self.assertFalse(self._available(scope))
