"""每轮生成一次目录显式同步入口的回归测试。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from uuid import uuid4

from notalone.persistence.skill_directory import SkillDirectorySyncError
from notalone.server.reply_wiring import RoundSkillSyncPort


class _RecordingReplyPort:
    def __init__(self, events):
        self._events = events

    def prepare(self, command, *, verified_scope):
        self._events.append(("prepare", verified_scope.owner_id))
        return "prepared"

    def generate(self, command, *, verified_scope):
        self._events.append(("generate", verified_scope.owner_id))
        return "generated"


class RoundSkillSyncPortTest(unittest.TestCase):
    def _port(self, events, *, failure=None):
        def synchronize(owner_id):
            events.append(("sync", owner_id))
            if failure is not None:
                raise failure

        return RoundSkillSyncPort(_RecordingReplyPort(events), synchronize=synchronize)

    def test_each_generation_round_synchronizes_once_before_delegating(self) -> None:
        events: list[tuple[str, object]] = []
        scope = SimpleNamespace(owner_id=uuid4())
        port = self._port(events)

        self.assertEqual(port.generate(command=object(), verified_scope=scope), "generated")
        self.assertEqual(port.prepare(command=object(), verified_scope=scope), "prepared")

        self.assertEqual(
            events,
            [
                ("sync", scope.owner_id),
                ("generate", scope.owner_id),
                ("sync", scope.owner_id),
                ("prepare", scope.owner_id),
            ],
        )

    def test_sync_failure_degrades_with_sanitized_warning_and_round_continues(self) -> None:
        events: list[tuple[str, object]] = []
        scope = SimpleNamespace(owner_id=uuid4())
        port = self._port(
            events, failure=SkillDirectorySyncError("Skill 目录同步失败。")
        )

        with self.assertLogs(
            "notalone.server.reply_wiring", level="WARNING"
        ) as captured:
            self.assertEqual(port.generate(command=object(), verified_scope=scope), "generated")

        self.assertIn("skill_directory_sync_failed", "\n".join(captured.output))
        self.assertNotIn(str(scope.owner_id), "\n".join(captured.output))
        self.assertEqual(events[-1], ("generate", scope.owner_id))


if __name__ == "__main__":
    unittest.main()
