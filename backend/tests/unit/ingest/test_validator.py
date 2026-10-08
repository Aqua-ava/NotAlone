"""微信 JSONL 校验器测试。"""

from __future__ import annotations

import unittest
from pathlib import Path

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.jsonl_reader import read_jsonl
from notalone.ingest.validator import validate_records


FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


class ValidateRecordsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.document = read_jsonl(FIXTURES_DIR / "valid_single_contact.jsonl")

    def test_blank_text_is_rejected_with_line_number(self) -> None:
        # 规范消息必须有正文或媒体占位；text 兼作媒体占位，空白 text
        # 必须在校验层按行号拒绝，而不是留到规范化阶段抛未捕获异常。
        for text in ("", "   "):
            with self.subTest(text=repr(text)):
                record = {**self.document.records[0], "text": text}
                with self.assertRaises(ImportPreviewError) as ctx:
                    validate_records((record, self.document.records[1]))
                self.assertIn("第 1 行", str(ctx.exception))
                self.assertIn("text", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
