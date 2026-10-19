"""JSONL 文件读取边界测试。"""

from __future__ import annotations

import unittest
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.jsonl_reader import read_jsonl


class ReadJsonlTest(unittest.TestCase):
    def test_read_without_processing_preserves_bytes_digest_and_records(self) -> None:
        content = '{"text":"合成原话🌿\\n下一行","nested":{"value":1}}\r\n'
        with TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.jsonl"
            path.write_bytes(content.encode("utf-8"))
            document = read_jsonl(path, capture_processing=False)
            captured = read_jsonl(path)
        self.assertEqual(document.records, (json.loads(content),))
        self.assertEqual(document.content_sha256, hashlib.sha256(content.encode("utf-8")).hexdigest())
        self.assertEqual(document.processing_records, ())
        self.assertEqual(captured.processing_records[0].payload()["record_text"], content)

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
