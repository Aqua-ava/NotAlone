import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {HistoryImportApi} from '../src/history-import-api.ts';
import {ExtractionTaskStore} from '../src/extraction-task-store.ts';
import {HostStorage} from '../src/host-storage.ts';

const python=`${homedir()}/miniconda3/envs/NotAlone/bin/python`;
const root=new URL('../../',import.meta.url).pathname;
const environment={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:`${root}/backend/src`};

function record({localId,at,fromMe,kind='text',text,sender,senderWxid='wxid_synthetic_contact'}){
  return {
    id:{local_id:localId,server_id_str:`server-${localId}`,talker:'wxid_synthetic_contact'},
    create_time:Date.parse(at)/1000,
    is_from_me:fromMe,
    kind,
    sender,
    ...(senderWxid?{sender_wxid:senderWxid}:{}),
    text,
    time:at.slice(0,19).replace('T',' '),
    time_iso:at,
    ...(kind==='image'?{images:[{path:'synthetic-image.jpg'}]}:{}),
  };
}

async function fixture(){
  const database=`notalone_task16_import_${randomUUID().replaceAll('-','')}_test`;
  execFileSync(python,['-c',`import sys,psycopg
from pathlib import Path
from psycopg import sql
from notalone.database_migrations import migrate
with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
 c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(sys.argv[1])))
migrate('host=/tmp dbname='+sys.argv[1],Path(sys.argv[2]))`,database,`${root}/backend/database/migrations`],{env:environment,stdio:'pipe'});
  const pool=new pg.Pool({host:'/tmp',database,max:4});
  const ownerId=randomUUID(),contactId=randomUUID();
  await pool.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[ownerId]);
  await pool.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','wxid_synthetic_owner','合成本人')",[ownerId]);
  await pool.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contactId,ownerId]);
  await pool.query("INSERT INTO channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat','wxid_synthetic_contact','合成联系人')",[ownerId,contactId]);
  const directory=await mkdtemp(join(tmpdir(),'notalone-task16-import-'));
  const filePath=join(directory,'synthetic-import.jsonl');
  const records=[
    record({localId:1,at:'2026-10-20T10:00:00+08:00',fromMe:false,text:'合成消息一',sender:'合成联系人'}),
    record({localId:2,at:'2026-10-20T10:01:00+08:00',fromMe:true,kind:'image',text:'[图片]',sender:'合成本人',senderWxid:'wxid_synthetic_owner'}),
    record({localId:3,at:'2026-10-20T10:02:00+08:00',fromMe:false,kind:'system',text:'合成系统记录',sender:'系统消息',senderWxid:null}),
  ];
  await writeFile(filePath,records.map(value=>JSON.stringify(value)).join('\n')+'\n');
  const transaction=async operation=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
    catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  };
  return {pool,database,ownerId,contactId,filePath,directory,
    async close(){
      await pool.end();
      await rm(directory,{recursive:true,force:true});
      execFileSync(python,['-c',`import sys,psycopg
from psycopg import sql
with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
 c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(sys.argv[1])))`,database],{env:environment,stdio:'pipe'});
    }};
}

test('已选既有联系人可通过公开导入入口预览且不写业务资料',async()=>{
  const f=await fixture();
  try{
    const api=new HistoryImportApi({transaction:f.pool.businessTransaction?.bind(f.pool)??(async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }),ownerId:f.ownerId});
    const response=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    assert.equal(response.status,200);
    assert.equal(response.body.valid,true);
    assert.equal(response.body.file_name,'synthetic-import.jsonl');
    assert.equal(response.body.record_count,3);
    assert.deepEqual(response.body.kind_counts,{image:1,system:1,text:1});
    assert.equal(response.body.owner_channel_identity.external_id,'wxid_synthetic_owner');
    assert.equal(response.body.contact_channel_identity.external_id,'wxid_synthetic_contact');
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM source_document')).rows[0].count,0);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM message')).rows[0].count,0);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM background_task')).rows[0].count,0);
  }finally{await f.close();}
});

