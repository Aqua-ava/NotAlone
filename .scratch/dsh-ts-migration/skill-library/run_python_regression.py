"""只在随机合成测试库运行指定回归，退出时删除自有库及目录。"""
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from uuid import uuid4
import psycopg
from psycopg import sql
from notalone.database_migrations import migrate

root = Path(__file__).resolve().parents[3]
name = 'notalone_skill_handoff_' + uuid4().hex + '_test'
assert name.endswith('_test')
with TemporaryDirectory(prefix='notalone-skill-handoff-') as directory:
    environment = {**os.environ, 'NOTALONE_DISABLE_DOTENV': '1',
                   'NOTALONE_MANAGED_USER_DATA': directory,
                   'NOTALONE_TEST_DATABASE_URL': 'host=/tmp dbname=' + name,
                   'NOTALONE_DATABASE_URL': 'host=/tmp dbname=' + name,
                   'NOTALONE_SKILLS_DIR': directory + '/skills'}
    with psycopg.connect('host=/tmp dbname=postgres', autocommit=True) as admin:
        admin.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
        try:
            migrate('host=/tmp dbname=' + name, root / 'backend/database/migrations')
            result = subprocess.run([sys.executable, '-m', 'unittest', *sys.argv[1:], '-v'],
                                    cwd=root / 'backend', env=environment, timeout=300)
        finally:
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
    sys.exit(result.returncode)
