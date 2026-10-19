"""重放历史 Grounded 审核与纠错保护；模型只返回合成标签。"""

import json
from pathlib import Path
import re
import threading
import time
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from langchain_core.outputs import ChatGeneration, ChatResult

from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory_extraction.adjudication import AdjudicationAction, AdjudicationDecision
from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, tool_response
from tests.integration.server.test_import_auto_flow import AutoMemoryModel


class GroundedCorrectionModel(AutoMemoryModel):
    """只替代模型边界；指定全文位置的标签由生产编译器生成候选。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        content = str(messages[-1].content)
        if " 原文=" not in content:
            return super()._generate(messages, stop, run_manager, **kwargs)
        self.seen_calls.append(messages)
        labels = {}
        for unit, sender, raw in re.findall(
            r"\[([0-9]+:[0-9]+)\] \[target\] sender=(contact|self) .*? 原文=(.*)", content,
        ):
            labels[unit] = {"kind": "event" if raw in {"我刚到家。", "我刚刚到家。"} else "not_memory",
                "subject": sender, "topic": "other", "dependency": None, "unresolved": False,
                "confidence": 0.95, "sensitivity": "none", "event": None}
        response = tool_response("GroundedMemoryLabels", {"units": labels})
        return ChatResult(generations=[ChatGeneration(message=response)])


def automatic_fact_text(variant, *, source=False):
    time_word = "刚刚" if variant == "乌龙茶" else "刚"
    return f"{'我' if source else '联系人'}{time_word}到家。"


@contextmanager
def controlled_adjudication(decide):
    """在单项及批量模型边界提供同一决定，保留真实自动写入事务。"""
    def batch(runtime, *, candidates):
        return tuple(decide(runtime, candidate_text=text, similar=similar)
                     for text, similar in candidates)

    with patch.object(LangChainAdjudicationRuntime, "adjudicate", decide), \
            patch.object(LangChainAdjudicationRuntime, "adjudicate_batch", batch):
        yield


class GroundedCorrectionAutomaticHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    """历史审核流程验证事务竞争，显式门回退只在本合成夹具中使用。"""

    extraction_model_factory = GroundedCorrectionModel
    production_model_wiring = True
    # 本组回放旧自动采纳写入边界；当前默认 Direct 流程由独立测试覆盖。
    dimension_release = DimensionRelease(gate_enabled=False)

    def _production_backend(self, owner_id):
        from notalone.tasks.worker import PostgresMemoryExtractionRunner

        def historical_review_runner(database_url, **kwargs):
            # ADR-069 保留历史审核合同；真实 Worker、核验与纠错事务继续执行。
            kwargs["runtime"] = kwargs["runtime"].for_prompt_profile("default")
            return PostgresMemoryExtractionRunner(database_url, **kwargs, automatic=False)

        with patch("notalone.tasks.worker.PostgresMemoryExtractionRunner", historical_review_runner):
            return super()._production_backend(owner_id)

    def _import_auto(self, backend, label, tea, *, contact_id=None, offset=0):
        path = Path(self.temporary.name) / f"synthetic-auto-{label}.jsonl"
        external = f"wxid_auto_{label}" if contact_id is None else contact_id[1]
        fact_text = (f"核心验收{label}：我平时喜欢{tea}。"
                     if getattr(self, "legacy_preference", False)
                     else automatic_fact_text(tea, source=True))
        messages_to_import = [
            (1, getattr(self, "fact_from_me", False), fact_text),
            (2, True, "好的，我记下了。"),
            (3, False, "你刚到家了吗？"),
        ]
        records = [{
            "id": {"local_id": number + offset, "server_id_str": f"server-{number + offset}",
                   "talker": external},
            "create_time": 1786500000 + 60 * (number + offset),
            "is_from_me": from_me, "kind": "text",
            "sender": "合成用户" if from_me else f"合成联系人{label}",
            "sender_wxid": f"wxid_synthetic_{backend.token}" if from_me else external,
            "text": text,
            "time": "2026-08-12",
            "time_iso": datetime.fromtimestamp(
                1786500000 + 60 * (number + offset), tz=timezone.utc,
            ).isoformat(),
        } for number, from_me, text in messages_to_import]
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records),
                        encoding="utf-8")
        status, preview = backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        selection = {"new_contact_name": f"合成联系人{label}"} if contact_id is None else {"contact_id": contact_id[0]}
        body = {"path": str(path), **selection}
        status, imported = backend.request("/api/imports/commit", body)
        self.assertEqual(status, 200, imported)
        self.assertEqual(imported["imported_count"], len(messages_to_import))
        current_contact = imported["contact_id"]
        messages = self._get(backend, f"/api/contacts/{current_contact}/messages")["messages"]
        source = next(row for row in self._get(backend, f"/api/contacts/{current_contact}/sources")["sources"]
                      if row["file_name"] == path.name)
        self.bindings.create_binding(
            owner_id=backend.owner_id, contact_id=UUID(current_contact), channel="wechat",
            account_scope=f"synthetic-account-{backend.token}", conversation_locator=external,
        ) if contact_id is None else None
        return {**imported, "source": source, "messages": messages, "tea": tea,
                "external": external, "body": body,
                "retrieval_query": "到家",
                "reply_text": "好的，欢迎回家。",
                "reply_basis": "回应当前消息，并参考联系人到家的事实。",
                "reply_direction": "自然回应对方到家的消息。",
                "fact_message": next(row for row in messages if row["text"] == fact_text),
                "target": next(row for row in messages if row["text"] == "你刚到家了吗？")}


    def _task(self, backend, imported):
        return self._get(backend, f"/api/tasks/status?contact_id={imported['contact_id']}"
                        f"&task_id={imported['task_id']}")


    def _wait_task(self, backend, imported, expected, *, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            task = self._task(backend, imported)
            if task["status"] == expected:
                return task
            threading.Event().wait(0.02)
        self.fail(f"原任务未进入 {expected}：{task}")


    def test_manual_decision_after_automatic_update_commit_survives_late_steps(self):
        backend = self._backend(self.owner_id)
        first = self._import_auto(backend, "自动更新旧依据", "茉莉茶")
        self._wait_task(backend, first, "succeeded")
        prefix = "/api/contacts/" + first["contact_id"]
        owner_subject = getattr(self, "fact_from_me", False)
        memories = "/api/memories/owner" if owner_subject else prefix + "/memories"
        old = self._get(backend, memories)["memories"][0]
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        store_class = PostgresOwnerMemoryStore if owner_subject else PostgresMemoryStore
        method = "confirm_candidate" if owner_subject else "confirm"
        original = getattr(store_class, method)
        committed = []
        replay_conflicts = []

        def confirm_and_pause(store, *args, **options):
            result = original(store, *args, **options)
            if result is not None:
                committed.append(str(result.memory_id))
                # 模拟首次提交回执未被调用方收到；同一候选重试只能返回同一资料。
                repeated = original(store, *args, **options)
                self.assertEqual(repeated.memory_id, result.memory_id)
                entered.set()
                if not release.wait(15):
                    raise RuntimeError("合成自动提交门超时。")
                # 用户已保存人工决定后，即使候选已被消费，也不能返回新人工叶作 auto。
                with self.assertRaises(MemoryCorrectionConflictError):
                    original(store, *args, **options)
                replay_conflicts.append(True)
            return result

        def update(runtime, *, candidate_text, similar):
            self.assertTrue(similar)
            return AdjudicationDecision(
                action=AdjudicationAction.UPDATE,
                replaced_memory_id=UUID(old["memory_id"]),
            )

        with controlled_adjudication(update), \
                patch.object(store_class, method, confirm_and_pause):
            second = self._import_auto(
                backend, "自动更新新依据", "乌龙茶", offset=100,
                contact_id=(first["contact_id"], first["external"]),
            )
            self.assertTrue(entered.wait(8), "自动更新没有提交新资料。")
            body = {"text": "人工明确决定：刚到家事实需要重新解释。"}
            status, changed = backend.request(memories + "/" + old["memory_id"] + "/correct", body)
            if status == 409:
                # 整体更新已提交时旧 ID 确实过期，用户刷新并纠正当前版本。
                self.assertEqual(changed, {"error": "memory_correction_conflict"})
                self.assertEqual(
                    [row["memory_id"] for row in self._get(backend, memories)["memories"]],
                    committed,
                )
                status, changed = backend.request(memories + "/" + committed[0] + "/correct", body)
            self.assertEqual(status, 200, changed)
            manual = changed["memory"]
            self.assertEqual(manual["adoption_method"], "manual")
            self.assertIn(manual["memory_id"],
                          [row["memory_id"] for row in self._get(backend, memories)["memories"]])
            release.set()
            self._wait_task(backend, second, "succeeded")

        self.assertEqual(replay_conflicts, [True])

        for current in (backend, self._backend(self.owner_id)):
            self.assertEqual(
                [(row["memory_id"], row["text"], row["adoption_method"])
                 for row in self._get(current, memories)["memories"]],
                [(manual["memory_id"], body["text"], "manual")],
                "迟到自动步骤不能失效人工版本或留下第二条当前自动资料。",
            )


    def test_failed_automatic_update_rolls_back_new_memory_and_retry_preserves_manual(self):
        backend = self._backend(self.owner_id)
        first = self._import_auto(backend, "原子失败旧依据", "茉莉茶")
        self._wait_task(backend, first, "succeeded")
        prefix = "/api/contacts/" + first["contact_id"]
        owner_subject = getattr(self, "fact_from_me", False)
        memories = "/api/memories/owner" if owner_subject else prefix + "/memories"
        table = "owner_memory" if owner_subject else "confirmed_memory"
        store_class = PostgresOwnerMemoryStore if owner_subject else PostgresMemoryStore
        confirm_method = "confirm_candidate" if owner_subject else "confirm"
        old = self._get(backend, memories)["memories"][0]
        with psycopg.connect(self.database_url) as connection:
            connection.execute("""CREATE FUNCTION correction_auto_failure() RETURNS trigger
                LANGUAGE plpgsql AS $$ BEGIN
                IF OLD.id=TG_ARGV[0]::uuid AND NEW.status='invalidated' THEN
                    RAISE EXCEPTION '合成自动替代失败';
                END IF;
                RETURN NEW; END $$""")
            connection.execute(sql.SQL(
                "CREATE TRIGGER correction_auto_failure BEFORE UPDATE ON public.{} "
                "FOR EACH ROW EXECUTE FUNCTION correction_auto_failure({})"
            ).format(sql.Identifier(table), sql.Literal(old["memory_id"])))

        def clear_failure():
            with psycopg.connect(self.database_url) as connection:
                connection.execute(sql.SQL("DROP TRIGGER IF EXISTS correction_auto_failure ON public.{}")
                                   .format(sql.Identifier(table)))
                connection.execute("DROP FUNCTION IF EXISTS correction_auto_failure()")

        self.addCleanup(clear_failure)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original_confirm = getattr(store_class, confirm_method)
        original_invalidate = store_class.invalidate

        def pause_failure(call, store, *args, **options):
            try:
                return call(store, *args, **options)
            except Exception:
                entered.set()
                if not release.wait(15):
                    raise RuntimeError("合成失败恢复门超时。")
                raise

        def confirm(store, *args, **options):
            return pause_failure(original_confirm, store, *args, **options)

        def invalidate(store, *args, **options):
            return pause_failure(original_invalidate, store, *args, **options)

        def update(runtime, *, candidate_text, similar):
            self.assertTrue(similar)
            return AdjudicationDecision(action=AdjudicationAction.UPDATE,
                                       replaced_memory_id=UUID(old["memory_id"]))

        with controlled_adjudication(update), \
                patch.object(store_class, confirm_method, confirm), \
                patch.object(store_class, "invalidate", invalidate):
            second = self._import_auto(
                backend, "原子失败新依据", "乌龙茶", offset=100,
                contact_id=(first["contact_id"], first["external"]),
            )
            self.assertTrue(entered.wait(8), "实际失效 SQL 没有遇到合成事务失败。")
            self.assertEqual(
                [row["memory_id"] for row in self._get(backend, memories)["memories"]],
                [old["memory_id"]], "旧行失效失败时不能留下已提交的新自动行。",
            )
            with psycopg.connect(self.database_url) as connection:
                rows = connection.execute(sql.SQL(
                    "SELECT id,status,revision FROM public.{} WHERE owner_id=%s AND status='active'"
                ).format(sql.Identifier(table)), (self.owner_id,)).fetchall()
            self.assertEqual(rows, [(UUID(old["memory_id"]), "active", old["revision"])])
            clear_failure()
            body = {"text": "失败之后用户亲自确定的到家事实。"}
            status, changed = backend.request(memories + "/" + old["memory_id"] + "/correct", body)
            self.assertEqual(status, 200, changed)
            manual_id = changed["memory"]["memory_id"]
            release.set()
            self._wait_task(backend, second, "succeeded")

        for current in (backend, self._backend(self.owner_id)):
            for _ in range(2):
                status, repeated = current.request("/api/imports/commit", second["body"])
                self.assertEqual(status, 200, repeated)
                self.assertEqual(repeated["task_id"], second["task_id"])
                self._wait_task(current, repeated, "succeeded")
            self.assertEqual(
                [(row["memory_id"], row["adoption_method"])
                 for row in self._get(current, memories)["memories"]],
                [(manual_id, "manual")],
            )
            pending = self._get(current, prefix + "/memory-candidates")["candidates"]
            self.assertTrue(all(row["correction_review"] for row in pending))


    def test_manual_decision_before_atomic_update_refuses_stale_automatic_write(self):
        backend = self._backend(self.owner_id)
        first = self._import_auto(backend, "人工优先旧依据", "茉莉茶")
        self._wait_task(backend, first, "succeeded")
        prefix = "/api/contacts/" + first["contact_id"]
        owner_subject = getattr(self, "fact_from_me", False)
        memories = "/api/memories/owner" if owner_subject else prefix + "/memories"
        store_class = PostgresOwnerMemoryStore if owner_subject else PostgresMemoryStore
        method = "confirm_candidate" if owner_subject else "confirm"
        old = self._get(backend, memories)["memories"][0]
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = getattr(store_class, method)

        def confirm_and_pause(store, *args, **options):
            entered.set()
            if not release.wait(15):
                raise RuntimeError("合成自动应用前门超时。")
            return original(store, *args, **options)

        def update(runtime, *, candidate_text, similar):
            self.assertTrue(similar)
            return AdjudicationDecision(action=AdjudicationAction.UPDATE,
                                       replaced_memory_id=UUID(old["memory_id"]))

        with controlled_adjudication(update), \
                patch.object(store_class, method, confirm_and_pause):
            second = self._import_auto(
                backend, "人工优先新依据", "乌龙茶", offset=100,
                contact_id=(first["contact_id"], first["external"]),
            )
            self.assertTrue(entered.wait(8), "实际自动确认没有到达持久化入口。")
            status, changed = backend.request(memories + "/" + old["memory_id"] + "/correct", {
                "text": "用户在自动应用之前明确保存的到家判断。",
            })
            self.assertEqual(status, 200, changed)
            manual_id = changed["memory"]["memory_id"]
            release.set()
            self._wait_task(backend, second, "succeeded")

        for current in (backend, self._backend(self.owner_id)):
            self.assertEqual(
                [(row["memory_id"], row["adoption_method"])
                 for row in self._get(current, memories)["memories"]],
                [(manual_id, "manual")],
            )
            status, replay = current.request("/api/imports/commit", second["body"])
            self.assertEqual(status, 200, replay)
            self.assertEqual(replay["task_id"], second["task_id"])
            self._wait_task(current, replay, "succeeded")
            self.assertEqual([row["memory_id"] for row in self._get(current, memories)["memories"]],
                             [manual_id])


    def test_historical_grounded_protocol_preserves_pending_review(self):
        self.dimension_release = DimensionRelease()
        backend = self._backend(self.owner_id)
        imported = self._import_auto(backend, "默认Grounded门", "茉莉茶")
        self._wait_task(backend, imported, "succeeded")
        prefix = "/api/contacts/" + imported["contact_id"]
        self.assertEqual(self._get(backend, prefix + "/memories")["memories"], [])
        pending = self._get(backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual([row["text"] for row in pending], ["联系人原话：“我刚到家。”"])

    def test_new_grounded_evidence_requires_review_after_user_correction(self):
        backend = self._backend(self.owner_id)
        first = self._import_auto(backend, "Grounded纠错旧证据", "茉莉茶")
        self._wait_task(backend, first, "succeeded")
        prefix = "/api/contacts/" + first["contact_id"]
        memories = "/api/memories/owner" if getattr(self, "fact_from_me", False) else prefix + "/memories"
        old = self._get(backend, memories)["memories"][0]
        status, corrected = backend.request(memories + "/" + old["memory_id"] + "/correct",
                                           {"text": "用户明确纠正：本句含义待核对。"})
        self.assertEqual(status, 200, corrected)
        second = self._import_auto(backend, "Grounded纠错新证据", "乌龙茶", offset=100,
                                  contact_id=(first["contact_id"], first["external"]))
        self._wait_task(backend, second, "succeeded")
        pending = self._get(backend, prefix + "/memory-candidates")["candidates"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["correction_review"][0]["corrected_text"], corrected["memory"]["text"])
        self.assertEqual([row["memory_id"] for row in self._get(backend, memories)["memories"]],
                         [corrected["memory"]["memory_id"]])


class SelfGroundedCorrectionAutomaticHttpTest(GroundedCorrectionAutomaticHttpTest):
    """本人范围沿同一公开入口复验，不把联系人决定跨范围套用。"""

    fact_from_me = True

    def test_historical_grounded_protocol_preserves_pending_review(self):
        self.dimension_release = DimensionRelease()
        backend = self._backend(self.owner_id)
        imported = self._import_auto(backend, "本人默认Grounded门", "茉莉茶")
        self._wait_task(backend, imported, "succeeded")
        self.assertEqual(self._get(backend, "/api/memories/owner")["memories"], [])
        pending = self._get(backend, "/api/contacts/" + imported["contact_id"] + "/memory-candidates")["candidates"]
        self.assertEqual([row["text"] for row in pending], ["用户原话：“我刚到家。”"])