test('确认提交原子保存来源、规范消息、处理记录和原导入任务，提交后才通知既有Worker',async()=>{
  const f=await fixture();const wakes=[];
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:async(scope,taskId)=>{
      const visible=await f.pool.query(`SELECT
        (SELECT count(*)::int FROM source_document WHERE owner_id=$1 AND contact_id=$2 AND status='active') AS sources,
        (SELECT count(*)::int FROM message WHERE owner_id=$1 AND contact_id=$2) AS messages,
        (SELECT count(*)::int FROM message_source_ref WHERE owner_id=$1 AND contact_id=$2) AS refs`, [scope.ownerId,scope.contactId]);
      wakes.push({scope,taskId,visible:visible.rows[0]});return true;
    }});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    assert.equal(preview.status,200);
    const response=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.equal(response.status,200);
    assert.deepEqual({imported:response.body.imported_count,skipped:response.body.skipped_duplicates,contact:response.body.contact_id}, {imported:3,skipped:0,contact:f.contactId});
    assert.ok(response.body.task_id);
    assert.deepEqual(wakes,[{scope:{ownerId:f.ownerId,contactId:f.contactId},taskId:response.body.task_id,
      visible:{sources:1,messages:3,refs:3}}]);
    const source=(await f.pool.query('SELECT id,source_type,file_name,record_count,status FROM source_document')).rows[0];
    assert.deepEqual({type:source.source_type,name:source.file_name,count:source.record_count,status:source.status},
      {type:'wechat_jsonl',name:'synthetic-import.jsonl',count:3,status:'active'});
    assert.deepEqual((await f.pool.query('SELECT method FROM import_confirmation WHERE source_document_id=$1',[source.id])).rows,
      [{method:'manual_select'}]);
    assert.deepEqual((await f.pool.query('SELECT speaker,message_type,text_content,media_placeholder FROM message ORDER BY occurred_at')).rows,[
      {speaker:'contact',message_type:'text',text_content:'合成消息一',media_placeholder:null},
      {speaker:'user',message_type:'image',text_content:'',media_placeholder:'[图片]'},
      {speaker:'system',message_type:'system',text_content:'合成系统记录',media_placeholder:null},
    ]);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM wechat_message_metadata')).rows[0].count,3);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM source_processing_batch')).rows[0].count,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM source_processing_record')).rows[0].count,3);
    const task=(await f.pool.query('SELECT id,status,task_type,message_count FROM background_task')).rows[0];
    assert.deepEqual({id:task.id,status:task.status,type:task.task_type,count:task.message_count},
      {id:response.body.task_id,status:'queued',type:'import',count:3});
    assert.deepEqual((await f.pool.query('SELECT step_name,status FROM background_task_step ORDER BY step_order')).rows.map(row=>row.step_name),
      ['parse','normalize','extract_memory','index','verify']);
  }finally{await f.close();}
});

test('并发重复提交复用同一来源与原任务，终态重放不重写消息或任务',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    const body={path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256};
    const responses=await Promise.all(Array.from({length:4},()=>api.handle('POST','/api/imports/commit',body)));
    assert.ok(responses.every(response=>response.status===200));
    assert.equal(new Set(responses.map(response=>response.body.task_id)).size,1);
    assert.equal(new Set(responses.map(response=>response.body.contact_id)).size,1);
    assert.deepEqual(responses.map(response=>response.body.imported_count).sort(),[0,0,0,3]);
    assert.deepEqual(responses.map(response=>response.body.skipped_duplicates).sort(),[0,3,3,3]);
    const taskId=responses[0].body.task_id;
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM source_document')).rows[0].count,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM message')).rows[0].count,3);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM source_processing_batch')).rows[0].count,1);
    await f.pool.query("UPDATE background_task SET status='succeeded',current_step='verify',finished_at=now() WHERE id=$1",[taskId]);
    await f.pool.query("UPDATE background_task_step SET status='succeeded',finished_at=now() WHERE task_id=$1",[taskId]);
    const replay=await api.handle('POST','/api/imports/commit',body);
    assert.equal(replay.status,200);
    assert.equal(replay.body.task_id,taskId);
    assert.equal(replay.body.skipped_duplicates,3);
    assert.deepEqual((await f.pool.query('SELECT status,current_step FROM background_task WHERE id=$1',[taskId])).rows,
      [{status:'succeeded',current_step:'verify'}]);
    assert.ok((await f.pool.query("SELECT 1 FROM background_task_step WHERE task_id=$1 AND status<>'succeeded'",[taskId])).rowCount===0);
  }finally{await f.close();}
});

