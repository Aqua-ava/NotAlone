"""来源处理快照的公开不可变与兼容构造契约。"""

import json
import unittest
from dataclasses import FrozenInstanceError, replace
from uuid import uuid4

from notalone.source_processing.models import ProcessingRecord


class ProcessingRecordTest(unittest.TestCase):
    def test_nested_payload_and_added_fields_are_independent_snapshots(self):
        raw = {"parsed": {"text": "原话🌿", "items": ["原值"]}}
        record = ProcessingRecord.capture("jsonl:1", raw)
        raw["parsed"]["items"].append("外部修改")
        exposed = record.payload()
        exposed["parsed"]["text"] = "查询修改"
        converted = {"labels": ["规范化"]}
        changed = record.with_fields(converted=converted)
        converted["labels"].append("后续修改")
        self.assertEqual(record.payload(), {"parsed": {"text": "原话🌿", "items": ["原值"]}})
        self.assertEqual(changed.payload()["converted"], {"labels": ["规范化"]})
        self.assertEqual(changed.record_id, record.record_id)
        self.assertEqual(changed.locator, "jsonl:1")
        self.assertNotIn("converted", record.payload())
        with self.assertRaises(FrozenInstanceError):
            record.payload_json = "{}"

    def test_three_argument_constructor_and_dataclass_replace_remain_supported(self):
        identity = uuid4()
        record = ProcessingRecord(identity, "synthetic:1", '{ "text" : "兼容正文" }')
        self.assertEqual(record.payload(), {"text": "兼容正文"})
        self.assertEqual(json.loads(record.with_fields(outcome="normalized").payload_json),
                         {"text": "兼容正文", "outcome": "normalized"})
        self.assertEqual(replace(record, payload_json="{}").payload(), {})
