"""正式工作树验证：只创建、迁移、删除本轮随机合成库。"""
import os, sys, tempfile, unittest
from pathlib import Path
from uuid import uuid4
import psycopg
from psycopg import sql
root=Path(__file__).resolve().parents[3]
sys.path[:0]=[str(root/'backend/src'),str(root/'backend')]
name='notalone_guard_live_'+uuid4().hex+'_test'
url='host=/tmp dbname='+name
with tempfile.TemporaryDirectory(prefix='notalone-guard-live-') as directory:
 os.environ.update(NOTALONE_TEST_DATABASE_URL=url,NOTALONE_DISABLE_DOTENV='1',NOTALONE_MANAGED_USER_DATA=directory)
 from notalone.database_migrations import migrate
 try:
  with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))
  migrate(url,root/'backend/database/migrations')
  suite=unittest.TestSuite()
  for target in sys.argv[1:]:suite.addTests(unittest.defaultTestLoader.loadTestsFromName(target))
  result=unittest.TextTestRunner(verbosity=2).run(suite)
  print('SUMMARY tests=%d failures=%d errors=%d skipped=%d'%(result.testsRun,len(result.failures),len(result.errors),len(result.skipped)))
 finally:
  with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
  print('CLEANUP own random_test database dropped')
raise SystemExit(not result.wasSuccessful() or bool(result.skipped))