test('混合、群聊、多本人身份和损坏文件均在预览拒绝且不写任何业务资料',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId});
    const records=(await readFile(f.filePath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const invalidCalendar=structuredClone(records[0]);
    invalidCalendar.time_iso='2026-02-30T10:00:00+08:00';
    invalidCalendar.create_time=Date.parse(invalidCalendar.time_iso)/1000;
    const invalidFraction=structuredClone(records[0]);
    invalidFraction.time_iso='2026-10-20T10:00:00.123+08:00';
    invalidFraction.create_time=Math.floor(Date.parse(invalidFraction.time_iso)/1000);
    const inputs=[
      ['mixed',[records[0],{...structuredClone(records[0]),id:{...records[0].id,local_id:9,talker:'wxid_other_contact'},sender_wxid:'wxid_other_contact'}],'import_preview_failed'],
      ['group',[records[0],{...structuredClone(records[1]),id:{...records[1].id,local_id:8,talker:'synthetic-room@chatroom'}}],'import_preview_failed'],
      ['multiple-owners',[...records,{...structuredClone(records[1]),id:{...records[1].id,local_id:7},sender_wxid:'wxid_other_owner'}],'import_preview_failed'],
      ['broken',null,'import_preview_failed'],
      ['invalid-calendar',[invalidCalendar,records[1],records[2]],'import_preview_failed'],
      ['invalid-fraction',[invalidFraction,records[1],records[2]],'import_preview_failed'],
      ['owner-conflict',records.map(value=>value.sender_wxid==='wxid_synthetic_owner'?{...value,sender_wxid:'wxid_changed_owner'}:value),'import_identity_conflict'],
    ];
    for(const [name,content,error] of inputs){
      const path=join(f.directory,`${name}.jsonl`);
      await writeFile(path,content===null?'{损坏的合成 JSONL\n':content.map(value=>JSON.stringify(value)).join('\n')+'\n');
      const response=await api.handle('POST','/api/imports/preview',{path,contact_id:f.contactId});
      assert.equal(response.status,422,name);
      assert.equal(response.body.error,error,name);
      assert.deepEqual((await f.pool.query(`SELECT
        (SELECT count(*)::int FROM source_document) AS sources,
        (SELECT count(*)::int FROM message) AS messages,
        (SELECT count(*)::int FROM background_task) AS tasks`)).rows[0],{sources:0,messages:0,tasks:0},name);
    }
  }finally{await f.close();}
});

test('处理记录写入故障回滚来源、消息、引用和任务，且不会唤醒Worker',async()=>{
  const f=await fixture();let wakeCount=0;
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>{wakeCount++;return true;}});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    await f.pool.query(`CREATE FUNCTION public.reject_synthetic_processing() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic processing failure'; END $$`);
    await f.pool.query(`CREATE TRIGGER reject_synthetic_processing BEFORE INSERT ON public.source_processing_record
      FOR EACH ROW EXECUTE FUNCTION public.reject_synthetic_processing()`);
    const response=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.equal(response.status,503);
    assert.deepEqual(response.body,{error:'import_commit_failed'});
    assert.equal(wakeCount,0);
    assert.deepEqual((await f.pool.query(`SELECT
      (SELECT count(*)::int FROM source_document) AS sources,
      (SELECT count(*)::int FROM import_confirmation) AS confirmations,
      (SELECT count(*)::int FROM message) AS messages,
      (SELECT count(*)::int FROM wechat_message_metadata) AS metadata,
      (SELECT count(*)::int FROM message_source_ref) AS refs,
      (SELECT count(*)::int FROM background_task) AS tasks,
      (SELECT count(*)::int FROM background_task_step) AS steps,
      (SELECT count(*)::int FROM source_processing_batch) AS batches,
      (SELECT count(*)::int FROM source_processing_record) AS records`)).rows[0],
    {sources:0,confirmations:0,messages:0,metadata:0,refs:0,tasks:0,steps:0,batches:0,records:0});
  }finally{await f.close();}
});

