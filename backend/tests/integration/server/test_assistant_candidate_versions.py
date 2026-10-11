"""候选版本通过真实HTTP观察；迁移前置不由本测试补造。"""

from __future__ import annotations

import json
import time
import unittest
from contextlib import contextmanager
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import psycopg
from psycopg import sql
from langchain_core.messages import HumanMessage

from notalone.persistence.locks import release_global_worker_lock, try_acquire_global_worker_lock
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, ScriptedCoreModel, tool_response,
)


class CandidateVersionModel(ScriptedCoreModel):
    """只替换外部模型，候选身份和会话归属仍由生产流程保存。"""

    message_texts: tuple[str, ...] = ("明天见。",)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(message.content) for message in messages
                       if isinstance(message, HumanMessage))
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{
                "text": "\n\n".join(self.message_texts),
                "messages": list(self.message_texts),
                "basis": "保留用户本次草稿原意。",
                "citation_ids": [item["evidence_id"] for item in payload["evidence"]],
                "risk_notes": [],
            }],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class AssistantCandidateVersionsHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = CandidateVersionModel

    @classmethod
    def _drop_database(cls) -> None:
        super()._drop_database()
        remaining = cls.admin.execute(
            "SELECT count(*) FROM pg_database WHERE datname=%s", (cls.database_name,),
        ).fetchone()[0]
        print(f"candidate_http_cleanup: owned database remaining={remaining}", flush=True)
        if remaining:
            raise AssertionError("候选版本HTTP专属测试库未回收。")

    def _contact(self):
        contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,%s)",
                (self.owner_id, contact_id, "合成候选版本联系人"),
            )
        self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=contact_id, channel="wechat",
            account_scope="synthetic-candidate-versions",
            conversation_locator=f"synthetic-{contact_id}",
        )
        return contact_id

    def _generated(self, *, contact_id=None, session_id=None, content=None):
        contact_id = contact_id or self._contact()
        if session_id is None:
            status, session = self.backend.request(
                f"/api/contacts/{contact_id}/assistant-session/default", {}, method="POST",
            )
            self.assertEqual(status, 200, session)
            session_id = session["session_id"]
        session_path = f"/api/contacts/{contact_id}/assistant-sessions/{session_id}"
        status, generated = self.backend.request(session_path + "/replies", {
            "contact_id": str(contact_id), "idempotency_key": str(uuid4()),
            "content": content or {"type": "rewrite_draft", "draft_text": "明天见"},
        })
        self.assertEqual(status, 200, generated)
        return contact_id, session_path, generated

    def _raw_request(self, path, *, body=None, method="GET", authorized=True):
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = f"Bearer {self.backend.token}"
        request = Request(self.backend.base_url + path, data=body, method=method, headers=headers)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read()), response.headers

    def _source_message(self, contact_id):
        source_id, message_id = uuid4(), uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-candidate-source.jsonl',%s,1)",
                (source_id, self.owner_id, contact_id, uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content) "
                "VALUES (%s,%s,%s,'contact','text','合成版本B原始消息')",
                (message_id, self.owner_id, contact_id),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic-1','{}')",
                (message_id, self.owner_id, contact_id, source_id),
            )
        return source_id, message_id

    def _finish_source_delete(self, contact_id, source_id):
        path = f"/api/contacts/{contact_id}/sources/{source_id}"
        self.assertEqual(self.backend.request(path, method="DELETE")[0], 202)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            sources = self._get(self.backend, f"/api/contacts/{contact_id}/sources")["sources"]
            source = next(item for item in sources if item["source_id"] == str(source_id))
            self.assertNotEqual(source["task_status"], "failed", source)
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                return
            time.sleep(.02)
        self.fail("合成版本来源删除未在时限内完成。")

    @contextmanager
    def _reject_insert(self, table, *, edited_only=False):
        """只在自有随机库触发真实写入失败，不替代生产迁移或业务守卫。"""
        name = f"synthetic_candidate_fault_{uuid4().hex}"
        condition = "NEW.owner_id={owner}::uuid"
        if edited_only:
            condition += " AND NEW.version_number>0"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS "
                "'BEGIN RAISE EXCEPTION ''synthetic_candidate_private_database_fault''; END;'"
            ).format(name=sql.Identifier(name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {name} BEFORE INSERT ON public.{table} FOR EACH ROW "
                "WHEN (" + condition + ") EXECUTE FUNCTION public.{name}()"
            ).format(name=sql.Identifier(name), table=sql.Identifier(table),
                     owner=sql.Literal(str(self.owner_id))))
        try:
            yield
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.{table}").format(
                    name=sql.Identifier(name), table=sql.Identifier(table),
                ))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()").format(name=sql.Identifier(name)))

    def test_generated_candidate_has_original_version_without_recording_selection(self):
        contact_id = self._contact()
        base = f"/api/contacts/{contact_id}/assistant-sessions"
        status, session = self.backend.request(
            f"/api/contacts/{contact_id}/assistant-session/default", {}, method="POST",
        )
        self.assertEqual(status, 200, session)
        session_path = f"{base}/{session['session_id']}"
        status, generated = self.backend.request(session_path + "/replies", {
            "contact_id": str(contact_id), "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "明天见"},
        })
        self.assertEqual(status, 200, generated)
        candidate_id = generated["candidates"][0]["candidate_id"]
        self.assertEqual(len(self.reply_model.seen_calls), 1)

        status, history = self.backend.request(
            session_path + f"/candidates/{candidate_id}/versions",
        )
        self.assertEqual(status, 200, history)
        self.assertEqual(history["candidate_id"], candidate_id)
        self.assertEqual(history["candidate_group_id"], generated["reply_request_id"])
        self.assertEqual(history["candidate_number"], 1)
        self.assertEqual(history["default_display_version_id"], candidate_id)
        self.assertIsNone(history["selected_version_id"])
        self.assertEqual(len(history["versions"]), 1)
        original = history["versions"][0]
        self.assertEqual(original["version_id"], candidate_id)
        self.assertEqual(original["version_number"], 0)
        self.assertIsNone(original["parent_version_id"])
        self.assertIsNone(original["requirements"])
        self.assertEqual(original["messages"], [
            {"message_id": candidate_id, "text": "明天见。"},
        ])
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_whole_message_group_edit_saves_parent_requirements_and_reopens_unselected(self):
        self.reply_model.message_texts = ("明天见。", "我带点水果。")
        _, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        path = session_path + f"/candidates/{candidate_id}/versions"
        original_messages = candidate["messages"]
        self.assertEqual([message["text"] for message in original_messages],
                         ["明天见。", "我带点水果。"])
        self.assertEqual(len({message["message_id"] for message in original_messages}), 2)
        edited_messages = [
            {"message_id": original_messages[0]["message_id"], "text": "那就明天见。"},
            {"message_id": original_messages[1]["message_id"], "text": "我带一点水果。"},
        ]
        command = {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": edited_messages, "requirements": "语气自然，不另作承诺。",
        }
        status, history = self.backend.request(path, command)
        self.assertEqual(status, 200, history)
        self.assertEqual(history["candidate_group_id"], generated["reply_request_id"])
        self.assertEqual(history["candidate_number"], 1)
        self.assertIsNone(history["selected_version_id"])
        self.assertEqual(len(history["versions"]), 2)
        original, edited = history["versions"]
        self.assertEqual(original["messages"], original_messages)
        self.assertIsNone(original["requirements"])
        self.assertEqual(edited["version_number"], 1)
        self.assertNotEqual(edited["version_id"], candidate_id)
        self.assertEqual(edited["parent_version_id"], candidate_id)
        self.assertEqual(edited["messages"], edited_messages)
        self.assertEqual(edited["text"], "那就明天见。\n\n我带一点水果。")
        self.assertEqual(edited["requirements"], "语气自然，不另作承诺。")
        self.assertEqual(history["default_display_version_id"], edited["version_id"])
        self.assertEqual(self.backend.request(path, command), (200, history))
        reopened = self._backend(self.owner_id)
        self.assertEqual(reopened.request(path), (200, history))
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_explicit_selection_replay_keeps_current_and_old_version_requires_new_click(self):
        _, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        path = session_path + f"/candidates/{candidate_id}/versions"
        selection_path = session_path + "/selections"
        original_choice = {
            "selection_key": str(uuid4()), "candidate_id": candidate_id,
            "version_id": candidate_id,
        }
        status, original_receipt = self.backend.request(selection_path, original_choice)
        self.assertEqual(status, 200, original_receipt)
        self.assertEqual(set(original_receipt), {
            "selection_id", "selection_number", "session_id", "candidate_id", "version_id",
        })
        self.assertEqual(original_receipt["selection_number"], 1)
        self.assertEqual(original_receipt["candidate_id"], candidate_id)
        self.assertEqual(original_receipt["version_id"], candidate_id)
        edit = {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": [{"message_id": candidate["messages"][0]["message_id"],
                          "text": "那我们明天见。"}],
        }
        status, edited = self.backend.request(path, edit)
        self.assertEqual(status, 200, edited)
        edited_id = edited["versions"][1]["version_id"]
        self.assertEqual(edited["default_display_version_id"], edited_id)
        self.assertEqual(edited["selected_version_id"], candidate_id)
        new_choice = {
            "selection_key": str(uuid4()), "candidate_id": candidate_id,
            "version_id": edited_id,
        }
        status, new_receipt = self.backend.request(selection_path, new_choice)
        self.assertEqual(status, 200, new_receipt)
        self.assertEqual(new_receipt["selection_number"], 2)
        self.assertNotEqual(new_receipt["selection_id"], original_receipt["selection_id"])
        self.assertEqual(self.backend.request(selection_path, original_choice), (200, original_receipt))
        after_replay = self._get(self.backend, path)
        self.assertEqual(after_replay["selected_version_id"], edited_id)
        self.assertEqual(self.backend.request(selection_path, {
            **original_choice, "version_id": edited_id,
        }), (409, {"error": "assistant_candidate_version_conflict", "reason": "selection_key_conflict"}))
        self.assertEqual(self._get(self.backend, path), after_replay)
        status, reselected = self.backend.request(selection_path, {
            **original_choice, "selection_key": str(uuid4()),
        })
        self.assertEqual(status, 200, reselected)
        self.assertEqual(reselected["selection_number"], 3)
        reopened = self._backend(self.owner_id)
        restored = self._get(reopened, path)
        self.assertEqual(restored["default_display_version_id"], edited_id)
        self.assertEqual(restored["selected_version_id"], candidate_id)
        self.assertEqual(len(restored["versions"]), 2)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_current_selection_is_publicly_readable_without_implicit_choice_or_replay_rewind(self):
        _, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        selection_path = session_path + "/selections"
        status, payload, headers = self._raw_request(selection_path)
        self.assertEqual((status, payload), (200, {"selection": None}))
        self.assertEqual(headers["Cache-Control"], "no-store")
        original = {"selection_key": str(uuid4()), "candidate_id": candidate_id,
                    "version_id": candidate_id}
        status, original_receipt = self.backend.request(selection_path, original)
        self.assertEqual(status, 200, original_receipt)
        self.assertEqual(self.backend.request(selection_path), (200, {"selection": original_receipt}))
        status, edited = self.backend.request(session_path + f"/candidates/{candidate_id}/versions", {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": "那明天见。"}],
        })
        self.assertEqual(status, 200, edited)
        selected = {**original, "selection_key": str(uuid4()),
                    "version_id": edited["default_display_version_id"]}
        status, current_receipt = self.backend.request(selection_path, selected)
        self.assertEqual(status, 200, current_receipt)
        self.assertEqual(self.backend.request(selection_path, original), (200, original_receipt))
        reopened = self._backend(self.owner_id)
        self.assertEqual(reopened.request(selection_path), (200, {"selection": current_receipt}))
        self.assertEqual(self._raw_request(selection_path, authorized=False)[:2],
                         (401, {"error": "unauthorized"}))
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_strict_request_shapes_uuid_and_methods_do_not_create_versions_or_choices(self):
        contact_id, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        path = session_path + f"/candidates/{candidate_id}/versions"
        original = self._get(self.backend, path)
        edit = {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": "明天见。"}],
        }
        bad_edits = [
            {}, [], {**edit, "owner_id": str(self.owner_id)},
            {**edit, "candidate_id": candidate_id}, {**edit, "edit_key": 1},
            {**edit, "edit_key": "不是UUID"}, {**edit, "parent_version_id": None},
            {**edit, "messages": []}, {**edit, "messages": {}},
            {**edit, "messages": [{"message_id": 1, "text": "明天见。"}]},
            {**edit, "messages": [{"message_id": "不是UUID", "text": "明天见。"}]},
            {**edit, "messages": [{"message_id": candidate_id, "text": True}]},
            {**edit, "messages": [{"message_id": candidate_id, "text": " "}]},
            {**edit, "messages": [{"message_id": candidate_id, "text": "明天见。", "ordinal": 0}]},
            {**edit, "requirements": 1}, {**edit, "requirements": " "},
            {**edit, "requirements": "合" * 4097},
        ]
        invalid = (400, {"error": "assistant_candidate_version_request_invalid"})
        for body in bad_edits:
            with self.subTest(body_type=type(body).__name__):
                self.assertEqual(self.backend.request(path, body, method="POST"), invalid)
        choice = {"selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": candidate_id}
        for body in ({}, [], {**choice, "owner_id": str(self.owner_id)},
                     {**choice, "version_id": "不是UUID"}, {**choice, "selection_key": False}):
            self.assertEqual(self.backend.request(session_path + "/selections", body, method="POST"), invalid)
        for identifier in (str(contact_id), session_path.split("/")[-1], candidate_id):
            self.assertEqual(self.backend.request(path.replace(identifier, "invalid-uuid")), invalid)
        for body in (b"{", b"\xff", b"null"):
            status, payload, headers = self._raw_request(path, body=body, method="POST")
            self.assertEqual((status, payload), invalid)
            self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.backend.request(path, method="DELETE"),
                         (405, {"error": "method_not_allowed"}))
        self.assertEqual(self.backend.request(session_path + "/selections", method="DELETE"),
                         (405, {"error": "method_not_allowed"}))
        for identifier in (str(contact_id), session_path.split("/")[-1]):
            self.assertEqual(self.backend.request(
                (session_path + "/selections").replace(identifier, "invalid-uuid")), invalid)
        status, payload, headers = self._raw_request(path)
        self.assertEqual((status, payload), (200, original))
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self._raw_request(path, authorized=False)[:2],
                         (401, {"error": "unauthorized"}))
        self.assertEqual(self._get(self.backend, path), original)
        self.assertIsNone(original["selected_version_id"])
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_scope_parent_group_and_selection_key_conflicts_keep_existing_history(self):
        contact_id, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        _, _, second = self._generated(contact_id=contact_id)
        second_id = second["candidates"][0]["candidate_id"]
        path = session_path + f"/candidates/{candidate_id}/versions"
        self._get(self.backend, session_path + f"/candidates/{second_id}/versions")
        edit = {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": "明天再见。"}],
            "requirements": None,
        }
        self.assertEqual(self.backend.request(path, edit)[0], 200)
        choice = {"selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": candidate_id}
        self.assertEqual(self.backend.request(session_path + "/selections", choice)[0], 200)
        before = self._get(self.backend, path)
        other_contact = self._contact()
        other_session = uuid4()
        # 仅安排另一个真实会话范围；此测试不消费第10票新开能力。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.assistant_session(id,owner_id,contact_id,is_default) VALUES (%s,%s,%s,false)",
                (other_session, self.owner_id, contact_id),
            )
        foreign_paths = [
            path.replace(str(contact_id), str(other_contact)),
            path.replace(session_path.split("/")[-1], str(other_session)),
        ]
        not_found = (404, {"error": "not_found"})
        for foreign_path in foreign_paths:
            self.assertEqual(self.backend.request(foreign_path), not_found)
            self.assertEqual(self.backend.request(foreign_path, {**edit, "edit_key": str(uuid4())}), not_found)
            foreign_session_path = foreign_path.split("/candidates/")[0]
            expected_selection = ((200, {"selection": None})
                                  if str(other_session) in foreign_session_path else not_found)
            self.assertEqual(self.backend.request(foreign_session_path + "/selections"), expected_selection)
            self.assertEqual(self.backend.request(foreign_session_path + "/selections", choice), not_found)
        self.assertEqual(self.other_backend.request(path), not_found)
        self.assertEqual(self.other_backend.request(path, edit), not_found)
        self.assertEqual(self.other_backend.request(session_path + "/selections", choice), not_found)
        self.assertEqual(self.other_backend.request(session_path + "/selections"), not_found)
        self.assertEqual(self.backend.request(path, {
            **edit, "edit_key": str(uuid4()), "parent_version_id": second_id,
        }), not_found)
        self.assertEqual(self.backend.request(session_path + "/selections", {
            **choice, "selection_key": str(uuid4()), "version_id": second_id,
        }), not_found)
        self.assertEqual(self.backend.request(path, {
            **edit, "edit_key": str(uuid4()), "messages": [{"message_id": second_id, "text": "明天再见。"}],
        }), (409, {"error": "assistant_candidate_version_conflict", "reason": "message_group_mismatch"}))
        self.assertEqual(self.backend.request(path, {
            **edit, "requirements": "使用不同的本次要求。",
        }), (409, {"error": "assistant_candidate_version_conflict", "reason": "edit_key_conflict"}))
        self.assertEqual(self.backend.request(session_path + "/selections", {
            **choice, "candidate_id": second_id, "version_id": second_id,
        }), (409, {"error": "assistant_candidate_version_conflict", "reason": "selection_key_conflict"}))
        self.assertEqual(self._get(self.backend, path), before)
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_source_pending_and_deletion_erase_current_without_reviving_old_selection(self):
        contact_id, session_path, first = self._generated()
        first_id = first["candidates"][0]["candidate_id"]
        first_path = session_path + f"/candidates/{first_id}/versions"
        selection_path = session_path + "/selections"
        first_choice = {"selection_key": str(uuid4()), "candidate_id": first_id, "version_id": first_id}
        status, first_receipt = self.backend.request(selection_path, first_choice)
        self.assertEqual(status, 200, first_receipt)
        source_id, message_id = self._source_message(contact_id)
        self.reply_model.message_texts = ("来自待删来源的候选。",)
        _, _, second = self._generated(contact_id=contact_id, content={
            "type": "reply_to_message", "target_message_id": str(message_id),
            "direction": "按本次合成消息自然回应。",
        })
        second_candidate = second["candidates"][0]
        second_id = second_candidate["candidate_id"]
        second_path = session_path + f"/candidates/{second_id}/versions"
        edit = {
            "edit_key": str(uuid4()), "parent_version_id": second_id,
            "messages": [{"message_id": second_candidate["messages"][0]["message_id"],
                          "text": "本次B编辑文字。"}],
            "requirements": "本次B修改要求。",
        }
        status, edited = self.backend.request(second_path, edit)
        self.assertEqual(status, 200, edited)
        second_choice = {
            "selection_key": str(uuid4()), "candidate_id": second_id,
            "version_id": edited["versions"][1]["version_id"],
        }
        self.assertEqual(self.backend.request(selection_path, second_choice)[0], 200)
        self.assertIsNone(self._get(self.backend, first_path)["selected_version_id"])
        with psycopg.connect(self.database_url, autocommit=True) as gate:
            self.assertTrue(try_acquire_global_worker_lock(gate))
            try:
                self.assertEqual(self.backend.request(
                    f"/api/contacts/{contact_id}/sources/{source_id}", method="DELETE",
                )[0], 202)
                conflict = (409, {"error": "assistant_candidate_version_conflict", "reason": "source_unavailable"})
                self.assertEqual(self.backend.request(second_path), conflict)
                self.assertEqual(self.backend.request(second_path, edit), conflict)
                self.assertEqual(self.backend.request(selection_path), conflict)
                self.assertEqual(self.backend.request(selection_path, second_choice), conflict)
                self.assertEqual(self.backend.request(selection_path, {
                    **second_choice, "selection_key": str(uuid4()),
                }), conflict)
            finally:
                release_global_worker_lock(gate)
        self._finish_source_delete(contact_id, source_id)
        not_found = (404, {"error": "not_found"})
        self.assertEqual(self.backend.request(second_path), not_found)
        self.assertEqual(self.backend.request(second_path, edit), not_found)
        self.assertEqual(self.backend.request(selection_path, second_choice), not_found)
        reopened = self._backend(self.owner_id)
        self.assertEqual(reopened.request(second_path), not_found)
        self.assertEqual(reopened.request(selection_path), (200, {"selection": None}))
        remaining = self._get(reopened, first_path)
        self.assertEqual(remaining["versions"][0]["messages"], first["candidates"][0]["messages"])
        self.assertIsNone(remaining["selected_version_id"])
        self.assertEqual(reopened.request(selection_path, first_choice), (200, first_receipt))
        self.assertEqual(reopened.request(selection_path), (200, {"selection": None}))
        self.assertIsNone(self._get(reopened, first_path)["selected_version_id"])
        self.assertEqual(reopened.request(selection_path, {
            **first_choice, "selection_key": str(uuid4()),
        })[0], 200)
        self.assertEqual(self._get(reopened, first_path)["selected_version_id"], first_id)
        selected = self._get(reopened, selection_path)["selection"]
        self.assertEqual(selected["candidate_id"], first_id)
        self.assertEqual(selected["version_id"], first_id)
        restored_session = json.dumps(self._get(reopened, session_path), ensure_ascii=False)
        for text in ("来自待删来源的候选。", "本次B编辑文字。", "本次B修改要求。", "合成版本B原始消息"):
            self.assertNotIn(text, restored_session)
        self.assertEqual(self.backend.request(session_path, {"confirmed": True}, method="DELETE")[0], 200)
        self.assertEqual(reopened.request(selection_path), not_found)
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_storage_faults_are_sanitized_and_roll_back_version_and_current_choice(self):
        _, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        path = session_path + f"/candidates/{candidate_id}/versions"
        selection_path = session_path + "/selections"
        original = self._get(self.backend, path)
        failure = (503, {"error": "assistant_candidate_version_save_failed"})
        with self._reject_insert("assistant_candidate_version"):
            status, payload, headers = self._raw_request(path)
            self.assertEqual((status, payload), failure)
            self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self._get(self.backend, path), original)
        edit = {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": "合成保存故障后的文字。"}],
            "requirements": "合成保存故障要求。",
        }
        with self._reject_insert("assistant_candidate_version", edited_only=True):
            self.assertEqual(self.backend.request(path, edit), failure)
            self.assertEqual(self._get(self.backend, path), original)
        status, edited = self.backend.request(path, edit)
        self.assertEqual(status, 200, edited)
        self.assertEqual(len(edited["versions"]), 2)
        edited_id = edited["versions"][1]["version_id"]
        first_choice = {"selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": candidate_id}
        status, first_receipt = self.backend.request(selection_path, first_choice)
        self.assertEqual(status, 200, first_receipt)
        before_selection_fault = self._get(self.backend, path)
        new_choice = {"selection_key": str(uuid4()), "candidate_id": candidate_id, "version_id": edited_id}
        with self._reject_insert("assistant_candidate_selection"):
            self.assertEqual(self.backend.request(selection_path, new_choice), failure)
            self.assertEqual(self._get(self.backend, path), before_selection_fault)
            self.assertEqual(self.backend.request(selection_path, first_choice), (200, first_receipt))
        status, saved = self.backend.request(selection_path, new_choice)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["selection_number"], 2)
        restored = self._get(self._backend(self.owner_id), path)
        self.assertEqual(restored["selected_version_id"], edited_id)
        self.assertEqual(restored["default_display_version_id"], edited_id)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_non_completed_turn_and_invalidated_request_reject_read_edit_and_selection_replay(self):
        _, session_path, generated = self._generated()
        candidate = generated["candidates"][0]
        candidate_id = candidate["candidate_id"]
        path = session_path + f"/candidates/{candidate_id}/versions"
        edit = {
            "edit_key": str(uuid4()), "parent_version_id": candidate_id,
            "messages": [{"message_id": candidate["messages"][0]["message_id"], "text": "合成失效版本文字。"}],
            "requirements": "合成失效版本要求。",
        }
        status, history = self.backend.request(path, edit)
        self.assertEqual(status, 200, history)
        choice = {
            "selection_key": str(uuid4()), "candidate_id": candidate_id,
            "version_id": history["versions"][1]["version_id"],
        }
        self.assertEqual(self.backend.request(session_path + "/selections", choice)[0], 200)
        # 安排持久记录失效，HTTP仍复用生产adapter的A turn与旧request检查。
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "UPDATE public.assistant_session_turn SET state='failed' WHERE owner_id=%s AND id=%s",
                (self.owner_id, history["turn_id"]),
            )
        for reason in ("candidate_unavailable", "request_invalidated"):
            rejected = (409, {"error": "assistant_candidate_version_conflict", "reason": reason})
            self.assertEqual(self.backend.request(path), rejected)
            self.assertEqual(self.backend.request(path, edit), rejected)
            self.assertEqual(self.backend.request(session_path + "/selections"), rejected)
            self.assertEqual(self.backend.request(session_path + "/selections", choice), rejected)
            if reason == "candidate_unavailable":
                with psycopg.connect(self.database_url) as connection:
                    connection.execute(
                        "UPDATE public.assistant_session_turn SET state='completed' WHERE owner_id=%s AND id=%s",
                        (self.owner_id, history["turn_id"]),
                    )
                    connection.execute(
                        "INSERT INTO public.reply_invalidated_key(owner_id,contact_id,idempotency_key) "
                        "SELECT owner_id,contact_id,idempotency_key FROM public.reply_request WHERE owner_id=%s AND id=%s",
                        (self.owner_id, generated["reply_request_id"]),
                    )
        self.assertEqual(len(self.reply_model.seen_calls), 1)


if __name__ == "__main__":
    unittest.main()
