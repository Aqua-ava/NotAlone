import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {seedMigrationBaseline,prepareTestSchema} from './schema-fixture.mjs';
import pg from 'pg';

// 只创建本用例随机_test库；从真实107迁移集升级，不修改历史SQL或业务库。
test('107升级108只快照已明确同意且有效绑定，重放不扩大到新绑定，原记录原ID保留',async t=>{
  const root=new URL('../../',import.meta.url).pathname;
  const migrations=join(root,'backend-ts/database/migrations');
  const directory=await mkdtemp(join(tmpdir(),'notalone-wechat-migration-'));
  const name=`notalone_wechat_migration_${randomUUID().replaceAll('-','')}_test`;
  const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
  let client;
  t.after(async()=>{await client?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  for(const file of await readdir(migrations)) if(/^\d{3}_.*\.sql$/.test(file)&&Number(file.slice(0,3))<=107) await symlink(join(migrations,file),join(directory,file));
  const migrate=async dir=>{
    if(dir===directory)return seedMigrationBaseline(name,dir);
    await client.end();await prepareTestSchema(name,dir,directory);
    client=new pg.Client({host:'/tmp',database:name});await client.connect();
  };
  await migrate(directory);
  client=new pg.Client({host:'/tmp',database:name});await client.connect();
  const owner=(await client.query("INSERT INTO owner(display_name) VALUES('合成升级本人') RETURNING id")).rows[0].id;
  await client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  await client.query("INSERT INTO wechat_history_sync_authorization(owner_id,channel,account_scope,version,decision,decided_at) VALUES($1,'wechat','synthetic-account',1,'accepted','2026-10-23T10:00:00Z')",[owner]);
  const add=async(locator,status='active')=>{
    const contact=(await client.query('INSERT INTO contact(owner_id,display_name) VALUES($1,$2) RETURNING id',[owner,locator])).rows[0].id;
    const binding=(await client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status,revoked_at) VALUES($1,$2,'wechat','synthetic-account',$3,$4,CASE WHEN $4='revoked' THEN now() ELSE NULL END) RETURNING id",[owner,contact,locator,status])).rows[0].id;
    return {contact,binding};
  };
  const active=await add('active-old');const revoked=await add('revoked-old','revoked');const excluded=await add('excluded-old');
  await client.query("INSERT INTO wechat_sync_exclusion(owner_id,channel,account_scope,locator_hash) VALUES($1,'wechat','synthetic-account',sha256(convert_to('excluded-old','UTF8')))",[owner]);
  const unaccepted=await add('without-grant');
  await client.query("UPDATE conversation_binding SET account_scope='unaccepted-account' WHERE id=$1",[unaccepted.binding]);
  const before=(await client.query('SELECT * FROM wechat_history_sync_authorization WHERE owner_id=$1',[owner])).rows;
  await migrate(migrations);
  assert.deepEqual((await client.query('SELECT binding_id FROM wechat_binding_history_authorization')).rows.map(r=>r.binding_id),[active.binding]);
  assert.deepEqual((await client.query('SELECT * FROM wechat_history_sync_authorization WHERE owner_id=$1',[owner])).rows,before);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM conversation_binding WHERE id=ANY($1::uuid[])',[[active.binding,revoked.binding,excluded.binding,unaccepted.binding]])).rows[0].n,4);
  const newer=await add('new-after-upgrade');await migrate(migrations);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM wechat_binding_history_authorization WHERE binding_id=$1',[newer.binding])).rows[0].n,0);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM notalone_schema_migration WHERE name='108_wechat_binding_history_authorization.sql'")).rows[0].n,1);
  await client.query('DELETE FROM contact WHERE id=$1',[active.contact]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM wechat_binding_history_authorization')).rows[0].n,0);
  assert.deepEqual((await client.query('SELECT * FROM wechat_history_sync_authorization WHERE owner_id=$1',[owner])).rows,before);
});
