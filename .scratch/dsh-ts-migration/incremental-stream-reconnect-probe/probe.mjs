/** 自然时钟跨退避重建全局CLI流；授权、存储、engine、Legacy与官方profile均使用冻结真实源。 */
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const run=process.env.NOTALONE_RECONNECT_RUN;
const meta=JSON.parse(await readFile(join(run,'meta.json'),'utf8'));
const {launchDsh}=await import(join(meta.frozen,'backend-ts/src/launch.ts'));
const {createUnconfiguredFixture}=await import(join(meta.frozen,'backend-ts/test/host-model-unconfigured-fixture.mjs'));
const f=await createUnconfiguredFixture();
const result={scope:'19全局CLI流code7异常关闭后自然退避自动重建',source_tree_sha256:meta.source_tree_sha256,checks:{},cleanup:{}};
let app,connection,profileHome,legacyPid,modelSocket,stage='prepare',failure;
const requests=[],observations=[];
const cli=join(f.directory,'synthetic-cli'),control=join(f.directory,'control.json'),log=join(f.directory,'cli.jsonl'),generation=join(f.directory,'generation.json');
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const exists=async p=>{try{await stat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
async function bounded(fn,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(100);}throw Error('有界等待失败：'+label);}
async function request(path,body){const method=body?'POST':'GET';requests.push({at:Date.now(),method,path});const r=await fetch('http://'+connection.address+path,{method,headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(6000)});return {status:r.status,data:await r.json()};}
async function logs(){return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
async function authority(){const output={};for(const table of ['owner_channel_identity','wechat_sync_scope','wechat_sync_exclusion','conversation_binding','wechat_observation_baseline','wechat_binding_history_authorization'])output[table]=(await f.client.query('SELECT to_jsonb(t) AS row FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows.map(x=>x.row);return output;}
try{
 const owner=randomUUID();await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成重连本人')",[owner]);
 await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
 await writeFile(control,JSON.stringify({at:0}));await writeFile(generation,JSON.stringify({n:0}));await writeFile(log,'');
 await writeFile(cli,`#!${meta.node}
import ${JSON.stringify(join(run,'node-audit.mjs'))};
import fs from 'node:fs';
const args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
const gen=()=>JSON.parse(fs.readFileSync(${JSON.stringify(generation)},'utf8')).n;
const log=(kind,extra={})=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({kind,args,parent:process.ppid,pid:process.pid,at:Date.now(),...extra})+'\\n');
log('command');const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(args[0]==='--version')emit({version:'synthetic-1'});
else if(args[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成重连联系人',chat_type:'private',last_timestamp:1},{username:'outside-b',display_name:'合成范围外',chat_type:'private',last_timestamp:1}]});
else if(args[0]==='resolve-chat')emit({candidates:[{username:args[1],display_name:'合成重连联系人',chat_type:'private'}]});
else if(args.includes('--follow')&&args.includes('--mode')&&args[args.indexOf('--mode')+1]==='sessions'){
 const n=gen()+1;fs.writeFileSync(${JSON.stringify(generation)},JSON.stringify({n}));log('stream_start',{generation:n});
 console.log(JSON.stringify({type:'session',cursor:'global-'+n+'-1',username:'friend-a'}));
 console.log(JSON.stringify({type:'session',cursor:'global-'+n+'-outside',username:'outside-b'}));
 if(n===1)setTimeout(()=>{log('stream_exit',{generation:n,code:7});process.exit(7);},1800);
 else {setTimeout(()=>{log('stream_replay_event',{generation:n});console.log(JSON.stringify({type:'session',cursor:'global-'+n+'-2',username:'friend-a'}));},5200);setInterval(()=>{},1000);}
}else if(args[0]==='tail'&&!args.includes('--history')){
 if(args[1]!=='friend-a'){log('scope_violation');process.exit(9);}
 const n=gen();const messages=[{id:2,cursor:'message-2',text:'合成断流前稳定消息'},...(n>=2?[{id:3,cursor:'message-3',text:'合成自动重连后新消息'}]:[])];
 log('body',{generation:n,ids:messages.map(m=>m.id)});
 emit({events:messages.map(m=>({type:'message',cursor:m.cursor,message:{id:{local_id:m.id,talker:args[1]},kind:'text',text:m.text,is_from_me:false,create_time:state.at}})),cursor:messages.at(-1).cursor,freshness:{message_source:'live_message_db'},query:{chat:args[1],has_more:false,history:false}});
}else {log('unexpected_command');process.exit(2);}
`,{mode:0o700});
 const environment={NOTALONE_DATABASE_URL:'host=/tmp dbname='+f.database,NOTALONE_OWNER_ID:owner,NOTALONE_REPLY_RUNTIME:'typescript',NOTALONE_WECHAT_CLI:cli,NOTALONE_SKILLS_DIR:join(f.directory,'skills'),NOTALONE_MANAGED_USER_DATA:f.directory,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_SYNTHETIC_NETWORK_AUDIT:join(run,'python-network-audit.jsonl'),NOTALONE_SYNTHETIC_NETWORK_AUDIT_NODE:join(run,'node-network-audit.jsonl'),TZ:'UTC',TMPDIR:join(run,'runtime')};
 await appendFile(f.envFilePath,Object.entries(environment).filter(([k])=>k.startsWith('NOTALONE_')).map(([k,v])=>k+'='+v).join('\n')+'\n');
 stage='official-profile-ready';
 app=await launchDsh({nodeExecutable:join(run,'audited-node'),projectDirectory:meta.frozen,envFilePath:f.envFilePath,infoPath:join(f.directory,'backend.info'),businessHome:f.directory,pythonExecutable:meta.python,environment},()=>true);
 await bounded(async()=>{if(!app.isRunning())throw Error('官方DSH早退');try{const text=await readFile(join(f.directory,'backend.info'),'utf8');connection=Object.fromEntries(text.trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));return true;}catch(e){if(e.code!=='ENOENT')throw e;}},'官方认证握手',20000);
 const lock=JSON.parse(await readFile(join(f.directory,'backend.info.dsh-lock'),'utf8'));profileHome=lock.home;
 result.checks.profile=JSON.parse(await readFile(join(profileHome,'profiles/notalone/package.json'),'utf8'));
 const runtime=await request('/api/runtime/status');assert.equal(runtime.status,200);legacyPid=runtime.data.legacyPid;
 assert.equal(runtime.data.runtime,'dsh');assert.equal(runtime.data.ownership.wechatIncremental,'typescript');assert.equal(runtime.data.ownership.wechatHistory,'python');assert.deepEqual(runtime.data.reply,{runtime:'typescript',state:'unconfigured',reason:'reply_model_unconfigured'});
 result.checks.runtime=runtime.data;
 stage='public-new-only-authority';
 assert.equal((await request('/api/sync/status')).status,200);
 const confirm=await request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}],history_authorized:false});assert.equal(confirm.status,200,JSON.stringify(confirm));
 const binding=(await request('/api/sync/cli-bindings')).data.bindings[0];assert.ok(binding);assert.equal((await request('/api/sync/cli-bindings')).data.bindings.length,1);
 const baseline=(await f.client.query('SELECT baseline_at FROM public.wechat_observation_baseline WHERE binding_id=$1',[binding.binding_id])).rows[0].baseline_at;
 const beforeAuthority=await authority();assert.equal(beforeAuthority.wechat_binding_history_authorization.length,0);
 assert.equal(beforeAuthority.wechat_sync_scope.length,0,'既有账号缺省仅所选范围，不创建全部私聊授权');
 await writeFile(control,JSON.stringify({at:Math.max(Math.ceil(Date.now()/1000),Math.ceil(baseline.getTime()/1000))}));
 stage='natural-stream-reconnect';
 assert.equal((await request('/api/sync/enable',{})).status,200);
 const enabledAt=Date.now();let firstMessageBeforeRestart=false;
 await bounded(async()=>{
  const status=await request('/api/sync/status');assert.equal(status.status,200,JSON.stringify(status));
  const text=JSON.stringify(status.data);if(!observations.length||observations.at(-1).serialized!==text)observations.push({at:Date.now(),status:status.data,serialized:text});
  const entries=await logs(),starts=entries.filter(e=>e.kind==='stream_start');
  const count=(await f.client.query('SELECT count(*)::int n FROM public.message')).rows[0].n;
  if(starts.length===1&&count===1)firstMessageBeforeRestart=true;
  const bodies=entries.filter(e=>e.kind==='body'&&e.generation===2);
  return starts.length===2&&bodies.length>=2&&count===2&&text.includes('global_follow');
 },'自然退避重建流并处理重复与新消息',29000);
 result.checks.elapsed_ms=Date.now()-enabledAt;
 const entries=await logs(),starts=entries.filter(e=>e.kind==='stream_start'),exits=entries.filter(e=>e.kind==='stream_exit');
 assert.equal(starts.length,2);assert.equal(exits.length,1);assert.equal(exits[0].code,7);assert.notEqual(starts[0].pid,starts[1].pid);assert.equal(starts[1].generation,2);
 assert.ok(starts[1].at-exits[0].at>=3000,'第二流必须在首代异常退出至少3秒后启动');
 assert.ok(firstMessageBeforeRestart,'重连之前必须先保存原稳定消息');
 assert.ok(observations.some(o=>JSON.stringify(o.status).includes('cli_follow_failed')),'必须公开观察原流故障分类');
 assert.ok(observations.some(o=>JSON.stringify(o.status).includes('bounded_polling')),'必须公开观察流故障回退');
 assert.ok(!requests.some(r=>r.path.includes('/check')||r.path.includes('/retry')||r.path.includes('/follow-')));
 assert.equal(requests.filter(r=>r.path==='/api/sync/enable').length,1);
 assert.deepEqual(await authority(),beforeAuthority,'重连不改变账号、绑定、baseline与历史/范围授权');
 stage='persistence-source-receipts';
 const rows=(await f.client.query(`SELECT m.id,m.owner_id,m.contact_id,m.text_content,r.id source_ref_id,r.source_kind,r.observation_id,o.binding_id,o.mode,w.external_local_id,w.external_talker,w.source_create_time FROM public.message m JOIN public.message_source_ref r ON r.message_id=m.id AND r.owner_id=m.owner_id AND r.contact_id=m.contact_id JOIN public.local_wechat_observation o ON o.id=r.observation_id AND o.owner_id=m.owner_id AND o.contact_id=m.contact_id JOIN public.wechat_message_metadata w ON w.message_id=m.id AND w.owner_id=m.owner_id AND w.contact_id=m.contact_id WHERE m.owner_id=$1 ORDER BY w.external_local_id,r.id`,[owner])).rows;
 const unique=new Map();for(const row of rows){assert.equal(row.contact_id,binding.contact_id);assert.equal(row.binding_id,binding.binding_id);assert.equal(row.source_kind,'local_wechat_observation');assert.equal(row.mode,'cli_background');assert.equal(row.external_talker,'friend-a');assert.ok(Number(row.source_create_time)*1000>=baseline.getTime());unique.set(row.external_local_id,row.id);}
 assert.deepEqual([...unique.keys()],['2','3']);assert.equal(new Set(unique.values()).size,2);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM public.message')).rows[0].n,2);
 const processing=(await f.client.query(`SELECT r.outcome,r.payload->'persistence'->>'message_id' message_id,r.payload->'persistence'->>'source_ref_id' source_ref_id,r.payload->>'model_read_status' model_read_status FROM public.source_processing_record r JOIN public.source_processing_batch b ON b.batch_id=r.batch_id WHERE b.source_id IN (SELECT id FROM public.local_wechat_observation WHERE owner_id=$1)`,[owner])).rows;
 for(const id of unique.values())assert.ok(processing.some(r=>r.outcome==='message_created'&&r.message_id===id&&r.source_ref_id&&r.model_read_status==='not_claimed'));
 const extraction=(await f.client.query('SELECT message_id,observation_id,task_id FROM public.memory_extraction_receipt WHERE owner_id=$1',[owner])).rows;
 assert.equal(extraction.length,2);assert.ok(extraction.every(r=>r.task_id===null));assert.deepEqual(new Set(extraction.map(r=>r.message_id)),new Set(unique.values()));
 const counters={};for(const table of ['background_task','background_task_step','model_call_receipt','model_call_learning_claim','outbound_ledger_entry','reply_request','reply_attempt'])counters[table]=(await f.client.query('SELECT count(*)::int n FROM public.'+table)).rows[0].n;assert.ok(Object.values(counters).every(n=>n===0));
 const bodies=entries.filter(e=>e.kind==='body');assert.ok(bodies.filter(e=>e.generation===2).length>=2);assert.ok(bodies.every(e=>e.args[1]==='friend-a'&&e.parent===runtime.data.pid));assert.ok(!entries.some(e=>e.args.includes('--history')||e.kind==='scope_violation'||e.kind==='unexpected_command'));
 result.checks.reconnect={first_exit_code:7,stream_generations:2,distinct_pids:true,exit_to_restart_ms:starts[1].at-exits[0].at,first_message_saved_before_restart:firstMessageBeforeRestart,degraded_failure_observed:true,automatic_only:true,initial_enable_count:1,forbidden_check_retry_calls:0,replay_pages:bodies.filter(e=>e.generation===2).length};
 result.checks.persisted={message_count:2,stable_ids:['2','3'],source_ref_count:rows.length,processing_receipt_count:processing.length,extraction_receipt_count:extraction.length,extraction_task_null:true,authority_baseline_unchanged:true,history_queries:0,outside_body_queries:0,body_writer:'typescript',model_task_counters:counters};
 stage='disabled-stop-reading';
 assert.equal((await request('/api/sync/disable',{})).status,200);
 const commandCount=(await logs()).filter(e=>e.kind==='command').length;
 // 已知3秒宿主heartbeat，跨过一个完整周期后核停读；不再调用check/enable。
 await delay(3500);assert.equal((await request('/api/sync/status')).status,200);assert.equal((await logs()).filter(e=>e.kind==='command').length,commandCount);
 result.checks.disabled_no_commands=true;
 stage='normal-shutdown';
 const identity=createHash('sha256').update(JSON.stringify([join(f.directory,'backend.info'),f.envFilePath])).digest('hex').slice(0,24);modelSocket=join('/tmp',`na-model-${process.getuid()}-${identity}`,'p.sock');assert.equal(await exists(modelSocket),true);
 const shutdown=await request('/api/runtime/shutdown',{});assert.equal(shutdown.status,200);assert.equal(shutdown.data.state,'stopped');assert.equal(await app.waitForExit(12000),true);
 result.checks.normal_shutdown=true;
 result.cleanup={dsh_gone:!alive(app.pid),legacy_gone:!alive(legacyPid),cli_gone:(await logs()).every(e=>!alive(e.pid)),info_removed:!await exists(join(f.directory,'backend.info')),lock_removed:!await exists(join(f.directory,'backend.info.dsh-lock')),profile_removed:!await exists(profileHome),model_socket_removed:!await exists(modelSocket)};
 assert.ok(Object.values(result.cleanup).every(Boolean),JSON.stringify(result.cleanup));
 await writeFile(join(run,'raw-evidence.json'),JSON.stringify({owner,binding,baseline,beforeAuthority,afterAuthority:await authority(),rows,processing,extraction,commands:await logs(),requests,observations},null,2));
 result.pass=true;
}catch(error){failure=error;result.pass=false;result.failure={stage,name:error.name,message:error.message,stack:error.stack};}
finally{
 try{if(app?.isRunning()){const shutdown=connection?await request('/api/runtime/shutdown',{}):null;if(shutdown?.status===200)await app.waitForExit(12000);else await app.terminate();}}catch(error){result.cleanup.emergency_error=String(error);result.pass=false;}
 if(!result.pass){await writeFile(join(run,'failure-observations.json'),JSON.stringify({stage,requests,observations,commands:await logs().catch(()=>[])},null,2));await writeFile(join(run,'result-raw.json'),JSON.stringify(result,null,2));console.error(JSON.stringify(result));}
 try{
  if(result.pass){await f.close();result.cleanup.database_dropped=true;result.cleanup.fixture_removed=!await exists(f.directory);}
  else {await f.client.end();result.cleanup.failed_database_preserved=true;result.private_fixture=f.directory;}
 }catch(error){result.cleanup.database_error=String(error);result.pass=false;}
 result.database_name=f.database;result.last_stage=stage;
 await writeFile(join(run,'result-raw.json'),JSON.stringify(result,null,2));
}
if(failure)throw failure;
assert.equal(result.pass,true,JSON.stringify(result));console.log(JSON.stringify({pass:true,checks:result.checks.reconnect,cleanup:result.cleanup}));
