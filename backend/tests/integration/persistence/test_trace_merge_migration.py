"""合并追踪枚举迁移不修改历史操作，也不接受未定义操作。"""
import os
from pathlib import Path
import unittest
from uuid import uuid4
import psycopg
from psycopg import sql
from notalone.database_migrations import _load_migrations


class TraceMergeMigrationTest(unittest.TestCase):
    def test_merge_operation_preserves_existing_rows_and_rejects_unknown(self):
        url = os.environ.get('NOTALONE_TEST_DATABASE_URL')
        if not url:
            self.skipTest('需要明确隔离测试库')
        with psycopg.connect(url) as connection:
            self.assertTrue(connection.info.dbname.endswith('_test'))
            # 在事务内用临时表遮蔽同名公开表不能验证public迁移；独立schema表
            # 仅替换迁移的schema定位，保留真实约束定义与ALTER操作。
            name = 'trace_merge_' + uuid4().hex
            connection.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(name)))
            connection.execute(sql.SQL("CREATE TABLE {}.memory_extraction_trace_link (operation text NOT NULL CONSTRAINT memory_extraction_trace_link_operation_check CHECK(operation IN ('input','save','invalidate')))").format(sql.Identifier(name)))
            connection.execute(sql.SQL("INSERT INTO {}.memory_extraction_trace_link VALUES ('save')").format(sql.Identifier(name)))
            directory = Path(__file__).resolve().parents[3] / 'database/migrations'
            body = next(m.body for m in _load_migrations(directory) if m.name.startswith('087_'))
            connection.execute(body.replace('public.memory_extraction_trace_link', name + '.memory_extraction_trace_link'))
            connection.execute(sql.SQL("INSERT INTO {}.memory_extraction_trace_link VALUES ('merge')").format(sql.Identifier(name)))
            self.assertEqual(connection.execute(sql.SQL('SELECT operation FROM {}.memory_extraction_trace_link ORDER BY operation').format(sql.Identifier(name))).fetchall(), [('merge',), ('save',)])
            with self.assertRaises(psycopg.errors.CheckViolation):
                with connection.transaction():
                    connection.execute(sql.SQL("INSERT INTO {}.memory_extraction_trace_link VALUES ('arbitrary')").format(sql.Identifier(name)))
            connection.rollback()
