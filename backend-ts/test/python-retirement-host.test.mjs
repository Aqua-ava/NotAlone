import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile,mkdtemp,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchDsh} from '../src/launch.ts';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {pureTsRuntimeEnvironment} from '../src/host/pure-ts-runtime.ts';
import {resolveHistoryRuntime} from '../src/imports/history-runtime.ts';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
import {waitForHostReady} from './host-readiness-support.mjs';

test('不设置运行时开关也只有 TypeScript 执行责任方',()=>{
 const environment=pureTsRuntimeEnvironment({NOTALONE_OWNER_ID:'synthetic-owner'});
 for(const key of ['NOTALONE_HOST_RUNTIME','NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_HISTORY_RUNTIME',
  'NOTALONE_EXTRACTION_B_RUNTIME','NOTALONE_TASK_WORKER_RUNTIME'])
  assert.equal(environment[key],'typescript');
 assert.equal(environment.NOTALONE_OWNER_ID,'synthetic-owner');
 assert.equal(resolveHistoryRuntime({},{incrementalRemoteAvailable:true}),'typescript');
 for(const key of ['NOTALONE_HOST_RUNTIME','NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_HISTORY_RUNTIME',
  'NOTALONE_EXTRACTION_B_RUNTIME','NOTALONE_TASK_WORKER_RUNTIME'])
  for(const value of ['python','legacy'])assert.throws(()=>pureTsRuntimeEnvironment({[key]:value}));
 assert.throws(()=>resolveHistoryRuntime({NOTALONE_HISTORY_RUNTIME:'python'},{incrementalRemoteAvailable:true}));
});

test('模型成功后超过旧租约的合法保存可完成，真实取消仍拒绝迟到结果',{timeout:30000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 let held=false,entered,release,calls=0;
 const provider=createServer(async(req,res)=>{
  for await(const chunk of req){}
  calls++;
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次合成原句',citation_ids:['c1'],risk_notes:[]}]});
  if(held){release=()=>sendEvents(res,events);entered();return;}
  sendEvents(res,events);
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 f.cleanup(async()=>{provider.closeAllConnections();await new Promise(r=>provider.close(r));});
 const preload=join(f.directory,'generation-clock.mjs'),wrapper=join(f.directory,'node-wrapper'),stderrPath=join(f.directory,'generation.stderr');
 // 仅在本轮合成进程的首个模型流成功后推进业务时钟35秒，不等待或放宽生产资格检查。
 await writeFile(preload,`import ${JSON.stringify(new URL('./main-host-reply-chain-preload.mjs',import.meta.url).href)};
 const RealDate=Date;let offset=0,shifted=false;
 globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[RealDate.now()+offset]));}static now(){return RealDate.now()+offset;}};
 const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const response=await original(input,init),url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(!url.startsWith('https://api.deepseek.com/')||!response.body)return response;
  const reader=response.body.getReader();
  return new Response(new ReadableStream({async pull(controller){const part=await reader.read();if(part.done){if(!shifted){shifted=true;offset=35000;}controller.close();}else controller.enqueue(part.value);},cancel(reason){return reader.cancel(reason);}}),{status:response.status,headers:response.headers});
 };`,{mode:0o600});
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 await writeFile(stderrPath,'',{mode:0o600});
 await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preload)} "$@" 2>> ${quote(stderrPath)}\n`,{mode:0o700});
 const infoPath=join(f.directory,'generation.info');
 const host=await launchDsh({nodeExecutable:wrapper,projectDirectory:resolve('..'),envFilePath:join(f.directory,'runtime.env'),infoPath,businessHome:f.directory,
  environment:{NOTALONE_MANAGED_USER_DATA:f.directory,NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',
   NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`}},()=>true);
 f.cleanup(async()=>{assert.equal(await host.terminate(),true);});
 let connection;
 try{connection=await waitForHostReady(host,infoPath,{stderrPath});}
 catch(error){
  // 失败证据独立于fixture寿命，避免after清理后只剩无法回查的stderr路径。
  const diagnostic=await mkdtemp(join(tmpdir(),'notalone-startup-diagnostic-')),saved=join(diagnostic,'stderr.log');
  await copyFile(stderrPath,saved);await writeFile(join(diagnostic,'readiness.json'),JSON.stringify({code:error.code,running:error.running,elapsed_ms:error.elapsed_ms,pid:host.pid,stderrPath:saved}),{mode:0o600});
  error.stderrPath=saved;throw error;
 }
 assert.ok(connection,'合成官方宿主必须发布认证握手');
 const request=async(path,body,signal)=>{
  const response=await fetch(`http://${connection.address}${path}`,{method:body===undefined?'GET':'POST',
   headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json','X-NotAlone-Manual-Contact':contact},
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
  return {status:response.status,data:await response.json()};
 };
 // 手动确认走独立联系人接口，生成请求不伪造渠道身份。
 await fetch(`http://${connection.address}/api/contacts/${contact}/manual-confirmation`,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:'{}'});
 const session=(await request(`/api/contacts/${contact}/assistant-session/default`,{})).data.session_id;
 const path=`/api/contacts/${contact}/assistant-sessions/${session}/replies`;
 const body=()=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:'明天见',include_relationship_context:false},skill_disabled:true});
 const input=body();assert.equal((await request(path+'/prepare',input)).status,200);
 const completed=await request(path,input);
 assert.equal(completed.status,200,JSON.stringify(completed.data));
 assert.equal(completed.data.state,'completed');assert.equal(completed.data.candidates[0].text,'明天见');
 const saved=(await f.client.query('SELECT r.state,extract(epoch FROM (a.lease_expires_at-a.started_at))*1000 AS lease_ms FROM reply_request r JOIN reply_attempt a ON a.reply_request_id=r.id AND a.number=r.attempt WHERE r.idempotency_key=$1',[input.idempotency_key])).rows[0];
 assert.equal(saved.state,'completed');assert.equal(Number(saved.lease_ms),120000);
 assert.deepEqual((await f.client.query('SELECT outcome FROM model_call_receipt WHERE request_id=$1',[completed.data.reply_request_id])).rows.map(row=>row.outcome),['succeeded']);
 held=true;const waiting=new Promise(r=>{entered=r;}),cancelled=body();
 assert.equal((await request(path+'/prepare',cancelled)).status,200);
 const controller=new AbortController(),pending=request(path,cancelled,controller.signal);
 const rejected=assert.rejects(pending,error=>error.name==='AbortError');
 await waiting;controller.abort();await rejected;release();
 let state;
 for(let i=0;i<100;i++){
  state=(await f.client.query('SELECT state FROM reply_request WHERE idempotency_key=$1',[cancelled.idempotency_key])).rows[0]?.state;
  if(state==='failed')break;
  await new Promise(r=>setTimeout(r,25));
 }
 assert.equal(state,'failed');assert.equal(calls,2,'取消与延长期限均不得隐式重放');
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM reply_candidate c JOIN reply_request r ON r.id=c.reply_request_id WHERE r.idempotency_key=$1',[cancelled.idempotency_key])).rows[0].n,0);
});

