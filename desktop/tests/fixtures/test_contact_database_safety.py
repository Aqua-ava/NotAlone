"""标准库故障夹具验证：不连接 PostgreSQL，也不导入产品模块。"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class ContactDatabaseSafetyTest(unittest.TestCase):
    def setUp(self):
        self.created = set()
        self.creates = 0
        self.drops = 0
        self.create_error = None
        self.drop_error = None
        state = self

        class SQL:
            def __init__(self, value):
                self.value = value

            def format(self, value):
                return self.value.format('"' + value + '"')

        class Connection:
            def __init__(self, name):
                self.name = name

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def execute(self, query, params=None):
                if query.startswith("CREATE DATABASE"):
                    state.creates += 1
                    if state.create_error is not None:
                        raise state.create_error
                    state.created.add(re.search(r'DATABASE "([a-z0-9_]+)"', query)[1])
                elif query.startswith("DROP DATABASE"):
                    state.drops += 1
                    if state.drop_error is not None:
                        raise state.drop_error
                    state.created.discard(re.search(r'EXISTS "([a-z0-9_]+)"', query)[1])
                elif query != "SELECT current_database()" and not query.lstrip().startswith("INSERT INTO"):
                    raise AssertionError("离线夹具遇到未声明的 SQL。")
                return self

            def fetchone(self):
                return (self.name,)

        def connect(url, **_):
            name = url.removeprefix("host=/tmp dbname=")
            if name != "postgres" and name not in state.created:
                raise AssertionError("离线夹具只接受本轮已确证创建的库。")
            return Connection(name)

        driver = SimpleNamespace(connect=connect, sql=SimpleNamespace(SQL=SQL, Identifier=lambda value: value))
        spec = importlib.util.spec_from_file_location(
            "contact_database_safety_fixture", Path(__file__).with_name("contact-database.py"),
        )
        self.fixture = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"psycopg": driver}):
            spec.loader.exec_module(self.fixture)
        self.temporary = tempfile.TemporaryDirectory(prefix="notalone-contact-marker-offline-")
        self.directory = Path(self.temporary.name)
        self.directory.chmod(0o700)
        self.marker = self.directory / "ownership.json"
        self.addCleanup(self.temporary.cleanup)

    def marker_failure(self, phase, error):
        original = json.dump

        def dump(value, stream, **kwargs):
            if value["phase"] == phase:
                raise error
            return original(value, stream, **kwargs)

        return patch.object(self.fixture.json, "dump", side_effect=dump)

    def test_created_marker_failure_cleans_exact_confirmed_database(self):
        original = OSError("合成 created marker 写入失败")
        with self.marker_failure("created", original), patch.object(self.fixture.subprocess, "run") as migration:
            with self.assertRaises(OSError) as caught:
                self.fixture.create_database("empty", self.marker)
        self.assertIs(caught.exception, original)
        self.assertEqual((self.creates, self.drops, self.created), (1, 1, set()))
        migration.assert_not_called()

    def test_failed_cleanup_preserves_original_marker_error(self):
        original = OSError("合成 created marker 写入失败")
        self.drop_error = RuntimeError("合成已知库清理失败")
        with self.marker_failure("created", original), self.assertRaises(OSError) as caught:
            self.fixture.create_database("empty", self.marker)
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, self.drop_error)
        self.assertEqual((self.creates, self.drops, len(self.created)), (1, 1, 1))
        planned = json.loads(self.marker.read_text())
        self.assertEqual(planned["phase"], "planned")
        self.assertEqual(self.created, {planned["database_name"]})
        self.assertTrue(any("已确证创建" in note and planned["database_name"] in note
                            for note in caught.exception.__notes__))

    def test_created_marker_fsync_and_cleanup_failure_preserve_exact_planned_identity(self):
        original = OSError("合成 created marker 同步失败")
        self.drop_error = RuntimeError("合成已知库清理连接失败")
        sync = self.fixture.os.fsync
        dump = self.fixture.json.dump
        phase = None

        def record_dump(value, stream, **kwargs):
            nonlocal phase
            phase = value["phase"]
            return dump(value, stream, **kwargs)

        def fail_created_sync(descriptor):
            if phase == "created" and stat.S_ISREG(self.fixture.os.fstat(descriptor).st_mode):
                raise original
            return sync(descriptor)

        with patch.object(self.fixture.json, "dump", side_effect=record_dump), \
                patch.object(self.fixture.os, "fsync", side_effect=fail_created_sync):
            with self.assertRaises(OSError) as caught:
                self.fixture.create_database("empty", self.marker)
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, self.drop_error)
        planned = json.loads(self.marker.read_text())
        self.assertEqual(planned["phase"], "planned")
        self.assertEqual((self.creates, self.drops, self.created), (1, 1, {planned["database_name"]}))
        self.assertTrue(any("已确证创建" in note and planned["database_name"] in note
                            for note in caught.exception.__notes__))

    def test_temporary_marker_cleanup_failure_does_not_replace_original_error(self):
        original = OSError("合成 created marker 写入失败")
        self.drop_error = RuntimeError("合成已知库清理失败")
        with self.marker_failure("created", original), \
                patch.object(self.fixture.Path, "unlink", side_effect=OSError("合成临时归属清理失败")):
            with self.assertRaises(OSError) as caught:
                self.fixture.create_database("empty", self.marker)
        self.assertIs(caught.exception, original)
        self.assertIs(caught.exception.__cause__, self.drop_error)
        self.assertTrue(any("合成临时归属清理失败" in note for note in caught.exception.__notes__))
        planned = json.loads(self.marker.read_text())
        self.assertEqual(planned["phase"], "planned")
        self.assertEqual(self.created, {planned["database_name"]})

    def test_create_failure_does_not_authorize_drop(self):
        self.create_error = RuntimeError("合成 CREATE 未确证成功")
        with self.assertRaises(RuntimeError) as caught:
            self.fixture.create_database("empty", self.marker)
        self.assertIs(caught.exception, self.create_error)
        self.assertEqual((self.creates, self.drops, self.created), (1, 0, set()))
        self.assertEqual(json.loads(self.marker.read_text())["phase"], "planned")

    def test_planned_marker_failure_precedes_any_create(self):
        original = OSError("合成 planned marker 写入失败")
        with self.marker_failure("planned", original), self.assertRaises(OSError) as caught:
            self.fixture.create_database("empty", self.marker)
        self.assertIs(caught.exception, original)
        self.assertEqual((self.creates, self.drops, self.created), (0, 0, set()))

    def test_migration_failure_cleans_confirmed_database(self):
        original = RuntimeError("合成迁移调用失败")
        with patch.object(self.fixture.subprocess, "run", side_effect=original), self.assertRaises(RuntimeError) as caught:
            self.fixture.create_database("empty", self.marker)
        self.assertIs(caught.exception, original)
        self.assertEqual((self.creates, self.drops, self.created), (1, 1, set()))

    def test_success_retains_created_marker_for_outer_cleanup(self):
        with patch.object(self.fixture.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            data = self.fixture.create_database("empty", self.marker)
        self.assertEqual((self.creates, self.drops), (1, 0))
        self.assertEqual(self.created, {data["database_name"]})
        self.assertEqual(json.loads(self.marker.read_text())["phase"], "created")


if __name__ == "__main__":
    unittest.main(verbosity=2)
