"""持续要求经过公开HTTP、正式迁移和合成模型的真实业务路径。"""

from __future__ import annotations

import json
import subprocess
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from langchain_core.messages import HumanMessage

from notalone.application.model_priority import ModelPriorityControl
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.input_budget_support import synthetic_budget_kwargs

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, HttpBackend, ScriptedCoreModel, tool_response,
)


class ContinuationModel(ScriptedCoreModel):
    """只替代外部模型，身份、版本、历史和来源仍使用生产组件。"""

    candidate_groups: list[list[str]] = [
        ["第一种合成说法。"], ["第二种合成说法。"], ["第三种合成说法。"],
    ]
    response_entered: Any = None

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.response_entered is not None:
            self.response_entered.set()
        payload = next(json.loads(message.content) for message in messages
                       if isinstance(message, HumanMessage))
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{
                "text": "\n\n".join(group), "messages": group, "basis": "依据本次明确输入。",
                "citation_ids": [item["evidence_id"] for item in payload["evidence"]],
                "risk_notes": [],
            } for group in self.candidate_groups],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


class AssistantContinuationHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    production_model_wiring = True
    reply_model_factory = ContinuationModel

    @classmethod
    def _drop_database(cls):
        super()._drop_database()
        remaining = cls.admin.execute(
            "SELECT count(*) FROM pg_database WHERE datname=%s", (cls.database_name,),
        ).fetchone()[0]
        print(f"continuation_http_cleanup: owned database remaining={remaining}", flush=True)
        if remaining:
            raise AssertionError("持续要求测试库未回收。")

    def _generated(self, *, content=None, with_source=False, with_sample=False):
        contact_id = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.contact(owner_id,id,display_name) VALUES (%s,%s,'合成持续要求联系人')",
                (self.owner_id, contact_id),
            )
            if with_source:
                self.source_id, message_id = uuid4(), uuid4()
                connection.execute(
                    "INSERT INTO public.source_document "
                    "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                    "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-continuation.jsonl',%s,1)",
                    (self.source_id, self.owner_id, contact_id, uuid4().hex * 2),
                )
                connection.execute(
                    "INSERT INTO public.message "
                    "(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                    "VALUES (%s,%s,%s,'contact','text','合成邀约：明天一起聊天吗？',now())",
                    (message_id, self.owner_id, contact_id),
                )
                connection.execute(
                    "INSERT INTO public.message_source_ref "
                    "(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                    "VALUES (%s,%s,%s,'source_document',%s,'synthetic:continuation','{}'::jsonb)",
                    (message_id, self.owner_id, contact_id, self.source_id),
                )
                content = {"type": "reply_to_message", "target_message_id": str(message_id),
                           "direction": "拒绝邀约", "user_instruction": "自然一点"}
        self.bindings.create_binding(
            owner_id=self.owner_id, contact_id=contact_id, channel="wechat",
            account_scope="synthetic-continuation", conversation_locator=f"synthetic-{contact_id}",
        )
        if with_sample:
            status, sample = self.backend.request(f"/api/contacts/{contact_id}/style-samples", {
                "idempotency_key": str(uuid4()), "text": "合成手写表达样本：说话自然一点。",
                "origin": {"kind": "manual"},
            })
            self.assertEqual(status, 200, sample)
            self.sample_id = sample["sample"]["sample_id"]
        status, session = self.backend.request(
            f"/api/contacts/{contact_id}/assistant-session/default", {}, method="POST",
        )
        self.assertEqual(status, 200, session)
        path = f"/api/contacts/{contact_id}/assistant-sessions/{session['session_id']}"
        status, generated = self.backend.request(path + "/replies", {
            "contact_id": str(contact_id), "idempotency_key": str(uuid4()),
            "content": content or {"type": "rewrite_draft", "draft_text": "明天再聊。"},
        })
        self.assertEqual(status, 200, generated)
        histories = [self._get(self.backend, path + f"/candidates/{item['candidate_id']}/versions")
                     for item in generated["candidates"]]
        frame = {"session_id": session["session_id"],
                 "candidate_group_id": generated["reply_request_id"],
                 "candidates": [{"number": history["candidate_number"],
                                 "candidate_id": history["candidate_id"],
                                 "version_id": history["default_display_version_id"]}
                                for history in histories]}
        return path, generated, frame

    def _command(self, generated, frame, *, instruction="第二条自然一点", **changes):
        return {"idempotency_key": str(uuid4()),
                "expected_input_version_id": generated["input_version_id"],
                "instruction": instruction, "displayed_group": frame, **changes}

    def _continue_with_default_json_client(self, path, command, *, replacement=None, confirmed_options=None,
                                          observe_lifecycle=False):
        root = Path(__file__).resolve().parents[4]
        fixture = {
            "port": int(self.backend.base_url.rsplit(":", 1)[1]), "token": self.backend.token,
            "contactId": path.split("/")[3], "sessionId": path.split("/")[5], "command": command,
            **({"replacement": replacement} if replacement is not None else {}),
            **({"confirmedOptions": confirmed_options} if confirmed_options is not None else {}),
            "observeLifecycle": observe_lifecycle,
        }
        result = subprocess.run(
            ["node", "tests/fixtures/assistant-continuation-http.mjs"], cwd=root / "desktop",
            input=json.dumps(fixture), text=True, capture_output=True, timeout=35,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def _model_payload(self):
        return next(json.loads(message.content) for message in self.reply_model.seen_calls[-1]
                    if isinstance(message, HumanMessage))

    def _frame(self, path, generated):
        histories = [self._get(self.backend, path + f"/candidates/{item['candidate_id']}/versions")
                     for item in generated["candidates"]]
        return {"session_id": generated["session_id"], "candidate_group_id": generated["reply_request_id"],
                "candidates": [{"number": item["candidate_number"], "candidate_id": item["candidate_id"],
                                "version_id": item["default_display_version_id"]} for item in histories]}

    def _limited_backend(self, capacity=100000):
        decisions = []
        configuration = synthetic_budget_kwargs(self.reply_model, capacity=capacity, output_reserve=100)
        priority = ModelPriorityControl()
        with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=self.reply_model):
            reply = build_reply_service(database_url=self.database_url, owner_id=self.owner_id,
                                        model_priority=priority, on_input_budget=decisions.append,
                                        **configuration)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=self.owner_id,
                                        token=f"synthetic-continuation-budget-{uuid4()}",
                                        reply_service=reply, runtime_shutdown=priority.stop), self.owner_id)
        self.addCleanup(backend.close)
        return backend, decisions, configuration["input_token_counter"]

    @contextmanager
    def _fail_c_request_insert(self, request_key):
        name = f"synthetic_continuation_insert_fault_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION public.{name}() RETURNS trigger LANGUAGE plpgsql AS "
                "'BEGIN RAISE EXCEPTION ''synthetic_continuation_insert_failure''; END;'"
            ).format(name=sql.Identifier(name)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {name} BEFORE INSERT ON public.reply_request "
                "FOR EACH ROW WHEN (NEW.owner_id={owner}::uuid AND NEW.idempotency_key={key}::uuid) "
                "EXECUTE FUNCTION public.{name}()"
            ).format(name=sql.Identifier(name), owner=sql.Literal(str(self.owner_id)),
                     key=sql.Literal(request_key)))
        try:
            yield
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {name} ON public.reply_request")
                                   .format(name=sql.Identifier(name)))
                connection.execute(sql.SQL("DROP FUNCTION public.{name}()")
                                   .format(name=sql.Identifier(name)))

    def test_second_displayed_candidate_continues_its_real_version_and_reopens(self):
        path, generated, frame = self._generated()
        second = generated["candidates"][1]
        command = self._command(generated, frame)
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["candidate_id"], second["candidate_id"])
        self.assertEqual(continued["continuation"]["version_id"], second["candidate_id"])
        self.assertEqual(continued["continuation"]["effective_requirements"], ["自然一点"])
        payload = self._model_payload()
        self.assertEqual(payload["draft_text"], "第二种合成说法。")
        self.assertIn("自然一点", payload["user_instruction"])
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        saved = self._get(self.backend, path)["turns"][-1]
        self.assertEqual(saved["input"]["continuation"], continued["continuation"])
        self.assertEqual(saved["input"]["continued_from_candidate_id"], second["candidate_id"])
        self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_displayed_edited_version_uses_its_complete_message_group(self):
        self.reply_model.candidate_groups[1] = ["原版完整第一段。", "原版完整第二段。"]
        path, generated, frame = self._generated()
        second = generated["candidates"][1]
        versions_path = path + f"/candidates/{second['candidate_id']}/versions"
        original = self._get(self.backend, versions_path)["versions"][0]
        messages = [{"message_id": original["messages"][0]["message_id"],
                     "text": "这是用户明确编辑的第一段。"},
                    {"message_id": original["messages"][1]["message_id"],
                     "text": "这是用户明确编辑的完整第二段。"}]
        status, edited = self.backend.request(versions_path, {
            "edit_key": str(uuid4()), "parent_version_id": original["version_id"],
            "messages": messages, "requirements": "保持两段完整。",
        })
        self.assertEqual(status, 200, edited)
        frame["candidates"][1]["version_id"] = edited["default_display_version_id"]
        command = self._command(generated, frame, requirement_changes=[
            {"action": "keep", "previous": "保持两段完整。"},
        ])

        status, continued = self.backend.request(path + "/continue", command)

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["version_id"], edited["default_display_version_id"])
        self.assertEqual(self._model_payload()["draft_text"],
                         "这是用户明确编辑的第一段。\n\n这是用户明确编辑的完整第二段。")
        reference = self._model_payload()["continuation_reference"]
        self.assertTrue(reference["is_current_draft"])
        self.assertEqual(reference["version_id"], edited["default_display_version_id"])
        saved = self._get(self.backend, path)["turns"][-1]
        self.assertEqual(saved["input"]["continuation"], continued["continuation"])
        self.assertEqual(saved["input"]["continued_from_candidate_id"], second["candidate_id"])
        self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def _display_edited_second(self, requirements):
        path, generated, frame = self._generated()
        candidate = generated["candidates"][1]
        versions_path = path + f"/candidates/{candidate['candidate_id']}/versions"
        original = self._get(self.backend, versions_path)["versions"][0]
        status, edited = self.backend.request(versions_path, {
            "edit_key": str(uuid4()), "parent_version_id": original["version_id"],
            "messages": original["messages"], "requirements": requirements,
        })
        self.assertEqual(status, 200, edited)
        frame["candidates"][1]["version_id"] = edited["default_display_version_id"]
        return path, generated, frame

    def test_selected_edited_version_preserves_compatible_requirements_in_actual_input(self):
        path, generated, frame = self._display_edited_second("不要承诺")
        command = self._command(generated, frame)

        status, continued = self.backend.request(path + "/continue", command)

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["不要承诺", "自然一点"])
        self.assertEqual(self._model_payload()["user_instruction"], "不要承诺；自然一点")
        self.assertEqual(continued["continuation"]["version_id"], frame["candidates"][1]["version_id"])
        saved = self._get(self.backend, path)["turns"][-1]
        self.assertEqual(saved["input"]["continuation"], continued["continuation"])
        self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_selected_edited_version_conflict_clarifies_before_reserve_and_model(self):
        path, generated, frame = self._display_edited_second("正式一点")
        command = self._command(generated, frame)
        before = self._get(self.backend, path)

        status, clarified = self.backend.request(path + "/continue", command)

        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
        self.assertEqual(self._get(self.backend, path), before)
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        command["requirement_changes"] = [{"action": "replace", "previous": "正式一点", "replacement": "自然一点"}]
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["自然一点"])
        self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_continuation_prepare_reuses_actual_identity_and_canonical_command(self):
        path, generated, frame = self._generated()
        command = self._command(generated, frame)

        status, prepared = self.backend.request(path + "/continue/prepare", command)

        self.assertEqual(status, 200, prepared)
        self.assertEqual(set(prepared), {"session_id", "turn_id", "request_key", "input_version_id", "state"})
        self.assertEqual(prepared["state"], "running")
        self.assertEqual(prepared["request_key"], command["idempotency_key"])
        self.assertEqual(self.backend.request(path + "/continue/prepare", command), (200, prepared))
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["turn_id"], prepared["turn_id"])
        self.assertEqual(continued["input_version_id"], prepared["input_version_id"])
        self.assertEqual(continued["continuation"]["submission"], command)
        self.assertEqual(self.backend.request(path + "/continue/prepare", command),
                         (200, {**prepared, "state": "completed"}))
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        changed = {**command, "instruction": "第二条简短一点"}
        self.assertEqual(self.backend.request(path + "/continue/prepare", changed),
                         (409, {"error": "assistant_session_input_conflict"}))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_default_client_prepares_identity_before_execution_and_freezes_requirements(self):
        path, generated, frame = self._display_edited_second("正式一点")
        command = self._command(generated, frame, requirement_changes=[
            {"action": "replace", "previous": "正式一点", "replacement": "自然一点"},
        ])

        observed = self._continue_with_default_json_client(path, command, observe_lifecycle=True)

        self.assertTrue(observed["ok"], observed)
        self.assertEqual(observed["requests"], 2)
        self.assertEqual(observed["lifecycle"]["events"], ["prepared", "requested"])
        self.assertEqual(len(observed["lifecycle"]["receipts"]), 1)
        self.assertTrue(observed["lifecycle"]["sameBody"])
        receipt = observed["lifecycle"]["receipts"][0]
        result = observed["result"]
        self.assertEqual(receipt["sessionId"], result["assistantSessionId"])
        self.assertEqual(receipt["inputVersionId"], result["inputVersionId"])
        self.assertEqual(receipt["requestKey"], command["idempotency_key"])
        saved = self._get(self.backend, path)["turns"][-1]
        self.assertEqual(receipt["turnId"], saved["turn_id"])
        self.assertEqual(saved["input"]["continuation"]["effective_requirements"], ["自然一点"])
        self.assertEqual(self._model_payload()["user_instruction"], "自然一点")
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_continuation_prepare_clarifies_without_claiming_or_model(self):
        path, generated, frame = self._display_edited_second("正式一点")
        command = self._command(generated, frame)
        before = self._get(self.backend, path)

        status, clarified = self.backend.request(path + "/continue/prepare", command)

        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
        self.assertEqual(self._get(self.backend, path), before)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_continuation_prepared_then_new_current_does_not_execute_or_rewind(self):
        path, generated, frame = self._generated()
        original_reply = self._get(self.backend, path)["turns"][0]["reply"]
        command = self._command(generated, frame)
        status, prepared = self.backend.request(path + "/continue/prepare", command)
        self.assertEqual(status, 200, prepared)
        status, newest = self.backend.request(path + "/inputs", {
            "expected_input_version_id": prepared["input_version_id"],
            "content": {"type": "purpose_exploration", "purpose_hint": "准备后明确修改的合成讨论。"},
        })
        self.assertEqual(status, 200, newest)

        status, rejected = self.backend.request(path + "/continue", command)

        self.assertNotEqual(status, 200, rejected)
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        saved = self._get(self.backend, path)
        self.assertEqual(saved["current_input_version_id"], newest["input_version_id"])
        self.assertIsNone(saved["turns"][-1]["reply"])
        self.assertEqual(saved["turns"][0]["reply"], original_reply)

    def test_continuation_prepared_quit_and_delete_reject_old_execution(self):
        for removal in ("quit", "session"):
            with self.subTest(removal=removal):
                path, generated, frame = self._generated()
                command = self._command(generated, frame)
                status, prepared = self.backend.request(path + "/continue/prepare", command)
                self.assertEqual(status, 200, prepared)
                before = len(self.reply_model.seen_calls)
                if removal == "quit":
                    status, stopped = self.backend.request(path + "/interrupt", {
                        "request_key": prepared["request_key"], "input_version_id": prepared["input_version_id"],
                    })
                    self.assertEqual(status, 200, stopped)
                    self.assertEqual(stopped["state"], "failed")
                    self.assertEqual(stopped["interruption_reason"], "app_quit")
                else:
                    self.assertEqual(self.backend.request(path, {"confirmed": True}, method="DELETE")[0], 200)
                for operation in ("continue", "continue/prepare"):
                    self.assertNotEqual(self.backend.request(path + "/" + operation, command)[0], 200)
                self.assertEqual(len(self.reply_model.seen_calls), before)
                if removal == "quit":
                    saved = self._get(self._backend(self.owner_id), path)
                    self.assertEqual(saved["turns"][-1]["interruption_reason"], "app_quit")
                    self.assertIsNone(saved["turns"][-1]["reply"])
                    self.assertEqual(saved["turns"][0]["state"], "completed")
                else:
                    self.assertEqual(self.backend.request(path), (404, {"error": "not_found"}))

    def test_ambiguous_or_missing_number_clarifies_before_new_input_or_model(self):
        path, generated, frame = self._generated()
        for instruction, reason in (
            ("第二条和第三条自然一点", "candidate_reference_ambiguous"),
            ("之前第二条自然一点", "candidate_reference_ambiguous"),
            ("第两条自然一点", "candidate_number_unclear"),
            ("第四条自然一点", "candidate_number_missing"),
        ):
            with self.subTest(reason=reason):
                status, clarified = self.backend.request(path + "/continue", self._command(
                    generated, frame, instruction=instruction,
                ))
                self.assertEqual(status, 409, clarified)
                self.assertEqual(clarified["clarification"]["reason"], reason)
                saved = self._get(self.backend, path)
                self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
                self.assertEqual(len(saved["turns"]), 1)
                self.assertEqual(len(self.reply_model.seen_calls), 1)

    def test_another_displayed_session_and_owner_cannot_supply_candidates(self):
        path, generated, frame = self._generated()
        other_path, _, other_frame = self._generated()
        status, clarified = self.backend.request(path + "/continue", self._command(generated, other_frame))
        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "candidate_session_mismatch")
        self.assertEqual(self.other_backend.request(path + "/continue", self._command(generated, frame)),
                         (404, {"error": "not_found"}))
        status, rejected = self.backend.request(other_path + "/continue", self._command(generated, frame))
        self.assertEqual(status, 409, rejected)
        self.assertEqual(len(self.reply_model.seen_calls), 2)
        self.assertEqual(len(self._get(self.backend, path)["turns"]), 1)
        self.assertEqual(len(self._get(self.backend, other_path)["turns"]), 1)

    def test_same_key_metadata_changes_and_plain_reply_cannot_downgrade_continuation(self):
        path, generated, frame = self._generated()
        command = self._command(generated, frame)
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        changed = {**command, "instruction": "第二条简短一点"}
        status, rejected = self.backend.request(path + "/continue", changed)
        self.assertEqual(status, 409, rejected)
        self.assertEqual(rejected["error"], "assistant_session_input_conflict")
        contact_id = path.split("/")[3]
        plain = {"contact_id": contact_id, "idempotency_key": command["idempotency_key"],
                 "content": continued["effective_input"],
                 "continued_from_candidate_id": continued["continuation"]["candidate_id"]}
        for ordinary_path in (path + "/replies", "/api/reply/generate"):
            with self.subTest(path=ordinary_path):
                status, rejected = self.backend.request(ordinary_path, plain)
                self.assertNotEqual(status, 200, rejected)
                self.assertEqual(len(self.reply_model.seen_calls), 2)
        self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
        self.assertEqual(len(self._get(self.backend, path)["turns"]), 2)
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_latest_explicit_intention_overrides_candidate_and_keeps_compatible_requirements(self):
        path, generated, frame = self._generated(content={
            "type": "initiate_conversation", "purpose": "拒绝邀约",
            "user_instruction": "自然一点；别太主动",
        })
        command = self._command(generated, frame, intention_update="答应邀约")

        status, continued = self.backend.request(path + "/continue", command)

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["effective_input"]["purpose"], "答应邀约")
        self.assertEqual(continued["continuation"]["effective_requirements"], ["自然一点", "别太主动"])
        payload = self._model_payload()
        self.assertEqual(payload["confirmed_purpose"], "答应邀约")
        self.assertNotIn("draft_text", payload)
        self.assertFalse(payload["continuation_reference"]["is_current_draft"])
        self.assertEqual(payload["continuation_reference"]["weight"], "low")
        self.assertEqual(continued["continuation"]["scope"], "this_assistant_session_only")
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_conflicting_explicit_intentions_clarify_before_input_or_model_changes(self):
        path, generated, frame = self._generated(content={
            "type": "initiate_conversation", "purpose": "拒绝邀约", "user_instruction": "自然一点",
        })
        command = self._command(generated, frame, instruction="还是拒绝", intention_update="答应")
        saved_before = self._get(self.backend, path)
        before_calls = len(self.reply_model.seen_calls)
        with psycopg.connect(self.database_url) as connection:
            before_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]

        status, clarified = self.backend.request(path + "/continue", command)

        saved = self._get(self.backend, path)
        with psycopg.connect(self.database_url) as connection:
            after_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]
        print(f"explicit_intention_conflict: status={status} "
              f"model_delta={len(self.reply_model.seen_calls) - before_calls} "
              f"request_delta={after_requests - before_requests} "
              f"current_unchanged={saved['current_input_version_id'] == saved_before['current_input_version_id']} "
              f"turns_unchanged={saved['turns'] == saved_before['turns']}", flush=True)
        self.assertEqual(status, 409)
        self.assertEqual(clarified, {
            "error": "assistant_continuation_clarification_required", "clarification": {
                "reason": "intention_conflict", "requirements": [],
                "requirement_options": [], "requirement_actions": [],
            },
        })
        self.assertEqual(saved, saved_before)
        self.assertEqual(len(self.reply_model.seen_calls), before_calls)
        self.assertEqual(after_requests, before_requests)

    def test_default_json_client_clarifies_conflicting_intentions_then_user_resolves(self):
        path, generated, frame = self._generated(content={
            "type": "initiate_conversation", "purpose": "拒绝邀约", "user_instruction": "自然一点",
        })
        command = self._command(generated, frame, instruction="还是拒绝", intention_update="答应")
        saved_before = self._get(self.backend, path)
        before_calls = len(self.reply_model.seen_calls)
        with psycopg.connect(self.database_url) as connection:
            before_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]

        observed = self._continue_with_default_json_client(path, command)

        with psycopg.connect(self.database_url) as connection:
            after_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]
        print(f"intention_conflict_default_client: ok={observed['ok']} "
              f"requests={observed['requests']} model_delta={len(self.reply_model.seen_calls) - before_calls} "
              f"request_delta={after_requests - before_requests}", flush=True)
        self.assertTrue(observed["ok"])
        self.assertEqual(observed["status"], 409)
        self.assertEqual(observed["requests"], 1)
        result = observed["result"]
        self.assertEqual(result["phase"], "clarification")
        self.assertEqual(result["clarification"], {
            "reason": "intention_conflict", "requirements": [],
            "requirement_options": [], "requirement_actions": [],
        })
        self.assertEqual(result["message"], "本次文字要求与明确意愿不一致，请改为同一意愿后重新提交。")
        self.assertEqual(result["requestKey"], command["idempotency_key"])
        self.assertEqual(result["expectedInputVersionId"], generated["input_version_id"])
        self.assertEqual(self._get(self.backend, path), saved_before)
        self.assertEqual(len(self.reply_model.seen_calls), before_calls)
        self.assertEqual(after_requests, before_requests)

        # 澄清不确认或猜测意愿；用户明确把两项改成一致，才使用原未领取请求键。
        corrected = {**command, "intention_update": "拒绝"}
        continued = self._continue_with_default_json_client(path, corrected)
        self.assertTrue(continued["ok"])
        self.assertEqual(continued["status"], 200)
        self.assertEqual(continued["result"]["phase"], "completed")
        self.assertEqual(continued["result"]["effectiveInput"]["purpose"], "拒绝")
        self.assertEqual(continued["result"]["effectiveRequirements"], ["自然一点"])
        self.assertEqual(self._model_payload()["confirmed_purpose"], "拒绝")
        self.assertEqual(self._model_payload()["user_instruction"], "自然一点")
        self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)
        with psycopg.connect(self.database_url) as connection:
            resolved_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]
        self.assertEqual(resolved_requests, before_requests + 1)
        reopened = self._backend(self.owner_id)
        saved = self._get(reopened, path)
        self.assertEqual(saved["turns"][0], saved_before["turns"][0])
        self.assertEqual(len(saved["turns"]), 2)
        self.assertEqual(saved["current_input_version_id"], continued["result"]["inputVersionId"])
        self.assertEqual(saved["turns"][-1]["input"]["continuation"]["submission"], corrected)
        self.assertEqual(saved["turns"][-1]["input"]["content"]["purpose"], "拒绝")
        repeated = self._continue_with_default_json_client(path, corrected)
        self.assertEqual(repeated, continued)
        self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)

    def test_matching_explicit_intentions_and_unknown_update_keep_original_semantics(self):
        for instruction, intention in (
            ("还是答应", "答应"), ("还是拒绝", "拒绝"),
            ("改口：同意吧！", "答应"), ("还是不去", "拒绝"),
            ("还是拒绝", "合成新意愿"),
        ):
            with self.subTest(instruction=instruction, intention=intention):
                path, generated, frame = self._generated(content={
                    "type": "initiate_conversation", "purpose": "合成原意愿", "user_instruction": "自然一点",
                })
                command = self._command(generated, frame, instruction=instruction, intention_update=intention)
                saved_before = self._get(self.backend, path)
                before_calls = len(self.reply_model.seen_calls)
                with psycopg.connect(self.database_url) as connection:
                    before_requests = connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
                    ).fetchone()[0]

                status, continued = self.backend.request(path + "/continue", command)

                self.assertEqual(status, 200, continued)
                self.assertEqual(continued["effective_input"]["purpose"], intention)
                self.assertEqual(continued["continuation"]["effective_requirements"], ["自然一点"])
                self.assertEqual(self._model_payload()["confirmed_purpose"], intention)
                self.assertEqual(self._model_payload()["user_instruction"], "自然一点")
                saved = self._get(self.backend, path)
                self.assertEqual(saved["turns"][0], saved_before["turns"][0])
                self.assertEqual(len(saved["turns"]), 2)
                self.assertEqual(saved["current_input_version_id"], continued["input_version_id"])
                self.assertEqual(saved["turns"][-1]["input"]["continuation"]["submission"], command)
                self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)
                with psycopg.connect(self.database_url) as connection:
                    after_requests = connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
                    ).fetchone()[0]
                self.assertEqual(after_requests, before_requests + 1)
                self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
                self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)

    def test_changed_intention_clarifies_unknown_requirement_then_explicit_remove(self):
        reason = "以身体不舒服为由拒绝"
        path, generated, frame = self._generated(content={
            "type": "initiate_conversation", "purpose": "拒绝邀约",
            "user_instruction": f"自然一点；{reason}",
        })
        command = self._command(generated, frame, instruction="还是答应")
        status, clarified = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_need_confirmation")
        self.assertEqual(clarified["clarification"]["requirements"], [reason])
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        self.assertEqual(len(self._get(self.backend, path)["turns"]), 1)

        status, continued = self.backend.request(path + "/continue", {
            **command, "requirement_changes": [{"action": "remove", "previous": reason}],
        })

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["effective_input"]["purpose"], "答应")
        self.assertEqual(continued["continuation"]["effective_requirements"], ["自然一点"])
        self.assertIsNone(continued["continuation"]["candidate_id"])
        self.assertEqual(self._model_payload()["confirmed_purpose"], "答应")
        self.assertEqual(self._model_payload()["user_instruction"], "自然一点")
        self.assertNotIn("continuation_reference", self._model_payload())
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_unknown_compatible_requirement_can_be_explicitly_kept_after_clarification(self):
        requirement = "保留末尾的祝福"
        path, generated, frame = self._generated(content={
            "type": "initiate_conversation", "purpose": "拒绝邀约",
            "user_instruction": f"自然一点；{requirement}",
        })
        command = self._command(generated, frame, instruction="还是答应")
        self.assertEqual(self.backend.request(path + "/continue", command)[0], 409)
        status, continued = self.backend.request(path + "/continue", {
            **command, "requirement_changes": [{"action": "keep", "previous": requirement}],
        })
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["自然一点", requirement])
        self.assertEqual(self._model_payload()["confirmed_purpose"], "答应")
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_conflicting_tone_requires_confirmation_and_explicit_replacement(self):
        path, generated, frame = self._generated(content={
            "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点",
        })
        command = self._command(generated, frame, instruction="第二条正式一点")
        status, clarified = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
        self.assertEqual(clarified["clarification"]["requirements"], ["自然一点"])
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        status, continued = self.backend.request(path + "/continue", {
            **command, "requirement_changes": [{"action": "replace", "previous": "自然一点",
                                               "replacement": "正式一点"}],
        })
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["正式一点"])
        self.assertEqual(self._model_payload()["user_instruction"], "正式一点")
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_source_delete_erases_continuation_and_reopen_cannot_restore_it(self):
        path, generated, frame = self._generated(with_source=True)
        source_id = self.source_id
        command = self._command(generated, frame)
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        unrelated_path, unrelated, _ = self._generated()
        before = len(self.reply_model.seen_calls)
        contact_id = path.split("/")[3]
        status, deletion = self.backend.request(
            f"/api/contacts/{contact_id}/sources/{source_id}", method="DELETE",
        )
        self.assertEqual(status, 202, deletion)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            source = self._get(self.backend, f"/api/contacts/{contact_id}/sources")["sources"][0]
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                break
            self.assertNotEqual(source["task_status"], "failed", source)
            time.sleep(0.02)
        self.assertEqual(source["status"], "deleted", source)
        self.assertEqual(source["task_status"], "succeeded")
        reopened = self._backend(self.owner_id)
        saved = self._get(reopened, path)
        self.assertEqual(len(saved["turns"]), 2)
        for turn in saved["turns"]:
            self.assertEqual(turn["state"], "redacted")
            self.assertIsNone(turn["input"])
            self.assertIsNone(turn["reply"])
        self.assertEqual(self._get(reopened, unrelated_path)["turns"][0]["reply"]["candidates"],
                         unrelated["candidates"])
        self.assertEqual(reopened.request(path + "/continue", command)[0], 409)
        self.assertEqual(len(self.reply_model.seen_calls), before)

    def test_new_current_input_blocks_new_continuation_but_preserves_completed_replay(self):
        path, generated, frame = self._generated()
        command = self._command(generated, frame)
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        status, newest = self.backend.request(path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "用户之后的新讨论"},
            "expected_input_version_id": continued["input_version_id"],
        })
        self.assertEqual(status, 200, newest)
        self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
        status, rejected = self.backend.request(path + "/continue", {
            **command, "idempotency_key": str(uuid4()),
            "expected_input_version_id": continued["input_version_id"],
        })
        self.assertEqual(status, 409, rejected)
        self.assertEqual(self._get(self.backend, path)["current_input_version_id"], newest["input_version_id"])
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_current_input_changed_during_model_prevents_save_and_stale_retry_model(self):
        path, generated, frame = self._generated()
        command = self._command(generated, frame)
        self.reply_model.response_entered = threading.Event()
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/continue", command)
            try:
                self.assertTrue(self.reply_model.response_entered.wait(5))
                status, newest = self.backend.request(path + "/inputs", {
                    "content": {"type": "purpose_exploration", "purpose_hint": "模型等待时的新明确讨论"},
                })
                self.assertEqual(status, 200, newest)
                gate.set()
                status, rejected = running.result(timeout=10)
                self.assertNotEqual(status, 200, rejected)
            finally:
                gate.set()
        saved = self._get(self.backend, path)
        self.assertEqual(saved["current_input_version_id"], newest["input_version_id"])
        self.assertEqual(saved["turns"][-1]["state"], "failed")
        self.assertIsNone(saved["turns"][-1]["reply"])
        before = len(self.reply_model.seen_calls)
        self.assertNotEqual(self.backend.request(path + "/continue", command)[0], 200)
        self.assertEqual(len(self.reply_model.seen_calls), before)

    def test_cumulative_continuation_budget_measures_actual_payload_and_blocks_growth_without_model(self):
        original_draft = "合成完整初始讨论：" + "保留这段已确认的完整原句。" * 30
        self.reply_model.candidate_groups = [[f"合成第{i}种完整说法：" + "逐段保留用户要求。" * 20]
                                             for i in range(1, 4)]
        baseline, _, _ = self._limited_backend()
        self.backend = baseline
        path, first, frame = self._generated(content={"type": "rewrite_draft", "draft_text": original_draft})
        status, baseline_continued = baseline.request(path + "/continue", self._command(first, frame))
        self.assertEqual(status, 200, baseline_continued)
        capacity = baseline_continued["input_budget"]["total_tokens"] + 100

        limited, decisions, counter = self._limited_backend(capacity)
        self.backend = limited
        path, first, frame = self._generated(content={"type": "rewrite_draft", "draft_text": original_draft})
        command = self._command(first, frame)
        status, continued = limited.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["input_budget"]["state"], "warning")
        self.assertEqual(counter.seen_payloads[-1], self.reply_model.seen_model_payloads[-1])
        frame = self._frame(path, continued)
        before = len(self.reply_model.seen_calls)
        status, blocked = limited.request(path + "/continue", self._command(
            continued, frame, instruction="第二条简短一点",
        ))

        self.assertEqual(status, 409, blocked)
        self.assertEqual(blocked["error"], "input_budget_exceeded")
        self.assertEqual(blocked["input_budget"], decisions[-1].to_payload())
        self.assertGreater(decisions[-1].total_tokens, capacity)
        self.assertEqual(len(self.reply_model.seen_calls), before)
        measured = next(json.loads(message["content"]) for message in counter.seen_payloads[-1]["messages"]
                        if message["role"] == "user")
        history_text = json.dumps(measured["assistant_discussion"], ensure_ascii=False)
        self.assertIn(original_draft, history_text)
        self.assertIn("第二条自然一点", history_text)
        self.assertIn(self.reply_model.candidate_groups[2][0], history_text)
        self.assertEqual(measured["user_instruction"], "自然一点；简短一点")
        saved = self._get(limited, path)
        self.assertEqual(len(saved["turns"]), 3)
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], first["candidates"])
        self.assertEqual(saved["turns"][1]["reply"]["candidates"], continued["candidates"])
        self.assertIsNone(saved["turns"][2]["reply"])
        self.assertEqual(saved["turns"][2]["input"]["continuation"]["effective_requirements"],
                         ["自然一点", "简短一点"])
        self.assertEqual(len(self.reply_model.seen_calls), before)

    def test_same_key_cannot_change_only_displayed_version_even_when_text_is_identical(self):
        path, generated, frame = self._generated()
        command = self._command(generated, frame)
        status, continued = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 200, continued)
        second = generated["candidates"][1]
        versions_path = path + f"/candidates/{second['candidate_id']}/versions"
        original = self._get(self.backend, versions_path)["versions"][0]
        status, edited = self.backend.request(versions_path, {
            "edit_key": str(uuid4()), "parent_version_id": original["version_id"],
            "messages": original["messages"], "requirements": "用户明确保存的另一个同正文版本。",
        })
        self.assertEqual(status, 200, edited)
        frame["candidates"][1]["version_id"] = edited["default_display_version_id"]
        changed_version = {**command, "displayed_group": frame}
        self.assertEqual(self.backend.request(path + "/continue", changed_version)[0], 409)
        command["displayed_group"]["candidates"][1]["version_id"] = original["version_id"]
        self.assertEqual(self.backend.request(path + "/continue", command), (200, continued))
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_unrelated_legacy_global_key_keeps_its_normal_input_without_assistant_history(self):
        path, generated, frame = self._generated()
        self.assertEqual(self.backend.request(path + "/continue", self._command(generated, frame))[0], 200)
        body = {"contact_id": path.split("/")[3], "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "独立旧入口的合成原句。"}}
        status, legacy = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, legacy)
        self.assertEqual(self._model_payload()["draft_text"], "独立旧入口的合成原句。")
        self.assertNotIn("assistant_discussion", self._model_payload())
        self.assertNotIn("continuation_reference", self._model_payload())
        self.assertEqual(len(self._get(self.backend, path)["turns"]), 2)
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, legacy))
        self.assertEqual(len(self.reply_model.seen_calls), 3)

    def test_source_deleted_during_continuation_model_cannot_publish_or_retry_candidates(self):
        path, generated, frame = self._generated(with_source=True)
        command = self._command(generated, frame)
        contact_id = path.split("/")[3]
        self.reply_model.response_entered = threading.Event()
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.backend.request, path + "/continue", command)
            try:
                self.assertTrue(self.reply_model.response_entered.wait(5))
                status, deletion = self.backend.request(
                    f"/api/contacts/{contact_id}/sources/{self.source_id}", method="DELETE",
                )
                self.assertEqual(status, 202, deletion)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    source = self._get(self.backend, f"/api/contacts/{contact_id}/sources")["sources"][0]
                    if source["status"] == "deleted" and source["task_status"] == "succeeded":
                        break
                    self.assertNotEqual(source["task_status"], "failed", source)
                    time.sleep(0.02)
                self.assertEqual(source["status"], "deleted", source)
                self.assertEqual(source["task_status"], "succeeded")
                gate.set()
                self.assertNotEqual(running.result(timeout=10)[0], 200)
            finally:
                gate.set()
        saved = self._get(self.backend, path)
        for turn in saved["turns"]:
            self.assertEqual(turn["state"], "redacted")
            self.assertIsNone(turn["input"])
            self.assertIsNone(turn["reply"])
        before = len(self.reply_model.seen_calls)
        self.assertEqual(self.backend.request(path + "/continue", command)[0], 409)
        self.assertEqual(self.backend.request(path + "/continue", {
            **command, "idempotency_key": str(uuid4()),
        })[0], 409)
        self.assertEqual(len(self.reply_model.seen_calls), before)

    def test_no_number_continuation_c_insert_failure_retains_original_source_delete_lineage(self):
        path, generated, frame = self._generated(with_source=True)
        status, continued = self.backend.request(path + "/continue", self._command(generated, frame))
        self.assertEqual(status, 200, continued)
        command = self._command(continued, self._frame(path, continued), instruction="继续")
        before = len(self.reply_model.seen_calls)
        with self._fail_c_request_insert(command["idempotency_key"]):
            self.assertEqual(self.backend.request(path + "/continue", command),
                             (503, {"error": "assistant_session_save_failed"}))
        saved = self._get(self.backend, path)
        self.assertEqual(saved["turns"][-1]["state"], "failed")
        self.assertEqual(saved["turns"][-1]["input"]["content"]["draft_text"], "第二种合成说法。")
        self.assertEqual(saved["current_input_version_id"], saved["turns"][-1]["input_version_id"])
        with psycopg.connect(self.database_url) as connection:
            missing = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND idempotency_key=%s",
                (self.owner_id, command["idempotency_key"]),
            ).fetchone()[0]
        self.assertEqual(missing, 0)
        self.assertEqual(len(self.reply_model.seen_calls), before)
        contact_id = path.split("/")[3]
        status, deletion = self.backend.request(
            f"/api/contacts/{contact_id}/sources/{self.source_id}", method="DELETE",
        )
        self.assertEqual(status, 202, deletion)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            source = self._get(self.backend, f"/api/contacts/{contact_id}/sources")["sources"][0]
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                break
            self.assertNotEqual(source["task_status"], "failed", source)
            time.sleep(0.02)
        self.assertEqual(source["status"], "deleted", source)
        reopened = self._backend(self.owner_id)
        saved = self._get(reopened, path)
        self.assertEqual((saved["turns"][-1]["state"], saved["turns"][-1]["input"] is None,
                          saved["current_input_version_id"] is None), ("redacted", True, True))
        self.assertEqual(reopened.request(path + "/continue", command)[0], 409)
        self.assertEqual(len(self.reply_model.seen_calls), before)

    def test_no_number_c_insert_failure_follows_central_manual_sample_delete_lineage(self):
        path, generated, frame = self._generated(with_sample=True, content={
            "type": "initiate_conversation", "purpose": "自然地问候一下",
        })
        self.assertEqual(generated["context_receipt"]["style_sample_ids"], [self.sample_id])
        status, continued = self.backend.request(path + "/continue", self._command(generated, frame))
        self.assertEqual(status, 200, continued)
        command = self._command(continued, self._frame(path, continued), instruction="继续")
        before = len(self.reply_model.seen_calls)
        with self._fail_c_request_insert(command["idempotency_key"]):
            self.assertEqual(self.backend.request(path + "/continue", command),
                             (503, {"error": "assistant_session_save_failed"}))
        saved = self._get(self.backend, path)
        self.assertEqual(saved["turns"][-1]["state"], "failed")
        self.assertEqual(saved["turns"][-1]["input"]["content"]["draft_text"], "第二种合成说法。")
        with psycopg.connect(self.database_url) as connection:
            missing = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s AND idempotency_key=%s",
                (self.owner_id, command["idempotency_key"]),
            ).fetchone()[0]
        self.assertEqual(missing, 0)
        self.assertEqual(len(self.reply_model.seen_calls), before)
        contact_id = path.split("/")[3]
        status, deleted = self.backend.request(
            f"/api/contacts/{contact_id}/style-samples/{self.sample_id}", method="DELETE",
        )
        self.assertEqual(status, 200, deleted)
        reopened = self._backend(self.owner_id)
        saved = self._get(reopened, path)
        self.assertEqual((saved["turns"][-1]["state"], saved["turns"][-1]["input"] is None,
                          saved["current_input_version_id"] is None), ("redacted", True, True))
        self.assertEqual(reopened.request(path + "/continue", command)[0], 409)
        self.assertEqual(len(self.reply_model.seen_calls), before)

    def test_compound_requirements_clarify_length_conflict_then_replace_only_length(self):
        path, generated, frame = self._generated(content={
            "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点，简短一点",
        })
        command = self._command(generated, frame, instruction="第二条详细一点")
        status, clarified = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 409)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
        self.assertEqual(clarified["clarification"]["requirements"], ["简短一点"])
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        status, continued = self.backend.request(path + "/continue", {
            **command, "requirement_changes": [{"action": "replace", "previous": "简短一点",
                                               "replacement": "详细一点"}],
        })
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["自然一点", "详细一点"])
        self.assertEqual(self._model_payload()["user_instruction"], "自然一点；详细一点")
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_unknown_mixed_clause_is_not_automatically_accepted_as_natural_tone(self):
        requirement = "自然一点并暗示一个未确认的约定"
        path, generated, frame = self._generated(content={
            "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": requirement,
        })
        command = self._command(generated, frame, instruction="第二条详细一点")
        status, clarified = self.backend.request(path + "/continue", command)
        self.assertEqual(status, 409)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_need_confirmation")
        self.assertEqual(clarified["clarification"]["requirements"], [requirement])
        self.assertEqual(len(self.reply_model.seen_calls), 1)
        status, continued = self.backend.request(path + "/continue", {
            **command, "requirement_changes": [{"action": "remove", "previous": requirement}],
        })
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["详细一点"])
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_replacement_revalidates_conflicts_with_untouched_requirements_before_model(self):
        path, generated, frame = self._generated(content={
            "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点；简短一点",
        })
        command = self._command(generated, frame, instruction="继续", requirement_changes=[
            {"action": "replace", "previous": "简短一点", "replacement": "正式一点"},
        ])

        status, clarified = self.backend.request(path + "/continue", command)

        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
        self.assertEqual(clarified["clarification"]["requirements"], ["自然一点"])
        saved = self._get(self.backend, path)
        self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

        status, continued = self.backend.request(path + "/continue", {
            **command, "requirement_changes": [
                {"action": "replace", "previous": "简短一点", "replacement": "正式一点"},
                {"action": "remove", "previous": "自然一点"},
            ],
        })

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["正式一点"])
        self.assertEqual(self._model_payload()["user_instruction"], "正式一点")
        self.assertEqual(self._get(self.backend, path)["turns"][-1]["input"]["continuation"],
                         continued["continuation"])
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_conjoined_known_requirements_revalidate_every_dimension_before_model(self):
        path, generated, frame = self._generated(content={
            "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点",
        })
        command = self._command(generated, frame, instruction="正式一点并简短一点")

        status, clarified = self.backend.request(path + "/continue", command)

        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
        self.assertEqual(clarified["clarification"]["requirements"], ["自然一点"])
        saved = self._get(self.backend, path)
        self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

        status, continued = self.backend.request(path + "/continue", {
            **command, "instruction": "继续", "requirement_changes": [
                {"action": "replace", "previous": "自然一点", "replacement": "正式一点"},
                {"action": "add", "replacement": "简短一点"},
            ],
        })

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["正式一点", "简短一点"])
        self.assertEqual(self._model_payload()["user_instruction"], "正式一点；简短一点")
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_new_mixed_requirement_clarifies_compatibility_then_accepts_explicit_add(self):
        requirement = "正式一点并保留祝福"
        path, generated, frame = self._generated(content={
            "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点",
        })
        command = self._command(generated, frame, instruction=requirement)

        status, clarified = self.backend.request(path + "/continue", command)

        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_need_confirmation")
        self.assertEqual(clarified["clarification"]["requirements"], [requirement])
        saved = self._get(self.backend, path)
        self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(len(self.reply_model.seen_calls), 1)

        status, continued = self.backend.request(path + "/continue", {
            **command, "instruction": "继续", "requirement_changes": [
                {"action": "replace", "previous": "自然一点", "replacement": "正式一点"},
                {"action": "add", "replacement": "保留祝福"},
            ],
        })

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["正式一点", "保留祝福"])
        self.assertEqual(self._model_payload()["user_instruction"], "正式一点；保留祝福")
        self.assertEqual(len(self.reply_model.seen_calls), 2)

    def test_single_unknown_requirement_and_unchanged_unknown_continuation_can_generate(self):
        requirement = "保留末尾的祝福"
        path, generated, frame = self._generated()

        status, continued = self.backend.request(path + "/continue", self._command(
            generated, frame, instruction=requirement,
        ))

        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], [requirement])
        self.assertEqual(self._model_payload()["user_instruction"], requirement)
        status, repeated = self.backend.request(path + "/continue", self._command(
            continued, self._frame(path, continued), instruction="继续",
        ))
        self.assertEqual(status, 200, repeated)
        self.assertEqual(repeated["continuation"]["effective_requirements"], [requirement])
        self.assertEqual(self._model_payload()["user_instruction"], requirement)
        self.assertEqual(len(self._get(self.backend, path)["turns"]), 3)
        self.assertEqual(len(self.reply_model.seen_calls), 3)


    def test_explicit_compound_replacement_cannot_bypass_untouched_tone_conflict(self):
        path, generated, frame = self._generated(content={
            "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点；简短一点",
        })
        command = self._command(generated, frame, instruction="继续", requirement_changes=[
            {"action": "replace", "previous": "简短一点", "replacement": "正式一点；简短一点"},
        ])
        before_calls = len(self.reply_model.seen_calls)
        with psycopg.connect(self.database_url) as connection:
            before_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]

        status, clarified = self.backend.request(path + "/continue", command)

        saved = self._get(self.backend, path)
        with psycopg.connect(self.database_url) as connection:
            after_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]
        print(f"compound_replacement_observation: status={status} "
              f"model_delta={len(self.reply_model.seen_calls) - before_calls} "
              f"request_delta={after_requests - before_requests}", flush=True)
        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
        self.assertEqual(clarified["clarification"]["requirements"], ["自然一点"])
        self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(len(self.reply_model.seen_calls), before_calls)
        self.assertEqual(after_requests, before_requests)
        corrected = {**command, "requirement_changes": [
            {"action": "replace", "previous": "简短一点", "replacement": "正式一点；简短一点"},
            {"action": "remove", "previous": "自然一点"},
        ]}
        status, continued = self.backend.request(path + "/continue", corrected)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], ["正式一点；简短一点"])
        self.assertEqual(self._model_payload()["user_instruction"], "正式一点；简短一点")
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, path)["turns"][-1]["input"]["continuation"], continued["continuation"])
        self.assertEqual(reopened.request(path + "/continue", corrected), (200, continued))
        self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)


    def test_confirmed_mixed_replacement_and_add_still_revalidate_known_tone(self):
        requirement = "正式一点并保留祝福"
        for action in ("replace", "add"):
            with self.subTest(action=action):
                path, generated, frame = self._generated(content={
                    "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点；简短一点",
                })
                change = {"action": action, "replacement": requirement}
                if action == "replace":
                    change["previous"] = "简短一点"
                command = self._command(generated, frame, instruction="继续", requirement_changes=[change])
                before_calls = len(self.reply_model.seen_calls)
                with psycopg.connect(self.database_url) as connection:
                    before_requests = connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
                    ).fetchone()[0]

                status, clarified = self.backend.request(path + "/continue", command)

                saved = self._get(self.backend, path)
                with psycopg.connect(self.database_url) as connection:
                    after_requests = connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
                    ).fetchone()[0]
                print(f"mixed_confirmed_observation: action={action} status={status} "
                      f"model_delta={len(self.reply_model.seen_calls) - before_calls} "
                      f"request_delta={after_requests - before_requests}", flush=True)
                self.assertEqual(status, 409, clarified)
                self.assertEqual(clarified["clarification"]["reason"], "requirements_conflict")
                self.assertEqual(clarified["clarification"]["requirements"], ["自然一点"])
                self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
                self.assertEqual(len(saved["turns"]), 1)
                self.assertEqual(len(self.reply_model.seen_calls), before_calls)
                self.assertEqual(after_requests, before_requests)

                corrected = {**command, "requirement_changes": [
                    change, {"action": "remove", "previous": "自然一点"},
                ]}
                status, continued = self.backend.request(path + "/continue", corrected)
                self.assertEqual(status, 200, continued)
                expected = [requirement] if action == "replace" else ["简短一点", requirement]
                self.assertEqual(continued["continuation"]["effective_requirements"], expected)
                self.assertEqual(self._model_payload()["user_instruction"], "；".join(expected))
                saved = self._get(self.backend, path)["turns"][-1]
                self.assertEqual(saved["input"]["continuation"], continued["continuation"])
                self.assertEqual(self.backend.request(path + "/continue", corrected), (200, continued))
                self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)


    def test_clarification_distinguishes_existing_and_new_requirement_actions(self):
        existing = "保留末尾的祝福"
        proposed = "保留开头的问候"
        path, generated, frame = self._generated(content={
            "type": "initiate_conversation", "purpose": "拒绝邀约",
            "user_instruction": f"自然一点；{existing}",
        })
        command = self._command(generated, frame, instruction=proposed)
        before_calls = len(self.reply_model.seen_calls)
        with psycopg.connect(self.database_url) as connection:
            before_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]

        status, clarified = self.backend.request(path + "/continue", command)

        saved = self._get(self.backend, path)
        with psycopg.connect(self.database_url) as connection:
            after_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]
        print(f"requirement_action_observation: status={status} "
              f"model_delta={len(self.reply_model.seen_calls) - before_calls} "
              f"request_delta={after_requests - before_requests}", flush=True)
        self.assertEqual(status, 409, clarified)
        clarification = clarified["clarification"]
        self.assertEqual(clarification["reason"], "requirements_need_confirmation")
        self.assertEqual(clarification["requirements"], [existing, proposed])
        self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
        self.assertEqual(len(saved["turns"]), 1)
        self.assertEqual(len(self.reply_model.seen_calls), before_calls)
        self.assertEqual(after_requests, before_requests)
        self.assertEqual(clarification.get("requirement_options"), [
            {"requirement": existing, "origin": "existing", "actions": ["keep", "replace", "remove"]},
            {"requirement": proposed, "origin": "new", "actions": ["add"]},
        ])
        self.assertEqual(clarification["requirement_actions"], ["keep", "replace", "remove", "add"])

        confirmed = {**command, "instruction": "继续", "requirement_changes": [
            {"action": "keep", "previous": existing}, {"action": "add", "replacement": proposed},
        ]}
        status, continued = self.backend.request(path + "/continue", confirmed)
        self.assertEqual(status, 200, continued)
        expected = ["自然一点", existing, proposed]
        self.assertEqual(continued["continuation"]["effective_requirements"], expected)
        self.assertEqual(self._model_payload()["user_instruction"], "；".join(expected))
        self.assertEqual(self._get(self.backend, path)["turns"][-1]["input"]["continuation"],
                         continued["continuation"])
        self.assertEqual(self.backend.request(path + "/continue", confirmed), (200, continued))
        self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)
        status, unchanged = self.backend.request(path + "/continue", self._command(
            continued, self._frame(path, continued), instruction="继续",
        ))
        self.assertEqual(status, 200, unchanged)
        self.assertEqual(unchanged["continuation"]["effective_requirements"], expected)
        self.assertEqual(len(self.reply_model.seen_calls), before_calls + 2)


    def test_new_compound_requirement_confirms_unknown_clause_independently(self):
        requirement = "自然一点并保留祝福"
        path, generated, frame = self._generated()
        command = self._command(generated, frame, instruction=requirement)
        before_calls = len(self.reply_model.seen_calls)
        with psycopg.connect(self.database_url) as connection:
            before_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]

        status, clarified = self.backend.request(path + "/continue", command)

        with psycopg.connect(self.database_url) as connection:
            after_requests = connection.execute(
                "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
            ).fetchone()[0]
        print(f"compound_unknown_observation: status={status} "
              f"model_delta={len(self.reply_model.seen_calls) - before_calls} "
              f"request_delta={after_requests - before_requests}", flush=True)
        self.assertEqual(status, 409, clarified)
        self.assertEqual(clarified["clarification"]["reason"], "requirements_need_confirmation")
        self.assertEqual(clarified["clarification"]["requirement_options"], [
            {"requirement": requirement, "origin": "new", "actions": ["add"]},
        ])
        self.assertEqual(len(self._get(self.backend, path)["turns"]), 1)
        self.assertEqual(len(self.reply_model.seen_calls), before_calls)
        self.assertEqual(after_requests, before_requests)
        confirmed = {**command, "instruction": "继续", "requirement_changes": [
            {"action": "add", "replacement": requirement},
        ]}
        status, continued = self.backend.request(path + "/continue", confirmed)
        self.assertEqual(status, 200, continued)
        self.assertEqual(continued["continuation"]["effective_requirements"], [requirement])
        self.assertEqual(self._model_payload()["user_instruction"], requirement)
        status, unchanged = self.backend.request(path + "/continue", self._command(
            continued, self._frame(path, continued), instruction="继续",
        ))
        self.assertEqual(status, 200, unchanged)
        self.assertEqual(unchanged["continuation"]["effective_requirements"], [requirement])
        self.assertEqual(len(self.reply_model.seen_calls), before_calls + 2)


    def test_legal_4096_input_clarification_preserves_more_than_32_requirements(self):
        for requirements in (
            [f"合成约定{index}" for index in range(33)],
            [chr(0x4E00 + index) for index in range(2048)],
        ):
            with self.subTest(requirement_count=len(requirements)):
                user_instruction = "；".join(requirements)
                self.assertLessEqual(len(user_instruction), 4096)
                path, generated, frame = self._generated(content={
                    "type": "initiate_conversation", "purpose": "合成原意愿", "user_instruction": user_instruction,
                })
                before = len(self.reply_model.seen_calls)
                with psycopg.connect(self.database_url) as connection:
                    before_requests = connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
                    ).fetchone()[0]

                status, clarified = self.backend.request(path + "/continue", self._command(
                    generated, frame, instruction="继续", intention_update="合成新意愿",
                ))

                self.assertEqual(status, 409, clarified)
                clarification = clarified["clarification"]
                self.assertEqual(clarification["reason"], "requirements_need_confirmation")
                self.assertEqual(clarification["requirements"], requirements)
                self.assertEqual(clarification["requirement_options"], [
                    {"requirement": value, "origin": "existing", "actions": ["keep", "replace", "remove"]}
                    for value in requirements
                ])
                self.assertEqual(len(self._get(self.backend, path)["turns"]), 1)
                self.assertEqual(len(self.reply_model.seen_calls), before)
                with psycopg.connect(self.database_url) as connection:
                    after_requests = connection.execute(
                        "SELECT count(*) FROM public.reply_request WHERE owner_id=%s", (self.owner_id,),
                    ).fetchone()[0]
                self.assertEqual(after_requests, before_requests)
                print(f"legal_clarification_boundary: input_length={len(user_instruction)} "
                      f"requirements={len(requirements)} status={status} model_delta=0 request_delta=0", flush=True)


    def test_all_legal_clarified_requirements_can_be_confirmed_without_partial_progress(self):
        for requirements in (
            [f"合成约定{index}" for index in range(33)],
            [chr(0x4E00 + index) for index in range(2048)],
        ):
            with self.subTest(requirement_count=len(requirements)):
                path, generated, frame = self._generated(content={
                    "type": "initiate_conversation", "purpose": "合成原意愿",
                    "user_instruction": "；".join(requirements),
                })
                command = self._command(generated, frame, instruction="继续", intention_update="合成新意愿")
                before_calls = len(self.reply_model.seen_calls)
                saved_before = self._get(self.backend, path)
                status, clarified = self.backend.request(path + "/continue", command)
                self.assertEqual(status, 409, clarified)
                self.assertEqual(clarified["clarification"]["requirements"], requirements)
                # 澄清不保存部分确认；下一次提交仍须覆盖全部未知要求。
                for confirmed, still_unconfirmed in (
                    (requirements[:-1], requirements[-1:]),
                    (requirements[-1:], requirements[:-1]),
                ):
                    status, partial = self.backend.request(path + "/continue", {
                        **command, "idempotency_key": str(uuid4()), "requirement_changes": [
                            {"action": "keep", "previous": value} for value in confirmed
                        ],
                    })
                    self.assertEqual(status, 409, partial)
                    self.assertEqual(partial["clarification"]["requirements"], still_unconfirmed)
                    self.assertEqual(self._get(self.backend, path), saved_before)
                    self.assertEqual(len(self.reply_model.seen_calls), before_calls)

                confirmed_command = {**command, "requirement_changes": [
                    {"action": "keep", "previous": value} for value in requirements
                ]}
                for malformed in (
                    {"action": "unknown", "previous": requirements[-1]},
                    {"action": "keep", "previous": requirements[-1], "replacement": "多余字段"},
                ):
                    status, invalid = self.backend.request(path + "/continue", {
                        **confirmed_command, "requirement_changes": [
                            *confirmed_command["requirement_changes"][:-1], malformed,
                        ],
                    })
                    self.assertEqual(status, 400, invalid)
                    self.assertEqual(len(self.reply_model.seen_calls), before_calls)
                    self.assertEqual(self._get(self.backend, path), saved_before)
                status, continued = self.backend.request(path + "/continue", confirmed_command)
                print(f"all_requirement_confirmation: count={len(requirements)} status={status} "
                      f"model_delta={len(self.reply_model.seen_calls) - before_calls}", flush=True)
                self.assertEqual(status, 200, continued)
                self.assertEqual(continued["continuation"]["effective_requirements"], requirements)
                self.assertEqual(self._model_payload()["user_instruction"], "；".join(requirements))
                self.assertEqual(self._model_payload()["confirmed_purpose"], "合成新意愿")
                saved = self._get(self.backend, path)
                self.assertEqual(len(saved["turns"]), 2)
                self.assertEqual(saved["turns"][-1]["input"]["continuation"], continued["continuation"])
                self.assertEqual(saved["turns"][-1]["input_version_id"], continued["input_version_id"])
                self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)
                self.assertEqual(self.backend.request(path + "/continue", confirmed_command), (200, continued))
                self.assertEqual(len(self.reply_model.seen_calls), before_calls + 1)


    def test_default_json_client_submits_legal_unicode_instruction_and_replacement(self):
        legal = "😀" * 2049
        for field in ("instruction", "replacement"):
            with self.subTest(field=field):
                path, generated, frame = self._generated(content={
                    "type": "rewrite_draft", "draft_text": "合成原句。",
                    **({"user_instruction": "自然一点"} if field == "replacement" else {}),
                })
                before = len(self.reply_model.seen_calls)
                command = self._command(generated, frame, instruction=legal if field == "instruction" else "继续")
                observed = self._continue_with_default_json_client(path, command, replacement=(
                    {"previous": "自然一点", "text": legal} if field == "replacement" else None
                ))
                print(f"unicode_default_client: field={field} codepoints={len(legal)} "
                      f"requests={observed['requests']} ok={observed['ok']} "
                      f"model_delta={len(self.reply_model.seen_calls) - before}", flush=True)
                self.assertTrue(observed["ok"], observed)
                self.assertEqual(observed["requests"], 2)
                self.assertEqual(observed["status"], 200)
                self.assertEqual(observed["result"]["phase"], "completed")
                self.assertEqual(observed["result"]["effectiveRequirements"], [legal])
                self.assertEqual(self._model_payload()["user_instruction"], legal)
                saved = self._get(self.backend, path)
                self.assertEqual(len(saved["turns"]), 2)
                self.assertEqual(saved["turns"][-1]["input"]["continuation"]["effective_requirements"], [legal])
                self.assertEqual(len(self.reply_model.seen_calls), before + 1)

    def test_default_json_client_refuses_over_4096_codepoints_before_http(self):
        for field in ("instruction", "replacement"):
            with self.subTest(field=field):
                path, generated, frame = self._generated(content={
                    "type": "rewrite_draft", "draft_text": "合成原句。", "user_instruction": "自然一点",
                })
                before = len(self.reply_model.seen_calls)
                saved_before = self._get(self.backend, path)
                command = self._command(generated, frame, instruction="😀" * 4097 if field == "instruction" else "继续")
                observed = self._continue_with_default_json_client(path, command, replacement=(
                    {"previous": "自然一点", "text": "😀" * 4097} if field == "replacement" else None
                ))
                self.assertFalse(observed["ok"], observed)
                self.assertEqual(observed["requests"], 0)
                self.assertEqual(self._get(self.backend, path), saved_before)
                self.assertEqual(len(self.reply_model.seen_calls), before)
                print(f"unicode_default_client_limit: field={field} codepoints=4097 "
                      "requests=0 model_delta=0", flush=True)

    def test_default_json_client_submits_exact_4096_unicode_codepoints(self):
        for field in ("instruction", "replacement"):
            with self.subTest(field=field):
                path, generated, frame = self._generated(content={
                    "type": "rewrite_draft", "draft_text": "合成原句。",
                    **({"user_instruction": "自然一点"} if field == "replacement" else {}),
                })
                legal = "😀" * 4096
                command = self._command(generated, frame, instruction=legal if field == "instruction" else "继续")
                before = len(self.reply_model.seen_calls)
                observed = self._continue_with_default_json_client(path, command, replacement=(
                    {"previous": "自然一点", "text": legal} if field == "replacement" else None
                ))
                self.assertTrue(observed["ok"], observed)
                self.assertEqual(observed["status"], 200)
                self.assertEqual(observed["requests"], 2)
                self.assertEqual(observed["result"]["effectiveRequirements"], [legal])
                self.assertEqual(self._model_payload()["user_instruction"], legal)
                self.assertEqual(self._get(self.backend, path)["turns"][-1]["input"]["continuation"]["effective_requirements"], [legal])
                self.assertEqual(len(self.reply_model.seen_calls), before + 1)
                print(f"unicode_default_client_boundary: field={field} codepoints=4096 "
                      "status=200 model_delta=1", flush=True)

    def test_default_json_client_confirms_all_33_and_2048_actual_clarification_options(self):
        for requirements in (
            [f"合成约定{index}" for index in range(33)],
            [chr(0x4E00 + index) for index in range(2048)],
        ):
            with self.subTest(requirement_count=len(requirements)):
                path, generated, frame = self._generated(content={
                    "type": "initiate_conversation", "purpose": "合成原意愿",
                    "user_instruction": "；".join(requirements),
                })
                command = self._command(generated, frame, instruction="继续", intention_update="合成新意愿")
                before = len(self.reply_model.seen_calls)
                clarified = self._continue_with_default_json_client(path, command)
                self.assertTrue(clarified["ok"], clarified)
                self.assertEqual(clarified["status"], 409)
                self.assertEqual(clarified["result"]["phase"], "clarification")
                self.assertEqual(clarified["result"]["clarification"]["requirements"], requirements)
                self.assertEqual(len(self.reply_model.seen_calls), before)
                observed = self._continue_with_default_json_client(path, command, confirmed_options=(
                    clarified["result"]["clarification"]["requirement_options"]
                ))
                self.assertTrue(observed["ok"], observed)
                self.assertEqual(observed["status"], 200)
                self.assertEqual(observed["requests"], 2)
                self.assertEqual(observed["result"]["phase"], "completed")
                self.assertEqual(observed["result"]["effectiveRequirements"], requirements)
                self.assertEqual(self._model_payload()["user_instruction"], "；".join(requirements))
                saved = self._get(self.backend, path)
                self.assertEqual(len(saved["turns"]), 2)
                self.assertEqual(saved["turns"][-1]["input"]["continuation"]["effective_requirements"], requirements)
                self.assertEqual(len(self.reply_model.seen_calls), before + 1)
                print(f"all_confirmation_default_client: count={len(requirements)} "
                      "status=200 model_delta=1", flush=True)


if __name__ == "__main__":
    unittest.main()
