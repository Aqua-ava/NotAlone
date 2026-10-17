"""公开资料删除后，清空的 stale 目录与概览均从权威资料重建。"""

from datetime import datetime, timedelta, timezone
import unittest
from uuid import UUID

from notalone.memory.models import MemoryTopic
from notalone.persistence.contact_memory_index import PostgresContactMemoryIndexRepository
from notalone.scopes import ContactScope
from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture


class RelationshipOverviewIndexRebuildHttpTest(MemoryOverviewHttpFixture, unittest.TestCase):
    def test_delete_rebuilds_a_cleared_stale_index_and_retains_only_the_independent_memory(self):
        when = datetime(2026, 8, 1, tzinfo=timezone.utc)
        contact, _, message = self.import_contact("合成偏好：喜欢交流读书感想。", when=when)
        first = self.confirm(contact, "喜欢交流读书感想。", message,
                             category="preference", topic=MemoryTopic.STUDY)
        scope = ContactScope(self.owner_id, UUID(contact))
        index = PostgresContactMemoryIndexRepository(self.database_url)
        index.rebuild(scope)
        _, _, next_message = self.import_contact("合成独立偏好：喜欢一起游览合成景点。",
            contact_id=contact, when=when + timedelta(minutes=1))
        second = self.confirm(contact, "喜欢一起游览合成景点。", next_message,
                              category="preference", topic=MemoryTopic.TRAVEL)
        added = index.incremental_update(scope, changed_memory_ids=(UUID(second["memory_id"]),))
        self.assertEqual(added.mode, "incremental")
        self.assertEqual(set(added.memory_ids), {UUID(first["memory_id"]), UUID(second["memory_id"])})
        self.assertEqual(len(self.overview(contact)["entries"]), 2)
        status, removed = self.backend.request(
            f"/api/contacts/{contact}/memories/{first['memory_id']}/delete", {})
        self.assertEqual(status, 200, removed)
        self.assertFalse(index.get(scope).is_current)
        rebuilt = index.incremental_update(scope, changed_memory_ids=(UUID(first["memory_id"]),))
        self.assertEqual(rebuilt.mode, "rebuild")
        self.assertEqual(rebuilt.memory_ids, (UUID(second["memory_id"]),))
        self.assertTrue(index.get(scope).is_current)
        self.assertEqual([entry["memory"]["memory_id"] for entry in self.overview(contact)["entries"]],
                         [second["memory_id"]])


if __name__ == "__main__":
    unittest.main()
