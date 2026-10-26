import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { prepareDatabaseSchema } from '../src/schema-prepare.ts';

const migrationsDirectory = new URL('../../backend/database/migrations/', import.meta.url).pathname;
const ownedDatabase = /^notalone_ts_host_[a-f0-9]{32}_test$/;

// 只创建本轮随机合成库，不读取项目 .env，也不调用历史 Python 后端。
export async function createStorageFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'notalone-host-pg-'));
  const name = `notalone_ts_host_${randomUUID().replaceAll('-', '')}_test`;
  const admin = new pg.Client({ host: '/tmp', database: 'postgres' });
  const client = new pg.Client({ host: '/tmp', database: name });
  let created = false, connected = false, adminConnected = false, closed = false;
  async function close() {
    if (closed) return;
    if (!ownedDatabase.test(name)) throw new Error('合成 PG 清理范围不匹配');
    // 排空前核对当前连接确属本轮库，禁止按前缀扫描或删除其他测试库。
    if (connected) {
      const current = await client.query('SELECT current_database() AS name');
      if (current.rows[0]?.name !== name) throw new Error('合成 PG 清理范围不匹配');
      await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid() AND backend_type='client backend'`, [name]);
      await client.end();
      connected = false;
    }
    if (created) {
      if (!adminConnected) { await admin.connect(); adminConnected = true; }
      await admin.query(`DROP DATABASE "${name}"`);
      created = false;
    }
    if (adminConnected) { await admin.end(); adminConnected = false; }
    await rm(directory, { recursive: true, force: true });
    closed = true;
  }
  try {
    await admin.connect(); adminConnected = true;
    if (!ownedDatabase.test(name)) throw new Error('合成 PG 创建范围不匹配');
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    const prepared = await prepareDatabaseSchema({
      databaseUrl: `host=/tmp dbname=${name}`, migrationsDirectory,
      environment: { HOME: directory, NOTALONE_SKILLS_DIR: join(directory, 'skills') },
    });
    if (prepared.code !== 'ready') throw new Error(`合成 PG 准备失败：${prepared.code}`);
    await client.connect(); connected = true;
    const envFilePath = join(directory, '.env');
    await writeFile(envFilePath, `NOTALONE_DATABASE_URL=host=/tmp dbname=${name}\nNOTALONE_SKILLS_DIR=${directory}/skills\n`, { mode: 0o600 });
    return { directory, envFilePath, migrationsDirectory, client,
      options: { envFilePath, migrationsDirectory, environment: {} }, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '合成 PG 准备及清理失败，保留本轮资源'); }
    throw new Error('合成 PG 准备失败', { cause: error });
  }
}
