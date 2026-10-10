"""会话目录通过真实 HTTP 与隔离 PostgreSQL 验证显式新开及选择。"""

from __future__ import annotations

import unittest
from contextlib import contextmanager
from typing import Iterator
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from notalone.application.assistant_session_service import AssistantSessionService
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.server.app import create_app
from tests.integration.server.core_business_flow_support import HttpBackend

from tests.integration.server import test_assistant_session_api as session_fixture


DATABASE_URL = session_fixture.DATABASE_URL


class AssistantSessionCatalogHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        session_fixture.AssistantSessionHttpTest.setUpClass()

    def setUp(self) -> None:
        self.fixture = session_fixture.AssistantSessionHttpTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def _catalog_path(self, *, contact_id=None) -> str:
        return f"/api/contacts/{contact_id or self.fixture.contact_id}/assistant-sessions"

    @contextmanager
    def _reject_write(self, *, creation: bool) -> Iterator[None]:
        name = f"synthetic_catalog_http_failure_{uuid4().hex}"
        event = "INSERT" if creation else "UPDATE OF is_default"
        condition = "NEW.owner_id = {owner}::uuid AND NEW.is_default"
        if not creation:
            condition += " AND NOT OLD.is_default"
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS "
                "'BEGIN RAISE EXCEPTION ''synthetic_catalog_private_fault''; END;'"
            ).format(name=sql.Identifier(name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {name} BEFORE " + event + " ON public.assistant_session "
                "FOR EACH ROW WHEN (" + condition + ") EXECUTE FUNCTION public.{name}()"
            ).format(name=sql.Identifier(name), owner=sql.Literal(str(self.fixture.owner_id))))
        try:
            yield
        finally:
            with psycopg.connect(DATABASE_URL) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.assistant_session").format(
                    name=sql.Identifier(name),
                ))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()").format(name=sql.Identifier(name)))

    def test_new_session_is_empty_and_becomes_explicit_current_without_model_call(self) -> None:
        status, old = self.fixture._default()
        self.assertEqual(status, 200, old)

        status, created = self.fixture.backend.request(
            self._catalog_path(), {}, method="POST",
        )
        self.assertEqual(status, 200, created)
        self.assertNotEqual(created["session_id"], old["session_id"])
        status, saved = self.fixture.backend.request(self.fixture._path(created["session_id"]))
        self.assertEqual(status, 200, saved)
        self.assertIsNone(saved["current_input_version_id"])
        self.assertEqual(saved["inputs"], [])
        self.assertEqual(saved["turns"], [])
        self.assertEqual(self.fixture._default()[1]["session_id"], created["session_id"])
        self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]))[0], 200)
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_list_is_empty_without_creating_or_selecting_a_session(self) -> None:
        self.assertEqual(self.fixture.backend.request(self._catalog_path()), (
            200, {"sessions": [], "current_session_id": None},
        ))
        self.assertEqual(self.fixture.backend.request(self._catalog_path()), (
            200, {"sessions": [], "current_session_id": None},
        ))
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_select_explicit_session_id_returns_without_generating(self) -> None:
        status, current = self.fixture._default()
        self.assertEqual(status, 200, current)
        self.assertEqual(self.fixture.backend.request(
            self.fixture._path(current["session_id"]) + "/select", {}, method="POST",
        ), (200, current))
        self.assertEqual(self.fixture._default()[1]["session_id"], current["session_id"])
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_new_list_select_and_reconnect_preserve_old_discussion_and_candidates(self) -> None:
        _, old = self.fixture._default()
        old_path = self.fixture._path(old["session_id"])
        status, discussion = self.fixture.backend.request(old_path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "合成旧讨论目的", "requirements": "不作新承诺"},
        })
        self.assertEqual(status, 200, discussion)
        status, reply = self.fixture.backend.request(old_path + "/replies", {
            **self.fixture._body(), "expected_input_version_id": discussion["input_version_id"],
        })
        self.assertEqual(status, 200, reply)
        self.assertEqual(len(self.fixture.model.seen_calls), 1)
        before = self.fixture.backend.request(old_path)[1]

        status, new = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        self.assertEqual(status, 200, new)
        status, listed = self.fixture.backend.request(self._catalog_path())
        self.assertEqual(status, 200, listed)
        self.assertEqual(listed["current_session_id"], new["session_id"])
        self.assertEqual({item["session_id"]: item["is_current"] for item in listed["sessions"]}, {
            old["session_id"]: False, new["session_id"]: True,
        })
        self.assertTrue(all(set(item) == {"session_id", "is_current"} for item in listed["sessions"]))
        self.assertEqual(self.fixture.backend.request(old_path + "/select", {}, method="POST"), (200, old))
        self.assertEqual(self.fixture.backend.request(old_path)[1], before)

        reopened = self.fixture._backend()
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.request(self._catalog_path())[1]["current_session_id"], old["session_id"])
        self.assertEqual(reopened.request(old_path)[1], before)
        self.assertEqual(self.fixture._default()[1], old)
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_unknown_or_cross_scope_selection_leaves_current_unchanged(self) -> None:
        _, first = self.fixture._default()
        _, current = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        unknown = self.fixture._path(uuid4()) + "/select"
        other_contact = self.fixture._path(first["session_id"], contact_id=self.fixture.other_contact_id) + "/select"
        self.assertEqual(self.fixture.backend.request(unknown, {}, method="POST"), (404, {"error": "not_found"}))
        self.assertEqual(self.fixture.backend.request(other_contact, {}, method="POST"), (404, {"error": "not_found"}))
        other_owner = self.fixture._backend(owner_id=uuid4())
        self.addCleanup(other_owner.close)
        for method, path, body in (("GET", self._catalog_path(), None),
                                   ("POST", self._catalog_path(), {}),
                                   ("POST", self.fixture._path(first["session_id"]) + "/select", {})):
            with self.subTest(method=method, path=path):
                self.assertEqual(other_owner.request(path, body, method=method), (404, {"error": "not_found"}))
        self.assertEqual(self.fixture.backend.request(self._catalog_path())[1]["current_session_id"], current["session_id"])
        self.assertEqual(self.fixture.backend.request(self._catalog_path(contact_id=self.fixture.other_contact_id)), (
            200, {"sessions": [], "current_session_id": None},
        ))
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_new_and_select_require_empty_action_body_and_explicit_uuid(self) -> None:
        _, current = self.fixture._default()
        for path in (self._catalog_path(), self.fixture._path(current["session_id"]) + "/select"):
            for body in ({"owner_id": str(uuid4())}, {"session_id": current["session_id"]}, [], "", None):
                with self.subTest(path=path, body_type=type(body).__name__):
                    self.assertEqual(self.fixture.backend.request(path, body, method="POST"), (
                        400, {"error": "assistant_session_request_invalid"},
                    ))
        self.assertEqual(self.fixture.backend.request(self._catalog_path() + "/nickname/select", {}, method="POST"), (
            400, {"error": "assistant_session_request_invalid"},
        ))
        self.assertEqual(self.fixture.backend.request(self._catalog_path())[1]["current_session_id"], current["session_id"])
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_revoked_binding_allows_read_and_select_but_rejects_new_and_generation(self) -> None:
        _, old = self.fixture._default()
        _, new = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        self.fixture.bindings.revoke_binding(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_id,
            binding_id=self.fixture.binding.binding_id,
        )
        self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]) + "/select", {}, method="POST"), (200, old))
        self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]))[0], 200)
        self.assertEqual(self.fixture.backend.request(self._catalog_path())[1]["current_session_id"], old["session_id"])
        rejected = (409, {"error": "assistant_session_rejected", "reason": "no_active_binding"})
        self.assertEqual(self.fixture.backend.request(self._catalog_path(), {}, method="POST"), rejected)
        self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]) + "/replies", self.fixture._body()), rejected)
        self.assertEqual(self.fixture.backend.request(self.fixture._path(new["session_id"]))[1]["inputs"], [])
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_selecting_source_deleted_old_session_returns_only_placeholder(self) -> None:
        source_id, message_id = self.fixture._source("合成来源删除旧会话消息")
        self.fixture.model.responses = [self.fixture._candidate(message_id)]
        _, old = self.fixture._default()
        path = self.fixture._path(old["session_id"])
        body = {"contact_id": str(self.fixture.contact_id), "idempotency_key": str(uuid4()),
                "content": {"type": "reply_to_message", "target_message_id": message_id, "direction": "合成回应方向"}}
        status, reply = self.fixture.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, reply)
        status, new = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        self.assertEqual(status, 200, new)
        self.fixture._delete_source(source_id)

        self.assertEqual(self.fixture.backend.request(path + "/select", {}, method="POST"), (200, old))
        status, saved = self.fixture.backend.request(path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "redacted")
        self.assertEqual(saved["turns"][0]["placeholder"], "相关来源已删除")
        self.assertIsNone(saved["turns"][0]["input"])
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(saved["inputs"][0]["state"], "redacted")
        self.assertEqual(self.fixture.backend.request(self.fixture._path(new["session_id"]))[1]["turns"], [])
        self.assertEqual(self.fixture.backend.request(path + "/replies", body), (
            409, {"error": "assistant_session_rejected", "reason": "source_deleted"},
        ))
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_deleted_old_session_cannot_be_selected_and_does_not_change_current(self) -> None:
        _, old = self.fixture._default()
        _, current = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        path = self.fixture._path(old["session_id"])
        self.assertEqual(self.fixture.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(self.fixture.backend.request(path + "/select", {}, method="POST"), (404, {"error": "not_found"}))
        self.assertEqual(self.fixture.backend.request(self._catalog_path()), (
            200, {"sessions": [{"session_id": current["session_id"], "is_current": True}],
                  "current_session_id": current["session_id"]},
        ))
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_catalog_write_failures_return_503_and_roll_back_current(self) -> None:
        _, old = self.fixture._default()
        failure = (503, {"error": "assistant_session_save_failed"})
        with self._reject_write(creation=True):
            self.assertEqual(self.fixture.backend.request(self._catalog_path(), {}, method="POST"), failure)
        self.assertEqual(self.fixture.backend.request(self._catalog_path())[1]["current_session_id"], old["session_id"])
        _, current = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        with self._reject_write(creation=False):
            self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]) + "/select", {}, method="POST"), failure)
        self.assertEqual(self.fixture.backend.request(self._catalog_path())[1]["current_session_id"], current["session_id"])
        self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]))[0], 200)
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_catalog_database_read_failure_is_explicit_without_driver_or_body_details(self) -> None:
        failed_url = make_conninfo(DATABASE_URL, dbname=f"notalone_missing_catalog_{uuid4().hex}_test")
        service = AssistantSessionService(
            store=PostgresAssistantSessionStore(DATABASE_URL), reply=self.fixture.reply_service,
            catalog=PostgresAssistantSessionCatalog(failed_url),
        )
        broken = HttpBackend(create_app(
            database_url=DATABASE_URL, owner_id=self.fixture.owner_id,
            token="synthetic-catalog-read-fault-token", reply_service=self.fixture.reply_service,
            assistant_sessions=service,
        ), self.fixture.owner_id)
        self.addCleanup(broken.close)
        self.assertEqual(broken.request(self._catalog_path()), (503, {"error": "assistant_session_save_failed"}))
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_ambiguous_binding_keeps_catalog_readable_and_blocks_new_or_generated_work(self) -> None:
        _, old = self.fixture._default()
        _, current = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        self.fixture.bindings.create_binding(
            owner_id=self.fixture.owner_id, contact_id=self.fixture.contact_id,
            channel="wechat", account_scope="synthetic-session-account",
            conversation_locator=f"synthetic-second-{uuid4()}",
        )
        rejected = (409, {"error": "assistant_session_rejected", "reason": "ambiguous_binding"})
        self.assertEqual(self.fixture.backend.request(self._catalog_path(), {}, method="POST"), rejected)
        self.assertEqual(self.fixture.backend.request(self._catalog_path())[1]["current_session_id"], current["session_id"])
        self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]) + "/select", {}, method="POST"), (200, old))
        self.assertEqual(self.fixture.backend.request(self.fixture._path(old["session_id"]) + "/replies", self.fixture._body()), rejected)
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_selecting_old_pure_discussion_restores_its_input_uuid_without_candidates(self) -> None:
        _, old = self.fixture._default()
        path = self.fixture._path(old["session_id"])
        status, discussion = self.fixture.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "只保存合成讨论，不生成候选",
                        "requirements": "合成旧讨论要求", "correction": "少一点客套"},
        })
        self.assertEqual(status, 200, discussion)
        before = self.fixture.backend.request(path)[1]
        self.assertEqual(before["current_input_version_id"], discussion["input_version_id"])
        self.assertEqual(before["inputs"][0]["input_version_id"], discussion["input_version_id"])
        self.assertIsNone(before["inputs"][0]["turn_id"])
        self.assertEqual(before["inputs"][0]["type"], "purpose_exploration")
        self.assertEqual(before["turns"], [])

        status, new = self.fixture.backend.request(self._catalog_path(), {}, method="POST")
        self.assertEqual(status, 200, new)
        self.assertEqual(self.fixture.backend.request(path + "/select", {}, method="POST"), (200, old))
        reopened = self.fixture._backend()
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.request(path), (200, before))
        self.assertEqual(reopened.request(self._catalog_path())[1]["current_session_id"], old["session_id"])
        self.assertIsNone(reopened.request(self.fixture._path(new["session_id"]))[1]["current_input_version_id"])
        self.assertEqual(len(self.fixture.model.seen_calls), 0)


if __name__ == "__main__":
    unittest.main()
