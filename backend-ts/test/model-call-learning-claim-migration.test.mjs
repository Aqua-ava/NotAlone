import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {HostStorage} from '../src/host-storage.ts';

test('110升级115保留原数据与unknown收据，学习claim完整约束和级联',async t=>{
  const root=new URL('../../',import.meta.url).pathname;
  const directory=await mkdtemp(join(tmpdir(),'notalone-learning-claim-upgrade-'));
  const {mkdir}=await import('node:fs/promises');
  const baseline=join(directory,'baseline'),current=join(directory,'current');
  await mkdir(baseline);await mkdir(current);
  for(const file of await readdir(join(root,'backend/database/migrations'))){
    if(!/^\d{3}_.*\.sql$/.test(file))continue;
    const version=Number(file.slice(0,3));
    if(version<=110)await copyFile(join(root,'backend/database/migrations',file),join(baseline,file));
    if(version<=115)await copyFile(join(root,'backend/database/migrations',file),join(current,file));
  }
  const name=`notalone_learning_claim_upgrade_${randomUUID().replaceAll('-','')}_test`;
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
  const session=(await client.query("INSERT INTO assistant_session(owner_id,contact_id) VALUES($1,$2) RETURNING id",[owner,contact])).rows[0].id;
  const ledgerId=randomUUID();
  await client.query("INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,outcome,called_at) VALUES($1,$2,$3,'synthetic','synthetic-model','rejected_by_validation',now())",[ledgerId,owner,contact]);
  const originalAttempt=randomUUID(),originalRequest=randomUUID();
  await client.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,ledger_entry_id,provider,model_name,called_at,dispatch,outcome,cost_status)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic','synthetic-model',now(),'authorized_unconfirmed','unknown','unknown')`,[originalAttempt,owner,contact,originalRequest,randomUUID(),ledgerId]);
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
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_learning_claim')).rows[0].n,0,'不把未知历史收据猜测成新租约授权');
  const original=(await client.query('SELECT attempt_id,outcome,input_tokens,output_tokens,cost_amount FROM model_call_receipt WHERE attempt_id=$1',[originalAttempt])).rows[0];
  assert.deepEqual(original,{attempt_id:originalAttempt,outcome:'unknown',input_tokens:null,output_tokens:null,cost_amount:null});
  const ledger=(await client.query('SELECT name,checksum FROM notalone_schema_migration ORDER BY name')).rows;
  assert.equal(ledger.length,115);
  for(const [entry,code] of [[ledger[111],'migration_history_mismatch'],[ledger[112],'migration_history_mismatch'],
    [ledger[113],'migration_history_mismatch'],[ledger[114],'migration_pending']]){
    await client.query('DELETE FROM notalone_schema_migration WHERE name=$1',[entry.name]);
    assert.deepEqual(await storage.compatibility(),{code});
    await assert.rejects(storage.businessReadTransaction(async()=>{}),{code});
    await client.query('INSERT INTO notalone_schema_migration(name,checksum) VALUES($1,$2)',[entry.name,entry.checksum]);
  }
  await client.query("UPDATE notalone_schema_migration SET checksum='wrong' WHERE name=$1",[ledger[111].name]);
  assert.deepEqual(await storage.compatibility(),{code:'migration_history_mismatch'});
  await client.query('UPDATE notalone_schema_migration SET checksum=$2 WHERE name=$1',[ledger[111].name,ledger[111].checksum]);
  await writeFile(join(current,'116_unknown.sql'),'SELECT 1;\n');
  assert.deepEqual(await storage.compatibility(),{code:'migration_files_invalid'});await rm(join(current,'116_unknown.sql'));
  await client.query("INSERT INTO notalone_schema_migration(name,checksum) VALUES('116_unknown.sql',$1)",['a'.repeat(64)]);
  assert.deepEqual(await storage.compatibility(),{code:'migration_history_mismatch'});
  await client.query("DELETE FROM notalone_schema_migration WHERE name='116_unknown.sql'");
  const receipt=async(own=owner,con=contact,request=randomUUID())=>{
    const attempt=randomUUID();await client.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,called_at,dispatch,outcome,cost_status)
      VALUES($1,$2,$3,$4,$5,'synthetic','synthetic-model',now(),'authorized_unconfirmed','pending','unknown')`,[attempt,own,con,request,randomUUID()]);return {attempt,request};
  };
  const task=async(own=owner,con=contact)=>{
    const id=(await client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,'skill_learning','running','propose_skill',0) RETURNING id",[own,con])).rows[0].id;
    const step=(await client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,worker_id,lease_generation,lease_expires_at) VALUES($1,'propose_skill',1,'running',$2,1,now()+interval '1 minute') RETURNING id",[id,randomUUID()])).rows[0].id;return {id,step};
  };
  const slot=async(r,t,{own=owner,con=contact,generation=1,stepName='propose_skill',step=t.step}={})=>client.query(`INSERT INTO model_call_learning_claim(attempt_id,owner_id,contact_id,request_id,task_id,step_id,step_name,worker_id,lease_generation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[r.attempt,own,con,r.request,t.id,step,stepName,randomUUID(),generation]);
  const t1=await task(),r1=await receipt();await slot(r1,t1);
  const r2=await receipt(owner,contact,r1.request);
  await assert.rejects(slot(r2,t1),{code:'23505'});
  const otherRequest=await receipt();
  await assert.rejects(slot(otherRequest,t1),{code:'23505'},'同一真实claim换request不能增加授权');
  await assert.rejects(slot(r2,t1,{generation:0}),{code:'23514'});
  await assert.rejects(slot(r2,t1,{stepName:'extract_memory'}),{code:'23514'});
  const other=(await client.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'合成第二联系人') RETURNING id",[owner])).rows[0].id;
  const t2=await task(owner,other);await assert.rejects(slot(r2,t1,{step:t2.step}),{code:'23503'});
  await assert.rejects(slot({...r2,request:randomUUID()},t1,{generation:2}),{code:'23503'});
  await assert.rejects(slot(r2,t1,{con:other,generation:2}),{code:'23503'});
  await client.query('BEGIN');let rolledAttempt;
  try{const r=await receipt(owner,contact,r1.request);rolledAttempt=r.attempt;await slot(r,t1);assert.fail('同claim不得新增授权');}
  catch(error){await client.query('ROLLBACK');assert.equal(error.code,'23505');}
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_receipt WHERE attempt_id=$1',[rolledAttempt])).rows[0].n,0,'slot失败时同事务receipt必须回滚');
  await client.query('UPDATE background_task_step SET lease_generation=2 WHERE id=$1',[t1.step]);
  await slot(r2,t1,{generation:2});
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_learning_claim WHERE request_id=$1',[r1.request])).rows[0].n,2,'新真实claim事实可独立保存，不删除旧累计收据');
  await client.query('DELETE FROM model_call_receipt WHERE attempt_id=$1',[r1.attempt]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_learning_claim WHERE attempt_id=$1',[r1.attempt])).rows[0].n,0);
  await client.query('DELETE FROM background_task_step WHERE id=$1',[t1.step]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_learning_claim WHERE attempt_id=$1',[r2.attempt])).rows[0].n,0);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_receipt WHERE attempt_id=$1',[r2.attempt])).rows[0].n,1,'step清理不抹累计receipt');
  await assert.rejects(slot(r2,t1,{generation:3}),{code:'23503'});
  const r3=await receipt(owner,other);await slot(r3,t2,{con:other});await client.query('DELETE FROM background_task WHERE id=$1',[t2.id]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_learning_claim WHERE attempt_id=$1',[r3.attempt])).rows[0].n,0);
  await client.query('DELETE FROM background_task WHERE id=$1',[t1.id]);
  const t3=await task(),r4=await receipt();await slot(r4,t3);
  await client.query('DELETE FROM contact WHERE id=$1',[contact]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_learning_claim')).rows[0].n,0);
  await assert.rejects(slot(r4,t3),{code:'23503'});
  const t4=await task(owner,other),r5=await receipt(owner,other);await slot(r5,t4,{con:other});
  await client.query('DELETE FROM owner WHERE id=$1',[owner]);
  assert.equal((await client.query('SELECT count(*)::int n FROM model_call_learning_claim')).rows[0].n,0);
  const constraints=(await client.query("SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.model_call_learning_claim'::regclass ORDER BY conname")).rows;
  const ident=name=>'"'+name.replaceAll('"','""')+'"';
  for(const constraint of constraints){
    await t.test('缺失学习slot约束 '+constraint.conname,async()=>{
      await client.query('ALTER TABLE model_call_learning_claim DROP CONSTRAINT '+ident(constraint.conname));
      try{assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});await assert.rejects(storage.businessReadTransaction(async()=>{}),{code:'schema_incomplete'});}
      finally{await client.query('ALTER TABLE model_call_learning_claim ADD CONSTRAINT '+ident(constraint.conname)+' '+constraint.definition);}
      assert.deepEqual(await storage.compatibility(),{code:'ready'});
    });
  }
  for(const [table,name] of [['model_call_receipt','model_call_receipt_claim_scope_key'],['background_task_step','background_task_step_claim_task_key']]){
    await t.test('缺失原表候选键 '+name,async()=>{
      const definition=(await client.query('SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2',['public.'+table,name])).rows[0].d;
      const fk=constraints.find(c=>c.contype==='f'&&c.definition.includes('REFERENCES '+table+'('));
      await client.query('ALTER TABLE '+table+' DROP CONSTRAINT '+ident(name)+' CASCADE');
      try{assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});}
      finally{await client.query('ALTER TABLE '+table+' ADD CONSTRAINT '+ident(name)+' '+definition);await client.query('ALTER TABLE model_call_learning_claim ADD CONSTRAINT '+ident(fk.conname)+' '+fk.definition);}
      assert.deepEqual(await storage.compatibility(),{code:'ready'});
    });
  }
  for(const constraint of constraints.filter(c=>['f','c'].includes(c.contype))){
    await client.query('ALTER TABLE model_call_learning_claim DROP CONSTRAINT '+ident(constraint.conname));
    await client.query('ALTER TABLE model_call_learning_claim ADD CONSTRAINT '+ident(constraint.conname)+' '+constraint.definition+' NOT VALID');
    assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
    await client.query('ALTER TABLE model_call_learning_claim VALIDATE CONSTRAINT '+ident(constraint.conname));
  }
  await client.query('ALTER TABLE model_call_learning_claim ALTER COLUMN worker_id DROP NOT NULL');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_learning_claim ALTER COLUMN worker_id SET NOT NULL');
  await client.query('ALTER TABLE model_call_learning_claim ALTER COLUMN lease_generation TYPE integer');
  assert.deepEqual(await storage.compatibility(),{code:'schema_incomplete'});
  await client.query('ALTER TABLE model_call_learning_claim ALTER COLUMN lease_generation TYPE bigint');
  assert.deepEqual(await storage.compatibility(),{code:'ready'});
});
