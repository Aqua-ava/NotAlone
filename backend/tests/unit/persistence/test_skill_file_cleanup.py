"""Skill 文件清理队列的独立回归：异常路径不再查库，失败归因保留。"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import patch
from uuid import uuid4

from notalone.persistence import skill_files


class _FakeCursor:
    def __init__(self, connection: "_FakeConnection") -> None:
        self._connection = connection
        self._rows: list[dict[str, object]] = []

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *_error: object) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> "_FakeCursor":
        normalized = " ".join(sql.split())
        self._connection.queries.append((normalized, params))
        upper = normalized.upper()
        if upper.startswith("SELECT RELATIVE_PATH FROM PUBLIC.REPLY_SKILL_FILE_CLEANUP"):
            self._rows = [dict(row) for row in self._connection.pending]
        elif "FROM PUBLIC.REPLY_SKILL WHERE OWNER_ID = ANY" in upper:
            self._rows = [dict(row) for row in self._connection.skills]
        elif "AND NAME = %S" in upper:
            raise RuntimeError("清理循环内不应再按 owner/name 查库")
        else:
            self._rows = []
        return self

    def fetchall(self) -> list[dict[str, object]]:
        return list(self._rows)

    def fetchone(self) -> dict[str, object] | None:
        return self._rows[0] if self._rows else None


class _FakeConnection:
    """只实现清理路径用到的游标/执行接口，不连接数据库。"""

    def __init__(self, *, pending: list[dict[str, object]], skills: list[dict[str, object]] = ()) -> None:
        self.pending = list(pending)
        self.skills = list(skills)
        self.queries: list[tuple[str, object]] = []

    def cursor(self, row_factory: object = None) -> _FakeCursor:
        return _FakeCursor(self)

    def execute(self, sql: str, params: object = None) -> _FakeCursor:
        self.queries.append((" ".join(sql.split()), params))
        return _FakeCursor(self)


class CleanupPendingFilesTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self._root_setting = patch.dict(
            os.environ, {"NOTALONE_SKILLS_DIR": str(Path(temporary.name) / "skills")}
        )
        self._root_setting.start()
        self.addCleanup(self._root_setting.stop)
        self._failure_table = patch.object(skill_files, "_FILE_FAILURES", {})
        self._failure_table.start()
        self.addCleanup(self._failure_table.stop)
        self.root = skill_files.skills_root()
        self.owner = uuid4()

    def _version_file(self, skill_id: object) -> tuple[str, Path]:
        relative = PurePosixPath(
            ".versions", str(self.owner), str(skill_id), str(uuid4()), "SKILL.md"
        )
        target = self.root.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("synthetic", encoding="utf-8")
        return relative.as_posix(), target

    def test_failure_path_does_not_query_and_keeps_skill_attribution(self) -> None:
        workdir_relative = f"{self.owner}/alpha-skill"
        workdir = self.root / str(self.owner) / "alpha-skill"
        workdir.mkdir(parents=True)
        workdir_skill_id = uuid4()
        versions_relative, versions_target = self._version_file(uuid4())
        connection = _FakeConnection(
            pending=[
                {"relative_path": workdir_relative},
                {"relative_path": versions_relative},
            ],
            skills=[
                {"id": workdir_skill_id, "owner_id": self.owner, "name": "alpha-skill"}
            ],
        )
        original_rmtree = shutil.rmtree

        def _rmtree(path: object, *args: object, **kwargs: object) -> None:
            if "alpha-skill" in str(path):
                raise OSError("synthetic cleanup failure")
            original_rmtree(path, *args, **kwargs)

        with patch.object(skill_files.shutil, "rmtree", side_effect=_rmtree):
            count = skill_files.cleanup_pending_files(connection)

        self.assertEqual(count, 1)
        self.assertFalse(versions_target.exists())
        self.assertTrue(workdir.exists())
        deletes = [query for query in connection.queries if query[0].upper().startswith("DELETE")]
        self.assertEqual([query[1] for query in deletes], [(versions_relative,)])
        self.assertFalse(
            any("AND NAME = %S" in query[0].upper() for query in connection.queries)
        )
        failures = skill_files.read_skill_file_failures(self.owner)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].operation, "cleanup")
        self.assertEqual(failures[0].code, "filesystem_error")
        self.assertEqual(failures[0].skill_id, workdir_skill_id)

    def test_paths_with_skill_identity_skip_database_lookup(self) -> None:
        versions_relative, versions_target = self._version_file(uuid4())
        connection = _FakeConnection(pending=[{"relative_path": versions_relative}])

        count = skill_files.cleanup_pending_files(connection)

        self.assertEqual(count, 1)
        self.assertFalse(versions_target.exists())
        selects = [
            sql for sql, _params in connection.queries if sql.upper().startswith("SELECT")
        ]
        self.assertEqual(len(selects), 1)
        self.assertEqual(skill_files.read_skill_file_failures(self.owner), ())
