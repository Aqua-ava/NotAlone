"""联系人范围检索的合成行为测试。"""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID

from notalone.memory import InMemoryMemoryStore
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from notalone.scopes import ContactScope


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("22222222-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("33333333-3333-3333-3333-333333333333")
MESSAGE_ID = UUID("44444444-4444-4444-4444-444444444444")
OTHER_MESSAGE_ID = UUID("55555555-5555-5555-5555-555555555555")
SOURCE_ID = UUID("88888888-8888-8888-8888-888888888888")


class RetrievalTest(unittest.TestCase):
    def test_message_query_filters_by_owner_and_contact_before_text_matching(
        self,
    ) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        other_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        retrieval = InMemoryRetrieval(
            messages=(
                RetrievedMessage(MESSAGE_ID, scope, "本联系人的合成消息"),
                RetrievedMessage(
                    OTHER_MESSAGE_ID,
                    other_scope,
                    "相似名称的另一消息",
                ),
            ),
            memory_store=InMemoryMemoryStore(),
        )

        results = retrieval.search_messages(
            scope=scope,
            query="相似名称",
        )

        self.assertEqual(results, ())

    def test_target_message_is_returned_before_recent_same_scope_messages(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        recent_id = UUID("66666666-6666-6666-6666-666666666666")
        retrieval = InMemoryRetrieval(
            messages=(
                RetrievedMessage(recent_id, scope, "较近的合成消息"),
                RetrievedMessage(MESSAGE_ID, scope, "待回复的合成消息"),
            ),
            memory_store=InMemoryMemoryStore(),
        )

        results = retrieval.search_messages(
            scope=scope,
            target_message_id=MESSAGE_ID,
            limit=2,
        )

        self.assertEqual(
            tuple(item.message_id for item in results),
            (MESSAGE_ID, recent_id),
        )

    def test_query_messages_returns_finite_chronological_window(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        start = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)
        messages = tuple(
            RetrievedMessage(
                UUID(f"77777777-7777-7777-7777-{index:012d}"),
                scope,
                f"第 {index} 条合成消息",
                source_ids=(SOURCE_ID,),
                occurred_at=start + timedelta(minutes=index),
            )
            for index in range(5)
        )
        retrieval = InMemoryRetrieval(messages=messages)

        results = retrieval.query_messages(
            scope=scope,
            anchor_message_id=messages[2].message_id,
            before=1,
            after=1,
        )

        self.assertEqual(
            tuple(item.message_id for item in results),
            tuple(message.message_id for message in messages[1:4]),
        )

    def test_query_messages_never_returns_another_contact(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        other_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        retrieval = InMemoryRetrieval(
            messages=(
                RetrievedMessage(MESSAGE_ID, scope, "当前范围消息"),
                RetrievedMessage(OTHER_MESSAGE_ID, other_scope, "越界消息"),
            )
        )

        results = retrieval.query_messages(
            scope=scope,
            anchor_message_id=MESSAGE_ID,
            before=5,
            after=5,
        )

        self.assertEqual(tuple(item.text for item in results), ("当前范围消息",))


if __name__ == "__main__":
    unittest.main()
