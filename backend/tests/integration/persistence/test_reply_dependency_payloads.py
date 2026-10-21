"""历史依赖按回复取一次快照，依据数量不能放大上下文传输。"""

import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.persistence.assistant_session_store import _reply_dependencies
from notalone.persistence.locks import lock_owner_scope
from notalone.scopes import ContactScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class ReplyDependencyPayloadTest(OverviewReplyHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def prepare_reply(self):
        contact, _, _ = self.import_contact("合成课程需要准备。")
        memories = [self.manual_contact(contact, f"合成课程偏好{index}。", category="preference")
                    for index in range(4)]
        self.activate_replies(contact)
        self.reply_model.plans.append({"text": "一起准备合成课程。", "basis": "保留本次草稿。"})
        status, turn = self.backend.request(self.reply_path(contact) + "/replies",
            self.rewrite_body(contact, "合成课程准备，合成课程偏好。"))
        self.assertEqual(status, 200, turn)
        return ContactScope(self.owner_id, UUID(contact)), UUID(turn["reply_request_id"]), memories

    def test_snapshot_transfer_does_not_multiply_by_evidence_count(self):
        scope, request_id, memories = self.prepare_reply()
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            evidence_count = connection.execute("SELECT count(*) AS count FROM public.reply_context_evidence "
                "WHERE reply_request_id=%s", (request_id,)).fetchone()["count"]
            self.assertGreater(evidence_count, 2)
            before = _reply_dependencies(connection, scope, request_id)
            rows_seen = []
            fetchall = psycopg.Cursor.fetchall

            def measured(cursor):
                rows = fetchall(cursor)
                rows_seen.extend(row for row in rows if isinstance(row, dict) and "context_snapshot" in row)
                return rows

            with patch.object(psycopg.Cursor, "fetchall", measured):
                after = _reply_dependencies(connection, scope, request_id)
            self.assertEqual(before, after)
            self.assertTrue(set(UUID(m["memory_id"]) for m in memories) & after)
            self.assertEqual(len(rows_seen), 1, "同一历史上下文不应随每条依据重复传输和解析")
            self.assertEqual(_reply_dependencies(connection, ContactScope(self.owner_id, uuid4()), request_id), set())

    def test_evolution_provenance_and_next_read_keep_original_semantics(self):
        scope, request_id, _ = self.prepare_reply()
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            original = connection.execute("SELECT context_snapshot FROM public.reply_request WHERE id=%s",
                                          (request_id,)).fetchone()["context_snapshot"]
            base = _reply_dependencies(connection, scope, request_id)
            provenance, actual, navigation, message = [uuid4() for _ in range(4)]
            extended = {**original, "synthetic_actual": {"memory_id": str(actual)},
                "navigation_dependency_ids": [*original.get("navigation_dependency_ids", []),
                                              str(provenance), str(actual), str(navigation)],
                "evidence": [*original.get("evidence", []), {"evolution": {
                    "related_versions": [{"memory_id": str(provenance)}, {"memory_id": str(actual)}],
                    "evidence_message_ids": [str(message)]}}]}
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s",
                               (Jsonb(extended), request_id))
            self.assertEqual(_reply_dependencies(connection, scope, request_id), base | {actual, navigation, message})
            connection.execute("UPDATE public.reply_request SET context_snapshot=%s WHERE id=%s",
                               (Jsonb(original), request_id))
            self.assertEqual(_reply_dependencies(connection, scope, request_id), base)

    def test_continuation_inherits_only_scoped_ancestors_with_evidence(self):
        scope, parent_id, _ = self.prepare_reply()
        self.reply_model.plans.append({"text": "继续准备合成课程。", "basis": "保留本次草稿。"})
        contact = str(scope.contact_id)
        status, turn = self.backend.request(self.reply_path(contact) + "/replies",
            self.rewrite_body(contact, "继续准备合成课程。"))
        self.assertEqual(status, 200, turn)
        child_id, marker = UUID(turn["reply_request_id"]), uuid4()
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            candidate = connection.execute("SELECT id FROM public.reply_candidate WHERE reply_request_id=%s LIMIT 1",
                                           (parent_id,)).fetchone()["id"]
            connection.execute("UPDATE public.reply_request SET continued_from_candidate_id=%s WHERE id=%s",
                               (candidate, child_id))
            connection.execute("UPDATE public.reply_request SET context_snapshot=context_snapshot || %s WHERE id=%s",
                               (Jsonb({"navigation_dependency_ids": [str(marker)]}), parent_id))
            self.assertIn(marker, _reply_dependencies(connection, scope, child_id))
            self.assertEqual(_reply_dependencies(connection, ContactScope(uuid4(), scope.contact_id), child_id), set())
            connection.execute("DELETE FROM public.reply_context_evidence WHERE reply_request_id=%s", (parent_id,))
            self.assertNotIn(marker, _reply_dependencies(connection, scope, child_id))

    def test_nested_candidate_history_read_is_shared_only_inside_source_validation(self):
        from notalone.persistence.assistant_discussion_context import _candidate_history
        from notalone.persistence.reply_sources import _reply_source_validation_scope
        from notalone.reply.errors import ReplyStoreInvariantError
        scope, request_id, _ = self.prepare_reply()
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            row = connection.execute("SELECT turn.session_id,candidate.id FROM public.assistant_session_turn turn "
                "JOIN public.reply_candidate candidate ON candidate.reply_request_id=turn.reply_request_id "
                "WHERE turn.reply_request_id=%s LIMIT 1", (request_id,)).fetchone()
            from notalone.persistence import assistant_discussion_context as discussion
            with patch.object(discussion, "read_candidate_versions", wraps=discussion.read_candidate_versions) as read:
                with _reply_source_validation_scope(connection, scope):
                    first = _candidate_history(connection, scope, row["session_id"], row["id"])
                    with _reply_source_validation_scope(connection, scope):
                        self.assertEqual(first, _candidate_history(connection, scope, row["session_id"], row["id"]))
                    self.assertEqual(read.call_count, 1)
                    with self.assertRaises(ReplyStoreInvariantError):
                        _candidate_history(connection, scope, uuid4(), row["id"])
                self.assertEqual(first, _candidate_history(connection, scope, row["session_id"], row["id"]))
                self.assertEqual(read.call_count, 3, "新读取不能复用上轮完整候选历史")
            connection.execute("UPDATE public.assistant_session_turn SET state='failed' "
                               "WHERE reply_request_id=%s", (request_id,))
            with self.assertRaises(ReplyStoreInvariantError):
                _candidate_history(connection, scope, row["session_id"], row["id"])
