import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createSocketServer,createConnection} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {startModelHost} from '../src/model-host.ts';
import {createHostModelAccounting,modelTaskRequestId} from '../src/host-model-accounting.ts';

// 与既有 Python 总账保持同一 SQLite 合同；原始请求只存在本机假 provider 内存。
async function legacyBudget(path,{limit=8,deadline=Date.now()/1000+1800}={}) {
 await writeFile(path,'',{mode:0o600});
 const db=new DatabaseSync(path);
 try {
  db.exec('CREATE TABLE budget(problem TEXT,max_calls INTEGER,deadline REAL,used INTEGER,streak INTEGER); CREATE TABLE rounds(id TEXT PRIMARY KEY,hypothesis TEXT,evidence TEXT,outcome TEXT)');
  db.prepare('INSERT INTO budget VALUES(?,?,?,0,0)').run('synthetic-memory-quality',limit,deadline);
  db.prepare('INSERT INTO rounds VALUES(?,?,NULL,NULL)').run('r1','只验证发送前累计预留');
 } finally {db.close();}
}
function status(path) {const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT used,streak FROM budget').get();}finally{db.close();}}
async function createTask(f,kind,step) {
 const task=(await f.client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'running',$4,0) RETURNING id",[f.owner,f.contact,kind,step])).rows[0].id;
 const worker=randomUUID(),id=(await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at) VALUES($1,$2,1,'running',$3,1,1,now()+interval '5 minutes') RETURNING id",[task,step,worker])).rows[0].id;
 return {task_id:task,step_id:id,step_name:step,worker_id:worker,lease_generation:1};
}
async function layeredWork(f) {
 const claim=await createTask(f,'layered_memory','organize_memory'),batch=randomUUID();
 await f.client.query('INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,$2,true,1)',[f.owner,f.contact]);
 await f.client.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required,profile_status) VALUES($1,$2,$3,1,'synthetic','synthetic','{}','{}','active',1,16,true,'pending')",[claim.task_id,f.owner,f.contact]);
 await f.client.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id) VALUES($1,$2,$3,1,$4,'running','[]','[]','{}',now(),$5)",[batch,f.owner,f.contact,randomUUID(),claim.task_id]);
 return {claim,batch};
}

