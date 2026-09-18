"""CLI 文字事件规范化的单元测试：只使用合成事件。"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone

from notalone.wechat_cli.models import CliMessageEvent, MessageIdentifier
from notalone.wechat_cli.normalizer import (
    CliNormalizationError,
    normalize_cli_events,
)


def _event(**overrides) -> CliMessageEvent:
    fields = {
        "message_id": MessageIdentifier(
            local_id=101,
            talker="wxid_synthetic_contact",
            server_id_str="srv-101",
        ),
        "text": "合成文字消息",
        "kind": "text",
        "sender": "合成联系人",
        "sender_wxid": "wxid_synthetic_contact",
        "is_from_me": False,
        "create_time": 1770000000,
        "time": "2026-02-02",
        "time_iso": "2026-02-02T08:00:00+08:00",
    }
    fields.update(overrides)
    return CliMessageEvent(**fields)


class NormalizeCliEventsTest(unittest.TestCase):
    def test_text_event_normalizes_with_stable_identity(self) -> None:
        messages = normalize_cli_events([_event()])

        self.assertEqual(len(messages), 1)
        message = messages[0]
        self.assertEqual(message.source_locator, "cli:101")
        self.assertEqual(message.speaker, "contact")
        self.assertEqual(message.message_type, "text")
        self.assertEqual(message.text_content, "合成文字消息")
        self.assertIsNone(message.media_placeholder)
        self.assertEqual(
            message.occurred_at,
            datetime(2026, 2, 2, 2, 40, tzinfo=timezone.utc),
        )
        assert message.wechat_metadata is not None
        self.assertEqual(message.wechat_metadata.external_local_id, 101)
        self.assertEqual(message.wechat_metadata.external_server_id, "srv-101")
        self.assertEqual(
            message.wechat_metadata.external_talker,
            "wxid_synthetic_contact",
        )
        self.assertEqual(message.wechat_metadata.source_create_time, 1770000000)

    def test_self_message_maps_to_user_speaker(self) -> None:
        messages = normalize_cli_events([_event(is_from_me=True)])

        self.assertEqual(messages[0].speaker, "user")

    def test_contact_message_maps_to_contact_speaker(self) -> None:
        messages = normalize_cli_events([_event(is_from_me=False)])

        self.assertEqual(messages[0].speaker, "contact")

    def test_non_text_event_is_skipped(self) -> None:
        messages = normalize_cli_events(
            [
                _event(kind="image", text="[图片]"),
                _event(),
                _event(kind="voice", text="[语音] 5.2s"),
            ]
        )

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].source_locator, "cli:101")

    def test_blank_text_is_skipped(self) -> None:
        messages = normalize_cli_events([_event(text="   ")])

        self.assertEqual(messages, ())

    def test_missing_create_time_keeps_occurred_at_unknown(self) -> None:
        messages = normalize_cli_events(
            [_event(create_time=None, time_iso=None, time=None)]
        )

        self.assertIsNone(messages[0].occurred_at)
        metadata = messages[0].wechat_metadata
        assert metadata is not None
        self.assertIsNone(metadata.source_create_time)

    def test_time_iso_used_when_create_time_missing(self) -> None:
        messages = normalize_cli_events(
            [_event(create_time=None, time_iso="2026-02-02T08:00:00+08:00")]
        )

        self.assertEqual(
            messages[0].occurred_at,
            datetime(2026, 2, 2, 0, 0, tzinfo=timezone.utc),
        )

    def test_naive_time_iso_is_interpreted_as_utc(self) -> None:
        messages = normalize_cli_events(
            [_event(create_time=None, time_iso="2026-02-02T00:00:00")]
        )

        self.assertEqual(
            messages[0].occurred_at,
            datetime(2026, 2, 2, 0, 0, tzinfo=timezone.utc),
        )

    def test_invalid_time_iso_fails_closed(self) -> None:
        with self.assertRaises(CliNormalizationError):
            normalize_cli_events([_event(create_time=None, time_iso="not-a-time")])

    def test_invalid_create_time_fails_closed(self) -> None:
        with self.assertRaises(CliNormalizationError):
            normalize_cli_events([_event(create_time=10**20)])

    def test_missing_local_id_fails_closed(self) -> None:
        event = _event(
            message_id=MessageIdentifier(
                local_id=0,
                talker="wxid_synthetic_contact",
            )
        )

        with self.assertRaises(CliNormalizationError):
            normalize_cli_events([event])

    def test_invalid_is_from_me_fails_closed(self) -> None:
        with self.assertRaises(CliNormalizationError):
            # dataclass 不做运行时类型检查，None 会绕过类型注解。
            normalize_cli_events([_event(is_from_me=None)])  # type: ignore[arg-type]

    def test_mixed_talkers_fail_closed(self) -> None:
        other = _event(
            message_id=MessageIdentifier(
                local_id=102,
                talker="wxid_synthetic_other",
            )
        )

        with self.assertRaises(CliNormalizationError):
            normalize_cli_events([_event(), other])

    def test_blank_first_talker_still_detects_mixed_batch(self) -> None:
        # 首事件 talker 为空串时，同会话校验不能退化为恒真表达式：
        # 后续其他会话的事件必须仍然触发失败关闭。
        first = _event(
            message_id=MessageIdentifier(
                local_id=101,
                talker="",
            )
        )
        other = _event(
            message_id=MessageIdentifier(
                local_id=102,
                talker="wxid_synthetic_other",
            )
        )

        with self.assertRaises(CliNormalizationError):
            normalize_cli_events([first, other])

    def test_missing_server_id_keeps_identity_without_server_id(self) -> None:
        event = _event(
            message_id=MessageIdentifier(
                local_id=101,
                talker="wxid_synthetic_contact",
                server_id_str=None,
            )
        )
        messages = normalize_cli_events([event])

        metadata = messages[0].wechat_metadata
        assert metadata is not None
        self.assertIsNone(metadata.external_server_id)

    def test_raw_payload_captures_event_evidence(self) -> None:
        event = _event()
        messages = normalize_cli_events([event])

        metadata = messages[0].wechat_metadata
        assert metadata is not None
        payload = json.loads(metadata.raw_payload_json)
        self.assertEqual(payload["message_id"]["local_id"], 101)
        self.assertEqual(payload["message_id"]["talker"], "wxid_synthetic_contact")
        self.assertEqual(payload["is_from_me"], False)
        self.assertEqual(payload["create_time"], 1770000000)

    def test_empty_events_return_empty_batch(self) -> None:
        self.assertEqual(normalize_cli_events([]), ())

    def test_duplicate_local_id_events_are_kept_for_write_side_dedup(self) -> None:
        # 同一事件重复出现时保留两条，由写入路径按稳定身份幂等去重。
        messages = normalize_cli_events([_event(), _event()])

        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0].source_locator, messages[1].source_locator)


if __name__ == "__main__":
    unittest.main()
