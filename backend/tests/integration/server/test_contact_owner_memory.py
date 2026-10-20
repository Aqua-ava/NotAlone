"""当前联系人本人记忆视图：独立合成数据库与生产HTTP边界。"""
import json
from pathlib import Path
import unittest
from uuid import UUID, uuid4

import psycopg
from psycopg import sql

from notalone.application.memory_service import MemoryService, ManualMemoryEntry
from notalone.database_migrations import migrate
from notalone.memory.models import AdoptionMethod, ConfirmedMemoryStatus, MemoryCategory, MemoryTopic, OwnerMemory
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


class ContactOwnerMemoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database_name = f"notalone_contact_owner_{uuid4().hex[:12]}_test"
        cls.database_url = f"postgresql:///{cls.database_name}"
        with psycopg.connect("postgresql:///postgres", autocommit=True) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database_name)))
        cls.addClassCleanup(cls._drop_database)
        migrate(cls.database_url, Path(__file__).resolve().parents[3] / "database/migrations")

    @classmethod
    def _drop_database(cls):
        with psycopg.connect("postgresql:///postgres", autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))

    def setUp(self):
        self.owner_id, self.contact_id, self.other_id = uuid4(), uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES (%s,'合成用户')", (self.owner_id,))
            for contact in (self.contact_id, self.other_id):
                connection.execute("INSERT INTO public.contact(id,owner_id,display_name) VALUES (%s,%s,'合成联系人')",
                                   (contact, self.owner_id))
        self.addCleanup(self._delete_owner)
        self.store = PostgresOwnerMemoryStore(self.database_url)
        self.service = MemoryService(contact_memory=PostgresMemoryStore(self.database_url), owner_memory=self.store)
        self.client = InProcessClient(create_app(database_url=self.database_url, owner_id=self.owner_id,
                                               token="synthetic-test", memory_service=self.service))
        self.path = f"/api/contacts/{self.contact_id}/owner-memories"

    def _delete_owner(self):
        with psycopg.connect(self.database_url) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=%s", (self.owner_id,))

    def request(self, method, path, data=None):
        return self.client.request(method, path, headers={"Authorization": "Bearer synthetic-test"},
                                   body=json.dumps(data).encode() if data is not None else b"")

    def memory(self, contact_id, text="本人喜欢散步"):
        source = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                               "VALUES (%s,%s,%s,'manual','synthetic.jsonl',%s,1)",
                               (source, self.owner_id, contact_id, uuid4().hex * 2))
        return self.store.create(OwnerMemory(memory_id=uuid4(), owner_id=self.owner_id, text=text,
            category=MemoryCategory.PREFERENCE, topic=MemoryTopic.OTHER, source_ids=(source,), adoption_method=AdoptionMethod.MANUAL,
            status=ConfirmedMemoryStatus.ACTIVE))

    def test_list_only_current_contact_and_preserve_global_pool(self):
        current = self.memory(self.contact_id)
        other = self.memory(self.other_id, "本人喜欢阅读")
        global_memory = self.service.add_manual_owner_memory(owner_id=self.owner_id,
            entry=ManualMemoryEntry("本人喜欢音乐", MemoryCategory.PREFERENCE))
        result = self.request("GET", self.path)
        self.assertEqual(result.status_code, 200, result.json())
        self.assertEqual([m["memory_id"] for m in result.json()["memories"]], [str(current.memory_id)])
        self.assertEqual({m.memory_id for m in self.store.list_active(self.owner_id)},
                         {current.memory_id, other.memory_id, global_memory.memory_id})

    def test_manual_entry_and_mutations_remain_in_current_contact_view(self):
        response = self.request("POST", self.path, {"text": "本人周末喜欢散步", "category": "preference"})
        self.assertEqual(response.status_code, 200, response.json())
        memory_id = response.json()["memory"]["memory_id"]
        other_path = f"/api/contacts/{self.other_id}/owner-memories/{memory_id}"
        self.assertEqual(self.request("GET", other_path + "/versions").status_code, 404)
        self.assertEqual(self.request("POST", other_path + "/correct", {"text": "不应写入"}).status_code, 404)
        self.assertEqual(self.request("POST", other_path + "/delete").status_code, 404)
        corrected = self.request("POST", f"{self.path}/{memory_id}/correct", {"text": "本人周末喜欢慢跑"})
        self.assertEqual(corrected.status_code, 200, corrected.json())
        latest = corrected.json()["memory"]["memory_id"]
        versions = self.request("GET", f"{self.path}/{latest}/versions")
        self.assertEqual(versions.status_code, 200, versions.json())
        self.assertEqual([m["memory_id"] for m in versions.json()["versions"]], [latest, memory_id])
        listed = self.request("GET", self.path).json()["memories"]
        self.assertEqual({m["memory_id"]: m["status"] for m in listed},
                         {memory_id: "invalidated", latest: "active"})
        self.assertEqual([m.memory_id for m in self.store.list_active(self.owner_id)],
                         [UUID(latest)])
        self.assertEqual(self.request("GET", f"/api/contacts/{self.other_id}/owner-memories").json()["memories"], [])
        self.assertEqual(self.request("POST", f"{self.path}/{latest}/delete").status_code, 200)
        self.assertEqual(self.request("GET", self.path).json()["memories"], [])

    def test_invalidated_owner_memories_keep_contact_and_source_boundaries(self):
        from dataclasses import replace
        current = self.memory(self.contact_id)
        other = self.memory(self.other_id, "其他联系人的旧本人资料")
        retired = self.store.create(replace(current, memory_id=uuid4(),
            status=ConfirmedMemoryStatus.INVALIDATED, text="以前的本人偏好"))
        self.store.create(replace(other, memory_id=uuid4(), status=ConfirmedMemoryStatus.INVALIDATED))
        mixed = self.store.create(replace(retired, memory_id=uuid4(),
            source_ids=current.source_ids + other.source_ids))
        listed = self.request("GET", self.path).json()["memories"]
        self.assertEqual({m["memory_id"] for m in listed},
                         {str(current.memory_id), str(retired.memory_id)})
        self.assertNotIn(str(mixed.memory_id), {m["memory_id"] for m in listed})
        self.assertEqual({m.memory_id for m in self.store.list_active(self.owner_id)},
                         {current.memory_id, other.memory_id})
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='deleted',file_name=NULL,content_sha256=NULL,"
                               "record_count=0,deleted_at=now() WHERE id=%s", (current.source_ids[0],))
        self.assertEqual(self.request("GET", self.path).json()["memories"], [])
        global_list = self.request("GET", "/api/memories/owner")
        self.assertEqual(global_list.status_code, 200, global_list.json())
        self.assertNotIn(str(mixed.memory_id),
                         {m["memory_id"] for m in global_list.json()["memories"]})

    def test_contact_memory_list_keeps_retired_entries_until_deleted(self):
        path = f"/api/contacts/{self.contact_id}/memories"
        created = self.request("POST", "/api/memories/manual-contact",
                               {"contact_id": str(self.contact_id), "text": "对方喜欢散步", "category": "preference"})
        self.assertEqual(created.status_code, 200, created.json())
        old_id = created.json()["memory"]["memory_id"]
        corrected = self.request("POST", f"{path}/{old_id}/correct",
                                 {"text": "对方喜欢慢跑"})
        self.assertEqual(corrected.status_code, 200, corrected.json())
        new_id = corrected.json()["memory"]["memory_id"]
        listed = self.request("GET", path)
        self.assertEqual(listed.status_code, 200, listed.json())
        self.assertEqual({m["memory_id"]: m["status"] for m in listed.json()["memories"]},
                         {old_id: "invalidated", new_id: "active"})
        self.assertEqual(self.request("GET", f"/api/contacts/{self.other_id}/memories").json()["memories"], [])
        self.assertEqual(self.request("POST", f"{path}/{new_id}/delete").status_code, 200)
        self.assertEqual(self.request("GET", path).json()["memories"], [])

    def test_retired_contact_memory_with_removed_source_is_hidden(self):
        from notalone.scopes import ContactScope
        old = self.service.add_manual_contact_memory(
            owner_id=self.owner_id, contact_id=self.contact_id,
            entry=ManualMemoryEntry("过去喜欢散步", MemoryCategory.PREFERENCE),
        )
        extra = self.memory(self.contact_id, "用于合成第二来源")
        store = PostgresMemoryStore(self.database_url)
        store.invalidate(scope=ContactScope(self.owner_id, self.contact_id), memory_id=old.memory_id)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.confirmed_memory SET source_ids=%s WHERE id=%s",
                               (list(old.source_ids + extra.source_ids), old.memory_id))
            connection.execute("UPDATE public.source_document SET status='deleted',file_name=NULL,content_sha256=NULL,"
                               "record_count=0,deleted_at=now() WHERE id=%s", (old.source_ids[0],))
        response = self.request("GET", f"/api/contacts/{self.contact_id}/memories")
        self.assertEqual(response.status_code, 200, response.json())
        self.assertEqual(response.json()["memories"], [])

    def test_mixed_or_removed_sources_do_not_enter_contact_view(self):
        from dataclasses import replace
        first = self.memory(self.contact_id)
        other = self.memory(self.other_id, "本人喜欢阅读")
        mixed = self.store.create(replace(first, memory_id=uuid4(),
            source_ids=first.source_ids + other.source_ids, text="跨联系人混合资料"))
        self.assertEqual([m["memory_id"] for m in self.request("GET", self.path).json()["memories"]],
                         [str(first.memory_id)])
        self.assertEqual(self.request("GET", f"{self.path}/{mixed.memory_id}/versions").status_code, 404)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='deleted',file_name=NULL,content_sha256=NULL,"
                               "record_count=0,deleted_at=now() WHERE id=%s", (first.source_ids[0],))
        self.assertEqual(self.request("GET", self.path).json()["memories"], [])
        self.assertEqual(self.request("POST", f"{self.path}/{first.memory_id}/delete").status_code, 404)

    def test_versions_stop_at_another_contact_without_changing_global_history(self):
        from dataclasses import replace
        earlier = self.memory(self.other_id, "旧关系里的本人资料")
        current = self.memory(self.contact_id)
        latest = self.store.create(replace(current, memory_id=uuid4(), supersedes_memory_id=earlier.memory_id))
        response = self.request("GET", f"{self.path}/{latest.memory_id}/versions")
        self.assertEqual(response.status_code, 200, response.json())
        versions = response.json()["versions"]
        self.assertEqual([m["memory_id"] for m in versions], [str(latest.memory_id)])
        self.assertIsNone(versions[0]["supersedes_memory_id"])
        self.assertFalse(versions[0]["can_revert_auto_update"])
        listed = next(m for m in self.request("GET", self.path).json()["memories"]
                      if m["memory_id"] == str(latest.memory_id))
        self.assertIsNone(listed["supersedes_memory_id"])
        self.assertEqual(len(self.store.list_versions(owner_id=self.owner_id, memory_id=latest.memory_id)), 2)
        result = self.request("POST", f"{self.path}/{latest.memory_id}/revert-auto-update", {"expected_revision": 1})
        self.assertEqual(result.status_code, 409)
