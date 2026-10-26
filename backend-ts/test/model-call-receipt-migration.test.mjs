import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {seedMigrationBaseline,prepareTestSchema} from './schema-fixture.mjs';
import pg from 'pg';
import {HostStorage} from '../src/platform/database/host-storage.ts';

test('109升级当前116保留业务UUID及未知用量，receipt隔离和关键约束损坏关闭门禁',async t=>{
  const root=new URL('../../',import.meta.url).pathname;
  const directory=await mkdtemp(join(tmpdir(),'notalone-receipt-upgrade-'));
  const {mkdir}=await import('node:fs/promises');
  const baseline=join(directory,'baseline'),current=join(directory,'current');
  await mkdir(baseline);await mkdir(current);
  for(const file of await readdir(join(root,'backend-ts/database/migrations'))){
    if(!/^\d{3}_.*\.sql$/.test(file))continue;
    const version=Number(file.slice(0,3));
    if(version<=109)await copyFile(join(root,'backend-ts/database/migrations',file),join(baseline,file));
    if(version<=116)await copyFile(join(root,'backend-ts/database/migrations',file),join(current,file));
  }
  const name=`notalone_receipt_upgrade_${randomUUID().replaceAll('-','')}_test`;
  const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
  let client,storage;
  t.after(async()=>{await storage?.close();await client?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();await rm(directory,{recursive:true,force:true});});
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const migrate=async path=>{
    if(path===baseline) return seedMigrationBaseline(name,path);
    await storage?.close();await client?.end();
    await prepareTestSchema(name,path,directory);
    client=new pg.Client({host:'/tmp',database:name});await client.connect();
    if(storage)storage=await HostStorage.open({envFilePath:join(directory,'.env'),migrationsDirectory:current,environment:{}});
  };
  await migrate(baseline);
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
  const session=(await client.query("INSERT INTO assistant_session(owner_id,contact_id) VALUES($1,$2) RETURNING id",[owner,contact])).rows[0].id;
  const ledgerId=randomUUID();
  await client.query("INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,outcome,called_at) VALUES($1,$2,$3,'synthetic','synthetic-model','rejected_by_validation',now())",[ledgerId,owner,contact]);
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
  await migrate(current);
  assert.deepEqual(await storage.compatibility(),{code:'ready'});
  assert.deepEqual(await snapshot(),before,'所有既有业务表内容保持不变');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM model_call_receipt')).rows[0].n,0);
  const originalLedger=(await client.query('SELECT * FROM outbound_ledger_entry WHERE id=$1',[ledgerId])).rows[0];
  assert.equal(originalLedger.input_tokens,null);assert.equal(originalLedger.output_tokens,null);
  assert.equal((await client.query('SELECT id FROM assistant_session WHERE id=$1',[session])).rows[0].id,session);
  const ledger=(await client.query('SELECT name,checksum FROM notalone_schema_migration ORDER BY name')).rows;
  assert.equal(ledger.length,116);
  for(const [entry,code] of [[ledger[110],'migration_history_mismatch'],[ledger[111],'migration_history_mismatch'],
    [ledger[112],'migration_history_mismatch'],[ledger[113],'migration_history_mismatch'],
    [ledger[114],'migration_history_mismatch'],[ledger[115],'migration_pending']]){
    await client.query('DELETE FROM notalone_schema_migration WHERE name=$1',[entry.name]);
    assert.deepEqual(await storage.compatibility(),{code});
    await assert.rejects(storage.businessReadTransaction(async()=>{}),{code});
    await client.query('INSERT INTO notalone_schema_migration(name,checksum) VALUES($1,$2)',[entry.name,entry.checksum]);
  }
  await client.query("UPDATE notalone_schema_migration SET checksum='wrong' WHERE name=$1",[ledger[109].name]);
  assert.deepEqual(await storage.compatibility(),{code:'migration_history_mismatch'});
  await client.query('UPDATE notalone_schema_migration SET checksum=$2 WHERE name=$1',[ledger[109].name,ledger[109].checksum]);
  await writeFile(join(current,'117_unknown.sql'),'SELECT 1;\n');
  assert.deepEqual(await storage.compatibility(),{code:'migration_files_invalid'});await rm(join(current,'117_unknown.sql'));
  await client.query("INSERT INTO notalone_schema_migration(name,checksum) VALUES('117_unknown.sql',$1)",['a'.repeat(64)]);
  assert.deepEqual(await storage.compatibility(),{code:'migration_history_mismatch'});
  await client.query("DELETE FROM notalone_schema_migration WHERE name='117_unknown.sql'");
  await client.query('ALTER TABLE model_call_receipt RENAME COLUMN scope_kind TO missing_scope');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_receipt RENAME COLUMN missing_scope TO scope_kind');
  // 参数化写入证明数据库级隔离、可空本人记忆范围和删除后的晚写约束。
  const insert=async(contactId,scope='contact',linked=null)=>{
    const id=randomUUID();
    await client.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,scope_kind,request_id,permit_id,ledger_entry_id,provider,model_name,called_at,dispatch,outcome,cost_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic','synthetic-model',now(),'authorized_unconfirmed','pending','unknown')`,[id,owner,contactId,scope,randomUUID(),randomUUID(),linked]);return id;
  };
  const otherOwner=(await client.query("INSERT INTO owner(display_name) VALUES('合成隔离本人') RETURNING id")).rows[0].id;
  const otherContact=(await client.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'合成隔离联系人') RETURNING id",[otherOwner])).rows[0].id;
  await assert.rejects(insert(otherContact),{code:'23503'});
  await assert.rejects(insert(null),{code:'23514'});
  await assert.rejects(insert(contact,'owner_memory'),{code:'23514'});
  const receipt=await insert(contact,'contact',ledgerId),ownerReceipt=await insert(null,'owner_memory');
  await assert.rejects(insert(contact,'contact',ledgerId),{code:'23505'});
  const budget={measurement_id:'synthetic:v1',measurement_kind:'approximate',input_tokens:10,max_output_tokens:20,context_window_tokens:100,safety_margin_tokens:5,request_sha256:'b'.repeat(64),serialized_bytes:20};
  await client.query('UPDATE model_call_receipt SET input_budget=$2 WHERE attempt_id=$1',[receipt,budget]);
  assert.deepEqual((await client.query('SELECT input_budget FROM model_call_receipt WHERE attempt_id=$1',[receipt])).rows[0].input_budget,budget);
  for(const query of ["input_tokens=1", "cost_amount=0", "outcome='succeeded'", "input_budget='{}'::jsonb"]){
    await assert.rejects(client.query(`UPDATE model_call_receipt SET ${query} WHERE attempt_id=$1`,[receipt]),{code:'23514'});
  }
  await client.query('DELETE FROM outbound_ledger_entry WHERE id=$1',[ledgerId]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_receipt WHERE attempt_id=$1',[receipt])).rows[0].n,0);
  await assert.rejects(insert(contact,'contact',ledgerId),{code:'23503'});
  await insert(contact);
  await client.query('DELETE FROM contact WHERE owner_id=$1 AND id=$2',[owner,contact]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_receipt WHERE contact_id=$1',[contact])).rows[0].n,0);
  await assert.rejects(insert(contact),{code:'23503'});
  assert.equal((await client.query('SELECT attempt_id FROM model_call_receipt')).rows[0].attempt_id,ownerReceipt);
  await client.query('DELETE FROM owner WHERE id=$1',[owner]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
  await assert.rejects(insert(null,'owner_memory'),{code:'23503'});
  const constraints=(await client.query("SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.model_call_receipt'::regclass ORDER BY conname")).rows;
  if(process.env.NOTALONE_SCHEMA110_CAPTURE)await writeFile(process.env.NOTALONE_SCHEMA110_CAPTURE,JSON.stringify(constraints,null,2)+'\n');
  const ident=name=>'"'+name.replaceAll('"','""')+'"';
  for(const constraint of constraints.filter(c=>c.conname!=='model_call_receipt_claim_scope_key')){
    await t.test('缺少约束 '+constraint.conname,async()=>{
      await client.query('ALTER TABLE model_call_receipt DROP CONSTRAINT '+ident(constraint.conname));
      try {
        assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
        await assert.rejects(storage.businessReadTransaction(async()=>{}),{code:'schema_incomplete'});
      } finally {await client.query('ALTER TABLE model_call_receipt ADD CONSTRAINT '+ident(constraint.conname)+' '+constraint.definition);}
      assert.deepEqual(await storage.compatibility(),{code:'ready'});
    });
  }
  const fk=constraints.find(c=>c.contype==='f'&&c.definition.includes('REFERENCES owner('));
  await client.query('ALTER TABLE model_call_receipt DROP CONSTRAINT '+ident(fk.conname));
  await client.query('ALTER TABLE model_call_receipt ADD CONSTRAINT '+ident(fk.conname)+' '+fk.definition+' NOT VALID');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_receipt VALIDATE CONSTRAINT '+ident(fk.conname));
  await client.query('ALTER TABLE model_call_receipt DROP CONSTRAINT '+ident(fk.conname));
  await client.query('ALTER TABLE model_call_receipt ADD CONSTRAINT '+ident(fk.conname)+' '+fk.definition.replace('ON DELETE CASCADE','ON DELETE RESTRICT'));
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_receipt DROP CONSTRAINT '+ident(fk.conname));
  await client.query('ALTER TABLE model_call_receipt ADD CONSTRAINT '+ident(fk.conname)+' '+fk.definition);
  await client.query('ALTER TABLE model_call_receipt ALTER COLUMN outcome DROP NOT NULL');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_receipt ALTER COLUMN outcome SET NOT NULL');
  await client.query('ALTER TABLE model_call_receipt ALTER COLUMN contact_id SET NOT NULL');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_receipt ALTER COLUMN contact_id DROP NOT NULL');
  const scopeCheck=constraints.find(c=>c.contype==='c'&&c.definition.includes('owner_memory')&&c.definition.includes('contact_id'));
  await client.query('ALTER TABLE model_call_receipt DROP CONSTRAINT '+ident(scopeCheck.conname));
  await client.query('ALTER TABLE model_call_receipt ADD CONSTRAINT '+ident(scopeCheck.conname)+' '+scopeCheck.definition+' NOT VALID');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_receipt VALIDATE CONSTRAINT '+ident(scopeCheck.conname));
  assert.deepEqual(await storage.compatibility(),{code:'ready'});
});
