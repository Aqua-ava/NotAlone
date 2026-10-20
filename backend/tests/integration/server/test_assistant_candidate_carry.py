"""显式携候选新开经生产 HTTP 和正式迁移隔离 PostgreSQL 验证。"""

from __future__ import annotations

import json
import unittest

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb
from uuid import uuid4

from tests.integration.server import test_assistant_input_budget as budget_fixture


class AssistantCandidateCarryHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        budget_fixture.AssistantInputBudgetHttpTest.setUpClass()

    def setUp(self) -> None:
        self.fixture = budget_fixture.AssistantInputBudgetHttpTest()

        def cleanup_fixture() -> None:
            if not self.fixture.doCleanups():
                raise RuntimeError("候选携入 HTTP 夹具清理失败。")

        self.addCleanup(cleanup_fixture)
        self.fixture.setUp()

    def _selected(self, *, history: bool = False) -> tuple[str, str, dict, dict]:
        if history:
            contact_id, target_id, self.raw_source_id = self.fixture.prepare_contact(self.fixture.owner_id)
            status, session = self.fixture.backend.request(
                f"/api/contacts/{contact_id}/assistant-session/default", {},
            )
            self.assertEqual(status, 200, session)
            path = f"/api/contacts/{contact_id}/assistant-sessions/{session['session_id']}"
        else:
            contact_id, path = self.fixture._session(self.fixture.backend)
        status, discussion = self.fixture.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "合成旧讨论目的",
                        "requirements": "合成旧讨论临时要求"},
        })
        self.assertEqual(status, 200, discussion)
        self.fixture.reply_model.plans = [{
            "text": "谢谢邀请。\n\n这次不参加。", "messages": ["谢谢邀请。", "这次不参加。"],
            "basis": "保留合成原句立场。",
        }]
        body = self.fixture._body(contact_id, "谢谢邀请。\n\n这次不参加。")
        if history:
            body["content"] = {"type": "reply_to_message", "target_message_id": target_id,
                               "direction": "谢谢邀请，这次不参加。"}
        body["expected_input_version_id"] = discussion["input_version_id"]
        status, generated = self.fixture.backend.request(path + "/replies", body)
        self.assertEqual(status, 200, generated)
        candidate_id = generated["candidates"][0]["candidate_id"]
        status, versions = self.fixture.backend.request(path + f"/candidates/{candidate_id}/versions")
        self.assertEqual(status, 200, versions)
        original = versions["versions"][0]
        status, selected = self.fixture.backend.request(path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate_id,
            "version_id": original["version_id"],
        })
        self.assertEqual(status, 200, selected)
        return contact_id, path, original, selected

    @staticmethod
    def _carry_body(selected: dict) -> dict:
        return {"expected_selection_id": selected["selection_id"],
                "candidate_id": selected["candidate_id"], "version_id": selected["version_id"]}

    def test_selected_message_group_enters_only_the_new_session_without_a_model_call(self) -> None:
        contact_id, path, original, selected = self._selected()
        before = self.fixture.backend.request(path)[1]
        calls = len(self.fixture.reply_model.seen_model_payloads)

        status, created = self.fixture.backend.request(
            path + "/new-with-candidate", self._carry_body(selected),
        )

        self.assertEqual(status, 200, created)
        self.assertNotEqual(created["session_id"], selected["session_id"])
        new_path = f"/api/contacts/{contact_id}/assistant-sessions/{created['session_id']}"
        status, saved = self.fixture.backend.request(new_path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"], [])
        self.assertEqual(len(saved["inputs"]), 1)
        self.assertEqual(saved["inputs"][0]["type"], "candidate_carry")
        content = saved["inputs"][0]["content"]
        self.assertEqual(content["messages"], original["messages"])
        self.assertNotIn("requirements", content)
        self.assertNotIn("purpose_hint", content)
        self.assertEqual(self.fixture.backend.request(path)[1], before)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)

    def test_parent_session_deletion_erases_consumed_carry_while_raw_and_independent_discussion_remain(self) -> None:
        contact_id, path, _, selected = self._selected(history=True)
        status, created = self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(selected))
        self.assertEqual(status, 200, created)
        child_path = f"/api/contacts/{contact_id}/assistant-sessions/{created['session_id']}"
        body = self.fixture._body(contact_id, "谢谢邀请，这次不参加，祝你们开心。")
        body["expected_input_version_id"] = created["input_version_id"]
        self.fixture._plan("谢谢邀请，这次不参加，祝你们开心。")
        status, generated = self.fixture.backend.request(child_path + "/replies", body)
        self.assertEqual(status, 200, generated)

        status, independent_session = self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(selected))
        self.assertEqual(status, 200, independent_session)
        independent_path = f"/api/contacts/{contact_id}/assistant-sessions/{independent_session['session_id']}"
        marker = "合成独立新讨论：下次希望自己说明时间。"
        status, independent = self.fixture.backend.request(independent_path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": marker},
        })
        self.assertEqual(status, 200, independent)
        calls = len(self.fixture.reply_model.seen_model_payloads)

        status, deleted = self.fixture.backend.request(path, {"confirmed": True}, method="DELETE")

        self.assertEqual(status, 200, deleted)
        self.assertEqual(self.fixture.backend.request(path), (404, {"error": "not_found"}))
        status, child = self.fixture.backend.request(child_path)
        self.assertEqual(status, 200, child)
        self.assertIsNone(child["current_input_version_id"])
        self.assertEqual([item["state"] for item in child["inputs"]], ["redacted", "redacted"])
        self.assertTrue(all(item["content"] is None for item in child["inputs"]))
        self.assertEqual(child["turns"][0]["state"], "redacted")
        self.assertIsNone(child["turns"][0]["input"])
        self.assertIsNone(child["turns"][0]["reply"])
        self.assertEqual(self.fixture.backend.request(child_path + "/replies", body), (
            409, {"error": "assistant_session_rejected", "reason": "source_deleted"},
        ))
        status, kept = self.fixture.backend.request(independent_path)
        self.assertEqual(status, 200, kept)
        self.assertEqual(kept["inputs"][0]["state"], "redacted")
        self.assertIsNone(kept["inputs"][0]["content"])
        self.assertEqual(kept["inputs"][1]["state"], "active")
        self.assertEqual(kept["inputs"][1]["content"]["purpose_hint"], marker)
        self.assertEqual(kept["current_input_version_id"], independent["input_version_id"])
        status, sources = self.fixture.backend.request(f"/api/contacts/{contact_id}/sources")
        self.assertEqual(status, 200, sources)
        self.assertEqual(next(item["status"] for item in sources["sources"]
                              if item["source_id"] == self.raw_source_id), "active")
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)

    def test_blank_new_remains_empty_after_the_old_session_exceeds_its_model_budget(self) -> None:
        limited, _ = self.fixture._budget_backend(self.fixture.owner_id, capacity=101)
        contact_id, path = self.fixture._session(limited)
        body = self.fixture._body(contact_id, "合成超限前仍保留的用户原句。")
        body["content"]["user_instruction"] = "合成临时要求不进入新会话。"
        status, blocked = limited.request(path + "/replies", body)
        self.assertEqual(status, 409, blocked)
        self.assertEqual(blocked["error"], "input_budget_exceeded")
        before = limited.request(path)[1]
        calls = len(self.fixture.reply_model.seen_model_payloads)

        status, created = limited.request(f"/api/contacts/{contact_id}/assistant-sessions", {})

        self.assertEqual(status, 200, created)
        status, saved = limited.request(
            f"/api/contacts/{contact_id}/assistant-sessions/{created['session_id']}",
        )
        self.assertEqual(status, 200, saved)
        self.assertIsNone(saved["current_input_version_id"])
        self.assertEqual(saved["inputs"], [])
        self.assertEqual(saved["turns"], [])
        self.assertEqual(limited.request(path)[1], before)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)

    def test_selected_edited_version_is_immutable_and_only_that_message_group_enters_the_model(self) -> None:
        contact_id, path, original, first_selection = self._selected()
        candidate_id = first_selection["candidate_id"]
        edited_messages = [
            {"message_id": original["messages"][0]["message_id"], "text": "谢谢你想到我。"},
            {"message_id": original["messages"][1]["message_id"], "text": "这次不参加，祝你们玩得开心。"},
        ]
        status, history = self.fixture.backend.request(path + f"/candidates/{candidate_id}/versions", {
            "edit_key": str(uuid4()), "parent_version_id": original["version_id"],
            "messages": edited_messages, "requirements": "合成只属于旧讨论的临时编辑要求",
        })
        self.assertEqual(status, 200, history)
        edited = history["versions"][-1]
        status, chosen = self.fixture.backend.request(path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": edited["version_id"],
        })
        self.assertEqual(status, 200, chosen)
        calls = len(self.fixture.reply_model.seen_model_payloads)
        self.assertEqual(self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(first_selection)), (
            409, {"error": "assistant_session_rejected", "reason": "selection_stale"},
        ))
        status, carried = self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(chosen))
        self.assertEqual(status, 200, carried)
        child_path = f"/api/contacts/{contact_id}/assistant-sessions/{carried['session_id']}"
        before = self.fixture.backend.request(child_path)[1]
        self.assertEqual(before["inputs"][0]["content"]["messages"], edited_messages)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)
        self.assertEqual(self.fixture.backend.request(path + "/selections", {
            "selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": original["version_id"],
        })[0], 200)
        self.assertEqual(self.fixture.backend.request(child_path)[1], before)

        self.fixture._plan("谢谢你想到我，这次不参加。")
        body = self.fixture._body(contact_id, "谢谢你想到我，这次不参加。")
        body["expected_input_version_id"] = carried["input_version_id"]
        status, generated = self.fixture.backend.request(child_path + "/replies", body)
        self.assertEqual(status, 200, generated)
        discussion = self.fixture.reply_model.payloads[-1]["assistant_discussion"]
        self.assertEqual(len(discussion["items"]), 1)
        item = discussion["items"][0]
        self.assertEqual((item["kind"], item["role"], item["version_id"]),
                         ("candidate_carry", "assistant_candidate", edited["version_id"]))
        self.assertEqual(json.loads(item["text"])["messages"], edited_messages)
        self.assertNotIn("合成只属于旧讨论的临时编辑要求", str(discussion))
        self.assertNotIn("合成旧讨论目的", str(discussion))
        self.assertNotIn("合成旧讨论临时要求", str(discussion))
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls + 1)

    def test_missing_selection_foreign_identity_and_injected_text_do_not_create_a_session(self) -> None:
        contact_id, path, _, selected = self._selected()
        catalog = f"/api/contacts/{contact_id}/assistant-sessions"
        status, empty = self.fixture.backend.request(catalog, {})
        self.assertEqual(status, 200, empty)
        empty_path = f"{catalog}/{empty['session_id']}"
        before = self.fixture.backend.request(catalog)
        calls = len(self.fixture.reply_model.seen_model_payloads)
        self.assertEqual(self.fixture.backend.request(empty_path + "/new-with-candidate", self._carry_body(selected)),
                         (409, {"error": "assistant_session_rejected", "reason": "candidate_not_selected"}))
        other_contact, _ = self.fixture._session(self.fixture.backend)
        foreign_path = path.replace(contact_id, other_contact)
        unknown_session = path.rsplit("/", 1)[0] + "/" + str(uuid4())
        for target in (foreign_path, unknown_session):
            with self.subTest(target=target):
                self.assertEqual(self.fixture.backend.request(target + "/new-with-candidate", self._carry_body(selected)),
                                 (404, {"error": "not_found"}))
        foreign_owner = self.fixture._budget_backend(self.fixture.other_owner_id)[0]
        self.assertEqual(foreign_owner.request(path + "/new-with-candidate", self._carry_body(selected)),
                         (404, {"error": "not_found"}))
        for body in ({**self._carry_body(selected), "candidate_id": str(uuid4())},
                     {**self._carry_body(selected), "version_id": str(uuid4())}):
            with self.subTest(body=body):
                self.assertEqual(self.fixture.backend.request(path + "/new-with-candidate", body),
                                 (409, {"error": "assistant_session_rejected", "reason": "selection_stale"}))
        for field in ("messages", "requirements", "user_instruction"):
            with self.subTest(field=field):
                self.assertEqual(self.fixture.backend.request(path + "/new-with-candidate", {
                    **self._carry_body(selected), field: "合成不可信临时正文",
                }), (400, {"error": "assistant_session_request_invalid"}))
        self.assertEqual(self.fixture.backend.request(catalog), before)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)

    def test_source_deletion_requested_refuses_new_carry_and_deletes_old_carry_without_current_guard(self) -> None:
        contact_id, path, _, selected = self._selected(history=True)
        status, carried = self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(selected))
        self.assertEqual(status, 200, carried)
        child_path = f"/api/contacts/{contact_id}/assistant-sessions/{carried['session_id']}"
        self.assertEqual(self.fixture.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "合成之后另有独立要求"},
        })[0], 200)
        with psycopg.connect(self.fixture.database_url) as connection:
            connection.execute("UPDATE public.source_document SET status='delete_requested' WHERE owner_id=%s AND id=%s",
                               (self.fixture.owner_id, self.raw_source_id))
        calls = len(self.fixture.reply_model.seen_model_payloads)
        self.assertEqual(self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(selected)),
                         (409, {"error": "assistant_session_rejected", "reason": "source_unavailable"}))
        blocked = self.fixture.backend.request(child_path)[1]
        self.assertEqual(blocked["inputs"][0]["state"], "unavailable")
        self.assertIsNone(blocked["inputs"][0]["content"])
        status, deleted = self.fixture.backend.request(path, {"confirmed": True}, method="DELETE")
        self.assertEqual(status, 200, deleted)
        erased = self.fixture.backend.request(child_path)[1]
        self.assertIsNone(erased["current_input_version_id"])
        self.assertEqual(erased["inputs"][0]["state"], "redacted")
        self.assertIsNone(erased["inputs"][0]["content"])
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)


    def test_corrupted_carry_origin_refuses_delete_and_rolls_back_old_session_invalidation(self) -> None:
        contact_id, path, _, selected = self._selected()
        status, carried = self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(selected))
        self.assertEqual(status, 200, carried)
        old_before = self.fixture.backend.request(path)
        with psycopg.connect(self.fixture.database_url) as connection:
            origin = connection.execute("SELECT content FROM public.assistant_session_input WHERE id=%s",
                                        (carried["input_version_id"],)).fetchone()[0]
            broken = {**origin, "payload_sha256": "f" * 64}
            connection.execute("UPDATE public.assistant_session_input SET content=%s WHERE id=%s",
                               (Jsonb(broken), carried["input_version_id"]))
        calls = len(self.fixture.reply_model.seen_model_payloads)
        self.assertEqual(self.fixture.backend.request(path, {"confirmed": True}, method="DELETE"),
                         (503, {"error": "assistant_session_save_failed"}))
        self.assertEqual(self.fixture.backend.request(path), old_before)
        with psycopg.connect(self.fixture.database_url) as connection:
            connection.execute("UPDATE public.assistant_session_input SET content=%s WHERE id=%s",
                               (Jsonb(origin), carried["input_version_id"]))
        self.assertEqual(self.fixture.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)

    def test_carry_write_failure_rolls_back_new_session_and_default_then_explicit_retry_succeeds(self) -> None:
        contact_id, path, _, selected = self._selected()
        catalog = f"/api/contacts/{contact_id}/assistant-sessions"
        before = self.fixture.backend.request(catalog)
        old = self.fixture.backend.request(path)
        calls = len(self.fixture.reply_model.seen_model_payloads)
        name = f"synthetic_carry_write_failure_{uuid4().hex}"
        with psycopg.connect(self.fixture.database_url) as connection:
            connection.execute(sql.SQL("CREATE FUNCTION public.{}() RETURNS trigger LANGUAGE plpgsql AS "
                                       "'BEGIN RAISE EXCEPTION ''synthetic_carry_private_fault''; END;'")
                               .format(sql.Identifier(name)))
            connection.execute(sql.SQL("CREATE TRIGGER {} BEFORE INSERT ON public.assistant_session_input "
                                       "FOR EACH ROW WHEN (NEW.owner_id={}::uuid AND NEW.input_type='candidate_carry') "
                                       "EXECUTE FUNCTION public.{}()")
                               .format(sql.Identifier(name), sql.Literal(str(self.fixture.owner_id)), sql.Identifier(name)))
        try:
            self.assertEqual(self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(selected)),
                             (503, {"error": "assistant_session_save_failed"}))
            self.assertEqual(self.fixture.backend.request(catalog), before)
            self.assertEqual(self.fixture.backend.request(path), old)
            self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)
        finally:
            with psycopg.connect(self.fixture.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON public.assistant_session_input").format(sql.Identifier(name)))
                connection.execute(sql.SQL("DROP FUNCTION public.{}()").format(sql.Identifier(name)))
        self.assertEqual(self.fixture.backend.request(path + "/new-with-candidate", self._carry_body(selected))[0], 200)
        self.assertEqual(len(self.fixture.reply_model.seen_model_payloads), calls)
