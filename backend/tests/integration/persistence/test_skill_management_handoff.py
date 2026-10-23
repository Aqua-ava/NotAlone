"""真实PG验证普通管理停收、目录移交和15既有事务回滚；仅合成资料。"""
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

from notalone.persistence import skill_directory, skill_library
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.skill_management_handoff import SkillManagementHandoff


class SkillManagementHandoffIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.url = os.environ.get('NOTALONE_TEST_DATABASE_URL')
        if not self.url:
            self.skipTest('需要显式合成测试库。')
        with psycopg.connect(self.url) as connection:
            if not connection.execute('SELECT current_database()').fetchone()[0].endswith('_test'):
                raise RuntimeError('仅允许测试库。')
            self.owner = uuid4()
            connection.execute("INSERT INTO owner(id,display_name) VALUES(%s,'合成移交用户')", (self.owner,))
        temporary = TemporaryDirectory(prefix='notalone-skill-handoff-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.enterContext(patch.dict(os.environ, {'NOTALONE_SKILLS_DIR': str(self.root / 'skills')}))
        self.gate = SkillManagementHandoff()
        for module in (skill_library, skill_directory):
            self.enterContext(patch.object(module, 'skill_management_handoff', self.gate))
        self.library = skill_library.PostgresSkillLibrary(self.url)
        self.package = self.root / 'synthetic-skill'
        self.package.mkdir()
        self.document = self.package / 'SKILL.md'
        self.document.write_text('---\nname: synthetic-skill\ndescription: 合成策略\n---\n\n先确认情况。\n')

    def test_stop_blocks_management_but_routes_refresh_without_local_writes(self):
        entry = self.library.import_package(self.owner, self.package)
        before = skill_directory.synchronize_skill_library(self.url, self.owner)
        self.gate.stop()
        with self.assertRaises(skill_library.SkillLibraryPersistenceError):
            self.library.list_owner_skills(self.owner)
        with self.assertRaises(skill_directory.SkillDirectorySyncError):
            skill_directory.synchronize_skill_library(self.url, self.owner)
        calls = []
        self.gate.activate(owner_id=self.owner, synchronize=lambda: calls.append('remote') or before)
        self.assertEqual(skill_directory.synchronize_skill_library(self.url, self.owner), before)
        skill_directory.prepare_skill_directory(self.url, self.owner)
        self.assertEqual(calls, ['remote', 'remote'])
        with psycopg.connect(self.url, row_factory=dict_row) as connection:
            self.assertFalse(skill_directory.synchronize_skill_directory(connection, self.owner, check_only=True))
            self.assertEqual(connection.execute('SELECT revision FROM skill_library WHERE owner_id=%s', (self.owner,)).fetchone()['revision'], before)
            self.assertEqual(connection.execute('SELECT count(*) AS n FROM reply_skill_version WHERE skill_id=%s', (entry.skill_id,)).fetchone()['n'], 1)

    def test_remote_failure_does_not_discover_pending_directory(self):
        self.library.import_package(self.owner, self.package)
        working = self.root / 'skills' / str(self.owner) / 'synthetic-skill' / 'SKILL.md'
        working.write_text(self.document.read_text() + '合成待发现修改。\n')
        self.gate.stop()
        def unavailable():
            raise OSError('合成内部错误不得透传')
        self.gate.activate(owner_id=self.owner, synchronize=unavailable)
        with self.assertRaises(skill_directory.SkillDirectorySyncError):
            skill_directory.synchronize_skill_library(self.url, self.owner)
        with psycopg.connect(self.url) as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM reply_skill_version v JOIN reply_skill s ON s.id=v.skill_id WHERE s.owner_id=%s', (self.owner,)).fetchone()[0], 1)

    def test_existing_transaction_drains_and_15_locked_rollback_remains_available(self):
        first = self.library.import_package(self.owner, self.package)
        self.document.write_text(self.document.read_text() + '合成第二版。\n')
        self.library.update_package(self.owner, self.package)
        entered, release = threading.Event(), threading.Event()
        original = skill_directory.synchronize_skill_directory
        errors = []
        def paused(connection, owner, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('测试未释放')
            return original(connection, owner, **kwargs)
        def refresh():
            try:
                self.library.list_owner_skills(self.owner)
            except Exception as error:
                errors.append(error)
        worker = threading.Thread(target=refresh)
        try:
            with patch.object(skill_directory, 'synchronize_skill_directory', paused):
                worker.start()
                self.assertTrue(entered.wait(1))
                self.assertEqual(self.gate.stop()['state'], 'draining')
                release.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(self.gate.status()['state'], 'stopped')
            with psycopg.connect(self.url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=self.owner)
                result = self.library.rollback_locked(connection, self.owner, first.skill_id, first.version_id)
                self.assertEqual(result.version_id, first.version_id)
        finally:
            release.set()
            worker.join(3)
