"""事件与版本经公开 HTTP、真实 Worker 及随机隔离 PostgreSQL 的行为。"""

from __future__ import annotations

import json
import time
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from unittest.mock import patch
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from notalone.memory_extraction.dimensions import DimensionRelease
from tests.fidelity_http_support import FidelityControlledModel
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, ScriptedCoreModel, tool_response,
)


class EventScriptedModel(ScriptedCoreModel):
    """按真实批量裁决请求封装预先指定动作；不改变裁决或采纳结果。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.wait_for_response()
        names = [item.get('function', {}).get('name') for item in kwargs.get('tools', [])]
        index = len(self.seen_calls)
        if names == ['BatchMemoryAdjudicationOutput'] and index < len(self.responses):
            calls = self.responses[index].tool_calls
            if len(calls) == 1 and calls[0]['name'] == 'MemoryAdjudicationOutput':
                candidates = json.loads(str(messages[-1].content))
                self.responses[index] = tool_response('BatchMemoryAdjudicationOutput', {
                    'decisions': [{**calls[0]['args'], 'candidate_index': item['candidate_index']}
                                  for item in candidates],
                })
        return super()._generate(messages, stop, run_manager, **kwargs)


class MemoryEventUpdatesHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    # 自动事件更新仍经独立来源核验；合成配置只解除额外逐维放行条件。
    dimension_release = DimensionRelease(gate_enabled=False)
    extraction_model_factory = EventScriptedModel

    @classmethod
    def _drop_database(cls) -> None:
        super()._drop_database()
        if cls.admin.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
            (cls.database_name,),
        ).fetchone()[0]:
            raise RuntimeError("本轮事件测试库清理未确认。")

    def import_event(
        self, *, original: str, claim: str, when: str,
        contact_id: str | None = None, subject: str = "contact",
        action: str = "keep", replaced_id: str | None = None,
        expect_failure: bool = False,
        fact_overrides: dict | None = None, additional_fact_overrides: tuple[dict, ...] = (),
        acknowledgement: str = "合成记录：已收到。",
        event_spec: dict | None = None, event_verification: dict | None = None,
        additional_event_specs: tuple[dict, ...] = (),
        additional_fact_uses_all_sources: bool = False,
    ) -> dict:
        """用实际导入入口提交合成来源，模型响应在系统边界准备。"""
        timestamp = datetime.fromisoformat(when)
        if not hasattr(self, "event_locators"):
            self.event_locators = {}
        locator = self.event_locators.get(contact_id, f"wxid_synthetic_{uuid4().hex}")
        path = Path(self.temporary.name) / f"event-{uuid4().hex}.jsonl"
        records = []
        for number, from_me, text in (
            (1, subject == "self", original), (2, subject != "self", acknowledgement),
        ):
            records.append({
                "id": {"local_id": number, "server_id_str": uuid4().hex,
                       "talker": locator},
                "create_time": int(timestamp.timestamp()),
                "is_from_me": from_me, "kind": "text",
                "sender": "合成用户" if from_me else "合成事件联系人",
                "sender_wxid": (
                    f"wxid_synthetic_{self.backend.token}" if from_me else locator
                ),
                "text": text, "time": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "time_iso": when,
            })
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records),
                        encoding="utf-8")
        gate = self.extraction_model.pause_next_response()
        status, imported = self.backend.request("/api/imports/commit", {
            "path": str(path), **({"contact_id": contact_id} if contact_id else
                                  {"new_contact_name": "合成事件联系人"}),
        })
        self.assertEqual(status, 200, imported)
        contact_id = imported["contact_id"]
        self.event_locators[contact_id] = locator
        messages = self._get(self.backend, f"/api/contacts/{contact_id}/messages")["messages"]
        message = next(item for item in messages if item["text"] == original)
        source = next(item for item in self._get(
            self.backend, f"/api/contacts/{contact_id}/sources",
        )["sources"] if item["file_name"] == path.name)
        fact = {
            "text": claim, "category": "relationship_note", "subject": subject,
            "topic": "other", "source_message_ids": [message["message_id"]],
            "confidence": 0.95, "risk_flags": [], "valid_at": None,
            "invalid_at": None, "speech_act": "assertion",
            "assertion_status": "asserted", "figurative_type": "literal",
            "alternatives": [], "interpretation_reason": "合成来源中的直接陈述。",
        }
        if event_spec is not None:
            position = {"message_id": message["message_id"], "char_start": 0,
                        "char_end": len(original)}
            fact["event"] = {
                "version": event_spec.get("version", 1), "stage": event_spec["stage"],
                **({"occurrence_precision": event_spec["occurrence_precision"],
                    "occurrence_expression": event_spec["occurrence_expression"],
                    "anchor_message_id": message["message_id"]} if event_spec.get("version") == 2 else {}),
                "stage_evidence": [position],
                "occurrence_start": event_spec.get("occurrence_start"),
                "occurrence_end": event_spec.get("occurrence_end"),
                "occurrence_evidence": [position] if event_spec.get("occurrence_start") else [],
            }
        facts = [{**fact, **(fact_overrides or {})}, *({**fact, **extra} for extra in additional_fact_overrides)]
        for extra in additional_event_specs:
            facts.append({**fact, "event": {**fact["event"], **extra}})
        if additional_fact_uses_all_sources:
            facts[-1]["source_message_ids"] = [item["message_id"] for item in messages]
        scripts = [
            tool_response("MemoryExtractionOutput", {"facts": facts}),
            tool_response("SourceVerificationOutput", {"results": [{
                "candidate_index": index, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": message["message_id"], "quote": original}],
                **({"event_verification": {**event_verification,
                    "stage_evidence": facts[index]["event"]["stage_evidence"],
                    "occurrence_evidence": facts[index]["event"]["occurrence_evidence"],
                }} if event_verification is not None else {}),
            } for index in range(len(facts))]}),
        ]
        if (len(messages) > 2 or len(facts) > 1
                or subject == "self" and self._get(self.backend, "/api/memories/owner")["memories"]):
            scripts.append(tool_response("MemoryAdjudicationOutput", {
                "action": action, "replaced_memory_id": replaced_id,
            }))
        self.extraction_model.responses.extend(scripts)
        gate.set()
        if expect_failure:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                state = self._get(self.backend, f"/api/tasks/status?contact_id={contact_id}")
                if state["status"] == "finished":
                    self.assertEqual(state["progress"]["status"], "failed", state)
                    break
                time.sleep(0.02)
            else:
                self.fail("合成故障任务未在时限内结束。")
        else:
            self._wait_finished(self.backend, contact_id)
        return {**imported, "message": message, "source": source, "scripts": scripts, "records": records}

    def delete_source(self, contact_id: str, source_id: str) -> None:
        path = f"/api/contacts/{contact_id}/sources/{source_id}"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status, result = self.backend.request(path, method="DELETE")
            self.assertEqual(status, 202, result)
            if result["status"] == "succeeded":
                return
            time.sleep(0.02)
        self.fail("本轮来源删除未在时限内通过不可检索校验。")

    def assert_automatic_candidate_terminated(self, contact_id, text, *, source_id=None):
        prefix = f"/api/contacts/{contact_id}"
        self.assertEqual(self._get(self.backend, prefix + '/memory-candidates')['candidates'], [])
        with psycopg.connect(self.database_url) as connection:
            rows = connection.execute("SELECT status,failure_reason,source_ids,event FROM public.memory_candidate "
                "WHERE owner_id=%s AND contact_id=%s AND text_content=%s "
                "AND (%s::uuid IS NULL OR %s::uuid=ANY(source_ids))",
                (self.owner_id,contact_id,text,source_id,source_id)).fetchall()
        self.assertTrue(rows, "失败候选仍保留原始正文与来源审计")
        for status, reason, sources, event in rows:
            self.assertEqual(status, 'rejected')
            self.assertIsNotNone(reason)
            self.assertTrue(sources)
        return rows

    def test_general_text_support_cannot_certify_event_fields_or_enable_automatic_adoption(self):
        imported = self.import_event(
            original="合成记录：我参加完读书会。", claim="已参加完读书会。",
            when="2026-08-01T10:00:00+08:00", event_spec={"stage": "occurred"},
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], [])
        rows = self.assert_automatic_candidate_terminated(imported['contact_id'], '已参加完读书会。',
            source_id=imported['message']['message_id'])
        self.assertEqual((rows[0][3]['stage_verified'], rows[0][3]['occurrence_verified']), (False, False))

    def test_verified_different_occurrence_cannot_replace_an_auto_event_by_text_adjudication(self):
        first = self.import_event(
            original="合成事件：已参加2026-08-05T09:00:00+08:00的读书会。", claim="已参加读书会。",
            when="2026-08-06T10:00:00+08:00",
            event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T09:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        prefix = f"/api/contacts/{first['contact_id']}"
        old = self._get(self.backend, prefix + "/memories")["memories"][0]
        self.assertEqual(old["adoption_method"], "auto")
        second = self.import_event(
            original="合成另一事件：已参加2026-08-07T09:00:00+08:00的读书会。", claim="已参加读书会。",
            when="2026-08-08T10:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
            event_spec={"stage": "occurred", "occurrence_start": "2026-08-07T09:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], [old])
        self.assert_automatic_candidate_terminated(first["contact_id"], "已参加读书会。",
            source_id=second["message"]["message_id"])

    def _undo_before_retry_with_lost_receipt(self, *, subject: str) -> None:
        first = self.import_event(original="合成旧依据：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
                                  when="2026-08-01T10:00:00+08:00", subject=subject)
        path = "/api/memories/owner" if subject == "self" else f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        function = f"synthetic_undo_receipt_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL("CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '合成提交回执故障'; END $$").format(sql.Identifier(function)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {} BEFORE INSERT ON public.memory_extraction_trace_event FOR EACH ROW "
                "WHEN (NEW.owner_id={}::uuid AND NEW.stage='write_result' AND NEW.payload->>'operation'='invalidate') EXECUTE FUNCTION {}()"
            ).format(sql.Identifier(function), sql.Literal(str(self.owner_id)), sql.Identifier(function)))
        try:
            second = self.import_event(original="合成新依据：读书会改到二号会议室举行。", claim="读书会改到二号会议室举行。",
                                       when="2026-08-01T11:00:00+08:00", subject=subject, contact_id=first["contact_id"],
                                       action="update", replaced_id=old["memory_id"], expect_failure=True)
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON public.memory_extraction_trace_event").format(sql.Identifier(function)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
        current = self._get(self.backend, path)["memories"][0]
        status, reverted = self.backend.request(path + f"/{current['memory_id']}/revert-auto-update", {"expected_revision": current["revision"]})
        self.assertEqual(status, 200, reverted)
        self.extraction_model.responses.extend(second["scripts"][:2])
        task = {"contact_id": first["contact_id"], "task_id": second["task_id"]}
        self.assertEqual(self.backend.request("/api/tasks/retry", task)[0], 200)
        self.assertEqual(self.backend.request("/api/tasks/run", task)[0], 200)
        self._wait_finished(self.backend, first["contact_id"])
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, path)["memories"], [reverted["memory"]])
        self.assertEqual(self._get(reopened, f"/api/contacts/{first['contact_id']}/memory-candidates")["candidates"], [])
        self.assertEqual(reopened.request(path + f"/{current['memory_id']}/versions")[0], 404)
        self.delete_source(first["contact_id"], first["source"]["source_id"])
        self.assertEqual(self._get(reopened, path)["memories"], [])

    def test_contact_undo_before_retry_of_lost_receipt_does_not_republish_the_revoked_version(self):
        self._undo_before_retry_with_lost_receipt(subject="contact")

    def test_self_undo_before_retry_of_lost_receipt_does_not_republish_the_revoked_version(self):
        self._undo_before_retry_with_lost_receipt(subject="self")

    def _undo_two_legal_updates(self, *, subject: str) -> None:
        first = self.import_event(original="合成初始安排：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
                                  when="2026-08-01T10:00:00+08:00", subject=subject)
        path = "/api/memories/owner" if subject == "self" else f"/api/contacts/{first['contact_id']}/memories"
        original = previous = self._get(self.backend, path)["memories"][0]
        for hour, room in ((11, "二"), (12, "三")):
            self.import_event(original=f"合成新安排：读书会改到{room}号会议室举行。", claim=f"读书会改到{room}号会议室举行。",
                              when=f"2026-08-01T{hour}:00:00+08:00", subject=subject, contact_id=first["contact_id"],
                              action="update", replaced_id=previous["memory_id"])
            previous = self._get(self.backend, path)["memories"][0]
        self.assertTrue(previous["can_revert_auto_update"])
        status, first_undo = self.backend.request(path + f"/{previous['memory_id']}/revert-auto-update", {"expected_revision": previous["revision"]})
        self.assertEqual(status, 200, first_undo)
        restored = first_undo["memory"]
        self.assertTrue(restored["can_revert_auto_update"])
        status, second_undo = self._backend(self.owner_id).request(path + f"/{restored['memory_id']}/revert-auto-update", {"expected_revision": restored["revision"]})
        self.assertEqual(status, 200, second_undo)
        self.assertEqual(second_undo["memory"]["memory_id"], original["memory_id"])
        self.assertEqual(second_undo["memory"]["text"], original["text"])
        self.assertFalse(second_undo["memory"]["can_revert_auto_update"])
        self.assertEqual(self.backend.request(path + f"/{previous['memory_id']}/revert-auto-update", {"expected_revision": previous["revision"]})[0], 409)
        self.delete_source(first["contact_id"], first["source"]["source_id"])
        self.assertEqual(self._get(self.backend, path)["memories"], [])

    def test_contact_can_undo_each_still_legal_auto_version_after_restart(self):
        self._undo_two_legal_updates(subject="contact")

    def test_self_can_undo_each_still_legal_auto_version_after_restart(self):
        self._undo_two_legal_updates(subject="self")

    def test_same_words_on_different_event_dates_remain_two_viewable_memories(self):
        first = self.import_event(
            original="合成记录一：今天参加了读书会。", claim="联系人参加了读书会。",
            when="2026-08-01T10:00:00+08:00",
        )
        second = self.import_event(
            original="合成记录二：今天参加了读书会。", claim="联系人参加了读书会。",
            when="2026-09-01T10:00:00+08:00", contact_id=first["contact_id"],
        )
        memories = self._get(
            self.backend, f"/api/contacts/{first['contact_id']}/memories",
        )["memories"]
        self.assertEqual(len(memories), 2)
        self.assertEqual({datetime.fromisoformat(item["timing"]["source_started_at"])
                          for item in memories}, {
            datetime.fromisoformat("2026-08-01T02:00:00+00:00"),
            datetime.fromisoformat("2026-09-01T02:00:00+00:00"),
        })
        self.assertEqual({tuple(item["source_ids"]) for item in memories}, {
            (first["message"]["message_id"],), (second["message"]["message_id"],),
        })

    def test_new_event_change_preserves_a_version_link_and_complete_sources(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        second = self.import_event(
            original="合成活动：刚才那场读书会改到二号会议室举行。",
            claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, path)["memories"]
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]["text"], "读书会改到二号会议室举行。")
        self.assertEqual(current[0]["adoption_method"], "auto")
        self.assertEqual(current[0]["supersedes_memory_id"], old["memory_id"])
        self.assertEqual(current[0]["revision"], old["revision"] + 1)
        self.assertEqual(set(current[0]["source_ids"]), {
            first["message"]["message_id"], second["message"]["message_id"],
        })

    def test_owner_event_change_stays_in_owner_scope_and_preserves_its_version(self):
        first = self.import_event(
            original="合成本人活动：我的读书会在一号会议室举行。", claim="我的读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00", subject="self",
        )
        old = self._get(self.backend, "/api/memories/owner")["memories"][0]
        second = self.import_event(
            original="合成本人活动：我的同一场读书会改到二号会议室举行。",
            claim="我的读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], subject="self", action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, "/api/memories/owner")["memories"]
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]["supersedes_memory_id"], old["memory_id"])
        self.assertEqual(current[0]["revision"], old["revision"] + 1)
        self.assertEqual(set(current[0]["source_ids"]), {
            first["message"]["message_id"], second["message"]["message_id"],
        })
        self.assertEqual(self._get(self.backend, f"/api/contacts/{first['contact_id']}/memories")["memories"], [])
        self.assertEqual(self._get(self.other_backend, "/api/memories/owner")["memories"], [])

    def test_failed_version_change_rolls_back_both_sides_and_retry_applies_once(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        function = f"synthetic_version_fault_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN RAISE EXCEPTION '合成版本故障'; END $$"
            ).format(sql.Identifier(function)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {} BEFORE UPDATE ON public.confirmed_memory "
                "FOR EACH ROW WHEN (OLD.id={}::uuid AND NEW.status='invalidated') "
                "EXECUTE FUNCTION {}()"
            ).format(sql.Identifier(function), sql.Literal(old["memory_id"]), sql.Identifier(function)))
        try:
            second = self.import_event(
                original="合成活动：刚才那场读书会改到二号会议室举行。",
                claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
                contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
                expect_failure=True,
            )
            self.assertEqual(self._get(self.backend, path)["memories"], [old])
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON public.confirmed_memory").format(sql.Identifier(function)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
        self.extraction_model.responses.extend(second["scripts"])
        task = {"contact_id": first["contact_id"], "task_id": second["task_id"]}
        self.assertEqual(self.backend.request("/api/tasks/retry", task)[0], 200)
        self.assertEqual(self.backend.request("/api/tasks/run", task)[0], 200)
        self._wait_finished(self.backend, first["contact_id"])
        current = self._get(self.backend, path)["memories"]
        self.assertEqual(len(current), 1)
        self.assertEqual(current[0]["text"], "读书会改到二号会议室举行。")
        self.assertEqual(current[0]["supersedes_memory_id"], old["memory_id"])
        self.assertEqual(self.backend.request("/api/tasks/run", task)[0], 200)
        persisted = self._get(self.backend, f"/api/tasks/status?contact_id={first['contact_id']}"
                              f"&task_id={second['task_id']}")
        self.assertEqual(persisted["status"], "succeeded")
        self.assertEqual(self._get(self.backend, path)["memories"], current)

    def test_version_history_is_viewable_after_restart_and_is_scoped(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.import_event(
            original="合成活动：刚才那场读书会改到二号会议室举行。",
            claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, path)["memories"][0]
        reopened = self._backend(self.owner_id)
        history = self._get(reopened, f"{path}/{current['memory_id']}/versions")["versions"]
        self.assertEqual([item["text"] for item in history], [current["text"], old["text"]])
        self.assertEqual([item["status"] for item in history], ["active", "invalidated"])
        self.assertEqual(history[1]["source_ids"], old["source_ids"])
        self.assertEqual(history[0]["supersedes_memory_id"], old["memory_id"])
        self.assertEqual(self.other_backend.request(f"{path}/{current['memory_id']}/versions")[0], 404)

    def test_user_can_revert_an_auto_update_and_repeated_or_stale_actions_do_not_change_it(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.import_event(
            original="合成活动：刚才那场读书会改到二号会议室举行。",
            claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, path)["memories"][0]
        self.assertTrue(current["can_revert_auto_update"])
        proof = current["version_evidence"]
        self.assertEqual((proof["version"], proof["previous"]["memory_id"],
                          proof["previous"]["revision"], proof["current"]["memory_id"]),
                         (1, old["memory_id"], old["revision"], current["memory_id"]))
        self.assertIn(first["message"]["message_id"], proof["previous_window"]["message_ids"])
        self.assertNotIn("text_content", json.dumps(proof))
        operation = f"{path}/{current['memory_id']}/revert-auto-update"
        self.assertEqual(self.backend.request(operation, {"expected_revision": 1})[0], 409)
        status, result = self.backend.request(operation, {"expected_revision": current["revision"]})
        self.assertEqual(status, 200, result)
        restored = result["memory"]
        self.assertEqual((restored["memory_id"], restored["text"], restored["source_ids"]),
                         (old["memory_id"], old["text"], old["source_ids"]))
        self.assertEqual(restored["adoption_method"], "auto")
        self.assertGreater(restored["revision"], current["revision"])
        self.assertEqual(self._get(self.backend, path)["memories"], [restored])
        self.assertEqual(self.backend.request(operation, {"expected_revision": current["revision"]})[0], 409)
        self.assertEqual(self._get(self.backend, path)["memories"], [restored])
        self.assertEqual(self.backend.request(f"{path}/{current['memory_id']}/versions")[0], 404)
        with psycopg.connect(self.database_url) as connection:
            retained = connection.execute(
                "SELECT memory.text_content, memory.event, memory.version_evidence, "
                "candidate.text_content, candidate.event, candidate.dimension_evidence, candidate.correction_evidence "
                "FROM public.confirmed_memory memory JOIN public.memory_candidate candidate "
                "ON candidate.id=memory.source_candidate_id WHERE memory.owner_id=%s AND memory.id=%s",
                (self.owner_id, current["memory_id"]),
            ).fetchone()
        self.assertEqual(retained, ("已删除的资料", None, None, "已删除的资料", None, None, None))

    def test_deleting_a_participating_source_erases_the_derived_version_and_cannot_restore_it(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        second = self.import_event(
            original="合成活动：刚才那场读书会改到二号会议室举行。",
            claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, path)["memories"][0]
        self.delete_source(first["contact_id"], first["source"]["source_id"])
        self.assertEqual(self._get(self.backend, path)["memories"], [])
        self.assertEqual(self.backend.request(f"{path}/{current['memory_id']}/versions")[0], 404)
        self.assertEqual(self.backend.request(f"{path}/{current['memory_id']}/revert-auto-update",
                                              {"expected_revision": current["revision"]})[0], 404)
        sources = self._get(self.backend, f"/api/contacts/{first['contact_id']}/sources")["sources"]
        self.assertEqual(next(item for item in sources if item["source_id"] == second["source"]["source_id"])["status"], "active")

    def test_owner_revert_checks_owner_scope_and_keeps_real_contact_sources(self):
        first = self.import_event(
            original="合成本人活动：我的读书会在一号会议室举行。", claim="我的读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00", subject="self",
        )
        old = self._get(self.backend, "/api/memories/owner")["memories"][0]
        self.import_event(
            original="合成本人活动：我的同一场读书会改到二号会议室举行。",
            claim="我的读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], subject="self", action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, "/api/memories/owner")["memories"][0]
        operation = f"/api/memories/owner/{current['memory_id']}/revert-auto-update"
        body = {"expected_revision": current["revision"]}
        self.assertEqual(self.other_backend.request(operation, body)[0], 404)
        restored = self.backend.request(operation, body)
        self.assertEqual(restored[0], 200, restored)
        self.assertEqual(restored[1]["memory"]["source_ids"], old["source_ids"])
        self.assertEqual(restored[1]["memory"]["adoption_method"], "auto")
        self.delete_source(first["contact_id"], first["source"]["source_id"])
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], [])
        self.assertEqual(self.backend.request(operation, body)[0], 404)

    def test_auto_update_with_missing_original_window_terminates_without_refilling_it(self):
        first = self.import_event(
            original="合成旧资料：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        with psycopg.connect(self.database_url) as connection:
            candidate_id = connection.execute("SELECT source_candidate_id FROM public.confirmed_memory WHERE owner_id=%s AND id=%s",
                                              (self.owner_id, old["memory_id"])).fetchone()[0]
            connection.execute("UPDATE public.memory_candidate SET dimension_evidence=NULL, correction_evidence=NULL WHERE owner_id=%s AND id=%s",
                               (self.owner_id, candidate_id))
        self.import_event(
            original="合成新资料：读书会改到二号会议室举行。", claim="读书会改到二号会议室举行。",
            when="2026-08-01T11:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
        )
        self.assertEqual([item["memory_id"] for item in self._get(self.backend, path)["memories"]], [old["memory_id"]])
        self.assert_automatic_candidate_terminated(first['contact_id'], '读书会改到二号会议室举行。')
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute("SELECT dimension_evidence, correction_evidence FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                                               (self.owner_id, candidate_id)).fetchone(), (None, None))

    def test_original_source_generation_change_disables_undo_after_restart(self):
        first = self.import_event(
            original="合成旧资料：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.import_event(
            original="合成新资料：读书会改到二号会议室举行。", claim="读书会改到二号会议室举行。",
            when="2026-08-01T11:00:00+08:00", contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, path)["memories"][0]
        self.assertTrue(current["can_revert_auto_update"])
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message_source_ref SET raw_payload=raw_payload||'{\"synthetic_generation\":2}'::jsonb WHERE owner_id=%s AND message_id=%s",
                               (self.owner_id, first["message"]["message_id"]))
        reopened = self._backend(self.owner_id)
        changed = self._get(reopened, path)["memories"][0]
        self.assertFalse(changed["can_revert_auto_update"])
        self.assertFalse(changed["version_evidence_source_current"])
        self.assertEqual(reopened.request(path + f"/{current['memory_id']}/revert-auto-update", {"expected_revision": current["revision"]})[0], 409)
        self.assertEqual(self._get(reopened, path)["memories"], [changed])

    def _manual_successor_erasure(self, *, subject: str, removed: str, deletion_first: bool) -> None:
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00", subject=subject,
        )
        path = ("/api/memories/owner" if subject == "self" else
                f"/api/contacts/{first['contact_id']}/memories")
        old = next(item for item in self._get(self.backend, path)["memories"]
                   if first["message"]["message_id"] in item["source_ids"])
        second = self.import_event(
            original="合成活动：刚才那场读书会改到二号会议室举行。",
            claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], subject=subject, action="update", replaced_id=old["memory_id"],
        )
        current = next(item for item in self._get(self.backend, path)["memories"]
                       if item["supersedes_memory_id"] == old["memory_id"])
        source = first["source"] if removed == "old" else second["source"]
        if deletion_first:
            self.delete_source(first["contact_id"], source["source_id"])
        status, corrected = self.backend.request(f"{path}/{current['memory_id']}/correct", {
            "text": "用户核对：读书会改在二号会议室靠窗举行。",
        })
        if deletion_first:
            self.assertEqual(status, 404, corrected)
        else:
            self.assertEqual(status, 200, corrected)
            successor = corrected["memory"]
            self.assertEqual(successor["adoption_method"], "manual")
            history = self._get(self.backend, f"{path}/{successor['memory_id']}/versions")["versions"]
            self.assertEqual([item["text"] for item in history], [successor["text"], current["text"], old["text"]])
            self.delete_source(first["contact_id"], source["source_id"])
            reopened = self._backend(self.owner_id)
            self.assertNotIn(successor["memory_id"], {
                item["memory_id"] for item in self._get(reopened, path)["memories"]
            })
            self.assertEqual(reopened.request(f"{path}/{successor['memory_id']}/versions")[0], 404)
            self.assertEqual(reopened.request(f"{path}/{successor['memory_id']}/revert-auto-update", {
                "expected_revision": successor["revision"],
            })[0], 404)
        self.assertEqual(self.backend.request(f"{path}/{current['memory_id']}/versions")[0], 404)
        self.assertEqual(self.backend.request(f"{path}/{current['memory_id']}/revert-auto-update", {
            "expected_revision": current["revision"],
        })[0], 404)


    def test_contact_manual_successor_old_source_deletion_after_correction(self):
        self._manual_successor_erasure(subject="contact", removed="old", deletion_first=False)

    def test_contact_manual_successor_old_source_deletion_before_correction(self):
        self._manual_successor_erasure(subject="contact", removed="old", deletion_first=True)

    def test_contact_manual_successor_new_source_deletion_after_correction(self):
        self._manual_successor_erasure(subject="contact", removed="new", deletion_first=False)

    def test_contact_manual_successor_new_source_deletion_before_correction(self):
        self._manual_successor_erasure(subject="contact", removed="new", deletion_first=True)

    def test_self_manual_successor_old_source_deletion_after_correction(self):
        self._manual_successor_erasure(subject="self", removed="old", deletion_first=False)

    def test_self_manual_successor_old_source_deletion_before_correction(self):
        self._manual_successor_erasure(subject="self", removed="old", deletion_first=True)

    def test_self_manual_successor_new_source_deletion_after_correction(self):
        self._manual_successor_erasure(subject="self", removed="new", deletion_first=False)

    def test_self_manual_successor_new_source_deletion_before_correction(self):
        self._manual_successor_erasure(subject="self", removed="new", deletion_first=True)

    def test_restore_failure_keeps_the_new_version_and_can_be_retried(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        self.import_event(
            original="合成活动：刚才那场读书会改到二号会议室举行。",
            claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
        )
        current = self._get(self.backend, path)["memories"][0]
        operation = f"{path}/{current['memory_id']}/revert-auto-update"
        body = {"expected_revision": current["revision"]}
        function = f"synthetic_restore_fault_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN RAISE EXCEPTION '合成恢复故障'; END $$"
            ).format(sql.Identifier(function)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {} BEFORE UPDATE ON public.confirmed_memory "
                "FOR EACH ROW WHEN (OLD.id={}::uuid AND NEW.status='active') "
                "EXECUTE FUNCTION {}()"
            ).format(sql.Identifier(function), sql.Literal(old["memory_id"]), sql.Identifier(function)))
        try:
            self.assertEqual(self.backend.request(operation, body)[0], 500)
            self.assertEqual(self._get(self.backend, path)["memories"], [current])
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON public.confirmed_memory").format(sql.Identifier(function)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
        self.assertEqual(self.backend.request(operation, body)[0], 200)
        self.assertEqual(self._get(self.backend, path)["memories"][0]["memory_id"], old["memory_id"])

    def test_auto_update_never_replaces_a_user_corrected_version(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        status, corrected = self.backend.request(f"{path}/{old['memory_id']}/correct", {"text": "用户已核对：读书会在三号会议室举行。"})
        self.assertEqual(status, 200, corrected)
        self.import_event(
            original="合成活动：刚才那场读书会改到二号会议室举行。",
            claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
            contact_id=first["contact_id"], action="update", replaced_id=corrected["memory"]["memory_id"],
        )
        self.assertEqual(self._get(self.backend, path)["memories"], [corrected["memory"]])
        self.assert_automatic_candidate_terminated(first['contact_id'], '读书会改到二号会议室举行。')

    def test_retry_after_committed_version_and_lost_trace_receipt_does_not_publish_it_twice(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        path = f"/api/contacts/{first['contact_id']}/memories"
        old = self._get(self.backend, path)["memories"][0]
        function = f"synthetic_receipt_fault_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN RAISE EXCEPTION '合成回执故障'; END $$"
            ).format(sql.Identifier(function)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {} BEFORE INSERT ON public.memory_extraction_trace_event "
                "FOR EACH ROW WHEN (NEW.owner_id={}::uuid AND NEW.stage='write_result' "
                "AND NEW.payload->>'operation'='invalidate') EXECUTE FUNCTION {}()"
            ).format(sql.Identifier(function), sql.Literal(str(self.owner_id)), sql.Identifier(function)))
        try:
            second = self.import_event(
                original="合成活动：刚才那场读书会改到二号会议室举行。",
                claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
                contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
                expect_failure=True,
            )
            committed = self._get(self.backend, path)["memories"]
            self.assertEqual(len(committed), 1)
            self.assertEqual(committed[0]["text"], "读书会改到二号会议室举行。")
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON public.memory_extraction_trace_event").format(sql.Identifier(function)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
        self.extraction_model.responses.extend(second["scripts"][:2])
        self.extraction_model.responses.append(tool_response("MemoryAdjudicationOutput", {
            "action": "keep", "replaced_memory_id": None,
        }))
        task = {"contact_id": first["contact_id"], "task_id": second["task_id"]}
        self.assertEqual(self.backend.request("/api/tasks/retry", task)[0], 200)
        self.assertEqual(self.backend.request("/api/tasks/run", task)[0], 200)
        self._wait_finished(self.backend, first["contact_id"])
        self.assertEqual(self._get(self.backend, path)["memories"], committed)

    def test_add_or_keep_with_a_replaced_id_cannot_replace_the_old_fact(self):
        for action in ("keep", "add"):
            with self.subTest(action=action):
                first = self.import_event(
                    original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
                    when="2026-08-01T10:00:00+08:00",
                )
                path = f"/api/contacts/{first['contact_id']}/memories"
                old = self._get(self.backend, path)["memories"][0]
                self.import_event(
                    original="合成活动：另外一次读书会在二号会议室举行。",
                    claim="读书会在二号会议室举行。", when="2026-09-01T11:00:00+08:00",
                    contact_id=first["contact_id"], action=action, replaced_id=old["memory_id"],
                )
                self.assertEqual(self._get(self.backend, path)["memories"], [old])
                self.assert_automatic_candidate_terminated(first['contact_id'], '读书会在二号会议室举行。')

    def test_text_only_noop_cannot_silently_drop_a_new_event_source(self):
        first = self.import_event(
            original="合成记录一：今天参加了读书会。", claim="联系人参加了读书会。",
            when="2026-08-01T10:00:00+08:00",
        )
        prefix = f"/api/contacts/{first['contact_id']}"
        old = self._get(self.backend, prefix + "/memories")["memories"][0]
        second = self.import_event(
            original="合成记录二：今天参加了读书会。", claim="联系人参加了读书会。",
            when="2026-08-02T10:00:00+08:00", contact_id=first["contact_id"], action="noop",
        )
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], [old])
        self.assert_automatic_candidate_terminated(first['contact_id'], '联系人参加了读书会。',
            source_id=second['message']['message_id'])

    def test_many_similar_manual_records_keep_a_new_claim_within_the_adjudication_budget(self):
        imported = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        for index in range(9):
            status, saved = self.backend.request("/api/memories/manual-contact", {
                "contact_id": imported["contact_id"], "category": "relationship_note", "topic": "other",
                "text": f"读书会在一号会议室举行，合成手录补充{index}。",
            })
            self.assertEqual(status, 200, saved)
        before = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual(len(before), 10)
        original_generate = self.extraction_model._generate

        def bounded_provider(_model, messages, *args, **kwargs):
            # 仅替换外部模型边界；超出夹具声明预算时供应商拒绝请求。
            for message in messages:
                text = getattr(message, "content", "")
                if isinstance(text, str) and text.startswith("新事实：") and text.count("[memory_id=") > 8:
                    raise RuntimeError("合成裁决输入超过八项预算。")
                if isinstance(text, str) and text.startswith('['):
                    payload = json.loads(text)
                    if any(len(item.get('similar', [])) > 8 for item in payload):
                        raise RuntimeError("合成批量裁决输入超过八项预算。")
            return original_generate(messages, *args, **kwargs)

        with patch.object(type(self.extraction_model), "_generate", bounded_provider):
            second = self.import_event(
                original="合成新活动：另外一场读书会也在一号会议室举行。",
                claim="另外一场读书会在一号会议室举行。", when="2026-09-01T10:00:00+08:00",
                contact_id=imported["contact_id"], action="add",
            )
        current = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual({item['memory_id'] for item in before},
            {item['memory_id'] for item in current if item['memory_id'] in {old['memory_id'] for old in before}})
        added = [item for item in current if item['memory_id'] not in {old['memory_id'] for old in before}]
        self.assertEqual(len(added), 1)
        self.assertEqual((added[0]['text'], added[0]['adoption_method'], added[0]['source_ids']),
            ('另外一场读书会在一号会议室举行。', 'auto', [second['message']['message_id']]))
        self.assertEqual(self._get(self.backend, prefix + '/memory-candidates')['candidates'], [])

    def test_same_source_and_words_with_distinct_verified_time_bounds_are_not_one_version(self):
        imported = self.import_event(
            original="合成回顾：八月一日和九月一日各参加了一次读书会。",
            claim="联系人参加了读书会。", when="2026-09-15T10:00:00+08:00",
            fact_overrides={"valid_at": "2026-08-01T00:00:00+08:00", "invalid_at": "2026-08-02T00:00:00+08:00"},
            additional_fact_overrides=({"valid_at": "2026-09-01T00:00:00+08:00", "invalid_at": "2026-09-02T00:00:00+08:00"},),
        )
        memories = self._get(self.backend, f"/api/contacts/{imported['contact_id']}/memories")["memories"]
        self.assertEqual(len(memories), 2)
        self.assertEqual({datetime.fromisoformat(item["valid_at"]) for item in memories}, {
            datetime.fromisoformat("2026-08-01T00:00:00+08:00"),
            datetime.fromisoformat("2026-09-01T00:00:00+08:00"),
        })


    def test_source_verified_confidence_changes_do_not_duplicate_automatic_memory(self):
        imported = self.import_event(
            original="合成资料：这次读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00", fact_overrides={"confidence": 0.1},
            additional_fact_overrides=({"confidence": 0.95},),
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        memories = self._get(self.backend, prefix + '/memories')['memories']
        self.assertEqual(len(memories), 1)
        self.assertEqual((memories[0]['text'], memories[0]['adoption_method'], memories[0]['source_ids']),
            ('读书会在一号会议室举行。', 'auto', [imported['message']['message_id']]))
        self.assertEqual(self._get(self.backend, prefix + '/memory-candidates')['candidates'], [])

    def test_manual_confirmation_winning_the_auto_commit_race_is_not_reported_as_an_auto_update(self):
        first = self.import_event(
            original="合成活动：读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00",
        )
        prefix = f"/api/contacts/{first['contact_id']}"
        old = self._get(self.backend, prefix + "/memories")["memories"][0]
        connect = psycopg.connect
        entered, release = threading.Event(), threading.Event()

        def controlled_connection(*args, **kwargs):
            connection = connect(*args, **kwargs)
            # 仅在数据库连接边界暂停自有 Worker；候选已提交，尚未取得下一事务的范围锁。
            if threading.current_thread().name.startswith("notalone-task-") and not entered.is_set():
                with connect(self.database_url) as observer:
                    ready = observer.execute(
                        "SELECT 1 FROM public.memory_candidate WHERE owner_id=%s AND contact_id=%s "
                        "AND status='pending' AND text_content=%s",
                        (self.owner_id, first["contact_id"], "读书会改到二号会议室举行。"),
                    ).fetchone()
                if ready:
                    entered.set()
                    if not release.wait(10):
                        connection.close()
                        raise TimeoutError("合成数据库边界未在时限内释放。")
            return connection

        with patch("psycopg.connect", side_effect=controlled_connection), ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(
                self.import_event, original="合成活动：刚才那场读书会改到二号会议室举行。",
                claim="读书会改到二号会议室举行。", when="2026-08-01T11:00:00+08:00",
                contact_id=first["contact_id"], action="update", replaced_id=old["memory_id"],
            )
            try:
                self.assertTrue(entered.wait(10), "自动确认前的数据库边界未到达。")
                pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
                status, manual = self.backend.request(prefix + f"/memory-candidates/{pending['candidate_id']}/confirm", {})
                self.assertEqual(status, 200, manual)
                self.assertEqual(manual["memory"]["adoption_method"], "manual")
            finally:
                release.set()
            future.result(timeout=10)
        current = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual({item["memory_id"] for item in current}, {old["memory_id"], manual["memory"]["memory_id"]})
        trace = self._get(self.backend, prefix + "/memory-traces")["batches"][0]
        detail = self._get(self.backend, prefix + f"/memory-traces/{trace['trace_id']}")
        self.assertFalse(any(event["stage"] == "candidate_result" and event["payload"].get("disposition") == "updated"
                             for event in detail["events"]), "人工确认胜出后不得报告自动更新或旧版已失效。")


class MemoryEventHistoricalReviewHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    """显式历史人工审核合同，验证旧候选仍能查看、确认、修改和删除。"""

    dimension_release = DimensionRelease()
    extraction_model_factory = EventScriptedModel
    reply_model_factory = FidelityControlledModel
    import_event = MemoryEventUpdatesHttpTest.import_event

    def _backend(self, owner_id):
        from notalone.tasks.worker import PostgresMemoryExtractionRunner

        def historical_review_runner(*args, **kwargs):
            return PostgresMemoryExtractionRunner(*args, **kwargs, automatic=False)

        with patch('tests.integration.server.core_business_flow_support.PostgresMemoryExtractionRunner',
                   historical_review_runner):
            return super()._backend(owner_id)

    def test_historical_changed_confidence_or_window_proof_does_not_duplicate_or_upgrade_old_pending(self):
        imported = self.import_event(
            original="合成资料：这次读书会在一号会议室举行。", claim="读书会在一号会议室举行。",
            when="2026-08-01T10:00:00+08:00", fact_overrides={"confidence": 0.1},
            additional_fact_overrides=({"confidence": 0.95},),
        )
        path = f"/api/contacts/{imported['contact_id']}"
        self.assertEqual(self._get(self.backend, f"{path}/memories")["memories"], [])
        pending = self._get(self.backend, f"{path}/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["confidence"], 0.1)


    def test_plan_keeps_its_source_verified_stage_after_the_occurrence_interval_passes(self):
        imported = self.import_event(
            original="合成计划：在2026-08-05T09:00:00+08:00至2026-08-05T11:00:00+08:00参加读书会。",
            claim="计划参加读书会。", when="2026-08-01T10:00:00+08:00",
            fact_overrides={"speech_act": "plan"},
            event_spec={"stage": "planned", "occurrence_start": "2026-08-05T09:00:00+08:00",
                        "occurrence_end": "2026-08-05T11:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        event = pending[0]["event"]
        self.assertEqual((event["stage"], event["stage_verified"], event["occurrence_verified"]),
                         ("planned", True, True))
        self.assertEqual(event["occurrence_start"], "2026-08-05T09:00:00+08:00")
        self.assertEqual(pending[0]["timing"]["source_started_at"], "2026-08-01T10:00:00+08:00")
        self.assertIsNone(pending[0]["valid_at"])
        status, confirmed = self.backend.request(
            prefix + f"/memory-candidates/{pending[0]['candidate_id']}/confirm", {},
        )
        self.assertEqual(status, 200, confirmed)
        reopened = self._backend(self.owner_id)
        saved = self._get(reopened, prefix + "/memories")["memories"][0]
        self.assertEqual(saved["event"], event)
        self.assertEqual(saved["adoption_method"], "manual")
        self.assertFalse(saved["can_revert_auto_update"])

        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(imported["contact_id"]),
                                     channel="wechat", account_scope=f"synthetic-{self.owner_id}",
                                     conversation_locator=f"synthetic-{imported['contact_id']}")
        self.reply_model.plans.append({"text": "读书会后来怎么样？", "basis": "只有计划依据，不推断已发生。"})
        status, reply = reopened.request("/api/reply/generate", {
            "contact_id": imported["contact_id"], "idempotency_key": str(uuid4()),
            "content": {"type": "rewrite_draft", "draft_text": "计划参加读书会。", "include_relationship_context": True},
        })
        self.assertEqual(status, 200, reply)
        evidence = next(item for item in self.reply_model.payloads[-1]["evidence"]
                        if item["evidence_id"] == saved["memory_id"])
        self.assertEqual(evidence["event"], event)
        path = prefix + f"/replies/{reply['reply_request_id']}/evidence"
        frozen = self._get(self._backend(self.owner_id), path)["evidence"]
        self.assertEqual(next(item for item in frozen if item["evidence_id"] == saved["memory_id"])["event"], event)

        from tests.integration.server.test_layered_profile_management import LayeredProfileHttpTest
        from tests.integration.server.test_layered_memory_management import LayeredMemoryManagementHttpTest
        layered_backend = LayeredProfileHttpTest.controlled(self)
        layered = LayeredMemoryManagementHttpTest.enable(self, layered_backend, imported["contact_id"])
        self.assertEqual(layered["status"], "ready")
        for reference in (layered["scenarios"][0]["paragraphs"][0]["references"][0],
                          layered["profile"]["entries"][0]["references"][0]):
            self.assertEqual(reference["event"], event)
            self.assertIsNone(reference["valid_at"])
            self.assertIsNone(reference["invalid_at"])

    def test_same_message_supporting_distinct_occurrences_keeps_two_pending_claims(self):
        imported = self.import_event(
            original="合成记录：在2026-08-05T09:00:00+08:00至2026-08-05T11:00:00+08:00和"
                     "2026-08-06T09:00:00+08:00至2026-08-06T11:00:00+08:00分别参加了读书会。",
            claim="已参加读书会。", when="2026-08-08T10:00:00+08:00",
            event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T09:00:00+08:00",
                        "occurrence_end": "2026-08-05T11:00:00+08:00"},
            additional_event_specs=({"occurrence_start": "2026-08-06T09:00:00+08:00",
                                     "occurrence_end": "2026-08-06T11:00:00+08:00"},),
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 2)
        self.assertEqual({item["event"]["occurrence_start"] for item in pending},
                         {"2026-08-05T09:00:00+08:00", "2026-08-06T09:00:00+08:00"})
        self.assertTrue(all(item["valid_at"] is None for item in pending))

    def test_overlapping_verified_event_evidence_reuses_one_pending_claim(self):
        imported = self.import_event(
            original="合成记录：已参加2026-08-05T09:00:00+08:00的读书会。",
            acknowledgement="合成补充：确认已参加2026-08-05T09:00:00+08:00的读书会。",
            claim="已参加读书会。", when="2026-08-08T10:00:00+08:00",
            event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T09:00:00+08:00"},
            additional_event_specs=({},), additional_fact_uses_all_sources=True,
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["source_ids"], [imported["message"]["message_id"]])
        self.assertTrue(pending[0]["event"]["stage_verified"])
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], [])

    def test_deleting_one_original_event_source_erases_proof_even_when_a_canonical_duplicate_survives(self):
        first = self.import_event(
            original="合成来源：计划参加2026-08-05T09:00:00+08:00的读书会。", claim="计划参加读书会。",
            when="2026-08-01T10:00:00+08:00",
            event_spec={"stage": "planned", "occurrence_start": "2026-08-05T09:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        prefix = f"/api/contacts/{first['contact_id']}"
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        # JSONL入口拒绝重叠导入；已有规范消息多引用状态沿真实PG数据边界准备。
        duplicate_source = uuid4()
        with psycopg.connect(self.database_url) as connection:
            connection.execute(
                "INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-overlap.jsonl',%s,1)",
                (duplicate_source, self.owner_id, first["contact_id"], uuid4().hex * 2),
            )
            connection.execute(
                "INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                "VALUES (%s,%s,%s,'source_document',%s,'synthetic-overlap:1',%s)",
                (first["message"]["message_id"], self.owner_id, first["contact_id"], duplicate_source, Jsonb(first["records"][0])),
            )
        self.delete_source(first["contact_id"], first["source"]["source_id"])
        reopened = self._backend(self.owner_id)
        self.assertIn(first["message"]["message_id"], {item["message_id"] for item in self._get(reopened, prefix + "/messages")["messages"]})
        self.assertEqual(self._get(reopened, prefix + "/memory-candidates")["candidates"], [])
        self.assertEqual(reopened.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/confirm", {})[0], 409)
        with psycopg.connect(self.database_url) as connection:
            residual = connection.execute(
                "SELECT text_content,event,dimension_evidence,correction_evidence FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                (self.owner_id, candidate["candidate_id"]),
            ).fetchone()
        self.assertEqual(residual, ("已删除的资料", None, None, None))

    def test_event_verification_is_not_reused_after_its_original_ref_generation_changes(self):
        imported = self.import_event(
            original="合成来源：已参加2026-08-05T09:00:00+08:00的读书会。", claim="已参加读书会。",
            when="2026-08-06T10:00:00+08:00",
            event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T09:00:00+08:00"},
            event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        self.assertEqual(self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/confirm", {})[0], 200)
        with psycopg.connect(self.database_url) as connection:
            connection.execute("UPDATE public.message_source_ref SET raw_payload=raw_payload||'{\"synthetic_generation\":2}'::jsonb WHERE owner_id=%s AND message_id=%s",
                               (self.owner_id, imported["message"]["message_id"]))
        event = self._get(self._backend(self.owner_id), prefix + "/memories")["memories"][0]["event"]
        self.assertEqual(event["stage"], "occurred")
        self.assertFalse(event["stage_verified"])
        self.assertFalse(event["occurrence_verified"])

    def _confirmed_unknown_occurrence_retry(self, *, subject: str, change: str | None = None) -> None:
        function = f"synthetic_unknown_event_receipt_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN RAISE EXCEPTION '合成候选回执故障'; END $$"
            ).format(sql.Identifier(function)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {} BEFORE INSERT ON public.memory_extraction_trace_event "
                "FOR EACH ROW WHEN (NEW.owner_id={}::uuid AND NEW.stage='candidate_result') "
                "EXECUTE FUNCTION {}()"
            ).format(sql.Identifier(function), sql.Literal(str(self.owner_id)), sql.Identifier(function)))
        try:
            imported = self.import_event(
                original="合成记录：已参加完读书会，但未说明发生日期。",
                claim="已参加完读书会。", when="2026-08-08T10:00:00+08:00", subject=subject,
                event_spec={"stage": "occurred"},
                event_verification={"stage_verdict": "supported", "occurrence_verdict": "uncertain"},
                expect_failure=True,
            )
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON public.memory_extraction_trace_event").format(sql.Identifier(function)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
        prefix = f"/api/contacts/{imported['contact_id']}"
        candidates = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["event"]["stage"], "occurred")
        self.assertTrue(candidate["event"]["stage_verified"])
        self.assertFalse(candidate["event"]["occurrence_verified"])
        self.assertIsNone(candidate["event"]["occurrence_start"])
        self.assertIsNone(candidate["event"]["occurrence_end"])
        status, result = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, result)
        confirmed = result["memory"]
        self.assertEqual(confirmed["adoption_method"], "manual")
        if change == "missing_proof":
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "UPDATE public.memory_candidate SET dimension_evidence=NULL WHERE owner_id=%s AND id=%s",
                    (self.owner_id, candidate["candidate_id"]),
                )
        elif change is not None:
            source_id = uuid4()
            with psycopg.connect(self.database_url) as connection:
                connection.execute(
                    "INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                    "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-replay-change.jsonl',%s,1)",
                    (source_id, self.owner_id, imported["contact_id"], uuid4().hex * 2),
                )
                message_id = imported["message"]["message_id"]
                if change == "window":
                    message_id = uuid4()
                    connection.execute(
                        "INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) "
                        "VALUES (%s,%s,%s,'user','text','合成新增上下文：近期有另一场活动。',%s)",
                        (message_id, self.owner_id, imported["contact_id"], datetime.fromisoformat("2026-08-08T09:00:00+08:00")),
                    )
                connection.execute(
                    "INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) "
                    "VALUES (%s,%s,%s,'source_document',%s,'synthetic-replay-change:1',%s)",
                    (message_id, self.owner_id, imported["contact_id"], source_id,
                     Jsonb(imported["records"][0] if change == "source_ref" else {"text": "合成新增上下文：近期有另一场活动。"})),
                )
        calls_before = len(self.extraction_model.seen_calls)
        self.extraction_model.responses.extend(imported["scripts"][:2])
        task = {"contact_id": imported["contact_id"], "task_id": imported["task_id"]}
        self.assertEqual(self.backend.request("/api/tasks/retry", task)[0], 200)
        self.assertEqual(self.backend.request("/api/tasks/run", task)[0], 200)
        self._wait_finished(self.backend, imported["contact_id"])
        memories = "/api/memories/owner" if subject == "self" else prefix + "/memories"
        reopened = self._backend(self.owner_id)
        current = self._get(reopened, memories)["memories"]
        if change in {"source_ref", "missing_proof"}:
            self.assertEqual(len(current), 1)
            for field in ("memory_id", "text", "source_ids", "adoption_method", "revision", "valid_at", "invalid_at"):
                self.assertEqual(current[0][field], confirmed[field])
            self.assertFalse(current[0]["event"]["stage_verified"])
            self.assertFalse(current[0]["event"]["occurrence_verified"])
        else:
            self.assertEqual(current, [confirmed])
        self.assertEqual(len(self.extraction_model.seen_calls) - calls_before, 2)
        pending = self._get(reopened, prefix + "/memory-candidates")["candidates"]
        if change is None:
            self.assertEqual(pending, [])
        else:
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["text"], confirmed["text"])
            self.assertEqual(pending[0]["source_ids"], candidate["source_ids"])
            self.assertEqual(pending[0]["event"], confirmed["event"])
        if change == "missing_proof":
            with psycopg.connect(self.database_url) as connection:
                self.assertIsNone(connection.execute(
                    "SELECT dimension_evidence FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                    (self.owner_id, candidate["candidate_id"]),
                ).fetchone()[0])

    def test_contact_confirmed_unknown_occurrence_is_not_republished_after_lost_receipt_retry(self):
        self._confirmed_unknown_occurrence_retry(subject="contact")

    def test_self_confirmed_unknown_occurrence_is_not_republished_after_lost_receipt_retry(self):
        self._confirmed_unknown_occurrence_retry(subject="self")

    def test_contact_same_claim_with_changed_window_is_not_an_original_claim_replay(self):
        self._confirmed_unknown_occurrence_retry(subject="contact", change="window")

    def test_self_same_claim_with_changed_window_is_not_an_original_claim_replay(self):
        self._confirmed_unknown_occurrence_retry(subject="self", change="window")

    def test_contact_same_claim_with_new_source_ref_is_not_an_original_claim_replay(self):
        self._confirmed_unknown_occurrence_retry(subject="contact", change="source_ref")

    def test_self_same_claim_with_new_source_ref_is_not_an_original_claim_replay(self):
        self._confirmed_unknown_occurrence_retry(subject="self", change="source_ref")

    def test_contact_missing_original_proof_is_not_refilled_to_suppress_unknown_occurrence(self):
        self._confirmed_unknown_occurrence_retry(subject="contact", change="missing_proof")

    def test_self_missing_original_proof_is_not_refilled_to_suppress_unknown_occurrence(self):
        self._confirmed_unknown_occurrence_retry(subject="self", change="missing_proof")

    def test_confirmed_occurrence_does_not_swallow_another_verified_occurrence_on_retry(self):
        function = f"synthetic_event_receipt_{uuid4().hex}"
        with psycopg.connect(self.database_url) as connection:
            connection.execute(sql.SQL(
                "CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN RAISE EXCEPTION '合成候选回执故障'; END $$"
            ).format(sql.Identifier(function)))
            connection.execute(sql.SQL(
                "CREATE TRIGGER {} BEFORE INSERT ON public.memory_extraction_trace_event "
                "FOR EACH ROW WHEN (NEW.owner_id={}::uuid AND NEW.stage='candidate_result') "
                "EXECUTE FUNCTION {}()"
            ).format(sql.Identifier(function), sql.Literal(str(self.owner_id)), sql.Identifier(function)))
        try:
            imported = self.import_event(
                original="合成记录：在2026-08-05T09:00:00+08:00和2026-08-06T09:00:00+08:00分别参加了读书会。",
                claim="已参加读书会。", when="2026-08-08T10:00:00+08:00",
                event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T09:00:00+08:00"},
                event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
                expect_failure=True,
            )
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER {} ON public.memory_extraction_trace_event").format(sql.Identifier(function)))
                connection.execute(sql.SQL("DROP FUNCTION {}()").format(sql.Identifier(function)))
        prefix = f"/api/contacts/{imported['contact_id']}"
        first = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        self.assertEqual(self.backend.request(prefix + f"/memory-candidates/{first['candidate_id']}/confirm", {})[0], 200)
        extraction = deepcopy(imported["scripts"][0].tool_calls[0]["args"])
        extraction["facts"][0]["event"]["occurrence_start"] = "2026-08-06T09:00:00+08:00"
        self.extraction_model.responses.extend([
            tool_response("MemoryExtractionOutput", extraction), imported["scripts"][1],
        ])
        task = {"contact_id": imported["contact_id"], "task_id": imported["task_id"]}
        self.assertEqual(self.backend.request("/api/tasks/retry", task)[0], 200)
        self.assertEqual(self.backend.request("/api/tasks/run", task)[0], 200)
        self._wait_finished(self.backend, imported["contact_id"])
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["event"]["occurrence_start"], "2026-08-06T09:00:00+08:00")
        self.assertEqual(len(self._get(self.backend, prefix + "/memories")["memories"]), 1)
    delete_source = MemoryEventUpdatesHttpTest.delete_source

    @classmethod
    def _drop_database(cls) -> None:
        super()._drop_database()
        if cls.admin.execute("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)",
                             (cls.database_name,)).fetchone()[0]:
            raise RuntimeError("本轮历史人工审核测试库清理未确认。")

    def test_historical_review_keeps_a_new_occurrence_pending_until_user_explicitly_applies_it(self):
        first = self.import_event(
            original="合成计划：准备参加这次读书会。", claim="计划参加这次读书会。",
            when="2026-08-01T10:00:00+08:00", fact_overrides={"speech_act": "plan"},
        )
        prefix = f"/api/contacts/{first['contact_id']}"
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        status, saved = self.backend.request(prefix + f"/memory-candidates/{pending[0]['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, saved)
        old = saved["memory"]
        self.assertEqual(old["adoption_method"], "manual")
        self.import_event(
            original="合成新依据：刚才参加完之前计划的那次读书会。", claim="已参加完这次读书会。",
            when="2026-08-02T10:00:00+08:00", contact_id=first["contact_id"],
        )
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], [old])
        pending = self._get(self.backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual([item["text"] for item in pending], ["已参加完这次读书会。"])
        operation = prefix + f"/memory-candidates/{pending[0]['candidate_id']}/apply-update"
        body = {"previous_memory_id": old["memory_id"], "expected_revision": old["revision"]}
        status, result = self.backend.request(operation, body)
        self.assertEqual(status, 200, result)
        current = self._get(self.backend, prefix + "/memories")["memories"]
        self.assertEqual([item["text"] for item in current], ["已参加完这次读书会。"])
        self.assertEqual(current[0]["adoption_method"], "manual")
        self.assertEqual(current[0]["supersedes_memory_id"], old["memory_id"])
        self.assertEqual(self.backend.request(operation, body), (200, result))
        self.assertEqual(self.backend.request(operation, {**body, "expected_revision": old["revision"] + 1})[0], 409)
        self.assertEqual(self._get(self.backend, prefix + "/memories")["memories"], current)
        history = self._get(self.backend, prefix + f"/memories/{current[0]['memory_id']}/versions")["versions"]
        self.assertEqual([item["text"] for item in history], ["已参加完这次读书会。", "计划参加这次读书会。"])

    def test_explicit_update_requires_the_complete_current_correction_decision_set(self):
        for subject in ("contact", "self"):
            with self.subTest(subject=subject):
                first = self.import_event(
                    original="合成依据：我喜欢参加读书会。", claim="喜欢参加读书会。",
                    when="2026-08-01T10:00:00+08:00", subject=subject,
                )
                prefix = f"/api/contacts/{first['contact_id']}"
                first_candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
                old = self.backend.request(prefix + f"/memory-candidates/{first_candidate['candidate_id']}/confirm", {})[1]["memory"]
                memories = "/api/memories/owner" if subject == "self" else prefix + "/memories"
                status, corrected = self.backend.request(memories + f"/{old['memory_id']}/correct", {
                    "text": "用户核对：只是工作需要参加读书会。",
                })
                self.assertEqual(status, 200, corrected)
                current = corrected["memory"]
                self.import_event(
                    original="合成新依据：现在我真的开始喜欢参加读书会。", claim="喜欢参加读书会。",
                    when="2026-08-02T10:00:00+08:00", subject=subject, contact_id=first["contact_id"],
                )
                candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
                decision_ids = [item["decision_id"] for item in candidate["correction_review"]]
                self.assertTrue(decision_ids)
                path = prefix + f"/memory-candidates/{candidate['candidate_id']}/apply-update"
                body = {"previous_memory_id": current["memory_id"], "expected_revision": current["revision"]}
                for review in (None, [], [str(uuid4())]):
                    status, result = self.backend.request(path, {**body, **({"correction_decision_ids": review} if review is not None else {})})
                    self.assertEqual((status, result), (409, {"error": "memory_correction_conflict"}))
                body["correction_decision_ids"] = decision_ids
                status, result = self.backend.request(path, body)
                self.assertEqual(status, 200, result)
                self.assertEqual(result["memory"]["adoption_method"], "manual")
                self.assertEqual(result["memory"]["supersedes_memory_id"], current["memory_id"])
                self.assertEqual(self.backend.request(path, body), (200, result))

    def test_event_stage_evolution_keeps_independent_sources_and_manual_version_history(self):
        old = None
        prefix = None
        expected = []
        for index, stage in enumerate(("planned", "agreed", "rescheduled", "cancelled", "occurred", "unknown"), 1):
            source = f"合成第{index}次说明：阶段{stage}；" + (
                "2026-08-05T09:00:00+08:00至2026-08-05T11:00:00+08:00的读书会。"
                if stage != "unknown" else "活动情况和发生时间尚不清楚。"
            )
            imported = self.import_event(
                original=source, claim=f"读书会阶段为{stage}。", when=f"2026-08-0{index}T10:00:00+08:00",
                contact_id=None if prefix is None else imported["contact_id"],
                event_spec={"stage": stage, **({"occurrence_start": "2026-08-05T09:00:00+08:00",
                            "occurrence_end": "2026-08-05T11:00:00+08:00"} if stage != "unknown" else {})},
                event_verification={"stage_verdict": "supported" if stage != "unknown" else "uncertain",
                                    "occurrence_verdict": "supported" if stage != "unknown" else "uncertain"},
                fact_overrides={"speech_act": "plan" if stage == "planned" else "assertion"},
            )
            prefix = f"/api/contacts/{imported['contact_id']}"
            candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
            expected.append(candidate["event"])
            self.assertEqual(candidate["event"]["stage"], stage)
            self.assertEqual(candidate["event"]["stage_evidence"][0]["message_id"], imported["message"]["message_id"])
            self.assertEqual(candidate["event"]["stage_verified"], stage != "unknown")
            path = prefix + f"/memory-candidates/{candidate['candidate_id']}/" + ("confirm" if old is None else "apply-update")
            body = {} if old is None else {"previous_memory_id": old["memory_id"], "expected_revision": old["revision"]}
            status, result = self.backend.request(path, body)
            self.assertEqual(status, 200, result)
            old = result["memory"]
            self.assertEqual(old["adoption_method"], "manual")
            self.assertIsNone(old["valid_at"])
            self.assertIsNone(old["invalid_at"])
            self.assertFalse(old["can_revert_auto_update"])
        reopened = self._backend(self.owner_id)
        versions = self._get(reopened, prefix + f"/memories/{old['memory_id']}/versions")["versions"]
        self.assertEqual([item["event"] for item in versions], list(reversed(expected)))

    def test_deleting_current_event_erases_all_historical_event_and_restore_proofs(self):
        for subject in ("contact", "self"):
            with self.subTest(subject=subject):
                first = self.import_event(
                    original="合成来源：计划参加2026-08-05T09:00:00+08:00的读书会。",
                    claim="计划参加读书会。", when="2026-08-01T10:00:00+08:00", subject=subject,
                    event_spec={"stage": "planned", "occurrence_start": "2026-08-05T09:00:00+08:00"},
                    event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
                )
                prefix = f"/api/contacts/{first['contact_id']}"
                candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
                old = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/confirm", {})[1]["memory"]
                self.import_event(
                    original="合成来源：已参加2026-08-05T09:00:00+08:00的读书会。",
                    claim="已参加读书会。", when="2026-08-06T10:00:00+08:00", subject=subject, contact_id=first["contact_id"],
                    event_spec={"stage": "occurred", "occurrence_start": "2026-08-05T09:00:00+08:00"},
                    event_verification={"stage_verdict": "supported", "occurrence_verdict": "supported"},
                )
                candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
                status, applied = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/apply-update", {
                    "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
                })
                self.assertEqual(status, 200, applied)
                current = applied["memory"]
                path = "/api/memories/owner" if subject == "self" else prefix + "/memories"
                self.assertEqual(self.backend.request(path + f"/{old['memory_id']}/delete", {})[0], 409)
                self.assertEqual(self.backend.request(path + f"/{current['memory_id']}/delete", {})[0], 200)
                self.assertEqual(self._backend(self.owner_id).request(path + f"/{current['memory_id']}/versions")[0], 404)
                table = "confirmed_memory" if subject == "contact" else "owner_memory"
                with psycopg.connect(self.database_url) as connection:
                    residual = connection.execute(sql.SQL(
                        "SELECT count(*) FROM public.{} memory WHERE owner_id=%s AND id=ANY(%s::uuid[]) "
                        "AND (event IS NOT NULL OR version_evidence IS NOT NULL OR text_content<>'已删除的资料')"
                    ).format(sql.Identifier(table)), (self.owner_id, [old["memory_id"], current["memory_id"]])).fetchone()[0]
                self.assertEqual(residual, 0)

    def _manual_update_erasure(self, *, subject: str, removed: str) -> None:
        first = self.import_event(
            original="合成计划：准备参加这次读书会。", claim="计划参加这次读书会。",
            when="2026-08-01T10:00:00+08:00", subject=subject, fact_overrides={"speech_act": "plan"},
        )
        prefix = f"/api/contacts/{first['contact_id']}"
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        status, result = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/confirm", {})
        self.assertEqual(status, 200, result)
        old = result["memory"]
        second = self.import_event(
            original="合成新依据：刚才参加完之前计划的那次读书会。", claim="已参加完这次读书会。",
            when="2026-08-02T10:00:00+08:00", contact_id=first["contact_id"], subject=subject,
        )
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        status, result = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/apply-update", {
            "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
        })
        self.assertEqual(status, 200, result)
        current = result["memory"]
        source = first["source"] if removed == "old" else second["source"]
        self.delete_source(first["contact_id"], source["source_id"])
        path = "/api/memories/owner" if subject == "self" else prefix + "/memories"
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, path)["memories"], [])
        self.assertEqual(reopened.request(f"{path}/{current['memory_id']}/versions")[0], 404)
        self.assertEqual(reopened.request(f"{path}/{current['memory_id']}/revert-auto-update", {
            "expected_revision": current["revision"],
        })[0], 404)

    def test_manual_contact_update_is_erased_with_its_old_source(self):
        self._manual_update_erasure(subject="contact", removed="old")

    def test_manual_contact_update_is_erased_with_its_new_source(self):
        self._manual_update_erasure(subject="contact", removed="new")

    def test_manual_owner_update_is_erased_with_its_old_contact_source(self):
        self._manual_update_erasure(subject="self", removed="old")

    def test_manual_owner_update_is_erased_with_its_new_contact_source(self):
        self._manual_update_erasure(subject="self", removed="new")

    def test_owner_manual_entry_can_be_explicitly_updated_without_treating_its_owner_anchor_as_chat(self):
        entry = {"text": "我计划参加这次读书会。", "category": "relationship_note"}
        status, result = self.backend.request("/api/memories/manual-owner", entry)
        self.assertEqual(status, 200, result)
        old = result["memory"]
        self.assertEqual(old["source_ids"], [str(self.owner_id)])
        imported = self.import_event(
            original="合成本人新依据：我刚才参加完之前计划的那次读书会。",
            claim="我已参加完这次读书会。", when="2026-08-02T10:00:00+08:00", subject="self",
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        operation = prefix + f"/memory-candidates/{candidate['candidate_id']}/apply-update"
        body = {"previous_memory_id": old["memory_id"], "expected_revision": old["revision"]}
        other_status, other = self.other_backend.request("/api/memories/manual-owner", entry)
        self.assertEqual(other_status, 200, other)
        self.assertEqual(self.backend.request(operation, {**body, "previous_memory_id": other["memory"]["memory_id"]})[0], 404)
        # 仅注入无效数据库输入；业务是否拒绝仍从公开 HTTP 与当前资料观察。
        try:
            for forged_id in (self.owner_id, self.other_owner_id):
                with psycopg.connect(self.database_url) as connection:
                    connection.execute(
                        "UPDATE public.memory_candidate SET source_ids=ARRAY[%s]::uuid[] WHERE id=%s",
                        (forged_id, candidate["candidate_id"]),
                    )
                self.assertEqual(self.backend.request(operation, body)[0], 404)
                self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], [old])
        finally:
            with psycopg.connect(self.database_url) as connection:
                connection.execute("UPDATE public.memory_candidate SET source_ids=%s::uuid[] WHERE id=%s",
                                   (candidate["source_ids"], candidate["candidate_id"]))
        status, result = self.backend.request(operation, body)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.backend.request(operation, body), (200, result))
        current = result["memory"]
        self.assertEqual(current["adoption_method"], "manual")
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], [current])
        history_path = f"/api/memories/owner/{current['memory_id']}/versions"
        history = self._get(self.backend, history_path)["versions"]
        self.assertEqual([item["text"] for item in history], [current["text"], old["text"]])
        self.delete_source(imported["contact_id"], imported["source"]["source_id"])
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, "/api/memories/owner")["memories"], [])
        self.assertEqual(reopened.request(history_path)[0], 404)
        self.assertEqual(reopened.request(f"/api/memories/owner/{current['memory_id']}/revert-auto-update", {
            "expected_revision": current["revision"],
        })[0], 404)
        retained = self._get(reopened, f"/api/memories/owner/{old['memory_id']}/versions")["versions"]
        self.assertEqual([(item["text"], item["adoption_method"], item["source_ids"]) for item in retained],
                         [(old["text"], "manual", [str(self.owner_id)])])

    def test_deleted_owner_manual_root_cannot_be_used_by_current_or_late_reply_generation(self):
        status, added = self.backend.request("/api/memories/manual-owner", {
            "text": "我计划参加这次读书会。", "category": "relationship_note",
        })
        self.assertEqual(status, 200, added)
        old = added["memory"]
        imported = self.import_event(
            original="合成本人新依据：我刚才参加完之前计划的那次读书会。",
            claim="我已参加完这次读书会。", when="2026-08-02T10:00:00+08:00", subject="self",
            acknowledgement="读书会怎么样？",
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        status, applied = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/apply-update", {
            "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
        })
        self.assertEqual(status, 200, applied)
        current = applied["memory"]
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(imported["contact_id"]),
                                     channel="wechat", account_scope=f"synthetic-{self.owner_id}",
                                     conversation_locator=f"synthetic-{imported['contact_id']}")
        body = {"contact_id": imported["contact_id"], "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "读书会怎么样？", "include_relationship_context": True}}
        plan = {"text": "参加读书会感觉怎么样？", "basis": "依据已确认的本人资料询问。",
                "citation_ids": [current["memory_id"]]}
        self.reply_model.plans.append(plan)
        status, reply = self.backend.request("/api/reply/generate", body)
        self.assertEqual(status, 200, reply)
        evidence = self._get(self.backend, prefix + f"/replies/{reply['reply_request_id']}/evidence")["evidence"]
        self.assertTrue(any(item["kind"] == "owner_memory" and item["evidence_id"] == current["memory_id"]
                            for item in evidence))
        self.assertEqual(self.backend.request("/api/reply/generate", body), (200, reply))
        child_body = {**body, "idempotency_key": str(uuid4()),
                      "continued_from_candidate_id": reply["candidates"][0]["candidate_id"]}
        self.reply_model.plans.append(plan)
        status, child = self.backend.request("/api/reply/generate", child_body)
        self.assertEqual(status, 200, child)
        self.assertEqual(self.backend.request("/api/reply/generate", child_body), (200, child))
        self.assertEqual(self.backend.request(prefix + f"/replies/{child['reply_request_id']}/evidence")[0], 200)
        target = next(item for item in self._get(self.backend, prefix + "/messages")["messages"]
                      if item["speaker"] == "contact")
        message_body = {"contact_id": imported["contact_id"], "idempotency_key": str(uuid4()),
                        "content": {"type": "reply_to_message", "target_message_id": target["message_id"],
                                    "direction": "自然回应读书会的情况。"}}
        self.reply_model.plans.append(plan)
        status, message_reply = self.backend.request("/api/reply/generate", message_body)
        self.assertEqual(status, 200, message_reply)
        message_evidence = self._get(self.backend, prefix + f"/replies/{message_reply['reply_request_id']}/evidence")["evidence"]
        self.assertEqual(message_evidence[0]["kind"], "message")
        self.assertTrue(any(item["kind"] == "owner_memory" and item["evidence_id"] == current["memory_id"]
                            for item in message_evidence[1:]))
        self.assertEqual(self.backend.request("/api/reply/generate", message_body), (200, message_reply))
        status, session = self.backend.request(prefix + "/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        session_path = prefix + f"/assistant-sessions/{session['session_id']}"
        session_body = {**body, "idempotency_key": str(uuid4())}
        self.reply_model.plans.append(plan)
        status, session_reply = self.backend.request(session_path + "/replies", session_body)
        self.assertEqual(status, 200, session_reply)
        self.assertEqual(self.backend.request(session_path + "/replies", session_body), (200, session_reply))
        self.assertEqual(self._get(self.backend, session_path)["turns"][-1]["reply"]["reply_request_id"],
                         session_reply["reply_request_id"])
        self.reply_model.plans.append(plan)
        self.reply_model.entered.clear()
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.backend.request, "/api/reply/generate", {**body, "idempotency_key": str(uuid4())})
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                self.assertEqual(self.backend.request(f"/api/memories/owner/{old['memory_id']}/delete", {})[0], 409)
                self.assertEqual(self.backend.request(f"/api/memories/owner/{current['memory_id']}/delete", {})[0], 200)
                listed = self._get(self.backend, "/api/memories/owner")["memories"]
                history_status = self.backend.request(f"/api/memories/owner/{current['memory_id']}/versions")[0]
            finally:
                gate.set()
            late_status, late = future.result(timeout=10)
        self.assertEqual(listed, [], "手录根已删除的派生版本不能继续出现在当前本人资料。")
        self.assertEqual(history_status, 404)
        self.assertNotEqual(late_status, 200, late)
        for label, previous, replay_body in (
            ("message_first", message_reply, message_body), ("rewrite", reply, body), ("continued", child, child_body),
        ):
            self.assertEqual(self.backend.request(prefix + f"/replies/{previous['reply_request_id']}/evidence")[0], 404, label)
            self.assertNotEqual(self.backend.request("/api/reply/generate", replay_body)[0], 200)
            continued = {**body, "idempotency_key": str(uuid4()),
                         "continued_from_candidate_id": previous["candidates"][0]["candidate_id"]}
            self.assertNotEqual(self.backend.request("/api/reply/generate", continued)[0], 200)
        saved_session = self._get(self.backend, session_path)
        self.assertIn(saved_session["turns"][-1]["state"], ("unavailable", "redacted"))
        self.assertIsNone(saved_session["turns"][-1]["reply"])
        self.assertIsNone(saved_session["inputs"][-1]["content"])
        self.assertNotEqual(self.backend.request(session_path + "/replies", session_body)[0], 200)
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, "/api/memories/owner")["memories"], [])
        self.reply_model.plans.append(plan)
        status, rejected = reopened.request("/api/reply/generate", {**body, "idempotency_key": str(uuid4())})
        self.assertNotEqual(status, 200, rejected)

    def test_mixed_owner_reply_keeps_real_chat_deletion_dependencies(self):
        status, added = self.backend.request("/api/memories/manual-owner", {
            "text": "我计划参加这次读书会。", "category": "relationship_note",
        })
        self.assertEqual(status, 200, added)
        old = added["memory"]
        imported = self.import_event(
            original="合成本人新依据：我刚才参加完之前计划的那次读书会。",
            claim="我已参加完这次读书会。", when="2026-08-02T10:00:00+08:00", subject="self",
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        status, applied = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/apply-update", {
            "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
        })
        self.assertEqual(status, 200, applied)
        current = applied["memory"]
        self.bindings.create_binding(owner_id=self.owner_id, contact_id=UUID(imported["contact_id"]),
                                     channel="wechat", account_scope=f"synthetic-{self.owner_id}",
                                     conversation_locator=f"synthetic-{imported['contact_id']}")
        status, session = self.backend.request(prefix + "/assistant-session/default", {})
        self.assertEqual(status, 200, session)
        session_path = prefix + f"/assistant-sessions/{session['session_id']}"
        body = {"contact_id": imported["contact_id"], "idempotency_key": str(uuid4()),
                "content": {"type": "rewrite_draft", "draft_text": "读书会怎么样？", "include_relationship_context": True}}
        plan = {"text": "读书会的感受怎么样？", "basis": "依据仍有效的本人资料询问。",
                "citation_ids": [current["memory_id"]]}
        self.reply_model.plans.append(plan)
        status, generated = self.backend.request(session_path + "/replies", body)
        self.assertEqual(status, 200, generated)
        self.assertEqual(self.backend.request(session_path + "/replies", body), (200, generated))
        style_path = prefix + "/style-samples"
        status, saved = self.backend.request(style_path, {
            "idempotency_key": str(uuid4()), "text": "合成保存：想听听读书会的感受。",
            "origin": {"kind": "candidate", "id": generated["candidates"][0]["candidate_id"]},
        })
        self.assertEqual(status, 200, saved)
        self.assertEqual(set(saved["sample"]["source_ids"]), {
            imported["message"]["message_id"], imported["source"]["source_id"],
        })
        self.reply_model.plans.append(plan)
        self.reply_model.entered.clear()
        gate = self.reply_model.pause_next_response()
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(self.backend.request, session_path + "/replies", {
                **body, "idempotency_key": str(uuid4()),
            })
            try:
                self.assertTrue(self.reply_model.entered.wait(5))
                self.assertEqual(self.backend.request(prefix + f"/sources/{imported['source']['source_id']}", method="DELETE")[0], 202)
                self.assertEqual(self.backend.request(prefix + f"/replies/{generated['reply_request_id']}/evidence")[0], 404)
                self.assertEqual(self._get(self.backend, style_path)["samples"], [])
                self.assertNotEqual(self.backend.request(session_path + "/replies", body)[0], 200)
            finally:
                gate.set()
            late_status, late = future.result(timeout=10)
        self.assertNotEqual(late_status, 200, late)
        self.delete_source(imported["contact_id"], imported["source"]["source_id"])
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, "/api/memories/owner")["memories"], [])
        self.assertEqual(reopened.request(f"/api/memories/owner/{current['memory_id']}/versions")[0], 404)
        self.assertEqual(self._get(reopened, style_path)["samples"], [])
        self.assertNotEqual(reopened.request(session_path + "/replies", body)[0], 200)
        turns = self._get(reopened, session_path)["turns"]
        self.assertTrue(all(item["state"] == "redacted" and item["reply"] is None for item in turns))
        retained = self._get(reopened, f"/api/memories/owner/{old['memory_id']}/versions")["versions"]
        self.assertEqual([item["text"] for item in retained], [old["text"]])

    def test_deleting_the_manual_owner_root_hides_its_derived_version_after_restart(self):
        status, added = self.backend.request("/api/memories/manual-owner", {
            "text": "我计划参加这次读书会。", "category": "relationship_note",
        })
        self.assertEqual(status, 200, added)
        old = added["memory"]
        imported = self.import_event(
            original="合成本人新依据：我刚才参加完之前计划的那次读书会。",
            claim="我已参加完这次读书会。", when="2026-08-02T10:00:00+08:00", subject="self",
        )
        prefix = f"/api/contacts/{imported['contact_id']}"
        candidate = self._get(self.backend, prefix + "/memory-candidates")["candidates"][0]
        status, applied = self.backend.request(prefix + f"/memory-candidates/{candidate['candidate_id']}/apply-update", {
            "previous_memory_id": old["memory_id"], "expected_revision": old["revision"],
        })
        self.assertEqual(status, 200, applied)
        current = applied["memory"]
        self.assertEqual(self.backend.request(f"/api/memories/owner/{old['memory_id']}/delete", {})[0], 409)
        self.assertEqual(self.backend.request(f"/api/memories/owner/{current['memory_id']}/delete", {})[0], 200)
        self.assertEqual(self._get(self.backend, "/api/memories/owner")["memories"], [])
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._get(reopened, "/api/memories/owner")["memories"], [])
        self.assertEqual(reopened.request(f"/api/memories/owner/{current['memory_id']}/versions")[0], 404)


if __name__ == "__main__":
    unittest.main()
