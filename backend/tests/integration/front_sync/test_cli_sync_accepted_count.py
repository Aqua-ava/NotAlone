"""自动读取抑制后，报告与持久进度只累计实际接受的消息。

使用显式配置的测试库与真实保存、删除、历史和补齐状态；CLI 只返回匿名合成页。
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
import unittest
from uuid import uuid4

import psycopg

from tests.integration.persistence import test_observation_store as observation_tests
from tests.unit.front_sync.test_cli_history_sync import (
    FakeAuthorization,
    FakeHistoryCli,
    _page,
)
from notalone.front_sync.cli_sync import CliBackgroundSync
from notalone.persistence.backfill_state import PostgresBackfillStateStore
from notalone.persistence.history_sync_state import PostgresHistorySyncStateStore
from notalone.persistence.observation_store import ObservationMode
from notalone.wechat_cli.models import MessageIdentifier
from notalone.wechat_cli.normalizer import normalize_cli_events


TEST_DATABASE_URL = observation_tests.TEST_DATABASE_URL


class CliSyncAcceptedCountTest(unittest.TestCase):
    """同页被抑制项不得增加报告、历史检查点或增量补齐的消息数。"""

    setUpClass = classmethod(
        observation_tests.PostgresObservationStoreTest.setUpClass.__func__
    )
    setUp = observation_tests.PostgresObservationStoreTest.setUp
    tearDown = observation_tests.PostgresObservationStoreTest.tearDown

    def _assert_page_count(self, *, history: bool, local_ids: tuple[int, ...]) -> None:
        binding = self.binding_a
        accepted_count = len(local_ids) - 1

        def page(ids: tuple[int, ...], cursor: str):
            result = _page(ids, has_more=False, cursor=cursor, create_time=42)
            return replace(
                result,
                events=tuple(
                    replace(
                        event,
                        message_id=MessageIdentifier(
                            event.message_id.local_id, binding.conversation_locator
                        ),
                    )
                    for event in result.events
                ),
            )

        # 通过真实删除入口建立 local_id=6 的抑制记录。
        seed = page((6,), "synthetic_seed")
        batch = self.store.record_batch_with_messages(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=binding.binding_id,
            mode=ObservationMode.CLI_BACKGROUND,
            cli_version="synthetic",
            conversation_locator=binding.conversation_locator,
            last_local_id=6,
            last_cursor="synthetic_seed",
            record_count=1,
            messages=normalize_cli_events(seed.events),
        )
        self.store.delete_observation(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            observation_id=batch.observation.observation_id,
        )
        result = page(local_ids, uuid4().hex)

        class SyntheticCli(FakeHistoryCli):
            def tail(self, talker: str, **kwargs):
                return result

        history_state = PostgresHistorySyncStateStore(TEST_DATABASE_URL) if history else None
        backfill_state = PostgresBackfillStateStore(TEST_DATABASE_URL) if not history else None
        sync = CliBackgroundSync(
            owner_id=self.owner_id,
            channel="wechat",
            account_scope="synthetic-account",
            cli=SyntheticCli(),
            bindings=(binding,),
            observation_store=self.store,
            history_state=history_state,
            backfill_state=backfill_state,
            history_authorization=FakeAuthorization() if history else None,
            clock=lambda: datetime(1970, 1, 1, tzinfo=timezone.utc),
        )
        if not history:
            sync.request_backfill_check()
        report = sync.cycle(enabled=True, max_bindings=1)

        self.assertIsNone(report.status.failure_code)
        self.assertEqual(report.batch_message_count, accepted_count)
        with psycopg.connect(TEST_DATABASE_URL) as connection:
            saved_count = connection.execute(
                "SELECT count(*) FROM public.message WHERE owner_id=%s AND contact_id=%s",
                (self.owner_id, self.contact_a),
            ).fetchone()[0]
        self.assertEqual(saved_count, accepted_count)

        state_store = history_state if history else backfill_state
        self.assertIsNotNone(state_store)
        saved_state = state_store.read(
            owner_id=self.owner_id,
            contact_id=self.contact_a,
            binding_id=binding.binding_id,
        )
        self.assertIsNotNone(saved_state)
        self.assertEqual(saved_state.message_count, accepted_count)

    def test_incremental_mixed_page_counts_only_accepted_messages(self) -> None:
        self._assert_page_count(history=False, local_ids=(6, 7))

    def test_incremental_fully_filtered_page_counts_zero_messages(self) -> None:
        self._assert_page_count(history=False, local_ids=(6,))

    def test_history_mixed_page_counts_only_accepted_messages(self) -> None:
        self._assert_page_count(history=True, local_ids=(6, 7))

    def test_history_fully_filtered_page_counts_zero_messages(self) -> None:
        self._assert_page_count(history=True, local_ids=(6,))


if __name__ == "__main__":
    unittest.main()
