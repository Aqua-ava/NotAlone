"""人工更正经公开HTTP成为可追溯回复依据，不回填原世代。"""

import unittest
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from notalone.database_migrations import migrate
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class CorrectedMemoryNavigationHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        instance = os.environ["NOTALONE_TEST_DATABASE_URL"]
        cls.database_name = f"notalone_nav_{uuid4().hex}_test"
        cls.database_url = make_conninfo(instance, dbname=cls.database_name)
        cls.admin = psycopg.connect(instance, dbname="postgres", autocommit=True)
        try:
            cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(cls.database_name)))
        except BaseException:
            cls.admin.close()
            raise
        cls.addClassCleanup(cls._drop_database)
        binding = patch.dict(os.environ, NOTALONE_DATABASE_URL=cls.database_url,
                             NOTALONE_TEST_DATABASE_URL=cls.database_url,
                             NOTALONE_EXPECTED_TEST_DATABASE=cls.database_name)
        binding.start()
        cls.addClassCleanup(binding.stop)
        migrations = Path(__file__).resolve().parents[3] / "database/migrations"
        expected = tuple(sorted(path.name for path in migrations.glob("*.sql")))
        if migrate(cls.database_url, migrations) != expected or migrate(cls.database_url, migrations):
            raise RuntimeError("更正导航回归须完整执行当前正式迁移，重复执行为零。")
        super().setUpClass()

    @classmethod
    def _drop_database(cls):
        try:
            cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.database_name)))
            if cls.admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
                                 (cls.database_name,)).fetchone()[0]:
                raise AssertionError("更正导航自有测试库未清理。")
        finally:
            cls.admin.close()

    def test_corrected_source_preference_is_navigable_and_cited_after_restart(self):
        contact, source, message = self.import_contact("对方喜欢红茶。")
        original = self.confirm(contact, "对方喜欢红茶。", message, category="preference")
        status, corrected = self.backend.request(
            f"/api/contacts/{contact}/memories/{original['memory_id']}/correct",
            {"text": "对方偏好无咖啡因的花草茶。"},
        )
        self.assertEqual(status, 200, corrected)
        current = corrected["memory"]
        restarted = self._backend(self.owner_id)
        overview = self.overview(contact, backend=restarted)
        old, new = overview["entries"]
        self.assertEqual(old["memory"]["status"], "invalidated")
        self.assertEqual(new["memory"]["memory_id"], current["memory_id"])
        self.assertEqual(new["provenance"]["kind"], "source_supported")
        self.assertEqual(new["provenance"]["references"][0]["source_id"], source)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        self.reply_model.plans.append({
            "text": "想喝无咖啡因的花草茶吗？", "basis": "按当前草稿询问已更正的偏好。",
            "cite_kinds": ["confirmed_memory"],
        })
        status, turn = self.backend.request(path + "/replies", self.rewrite_body(
            contact, "想喝无咖啡因的花草茶吗？",
        ))
        self.assertEqual(status, 200, turn)
        evidence = self._get(self.backend, self.evidence_path(contact, turn))
        actual = next(item for item in evidence["evidence"] if item["evidence_id"] == current["memory_id"])
        self.assertTrue(actual["cited"])
        self.assertEqual(actual["text"], current["text"])
        self.assertEqual(actual["navigation"]["provenance_kind"], "source_supported")
        self.assertEqual(actual["navigation"]["memory_revision"], current["revision"])
        self.assertEqual(self._get(self._backend(self.owner_id), self.evidence_path(contact, turn)), evidence)

    def test_correction_proof_does_not_upgrade_the_original_unknown_generation(self):
        contact, _, message = self.import_contact("对方喜欢红茶。")
        original = self.confirm(contact, "对方喜欢红茶。", message, category="preference")
        status, corrected = self.backend.request(
            f"/api/contacts/{contact}/memories/{original['memory_id']}/correct",
            {"text": "对方喜欢花草茶。"},
        )
        self.assertEqual(status, 200, corrected)
        # 模拟只有原提取窗口缺失的旧资料；人工更正有独立的已冻结证明。
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.memory_candidate SET correction_evidence=NULL "
                               "WHERE owner_id=%s AND id=(SELECT source_candidate_id FROM public.confirmed_memory "
                               "WHERE owner_id=%s AND id=%s)",
                               (self.owner_id, self.owner_id, original["memory_id"]))
        old, new = self.overview(contact, backend=self._backend(self.owner_id))["entries"]
        self.assertEqual(old["provenance"]["kind"], "unknown")
        self.assertEqual(new["provenance"]["kind"], "source_supported")
        self.assertEqual(new["memory"]["memory_id"], corrected["memory"]["memory_id"])
        with psycopg.connect(self.database_url) as connection:
            self.assertIsNone(connection.execute(
                "SELECT candidate.correction_evidence FROM public.memory_candidate AS candidate "
                "JOIN public.confirmed_memory AS memory ON memory.owner_id=candidate.owner_id "
                "AND memory.source_candidate_id=candidate.id WHERE memory.owner_id=%s AND memory.id=%s",
                (self.owner_id, original["memory_id"]),
            ).fetchone()[0])

    def test_corrected_leaf_does_not_recapture_changed_body_ref_or_source_generation(self):
        for mutation in ("body", "ref", "source"):
            with self.subTest(mutation=mutation):
                contact, source, message = self.import_contact("对方喜欢红茶。")
                original = self.confirm(contact, "对方喜欢红茶。", message, category="preference")
                status, corrected = self.backend.request(
                    f"/api/contacts/{contact}/memories/{original['memory_id']}/correct",
                    {"text": "对方喜欢花草茶。"},
                )
                self.assertEqual(status, 200, corrected)
                self.assertEqual(self.overview(contact)["entries"][-1]["provenance"]["kind"], "source_supported")
                with psycopg.connect(self.database_url) as connection:
                    if mutation == "body":
                        connection.execute("UPDATE public.message SET text_content='来源已变化。' WHERE owner_id=%s AND id=%s",
                                           (self.owner_id, message))
                    elif mutation == "ref":
                        connection.execute("UPDATE public.message_source_ref SET raw_payload=raw_payload || %s "
                                           "WHERE owner_id=%s AND message_id=%s",
                                           (Jsonb({"synthetic_generation": 2}), self.owner_id, message))
                    else:
                        connection.execute("UPDATE public.source_document SET content_sha256=%s WHERE owner_id=%s AND id=%s",
                                           ("f" * 64, self.owner_id, source))
                self.assertEqual(self.overview(contact, backend=self._backend(self.owner_id))["entries"], [])

    def test_deleting_correction_or_original_source_rejects_the_inflight_reply(self):
        for deletion in ("memory", "source"):
            with self.subTest(deletion=deletion):
                contact, source, message = self.import_contact("对方喜欢红茶。")
                original = self.confirm(contact, "对方喜欢红茶。", message, category="preference")
                status, corrected = self.backend.request(
                    f"/api/contacts/{contact}/memories/{original['memory_id']}/correct",
                    {"text": "对方偏好无咖啡因的花草茶。"},
                )
                self.assertEqual(status, 200, corrected)
                self.activate_replies(contact)
                path = self.reply_path(contact)
                self.reply_model.plans.append({"text": "想喝花草茶吗？", "basis": "询问更正后的偏好。",
                                              "cite_kinds": ["confirmed_memory"]})
                self.reply_model.entered.clear()
                gate = self.reply_model.pause_next_response()
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(self.backend.request, path + "/replies", self.rewrite_body(
                        contact, "想喝无咖啡因的花草茶吗？"))
                    try:
                        self.assertTrue(self.reply_model.entered.wait(5))
                        if deletion == "memory":
                            self.assertEqual(self.backend.request(
                                f"/api/contacts/{contact}/memories/{corrected['memory']['memory_id']}/delete", {},
                            )[0], 200)
                        else:
                            self.delete_source(contact, source)
                        gate.set()
                        status, result = pending.result(timeout=10)
                    finally:
                        gate.set()
                self.assertNotEqual(status, 200, result)
                failed = self._get(self._backend(self.owner_id), path)["turns"][0]
                self.assertEqual(failed["state"], "redacted" if deletion == "source" else "failed")
                self.assertIsNone(failed["reply"])
