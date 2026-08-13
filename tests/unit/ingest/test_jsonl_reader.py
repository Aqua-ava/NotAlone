"""JSONL 文件读取边界测试。"""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.jsonl_reader import read_jsonl


class ReadJsonlTest(unittest.TestCase):
    def test_rejects_file_larger_than_64_mib_before_reading_content(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "oversized.jsonl"
            path.write_bytes(b"12345")

            with patch("notalone.ingest.jsonl_reader.MAX_JSONL_BYTES", 4):
                with self.assertRaisesRegex(ImportPreviewError, "超过 64 MiB"):
                    read_jsonl(path)

    def test_rejects_more_than_500000_records(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "too-many-records.jsonl"
            path.write_bytes(b"{}\n{}\n")

            with patch("notalone.ingest.jsonl_reader.MAX_JSONL_RECORDS", 1):
                with self.assertRaisesRegex(
                    ImportPreviewError,
                    "消息记录超过 1 条",
                ):
                    read_jsonl(path)

    def test_rejects_non_regular_file(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ImportPreviewError, "必须是普通文件"):
                read_jsonl(Path(directory))


if __name__ == "__main__":
    unittest.main()
