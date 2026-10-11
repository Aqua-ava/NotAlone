"""稳定讨论输入经公开仓储与真实 HTTP 读投影在隔离 PG 中验证。"""

from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import psycopg

from notalone.memory.models import (
    AdoptionMethod, ConfirmedMemoryStatus, MemoryCategory, MemoryTopic, OwnerMemory,
)
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.persistence.style_sample_store import captured_reply_sources
from notalone.scopes import ContactScope
from tests.integration.persistence.concurrency import wait_for_blocked_operations
from tests.integration.server import test_assistant_session_api as session_fixture


DATABASE_URL = session_fixture.DATABASE_URL


class AssistantSessionInputHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        session_fixture.AssistantSessionHttpTest.setUpClass()

    def setUp(self) -> None:
        self.fixture = session_fixture.AssistantSessionHttpTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.store = PostgresAssistantSessionStore(DATABASE_URL)
        self.scope = ContactScope(self.fixture.owner_id, self.fixture.contact_id)
        status, saved = self.fixture._default()
        self.assertEqual(status, 200, saved)
        self.session_id = UUID(saved["session_id"])
        self.path = self.fixture._path(self.session_id)

    def test_discussion_input_is_recoverable_without_generating_candidates(self) -> None:
        content = {"type": "purpose_exploration", "purpose_hint": "想轻松问候", "correction": "少一点客套"}
        status, created = self.fixture.backend.request(self.path + "/inputs", {"content": content})
        self.assertEqual(status, 200, created)
        version = UUID(created["input_version_id"])

        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], str(version))
        self.assertEqual(saved["turns"], [])
        self.assertEqual(len(saved["inputs"]), 1)
        self.assertEqual(saved["inputs"][0]["input_version_id"], str(version))
        self.assertEqual(saved["inputs"][0]["type"], "purpose_exploration")
        self.assertEqual(saved["inputs"][0]["content"], {
            **content, "requirements": "", "answer": "", "confirmed_intent": "",
            "skill_mode": "auto", "skill_version_id": None,
        })
        self.assertEqual(saved["inputs"][0]["state"], "active")
        self.assertIsNone(saved["inputs"][0]["turn_id"])
        self.assertTrue(self.store.is_current_input(self.scope, self.session_id, version))
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_generation_advances_current_version_and_replay_precedes_stale_expected_check(self) -> None:
        status, discussion = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "合成改写讨论"},
        })
        self.assertEqual(status, 200, discussion)
        body = {**self.fixture._body(), "expected_input_version_id": discussion["input_version_id"]}
        status, first = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, first)
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual(saved["current_input_version_id"], first["input_version_id"])
        self.assertEqual(len(saved["inputs"]), 2)
        self.assertEqual(saved["inputs"][1]["type"], "generation")
        self.assertEqual(saved["inputs"][1]["turn_id"], first["turn_id"])
        self.assertIsNone(saved["inputs"][1]["content"])
        _, newest = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "之后的合成讨论"},
            "expected_input_version_id": first["input_version_id"],
        })
        self.assertEqual(self.fixture.backend.request(self.path + "/replies", body), (200, first))
        stale = {**self.fixture._body(draft="新的合成输入"),
                 "expected_input_version_id": discussion["input_version_id"]}
        self.assertEqual(self.fixture.backend.request(self.path + "/replies", stale),
                         (409, {"error": "assistant_session_input_conflict"}))
        self.assertEqual(self.fixture.backend.request(self.path)[1]["current_input_version_id"], newest["input_version_id"])
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_actual_source_cleanup_redacts_discussion_input_and_keeps_unrelated_discussion(self) -> None:
        _, independent = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": "无关合成讨论"},
        })
        source_id, target_id = self.fixture._source("合成讨论消息待删除")
        status, dependent = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "response_exploration", "target_message_id": target_id,
                        "correction": "保留合成临时要求"},
            "expected_input_version_id": independent["input_version_id"],
        })
        self.assertEqual(status, 200, dependent)
        self.fixture._delete_source(source_id)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["inputs"][0]["state"], "active")
        self.assertEqual(saved["inputs"][0]["content"]["purpose_hint"], "无关合成讨论")
        self.assertEqual(saved["inputs"][1]["state"], "redacted")
        self.assertIsNone(saved["inputs"][1]["content"])
        self.assertEqual(saved["inputs"][1]["placeholder"], "相关来源已删除")
        self.assertIsNone(saved["current_input_version_id"])
        self.assertFalse(self.store.is_current_input(self.scope, self.session_id, UUID(dependent["input_version_id"])))
        self.assertEqual(saved["turns"], [])
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_new_discussion_version_prevents_a_held_generation_from_becoming_a_candidate(self) -> None:
        body = self.fixture._body()
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.fixture.backend.request, self.path + "/replies", body)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                saved = self.fixture.backend.request(self.path)[1]
                self.assertEqual(saved["turns"][0]["state"], "running")
                self.assertEqual(saved["inputs"][0]["state"], "active")
                self.assertTrue(self.store.is_current_input(self.scope, self.session_id,
                                                           UUID(saved["current_input_version_id"])))
                status, version = self.fixture.backend.request(self.path + "/inputs", {
                    "content": {"type": "purpose_exploration", "purpose_hint": "合成新输入取代旧要求"},
                })
                self.assertEqual(status, 200, version)
            finally:
                gate.set()
            self.assertNotEqual(running.result(timeout=10)[0], 200)
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual(saved["current_input_version_id"], version["input_version_id"])
        self.assertEqual(saved["turns"][0]["state"], "failed")
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(len(saved["inputs"]), 2)

    def test_purpose_generation_with_disabled_skill_roundtrips_through_session_http(self) -> None:
        purpose = "合成主动约定明天见面"
        status, discussion = self.fixture.backend.request(self.path + "/inputs", {
            "content": {"type": "purpose_exploration", "purpose_hint": purpose, "skill_mode": "disabled"},
        })
        self.assertEqual(status, 200, discussion)
        body = {**self.fixture._body(), "content": {"type": "initiate_conversation", "purpose": purpose},
                "skill_disabled": True, "expected_input_version_id": discussion["input_version_id"]}
        status, generated = self.fixture.backend.request(self.path + "/replies", body)
        self.assertEqual(status, 200, generated)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["input"]["content"]["type"], "initiate_conversation")
        self.assertEqual(saved["turns"][0]["input"]["content"]["purpose"], purpose)
        self.assertTrue(saved["turns"][0]["input"]["skill_disabled"])
        self.assertIsNone(saved["inputs"][1]["content"])
        self.assertEqual(saved["current_input_version_id"], generated["input_version_id"])
        self.assertEqual(self.fixture.backend.request(self.path + "/replies", body), (200, generated))
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_new_input_after_candidate_save_preserves_completed_history_without_rewinding_current(self) -> None:
        body = self.fixture._body()
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=2) as pool:
            running = pool.submit(self.fixture.backend.request, self.path + "/replies", body)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                with psycopg.connect(DATABASE_URL) as connection:
                    lock_owner_scope(connection, owner_id=self.fixture.owner_id)
                    holder = connection.execute("SELECT pg_backend_pid()").fetchone()[0]
                    gate.set()
                    saving = wait_for_blocked_operations(DATABASE_URL, {holder}, 1)
                    updating = pool.submit(self.fixture.backend.request, self.path + "/inputs", {
                        "content": {"type": "purpose_exploration", "purpose_hint": "已保存候选后的合成新输入"},
                    })
                    # save 先排队，新输入紧随其后；complete 只能在 save 提交后入队。
                    wait_for_blocked_operations(DATABASE_URL, {holder} | saving, 2)
                status, newest = updating.result(timeout=10)
                self.assertEqual(status, 200, newest)
                completed_status, completed = running.result(timeout=10)
                self.assertEqual(completed_status, 200, completed)
                self.assertEqual(completed["session_id"], str(self.session_id))
                self.assertEqual(completed["state"], "completed")
                self.assertNotEqual(completed["input_version_id"], newest["input_version_id"])
            finally:
                gate.set()
        # 确认走过实际 save 提交，反例覆盖的是第二个事务窗口。
        with psycopg.connect(DATABASE_URL) as connection:
            persisted = connection.execute(
                "SELECT id, state FROM public.reply_request WHERE owner_id = %s AND contact_id = %s "
                "AND idempotency_key = %s",
                (self.fixture.owner_id, self.fixture.contact_id, UUID(body["idempotency_key"])),
            ).fetchall()
        self.assertEqual(persisted, [(UUID(completed["reply_request_id"]), "completed")])
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual(saved["current_input_version_id"], newest["input_version_id"])
        historical = saved["turns"][0]
        self.assertEqual(historical["state"], "completed")
        self.assertEqual(historical["turn_id"], completed["turn_id"])
        self.assertEqual(historical["input_version_id"], completed["input_version_id"])
        self.assertEqual(historical["reply"]["reply_request_id"], completed["reply_request_id"])
        self.assertEqual(historical["reply"]["candidates"], completed["candidates"])
        self.assertEqual(len(saved["inputs"]), 2)
        self.assertEqual(saved["inputs"][-1]["content"]["purpose_hint"], "已保存候选后的合成新输入")
        self.assertEqual(self.fixture.backend.request(self.path + "/replies", body), (200, completed))
        self.assertEqual(self.fixture.backend.request(self.path)[1]["current_input_version_id"],
                         newest["input_version_id"])
        self.assertEqual(len(self.fixture.model.seen_calls), 1)
        # 这里只证明历史保存与重放；A16 仍须拒绝在当前视图展示旧输入的响应。

    def test_discussion_http_rejects_cross_scope_and_client_provenance(self) -> None:
        content = {"type": "purpose_exploration", "purpose_hint": "合成范围检查"}
        other_path = self.fixture._path(self.session_id, contact_id=self.fixture.other_contact_id)
        self.assertEqual(self.fixture.backend.request(other_path + "/inputs", {"content": content})[0], 404)
        other_owner = self.fixture._backend(owner_id=UUID("00000000-0000-4000-8000-000000000001"))
        self.addCleanup(other_owner.close)
        self.assertEqual(other_owner.request(self.path + "/inputs", {"content": content})[0], 404)
        for payload in (
            {"content": content, "source_ids": []}, {"content": content, "verified_dependencies": []},
            {"content": {**content, "source_ids": []}}, {"content": {**content, "verified_dependencies": []}},
            {"content": {**content, "requirements": "字" * 4097}},
        ):
            with self.subTest(keys=tuple(payload)):
                self.assertEqual(self.fixture.backend.request(self.path + "/inputs", payload),
                                 (400, {"error": "assistant_session_request_invalid"}))
        saved = self.fixture.backend.request(self.path)[1]
        self.assertEqual(saved["inputs"], [])
        self.assertIsNone(saved["current_input_version_id"])
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_generation_expected_version_requires_a_uuid_when_provided(self) -> None:
        for invalid in (None, True, 42, "not-a-uuid", {}):
            with self.subTest(value_type=type(invalid).__name__):
                self.assertEqual(self.fixture.backend.request(self.path + "/replies", {
                    **self.fixture._body(), "expected_input_version_id": invalid,
                }), (400, {"error": "assistant_session_request_invalid"}))
        self.assertEqual(self.fixture.backend.request(self.path)[1]["turns"], [])
        self.assertEqual(len(self.fixture.model.seen_calls), 0)

    def test_sources_attached_during_model_call_do_not_change_the_captured_generation_sources(self) -> None:
        text = "明天一起散步，我希望表达轻松自然。"
        original_source, message_id = self.fixture._source(text)
        memory_id = uuid4()
        PostgresOwnerMemoryStore(DATABASE_URL).create(OwnerMemory(
            memory_id=memory_id, owner_id=self.fixture.owner_id, text=text,
            category=MemoryCategory.PREFERENCE, topic=MemoryTopic.OTHER,
            source_ids=(UUID(message_id),), adoption_method=AdoptionMethod.AUTO,
            status=ConfirmedMemoryStatus.ACTIVE,
        ))
        self.fixture.model.responses = [self.fixture._candidate(str(memory_id))]
        body = self.fixture._body(draft=text)
        body["content"]["include_relationship_context"] = True
        gate = self.fixture.model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(self.fixture.backend.request, self.path + "/replies", body)
            try:
                self.assertTrue(self.fixture.model.response_entered.wait(5))
                later_source, _ = self.fixture._source("合成模型运行中新增的独立来源。")
                self.fixture._attach_source(later_source, message_id)
            finally:
                gate.set()
            status, generated = running.result(timeout=10)
        self.assertEqual(status, 200, generated)
        evidence = self.fixture.backend.request(
            f"/api/contacts/{self.fixture.contact_id}/replies/{generated['reply_request_id']}/evidence",
        )[1]
        self.assertTrue(any(item["kind"] == "owner_memory" and item["evidence_id"] == str(memory_id)
                            for item in evidence["evidence"]))
        with psycopg.connect(DATABASE_URL) as connection:
            captured = captured_reply_sources(connection, owner_id=self.fixture.owner_id,
                                              request_id=UUID(generated["reply_request_id"]))
        self.assertIn(UUID(original_source), captured)
        self.assertNotIn(UUID(later_source), captured)

        self.fixture._delete_source(later_source)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "completed")
        self.assertEqual(saved["turns"][0]["reply"]["candidates"], generated["candidates"])
        self.assertTrue(self.store.is_current_input(self.scope, self.session_id,
                                                   UUID(generated["input_version_id"])))
        self.assertEqual(self.fixture.backend.request(self.path + "/replies", body), (200, generated))

        self.fixture._delete_source(original_source)
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["turns"][0]["state"], "redacted")
        self.assertIsNone(saved["turns"][0]["input"])
        self.assertIsNone(saved["turns"][0]["reply"])
        self.assertEqual(saved["inputs"][0]["state"], "redacted")
        self.assertIsNone(saved["inputs"][0]["content"])
        self.assertFalse(self.store.is_current_input(self.scope, self.session_id,
                                                    UUID(generated["input_version_id"])))
        self.assertEqual(self.fixture.backend.request(self.path + "/replies", body), (
            409, {"error": "assistant_session_rejected", "reason": "source_deleted"},
        ))
        self.assertEqual(len(self.fixture.model.seen_calls), 1)

    def test_current_input_and_recovery_reject_a_missing_ancestor_source_snapshot(self) -> None:
        _, target_id = self.fixture._source("合成祖先当时使用的原始消息。")
        self.fixture.model.responses = [self.fixture._candidate(target_id)]
        parent_body = {**self.fixture._body(), "content": {
            "type": "reply_to_message", "target_message_id": target_id, "direction": "自然回应",
        }}
        status, parent = self.fixture.backend.request(self.path + "/replies", parent_body)
        self.assertEqual(status, 200, parent)
        candidate_id = parent["candidates"][0]["candidate_id"]
        self.fixture.model.responses.append(self.fixture._candidate(candidate_id))
        child_body = {**self.fixture._body(draft="继续保留合成候选原意"),
                      "continued_from_candidate_id": candidate_id}
        status, child = self.fixture.backend.request(self.path + "/replies", child_body)
        self.assertEqual(status, 200, child)
        with psycopg.connect(DATABASE_URL) as connection:
            # 模拟 049 前已有的祖先，后继自己的 raw 快照不能补证祖先。
            connection.execute(
                "DELETE FROM public.reply_original_source_use WHERE owner_id = %s AND reply_request_id = %s",
                (self.fixture.owner_id, UUID(parent["reply_request_id"])),
            )
        status, saved = self.fixture.backend.request(self.path)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["current_input_version_id"], child["input_version_id"])
        self.assertEqual([turn["state"] for turn in saved["turns"]], ["unavailable", "unavailable"])
        self.assertEqual([item["state"] for item in saved["inputs"]], ["unavailable", "unavailable"])
        self.assertTrue(all(turn["input"] is None and turn["reply"] is None for turn in saved["turns"]))
        self.assertFalse(self.store.is_current_input(self.scope, self.session_id,
                                                    UUID(child["input_version_id"])))
        self.assertNotEqual(self.fixture.backend.request(self.path + "/replies", child_body)[0], 200)
        self.assertEqual(len(self.fixture.model.seen_calls), 2)
