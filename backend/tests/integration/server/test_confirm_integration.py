"""绑定确认 API 与真实引擎的整链集成测试。

HTTP→SyncHost→FrontSyncEngine(真实引擎 + 脚本化 fake CLI + 内存探针)
首次绑定确认全链路：候选出现在 status，经 /api/sync/confirm 确认后
写入绑定，后续切换不再要求重复确认。使用真实 PostgreSQL 测试库。
"""

from __future__ import annotations

import os
import unittest
from uuid import UUID, uuid4

import psycopg

from notalone.conversation.matcher import FrontSessionEvidence
from notalone.front_sync import FrontSessionProbeObservation
from notalone.front_sync.probe_adapter import FrontSessionQuality, ProbeAdapterError
from notalone.front_sync.sync_engine import FrontSyncEngine
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.server.app import create_app
from notalone.server.sync_host import SyncHost
from notalone.server.testing import InProcessClient
from notalone.wechat_cli import LocalWechatCli
from tests.integration.front_sync.cli_fakes import (
    ScriptedCliRunner,
    candidate_json as _candidate,
)


TEST_DATABASE_URL = os.environ.get(
    "NOTALONE_TEST_DATABASE_URL",
    "postgresql:///notalone_test",
)

_CHANNEL = "wechat"
_ACCOUNT = "synthetic-confirm-account"
_TALKER = "wxid_front_confirm"
_NAME = "合成确认甲"


class FakeProbe:
    """内存前台探针：由测试直接设置前台状态与证据。"""

    def __init__(self) -> None:
        self.observation = FrontSessionProbeObservation(
            wechat_in_front=False, evidence=None
        )
        self.error: ProbeAdapterError | None = None

    def observe(self) -> FrontSessionProbeObservation:
        if self.error is not None:
            raise self.error
        return self.observation


class ConfirmApiIntegrationTest(unittest.TestCase):
    """验证进程内 HTTP 接缝与真实引擎的确认串接。"""

    @classmethod
    def setUpClass(cls) -> None:
        try:
            with psycopg.connect(TEST_DATABASE_URL) as connection:
                database_name = connection.execute(
                    "SELECT current_database()"
                ).fetchone()[0]
        except psycopg.OperationalError as error:
            raise unittest.SkipTest("本地 PostgreSQL 测试库不可用。") from error
        if not database_name.endswith("_test"):
            raise RuntimeError("集成测试只允许连接名称以 _test 结尾的数据库。")

    def setUp(self) -> None:
        self.owner_id = uuid4()
        self.contact_id = uuid4()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, %s)",
                (self.owner_id, "确认整链用户"),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, %s)",
                (self.owner_id, self.contact_id, "联系人确认甲"),
            )

        self.runner = ScriptedCliRunner()
        self.runner.candidates_by_query[_NAME] = [_candidate(_TALKER, _NAME)]
        self.probe = FakeProbe()
        self.probe.observation = FrontSessionProbeObservation(
            wechat_in_front=True,
            selected_row_name=_NAME,
            quality=FrontSessionQuality("minimal-region-v1", 1, 1),
            evidence=FrontSessionEvidence(
                display_name=_NAME,
                preview_text=None,
            ),
        )
        self.bindings = PostgresConversationBindingRepository(TEST_DATABASE_URL)
        self.sync_state = PostgresFrontSyncStateStore(TEST_DATABASE_URL)
        lifecycle = FrontSyncEngineLifecycleFactory.build(self)
        engine = FrontSyncEngine(
            owner_id=self.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            probe=self.probe,
            lifecycle=lifecycle,
            bindings=self.bindings,
            sync_state=self.sync_state,
            cli=LocalWechatCli(runner=self.runner),
        )
        engine.enable_sync()
        self.host = SyncHost(engine=engine, interval=0.01)
        self.host.start()
        self.app = create_app(
            database_url=TEST_DATABASE_URL,
            owner_id=self.owner_id,
            token="test-token",
            sync_control=self.host,
        )
        self.client = InProcessClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    def tearDown(self) -> None:
        self.host.stop()
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            connection.execute(
                "DELETE FROM public.owner WHERE id = %s",
                (self.owner_id,),
            )

    def _wait_for_candidates(self) -> dict[str, object]:
        """轮询 status 直到出现待确认候选。"""

        deadline = 5.0
        elapsed = 0.0
        while elapsed < deadline:
            response = self.client.get("/api/sync/status", headers=self.headers)
            payload = response.json()
            if payload.get("candidates"):
                return payload
            import time

            time.sleep(0.05)
            elapsed += 0.05
        self.fail("超时未出现待确认候选。")

    # ------------------------------------------------------------------
    # 首次绑定全链路
    # ------------------------------------------------------------------

    def test_first_binding_via_api_then_auto_recognized(self) -> None:
        status = self._wait_for_candidates()
        candidates = status["candidates"]
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["username"], _TALKER)
        self.assertEqual(candidates[0]["display_name"], _NAME)

        body = (
            f'{{"contact_id": "{self.contact_id}",'
            f' "locator": "{_TALKER}"}}'
        ).encode("utf-8")
        response = self.client.request(
            "POST",
            "/api/sync/confirm",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["phase"], "active")
        self.assertEqual(payload["active_contact_id"], str(self.contact_id))
        self.assertEqual(payload["candidates"], [])

        # 确认后触发一轮新的 cycle：同一会话自动识别，不再要求确认。
        self.probe.observation = FrontSessionProbeObservation(
            wechat_in_front=True,
            selected_row_name=_NAME,
            quality=FrontSessionQuality("minimal-region-v1", 1, 1),
            evidence=FrontSessionEvidence(
                display_name=_NAME,
                preview_text=None,
            ),
        )
        response = self.client.request(
            "POST", "/api/sync/check", headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["phase"], "active")
        self.assertEqual(response.json()["candidates"], [])
        self.assertEqual(
            response.json()["active_contact_id"],
            str(self.contact_id),
        )

    def test_confirm_rejection_returns_stable_reason(self) -> None:
        status = self._wait_for_candidates()
        self.assertEqual(len(status["candidates"]), 1)

        body = (
            f'{{"contact_id": "{self.contact_id}",'
            f' "locator": "wxid_not_in_candidates"}}'
        ).encode("utf-8")
        response = self.client.request(
            "POST",
            "/api/sync/confirm",
            headers=self.headers,
            body=body,
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json(),
            {
                "error": "binding_confirmation_rejected",
                "reason": "candidate_not_found",
            },
        )


# 复用 front_sync e2e 的生命周期装配（测试库 + 合成账号范围）。
class FrontSyncEngineLifecycleFactory:
    @staticmethod
    def build(test: ConfirmApiIntegrationTest):
        from notalone.front_sync import TailLifecycle
        from notalone.persistence.observation_store import PostgresObservationStore

        return TailLifecycle(
            owner_id=test.owner_id,
            channel=_CHANNEL,
            account_scope=_ACCOUNT,
            cli=LocalWechatCli(runner=test.runner),
            bindings=test.bindings,
            observation_store=PostgresObservationStore(TEST_DATABASE_URL),
            sync_state=test.sync_state,
        )


if __name__ == "__main__":
    unittest.main()
