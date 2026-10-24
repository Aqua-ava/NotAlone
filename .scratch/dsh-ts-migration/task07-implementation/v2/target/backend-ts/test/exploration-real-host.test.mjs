import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stat,rm} from 'node:fs/promises';
import pg from 'pg';
import {realHost,until,sendEvents,useTool} from './exploration-real-host-support.mjs';

test('正式launchDsh与host-plugin经Legacy公开入口完成NoSkill B→A→C且重放零额外调用',{timeout:60000},async t=>{
 const x=await realHost(t),runtime=await x.request('/api/runtime/status');
 assert.equal(runtime.status,200);assert.equal(runtime.body.pid,x.host.pid);assert.equal(runtime.body.ownership.replies,'typescript');assert.equal(runtime.body.ownership.ledger,'typescript');
 const privateRuntime=await x.privateRuntime(),gate=await x.request('/internal/exploration',{owner_id:x.owner,contact_id:x.contact,session_id:x.session,action:'read',request:{exploration_id:randomUUID()}},{token:privateRuntime.NOTALONE_REPLY_REMOTE_TOKEN});
 t.diagnostic(JSON.stringify({private_gate_status:gate.status,private_gate_error:gate.body.error}));
 const command={operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'disabled'}};
 const opened=await x.send('open',command);assert.equal(opened.status,200,JSON.stringify(opened.body));
 const b=opened.body;assert.equal(b.confirmed_intent,null);assert.equal(b.skill_version_id,null);assert.equal(x.requests.length,1);assert.equal(b.evidence[0].evidence_id,x.message);
 assert.deepEqual(await x.send('open',command),opened);assert.equal(x.requests.length,1);
 const select={exploration_id:b.exploration_id,input_version_id:b.input_version_id,suggestion_id:b.options[0].suggestion_id,generate:true};
 const prepared=await x.send('prepare-confirm',select);assert.equal(prepared.status,200,JSON.stringify(prepared.body));assert.equal(prepared.body.kind,'prepared');assert.equal(x.requests.length,1);
 const generated=await x.send('confirm',select);assert.equal(generated.status,200,JSON.stringify(generated.body));assert.equal(generated.body.kind,'generated');assert.match(JSON.stringify(generated.body),/最近还好吗/);assert.equal(x.requests.length,2);
 assert.deepEqual(await x.send('confirm',select),generated);assert.equal(x.requests.length,2);
 const usage=await x.request('/api/ledger/summary');assert.equal(usage.status,200,JSON.stringify(usage.body));
 assert.equal(usage.body.total_attempts,2);assert.equal(usage.body.total_calls,2);assert.equal((await x.request('/api/settings/credentials')).status,200);
 assert.equal((await x.f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,2);assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_candidate')).rows[0].n,1);
 await x.assertNoFallback();assert.deepEqual((await x.journal()).active,[]);
 t.diagnostic(JSON.stringify({official_profile:true,production_host_plugin:true,legacy_public_http:true,physical_calls:x.requests.length,python_model_calls:0,ledger_summary_status:usage.status}));
});

