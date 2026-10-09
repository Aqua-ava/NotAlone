"""同一合成观察场景的生产装配预演与显式真实模型验收。"""

import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.runtime_config import load_project_env
from notalone.scopes import ContactScope
from notalone.server.command import _build_task_host
from tests.integration.server.test_import_auto_flow import AutoMemoryModel
from tests.integration.server.test_observation_auto_flow import ObservationAutoFlowFixture


class ObservationModelScenario(ObservationAutoFlowFixture):
    """只替换模型边界；复用生产宿主与观察提交后的发布端口。"""

    message_text = "我平时喜欢科幻小说。"
    task_timeout = 360

    def create_task_host(self):
        host = _build_task_host(self.database_url, self.events, model_priority=self.priority)
        self.assertIsNotNone(host)
        return host

    def setUp(self):
        gate = patch.dict(os.environ, {"NOTALONE_MEMORY_DIMENSION_GATE": "1"})
        gate.start()
        self.addCleanup(gate.stop)
        super().setUp()

    def test_observation_pending_evidence_replay_delete_and_shutdown(self):
        batch = self.record()
        self.publish(batch)
        task = self.wait_task()
        self.assertEqual(task["task_type"], "observation")
        memory = PostgresMemoryStore(self.database_url)
        pending = memory.list_pending_candidates(self.scope)
        self.assertGreaterEqual(len(pending), 1, "合成明确偏好未生成待确认候选。")
        self.assertFalse(memory.list_confirmed(self.scope))
        for candidate in pending:
            self.assertTrue(candidate.source_ids)
            self.assertTrue(set(candidate.source_ids).issubset(set(batch.message_ids)))
        retrieval = PostgresRetrieval(self.database_url, memory_store=memory)
        self.assertTrue(retrieval.search_pending_candidates(scope=self.scope, query="科幻小说"))
        for wrong_scope in (ContactScope(self.scope.owner_id, uuid4()),
                            ContactScope(uuid4(), self.scope.contact_id)):
            self.assertFalse(retrieval.search_pending_candidates(scope=wrong_scope, query="科幻小说"))
        ledger = PostgresOutboundLedger(self.database_url)
        entries = ledger.list_by_owner(self.scope.owner_id)
        self.assertTrue(entries)
        self.publish(batch)
        code, replayed = self.backend.request(
            f"/api/tasks/status?contact_id={self.scope.contact_id}&task_id={task['task_id']}",
        )
        self.assertEqual(code, 200)
        self.assertEqual(replayed, task)
        self.assertEqual(len(ledger.list_by_owner(self.scope.owner_id)), len(entries))
        self.store.delete_observation(
            owner_id=self.scope.owner_id, contact_id=self.scope.contact_id,
            observation_id=batch.observation.observation_id,
        )
        self.assertFalse(retrieval.search_pending_candidates(scope=self.scope, query="科幻小说"))
        code, _ = self.backend.request("/api/runtime/shutdown", {})
        self.assertEqual(code, 200)
        self.publish(batch)
        self.assertEqual(len(ledger.list_by_owner(self.scope.owner_id)), len(entries))


class ObservationModelRehearsalTest(ObservationModelScenario, unittest.TestCase):
    """普通测试只使用脚本模型，验证未来真实调用的同一入口。"""

    task_timeout = 10

    def setUp(self):
        model = patch("notalone.memory_extraction.cli_support.build_deepseek_model",
                      return_value=AutoMemoryModel())
        model.start()
        self.addCleanup(model.stop)
        super().setUp()


class RealObservationModelSmokeTest(ObservationModelScenario, unittest.TestCase):
    """持有 API key 不等于授权；必须另有显式运行开关。"""

    @classmethod
    def setUpClass(cls):
        if os.environ.get("NOTALONE_RUN_REAL_OBSERVATION_SMOKE") != "1":
            raise unittest.SkipTest("未显式启用真实观察模型验收。")
        load_project_env()
        if not os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "").strip():
            raise RuntimeError("真实观察模型验收缺少 NOTALONE_DEEPSEEK_API_KEY。")
        super().setUpClass()
