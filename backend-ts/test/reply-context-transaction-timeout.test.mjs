import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { HostStorage } from '../src/platform/database/host-storage.ts';
import { PostgresReplyContext } from '../src/reply/context/reply-context.ts';
import { captureSnapshot } from '../src/memory/overview/evidence/sources.ts';

async function seedSourceWindow(fixture) {
  const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),candidate=randomUUID(),memory=randomUUID();
  await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
  await fixture.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,owner,contact,source.replaceAll('-','').repeat(2)]);
  await fixture.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','清淡饮食','2026-01-01T01:02:03.123456Z')",[message,owner,contact]);
  await fixture.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,owner,contact,source]);
  const frozen=await captureSnapshot(fixture.client,owner,[message],[message],contact);
  await fixture.client.query("INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,topic,source_ids,status,correction_evidence) VALUES($1,$2,$3,'清淡饮食','common_fact','other',$4,'pending',$5)",[candidate,owner,contact,[message],frozen]);
  await fixture.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method) VALUES($1,$2,$3,'清淡饮食','common_fact','other',$4,$5,'auto')",[memory,owner,contact,[message],candidate]);
  return {owner,contact,message,input:{owner_id:owner,contact_id:contact,reply_request_id:randomUUID(),conversation_binding_id:randomUUID(),history_message_ids:[],request:{contact_id:contact,continued_from_candidate_id:null,content:{type:'rewrite_draft',input_kind:'draft',draft_text:'清淡饮食',include_relationship_context:true}}}};
}

function timeoutHistoryOnce(client, observation) {
  const query = client.query.bind(client);
  return new Proxy(client, { get(target, property) {
    if (property !== 'query') return Reflect.get(target, property, target);
    return async (sql, ...args) => {
      if (observation.breakRecovery && sql === 'ROLLBACK TO SAVEPOINT reply_context_source_window') {
        observation.recovery_attempted=true;
        throw new Error('合成保存点恢复失败');
      }
      const result = await query(sql, ...args);
      if (!observation.injected && typeof sql === 'string' && sql.includes("set_config('statement_timeout'")) {
        observation.injected=true;
        observation.scoped_timeout=(await query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
        try { await query('SELECT pg_sleep(0.65)'); }
        catch (error) { observation.server_code=error.code; throw error; }
      }
      return result;
    };
  }});
}

test('来源窗口真实超时后保留外层事务、原超时设置和本人锁', async t => {
  const fixture=await createStorageFixture();
  const storage=await HostStorage.open(fixture.options);
  const observed={injected:false};
  try {
    const {owner,input}=await seedSourceWindow(fixture);
    const result=await storage.businessTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      await client.query("UPDATE public.owner SET display_name='外层事务仍可提交' WHERE id=$1",[owner]);
      const before=(await client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
      const context=await new PostgresReplyContext(timeoutHistoryOnce(client,observed)).build(input);
      observed.status=context.retrieval?.status;
      observed.tool=context.tool_calls.at(-1)?.status;
      assert.equal(observed.status,'unavailable');
      assert.ok(['failed','timeout'].includes(observed.tool));
      let after;
      try { after=(await client.query("SELECT current_setting('statement_timeout') AS value,1 AS usable")).rows[0]; }
      catch (error) { observed.after_code=error.code; throw error; }
      assert.equal(after.value,before);
      assert.equal(after.usable,1);
      const held=(await fixture.client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`owner:${owner}`])).rows[0].acquired;
      assert.equal(held,false);
      return context;
    });
    assert.equal(observed.injected,true);
    assert.equal(observed.server_code,'57014');
    assert.equal(observed.scoped_timeout,'500ms');
    assert.equal(result.retrieval.status,'unavailable');
    assert.equal((await fixture.client.query('SELECT display_name FROM public.owner WHERE id=$1',[owner])).rows[0].display_name,'外层事务仍可提交');
  } finally {
    t.diagnostic('真实超时观测 '+JSON.stringify(observed));
    await storage.close(); await fixture.close();
  }
});