test('正式宿主探索精确路径与私有token、owner/contact/session边界拒绝且零物理调用',{timeout:60000},async t=>{
 const x=await realHost(t),privateRuntime=await x.privateRuntime(),privateToken=privateRuntime.NOTALONE_REPLY_REMOTE_TOKEN;
 const envelope={owner_id:x.owner,contact_id:x.contact,session_id:x.session,manual_input:true,action:'open',request:{operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'disabled'}}};
 for(const options of [{},{token:'synthetic-wrong-token'},{token:privateToken,headers:{Origin:'http://127.0.0.1'}}, {token:privateToken,method:'GET'}]){
  const denied=await x.request('/internal/exploration',options.method==='GET'?undefined:envelope,options);assert.equal(denied.status,options.method==='GET'?404:401);
 }
 for(const path of ['/internal/exploration-evil','/internal/exploration/evil','/internal/exploration?extra=1']){
  assert.equal((await x.request(path,envelope,{token:privateToken})).status,401);
  assert.equal((await x.request(path,envelope)).status,404);
 }
 assert.equal((await x.request('/internal/exploration',{...envelope,owner_id:randomUUID()},{token:privateToken})).status,400);
 const stranger=randomUUID();await x.f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成另一联系人')",[stranger,x.owner]);
 await x.f.client.query('INSERT INTO manual_contact_confirmation(owner_id,contact_id)VALUES($1,$2)',[x.owner,stranger]);
 assert.equal((await x.request('/internal/exploration',{...envelope,contact_id:stranger},{token:privateToken})).status,409);
 assert.equal((await x.send('open',envelope.request,{cid:stranger,sid:x.session})).status,409);
 assert.equal(x.requests.length,0);assert.equal((await x.f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
 assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_exploration')).rows[0].n,0);await x.assertNoFallback();
 t.diagnostic(JSON.stringify({exact_path:true,public_and_wrong_tokens_rejected:true,owner_contact_session_checked:true,physical_calls:0}));
});

test('正式宿主公开在途暂停阻止晚结果提交且实际SDK退出后共享许可才排空',{timeout:60000},async t=>{
 let entered,release;const began=new Promise(resolve=>entered=resolve),released=new Promise(resolve=>release=resolve);
 const x=await realHost(t,{beforeClose:()=>release(),onRequest:async({events,res,id})=>{
  entered();await released;
  useTool(events,'ExplorationOutput',{understanding:'本轮合成理解',ambiguities:[],citation_ids:[id],options:[{intent:'了解近况',label:'关心',reason:'当前原话',citation_ids:[id],recommended:true,pause:false},{intent:'稍后联系',label:'稍后',reason:'由用户选择',citation_ids:[],recommended:false,pause:false}],question:null,current_step:'选择',tradeoffs:[]});
  sendEvents(res,events);return true;
 }});
 const command={operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'disabled'}};
 const inFlight=x.send('open',command).then(value=>({value}),error=>({error}));
 await Promise.race([began,inFlight.then(value=>{throw Error('暂停前意外结束 '+JSON.stringify(value));})]);
 const task=(await x.f.client.query('SELECT id,input_version_id FROM reply_exploration WHERE operation_key=$1',[command.operation_key])).rows[0];assert.ok(task);assert.equal((await x.journal()).active.length,1);
 const stopped=await x.send('stop',{exploration_id:task.id,input_version_id:task.input_version_id});assert.equal(stopped.status,200,JSON.stringify(stopped.body));assert.equal(stopped.body.kind,'paused');
 assert.equal((await x.journal()).active.length,1,'暂停HTTP回执不代替实际SDK排空');
 release();const late=await inFlight;assert.equal(late.value?.status,409,JSON.stringify(late));
 await until(async()=>(await x.journal()).active.length===0,'原SDK退出后共享许可排空',5000);
 const read=await x.send('read',{exploration_id:task.id});assert.equal(read.status,409);
 const retained=(await x.f.client.query('SELECT state,selected_intent FROM reply_exploration WHERE id=$1',[task.id])).rows[0];assert.deepEqual(retained,{state:'paused',selected_intent:null});
 assert.equal((await x.f.client.query('SELECT count(*)::int n FROM reply_candidate')).rows[0].n,0);assert.equal(x.requests.length,1);
 assert.equal((await x.send('open',command)).status,409);assert.equal(x.requests.length,1);await x.assertNoFallback();
 t.diagnostic(JSON.stringify({public_stop:'paused',permit_held_until_sdk_exit:true,late_result_committed:false,physical_calls:1,python_model_calls:0}));
});

test('正式宿主关闭钩子异常仍结束自有进程并回收数据库与临时目录',{timeout:60000},async t=>{
 const x=await realHost(t,{beforeClose:()=>{throw Error('合成关闭钩子异常');}});
 let failure;try{await x.close();}catch(error){failure=error;}
 const wasRunning=x.host.isRunning(),admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();let remaining,directoryExists;
 try{remaining=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[x.f.client.database])).rows;directoryExists=await stat(x.f.directory).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});}
 finally{
  // 清理回归的 RED 仍通过原关闭入口收回自己启动的宿主；不影响其他进程。
  if(x.host.isRunning()){await x.request('/api/runtime/shutdown',{});if(!await x.host.waitForExit(15000))assert.equal(await x.host.terminate(),true);}
  x.provider.closeAllConnections();if(x.provider.listening)await new Promise(resolve=>x.provider.close(resolve));
  if(remaining?.length){assert.match(x.f.client.database,/^notalone_ts_host_[a-f0-9]+_test$/);await admin.query(`DROP DATABASE "${x.f.client.database}"`);}
  await admin.end();await rm(x.f.directory,{recursive:true,force:true});
 }
 assert.equal(wasRunning,false);assert.deepEqual(remaining,[]);assert.equal(directoryExists,false);
 assert.ok(failure instanceof AggregateError);assert.match(failure.errors.map(error=>error.message).join('\n'),/合成关闭钩子异常/);
});
