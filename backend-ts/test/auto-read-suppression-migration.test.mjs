import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {HostStorage} from '../src/host-storage.ts';

test('108升级当前115保留既有数据，严格拒绝迁移缺口、未知版本和抑制表字段缺失',async t=>{
  const root=new URL('../../',import.meta.url).pathname;
  const directory=await mkdtemp(join(tmpdir(),'notalone-suppression-upgrade-'));
  const {mkdir}=await import('node:fs/promises');
  const baseline=join(directory,'baseline'),current=join(directory,'current');
  await mkdir(baseline);await mkdir(current);
  for(const file of await readdir(join(root,'backend/database/migrations'))){
    if(!/^\d{3}_.*\.sql$/.test(file))continue;
    const version=Number(file.slice(0,3));
    if(version<=108)await copyFile(join(root,'backend/database/migrations',file),join(baseline,file));
    if(version<=115)await copyFile(join(root,'backend/database/migrations',file),join(current,file));
  }
  const name=`notalone_suppression_upgrade_${randomUUID().replaceAll('-','')}_test`;
  const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
  let client,storage;
  t.after(async()=>{await storage?.close();await client?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const migrate=path=>execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',
    'import sys\nfrom pathlib import Path\nfrom notalone.database_migrations import migrate\nmigrate(sys.argv[1],Path(sys.argv[2]))',`host=/tmp dbname=${name}`,path],
    {env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:join(root,'backend/src')},timeout:60000,stdio:'pipe'});
  migrate(baseline);
  client=new pg.Client({host:'/tmp',database:name});await client.connect();
  const owner=(await client.query("INSERT INTO owner(display_name) VALUES('合成升级本人') RETURNING id")).rows[0].id;
  const contact=(await client.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'合成原联系人') RETURNING id",[owner])).rows[0].id;
  // 用有来源的消息和记忆版本验证升级保留内容、身份及关系，不仅比较空表。
  const source=(await client.query("INSERT INTO source_document(owner_id,contact_id,source_type,file_name,content_sha256,record_count,status) VALUES($1,$2,'wechat_jsonl','synthetic-upgrade.jsonl',$3,1,'active') RETURNING id",[owner,contact,'a'.repeat(64)])).rows[0].id;
  const message=(await client.query("INSERT INTO message(owner_id,contact_id,speaker,message_type,text_content) VALUES($1,$2,'contact','text','合成升级消息') RETURNING id",[owner,contact])).rows[0].id;
  await client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'row:1','{}')",[message,owner,contact,source]);
  await client.query("INSERT INTO memory_candidate(owner_id,contact_id,text_content,category,source_ids,status) VALUES($1,$2,'合成拒绝记忆','preference',$3,'rejected')",[owner,contact,[source]]);
  const oldMemory=(await client.query("INSERT INTO confirmed_memory(owner_id,contact_id,text_content,category,source_ids,status,adoption_method) VALUES($1,$2,'合成旧版记忆','preference',$3,'invalidated','manual') RETURNING id",[owner,contact,[source]])).rows[0].id;
  await client.query("INSERT INTO confirmed_memory(owner_id,contact_id,text_content,category,source_ids,status,adoption_method,supersedes_memory_id) VALUES($1,$2,'合成修正记忆','preference',$3,'invalidated','manual',$4)",[owner,contact,[source],oldMemory]);
  const originalTables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'notalone_schema_migration' ORDER BY tablename")).rows.map(r=>r.tablename);
  const snapshot=async()=>{
    const result={};
    for(const name of originalTables){const ident='"'+name.replaceAll('"','""')+'"';result[name]=(await client.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM public.${ident} t`)).rows[0].data;}
    return result;
  };
  const before=await snapshot(),envFilePath=join(directory,'.env');
  await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${name}\n`);
  storage=await HostStorage.open({envFilePath,migrationsDirectory:current,environment:{}});
  assert.deepEqual(await storage.compatibility(),{code:'migration_pending'});
  migrate(current);
  assert.deepEqual(await storage.compatibility(),{code:'ready'});
  assert.deepEqual(await snapshot(),before,'所有既有业务表内容保持不变');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM wechat_auto_read_suppression')).rows[0].n,0,'不能猜测回填丢失的历史删除身份');
  const ledger=(await client.query('SELECT name,checksum FROM notalone_schema_migration ORDER BY name')).rows;
  assert.equal(ledger.length,115);
  for(const [entry,code] of [[ledger[109],'migration_history_mismatch'],[ledger[110],'migration_history_mismatch'],
    [ledger[111],'migration_history_mismatch'],[ledger[112],'migration_history_mismatch'],
    [ledger[113],'migration_history_mismatch'],[ledger[114],'migration_pending']]){
    await client.query('DELETE FROM notalone_schema_migration WHERE name=$1',[entry.name]);
    assert.deepEqual(await storage.compatibility(),{code});
    await client.query('INSERT INTO notalone_schema_migration(name,checksum) VALUES($1,$2)',[entry.name,entry.checksum]);
  }
  await writeFile(join(current,'116_unknown.sql'),'SELECT 1;\n');
  assert.deepEqual(await storage.compatibility(),{code:'migration_files_invalid'});
  await rm(join(current,'116_unknown.sql'));
  await client.query("INSERT INTO notalone_schema_migration(name,checksum) VALUES('116_unknown.sql',$1)",['a'.repeat(64)]);
  assert.deepEqual(await storage.compatibility(),{code:'migration_history_mismatch'});
  await client.query("DELETE FROM notalone_schema_migration WHERE name='116_unknown.sql'");
  await client.query('ALTER TABLE wechat_auto_read_suppression RENAME COLUMN identity_create_time TO missing_identity');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE wechat_auto_read_suppression RENAME COLUMN missing_identity TO identity_create_time');
  await client.query('INSERT INTO wechat_auto_read_suppression(owner_id,contact_id,external_local_id,identity_create_time) VALUES($1,$2,7,-1)',[owner,contact]);
  await client.query('DELETE FROM contact WHERE owner_id=$1 AND id=$2',[owner,contact]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM wechat_auto_read_suppression')).rows[0].n,0);
  assert.deepEqual(await storage.compatibility(),{code:'ready'});
});