test('默认官方宿主公开 TS 职责并拒绝退回旧执行者',{timeout:30000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 const app=await f.start({NOTALONE_HOST_RUNTIME:undefined,NOTALONE_OWNER_ID:owner});
 const status=await app.request('/api/runtime/status');
 assert.equal(status.status,200);
 assert.equal(status.data.hostRuntime,'typescript');
 assert.equal(status.data.legacyPid,undefined);
 for(const value of Object.values(status.data.ownership))assert.ok(!['python','legacy','split'].includes(value));
 const processes=execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{
  const [,pid,ppid,command]=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);return {pid:+pid,ppid:+ppid,command};
 });
 const owned=new Set([app.host.pid]);
 for(let i=0;i<processes.length;i++)for(const item of processes)if(owned.has(item.ppid))owned.add(item.pid);
 assert.deepEqual(processes.filter(item=>owned.has(item.pid)&&/python/i.test(item.command)),[]);
 assert.deepEqual((await app.request('/api/contacts')).data.contacts.map(item=>item.contact_id),[contact]);
 assert.equal((await app.request('/api/skills/health')).status,200);
 for(const domain of ['contact-context','memory-management']){
  const before=await app.request(`/api/runtime/${domain}/status`);
  assert.equal(before.data.owner,'typescript');
  assert.equal(before.data.state,'running');
  assert.equal((await app.request(`/api/runtime/${domain}/handoff`,{target:'python'})).status,404);
  assert.deepEqual((await app.request(`/api/runtime/${domain}/status`)).data,before.data);
 }
 assert.equal((await app.request('/api/setup/status')).status,200);
 assert.equal((await app.request('/api/runtime/shutdown',{})).data.state,'stopped');
 assert.equal(await app.host.waitForExit(7000),true);
});
