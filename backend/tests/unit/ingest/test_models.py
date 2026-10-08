"""跨输入类型的规范消息契约测试。"""

from __future__ import annotations

import unittest

from notalone.ingest.models import NormalizedMessage


class NormalizedMessageTest(unittest.TestCase):
    def test_accepts_text_without_timestamp_or_wechat_metadata(self) -> None:
        message = NormalizedMessage(
            source_locator="manual:1",
            speaker="contact",
            message_type="text",
            text_content="合成手工文字",
            media_placeholder=None,
            occurred_at=None,
            wechat_metadata=None,
        )

        self.assertEqual(message.text_content, "合成手工文字")
        self.assertIsNone(message.occurred_at)
        self.assertIsNone(message.wechat_metadata)

    def test_rejects_message_without_text_or_media_placeholder(self) -> None:
        with self.assertRaisesRegex(ValueError, "正文或媒体占位"):
            NormalizedMessage(
                source_locator="manual:2",
                speaker="contact",
                message_type="text",
                text_content="",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=None,
            )

    def test_accepts_media_placeholder_without_text(self) -> None:
        message = NormalizedMessage(
            source_locator="ocr:3",
            speaker="contact",
            message_type="image",
            text_content="",
            media_placeholder="[图片]",
            occurred_at=None,
            wechat_metadata=None,
        )

        self.assertEqual(message.media_placeholder, "[图片]")
        self.assertEqual(message.text_content, "")

    def test_rejects_empty_source_locator(self) -> None:
        with self.assertRaisesRegex(ValueError, "来源定位"):
            NormalizedMessage(
                source_locator=" ",
                speaker="contact",
                message_type="text",
                text_content="合成文字",
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=None,
            )


if __name__ == "__main__":
    unittest.main()
