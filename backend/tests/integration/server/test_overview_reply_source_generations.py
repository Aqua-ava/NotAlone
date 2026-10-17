"""原来源的正文、ref 与世代变化不能被当前引用补证或最后 writer 绕过。"""

from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from notalone.memory.models import FactSubject
from tests.integration.server import test_historical_reply_basis as commit_support
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class OverviewReplySourceGenerationHttpTest(OverviewReplyHttpFixture, unittest.TestCase):
    def _change_source(self, contact, source, message, mutation):
        with psycopg.connect(self.database_url) as connection:
            if mutation == "ref":
                connection.execute("UPDATE public.message_source_ref SET raw_payload=raw_payload || %s WHERE owner_id=%s AND contact_id=%s AND message_id=%s",
                                   (Jsonb({"synthetic_generation": 2}), self.owner_id, contact, message))
            elif mutation == "body":
                connection.execute("UPDATE public.message SET text_content='合成正文已经变化。' WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                   (self.owner_id, contact, message))
            else:
                connection.execute("UPDATE public.source_document SET content_sha256=%s WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                   ("f" * 64, self.owner_id, contact, source))

    def test_changed_original_generation_is_not_injected_before_model_or_committed_after_last_validation(self):
        for level in ("contact", "owner"):
            for phase in ("before_model", "before_writer"):
                for mutation in ("ref", "body", "source"):
                    with self.subTest(level=level, phase=phase, mutation=mutation):
                        contact, source, contact_message = self.import_contact("对方最近合成近况需要核实。", owner_text="本人最近合成近况需要核实。")
                        message = contact_message
                        if level == "owner":
                            own = next(item for item in self._get(self.backend, f"/api/contacts/{contact}/messages")["messages"] if item["speaker"] == "user")
                            message = UUID(own["message_id"])
                        memory = self.confirm(contact, "最近合成近况需要核实。", message,
                                              subject=FactSubject.SELF if level == "owner" else FactSubject.CONTACT)
                        store = commit_support.CommitBoundaryReplyStore(self.database_url)
                        with patch("notalone.server.reply_wiring.PostgresReplyStore", return_value=store):
                            self.activate_replies(contact)
                        path = self.reply_path(contact)
                        self.reply_model.plans.append({"text": "想聊聊合成近况。", "basis": "保留用户本次草稿。"})
                        body = self.rewrite_body(contact, "合成近况，想聊合成近况。")
                        if phase == "before_model":
                            self._change_source(contact, source, message, mutation)
                            status, turn = self.backend.request(path + "/replies", body)
                            self.assertEqual(status, 200, turn)
                            evidence = self._get(self.backend, self.evidence_path(contact, turn))
                            self.assertEqual(evidence["retrieval"]["status"], "empty")
                            self.assertNotIn(memory["memory_id"], str(evidence))
                            self.assertEqual([item["kind"] for item in evidence["evidence"]], ["user_draft"])
                        else:
                            store.hold_before_commit = True
                            with ThreadPoolExecutor(max_workers=1) as pool:
                                pending = pool.submit(self.backend.request, path + "/replies", body)
                                try:
                                    self.assertTrue(store.entered.wait(5))
                                    self.assertIn(memory["memory_id"], str(self.reply_model.payloads[-1]))
                                    self._change_source(contact, source, message, mutation)
                                    store.release.set()
                                    status, rejected = pending.result(timeout=10)
                                finally:
                                    store.release.set()
                            self.assertNotEqual(status, 200, rejected)
                            failed = self._get(self.backend, path)["turns"][0]
                            self.assertEqual(failed["state"], "failed")
                            self.assertIsNone(failed["reply"])
                        self.delete_source(contact, source)