test('预览后文件变化时拒绝旧确认并且不写资料或任务',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    const changed=(await readFile(f.filePath,'utf8')).replace('合成消息一','预览后变化的合成消息');
    await writeFile(f.filePath,changed);
    const response=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.deepEqual(response,{status:409,body:{error:'import_file_changed'}});
    assert.deepEqual((await f.pool.query(`SELECT
      (SELECT count(*)::int FROM source_document) AS sources,
      (SELECT count(*)::int FROM message) AS messages,
      (SELECT count(*)::int FROM background_task) AS tasks`)).rows[0],{sources:0,messages:0,tasks:0});
  }finally{await f.close();}
});

test('Worker不可用仍保留成功导入和可恢复排队任务，不把处理延迟伪装成模型执行',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>false});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    const response=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.equal(response.status,200);
    assert.equal(response.body.processing_deferred,true);
    assert.equal(response.body.deferred_reason,'worker_unavailable');
    const taskId=response.body.task_id;
    const task=(await f.pool.query('SELECT status,retry_count,last_error_code FROM background_task WHERE id=$1',[taskId])).rows[0];
    assert.deepEqual(task,{status:'queued',retry_count:0,last_error_code:null});
    assert.ok((await f.pool.query('SELECT 1 FROM background_task_step WHERE task_id=$1 AND attempt_count<>0',[taskId])).rowCount===0);
    const store=new ExtractionTaskStore(f.pool);
    const claim=await store.claim({ownerId:f.ownerId,contactId:f.contactId},{taskId,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['parse']});
    assert.equal(claim.stepName,'parse');
    await store.complete(claim,3,3);
    assert.equal((await store.progress({ownerId:f.ownerId,contactId:f.contactId},taskId)).tasks[0].status,'interrupted');
    assert.deepEqual(await store.readyScopes(f.ownerId),[{ownerId:f.ownerId,contactId:f.contactId}]);
    const normalize=await store.claim({ownerId:f.ownerId,contactId:f.contactId},{taskId,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['normalize']});
    assert.equal(normalize.stepName,'normalize');
    await store.complete(normalize,3,3);
    const extraction=await store.claim({ownerId:f.ownerId,contactId:f.contactId},{taskId,workerId:randomUUID(),leaseMs:30_000});
    assert.equal(extraction.stepName,'extract_memory');
    assert.equal(extraction.attemptCount,1);
    assert.equal((await store.targets(extraction)).targetIds.length,2);
  }finally{await f.close();}
});

test('来源排队删除后原唤醒不能再领取任务，重复导入不恢复已删除来源',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    const imported=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    const sourceId=(await f.pool.query('SELECT id FROM source_document')).rows[0].id;
    await f.pool.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[sourceId]);
    await f.pool.query("UPDATE background_task SET status='cancelled',current_step='parse',finished_at=now() WHERE id=$1",[imported.body.task_id]);
    await f.pool.query("UPDATE background_task_step SET status='cancelled',lease_expires_at=NULL WHERE task_id=$1",[imported.body.task_id]);
    const store=new ExtractionTaskStore(f.pool);
    assert.equal(await store.claim({ownerId:f.ownerId,contactId:f.contactId},{taskId:imported.body.task_id,workerId:randomUUID(),leaseMs:30_000}),null);
    await assert.rejects(store.resume({ownerId:f.ownerId,contactId:f.contactId},imported.body.task_id,'restart'),{code:'source_unavailable'});
    const repeated=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.deepEqual(repeated,{status:409,body:{error:'import_commit_failed'}});
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM source_document')).rows[0].count,1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM message')).rows[0].count,3);
  }finally{await f.close();}
});

