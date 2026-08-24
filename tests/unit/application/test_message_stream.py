"""消息流应用服务的参数门禁与范围拒绝测试；不连接数据库。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from uuid import uuid4

from notalone.application.message_stream import (
    MessageStream,
    MessageStreamContactNotFound,
)


class StubMessageStreamPort:
    """记录调用的内存端口。"""

    def __init__(self) -> None:
        self.exists = True
        self.calls: list[tuple[str, str, int, object]] = []

    def contact_exists(self, owner_id, contact_id) -> bool:
        return self.exists

    def page_messages(self, *, scope, limit, before_message_id=None):
        self.calls.append((str(scope.owner_id), str(scope.contact_id), limit, before_message_id))
        return SimpleNamespace(messages=(), next_cursor=None)


class MessageStreamGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        self.port = StubMessageStreamPort()
        self.stream = MessageStream(self.port)

    def test_contact_not_found_is_rejected(self) -> None:
        self.port.exists = False
        with self.assertRaises(MessageStreamContactNotFound):
            self.stream.page_messages(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
            )

    def test_limit_out_of_range_is_rejected(self) -> None:
        for bad in (0, -1, 101):
            with self.subTest(limit=bad), self.assertRaises(ValueError):
                self.stream.page_messages(
                    owner_id=self.owner_id,
                    contact_id=self.contact_id,
                    limit=bad,
                )

    def test_invalid_owner_or_contact_is_rejected(self) -> None:
        with self.assertRaises(TypeError):
            self.stream.page_messages(owner_id="not-uuid", contact_id=self.contact_id)
        with self.assertRaises(TypeError):
            self.stream.page_messages(owner_id=self.owner_id, contact_id="not-uuid")
        with self.assertRaises(TypeError):
            self.stream.page_messages(
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                before_message_id="not-uuid",
            )

    def test_valid_request_delegates_with_scope(self) -> None:
        before = uuid4()
        page = self.stream.page_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_id,
            limit=25,
            before_message_id=before,
        )

        self.assertEqual(
            self.port.calls,
            [
                (
                    str(self.owner_id),
                    str(self.contact_id),
                    25,
                    before,
                )
            ],
        )
        self.assertEqual(page.messages, ())
        self.assertIsNone(page.next_cursor)


if __name__ == "__main__":
    unittest.main()