test('来源窗口成功后恢复调用方事务的原超时设置', async t => {
  const fixture=await createStorageFixture();
  const storage=await HostStorage.open(fixture.options);
  const observed={};
  try {
    const {owner,input}=await seedSourceWindow(fixture);
    await storage.businessTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      observed.before=(await client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
      const context=await new PostgresReplyContext(client).build(input);
      observed.tool=context.tool_calls.at(-1)?.status;
      observed.after=(await client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
      assert.equal(observed.tool,'succeeded');
      assert.equal(observed.after,observed.before,'来源窗口的500ms不能遗留给外层事务');
      assert.equal((await fixture.client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`owner:${owner}`])).rows[0].acquired,false);
      assert.equal((await fixture.client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`owner:${randomUUID()}`])).rows[0].acquired,true);
    });
  } finally { t.diagnostic('成功路径超时设置 '+JSON.stringify(observed)); await storage.close(); await fixture.close(); }
});

test('来源窗口保存点恢复失败时不得返回可用结果或提交外层写入', async t => {
  const fixture=await createStorageFixture();
  const storage=await HostStorage.open(fixture.options);
  const observed={injected:false,breakRecovery:true,returned:false};
  try {
    const {owner,input}=await seedSourceWindow(fixture);
    let failure;
    try {
      await storage.businessTransaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
        await client.query("UPDATE public.owner SET display_name='不应提交的外层写入' WHERE id=$1",[owner]);
        await new PostgresReplyContext(timeoutHistoryOnce(client,observed)).build(input);
        observed.returned=true;
      });
    } catch(error) { failure=error; observed.error_name=error.name; }
    observed.persisted=(await fixture.client.query('SELECT display_name FROM public.owner WHERE id=$1',[owner])).rows[0].display_name;
    assert.equal(observed.injected,true);
    assert.equal(observed.server_code,'57014');
    assert.equal(observed.recovery_attempted,true);
    assert.equal(observed.returned,false);
    assert.equal(failure?.name,'ReplyHistoryRecoveryError');
    assert.equal(observed.persisted,'合成本人');
  } finally { t.diagnostic('保存点恢复故障 '+JSON.stringify(observed)); await storage.close(); await fixture.close(); }
});

