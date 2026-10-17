"""记忆时间公开值对象的合成契约验证。"""

from datetime import datetime, timezone
import unittest

from notalone.memory.timing import MemoryTiming


class MemoryTimingTest(unittest.TestCase):
    def test_partial_source_dates_round_trip_without_inventing_missing_time(self):
        timing = MemoryTiming.from_source_times(
            (datetime(2026, 4, 12, tzinfo=timezone.utc), None,
             datetime(2026, 4, 10, tzinfo=timezone.utc)),
            recorded_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        )

        self.assertEqual(timing.to_payload(), {
            "recorded_at": "2026-05-01T00:00:00+00:00",
            "source_started_at": "2026-04-10T00:00:00+00:00",
            "source_ended_at": "2026-04-12T00:00:00+00:00",
            "source_time_complete": False,
            "current_status": "current_unverified",
            "current_status_reason": "当前未核实；原话和保存时间不能证明状态现在仍成立。",
        })
        self.assertEqual(MemoryTiming.from_payload(timing.to_payload()), timing)
        self.assertEqual(MemoryTiming.from_payload(None), MemoryTiming())

    def test_explicit_malformed_dates_are_rejected_instead_of_becoming_unknown(self):
        unknown = MemoryTiming().to_payload()
        for payload in (
            [], {}, {**unknown, "recorded_at": "2026-04-01T00:00:00"},
            {**unknown, "source_time_complete": "false"},
            {**unknown, "source_started_at": "2026-04-01T00:00:00Z"},
            {**unknown, "source_time_complete": True},
            {**unknown,
             "source_started_at": "2026-04-02T00:00:00Z",
             "source_ended_at": "2026-04-01T00:00:00Z"},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    MemoryTiming.from_payload(payload)

    def test_complete_dates_are_compared_as_instants_across_timezones(self):
        timing = MemoryTiming.from_source_times((
            datetime.fromisoformat("2026-04-01T08:00:00+08:00"),
            datetime.fromisoformat("2026-04-01T02:00:00+00:00"),
        ))
        self.assertTrue(timing.source_time_complete)
        self.assertEqual(timing.source_started_at, datetime(2026, 4, 1, tzinfo=timezone.utc))
        self.assertEqual(timing.source_ended_at, datetime(2026, 4, 1, 2, tzinfo=timezone.utc))
