/** 自有helper异常退出后同库恢复；只合成CLI输入与进程内传输审计。 */
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,readdir,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';import {userInfo} from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const run=process.env.NOTALONE_ABRUPT_RUN,meta=JSON.parse(await readFile(join(run,'meta.json'),'utf8'));
const project=meta.frozen,node=process.execPath;process.env.PGUSER??=userInfo().username;
const {createUnconfiguredFixture}=await import(join(project,'backend-ts/test/host-model-unconfigured-fixture.mjs'));
const {captureProcessIdentity,processIdentityState}=await import(join(project,'backend-ts/src/process-identity.ts'));
let f,connection,config,lock,legacyIdentity,modelPath,modelSocket,helper,dshIdentity,helperIdentity;
const helpers=[],identities=[],profiles=[];
const result={pass:false,slice:'带一条已同步消息的launcher helper SIGKILL/同库自动恢复',stage:'prepare',source_tree_sha256:meta.source_tree_sha256,checks:{},cleanup:{},boundary:'后端合成验收；不是真实App异常退出；无停机新历史与20追赶要求'};
async function exists(p){try{await stat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function readJson(p){return JSON.parse(await readFile(p,'utf8'));}
async function until(fn,label,ms=22000){for(const end=Date.now()+ms;Date.now()<end;){const value=await fn();if(value)return value;await delay(100);}throw Error('有界等待失败：'+label);}
async function save(){await writeFile(join(run,'result-raw.json'),JSON.stringify(result,null,2));}
async function stage(value){result.stage=value;await save();}
async function request(path,body){const response=await fetch('http://'+connection.address+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000)});return {status:response.status,data:await response.json()};}
async function readConnection(){const content=await readFile(config.infoPath,'utf8');connection=Object.fromEntries(content.trim().split('\n').map(line=>{const n=line.indexOf('=');return [line.slice(0,n),line.slice(n+1)];}));return connection;}
let cliLog,control;
async function commands(){return (await readFile(cliLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
function bodyCommands(cmds){return cmds.filter(c=>c.args[0]==='tail'&&!c.args.includes('--follow')&&!c.args.includes('--mode')&&!c.args.includes('--history'));}
async function startHelper(attempt){
 const child=spawn(node,['--import',join(run,'audit/network.mjs'),join(run,'helper.mjs'),join(run,'launch-config.json')],{cwd:run,env:{PATH:'/usr/bin:/bin',HOME:join(run,'home'),TMPDIR:join(run,'runtime'),NOTALONE_SYNTHETIC_NETWORK_AUDIT_NODE:join(run,'node-network-audit.jsonl')},stdio:['ignore','ignore','ignore','ipc']});
 helpers.push(child);helper=child;
 helperIdentity=await captureProcessIdentity(child.pid,process.pid,node);identities.push({kind:'helper-'+attempt,identity:helperIdentity});
 const launch=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('helper启动超时')),15000);child.on('message',m=>{if(m.type==='launched'){clearTimeout(timer);resolve(m);}else if(m.type==='error'){clearTimeout(timer);reject(Error(m.message));}});child.once('exit',(code,signal)=>{clearTimeout(timer);reject(Error('helper早退 '+code+'/'+signal));});});
 lock=await readJson(config.infoPath+'.dsh-lock');profiles.push(lock.home);result.private.last_launch=launch;await save();
 dshIdentity=await until(async()=>{try{return await captureProcessIdentity(launch.dsh_pid,child.pid,node);}catch{return false;}},'本轮DSH完成exec身份稳定',5000);identities.push({kind:'dsh-'+attempt,identity:dshIdentity});
 await until(async()=>{if(await processIdentityState(dshIdentity)!=='same')throw Error('DSH在握手前退出');try{return await readConnection();}catch(e){if(e.code!=='ENOENT')throw e;return false;}},'官方profile认证握手');
 lock=await readJson(config.infoPath+'.dsh-lock');
 legacyIdentity=(await readJson(join(lock.home,'legacy.pid'))).identity;identities.push({kind:'legacy-'+attempt,identity:legacyIdentity});
 const runtime=await request('/api/runtime/status');assert.equal(runtime.status,200);assert.equal(runtime.data.pid,dshIdentity.pid);assert.equal(runtime.data.legacyPid,legacyIdentity.pid);assert.equal(runtime.data.ownership.wechatIncremental,'typescript');assert.equal(runtime.data.ownership.wechatHistory,'python');assert.equal(runtime.data.ownership.skills,'typescript');assert.equal(runtime.data.ownership.replies,'typescript');assert.deepEqual(runtime.data.reply,{runtime:'typescript',state:'unconfigured',reason:'reply_model_unconfigured'});
 const profile=await readJson(join(lock.home,'profiles/notalone/package.json'));assert.deepEqual(profile,{private:true,dsh:{profile:{bundles:[]}}});
 return {helperIdentity,dshIdentity,legacyIdentity,lock,runtime:runtime.data};
}
async function snapshot(){
 const value={};
 for(const table of ['conversation_binding','wechat_observation_baseline','wechat_observation_cursor','wechat_binding_history_authorization','wechat_sync_scope','wechat_sync_exclusion','front_sync_state','message','message_source_ref','wechat_message_metadata','local_wechat_observation','source_processing_batch','source_processing_record','memory_extraction_receipt']){
  const rows=(await f.client.query('SELECT row_to_json(t) value FROM public.'+table+' t')).rows.map(r=>r.value);
  value[table]=rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 }
 return value;
}
async function counters(){const v={};for(const table of ['message','message_source_ref','background_task','background_task_step','model_call_receipt','model_call_learning_claim','outbound_ledger_entry','reply_request','reply_attempt'])v[table]=(await f.client.query('SELECT count(*)::int n FROM public.'+table)).rows[0].n;return v;}
try{
 f=await createUnconfiguredFixture();cliLog=join(f.directory,'commands.jsonl');control=join(f.directory,'control.json');
 const owner=randomUUID();await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成异常恢复本人')",[owner]);await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
 const cli=join(f.directory,'synthetic-cli');await writeFile(control,JSON.stringify({incremental:false}));await writeFile(cliLog,'');
 await writeFile(cli,`#!${node}
import fs from 'node:fs';
const args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
fs.appendFileSync(${JSON.stringify(cliLog)},JSON.stringify({args,parent:process.ppid,pid:process.pid,at:Date.now()})+'\\n');
const emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}});
else if(args[0]==='--version')emit({version:'synthetic-1'});
else if(args[0]==='sessions')emit({sessions:[{username:'friend-a',display_name:'合成联系人',chat_type:'private',last_timestamp:1}]});
else if(args[0]==='resolve-chat')emit({candidates:[{username:args[1],display_name:'合成联系人',chat_type:'private'}]});
else if(args.includes('--follow')||args.includes('--mode'))setInterval(()=>{},1000);
else if(args[0]==='tail'&&!args.includes('--history')){
 const cursor=args.includes('--cursor')?args[args.indexOf('--cursor')+1]:null;
 // 同一个稳定身份在重启后重复交付，绝不添加停机期间新消息。
 const messages=state.incremental?[{id:2,cursor:'incremental-2',text:'合成异常退出前已同步消息'}]:[];
 emit({events:messages.map(m=>({type:'message',cursor:m.cursor,message:{id:{local_id:m.id,talker:args[1]},kind:'text',text:m.text,is_from_me:false,create_time:state.at}})),cursor:messages.at(-1)?.cursor??cursor,freshness:{message_source:'live_message_db'},query:{chat:args[1],has_more:false,history:false}});
}else process.exit(2);`,{mode:0o700});
 const environment={PGUSER:process.env.PGUSER,NOTALONE_DATABASE_URL:'host=/tmp dbname='+f.database,NOTALONE_OWNER_ID:owner,NOTALONE_REPLY_RUNTIME:'typescript',NOTALONE_WECHAT_CLI:cli,NOTALONE_SKILLS_DIR:join(f.directory,'skills'),NOTALONE_MANAGED_USER_DATA:f.directory,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_SYNTHETIC_NETWORK_AUDIT:join(run,'python-network-audit.jsonl'),NOTALONE_SYNTHETIC_NETWORK_AUDIT_NODE:join(run,'node-network-audit.jsonl'),TZ:'UTC',TMPDIR:join(run,'runtime')};
 await appendFile(f.envFilePath,Object.entries(environment).filter(([k])=>k.startsWith('NOTALONE_')).map(([k,v])=>k+'='+v).join('\n')+'\n');
 config={nodeExecutable:join(run,'audited-node'),projectDirectory:project,envFilePath:f.envFilePath,infoPath:join(f.directory,'backend.info'),businessHome:f.directory,pythonExecutable:process.env.NOTALONE_TEST_PYTHON,environment};await writeFile(join(run,'launch-config.json'),JSON.stringify(config),{mode:0o600});
 const identity=createHash('sha256').update(JSON.stringify([config.infoPath,config.envFilePath])).digest('hex').slice(0,24);modelSocket=join('/tmp',`na-model-${process.getuid()}-${identity}`,'p.sock');modelPath=join(f.directory,'model-permits',identity,'state.json');
 result.private={database:f.database,directory:f.directory,configPath:join(run,'launch-config.json'),modelPath,modelSocket,owner};await stage('first_launch');
 const first=await startHelper(1);await until(async()=>(await request('/api/sync/status')).status===200,'初始同步宿主就绪');
 const confirmed=await request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}],history_authorized:false});assert.equal(confirmed.status,200,JSON.stringify(confirmed));
 const binding=(await request('/api/sync/cli-bindings')).data.bindings[0];assert.ok(binding);
 const baseline=(await f.client.query('SELECT baseline_at FROM public.wechat_observation_baseline WHERE binding_id=$1',[binding.binding_id])).rows[0].baseline_at;
 assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization')).rows[0].n,0);assert.equal((await request('/api/sync/enable',{})).status,200);
 const at=Math.max(Math.ceil(Date.now()/1000),Math.ceil(baseline.getTime()/1000));await writeFile(control,JSON.stringify({incremental:true,at}));assert.equal((await request('/api/sync/check',{})).status,200);
 await until(async()=>(await f.client.query('SELECT count(*)::int n FROM public.message')).rows[0].n===1,'一条新消息入库');
 await until(async()=>(await f.client.query("SELECT count(*)::int n FROM public.source_processing_record WHERE outcome='message_created'")).rows[0].n===1,'处理回执');
 const before=await snapshot();assert.equal(before.message[0].text_content,'合成异常退出前已同步消息');assert.equal(before.wechat_observation_baseline.length,1);assert.equal(before.wechat_observation_cursor[0].last_cursor,'incremental-2');assert.equal(before.message_source_ref.length,1);assert.equal(before.memory_extraction_receipt.length,1);assert.equal(before.memory_extraction_receipt[0].task_id,null);
 const originalMessage=before.message[0],source=before.message_source_ref[0];assert.equal(originalMessage.owner_id,owner);assert.equal(originalMessage.contact_id,binding.contact_id);assert.equal(source.message_id,originalMessage.id);assert.equal(source.source_kind,'local_wechat_observation');assert.equal(before.local_wechat_observation.find(o=>o.id===source.observation_id).binding_id,binding.binding_id);
 const originalProcessing=before.source_processing_record.find(r=>r.outcome==='message_created');assert.equal(originalProcessing.payload.persistence.message_id,originalMessage.id);assert.equal(originalProcessing.payload.persistence.source_ref_id,source.id);assert.equal(originalProcessing.payload.model_read_status,'not_claimed');
 const journalBefore=await readJson(modelPath);assert.equal(journalBefore.host.pid,first.dshIdentity.pid);assert.equal(journalBefore.active.length,0);assert.equal(journalBefore.unknown.length,0);
 const cliBefore=await commands();for(const c of cliBefore){try{if(c.args.includes('--follow')||c.args.includes('--mode'))identities.push({kind:'cli-stream-first',identity:await captureProcessIdentity(c.pid,c.parent,node)});}catch{}}
 const stableBefore={scope:before.wechat_sync_scope,bindings:before.conversation_binding,baseline:before.wechat_observation_baseline,cursor:before.wechat_observation_cursor,message:originalMessage,source,processing:originalProcessing};
 await writeFile(join(run,'before-kill.json'),JSON.stringify({first,before,journalBefore,commands:cliBefore,stableBefore},null,2));result.checks.before_kill={messages:1,source_refs:1,processing:'message_created',history_authorized:false,enabled:true,model_journal_active:0};await stage('helper_sigkill');
 assert.equal(await processIdentityState(first.helperIdentity),'same');const helperExit=new Promise(resolve=>helper.once('exit',resolve));process.kill(first.helperIdentity.pid,'SIGKILL');await helperExit;
 // 只观察原插件的自然退出，不预先给DSH/Legacy/CLI发信号。
 await until(async()=>await processIdentityState(first.dshIdentity)==='gone'&&await processIdentityState(first.legacyIdentity)==='gone','父丢失自然停止DSH与Legacy',22000);
 await until(async()=>{for(const c of await commands()){try{process.kill(c.pid,0);return false;}catch(e){if(e.code!=='ESRCH')throw e;}}return true;},'原CLI自然退出',10000);
 const afterLoss={first,info_exists:await exists(config.infoPath),lock_exists:await exists(config.infoPath+'.dsh-lock'),profile_exists:await exists(first.lock.home),model_socket_exists:await exists(modelSocket),journal:await readJson(modelPath),commands:await commands(),database:await snapshot()};
 await writeFile(join(run,'after-parent-loss.json'),JSON.stringify(afterLoss,null,2));
 assert.equal(afterLoss.info_exists,false);assert.equal(afterLoss.profile_exists,false);assert.equal(afterLoss.model_socket_exists,false);assert.equal(afterLoss.lock_exists,true);assert.deepEqual(await readJson(config.infoPath+'.dsh-lock'),first.lock);assert.equal(afterLoss.journal.host,null);assert.equal(afterLoss.journal.active.length,0);assert.equal(afterLoss.journal.unknown.length,0);
 const quiescentCommands=afterLoss.commands.length;const queryStart=Date.now();await f.client.query('SELECT pg_sleep(0.25)');assert.equal((await commands()).length,quiescentCommands);
 result.checks.parent_loss={sigkill_target:'本轮自有launcher helper',dsh_legacy_cli_naturally_gone:true,info_removed:true,profile_removed:true,launcher_lock_preserved:true,journal_host_null:true,model_socket_removed:true,no_cli_commands_after_exit:true,observation_ms:Date.now()-queryStart};await stage('same_path_restart');
 // 不改锁、info、journal或数据库，不重新confirm/enable/check；第二次仅GET状态。
 const restartStart=Date.now(),commandsBeforeRestart=(await commands()).length;
 const second=await startHelper(2);assert.notEqual(second.helperIdentity.pid,first.helperIdentity.pid);assert.notEqual(second.dshIdentity.pid,first.dshIdentity.pid);assert.notEqual(second.lock.nonce,first.lock.nonce);
 await until(async()=>{const status=await request('/api/sync/status');if(status.status!==200)return false;const cmds=bodyCommands((await commands()).slice(commandsBeforeRestart));return cmds.some(c=>c.parent===second.dshIdentity.pid&&c.args.includes('--cursor')&&c.args[c.args.indexOf('--cursor')+1]==='incremental-2')?status:false;},'仅GET status观察原授权自动恢复与稳定cursor重复交付',30000);
 await until(async()=>(await f.client.query("SELECT count(*)::int n FROM public.source_processing_record WHERE outcome='message_reused'")).rows[0].n>=1,'重复交付写入可追溯reused处理回执',8000);
 const after=await snapshot(),journalAfter=await readJson(modelPath);
 await writeFile(join(run,'restart-observed-before-assertions.json'),JSON.stringify({second,after,journalAfter,commands:await commands()},null,2));
 assert.equal(after.front_sync_state[0].enabled,true);assert.deepEqual(after.wechat_sync_scope,stableBefore.scope);assert.deepEqual(after.conversation_binding,stableBefore.bindings);assert.deepEqual(after.wechat_observation_baseline,stableBefore.baseline);
 assert.equal(after.wechat_observation_cursor.length,1);assert.equal(after.wechat_observation_cursor[0].last_cursor,stableBefore.cursor[0].last_cursor);assert.equal(after.wechat_observation_cursor[0].last_local_id,stableBefore.cursor[0].last_local_id);
 assert.equal(after.message.length,1);assert.deepEqual(after.message[0],originalMessage);assert.ok(after.message_source_ref.length>=1);assert.deepEqual(after.message_source_ref.find(r=>r.id===source.id),source);assert.deepEqual(after.source_processing_record.find(r=>r.record_id===originalProcessing.record_id),originalProcessing);
 for(const ref of after.message_source_ref){assert.equal(ref.owner_id,owner);assert.equal(ref.contact_id,binding.contact_id);assert.equal(ref.message_id,originalMessage.id);assert.ok(after.local_wechat_observation.some(o=>o.id===ref.observation_id&&o.binding_id===binding.binding_id));if(ref.id!==source.id){assert.ok(after.source_processing_record.some(r=>r.outcome==='message_reused'&&r.message_id===originalMessage.id&&r.source_ref_id===ref.id&&r.payload.persistence.message_id===originalMessage.id&&r.payload.persistence.source_ref_id===ref.id&&r.payload.model_read_status==='not_claimed'));}}
 assert.deepEqual(after.memory_extraction_receipt,before.memory_extraction_receipt);assert.deepEqual(after.wechat_sync_exclusion,before.wechat_sync_exclusion);
 assert.equal(after.wechat_binding_history_authorization.length,0);assert.equal(journalAfter.host.pid,second.dshIdentity.pid);assert.equal(journalAfter.active.length,0);assert.equal(journalAfter.unknown.length,0);
 const finalCounters=await counters();assert.deepEqual(finalCounters,{message:1,message_source_ref:after.message_source_ref.length,background_task:0,background_task_step:0,model_call_receipt:0,model_call_learning_claim:0,outbound_ledger_entry:0,reply_request:0,reply_attempt:0});
 const cmds=await commands();assert.ok(!cmds.some(c=>c.args.includes('--history')));assert.ok(bodyCommands(cmds).every(c=>c.args[1]==='friend-a'));assert.ok(bodyCommands(cmds).some(c=>c.parent===second.dshIdentity.pid));
 await writeFile(join(run,'after-restart.json'),JSON.stringify({second,after,journalAfter,commands:cmds,counters:finalCounters},null,2));
 result.checks.restart={same_database_and_env_business_info_paths:true,stable_model_journal_path:true,only_get_status_after_restart:true,explicit_confirm_enable_check_count_after_restart:0,scope_baseline_binding_preserved:true,original_message_uuid_and_source_processing_preserved:true,cursor_preserved:true,replayed_stable_local_id:'2',message_count:1,source_ref_count:after.message_source_ref.length,original_source_preserved:true,new_sources_have_reused_receipts:true,extraction_receipt_count:after.memory_extraction_receipt.length,history_queries:0,downtime_new_messages:0,automatic_resume_ms:Date.now()-restartStart};result.checks.counters=finalCounters;
 await stage('normal_final_shutdown');assert.equal((await request('/api/runtime/shutdown',{})).status,200);
 await until(async()=>await processIdentityState(second.dshIdentity)==='gone'&&await processIdentityState(second.legacyIdentity)==='gone','第二个宿主正常结束');
 await until(async()=>!await exists(config.infoPath+'.dsh-lock'),'第二个helper回收原锁');
 result.pass=true;
}catch(error){result.pass=false;result.failure={stage:result.stage,name:error.name,message:error.message,stack:error.stack};await save();console.error(error.stack);}
finally{
 // 先固化真实RED，才清理身份核验成功的本轮自有资源。
 await save();let emergency=false;
 if(connection&&dshIdentity&&await processIdentityState(dshIdentity)==='same')try{await request('/api/runtime/shutdown',{});await until(async()=>await processIdentityState(dshIdentity)==='gone'&&await processIdentityState(legacyIdentity)==='gone','清理先等公开shutdown完成',12000);await until(async()=>!await exists(config.infoPath+'.dsh-lock'),'helper自然回收',5000);}catch{}
 for(const item of [...identities].reverse()){
  try{if(await processIdentityState(item.identity)==='same'){
   emergency=true;process.kill(item.identity.pid,'SIGTERM');await until(async()=>await processIdentityState(item.identity)==='gone','收尾 '+item.kind,8000);
  }}catch(error){result.cleanup['process_'+item.kind]=String(error);}
 }
 for(const child of helpers){if(child.connected)child.disconnect();}
 result.cleanup.emergency_owned_process_cleanup=emergency;
 result.cleanup.processes=[];for(const item of identities)result.cleanup.processes.push({kind:item.kind,state:await processIdentityState(item.identity)});
 if(f){
  result.cleanup.cli_gone=(await commands()).every(c=>{try{process.kill(c.pid,0);return false;}catch(e){return e.code==='ESRCH';}});
  result.cleanup.info_removed=!await exists(config?.infoPath??join(f.directory,'backend.info'));result.cleanup.launcher_lock_removed=!await exists((config?.infoPath??join(f.directory,'backend.info'))+'.dsh-lock');result.cleanup.profiles_removed=await Promise.all(profiles.map(async p=>!await exists(p)));result.cleanup.model_socket_removed=modelSocket?!await exists(modelSocket):null;
  // 自然失败的锁/profile保留到取证后；仅删除本轮fixture所属文件。
  try{await f.close();result.cleanup.database_dropped=true;result.cleanup.fixture_removed=!await exists(f.directory);}catch(error){result.cleanup.database_error=String(error);result.pass=false;}
  try{const {default:pg}=await import(join(project,'backend-ts/node_modules/pg/lib/index.js'));const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();result.cleanup.database_absent=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[f.database])).rowCount===0;result.cleanup.shared_pg_alive=(await admin.query('SELECT 1')).rowCount===1;await admin.end();}catch(error){result.cleanup.verification_error=String(error);result.pass=false;}
 }
 result.identities=identities;await save();
}
console.log(JSON.stringify({pass:result.pass,stage:result.stage,failure:result.failure?.message,checks:result.checks,cleanup:result.cleanup}));if(!result.pass)process.exitCode=1;