async function fixture(t,{budget=true,afterReserve}={}) {
 const directory=await mkdtemp(join(tmpdir(),'na-diagnostic-budget-'));
 await chmod(directory,0o700);
 const ledger=join(directory,'problem.sqlite');if(budget)await legacyBudget(ledger);
 const name=`notalone_diag_${randomUUID().replaceAll('-','')}_test`;
 const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
 await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
 const client=new pg.Client({host:'/tmp',database:name});await client.connect();
 const children=[],proxies=[];let host,provider,dropResponse=false,settledAfterCorruptAck=0;const requests=[];
 t.after(async()=>{
  for(const child of children)await child.stop();
  for(const proxy of proxies)await proxy();
  await host?.shutdown();
  if(provider){provider.closeAllConnections();await new Promise(r=>provider.close(r));}
  await client.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end();
  await rm(directory,{recursive:true,force:true});
 });
 const migrations=new URL('../../backend/database/migrations/',import.meta.url);
 for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await client.query(await readFile(new URL(file,migrations),'utf8'));
 const owner=(await client.query("INSERT INTO owner(display_name) VALUES('合成') RETURNING id")).rows[0].id;
 const contact=(await client.query("INSERT INTO contact(owner_id,display_name) VALUES($1,'合成') RETURNING id",[owner])).rows[0].id;
 await client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status) VALUES($1,$2,'wechat','synthetic','synthetic','active')",[owner,contact]);
 const task=(await client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,'observation','running','extract_memory',0) RETURNING id",[owner,contact])).rows[0].id;
 const worker=randomUUID(),step=(await client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at) VALUES($1,'extract_memory',1,'running',$2,1,1,now()+interval '5 minutes') RETURNING id",[task,worker])).rows[0].id;
 const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
 async function registerBatch(key) {
  const trace=randomUUID();
  await client.query('INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES($1,$2,$3,$4,$5)',[trace,owner,contact,randomUUID(),key]);
  await client.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES($1,$2,$3,$4,1,'window',$5)",[randomUUID(),trace,owner,contact,{task_runtime:claim}]);
  await client.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) VALUES($1,$2,$3,$4,2,'typescript_a_result',$5)",[randomUUID(),trace,owner,contact,{outcome:{accepted:[{}]}}]);
  return modelTaskRequestId('extraction',task,key);
 }
 const key='a'.repeat(64);await registerBatch(key);
 const transaction=async work=>{
  const c=new pg.Client({host:'/tmp',database:name});await c.connect();
  try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{await c.end();}
 };
 const accounting=createHostModelAccounting({transaction,provider:'synthetic',typescriptProvider:'synthetic-route',model:'synthetic-model',unconfirmedPermitIds:()=>host?.unconfirmedPermitIds()??[]});
 host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:directory},businessHome:directory,infoPath:join(directory,'info'),envFilePath:join(directory,'env'),accounting:{...accounting,
  reserve:async(...args)=>{await accounting.reserve(...args);await afterReserve?.(ledger);}}});
 provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  requests.push(req.url);
  if(dropResponse){dropResponse=false;req.socket.destroy();return;}
  const body=JSON.parse(raw);
  if(req.url==='/beta/chat/completions') {
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'synthetic',type:'function',function:{name:'SourceVerificationOutput',arguments:JSON.stringify({results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[],proof:null}]})}}]}}],usage:{prompt_tokens:3,completion_tokens:1}}));return;
  }
  if(JSON.stringify(body).includes('FAIL_503')){res.writeHead(503);res.end('{}');return;}
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 async function start(label,{scenario=false,round='r1',corruptReserveAck=false}={}) {
  const home=join(directory,label),profile=join(home,'profiles','notalone');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(resolve(scenario?'test/diagnostic-scenario-budget-plugin.ts':'test/extraction-model-plugin.ts'))}\n`);
  let permitPath=host.pythonEnvironment.NOTALONE_MODEL_PERMIT_SOCKET;
  if(corruptReserveAck) {
   const sockets=new Set(),path=join(directory,'ack.sock'),targetPermitPath=permitPath;
   const proxy=createSocketServer(local=>{
    const remote=createConnection(targetPermitPath),pair=[local,remote];for(const socket of pair){sockets.add(socket);socket.on('error',()=>{for(const other of pair)other.destroy();});socket.once('close',()=>{sockets.delete(socket);for(const other of pair)other.destroy();});}
    let buffer='',corrupted=false;
    local.on('data',data=>{if(corrupted&&data.toString().includes('"op":"settled"'))settledAfterCorruptAck++;remote.write(data);});
    remote.on('data',data=>{buffer+=data.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(JSON.parse(line).state==='reserved'){corrupted=true;local.write('lost-valid-reservation-ack\n');}else local.write(line+'\n');}});
   });
   proxy.listen(path);await once(proxy,'listening');
   proxies.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>proxy.close(r));});
   permitPath=path;
  }
  const child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:home,env:{PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',...host.pythonEnvironment,NOTALONE_MODEL_PERMIT_SOCKET:permitPath,...(budget?{NOTALONE_PROBLEM_BUDGET:ledger,NOTALONE_PROBLEM_ROUND:round}:{}),NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let log='';child.stderr.on('data',v=>log+=v);
  const running={stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;}};children.push(running);
  const url=await new Promise((done,reject)=>{
   const timer=setTimeout(()=>reject(new Error(log.slice(-700))),10000);
   child.stdout.on('data',v=>{log+=v;const match=log.match(/(?:EXTRACTION_MODEL|DIAGNOSTIC_SCENARIO)_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);done(match[1]);}});
   child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-700)));});
  });
  return {...running,call:async(extra={})=>await(await fetch(url,{method:'POST',body:JSON.stringify({request_id:modelTaskRequestId('extraction',task,key),owner_id:owner,contact_id:contact,claim,attempt_id:randomUUID(),...extra})})).json()};
 }
 return {ledger,start,requests,client,owner,contact,claim,task,key,registerBatch,dropNextResponse:()=>{dropResponse=true;},unconfirmedPermits:()=>host.unconfirmedPermitIds(),settledAfterCorruptAck:()=>settledAfterCorruptAck};
}

test('真实 PG 许可与两种 HTTP 发送共用八次总账，重启和换目录后第九次零出站',{timeout:30000},async t=>{
 const f=await fixture(t),first=await f.start('run-one');
 for(let i=0;i<4;i++)assert.equal((await first.call()).receipt?.outcome,'succeeded');
 await first.stop();
 const second=await f.start('new-prompt-directory');
 const strict={system:'合成核验提示',tools:[{name:'SourceVerificationOutput',description:'合成核验',parameters:{type:'object',additionalProperties:false,properties:{supported:{type:'boolean'}},required:['supported']}}]};
 for(let i=0;i<4;i++){const result=await second.call(i%2?strict:{});assert.equal(result.receipt?.outcome,'succeeded',JSON.stringify(result));}
 assert.equal(f.requests.length,8);
 const ninth=await second.call(strict);
 assert.ok(ninth.error,'第九次必须在实际 HTTP 发送前拒绝');
 assert.equal(f.requests.length,8,'第九次不得增加真实 upstream 请求');
 assert.equal(status(f.ledger).used,8);
 assert.equal((await f.client.query('SELECT count(DISTINCT permit_id)::int AS n FROM model_call_receipt')).rows[0].n,8);
});

test('PG 授权等待期间到期：预留不退款、零 HTTP，确定未发送不新增 unknown',{timeout:30000},async t=>{
 const f=await fixture(t,{afterReserve:path=>{const db=new DatabaseSync(path);try{db.exec('UPDATE budget SET deadline=0');}finally{db.close();}}});
 const child=await f.start('expires-during-authorization'),result=await child.call();
 assert.ok(result.error,'授权等待跨过截止时间后必须拒发');
 assert.equal(f.requests.length,0);
 assert.equal(status(f.ledger).used,1,'已预留的额度不能因截止后拒发退款');
 assert.equal(result.receipt?.dispatch,'not_sent');
 assert.equal(result.receipt?.outcome,'cancelled');
 assert.equal((await f.client.query("SELECT count(*)::int n FROM model_call_receipt WHERE outcome='unknown'")).rows[0].n,0);
});

test('两个独立 provider 进程并发竞争同一问题：十二次许可最多八次真实 HTTP',{timeout:30000},async t=>{
 const f=await fixture(t),first=await f.start('concurrent-one'),second=await f.start('concurrent-two');
 const requestIds=[];for(let n=0;n<12;n++)requestIds.push(await f.registerBatch(n.toString(16).padStart(64,'0')));
 const results=await Promise.all(requestIds.map((request_id,index)=>(index%2?first:second).call({request_id})));
 assert.equal(results.filter(r=>r.receipt?.outcome==='succeeded').length,8);
 assert.equal(results.filter(r=>r.error).length,4);
 assert.equal(status(f.ledger).used,8);
 assert.equal(f.requests.length,8);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,8);
 const before=f.requests.length;await second.call();assert.equal(f.requests.length,before);
});

test('PG 拒绝、预留后取消和 HTTP 失败均不退款；预算拒绝不产生新 unknown',{timeout:30000},async t=>{
 const f=await fixture(t),child=await f.start('conservative-reservations');
 const rejected=await child.call({wrongLedger:true});assert.ok(rejected.error);
 assert.equal(status(f.ledger).used,1);assert.equal(f.requests.length,0);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
 const cancelled=await child.call({cancelBeforeDispatch:true});assert.ok(cancelled.error);
 assert.equal(cancelled.receipt?.dispatch,'not_sent');assert.equal(cancelled.receipt?.outcome,'cancelled');
 assert.equal(status(f.ledger).used,2);assert.equal(f.requests.length,0);
 const failed=await child.call({providerStatus:503});assert.equal(failed.receipt?.outcome,'failed');
 assert.equal(status(f.ledger).used,3);assert.equal(f.requests.length,1);
 for(let i=0;i<5;i++)assert.equal((await child.call()).receipt?.outcome,'succeeded');
 assert.equal(status(f.ledger).used,8);assert.equal(f.requests.length,6);
 const ninth=await child.call();assert.ok(ninth.error);assert.equal(f.requests.length,6);
 assert.equal((await f.client.query("SELECT count(*)::int n FROM model_call_receipt WHERE outcome='unknown'")).rows[0].n,0);
});

test('同一问题的 E、strict-V、B、关系、合并、L2、L3 和学习共用物理总额',{timeout:30000},async t=>{
 const f=await fixture(t),child=await f.start('all-model-purposes'),scenario=await f.start('real-scenario-call-port',{scenario:true});
 const call=async extra=>{const result=await child.call(extra);assert.equal(result.receipt?.outcome,'succeeded',JSON.stringify(result));};
 await call();
 await call({system:'合成核验',tools:[{name:'SourceVerificationOutput',description:'核验',parameters:{type:'object',properties:{supported:{type:'boolean'}}}}]});
 for(const purpose of ['adjudication','relation_verification','merge_verification'])await call({request_id:modelTaskRequestId(purpose,f.task,`${f.key}:${purpose==='merge_verification'?0:'batch'}`)});
 const {claim:layered,batch}=await layeredWork(f);
 assert.ok((await scenario.call({claim:layered,batch_id:batch})).receipt_id);
 await f.client.query("UPDATE layered_memory_batch SET status='succeeded' WHERE id=$1",[batch]);
 const profile=randomUUID();
 await f.client.query("INSERT INTO layered_profile_batch(id,owner_id,contact_id,settings_generation,organization_generation,work_key,work_token,budget_batch_id,task_id,status,lease_expires_at,scenario_version_ids,input_manifest,input_payload,dependency_ids,created_at) VALUES($1,$2,$3,1,0,$4,$5,$6,$7,'running',now()+interval '5 minutes','{}','[]','{}','{}',now())",[profile,f.owner,f.contact,randomUUID(),randomUUID(),batch,layered.task_id]);
 assert.ok((await scenario.call({claim:layered,batch_id:profile})).receipt_id);
 const learning=await createTask(f,'skill_learning','propose_skill');
 await f.client.query("INSERT INTO skill_learning_scope(owner_id,contact_id,enabled,last_attempt_key) VALUES($1,$2,true,'synthetic-learning')",[f.owner,f.contact]);
 await call({request_id:modelTaskRequestId('skill_learning',learning.task_id,'synthetic-learning'),claim:learning});
 assert.equal(f.requests.length,8);assert.equal(status(f.ledger).used,8);
 assert.equal((await scenario.call({claim:layered,batch_id:profile})).error,'l2_scenario_model_failed','发送前预算拒绝必须确定收尾，不能成为 ACK unknown');
 assert.equal(f.requests.length,8,'换回 L3 不能另起总额');
 await scenario.stop();assert.equal(f.unconfirmedPermits().length,0,'确定未调用 PG 的预算拒绝不能留下孤儿许可');
});

test('实际 L2 caller 已进入 PG 回调但有效预约 ACK 丢失：不误 settle，保留原未知许可',{timeout:30000},async t=>{
 const f=await fixture(t),work=await layeredWork(f),child=await f.start('scenario-lost-reserve-ack',{scenario:true,corruptReserveAck:true});
 const result=await child.call({claim:work.claim,batch_id:work.batch});
 assert.equal(result.error,'l2_scenario_model_ack_unknown');
 assert.equal(f.requests.length,0);assert.equal(status(f.ledger).used,1);
 await child.stop();
 const rows=(await f.client.query('SELECT permit_id,outcome FROM model_call_receipt')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].outcome,'pending');
 assert.equal(f.settledAfterCorruptAck(),0,'进入过预约回调的 ACK unknown 不得按未发送观测自动 settle');
 assert.deepEqual(f.unconfirmedPermits(),[rows[0].permit_id]);
});

test('旧 observation 缺失回调标记时仍按未知保守处理，不凭 not_authorized 释放许可',{timeout:30000},async t=>{
 const f=await fixture(t),work=await layeredWork(f);
 const db=new DatabaseSync(f.ledger);try{db.exec('UPDATE budget SET used=8');}finally{db.close();}
 const child=await f.start('scenario-legacy-observation',{scenario:true});
 const result=await child.call({claim:work.claim,batch_id:work.batch,legacyObservation:true});
 assert.equal(result.error,'l2_scenario_model_ack_unknown');
 await child.stop();assert.equal(f.unconfirmedPermits().length,1);
 assert.equal(f.requests.length,0);assert.equal(status(f.ledger).used,8);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
});

test('旧真实 transport unknown 在重启后仍拒绝重放，原回执和已用额度保留',{timeout:30000},async t=>{
 const f=await fixture(t),first=await f.start('unknown-original-writer');f.dropNextResponse();
 const result=await first.call();assert.equal(result.receipt?.outcome,'unknown');
 const original=(await f.client.query('SELECT attempt_id,permit_id,outcome FROM model_call_receipt')).rows;
 assert.equal(f.requests.length,1);assert.equal(status(f.ledger).used,1);
 await first.stop();const restarted=await f.start('unknown-restarted-writer');
 assert.ok((await restarted.call()).error);
 assert.equal(f.requests.length,1);
 assert.equal(status(f.ledger).used,2,'PG 已知 unknown 拒绝之后仍不退还本次预留');
 assert.deepEqual((await f.client.query('SELECT attempt_id,permit_id,outcome FROM model_call_receipt')).rows,original);
});

test('未配置问题总账时沿用原产品额度，不创建诊断账本',{timeout:30000},async t=>{
 const f=await fixture(t,{budget:false}),child=await f.start('ordinary-product');
 for(let i=0;i<9;i++)assert.equal((await child.call()).receipt?.outcome,'succeeded');
 assert.equal(f.requests.length,9);
 await assert.rejects(readFile(f.ledger),{code:'ENOENT'});
});

for(const stop of [
 {name:'发送前已经截止',round:'r1',sql:'UPDATE budget SET deadline=0'},
 {name:'上一轮未结案时改为下一轮',round:'r2',sql:''},
 {name:'连续两轮无改善',round:'r1',sql:"UPDATE rounds SET outcome='unchanged'; INSERT INTO rounds VALUES('r2','合成假设','合成证据','unknown'); UPDATE budget SET streak=2"},
])test(`${stop.name}：普通与 strict 请求均在 PG 预约前零出站`,{timeout:30000},async t=>{
 const f=await fixture(t);
 if(stop.sql){const db=new DatabaseSync(f.ledger);try{db.exec(stop.sql);}finally{db.close();}}
 const child=await f.start('stopped-before-reservation',{round:stop.round});
 for(const extra of [{},{system:'合成核验',tools:[{name:'SourceVerificationOutput',description:'核验',parameters:{type:'object',properties:{supported:{type:'boolean'}}}}]}])assert.ok((await child.call(extra)).error);
 assert.equal(f.requests.length,0);assert.equal(status(f.ledger).used,0);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
 assert.equal(f.unconfirmedPermits().length,0);
});
