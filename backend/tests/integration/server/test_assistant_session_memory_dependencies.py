"""记忆删除与有效期经公开 HTTP、稳定输入接口和真实 PG 联动验证。"""

from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import psycopg
from psycopg import sql
from psycopg.rows import dict_row, tuple_row

from notalone.application.assistant_session_service import AssistantSessionRejected
from notalone.persistence.locks import lock_owner_scope
from tests.integration.server import test_assistant_session_inputs as input_fixture


DATABASE_URL = input_fixture.DATABASE_URL


class AssistantSessionMemoryDependencyHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        input_fixture.AssistantSessionInputHttpTest.setUpClass()

    def setUp(self) -> None:
        setup = input_fixture.AssistantSessionInputHttpTest()
        setup.setUp()
        self.addCleanup(setup.doCleanups)
        self.fixture, self.store, self.scope = setup.fixture, setup.store, setup.scope
        self.session_id, self.path = setup.session_id, setup.path

    def _memory(self, kind: str, text: str) -> UUID:
        payload = {"text": text, "category": "preference", "topic": "other"}
        if kind == "contact":
            payload["contact_id"] = str(self.fixture.contact_id)
        status, saved = self.fixture.backend.request(f"/api/memories/manual-{kind}", payload)
        self.assertEqual(status, 200, saved)
        return UUID(saved["memory"]["memory_id"])

    def _set_period(self, kind: str, memory_id: UUID, *, future: bool = False, expired: bool = False) -> None:
        table = "confirmed_memory" if kind == "contact" else "owner_memory"
        with psycopg.connect(DATABASE_URL) as connection:
            lock_owner_scope(connection, owner_id=self.fixture.owner_id)
            connection.execute(sql.SQL(
                "UPDATE public.{} SET valid_at = CASE WHEN %s THEN now() + interval '1 day' "
                "ELSE now() - interval '1 day' END, "
                "invalid_at = CASE WHEN %s THEN now() ELSE NULL END WHERE owner_id = %s AND id = %s"
            ).format(sql.Identifier(table)), (future, expired, self.fixture.owner_id, memory_id))

    def test_contact_memory_delete_erases_dependent_discussions_and_replies_without_canceling_unrelated_running(self) -> None:
        text = "明天一起散步，我希望表达轻松自然。"
        memory_id = self._memory("contact", text)
        _, target_id = self.fixture._source("合成独立目标消息仍可用。")
        self.fixture.model.responses = [self.fixture._candidate(str(memory_id))]
        parent_body = self.fixture._body(draft=text)
        parent_body["content"]["include_relationship_context"] = True
        status, parent = self.fixture.backend.request(self.path + "/replies", parent_body)
        self.assertEqual(status, 200, parent)
        candidate_id = parent["candidates"][0]["candidate_id"]
        self.fixture.model.responses.append(self.fixture._candidate(candidate_id))
        status, child = self.fixture.backend.request(self.path + "/replies", {
            **self.fixture._body(draft="继续保留合成候选原意"), "continued_from_candidate_id": candidate_id,
        })
        self.assertEqual(status, 200, child)
        _, independent = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "无关讨论保留"},
        })
        response = self.store.record_discussion_input(self.scope, self.session_id, {
            "type": "response_exploration", "target_message_id": target_id,
            "correction": "仅本次有效记忆支持的合成要求",
        }, verified_dependencies=(memory_id,))
        purpose = self.store.record_discussion_input(self.scope, self.session_id, {
            "type": "purpose_exploration", "purpose_hint": "仅本次记忆支持的合成目的",
        }, verified_dependencies=(memory_id,))
        from notalone.persistence.locks import lock_contact_scope
        from notalone.persistence.reply_cleanup import delete_contact_memory_replies
        for factory in (tuple_row, dict_row):
            with self.subTest(factory=factory.__name__):
                with psycopg.connect(DATABASE_URL, row_factory=factory) as connection:
                    lock_contact_scope(connection, owner_id=self.scope.owner_id, contact_id=self.scope.contact_id)
                    lock_owner_scope(connection, owner_id=self.scope.owner_id)
                    delete_contact_memory_replies(connection, scope=self.scope, memory_id=memory_id)
                    self.assertIs(connection.row_factory, factory)
                    with connection.cursor(row_factory=dict_row) as cursor:
                        self.assertEqual(cursor.execute(
                            "SELECT state, content FROM public.assistant_session_input WHERE id = %s",
                            (purpose,),
                        ).fetchone(), {"state": "redacted", "content": None})
                    connection.rollback()
                self.assertEqual(self.fixture.backend.request(self.path)[1]["turns"][0]["state"], "completed")
        self.fixture.model.responses.append(self.fixture._candidate(str(self.fixture.draft_id)))
        body = self.fixture._body(draft="完全无关的合成草稿")
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.fixture.backend.request, self.path + "/replies", body)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                status, deleted = self.fixture.backend.request(
                    f"/api/contacts/{self.fixture.contact_id}/memories/{memory_id}/delete", {},
                )
                self.assertEqual(status, 200, deleted)
                status, saved = self.fixture.backend.request(self.path)
                self.assertEqual(status, 200, saved)
                records = {item["input_version_id"]: item for item in saved["inputs"]}
                for version in (response, purpose):
                    self.assertEqual(records[str(version)]["state"], "redacted")
                    self.assertIsNone(records[str(version)]["content"])
                    self.assertEqual(records[str(version)]["placeholder"], "相关来源已删除")
                with psycopg.connect(DATABASE_URL) as connection:
                    erased = connection.execute(
                        "SELECT state, content, dependency_ids FROM public.assistant_session_input "
                        "WHERE owner_id = %s AND id = ANY(%s::uuid[])",
                        (self.fixture.owner_id, [response, purpose]),
                    ).fetchall()
                    retained = connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id = %s AND id = ANY(%s::uuid[])",
                        (self.fixture.owner_id, [UUID(parent["reply_request_id"]), UUID(child["reply_request_id"])]),
                    ).fetchone()[0]
                self.assertEqual(erased, [("redacted", None, []), ("redacted", None, [])])
                self.assertEqual(retained, 0)
                self.assertEqual(records[independent["input_version_id"]]["content"]["purpose_hint"], "无关讨论保留")
                self.assertEqual([turn["state"] for turn in saved["turns"]], ["redacted", "redacted", "running"])
                self.assertTrue(all(turn["input"] is None and turn["reply"] is None for turn in saved["turns"][:2]))
            finally:
                gate.set()
            status, unrelated = running.result(timeout=10)
        self.assertEqual(status, 200, unrelated)
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual(saved["turns"][-1]["state"], "completed")
        self.assertEqual(saved["turns"][-1]["input"]["content"]["draft_text"], "完全无关的合成草稿")
        self.assertEqual(self.fixture.backend.request(self.path + "/replies", parent_body), (
            409, {"error": "assistant_session_rejected", "reason": "source_deleted"},
        ))
        self.assertEqual(len(self.fixture.model.seen_calls), 3)

    def test_future_or_expired_memory_cannot_advance_the_current_input(self) -> None:
        status, independent = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "无关当前输入"},
        })
        self.assertEqual(status, 200, independent)
        for kind in ("contact", "owner"):
            for future in (True, False):
                with self.subTest(kind=kind, future=future):
                    memory_id = self._memory(kind, "合成尚未生效或已过期的记忆")
                    self._set_period(kind, memory_id, future=future, expired=not future)
                    rejected = False
                    try:
                        self.store.record_discussion_input(self.scope, self.session_id, {
                            "type": "purpose_exploration", "purpose_hint": "不能采用无效时段记忆",
                        }, verified_dependencies=(memory_id,))
                    except AssistantSessionRejected:
                        rejected = True
                    status, saved = self.fixture.backend.request(self.path)
                    self.assertEqual(status, 200, saved)
                    self.assertEqual(saved["current_input_version_id"], independent["input_version_id"])
                    self.assertEqual(len(saved["inputs"]), 1)
                    self.assertTrue(rejected)
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_memory_expiration_masks_discussion_content_and_current_status(self) -> None:
        _, independent = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "无关讨论保持可读"},
        })
        for kind in ("contact", "owner"):
            with self.subTest(kind=kind):
                memory_id = self._memory(kind, "合成录入时仍有效的记忆")
                version = self.store.record_discussion_input(self.scope, self.session_id, {
                    "type": "purpose_exploration", "purpose_hint": "合成依赖记忆的讨论正文",
                }, verified_dependencies=(memory_id,))
                self.assertTrue(self.store.is_current_input(self.scope, self.session_id, version))
                self._set_period(kind, memory_id, expired=True)
                status, saved = self.fixture.backend.request(self.path)
                self.assertEqual(status, 200, saved)
                records = {item["input_version_id"]: item for item in saved["inputs"]}
                self.assertEqual(saved["current_input_version_id"], str(version))
                self.assertEqual(records[str(version)]["state"], "unavailable")
                self.assertIsNone(records[str(version)]["content"])
                self.assertEqual(records[str(version)]["placeholder"], "相关来源不可用")
                self.assertFalse(self.store.is_current_input(self.scope, self.session_id, version))
                self.assertEqual(records[independent["input_version_id"]]["content"]["purpose_hint"], "无关讨论保持可读")
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_memory_expiration_masks_generated_body_and_blocks_replay(self) -> None:
        self.fixture.model.responses = []
        for kind in ("contact", "owner"):
            with self.subTest(kind=kind):
                text = "明天一起散步，我希望表达轻松自然。"
                memory_id = self._memory(kind, text)
                self.fixture.model.responses.append(self.fixture._candidate(str(memory_id)))
                body = self.fixture._body(draft=text)
                body["content"]["include_relationship_context"] = True
                status, generated = self.fixture.backend.request(self.path + "/replies", body)
                self.assertEqual(status, 200, generated)
                calls = len(self.fixture.model.seen_calls)
                self._set_period(kind, memory_id, expired=True)
                status, saved = self.fixture.backend.request(self.path)
                self.assertEqual(status, 200, saved)
                self.assertEqual(saved["turns"][-1]["state"], "unavailable")
                self.assertIsNone(saved["turns"][-1]["input"])
                self.assertIsNone(saved["turns"][-1]["reply"])
                self.assertEqual(saved["inputs"][-1]["state"], "unavailable")
                self.assertFalse(self.store.is_current_input(self.scope, self.session_id,
                                                            UUID(generated["input_version_id"])))
                self.assertEqual(self.fixture.backend.request(self.path + "/replies", body), (
                    409, {"error": "assistant_session_rejected", "reason": "source_unavailable"},
                ))
                self.assertEqual(len(self.fixture.model.seen_calls), calls)
