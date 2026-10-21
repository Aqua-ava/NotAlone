"""准备阶段延后概览复验到保存事务，其他来源守卫保持完整。"""

from collections import Counter
from contextlib import ExitStack
import unittest
from unittest.mock import patch

import psycopg

from notalone.persistence.assistant_discussion_reply_context import PostgresAssistantDiscussionContext
from notalone.persistence.assistant_prepared_context import PreparedAssistantContext
from notalone.persistence import assistant_prepared_context
from notalone.persistence.memory_overview import PostgresRelationshipOverviewStore
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.overview_reply_support import OverviewReplyHttpFixture


class PrepareOverviewValidationTest(OverviewReplyHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def _prepare_request(self):
        contact, source, message = self.import_contact("对方参加合成课程。")
        memory = self.confirm(contact, "对方参加合成课程。", message)
        owner = self.manual_owner("本人也参加合成课程。")
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "想聊聊合成课程。")
        return contact, source, message, {"contact": memory, "owner": owner}, path, body

    def test_preparation_reads_each_overview_for_build_and_locked_commit_only(self):
        _, _, _, _, path, body = self._prepare_request()
        counts = Counter()
        contact_read = PostgresRelationshipOverviewStore.read_contact_in_transaction
        owner_read = PostgresRelationshipOverviewStore.read_owner_in_transaction

        def contact(store, *args, **kwargs):
            counts["contact"] += 1
            return contact_read(store, *args, **kwargs)

        def owner(store, *args, **kwargs):
            counts["owner"] += 1
            return owner_read(store, *args, **kwargs)

        with ExitStack() as stack:
            stack.enter_context(patch.object(PostgresRelationshipOverviewStore, "read_contact_in_transaction", contact))
            stack.enter_context(patch.object(PostgresRelationshipOverviewStore, "read_owner_in_transaction", owner))
            status, result = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, result)
        self.assertEqual(counts, {"contact": 2, "owner": 2})
        self.assertEqual(self.reply_model.seen_calls, [])

    def test_overview_changes_after_budget_check_are_rejected_by_locked_commit(self):
        for side, table in (("contact", "confirmed_memory"), ("owner", "owner_memory")):
            with self.subTest(side=side):
                _, _, _, memories, path, body = self._prepare_request()
                fit = PreparedAssistantContext.fit_budget

                def change_after_budget(context_port, context, **kwargs):
                    prepared = fit(context_port, context, **kwargs)
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(f"UPDATE public.{table} SET text_content='保存前合成资料已变化。' "
                            "WHERE owner_id=%s AND id=%s", (self.owner_id, memories[side]["memory_id"]))
                    return prepared

                with patch.object(PreparedAssistantContext, "fit_budget", change_after_budget), patch.object(
                        assistant_prepared_context, "require_current_overview_navigation",
                        wraps=assistant_prepared_context.require_current_overview_navigation) as verify:
                    status, result = self.backend.request(path + "/replies/prepare", body)
                self.assertNotEqual(status, 200, result)
                self.assertEqual(verify.call_count, 1, "最终保存仍须执行持锁概览复验")
                self.assertEqual(self.reply_model.seen_calls, [])

    def test_preparation_still_rejects_changed_message_text_speaker_and_source(self):
        statements = (
            "UPDATE public.message SET text_content='原合成消息正文已修正。' WHERE owner_id=%s AND id=%s",
            "UPDATE public.message SET speaker='user' WHERE owner_id=%s AND id=%s",
            "DELETE FROM public.message_source_ref WHERE owner_id=%s AND message_id=%s",
        )
        for statement in statements:
            with self.subTest(mutation=statement.split()[2:4]):
                _, _, message, _, path, body = self._prepare_request()
                body["content"] = {"type": "reply_to_message", "target_message_id": str(message),
                                   "direction": "合成明确回应课程邀请。"}
                build = PostgresAssistantDiscussionContext.build

                def change_after_build(context_port, **kwargs):
                    context = build(context_port, **kwargs)
                    self.assertTrue(any(item.evidence_id == message and item.kind == "message"
                                        for item in context.evidence))
                    with psycopg.connect(self.database_url) as connection:
                        connection.execute(statement, (self.owner_id, message))
                    return context

                with patch.object(PostgresAssistantDiscussionContext, "build", change_after_build), patch.object(
                        assistant_prepared_context, "require_current_overview_navigation",
                        wraps=assistant_prepared_context.require_current_overview_navigation) as verify:
                    status, result = self.backend.request(path + "/replies/prepare", body)
                self.assertNotEqual(status, 200, result)
                self.assertEqual(verify.call_count, 0, "消息守卫仍须在最终概览复验前拒绝变化")
                self.assertEqual(self.reply_model.seen_calls, [])

    def test_unsupported_preparation_adapter_falls_back_to_full_validation(self):
        _, _, _, _, path, body = self._prepare_request()
        read = PostgresRelationshipOverviewStore.read_contact_in_transaction
        reads = []

        def contact(store, *args, **kwargs):
            reads.append(True)
            return read(store, *args, **kwargs)

        with patch.object(PostgresAssistantDiscussionContext, "validate_for_preparation", None), patch.object(
                PostgresRelationshipOverviewStore, "read_contact_in_transaction", contact):
            status, result = self.backend.request(path + "/replies/prepare", body)
        self.assertEqual(status, 200, result)
        self.assertEqual(len(reads), 3, "旧适配器缺少专用接口时不能省略其完整验证")
