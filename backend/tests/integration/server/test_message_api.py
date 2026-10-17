"""消息流查询 API 的进程内契约测试。

真实 PostgreSQL 测试库 + 合成消息/来源数据，钉住消息查询 API 的
JSON 结构、active 来源过滤、跨联系人/跨 owner 拒绝与引用消息语义。
不连接真实微信。
"""

from __future__ import annotations

import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg

from notalone.persistence.message_stream import PostgresMessageStream
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)


def _insert_message(
    *,
    connection: psycopg.Connection,
    owner_id: UUID,
    contact_id: UUID,
    message_id: UUID,
    source_id: UUID,
    speaker: str,
    message_type: str,
    text_content: str,
    media_placeholder: str | None,
    occurred_at: datetime | None,
    external_server_id: str,
    raw_payload: str = "{}",
    include_source: bool = True,
) -> None:
    connection.execute(
        """
        INSERT INTO public.message (
            id, owner_id, contact_id, speaker, message_type, text_content,
            media_placeholder, occurred_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            message_id,
            owner_id,
            contact_id,
            speaker,
            message_type,
            text_content,
            media_placeholder,
            occurred_at,
        ),
    )
    connection.execute(
        """
        INSERT INTO public.wechat_message_metadata (
            message_id, owner_id, contact_id, external_local_id,
            external_server_id, external_talker, source_create_time
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            message_id,
            owner_id,
            contact_id,
            _next_sequence(),
            external_server_id,
            "wxid_synthetic",
            2000,
        ),
    )

    if include_source:
        connection.execute(
            """
            INSERT INTO public.message_source_ref (
                message_id, owner_id, contact_id, source_kind,
                source_document_id, source_locator, raw_payload
            )
            VALUES (%s, %s, %s, 'source_document', %s, %s, %s::jsonb)
            """,
            (
                message_id,
                owner_id,
                contact_id,
                source_id,
                f"synthetic:{external_server_id}",
                raw_payload,
            ),
        )


_insert_message.sequence = 1000


def _next_sequence() -> int:
    """返回并递增测试级稳定身份序号。"""

    value = _insert_message.sequence
    _insert_message.sequence += 1
    return value


class MessageStreamApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.other_owner_id = uuid4()
        self.contact_id = uuid4()
        self.other_contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s), (%s, %s)",
                (self.owner_id, "合成用户甲", self.other_owner_id, "合成用户乙"),
            )
            connection.execute(
                """
                INSERT INTO public.contact (owner_id, id, display_name)
                VALUES (%s, %s, %s), (%s, %s, %s), (%s, %s, %s)
                """,
                (
                    self.owner_id,
                    self.contact_id,
                    "合成联系人甲",
                    self.other_owner_id,
                    self.other_contact_id,
                    "其他用户的联系人",
                    self.owner_id,
                    uuid4(),
                    "无来源联系人",
                ),
            )
        self.app = create_app(
            database_url=TEST_DATABASE_URL,
            owner_id=self.owner_id,
            token="test-token",
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    def tearDown(self) -> None:
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id IN (%s, %s)",
                (self.owner_id, self.other_owner_id),
            )

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------

    def _insert_plain_messages(self, *, count: int) -> list[UUID]:
        source_id = uuid4()
        message_ids: list[UUID] = []
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                )
                VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, %s)
                """,
                (
                    source_id,
                    self.owner_id,
                    self.contact_id,
                    "synthetic.jsonl",
                    "b" * 64,
                    count,
                ),
            )
            base = 1_800_000_000
            for index in range(count):
                message_id = uuid4()
                occurred_at = datetime.fromtimestamp(base + index, tz=timezone.utc)
                _insert_message(
                    connection=connection,
                    owner_id=self.owner_id,
                    contact_id=self.contact_id,
                    message_id=message_id,
                    source_id=source_id,
                    speaker="contact" if index % 2 else "user",
                    message_type="text",
                    text_content=f"合成消息 {index}",
                    media_placeholder=None,
                    occurred_at=occurred_at,
                    external_server_id=f"server-{index}",
                )
                message_ids.append(message_id)
        return message_ids

    # ------------------------------------------------------------------
    # 鉴权与范围隔离
    # ------------------------------------------------------------------

    def test_messages_require_token(self) -> None:
        response = self.client.get(
            f"/api/contacts/{self.contact_id}/messages",
        )
        wrong = self.client.get(
            f"/api/contacts/{self.contact_id}/messages",
            headers={"Authorization": "Bearer wrong-secret"},
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": "unauthorized"})
        self.assertEqual(wrong.status_code, 401)
        self.assertNotIn("wrong-secret", wrong.body.decode("utf-8"))

    def test_messages_require_current_owner_contact(self) -> None:
        other_response = self.client.get(
            f"/api/contacts/{self.other_contact_id}/messages",
            headers=self.headers,
        )
        missing_response = self.client.get(
            f"/api/contacts/{uuid4()}/messages",
            headers=self.headers,
        )

        self.assertEqual(other_response.status_code, 404)
        self.assertEqual(missing_response.status_code, 404)
        self.assertEqual(other_response.json(), {"error": "contact_not_found"})

    # ------------------------------------------------------------------
    # JSON 结构与 active 来源过滤
    # ------------------------------------------------------------------

    def test_messages_return_pinned_json_structure(self) -> None:
        message_ids = self._insert_plain_messages(count=2)

        response = self.client.get(
            f"/api/contacts/{self.contact_id}/messages",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["messages"]), 2)
        first_id = str(message_ids[1])
        second_id = str(message_ids[0])
        self.assertEqual(
            [item["message_id"] for item in payload["messages"]],
            [first_id, second_id],
        )
        self.assertEqual(
            payload["messages"][0],
            {
                "message_id": first_id,
                "speaker": "contact",
                "message_type": "text",
                "text": "合成消息 1",
                "media_placeholder": None,
                "occurred_at": "2027-01-15T08:00:01Z",
                "quoted": None,
            },
        )
        # 只有 2 条消息且 limit=50：没有下一页。
        self.assertIsNone(payload["next_cursor"])

    def test_messages_filter_out_messages_without_active_source(self) -> None:
        source_id = uuid4()
        with_source_id = uuid4()
        orphan_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                )
                VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 2)
                """,
                (
                    source_id,
                    self.owner_id,
                    self.contact_id,
                    "synthetic.jsonl",
                    "c" * 64,
                ),
            )
            now = datetime(2027, 2, 1, tzinfo=timezone.utc)
            _insert_message(
                connection=connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_id=with_source_id,
                source_id=source_id,
                speaker="user",
                message_type="text",
                text_content="有来源消息",
                media_placeholder=None,
                occurred_at=now,
                external_server_id="server-with-source",
            )
            _insert_message(
                connection=connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_id=orphan_id,
                source_id=source_id,
                speaker="contact",
                message_type="text",
                text_content="无来源消息",
                media_placeholder=None,
                occurred_at=now + timedelta(minutes=1),
                external_server_id="server-orphan",
                include_source=False,
            )

        response = self.client.get(
            f"/api/contacts/{self.contact_id}/messages",
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200)
        messages = response.json()["messages"]
        # 只有带 active 来源引用的消息会被返回；孤儿消息被过滤。
        self.assertEqual(
            [item["message_id"] for item in messages],
            [str(with_source_id)],
        )
        self.assertEqual(messages[0]["text"], "有来源消息")

    def test_media_placeholder_is_not_reported_as_text(self) -> None:
        source_id = uuid4()
        image_id = uuid4()
        text_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                )
                VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 2)
                """,
                (
                    source_id,
                    self.owner_id,
                    self.contact_id,
                    "synthetic.jsonl",
                    "d" * 64,
                ),
            )
            now = datetime(2027, 3, 1, tzinfo=timezone.utc)
            _insert_message(
                connection=connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_id=image_id,
                source_id=source_id,
                speaker="contact",
                message_type="image",
                text_content="",
                media_placeholder="[图片]",
                occurred_at=now,
                external_server_id="server-image",
            )
            _insert_message(
                connection=connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_id=text_id,
                source_id=source_id,
                speaker="user",
                message_type="text",
                text_content="普通正文",
                media_placeholder=None,
                occurred_at=now + timedelta(minutes=1),
                external_server_id="server-text",
            )

        response = self.client.get(
            f"/api/contacts/{self.contact_id}/messages",
            headers=self.headers,
        )

        messages = response.json()["messages"]
        by_id = {item["message_id"]: item for item in messages}
        self.assertEqual(by_id[str(text_id)]["text"], "普通正文")
        self.assertEqual(by_id[str(text_id)]["media_placeholder"], None)
        image = by_id[str(image_id)]
        self.assertEqual(image["text"], "")
        self.assertEqual(image["media_placeholder"], "[图片]")

    def test_quote_message_exposes_quoted_target_when_resolved(self) -> None:
        source_id = uuid4()
        target_id = uuid4()
        quote_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                )
                VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 2)
                """,
                (
                    source_id,
                    self.owner_id,
                    self.contact_id,
                    "synthetic.jsonl",
                    "e" * 64,
                ),
            )
            now = datetime(2027, 4, 1, tzinfo=timezone.utc)
            _insert_message(
                connection=connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_id=target_id,
                source_id=source_id,
                speaker="contact",
                message_type="text",
                text_content="被引用的目标消息",
                media_placeholder=None,
                occurred_at=now,
                external_server_id="server-target",
            )
            quote_payload = (
                '{"quote": {"id": {"server_id_str": "server-target"},'
                ' "text": "被引用的目标消息"}}'
            )
            _insert_message(
                connection=connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_id=quote_id,
                source_id=source_id,
                speaker="user",
                message_type="quote",
                text_content="引用回复",
                media_placeholder=None,
                occurred_at=now + timedelta(minutes=1),
                external_server_id="server-quote",
                raw_payload=quote_payload,
            )

        response = self.client.get(
            f"/api/contacts/{self.contact_id}/messages",
            headers=self.headers,
        )

        messages = response.json()["messages"]
        quote = {item["message_id"]: item for item in messages}[str(quote_id)]
        self.assertEqual(quote["message_type"], "quote")
        self.assertEqual(quote["text"], "引用回复")
        self.assertEqual(
            quote["quoted"],
            {
                "text": "被引用的目标消息",
                "target_message_id": str(target_id),
            },
        )

    def test_quote_message_with_missing_target_stays_unresolved(self) -> None:
        source_id = uuid4()
        quote_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                """
                INSERT INTO public.source_document (
                    id, owner_id, contact_id, source_type, file_name,
                    content_sha256, record_count
                )
                VALUES (%s, %s, %s, 'wechat_jsonl', %s, %s, 1)
                """,
                (
                    source_id,
                    self.owner_id,
                    self.contact_id,
                    "synthetic.jsonl",
                    "f" * 64,
                ),
            )
            quote_payload = (
                '{"quote": {"id": {"server_id_str": "server-vanished"},'
                ' "text": "已不存在的引用"}}'
            )
            _insert_message(
                connection=connection,
                owner_id=self.owner_id,
                contact_id=self.contact_id,
                message_id=quote_id,
                source_id=source_id,
                speaker="user",
                message_type="quote",
                text_content="引用回复",
                media_placeholder=None,
                occurred_at=datetime(2027, 5, 1, tzinfo=timezone.utc),
                external_server_id="server-quote-missing",
                raw_payload=quote_payload,
            )

        response = self.client.get(
            f"/api/contacts/{self.contact_id}/messages",
            headers=self.headers,
        )

        messages = response.json()["messages"]
        self.assertEqual(
            messages[0]["quoted"],
            {"text": "已不存在的引用", "target_message_id": None},
        )

    def test_messages_reject_invalid_query_params(self) -> None:
        self._insert_plain_messages(count=2)

        bad_cursor = self.client.get(
            f"/api/contacts/{self.contact_id}/messages?before=not-a-uuid",
            headers=self.headers,
        )
        bad_limit = self.client.get(
            f"/api/contacts/{self.contact_id}/messages?limit=abc",
            headers=self.headers,
        )
        zero_limit = self.client.get(
            f"/api/contacts/{self.contact_id}/messages?limit=0",
            headers=self.headers,
        )

        for response in (bad_cursor, bad_limit, zero_limit):
            with self.subTest(status=response.status_code):
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {"error": "invalid_message_query"})

    def test_messages_paginate_with_cursor(self) -> None:
        message_ids = self._insert_plain_messages(count=5)

        first = self.client.get(
            f"/api/contacts/{self.contact_id}/messages?limit=2",
            headers=self.headers,
        )
        payload = first.json()
        self.assertEqual(len(payload["messages"]), 2)
        self.assertEqual(payload["messages"][0]["message_id"], str(message_ids[4]))
        self.assertEqual(payload["messages"][1]["message_id"], str(message_ids[3]))
        cursor = payload["next_cursor"]

        second = self.client.get(
            f"/api/contacts/{self.contact_id}/messages?limit=2&before={cursor}",
            headers=self.headers,
        )
        second_payload = second.json()
        self.assertEqual(
            [item["message_id"] for item in second_payload["messages"]],
            [str(message_ids[2]), str(message_ids[1])],
        )

        third = self.client.get(
            f"/api/contacts/{self.contact_id}/messages?limit=2"
            f"&before={second_payload['next_cursor']}",
            headers=self.headers,
        )
        third_payload = third.json()
        self.assertEqual(
            [item["message_id"] for item in third_payload["messages"]],
            [str(message_ids[0])],
        )
        self.assertIsNone(third_payload["next_cursor"])

    def test_bounded_page_enrichment_finishes_without_message_statistics(self) -> None:
        message_ids = self._insert_plain_messages(count=505)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            statistics = connection.execute(
                "SELECT relname,last_analyze,last_autoanalyze FROM pg_stat_all_tables "
                "WHERE schemaname='public' AND relname=ANY(%s) ORDER BY relname",
                (["message", "message_source_ref", "source_document", "wechat_message_metadata",
                  "local_wechat_observation"],),
            ).fetchall()
        self.assertEqual(len(statistics), 5)
        if any(analyzed is not None or autoanalyzed is not None for _, analyzed, autoanalyzed in statistics):
            self.fail("无统计回归的前置条件不成立；须用尚未ANALYZE的自有新测试库，不能将此结果算作性能复现。")

        class BoundedStream(PostgresMessageStream):
            def _connect(inner):
                connection = super()._connect()
                try:
                    # 仅约束此测试读取事务，不修改产品HTTP或数据库永久设置。
                    connection.execute("SET LOCAL statement_timeout='3s'")
                    return connection
                except BaseException:
                    connection.close()
                    raise

        page = BoundedStream(TEST_DATABASE_URL).page_messages(
            scope=ContactScope(self.owner_id, self.contact_id), limit=50,
        )
        self.assertEqual([message.message_id for message in page.messages], list(reversed(message_ids[-50:])))
        self.assertEqual(page.next_cursor, message_ids[-50])

    def _insert_stream_source(self, connection, *, owner_id=None, contact_id=None, status="active") -> UUID:
        source_id = uuid4()
        connection.execute(
            "INSERT INTO public.source_document "
            "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status) "
            "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-page.jsonl',%s,10,%s)",
            (source_id, owner_id or self.owner_id, contact_id or self.contact_id, uuid4().hex * 2, status),
        )
        return source_id

    def test_cursor_preserves_same_time_null_and_active_scope(self) -> None:
        same_time = datetime(2027, 6, 1, tzinfo=timezone.utc)
        other_contact = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,%s)",
                               (self.owner_id, other_contact, "另一合成分页联系人"))
            active = self._insert_stream_source(connection)
            inactive = self._insert_stream_source(connection, status="delete_requested")
            other_source = self._insert_stream_source(connection, contact_id=other_contact)
            foreign_source = self._insert_stream_source(
                connection, owner_id=self.other_owner_id, contact_id=self.other_contact_id,
            )
            cases = (
                (40, self.owner_id, self.contact_id, active, same_time, True),
                (30, self.owner_id, self.contact_id, active, same_time, True),
                (20, self.owner_id, self.contact_id, active, None, True),
                (10, self.owner_id, self.contact_id, active, None, True),
                (80, self.owner_id, self.contact_id, inactive, same_time + timedelta(days=1), True),
                (70, self.owner_id, self.contact_id, active, same_time + timedelta(days=1), False),
                (90, self.owner_id, other_contact, other_source, same_time + timedelta(days=1), True),
                (100, self.other_owner_id, self.other_contact_id, foreign_source, same_time + timedelta(days=1), True),
            )
            for number, owner, contact, source, occurred_at, has_source in cases:
                _insert_message(connection=connection, owner_id=owner, contact_id=contact,
                    message_id=UUID(int=number), source_id=source, speaker="contact", message_type="text",
                    text_content=f"合成分页消息{number}", media_placeholder=None, occurred_at=occurred_at,
                    external_server_id=f"synthetic-page-{number}", include_source=has_source)
        scope = ContactScope(self.owner_id, self.contact_id)
        stream = PostgresMessageStream(TEST_DATABASE_URL)
        first = stream.page_messages(scope=scope, limit=2)
        self.assertEqual([message.message_id for message in first.messages], [UUID(int=40), UUID(int=30)])
        self.assertEqual(first.next_cursor, UUID(int=30))
        second = stream.page_messages(scope=scope, limit=1, before_message_id=first.next_cursor)
        self.assertEqual([message.message_id for message in second.messages], [UUID(int=20)])
        self.assertEqual(second.next_cursor, UUID(int=20))
        last = stream.page_messages(scope=scope, limit=1, before_message_id=second.next_cursor)
        self.assertEqual([message.message_id for message in last.messages], [UUID(int=10)])
        self.assertIsNone(last.next_cursor)
        tied = stream.page_messages(scope=scope, limit=3, before_message_id=UUID(int=40))
        self.assertEqual([message.message_id for message in tied.messages], [UUID(int=30), UUID(int=20), UUID(int=10)])
        self.assertIsNone(tied.next_cursor)
        self.assertTrue(all(message.scope == scope for page in (first, second, last, tied) for message in page.messages))

    def test_quote_expansion_keeps_outer_page_bound_with_duplicate_server_ids(self) -> None:
        when = datetime(2027, 7, 1, tzinfo=timezone.utc)
        targets = {UUID(int=101), UUID(int=102), UUID(int=103)}
        other_contact = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,%s)",
                               (self.owner_id, other_contact, "另一合成引用联系人"))
            source = self._insert_stream_source(connection)
            for number, owner, contact in ((101, self.owner_id, self.contact_id),
                (102, self.owner_id, self.contact_id), (103, self.owner_id, self.contact_id),
                (104, self.owner_id, other_contact), (105, self.other_owner_id, self.other_contact_id)):
                target_source = self._insert_stream_source(
                    connection, owner_id=owner, contact_id=contact,
                )
                _insert_message(connection=connection, owner_id=owner, contact_id=contact,
                    message_id=UUID(int=number), source_id=target_source, speaker="contact", message_type="text",
                    text_content="合成引用目标", media_placeholder=None, occurred_at=when,
                    external_server_id="synthetic-shared-server")
            for number, quoted_id, text in (
                (204, "synthetic-unresolved-primary", None),
                (203, "synthetic-shared-server", "合成共同引用"),
                (202, "synthetic-vanished", "引用目标已缺失。"),
            ):
                quote = {"id": {"server_id_str": quoted_id}}
                if text is not None:
                    quote["text"] = text
                _insert_message(connection=connection, owner_id=self.owner_id, contact_id=self.contact_id,
                    message_id=UUID(int=number), source_id=source, speaker="user", message_type="quote",
                    text_content=f"合成引用回复{number}", media_placeholder=None,
                    occurred_at=when + timedelta(minutes=number), external_server_id=f"synthetic-quote-{number}",
                    raw_payload=json.dumps({"quote": quote}))
            # 同一消息多来源时仍优先有引用正文的记录，不能因先分页改变引用选择。
            additional_source = self._insert_stream_source(connection)
            connection.execute(
                "INSERT INTO public.message_source_ref "
                "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic-extra-quote',%s::jsonb)",
                (UUID(int=204), self.owner_id, self.contact_id, additional_source, json.dumps({"quote": {
                    "id": {"server_id_str": "synthetic-shared-server"}, "text": "合成共同引用",
                }})),
            )

        row_counts = []

        class ObservedCursor:
            def __init__(inner, cursor):
                inner.cursor = cursor

            def fetchone(inner):
                return inner.cursor.fetchone()

            def fetchall(inner):
                rows = inner.cursor.fetchall()
                row_counts.append(len(rows))
                return rows

        class ObservedConnection:
            def __init__(inner, connection):
                inner.connection = connection

            def __enter__(inner):
                inner.connection.__enter__()
                return inner

            def __exit__(inner, *args):
                return inner.connection.__exit__(*args)

            def execute(inner, query, parameters):
                return ObservedCursor(inner.connection.execute(query, parameters))

        class ObservedStream(PostgresMessageStream):
            def _connect(inner):
                return ObservedConnection(super()._connect())

        stream = ObservedStream(TEST_DATABASE_URL)
        scope = ContactScope(self.owner_id, self.contact_id)
        first = stream.page_messages(scope=scope, limit=2)
        self.assertEqual(row_counts[-1], 3, "引用展开后的数据库结果也只能读取limit+1行。")
        self.assertEqual([message.message_id for message in first.messages], [UUID(int=204)] * 2)
        self.assertEqual(first.next_cursor, UUID(int=204))
        self.assertEqual(len({message.quoted.target_message_id for message in first.messages}), 2)
        self.assertTrue({message.quoted.target_message_id for message in first.messages} <= targets)
        all_targets = stream.page_messages(scope=scope, limit=3)
        self.assertEqual(row_counts[-1], 4)
        self.assertEqual([message.message_id for message in all_targets.messages], [UUID(int=204)] * 3)
        self.assertEqual({message.quoted.target_message_id for message in all_targets.messages}, targets)
        self.assertTrue(all(message.quoted.text == "合成共同引用" for message in all_targets.messages))
        second = stream.page_messages(scope=scope, limit=2, before_message_id=first.next_cursor)
        self.assertEqual(row_counts[-1], 3)
        self.assertEqual([message.message_id for message in second.messages], [UUID(int=203)] * 2)
        self.assertEqual(second.next_cursor, UUID(int=203))
        missing = stream.page_messages(scope=scope, limit=1, before_message_id=second.next_cursor)
        self.assertEqual(row_counts[-1], 2)
        self.assertEqual(missing.messages[0].message_id, UUID(int=202))
        self.assertEqual(missing.messages[0].quoted.text, "引用目标已缺失。")
        self.assertIsNone(missing.messages[0].quoted.target_message_id)
        self.assertEqual(missing.next_cursor, UUID(int=202))


if __name__ == "__main__":
    unittest.main()