test('来源窗口缺少调用方事务时失败关闭，不执行无效的局部超时读取', async t=>{
  const fixture=await createStorageFixture();
  const observed={set_timeout:false};
  try {
    const {input}=await seedSourceWindow(fixture);
    const before=(await fixture.client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
    const query=fixture.client.query.bind(fixture.client);
    const client=new Proxy(fixture.client,{get(target,property){
      if(property!=='query')return Reflect.get(target,property,target);
      return async (sql,...args)=>{
        const isTimeout=typeof sql==='string'&&sql.includes("set_config('statement_timeout'");
        if(isTimeout)observed.set_timeout=true;
        try{const result=await query(sql,...args);if(isTimeout)observed.next_statement_timeout=(await query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;return result;}
        catch(error){if(sql==='SAVEPOINT reply_context_source_window')observed.savepoint_code=error.code;throw error;}
      };
    }});
    await assert.rejects(new PostgresReplyContext(client).build(input),{name:'ReplyHistoryRecoveryError'});
    assert.equal(observed.savepoint_code,'25P01');
    assert.equal(observed.set_timeout,false);
    assert.equal((await fixture.client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value,before);
  } finally {t.diagnostic('无外层事务观测 '+JSON.stringify(observed));await fixture.close();}
});

function cancelHistoryOnce(client, canceller, observation) {
  const query=client.query.bind(client);
  return new Proxy(client,{get(target,property){
    if(property!=='query')return Reflect.get(target,property,target);
    return async (sql,...args)=>{
      const result=await query(sql,...args);
      if(!observation.injected && typeof sql==='string' && sql.includes("set_config('statement_timeout'")){
        observation.injected=true;
        observation.scoped_timeout=(await query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
        const pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const cancel=canceller.query('SELECT pg_sleep(0.05),pg_cancel_backend($1) AS cancelled',[pid]);
        let failure;
        try{await query('SELECT pg_sleep(5)');}catch(error){failure=error;}
        observation.cancelled=(await cancel).rows[0].cancelled;
        observation.server_code=failure?.code;
        observation.user_cancel=Boolean(failure?.message?.includes('user request'));
        if(!failure)throw new Error('合成取消没有中断真实数据库语句');
        throw failure;
      }
      return result;
    };
  }});
}

test('来源窗口真实数据库取消后回滚保存点并保留外层事务', async t=>{
  const fixture=await createStorageFixture();
  const storage=await HostStorage.open(fixture.options);
  const observed={injected:false};
  try{
    const {owner,input}=await seedSourceWindow(fixture);
    await storage.businessTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      const before=(await client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
      const context=await new PostgresReplyContext(cancelHistoryOnce(client,fixture.client,observed)).build(input);
      assert.equal(context.retrieval.status,'unavailable');
      assert.equal(context.tool_calls.at(-1).status,'failed');
      const after=(await client.query("SELECT current_setting('statement_timeout') AS value,1 AS usable")).rows[0];
      assert.equal(after.value,before);assert.equal(after.usable,1);
      assert.equal((await fixture.client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`owner:${owner}`])).rows[0].acquired,false);
    });
    assert.equal(observed.injected,true);assert.equal(observed.cancelled,true);
    assert.equal(observed.server_code,'57014');assert.equal(observed.user_cancel,true);assert.equal(observed.scoped_timeout,'500ms');
  }finally{t.diagnostic('真实数据库取消 '+JSON.stringify(observed));await storage.close();await fixture.close();}
});

test('正式Host来源窗口真实超时返回可审阅准备结果且零模型HTTP',{timeout:30000},async t=>{
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join,resolve}=await import('node:path');
  const {startReplyServiceHost}=await import('./reply-service-runtime-support.mjs');
  const fixture=await createStorageFixture();
  const home=await mkdtemp(join(tmpdir(),'notalone-context-timeout-'));
  const token=randomUUID()+randomUUID();
  let host;
  t.after(async()=>{
    if(host&&host.child.exitCode===null&&host.child.signalCode===null)await host.stop();
    await fixture.close();await rm(home,{recursive:true,force:true});
  });
  const {owner,contact,input}=await seedSourceWindow(fixture);
  await fixture.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[randomUUID(),owner,contact]);
  host=await startReplyServiceHost(t,{name:fixture.client.database,user:fixture.client.user,replyOwner:owner,replyToken:token,close:async()=>{}},(_request,response)=>{response.writeHead(500).end('unexpected model request');},{
    pluginPath:'test/host-reply-runtime-plugin.ts',environment:{NOTALONE_SYNTHETIC_PERSISTENT:'1',NOTALONE_SYNTHETIC_BUSINESS_HOME:home,NODE_OPTIONS:`--import ${resolve('test/reply-context-timeout-preload.mjs')}`},
  });
  async function post(path,body){
    const response=await fetch(host.url+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json','x-notalone-manual-contact':contact},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok){try{const fault=JSON.parse((await readFile(join(home,'source-window-timeout.jsonl'),'utf8')).trim());t.diagnostic('正式Host失败现场 '+JSON.stringify({server_code:fault.code,status:response.status,model_http:host.requests.length}));}catch{}}
    assert.equal(response.status,200,JSON.stringify(data));return data;
  }
  const base=`/api/contacts/${contact}/assistant-sessions`;
  const session=await post(base,{});
  const request={contact_id:contact,idempotency_key:randomUUID(),content:input.request.content,skill_disabled:true};
  const prepared=await post(`${base}/${session.session_id}/replies/prepare`,request);
  assert.equal(prepared.session_id,session.session_id);
  assert.equal(host.requests.length,0);
  const fault=JSON.parse((await readFile(join(home,'source-window-timeout.jsonl'),'utf8')).trim());
  assert.equal(fault.code,'57014');
  const row=(await fixture.client.query('SELECT prepared_context FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[owner,contact,request.idempotency_key])).rows[0];
  assert.ok(row?.prepared_context);
  const retrieval=row.prepared_context.context.retrieval.fields;
  assert.equal(retrieval.status,'unavailable');
  assert.ok(retrieval.queries.some(query=>query.fields.purpose==='source_window'&&query.fields.status==='failed'));
  t.diagnostic('正式Host真实超时 '+JSON.stringify({server_code:fault.code,retrieval:retrieval.status,model_http:host.requests.length}));
});
