"""真实回环 HTTP 验证导入提交后的原任务自动处理。"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import threading
import time
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

from langchain_core.outputs import ChatGeneration, ChatResult
import psycopg

from notalone.persistence.locks import (
    release_global_worker_lock, try_acquire_global_worker_lock,
)
from notalone.application.import_service import ImportService
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.persistence.postgres_repository import PostgresIngestRepository
from notalone.server.app import create_app

from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, HttpBackend, ScriptedCoreModel, tool_response,
)
from tests.integration.server.background_task_wait import (
    BACKGROUND_TASK_WAIT_SECONDS, wait_for_task,
)


@dataclass
class ModelGate:
    entered: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)


class AutoMemoryModel(ScriptedCoreModel):
    """提交前准备脚本；来源 ID 只从实际模型输入中读取。"""

    gates: dict[int, ModelGate] = {}
    errors: dict[int, Exception] = {}
    call_lock: object = None

    def __init__(self):
        super().__init__()
        self.gates, self.errors = {}, {}
        self.call_lock = threading.Lock()

    def block_call(self, index):
        gate = self.gates[index] = ModelGate()
        return gate

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        del stop, run_manager
        # 协议来自本次Runnable参数，其他线程重新绑定工具不能改写本次调用。
        requested = tuple(tool["function"]["name"] for tool in kwargs.get("tools", ()))
        with self.call_lock:
            index = len(self.seen_calls)
            self.seen_calls.append(messages)
        gate = self.gates.get(index)
        if gate is not None:
            gate.entered.set()
            if not gate.release.wait(60):
                raise TimeoutError("合成模型未在时限内释放。")
        if index in self.errors:
            raise self.errors[index]
        content = str(messages[-1].content)
        if requested == ("GroundedMemoryLabels",):
            labels = {}
            unit_schemas = kwargs["tools"][0]["function"]["parameters"]["properties"]["units"]["properties"]
            for unit, sender, raw in re.findall(
                r"^\[([0-9]+:[0-9]+)\] \[target\] sender=(contact|self) .*? 原文=(.*)$",
                content, re.MULTILINE,
            ):
                preference = re.fullmatch(
                    r"(?:核心验收[^：\n]+：)?我平时喜欢[^。！？!?]+。?", raw,
                )
                label = {
                    "kind": "preference" if preference else "not_memory",
                    "subject": sender, "topic": "other", "dependency": None,
                    "unresolved": False, "confidence": 0.95, "sensitivity": "none",
                }
                # 只在本次协议包含事件字段时返回，兼容独立主线装配。
                if "event" in unit_schemas[unit]["properties"]:
                    label["event"] = None
                labels[unit] = label
            response = tool_response("GroundedMemoryLabels", {"units": labels})
        elif requested == ("MemoryAdjudicationOutput",):
            response = tool_response("MemoryAdjudicationOutput", {
                "action": "add", "replaced_memory_id": None,
            })
        elif requested == ("SourceVerificationOutput",):
            payload = json.loads(content)
            parameters = kwargs["tools"][0]["function"]["parameters"]
            result_properties = parameters["properties"]["results"]["items"]["properties"]
            results = [{
                "candidate_index": candidate["candidate_index"],
                "verdict": "supported", "issues": [],
                "evidence": [{"message_id": candidate["source_message_ids"][0],
                              "quote": next(row["text"]
                                            for row in payload["messages"]
                                            if row["message_id"] == candidate["source_message_ids"][0])}],
            } for candidate in payload["candidates"]]
            if "proof" in result_properties:
                # 本合成偏好不属于有限全文改写证明语法，不能伪造证明。
                for result in results:
                    result["proof"] = None
            response = tool_response("SourceVerificationOutput", {"results": results})
        elif requested == ("MemoryExtractionOutput",):
            matches = re.findall(
                r"\[target\] \[message_id=([0-9a-f-]+)\].*?我平时喜欢([^。]+)。",
                content,
            )
            response = tool_response("MemoryExtractionOutput", {"facts": [{
                "text": f"联系人喜欢{tea}。", "category": "preference",
                "subject": "contact", "topic": "other",
                "source_message_ids": [message_id], "confidence": 0.95,
                "risk_flags": [], "valid_at": None, "invalid_at": None,
                "speech_act": "assertion", "assertion_status": "asserted",
                "figurative_type": "literal", "alternatives": [],
                "interpretation_reason": "联系人直接陈述自己的口味。",
            } for message_id, tea in matches]})
        else:
            raise AssertionError("合成自动导入模型只接受提取、来源核验和裁决协议。")
        return ChatResult(generations=[ChatGeneration(message=response)])


class ImportAutoFlowHttpTest(CoreBusinessFlowFixture, unittest.TestCase):
    extraction_model_factory = AutoMemoryModel
    production_model_wiring = True
    # 本组合核对自动写入后的事务与调度；默认门另沿None装配验证待确认。
    dimension_release = DimensionRelease(gate_enabled=False)

    def setUp(self):
        super().setUp()
        self.executor = ThreadPoolExecutor(max_workers=4)
        self.addCleanup(self.executor.shutdown, wait=True)
        self.addCleanup(self._release_models)

    def _release_models(self):
        for gate in self.extraction_model.gates.values():
            gate.release.set()

    def _import_auto(self, backend, label, tea, *, contact_id=None, offset=0):
        path = Path(self.temporary.name) / f"synthetic-auto-{label}.jsonl"
        external = f"wxid_auto_{label}" if contact_id is None else contact_id[1]
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
        } for number, from_me, text in (
            (1, False, f"核心验收{label}：我平时喜欢{tea}。"),
            (2, True, "好的，我记下了。"),
            (3, False, f"核心验收{label}：一起聊聊{tea}？"),
        )]
        path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in records),
                        encoding="utf-8")
        status, preview = backend.request("/api/imports/preview", {"path": str(path)})
        self.assertEqual(status, 200, preview)
        selection = {"new_contact_name": f"合成联系人{label}"} if contact_id is None else {"contact_id": contact_id[0]}
        body = {"path": str(path), **selection}
        status, imported = backend.request("/api/imports/commit", body)
        self.assertEqual(status, 200, imported)
        self.assertEqual(imported["imported_count"], 3)
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
                "fact_message": next(row for row in messages if f"我平时喜欢{tea}" in row["text"]),
                "target": next(row for row in messages if f"一起聊聊{tea}" in row["text"])}

    def _task(self, backend, imported):
        return self._get(backend, f"/api/tasks/status?contact_id={imported['contact_id']}"
                        f"&task_id={imported['task_id']}")

    def _wait_task(self, backend, imported, expected, *, timeout=BACKGROUND_TASK_WAIT_SECONDS):
        return wait_for_task(backend, imported, expected, timeout=timeout)

    def _memory(self, backend, imported):
        self._wait_task(backend, imported, "succeeded")
        memories = self._get(backend, f"/api/contacts/{imported['contact_id']}/memories")["memories"]
        expected = f"联系人原话：“{imported['fact_message']['text']}”"
        imported["memory"] = next(row for row in memories if row["text"] == expected)
        self.assertEqual(imported["memory"]["adoption_method"], "auto")
        self.assertEqual(imported["memory"]["source_ids"], [imported["fact_message"]["message_id"]])

    def test_confirmed_import_automatically_completes_original_task(self):
        active = self.extraction_model.block_call(0)
        imported = self._import_auto(self.backend, "自动闭环", "茉莉茶")
        self.assertEqual(len(imported["messages"]), 3)
        self.assertTrue(active.entered.wait(1), "提交成功后原任务没有自动进入模型边界。")
        active.release.set()
        self._memory(self.backend, imported)
        self._reply(self.backend, imported)

    def test_default_dimension_release_keeps_automatic_import_candidates_pending(self):
        # 与生产 main 一样不注入维度放行表，仍经相同优先级与追踪装配。
        self.dimension_release = None
        backend = self._backend(self.owner_id)
        imported = self._import_auto(backend, "默认空放行", "茉莉茶")
        self._wait_task(backend, imported, "succeeded")
        contact_id = imported["contact_id"]
        self.assertEqual(
            self._get(backend, f"/api/contacts/{contact_id}/memories")["memories"],
            [],
        )
        candidates = self._get(
            backend, f"/api/contacts/{contact_id}/memory-candidates",
        )["candidates"]
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["text"], f"联系人原话：“{imported['fact_message']['text']}”")
        self.assertEqual(candidates[0]["status"], "pending")
        self.assertEqual(
            candidates[0]["source_ids"], [imported["fact_message"]["message_id"]],
        )

    def test_new_import_while_same_contact_is_active_is_not_lost(self):
        active = self.extraction_model.block_call(0)
        first = self._import_auto(self.backend, "继续排队", "茉莉茶")
        self.assertTrue(active.entered.wait(5))
        second = self._import_auto(
            self.backend, "后续资料", "乌龙茶",
            contact_id=(first["contact_id"], first["external"]), offset=20,
        )
        self.assertNotEqual(first["task_id"], second["task_id"])
        active.release.set()
        self._memory(self.backend, first)
        self._memory(self.backend, second)

    def test_missing_model_configuration_remains_queryable_before_claim(self):
        with patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                   side_effect=ValueError("合成缺配置")):
            imported = self._import_auto(self.backend, "缺配置", "茉莉茶")
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                task = self._task(self.backend, imported)
                if task["error_code"] is not None:
                    break
                threading.Event().wait(0.02)
            self.assertEqual(task["status"], "queued", task)
            self.assertEqual(task["error_code"], "model_configuration_unavailable", task)
            self.assertTrue(all(step["attempt_count"] == 0 for step in task["steps"]))
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._task(reopened, imported), task)
        self.assertEqual(reopened.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (200, {"status": "started"}))
        self._memory(reopened, imported)
        self.assertIsNone(self._task(reopened, imported)["error_code"])

    def test_duplicate_import_keeps_wake_when_explicit_original_task_is_busy(self):
        with patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                   side_effect=ValueError("合成缺配置")):
            imported = self._import_auto(self.backend, "显式与自动合并", "茉莉茶")
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                task = self._task(self.backend, imported)
                if task["error_code"] == "model_configuration_unavailable":
                    break
                threading.Event().wait(0.02)
            self.assertEqual(task["error_code"], "model_configuration_unavailable", task)
        reopened = self._backend(self.owner_id)
        construction = ModelGate()
        self.addCleanup(construction.release.set)
        active = self.extraction_model.block_call(0)

        def construct_model(**kwargs):
            del kwargs
            construction.entered.set()
            if not construction.release.wait(60):
                raise TimeoutError("合成模型构造没有释放。")
            return self.extraction_model

        with psycopg.connect(self.database_url, autocommit=True) as connection:
            self.assertTrue(try_acquire_global_worker_lock(connection))
            with patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                       side_effect=construct_model):
                self.assertEqual(reopened.request("/api/tasks/run", {
                    "contact_id": imported["contact_id"], "task_id": imported["task_id"],
                }), (200, {"status": "started"}))
                self.assertTrue(construction.entered.wait(5))
                status, repeated = reopened.request("/api/imports/commit", {
                    "path": imported["body"]["path"], "contact_id": imported["contact_id"],
                })
                self.assertEqual(status, 200, repeated)
                self.assertEqual(repeated["task_id"], imported["task_id"])
                construction.release.set()
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    host = self._get(reopened, f"/api/tasks/status?contact_id={imported['contact_id']}")
                    if host["progress"]["status"] == "busy":
                        break
                    threading.Event().wait(0.02)
                self.assertEqual(host["progress"]["status"], "busy", host)
                self.assertEqual(self._task(reopened, imported)["status"], "queued")
                release_global_worker_lock(connection)
                self.assertTrue(active.entered.wait(2), "显式 busy 合并的导入唤醒丢失。")
                active.release.set()
                self._memory(reopened, imported)
        self.assertEqual(len(self.extraction_model.seen_calls), 2)

    def test_memory_reply_replay_isolation_and_source_deletion(self):
        imported = self._import_auto(self.backend, "闭环A", "茉莉茶")
        self._memory(self.backend, imported)
        other_contact = self._import_auto(self.backend, "闭环B", "乌龙茶")
        self._memory(self.backend, other_contact)
        other_owner = self._import_auto(self.other_backend, "闭环另一用户", "大红袍")
        self._memory(self.other_backend, other_owner)
        body, reply = self._reply(self.backend, imported)
        reopened = self._backend(self.owner_id)
        calls = len(self.reply_model.seen_calls)
        self.assertEqual(reopened.request("/api/reply/generate", body), (200, reply))
        self.assertEqual(len(self.reply_model.seen_calls), calls)
        for backend, wrong_contact in ((self.backend, other_contact["contact_id"]),
                                       (self.other_backend, imported["contact_id"])):
            path = self._evidence_path(imported, reply).replace(imported["contact_id"], wrong_contact)
            self.assertEqual(backend.request(path), (404, {"error": "not_found"}))
            self.assertEqual(backend.request(
                f"/api/tasks/status?contact_id={wrong_contact}&task_id={imported['task_id']}",
            ), (404, {"error": "task_not_found"}))
        source_path = self._source_path(imported)
        self.assertEqual(self.other_backend.request(source_path, method="DELETE"),
                         (404, {"error": "not_found"}))
        status, deleted = self.backend.request(source_path, method="DELETE")
        self.assertEqual(status, 202, deleted)
        self._wait_deleted(self.backend, imported)
        self.assertEqual(reopened.request(self._evidence_path(imported, reply)),
                         (404, {"error": "not_found"}))
        for backend, preserved in ((self.backend, other_contact),
                                   (self.other_backend, other_owner)):
            self.assertEqual(self._get(backend, f"/api/contacts/{preserved['contact_id']}/messages")["messages"],
                             preserved["messages"])
            self.assertEqual(self._get(backend, f"/api/contacts/{preserved['contact_id']}/memories")["memories"],
                             [preserved["memory"]])

    @staticmethod
    def _source_path(imported):
        return f"/api/contacts/{imported['contact_id']}/sources/{imported['source']['source_id']}"

    def _wait_deleted(self, backend, imported):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            source = self._get(backend, f"/api/contacts/{imported['contact_id']}/sources")["sources"][0]
            if source["status"] == "deleted" and source["task_status"] == "succeeded":
                break
            threading.Event().wait(0.02)
        self.assertEqual(source["status"], "deleted", source)
        self.assertEqual(source["task_status"], "succeeded", source)
        self.assertEqual(self._get(backend, f"/api/contacts/{imported['contact_id']}/messages")["messages"], [])
        self.assertEqual(self._get(backend, f"/api/contacts/{imported['contact_id']}/memories")["memories"], [])

    def test_concurrent_duplicate_commits_merge_original_task_and_terminal_replay(self):
        active = self.extraction_model.block_call(0)
        imported = self._import_auto(self.backend, "并发重复", "茉莉茶")
        self.assertTrue(active.entered.wait(5))
        body = {"path": imported["body"]["path"], "contact_id": imported["contact_id"]}
        replies = [self.executor.submit(self.backend.request, "/api/imports/commit", body)
                   for _ in range(4)]
        for future in replies:
            status, repeated = future.result(timeout=5)
            self.assertEqual(status, 200, repeated)
            self.assertEqual(repeated["task_id"], imported["task_id"])
            self.assertEqual(repeated["skipped_duplicates"], 3)
        active.release.set()
        self._memory(self.backend, imported)
        first = self._task(self.backend, imported)
        self.assertEqual(len(self.extraction_model.seen_calls), 2)
        self.assertEqual(self.backend.request("/api/imports/commit", body)[0], 200)
        following = self._import_auto(self.backend, "重复后的资料", "乌龙茶")
        self._memory(self.backend, following)
        self.assertEqual(self._task(self.backend, imported), first)
        self.assertEqual(len(self.extraction_model.seen_calls), 4)

    def test_new_contact_and_other_owner_wake_while_worker_is_active(self):
        active = self.extraction_model.block_call(0)
        first = self._import_auto(self.backend, "活跃A", "茉莉茶")
        self.assertTrue(active.entered.wait(5))
        second = self._import_auto(self.backend, "活跃B", "乌龙茶")
        other = self._import_auto(self.other_backend, "活跃另一用户", "大红袍")
        self.assertEqual(self._task(self.backend, second)["status"], "queued")
        self.assertEqual(self._task(self.other_backend, other)["status"], "queued")
        active.release.set()
        for backend, imported in ((self.backend, first), (self.backend, second),
                                   (self.other_backend, other)):
            self._memory(backend, imported)

    def test_global_worker_lock_busy_keeps_wake_until_released(self):
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            self.assertTrue(try_acquire_global_worker_lock(connection))
            active = self.extraction_model.block_call(0)
            imported = self._import_auto(self.backend, "全局锁忙", "茉莉茶")
            self.assertFalse(active.entered.wait(0.8))
            task = self._task(self.backend, imported)
            self.assertEqual(task["status"], "queued")
            self.assertEqual(task["retry_count"], 0)
            self.assertTrue(all(step["attempt_count"] == 0 for step in task["steps"]))
            release_global_worker_lock(connection)
            self.assertTrue(active.entered.wait(5))
            active.release.set()
        self._memory(self.backend, imported)
        self.assertEqual(self._task(self.backend, imported)["retry_count"], 0)

    def test_worker_contention_can_outlast_short_wait_without_failing_task(self):
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            self.assertTrue(try_acquire_global_worker_lock(connection))
            released = False
            try:
                imported = self._import_auto(self.backend, "后台排队后完成", "茉莉茶")
                queued = self._task(self.backend, imported)
                self.assertEqual(queued["status"], "queued", queued)
                self.assertEqual(queued["retry_count"], 0)
                # 跨过旧10秒截止；在测试线程释放锁，不跨线程共享PG连接。
                release_at = time.monotonic() + 11
                original_request = self.backend.request

                def request(*args, **options):
                    nonlocal released
                    if not released and time.monotonic() >= release_at:
                        release_global_worker_lock(connection)
                        released = True
                    return original_request(*args, **options)

                with patch.object(self.backend, "request", request):
                    completed = self._wait_task(self.backend, imported, "succeeded")
                self.assertEqual(completed["task_id"], imported["task_id"])
                self.assertEqual(completed["retry_count"], 0)
                self.assertTrue(released, "合成Worker锁没有按计划释放。")
                self.assertTrue(all(step["status"] == "succeeded" for step in completed["steps"]))
                self.assertTrue(all(step["attempt_count"] == 1 for step in completed["steps"]))
            finally:
                if not released:
                    release_global_worker_lock(connection)

    def test_missing_execution_resources_stops_before_claim_with_persistent_reason(self):
        with patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                   side_effect=RuntimeError("合成模型执行资源暂缺")):
            imported = self._import_auto(self.backend, "缺执行资源", "茉莉茶")
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                task = self._task(self.backend, imported)
                if task["error_code"] is not None:
                    break
                threading.Event().wait(0.02)
            self.assertEqual(task["status"], "queued", task)
            self.assertEqual(task["error_code"], "execution_resources_unavailable", task)
            self.assertTrue(all(step["attempt_count"] == 0 for step in task["steps"]))
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._task(reopened, imported), task)
        later = self._import_auto(reopened, "资源恢复后的新资料", "乌龙茶")
        self._memory(reopened, later)
        self.assertEqual(self._task(reopened, imported), task)

    def test_three_model_failures_are_terminal_until_explicit_recovery(self):
        self.extraction_model.errors = {index: RuntimeError("合成供应商暂不可用") for index in range(3)}
        imported = self._import_auto(self.backend, "失败预算", "茉莉茶")
        failed = self._wait_task(self.backend, imported, "failed")
        self.assertEqual(len(self.extraction_model.seen_calls), 3)
        extraction = next(step for step in failed["steps"] if step["name"] == "extract_memory")
        self.assertEqual(extraction["attempt_count"], 3)
        self.assertEqual(self.backend.request("/api/imports/commit", {
            "path": imported["body"]["path"], "contact_id": imported["contact_id"],
        })[0], 200)
        later = self._import_auto(self.backend, "失败后的新资料", "乌龙茶")
        self._memory(self.backend, later)
        self.assertEqual(self._task(self.backend, imported), failed)
        self.assertEqual(self.backend.request("/api/tasks/retry", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (200, {"task_id": imported["task_id"], "status": "queued"}))
        self.assertEqual(self.backend.request("/api/tasks/run", {
            "contact_id": imported["contact_id"], "task_id": imported["task_id"],
        }), (200, {"status": "started"}))
        self._memory(self.backend, imported)
        recovered = self._task(self.backend, imported)
        self.assertEqual([step["attempt_count"] for step in recovered["steps"]], [1, 1, 1, 1, 1])

    def test_new_task_skips_older_queue_and_restart_only_queries_persistent_status(self):
        queued = HttpBackend(create_app(
            database_url=self.database_url, owner_id=self.owner_id, token=self.backend.token,
            import_service=ImportService(repository=PostgresIngestRepository(self.database_url)),
        ), self.owner_id)
        self.addCleanup(queued.close)
        old = self._import_auto(queued, "旧排队资料", "茉莉茶")
        original = self._task(queued, old)
        self.assertEqual(original["status"], "queued")
        self.assertEqual(original["error_code"], "execution_resources_unavailable")
        queued.close()
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._task(reopened, old), original)
        current = self._import_auto(
            reopened, "当前原任务", "乌龙茶",
            contact_id=(old["contact_id"], old["external"]), offset=20,
        )
        self._memory(reopened, current)
        self.assertEqual(self._task(reopened, old), original)
        # 调度固定新任务；既有联系人执行器仍可覆盖同范围有效历史消息。
        self.assertEqual({row["text"] for row in self._get(
            reopened, f"/api/contacts/{old['contact_id']}/memories",
        )["memories"]}, {f"联系人原话：“{item['fact_message']['text']}”" for item in (old, current)})

    def test_shutdown_ends_global_lock_wait_and_restart_does_not_resume_it(self):
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            self.assertTrue(try_acquire_global_worker_lock(connection))
            active = self.extraction_model.block_call(0)
            imported = self._import_auto(self.backend, "关闭排队", "茉莉茶")
            self.assertFalse(active.entered.wait(0.3))
            before = self._task(self.backend, imported)
            started = time.monotonic()
            self.backend.server.shutdown()
            self.assertLess(time.monotonic() - started, 5)
            release_global_worker_lock(connection)
        reopened = self._backend(self.owner_id)
        self.assertEqual(self._task(reopened, imported), before)
        later = self._import_auto(reopened, "重启后的新导入", "乌龙茶")
        self.assertTrue(active.entered.wait(5))
        active.release.set()
        self._memory(reopened, later)
        self.assertEqual(self._task(reopened, imported), before)
        self.assertEqual(self._get(reopened, f"/api/contacts/{imported['contact_id']}/memories")["memories"], [])

    def test_source_deleted_while_waiting_is_not_resurrected_by_original_wake(self):
        with psycopg.connect(self.database_url, autocommit=True) as connection:
            self.assertTrue(try_acquire_global_worker_lock(connection))
            active = self.extraction_model.block_call(0)
            imported = self._import_auto(self.backend, "排队删除", "茉莉茶")
            self.assertFalse(active.entered.wait(0.3))
            self.assertEqual(self.backend.request(self._source_path(imported), method="DELETE")[0], 202)
            cancelled = self._task(self.backend, imported)
            self.assertEqual(cancelled["status"], "cancelled")
            release_global_worker_lock(connection)
        # 删除本身保留原显式继续契约，全局锁忙后再次请求同一删除。
        self.assertEqual(self.backend.request(self._source_path(imported), method="DELETE")[0], 202)
        self._wait_deleted(self.backend, imported)
        later = self._import_auto(self.backend, "删除后的新资料", "乌龙茶")
        self.assertTrue(active.entered.wait(5))
        active.release.set()
        self._memory(self.backend, later)
        self.assertEqual(self._task(self.backend, imported), cancelled)

    def test_shutdown_during_model_call_prevents_later_calls_and_late_memory_write(self):
        active = self.extraction_model.block_call(0)
        following = self.extraction_model.block_call(1)
        imported = self._import_auto(self.backend, "关闭旧调用", "茉莉茶")
        self.assertTrue(active.entered.wait(5))
        waiting = self._import_auto(self.backend, "关闭待处理", "乌龙茶")
        started = time.monotonic()
        self.backend.server.shutdown()
        self.assertLess(time.monotonic() - started, 5)
        active.release.set()
        self.assertFalse(following.entered.wait(0.3))
        reopened = self._backend(self.owner_id)
        self.assertNotEqual(self._task(reopened, imported)["status"], "succeeded")
        self.assertEqual(self._task(reopened, waiting)["status"], "queued")
        self.assertEqual(self._get(reopened, f"/api/contacts/{imported['contact_id']}/memories")["memories"], [])


if __name__ == "__main__":
    unittest.main()