test('不同文件包含稳定消息重叠时整批拒绝，不静默合并或增加来源',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const firstPreview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:firstPreview.body.content_sha256,
    });
    const records=(await readFile(f.filePath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    records[0].text='同一稳定消息身份的合成新内容';
    records.push(record({localId:4,at:'2026-10-20T10:03:00+08:00',fromMe:false,text:'合成新增消息',sender:'合成联系人'}));
    const overlap=join(f.directory,'overlap.jsonl');
    await writeFile(overlap,records.map(value=>JSON.stringify(value)).join('\n')+'\n');
    const preview=await api.handle('POST','/api/imports/preview',{path:overlap,contact_id:f.contactId});
    const response=await api.handle('POST','/api/imports/commit',{
      path:overlap,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.deepEqual(response,{status:409,body:{error:'import_commit_failed'}});
    assert.deepEqual((await f.pool.query(`SELECT
      (SELECT count(*)::int FROM source_document) AS sources,
      (SELECT count(*)::int FROM message) AS messages,
      (SELECT count(*)::int FROM background_task) AS tasks`)).rows[0],{sources:1,messages:3,tasks:1});
  }finally{await f.close();}
});

test('已确认既有联系人尚无active渠道身份时，由同一事务建立该身份但不创建联系人',async()=>{
  const f=await fixture();
  try{
    await f.pool.query("UPDATE channel_identity SET status='revoked' WHERE owner_id=$1 AND contact_id=$2",[f.ownerId,f.contactId]);
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    assert.equal(preview.status,200);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM channel_identity WHERE status=$1',['active'])).rows[0].count,0,
      '预览不得提前建立渠道身份');
    const imported=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.equal(imported.status,200);
    assert.equal(imported.body.contact_id,f.contactId);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM contact')).rows[0].count,1);
    assert.deepEqual((await f.pool.query("SELECT external_id,status FROM channel_identity ORDER BY status")).rows,[
      {external_id:'wxid_synthetic_contact',status:'active'},
      {external_id:'wxid_synthetic_contact',status:'revoked'},
    ]);
  }finally{await f.close();}
});

test('联系人渠道身份撤销后再次确认同一文件仍复用active来源和原任务',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    const body={path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256};
    const first=await api.handle('POST','/api/imports/commit',body);
    await f.pool.query("UPDATE channel_identity SET status='revoked' WHERE owner_id=$1 AND contact_id=$2",[f.ownerId,f.contactId]);
    const repeated=await api.handle('POST','/api/imports/commit',body);
    assert.equal(repeated.status,200);
    assert.equal(repeated.body.task_id,first.body.task_id);
    assert.equal(repeated.body.skipped_duplicates,3);
    assert.deepEqual((await f.pool.query("SELECT external_id,status FROM channel_identity ORDER BY status")).rows,[
      {external_id:'wxid_synthetic_contact',status:'active'},
      {external_id:'wxid_synthetic_contact',status:'revoked'},
    ]);
  }finally{await f.close();}
});

