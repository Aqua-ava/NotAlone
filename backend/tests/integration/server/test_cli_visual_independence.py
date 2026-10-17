"""公开 HTTP、真实同步引擎与隔离 PostgreSQL 的视觉独立性回归。"""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from notalone.conversation.matcher import FrontSessionEvidence
from notalone.front_sync.cli_binding import CliBindingCoordinator
from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.front_sync.foreground_locator import ForegroundLocator
from notalone.front_sync.full_sync_engine import CliFullSyncEngine
from notalone.front_sync.probe_adapter import FrontSessionProbeObservation, FrontSessionQuality
from notalone.persistence.backfill_state import PostgresBackfillStateStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.server.app import create_app
from notalone.server.sync_host import SyncHost
from notalone.wechat_cli import LocalWechatCli
from tests.integration.front_sync.cli_fakes import ScriptedCliRunner, candidate_json, tail_stdout
from tests.integration.server.binding_consent_support import ACCOUNT, create_database, drop_database
from tests.integration.server.core_business_flow_support import HttpBackend


class RecordingProbe:
    """视觉输入适配器只返回合成帧证据，记录两种实际读取入口。"""

    def __init__(self) -> None:
        self.legacy_calls = 0
        self.fresh_calls = 0

    def _observation(self) -> FrontSessionProbeObservation:
        return FrontSessionProbeObservation(
            wechat_in_front=True,
            evidence=FrontSessionEvidence(display_name="合成唯一私聊"),
            quality=FrontSessionQuality("automatic-header-v3", 1.0, name_complete=True),
            captured_at=datetime.now(timezone.utc),
        )

    def observe(self) -> FrontSessionProbeObservation:
        self.legacy_calls += 1
        return self._observation()

    def observe_fresh(self, *, timeout_seconds: float) -> FrontSessionProbeObservation:
        if not 0 < timeout_seconds <= 2.5:
            raise AssertionError("显式观察必须保留有界预算。")
        self.fresh_calls += 1
        return self._observation()


class CliVisualIndependenceHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        environment = patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"})
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory(prefix="notalone-cli-visual-")
        self.addCleanup(directory.cleanup)
        ownership = Path(directory.name) / "database-owned.json"
        fixture = create_database("single-account", ownership)
        self.addCleanup(drop_database, fixture["database_name"], ownership)
        self.database_url = fixture["database_url"]
        self.owner_id = UUID(fixture["owner_id"])
        self.contact_id = UUID(fixture["contact_ids"][0])
        self.locator = "wxid_synthetic_visual_independence"
        bindings = PostgresConversationBindingRepository(self.database_url)
        self.binding = bindings.create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope=ACCOUNT, conversation_locator=self.locator,
            display_name="合成唯一私聊",
        )
        self.runner = ScriptedCliRunner()
        self.runner.sessions_json = [candidate_json(self.locator, "合成唯一私聊")]
        cli = LocalWechatCli(runner=self.runner)
        self.probe = RecordingProbe()
        state = PostgresFrontSyncStateStore(self.database_url)
        background = CliBackgroundSync(
            owner_id=self.owner_id, channel="wechat", account_scope=ACCOUNT,
            cli=cli, bindings=bindings,
            observation_store=PostgresObservationStore(self.database_url),
            backfill_state=PostgresBackfillStateStore(self.database_url), sync_state=state,
        )
        engine = CliFullSyncEngine(
            owner_id=self.owner_id, channel="wechat", account_scope=ACCOUNT,
            cli=cli, sync_state=state, background=background,
            foreground=ForegroundLocator(
                owner_id=self.owner_id, channel="wechat", account_scope=ACCOUNT,
                probe=self.probe, cli=cli, bindings=bindings,
            ),
            binding_coordinator=CliBindingCoordinator(
                owner_id=self.owner_id, channel="wechat", account_scope=ACCOUNT,
                cli=cli, bindings=bindings, batch_repository=bindings,
            ),
            fallback=object(),
        )
        # 不开定时线程，以公开控制请求确定性驱动同一个正式 cycle。
        self.host = SyncHost(engine=engine)
        self.addCleanup(self.host.stop)
        self.backend = HttpBackend(create_app(
            database_url=self.database_url, owner_id=self.owner_id,
            token="synthetic-cli-visual-independence", sync_control=self.host,
        ), self.owner_id)
        self.addCleanup(self.backend.close)

    def _control(self, operation: str) -> dict:
        status, report = self.backend.request("/api/sync/" + operation, {}, method="POST")
        self.assertEqual(status, 200, report)
        self.assertEqual(self.probe.legacy_calls, 0)
        self.assertEqual(report["foreground_failure_code"], "foreground_not_observed")
        self.assertFalse(report["probe_available"])
        self.assertIsNone(report["active_contact_id"])
        self.assertIsNone(report["active_binding_display_name"])
        self.assertIsNone(report["decision_reason"])
        self.assertEqual(report["candidates"], [])
        return report

    def test_background_controls_persist_messages_without_any_visual_read(self) -> None:
        self.runner.tail_queues[self.locator].append(
            tail_stdout(self.locator, [(10, "合成后台第一条消息", False)]),
        )
        enabled = self._control("enable")
        self.assertEqual(enabled["cli_bound_count"], 1)
        self.assertEqual(enabled["cli_batch_message_count"], 1)
        self._control("check")
        self._control("backfill/pause")
        self._control("backfill/retry")
        disabled = self._control("disable")
        self.assertFalse(disabled["sync_enabled"])
        before = len(self.runner.tail_calls)
        self._control("check")
        self.assertEqual(len(self.runner.tail_calls), before)
        self.runner.tail_queues[self.locator].append(
            tail_stdout(self.locator, [(11, "合成重新开启后的补齐消息", True)]),
        )
        resumed = self._control("enable")
        self.assertTrue(resumed["sync_enabled"])
        status, page = self.backend.request(f"/api/contacts/{self.contact_id}/messages")
        self.assertEqual(status, 200, page)
        self.assertEqual({message["text"] for message in page["messages"]},
                         {"合成后台第一条消息", "合成重新开启后的补齐消息"})
        self.assertEqual((self.probe.legacy_calls, self.probe.fresh_calls), (0, 0))
        self.assertIsNone(self.host.last_valid_observation())

    def test_explicit_fresh_observation_matches_binding_without_authorizing_background_identity(self) -> None:
        self._control("enable")
        status, observed = self.backend.request("/api/sync/foreground/observe", {}, method="POST")
        self.assertEqual(status, 200, observed)
        self.assertEqual(observed["phase"], "confirmed")
        self.assertEqual(observed["contact_id"], str(self.contact_id))
        self.assertEqual(observed["binding_id"], str(self.binding.binding_id))
        self.assertEqual((self.probe.legacy_calls, self.probe.fresh_calls), (0, 1))
        self._control("check")
        self.assertEqual((self.probe.legacy_calls, self.probe.fresh_calls), (0, 1))
        self.assertIsNone(self.host.last_valid_observation())


if __name__ == "__main__":
    unittest.main()
