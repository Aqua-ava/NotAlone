import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { prepareDatabaseSchema } from '../src/schema-prepare.ts';

// 仅用于构造历史版本的空合成库；完整升级走产品 prepareDatabaseSchema。
export async function seedMigrationBaseline(database, migrationsDirectory) {
  assert.match(database, /^notalone_[a-z_]+_[a-f0-9]{32}_test$/);
  const client = new pg.Client({host:'/tmp',database});
  await client.connect();
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, database);
    await client.query('CREATE TABLE public.notalone_schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(migrationsDirectory)).filter(name=>name.endsWith('.sql')).sort()) {
      const bytes = await readFile(join(migrationsDirectory,name));
      await client.query(bytes.toString('utf8'));
      await client.query('INSERT INTO public.notalone_schema_migration(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(bytes).digest('hex')]);
    }
  } finally { await client.end(); }
}
export async function prepareTestSchema(database, migrationsDirectory, home) {
  assert.match(database, /^notalone_[a-z_]+_[a-f0-9]{32}_test$/);
  const result = await prepareDatabaseSchema({databaseUrl:`host=/tmp dbname=${database}`,migrationsDirectory,
    environment:{HOME:home,NOTALONE_SKILLS_DIR:join(home,'skills')}});
  assert.equal(result.code,'ready', '合成库必须经产品 Node schema 入口完成升级');
}
