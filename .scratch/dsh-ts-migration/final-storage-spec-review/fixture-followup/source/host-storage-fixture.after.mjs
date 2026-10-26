import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const migrationsDirectory = new URL('../../backend/database/migrations/', import.meta.url).pathname;
// 独立 PostgreSQL seam：由原迁移命令创建本轮合成库，不读取项目 .env。
export async function createStorageFixture() {
  const { execFileSync } = await import('node:child_process');
  const { homedir } = await import('node:os');
  const { randomUUID } = await import('node:crypto');
  const directory = await mkdtemp(join(tmpdir(), 'notalone-host-pg-'));
  const name = `notalone_ts_host_${randomUUID().replaceAll('-', '')}_test`;
  const python = process.env.NOTALONE_TEST_PYTHON || join(homedir(), 'miniconda3/envs/NotAlone/bin/python');
  const root = new URL('../../', import.meta.url).pathname;
  const script = `import sys\nfrom pathlib import Path\nimport psycopg\nfrom psycopg import sql\nfrom notalone.database_migrations import migrate\nname=sys.argv[1]\nassert name.startswith('notalone_ts_host_') and name.endswith('_test')\nwith psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:\n c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(name)))\nmigrate('host=/tmp dbname='+name,Path(sys.argv[2]))\n`;
  const environment = { ...process.env, NOTALONE_DISABLE_DOTENV: '1', NOTALONE_MANAGED_USER_DATA: directory, PYTHONPATH: join(root, 'backend/src') };
  try { execFileSync(python, ['-c', script, name, migrationsDirectory], { env: environment, timeout: 60000, stdio: 'pipe' }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw new Error('合成 PG 准备失败', { cause: error }); }
  const envFilePath = join(directory, '.env');
  await writeFile(envFilePath, `NOTALONE_DATABASE_URL=host=/tmp dbname=${name}\nNOTALONE_SKILLS_DIR=${directory}/skills\n`);
  const pg = await import('pg');
  const client = new pg.default.Client({ host: '/tmp', database: name });
  await client.connect();
  return { directory, envFilePath, migrationsDirectory, client,
    options: { envFilePath, migrationsDirectory, environment: {} },
    async close() {
      // 收尾不依赖各测试的 after 注册顺序；同步删库前先排空本夹具的连接。
      const current = await client.query('SELECT current_database() AS name');
      if (!/^notalone_ts_host_[a-f0-9]{32}_test$/.test(name) || current.rows[0]?.name !== name) {
        throw new Error('合成 PG 清理范围不匹配');
      }
      await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid() AND backend_type='client backend'`, [name]);
      await client.end();
      execFileSync(python, ['-c', "import sys,psycopg\nfrom psycopg import sql\nwith psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:\n c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(sys.argv[1])))", name], { env: environment, timeout: 15000, stdio: 'pipe' });
      await rm(directory, { recursive: true, force: true });
    },
  };
}
