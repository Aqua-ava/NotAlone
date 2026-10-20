"""缺表后的本地历史核验只使用合成 SQLite 数据。"""

import json
import sqlite3
import unittest

from notalone.wechat_cli.local_availability import (
    classify_local_history_probe,
    is_exact_missing_message_table,
    local_history_probe_sql,
)


def success(row: dict, **changes: object) -> str:
    data = {"freshness": {"message_source": "live_selected_db_read_only"},
            "query": {"returned": 1, "has_more": False}, "rows": [row]}
    data.update(changes)
    return json.dumps({"ok": True, "data": data})


class LocalHistoryAvailabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE SessionTable (username TEXT PRIMARY KEY,
                last_msg_locald_id INTEGER, last_timestamp INTEGER, summary TEXT);
            CREATE TABLE SessionDeleteTable (username TEXT PRIMARY KEY, delete_time INTEGER);
        """)

    def probe(self, talker: str) -> str | None:
        rows = self.db.execute(local_history_probe_sql(talker)).fetchall()
        self.assertEqual(len(rows), 1)
        return classify_local_history_probe(success(dict(rows[0])))

    def test_exact_failure_rejects_partial_shards_and_other_failures(self) -> None:
        def failure(message: str, **changes: object) -> str:
            value = {"ok": False, "error": {"code": "tool_error", "message": message}}
            value.update(changes)
            return json.dumps(value)

        template = "table Msg_synthetic not found in 4 message shards"
        self.assertTrue(is_exact_missing_message_table(failure(template)))
        for message in ("table Msg_synthetic not found in opened message shards",
                        "table Msg_synthetic not found in 0 message shards",
                        template + "; open shard failed", "missing table", " " + template):
            self.assertFalse(is_exact_missing_message_table(failure(message)))
        for changes in ({"warnings": ["shard open failed"]}, {"data": {"warnings": ["failed"]}},
                        {"ok": True}, {"error": {"code": "other", "message": template}}):
            self.assertFalse(is_exact_missing_message_table(failure(template, **changes)))

    def test_deleted_and_empty_require_evidence_for_selected_locator(self) -> None:
        self.db.execute("INSERT INTO SessionDeleteTable VALUES ('deleted', 1)")
        self.db.execute("INSERT INTO SessionTable VALUES ('empty', 0, 0, '')")
        self.assertEqual(self.probe("deleted"), "local_history_deleted")
        self.assertEqual(self.probe("empty"), "local_history_empty")
        self.assertIsNone(self.probe("unknown"))

    def test_session_messages_or_unknown_watermark_override_delete_marker(self) -> None:
        for local_id, timestamp, summary in ((1, 0, ''), (0, 1, ''), (0, 0, '合成摘要'),
                                             (None, 0, ''), (0, None, ''), (-1, 0, '')):
            with self.subTest(local_id=local_id, timestamp=timestamp, summary=summary):
                self.db.execute("DELETE FROM SessionTable")
                self.db.execute("INSERT OR REPLACE INTO SessionDeleteTable VALUES ('selected', 1)")
                self.db.execute("INSERT INTO SessionTable VALUES ('selected', ?, ?, ?)",
                                (local_id, timestamp, summary))
                self.assertIsNone(self.probe("selected"))

    def test_sql_escapes_locator_and_returns_only_counts(self) -> None:
        talker = "synthetic' OR 1=1 --"
        self.db.execute("INSERT INTO SessionDeleteTable VALUES ('unselected', 1)")
        self.assertIsNone(self.probe(talker))
        self.db.execute("INSERT INTO SessionTable VALUES (?, 0, 0, '')", (talker,))
        self.assertEqual(self.probe(talker), "local_history_empty")
        for invalid in ("", "\x00", "line\nfeed", "x" * 1025):
            with self.assertRaises(ValueError):
                local_history_probe_sql(invalid)

    def test_unknown_stale_warning_and_malformed_results_remain_errors(self) -> None:
        row = {"deleted_count": 1, "session_count": 0, "empty_session_count": 0}
        for change in ({"freshness": {"message_source": "cache"}}, {"freshness": {}},
                       {"query": {"returned": 1, "has_more": True}},
                       {"query": {"returned": True, "has_more": False}},
                       {"rows": []}, {"rows": [row, row]}, {"warnings": ["cache stale"]},
                       {"error": {"message": "failed"}}):
            self.assertIsNone(classify_local_history_probe(success(row, **change)))
        for changed_row in ({**row, "deleted_count": True}, {**row, "deleted_count": "1"},
                            {**row, "session_count": -1}, {**row, "empty_session_count": 1},
                            {**row, "unexpected": "合成私密文本"}):
            self.assertIsNone(classify_local_history_probe(success(changed_row)))
        for stdout in ("", "not json", "[]", '{"ok":false}', '{"ok":true}'):
            self.assertIsNone(classify_local_history_probe(stdout))
            self.assertFalse(is_exact_missing_message_table(stdout))