test('导入后的来源处理记录可由现有追溯入口按owner和联系人范围读取',async()=>{
  const f=await fixture();
  try{
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    const script=`import json,sys
from uuid import UUID
from notalone.persistence.source_processing import PostgresSourceProcessingStore
from notalone.scopes import ContactScope
store=PostgresSourceProcessingStore('host=/tmp dbname='+sys.argv[1])
scope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]))
batches=store.list_batches(scope)
detail=store.get_batch(scope,batches[0]['batch_id'])
print(json.dumps({'batch':batches[0],'detail':detail},default=str))`;
    const trace=JSON.parse(execFileSync(python,['-c',script,f.database,f.ownerId,f.contactId],{encoding:'utf8',env:environment}));
    assert.equal(trace.batch.source_kind,'source_document');
    assert.equal(trace.batch.owner_id,f.ownerId);
    assert.equal(trace.batch.contact_id,f.contactId);
    assert.equal(trace.detail.records.length,3);
    assert.equal(trace.detail.records[0].payload.record_text,(await readFile(f.filePath,'utf8')).split('\n')[0]+'\n');
    assert.ok(trace.detail.records.some(record=>record.payload.record_text.includes('合成消息一')));
    assert.ok(trace.detail.records.every(record=>record.payload.model_read_status==='not_claimed'));
  }finally{await f.close();}
});

test('共享HostStorage事务保留身份拒绝码，并在真实关闭屏障内提交导入',async()=>{
  const f=await fixture();let storage;
  try{
    storage=await HostStorage.open({
      envFilePath:join(f.directory,'synthetic.env'),
      migrationsDirectory:join(root,'backend/database/migrations'),
      environment:{NOTALONE_DISABLE_DOTENV:'1',NOTALONE_OWNER_ID:f.ownerId,
        NOTALONE_DATABASE_URL:`host=/tmp dbname=${f.database}`,PATH:process.env.PATH,HOME:f.directory},
    });
    assert.deepEqual(await storage.compatibility(),{code:'ready'});
    const api=new HistoryImportApi({transaction:work=>storage.businessTransaction(work),ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    assert.equal(preview.status,200);
    await f.pool.query("UPDATE owner_channel_identity SET external_id='wxid_shared_host_conflict' WHERE owner_id=$1",[f.ownerId]);
    const conflict=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    assert.deepEqual(conflict,{status:422,body:{error:'import_identity_conflict'}});
    await f.pool.query("UPDATE owner_channel_identity SET external_id='wxid_synthetic_owner' WHERE owner_id=$1",[f.ownerId]);
    const committed=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.equal(committed.status,200);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM message')).rows[0].count,3);
  }finally{await storage?.close();await f.close();}
});

test('超过批量写入边界的合成历史完整保存全部消息与来源处理记录',async()=>{
  const f=await fixture();
  try{
    const records=Array.from({length:501},(_,index)=>{
      const fromMe=index%2===1;
      return record({localId:1_000+index,at:new Date(Date.UTC(2026,9,20,2,0,index)).toISOString(),
        fromMe,text:`合成批次消息${index+1}`,sender:fromMe?'合成本人':'合成联系人',
        senderWxid:fromMe?'wxid_synthetic_owner':'wxid_synthetic_contact'});
    });
    await writeFile(f.filePath,records.map(value=>JSON.stringify(value)).join('\n')+'\n');
    const transaction=async operation=>{
      const client=await f.pool.connect();
      try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
      catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const api=new HistoryImportApi({transaction,ownerId:f.ownerId,wake:()=>true});
    const preview=await api.handle('POST','/api/imports/preview',{path:f.filePath,contact_id:f.contactId});
    const imported=await api.handle('POST','/api/imports/commit',{
      path:f.filePath,contact_id:f.contactId,expected_content_sha256:preview.body.content_sha256,
    });
    assert.equal(imported.status,200);
    assert.equal(imported.body.imported_count,501);
    assert.deepEqual((await f.pool.query(`SELECT
      (SELECT count(*)::int FROM message) AS messages,
      (SELECT count(*)::int FROM wechat_message_metadata) AS metadata,
      (SELECT count(*)::int FROM message_source_ref) AS refs,
      (SELECT count(*)::int FROM source_processing_record) AS records,
      (SELECT count(*)::int FROM background_task_step) AS steps`)).rows[0],
    {messages:501,metadata:501,refs:501,records:501,steps:5});
  }finally{await f.close();}
});
