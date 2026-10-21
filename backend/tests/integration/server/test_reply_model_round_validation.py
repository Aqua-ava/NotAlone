"""正式回复装配每个模型轮只完整复验一次，仍逐轮拒绝失效租约与来源。"""

from contextlib import ExitStack
import unittest
from unittest.mock import patch

import psycopg
from langchain_core.rate_limiters import InMemoryRateLimiter

from notalone.persistence.assistant_prepared_context import PreparedAssistantContext
from notalone.persistence.reply_store import PostgresReplyStore
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.overview_reply_support import (
    OverviewReplyControlledModel, OverviewReplyHttpFixture,
)


class ReplyModelRoundValidationTest(OverviewReplyHttpFixture, CoreBusinessFlowFixture, unittest.TestCase):
    setUpClass = classmethod(CoreBusinessFlowFixture.setUpClass.__func__)

    def _prepare_reply(self):
        contact, source, message = self.import_contact("对方参加合成课程。")
        self.confirm(contact, "对方参加合成课程。", message)
        self.activate_replies(contact)
        path = self.reply_path(contact)
        body = self.rewrite_body(contact, "想聊聊合成课程。")
        self.reply_model.plans.extend([
            {"history": {"name": "conversation_search", "args": {"query": "合成课程", "top_k": 8}}},
            {"text": "想聊聊合成课程。", "basis": "保留本次草稿原意。"},
        ])
        return contact, source, message, path, body

    def test_each_model_round_revalidates_the_attempt_and_context_once(self):
        _, _, _, path, body = self._prepare_reply()
        events = []
        require_current = PostgresReplyStore.require_current
        validate_current = PreparedAssistantContext.validate_current
        generate = OverviewReplyControlledModel._generate

        def require(store, request):
            events.append("lease")
            return require_current(store, request)

        def validate(context, prepared):
            events.append("context")
            return validate_current(context, prepared)

        def model_call(model, *args, **kwargs):
            events.append("model")
            return generate(model, *args, **kwargs)

        # 只观测正式方法，完整执行数据库、运行时和外部合成模型边界。
        with ExitStack() as stack:
            stack.enter_context(patch.object(PostgresReplyStore, "require_current", require))
            stack.enter_context(patch.object(PreparedAssistantContext, "validate_current", validate))
            stack.enter_context(patch.object(OverviewReplyControlledModel, "_generate", model_call))
            status, result = self.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, result)
        self.assertEqual(events.count("model"), 2, events)
        self.assertEqual(events.count("lease"), 2, events)
        for index, event in enumerate(events):
            if event == "model":
                beginning = max(position for position in range(index) if events[position] == "lease")
                self.assertEqual(events[beginning:index], ["lease", "context"],
                                 "同一模型轮不能重复执行完整来源复验")

    def test_missing_request_guard_rejects_before_any_model_call(self):
        _, _, _, path, body = self._prepare_reply()
        with patch("notalone.reply.runtime.current_model_request_validator", return_value=None):
            status, result = self.backend.request(path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(self.reply_model.seen_calls, [])

    def test_model_configuration_guard_still_rejects_local_rate_limiting(self):
        _, _, _, path, body = self._prepare_reply()
        self.reply_model.rate_limiter = InMemoryRateLimiter(requests_per_second=1000)
        status, result = self.backend.request(path + "/replies", body)
        self.assertNotEqual(status, 200, result)
        self.assertEqual(self.reply_model.seen_calls, [])

    def test_changed_source_or_expired_attempt_blocks_the_next_model_round(self):
        for mutation in ("source", "lease"):
            with self.subTest(mutation=mutation):
                contact, _, message, path, body = self._prepare_reply()
                generate = OverviewReplyControlledModel._generate
                seen = []

                def model_call(model, *args, **kwargs):
                    result = generate(model, *args, **kwargs)
                    seen.append(True)
                    if len(seen) == 1:
                        with psycopg.connect(self.database_url) as connection:
                            if mutation == "source":
                                connection.execute("UPDATE public.message SET text_content='原课程来源已修正。' "
                                    "WHERE owner_id=%s AND contact_id=%s AND id=%s",
                                    (self.owner_id, contact, message))
                            else:
                                connection.execute("UPDATE public.reply_request SET lease_expires_at=now()-interval '1 second' "
                                    "WHERE owner_id=%s AND contact_id=%s AND idempotency_key=%s",
                                    (self.owner_id, contact, body["idempotency_key"]))
                    return result

                with patch.object(OverviewReplyControlledModel, "_generate", model_call):
                    status, result = self.backend.request(path + "/replies", body)
                self.assertNotEqual(status, 200, result)
                self.assertEqual(len(seen), 1, "来源或租约变化后不能发出第二轮模型请求")
                turn = self._get(self.backend, path)["turns"][0]
                self.assertIsNone(turn["reply"])
                self.reply_model.plans.clear()
