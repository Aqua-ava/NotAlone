/** 实际官方profile、PG、Unix许可及本机SSE；不向真实模型派发。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {captureProcessIdentity} from '../src/process-identity.ts';
import {modelTaskRequestId} from '../src/host-model-accounting.ts';
import {startModelHost} from '../src/model-host.ts';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';

function evidenceId(body){
 let id;
 const visit=value=>{
  if(Array.isArray(value))return value.forEach(visit);
  if(value&&typeof value==='object'){if(Array.isArray(value.evidence))id??=value.evidence[0]?.evidence_id;Object.values(value).forEach(visit);}
  if(typeof value==='string'){try{visit(JSON.parse(value));}catch{const a=value.indexOf('{'),b=value.lastIndexOf('}');if(a>=0&&b>a)try{visit(JSON.parse(value.slice(a,b+1)));}catch{}}}
 };visit(body);assert.ok(id);return id;
}
function channel(path){
 const socket=connect(path);let buffer='',waiter;const queued=[];
 socket.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(waiter){const current=waiter;waiter=undefined;current(message);}else queued.push(message);}});
 return {socket,async call(value){socket.write(JSON.stringify(value)+'\n');if(queued.length)return queued.shift();return Promise.race([new Promise(resolve=>waiter=resolve),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('合成许可回执超时')),5000);timer.unref();})]);}};
}
test('统一宿主真实恢复PG、官方匿名身份/私有鉴权、共享Python及取消排空',{timeout:90000},async t=>{
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),controlToken=randomUUID()+randomUUID();
 const business=join(f.directory,'business'),profileHome=join(f.directory,'profile-home');await mkdir(business,{mode:0o700});
 const requests=[];let slow=false,entered,releaseLate,child,exited,output='',socketDirectory;
 const enteredPromise=new Promise(resolve=>entered=resolve);
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push({path:req.url,headers:req.headers,body});
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},
    {},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'合成本机原句',citation_ids:[evidenceId(body)],risk_notes:[]}]});
  if(slow){releaseLate=()=>sendEvents(res,events);entered();return;}sendEvents(res,events);
 });
 let stopped=false;
 async function stop(){
  if(stopped||!child)return;stopped=true;
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  let forced=false;const timer=setTimeout(()=>{forced=true;child.kill('SIGKILL');},6000);
  await exited;clearTimeout(timer);assert.equal(forced,false,'实际清理必须完成，不能以kill冒充正常排空');
 }
 t.after(async()=>{await stop();provider.closeAllConnections();if(provider.listening)await new Promise(resolve=>provider.close(resolve));if(socketDirectory)await rm(socketDirectory,{recursive:true,force:true});await f.close();});
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成统一宿主本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 await f.client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status) VALUES($1,$2,'wechat','synthetic','synthetic','active')",[owner,contact]);
 await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.client.database}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_EXTRACTION_BATCH_CONCURRENCY=2\nNOTALONE_SKILLS_DIR=${f.directory}/skills\n`,{mode:0o600});
 const seedOptions={runtimeEnvironment:{NOTALONE_EXTRACTION_BATCH_CONCURRENCY:'2'},businessHome:business,envFilePath:f.envFilePath,infoPath:join(business,'backend.info')};
 const seed=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',
  "import {startModelHost} from './src/model-host.ts';import {captureProcessIdentity} from './src/process-identity.ts';const h=await startModelHost(JSON.parse(process.argv[1]));const p=await h.arbiter.acquire('background',undefined,await captureProcessIdentity(process.pid,process.ppid,process.execPath));console.log(JSON.stringify({id:p.id,statePath:h.statePath}));process.exit(0);",JSON.stringify(seedOptions)],{encoding:'utf8',timeout:10000}));
 socketDirectory=join('/tmp',`na-model-${process.getuid?.()??'local'}-${basename(dirname(seed.statePath))}`);
 const unknownAttempt=randomUUID(),unknownRequest=randomUUID(),knownAttempt=randomUUID(),knownRequest=randomUUID();
 await f.client.query("INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,called_at,dispatch,outcome,cost_status) VALUES($1,$2,$3,$4,$5,'deepseek','deepseek-flash',now(),'authorized_unconfirmed','pending','unknown')",[unknownAttempt,owner,contact,unknownRequest,seed.id]);
 await f.client.query("INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,called_at,dispatch,outcome,cost_status) VALUES($1,$2,$3,$4,$5,'deepseek','deepseek-flash',now(),'not_sent','failed','unknown')",[knownAttempt,owner,contact,knownRequest,seed.id]);
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 async function startProfile(home){
 stopped=false;output='';
 const profile=join(home,'profiles/notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 await writeFile(join(profile,'cordis.patch.yml'),(await readFile('profile/host.patch.yml','utf8')).replace('PLUGIN_PATH',resolve('test/host-model-integration-plugin.ts')));
 child=spawn(process.execPath,['--import',resolve('test/host-model-network-guard.mjs'),resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
  cwd:home,env:{PATH:process.env.PATH,USER:process.env.USER,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',
   NOTALONE_SYNTHETIC_BUSINESS:business,NOTALONE_SYNTHETIC_ENV:f.envFilePath,NOTALONE_SYNTHETIC_CONTROL_TOKEN:controlToken,NOTALONE_SYNTHETIC_CONTACT:contact,
   NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`,NOTALONE_SYNTHETIC_PYTHON:join(homedir(),'miniconda3/envs/NotAlone/bin/python')},stdio:['ignore','pipe','pipe']});
 exited=once(child,'exit');child.stderr.on('data',data=>output+=data);
 return await new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>reject(Error('官方profile启动超时 '+output)),15000);
  child.stdout.on('data',data=>{output+=data;const match=output.match(/VALIDATION_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolveReady(match[1]);}});
  exited.then(()=>{clearTimeout(timer);reject(Error('官方profile提前退出 '+output));});
 });
 }
 let url=await startProfile(profileHome);
 async function control(path){const response=await fetch(url+path,{headers:{Authorization:'Bearer '+controlToken}});assert.equal(response.status,200,await response.clone().text());return response.json();}
 const bridge=await control('/bridge');
 assert.equal(bridge.statePath,seed.statePath);assert.ok(bridge.statePath.startsWith(join(business,'.notalone')));assert.ok(!bridge.statePath.startsWith(profileHome));
 assert.equal(bridge.recoveredUnknown,1);assert.equal(bridge.unknownRows,1);
 const unknown=(await f.client.query('SELECT outcome,input_tokens,cost_amount FROM model_call_receipt WHERE attempt_id=$1',[unknownAttempt])).rows[0];assert.deepEqual(unknown,{outcome:'unknown',input_tokens:null,cost_amount:null});
 assert.equal(bridge.environment.NOTALONE_EXTRACTION_BATCH_CONCURRENCY,'2');assert.equal(bridge.environment.NOTALONE_REPLY_RUNTIME,'typescript');
 assert.match(bridge.anonymousId,/^[a-f0-9-]{36}$/);assert.notEqual(bridge.anonymousId,owner);assert.notEqual(bridge.anonymousId,contact);
 assert.equal((await control('/python-control')).control,'SharedModelPriorityControl');
 assert.deepEqual((await control('/unconfirmed')).requests,[unknownRequest,knownRequest].sort(),'同源journal门禁保留PG已终态请求，不能只保留pending恢复返回值');
 assert.equal((await f.client.query('SELECT outcome FROM model_call_receipt WHERE attempt_id=$1',[knownAttempt])).rows[0].outcome,'failed','恢复不得降级已知PG终态');
 // 真实socket预约验证供应商身份和原claim；没有SDK或正文输入。
 const task=(await f.client.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,'skill_learning','running','propose_skill',0) RETURNING id",[owner,contact])).rows[0].id,worker=randomUUID();
 const step=(await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at) VALUES($1,'propose_skill',1,'running',$2,1,1,now()+interval '1 minute') RETURNING id",[task,worker])).rows[0].id;
 await f.client.query("INSERT INTO skill_learning_scope(owner_id,contact_id,enabled,last_attempt_key) VALUES($1,$2,true,'synthetic-batch')",[owner,contact]);
 const claim={task_id:task,step_id:step,step_name:'propose_skill',worker_id:worker,lease_generation:1};
 const c=channel(bridge.environment.NOTALONE_MODEL_PERMIT_SOCKET),attempt=randomUUID();
 const granted=await c.call({op:'acquire',kind:'background',token:bridge.environment.NOTALONE_MODEL_PERMIT_TOKEN,attempt_id:attempt,worker:await captureProcessIdentity(process.pid,process.ppid,process.execPath)});assert.equal(granted.state,'granted');
 const receipt={attempt_id:attempt,permit_id:granted.permit_id,request_id:modelTaskRequestId('skill_learning',task,'synthetic-batch'),owner_id:owner,contact_id:contact,provider:'deepseek',model:'deepseek-flash',called_at:new Date().toISOString(),latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
 assert.equal((await c.call({op:'reserve',receipt:{...receipt,provider:'notalone-deepseek'},claim})).state,'accounting_rejected');
 assert.equal((await c.call({op:'reserve',receipt,claim})).state,'reserved');
 const record=channel(bridge.environment.NOTALONE_MODEL_PERMIT_SOCKET);
 assert.equal((await record.call({op:'record',token:bridge.environment.NOTALONE_MODEL_PERMIT_TOKEN,receipt:{...receipt,outcome:'failed',dispatch:'not_sent'}})).state,'recorded');record.socket.destroy();
 assert.equal((await c.call({op:'settled'})).state,'settled');c.socket.destroy();
 assert.equal((await f.client.query('SELECT provider FROM model_call_receipt WHERE attempt_id=$1',[attempt])).rows[0].provider,'deepseek');
 const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding};
 const request=()=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'draft',draft_text:'明天见',include_relationship_context:false},skill_disabled:true});
 async function generate(body,token=bridge.environment.NOTALONE_REPLY_REMOTE_TOKEN){const response=await fetch(url+'/internal/reply/generate',{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({verified_scope:scope,request:body,internal:{}})});return {status:response.status,body:await response.json()};}
 assert.equal((await generate(request(),controlToken)).status,401);assert.equal(requests.length,0);
 const input=request(),first=await generate(input);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.reply.candidates[0].text,'明天见');
 assert.deepEqual(await generate(input),first);assert.equal(requests.length,1);
 assert.equal((await control('/startup-failure')).recovered,true,'提供者初始化失败后不能遗留socket或journal互斥');
 await control('/restart');const second=await control('/bridge');assert.equal(second.anonymousId,bridge.anonymousId);assert.equal(second.statePath,bridge.statePath);
 assert.equal((await generate(request(),second.environment.NOTALONE_REPLY_REMOTE_TOKEN)).status,200);
 slow=true;const active=generate(request(),second.environment.NOTALONE_REPLY_REMOTE_TOKEN);await Promise.race([enteredPromise,active.then(value=>{throw Error('取消前意外结束 '+value.status);})]);
 assert.equal((await control('/close')).closed,true);assert.equal((await active).body.error,'reply_cancelled');releaseLate();
 assert.equal((await generate(request(),second.environment.NOTALONE_REPLY_REMOTE_TOKEN)).status,503);assert.equal(requests.length,3);
 assert.ok(requests.every(row=>row.path==='/anthropic/v1/messages'&&row.headers['x-deepseek-harness-user-id']===bridge.anonymousId));
 assert.doesNotMatch(JSON.stringify(requests),/dsh_session_log|dsh_plugin_packages/);
 const journal=JSON.parse(await readFile(seed.statePath,'utf8'));assert.deepEqual(journal.active,[]);assert.equal(journal.unknown.length,1);
 await stop();
 // 换整个Node进程及DSH临时home，不能只用官方API进程内memo来证明稳定。
 url=await startProfile(profileHome+'-second');
 const third=await control('/bridge');assert.equal(third.anonymousId,bridge.anonymousId);assert.equal(third.statePath,bridge.statePath);
 assert.equal(third.unknownRows,1);assert.equal(third.environment.NOTALONE_EXTRACTION_BATCH_CONCURRENCY,'2');
 // 只有元数据的故障夹具：真实当前orphan不能因PG已有终态或宿主退出被丢弃。
 const orphan=channel(third.environment.NOTALONE_MODEL_PERMIT_SOCKET),orphanAttempt=randomUUID(),orphanRequest=randomUUID();
 const orphanGrant=await orphan.call({op:'acquire',kind:'background',token:third.environment.NOTALONE_MODEL_PERMIT_TOKEN,attempt_id:orphanAttempt,worker:await captureProcessIdentity(process.pid,process.ppid,process.execPath)});
 assert.equal(orphanGrant.state,'granted');
 await f.client.query("INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,called_at,dispatch,outcome,cost_status) VALUES($1,$2,$3,$4,$5,'deepseek','deepseek-flash',now(),'not_sent','failed','unknown')",[orphanAttempt,owner,contact,orphanRequest,orphanGrant.permit_id]);
 const disconnected=once(orphan.socket,'close');orphan.socket.destroy();await disconnected;
 assert.ok((await control('/unconfirmed')).requests.includes(orphanRequest));
 const unsettled=await fetch(url+'/close',{headers:{Authorization:'Bearer '+controlToken}});assert.equal(unsettled.status,503);assert.equal((await unsettled.json()).error,'model_runtime_unsettled');
 const retained=JSON.parse(await readFile(seed.statePath,'utf8'));assert.ok(retained.active.some(row=>row.id===orphanGrant.permit_id));assert.equal(retained.unknown.length,1);
 assert.equal((await f.client.query('SELECT outcome FROM model_call_receipt WHERE attempt_id=$1',[orphanAttempt])).rows[0].outcome,'failed');
 await stop();
 await assert.rejects(startModelHost(seedOptions),/previous_worker_alive_or_unknown/,'宿主已退出仍不能把活着的未知执行者当作已结算');
});
