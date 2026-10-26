/** 公开产品 Host、隔离 PG 和官方存档真实运行，仅模型网络为合成供应商。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm,stat,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';

async function fixture(t){
 let candidateText='合成保存候选',gate=null,active=0,maxActive=0,nextTool=null,useSkill=false;
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token=randomUUID()+randomUUID();
 const businessHome=await mkdtemp(join(tmpdir(),'notalone-persistent-assistant-'));
 t.after(async()=>{await f.close();await rm(businessHome,{recursive:true,force:true});});
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成持久用户')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成持久联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 const start=(environment={})=>startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:async()=>{}},(_req,res,requests,events)=>{
   active++;maxActive=Math.max(maxActive,active);res.once('finish',()=>{active--;});
   const body=requests.at(-1).body,last=body.messages.at(-1),raw=JSON.stringify(last),citation=[...raw.matchAll(/(?:evidence_id\\?"\s*:\s*\\?")(c\d+)/g)].at(-1)?.[1]??'c1';
   if(nextTool){const tool=nextTool;nextTool=null;const selected=tool(body);useTool(events,selected.name,selected.args);sendEvents(res,events);return;}
   const skillAlias=useSkill?[...JSON.stringify(body).matchAll(/version_id\\?"\s*:\s*\\?"(k\d+)/g)].at(-1)?.[1]??null:null;
   if(body.tools.some(tool=>tool.name==='ExplorationOutput'))useTool(events,'ExplorationOutput',{understanding:'合成近期联系',ambiguities:[],citation_ids:[],options:[{intent:'了解近况',label:'关心',reason:'由用户决定',citation_ids:[],recommended:false,pause:false},{intent:'稍后联系',label:'稍后',reason:'由用户决定',citation_ids:[],recommended:false,pause:false}],question:null,current_step:'选择本次意愿',tradeoffs:[]});else useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:skillAlias,candidates:[{text:candidateText,basis:'本轮明确原句',citation_ids:[citation],risk_notes:[]}]});if(gate){const current=gate;gate=null;current.enter();current.wait.then(()=>sendEvents(res,events));return;}sendEvents(res,events);
 },{pluginPath:'test/host-reply-runtime-plugin.ts',environment:{NOTALONE_SYNTHETIC_PERSISTENT:'1',NOTALONE_SYNTHETIC_BUSINESS_HOME:businessHome,...environment}});
 const request=async(host,path,body,method=body===undefined?'GET':'POST')=>{
  const response=await fetch(host.url+path,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json','x-notalone-manual-contact':contact},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result)+(response.ok?"":host.output));return result;
 };
 return {f,owner,contact,binding,token,businessHome,start,request,setUseSkill:value=>{useSkill=value;},setNextTool:value=>{nextTool=value;},maxActive:()=>maxActive,setCandidateText:text=>{candidateText=text;},holdNext:()=>{let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);gate={enter,wait};return {entered,release};},input:text=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:text,include_relationship_context:false},skill_disabled:true})};
}

// 自有库只恢复122涉及的旧结构，再执行原迁移SQL验证来源分类；保留生产迁移器的连接门禁，不把此处当整套升级验收。
async function upgradeLegacyProvenance(f){
 assert.match(f.f.client.database,/^notalone_ts_host_[a-f0-9]+_test$/);
 await f.f.client.query('ALTER TABLE assistant_session DROP COLUMN legacy_runtime_pending');
 await f.f.client.query(await readFile(new URL('../database/migrations/122_assistant_legacy_resume_provenance.sql',import.meta.url),'utf8'));
}

function hostOutput(host,marker){
 if(host.output.includes(marker))return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error(`自有宿主屏障超时：${marker}`));},10000);
  const data=()=>{if(host.output.includes(marker)){cleanup();resolve();}},exit=()=>{cleanup();reject(Error('自有宿主在屏障前退出'));};
  function cleanup(){clearTimeout(timer);host.child.stdout.off('data',data);host.child.off('exit',exit);}
  host.child.stdout.on('data',data);host.child.once('exit',exit);
 });
}

test('自有宿主SIGKILL后中断未过期和已过期任务，明确重试幂等且重启零模型',{timeout:60000},async t=>{
 const f=await fixture(t);let host=await f.start();
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 for(const expired of [false,true]){
  const command=f.input(`合成崩溃保留输入${expired}`),gate=f.holdNext();
  const running=f.request(host,`${path}/replies`,command).catch(error=>error);await gate.entered;
  if(expired)await f.f.client.query("UPDATE reply_request SET lease_expires_at=now()-interval '1 second' WHERE idempotency_key=$1",[command.idempotency_key]);
  assert.deepEqual(await host.stop('SIGKILL'),[null,'SIGKILL']);await running;gate.release();
  host=await f.start();assert.equal(host.requests.length,0,'再次启动不自动重发模型');
  const history=await f.request(host,path),turn=history.turns.find(turn=>turn.request_key===command.idempotency_key);
  assert.equal(turn.state,'failed');assert.equal(turn.interruption_reason,'app_quit');assert.equal(turn.reply,null);
  assert.match(JSON.stringify(turn.input),/合成崩溃保留输入/);
  const retry={original_turn_id:turn.turn_id,original_input_version_id:turn.input_version_id,request_key:randomUUID()};
  const completed=await f.request(host,`${path}/retry-interrupted`,retry);
  assert.equal(completed.state,'completed');assert.deepEqual(await f.request(host,`${path}/retry-interrupted`,retry),completed);
  assert.equal(host.requests.length,1,'明确重试只生成并保存一次');
  assert.equal((await f.request(host,path)).turns.filter(turn=>turn.request_key===retry.request_key).length,1);
 }
});

test('自有宿主正常退出等待在途任务收尾，重启显示中断且不自动生成',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`,input=f.input('合成正常退出未完成输入'),gate=f.holdNext();
 const running=f.request(host,`${path}/replies`,input).catch(error=>error);await gate.entered;const exited=await host.stop();await running;gate.release();assert.equal(exited[0],0);
 const restarted=await f.start(),turn=(await f.request(restarted,path)).turns.find(turn=>turn.request_key===input.idempotency_key);
 assert.equal(turn.state,'failed');assert.equal(turn.interruption_reason,'app_quit');assert.equal(turn.reply,null);assert.match(JSON.stringify(turn.input),/合成正常退出未完成输入/);assert.equal(restarted.requests.length,0);
});

test('缺失和损坏存档在原讨论按有效业务记录一次重建，恢复本身零模型',{timeout:60000},async t=>{
 const f=await fixture(t);let host=await f.start();
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成恢复前原输入'));
 const history=await f.request(host,path);
 for(const damage of ['missing_log','missing_directory','corrupt','event_count','torn_tail','dirty']){
  await host.stop();
  const root=join(f.businessHome,'assistant-runtime',f.owner,f.contact,session),row=(await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0],runtimeRoot=join(root,row.runtime_session_id),files=await readdir(runtimeRoot,{recursive:true});
  const log=join(runtimeRoot,files.find(file=>file.endsWith('.jsonl')));
  if(damage==='missing_log')await rm(log);
  if(damage==='missing_directory'){
   await rm(runtimeRoot,{recursive:true});
  }
  if(damage==='corrupt')await writeFile(log,'{broken\n'+(await readFile(log,'utf8')).split('\n').slice(1).join('\n'));
  if(damage==='event_count')await f.f.client.query('UPDATE assistant_runtime_session SET committed_event_count=committed_event_count+1 WHERE session_id=$1',[session]);
  if(damage==='torn_tail')await writeFile(log,(await readFile(log,'utf8'))+'{"uncommitted_ghost":"合成撕裂尾');
  if(damage==='dirty')await f.f.client.query("UPDATE assistant_runtime_session SET state='dirty' WHERE session_id=$1",[session]);
  host=await f.start();assert.deepEqual(await f.request(host,path),history,'业务可见历史独立于运行档');
  assert.equal((await f.request(host,`${path}/resume`,{})).session_id,session,damage);
  if(damage!=='torn_tail')assert.notEqual((await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0].runtime_session_id,row.runtime_session_id,damage);
  assert.equal(host.requests.length,0,'读取及恢复不得请求模型');
 }
 await f.request(host,`${path}/replies`,f.input('合成恢复后明确生成'));
 assert.match(JSON.stringify(host.requests[0].body),/合成恢复前原输入/);assert.doesNotMatch(JSON.stringify(host.requests[0].body),/合成撕裂尾/);
});

test('业务已保存而运行提交失败仍显示可靠候选，SIGKILL后同键只读重放',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.f.client.query("CREATE FUNCTION synthetic_reject_runtime_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='ready' AND NEW.committed_request_id IS NOT NULL THEN RAISE EXCEPTION 'synthetic runtime commit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_reject_runtime_commit BEFORE UPDATE ON assistant_runtime_session FOR EACH ROW EXECUTE FUNCTION synthetic_reject_runtime_commit()");
 const command=f.input('合成业务已保存原输入');
 const response=await fetch(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(command)});
 assert.equal(response.status,502);assert.equal(host.requests.length,1);
 const saved=await f.request(host,path),turn=saved.turns.find(turn=>turn.request_key===command.idempotency_key);
 assert.equal(turn.state,'completed');assert.equal(turn.reply.candidates[0].text,'合成保存候选');
 assert.deepEqual(await host.stop('SIGKILL'),[null,'SIGKILL']);
 await f.f.client.query('DROP TRIGGER synthetic_reject_runtime_commit ON assistant_runtime_session');
 // 模拟旧版本在DB保存后留下的失败投影；再次启动必须按同一DB完成凭据裁定。
 await f.f.client.query("UPDATE assistant_session_turn SET state='failed' WHERE id=$1",[turn.turn_id]);
 const restarted=await f.start();assert.deepEqual(await f.request(restarted,path),saved);assert.equal(restarted.requests.length,0);
 const replay=await f.request(restarted,`${path}/replies`,command);assert.equal(replay.turn_id,turn.turn_id);assert.equal(replay.candidates[0].candidate_id,turn.reply.candidates[0].candidate_id);assert.equal(restarted.requests.length,0);
 await f.request(restarted,`${path}/resume`,{});assert.equal(restarted.requests.length,0);
});

test('真实完成HTTP正文回执丢失后重启可读原候选，同键重放不再调用模型',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`,command=f.input('合成完成回执丢失输入');
 await new Promise((resolve,reject)=>{
  const request=httpRequest(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact}},response=>{assert.equal(response.statusCode,200);response.destroy();resolve();});request.once('error',reject);request.end(JSON.stringify(command));
 });
 const saved=await f.request(host,path),turn=saved.turns.find(turn=>turn.request_key===command.idempotency_key);assert.equal(turn.state,'completed');assert.equal(host.requests.length,1);
 await host.stop('SIGKILL');const restarted=await f.start();assert.deepEqual(await f.request(restarted,path),saved);
 const replay=await f.request(restarted,`${path}/replies`,command);assert.equal(replay.candidates[0].candidate_id,turn.reply.candidates[0].candidate_id);assert.equal(restarted.requests.length,0);
});

test('真实JSONL已fsync而DB候选事务被阻断，SIGKILL后不恢复幽灵输出',{timeout:60000},async t=>{
 const f=await fixture(t),control=join(f.businessHome,'runtime-faults.json');
 await writeFile(control,JSON.stringify({durable_marker:'合成磁盘先于提交幽灵'}),{mode:0o600});
 const host=await f.start({NOTALONE_SYNTHETIC_RUNTIME_FAULTS:control}),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.f.client.query('SELECT pg_advisory_lock(700612)');
 await f.f.client.query('CREATE FUNCTION synthetic_hold_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(700612); RETURN NEW; END $$; CREATE TRIGGER synthetic_hold_candidate BEFORE INSERT ON reply_candidate FOR EACH ROW EXECUTE FUNCTION synthetic_hold_candidate()');
 f.setCandidateText('合成磁盘先于提交幽灵');const running=f.request(host,`${path}/replies`,f.input('合成应保留的未完成输入')).catch(error=>error);
 try{
  await hostOutput(host,'VALIDATION_RUNTIME_DURABLE_MARKER');
  const root=join(f.businessHome,'assistant-runtime'),files=await readdir(root,{recursive:true});
  assert.match(await readFile(join(root,files.find(file=>file.endsWith('.jsonl'))),'utf8'),/合成磁盘先于提交幽灵/,'真实fsync后的文件含模型输出');
  assert.deepEqual(await host.stop('SIGKILL'),[null,'SIGKILL']);await running;
 }finally{await f.f.client.query('SELECT pg_advisory_unlock(700612)');}
 await f.f.client.query('DROP TRIGGER synthetic_hold_candidate ON reply_candidate');
 const restarted=await f.start(),saved=await f.request(restarted,path);
 assert.doesNotMatch(JSON.stringify(saved),/合成磁盘先于提交幽灵/);assert.match(JSON.stringify(saved),/合成应保留的未完成输入/);assert.equal(restarted.requests.length,0);
 await f.request(restarted,`${path}/resume`,{});assert.equal(restarted.requests.length,0);
 f.setCandidateText('合成新可靠候选');await f.request(restarted,`${path}/replies`,f.input('合成崩溃后明确请求'));
 assert.doesNotMatch(JSON.stringify(restarted.requests[0].body),/合成磁盘先于提交幽灵/);
});

test('重建磁盘拒写每次动作有界失败，原输入与历史保留，明确恢复后可继续',{timeout:60000},async t=>{
 const f=await fixture(t),control=join(f.businessHome,'runtime-faults.json');await writeFile(control,'{}',{mode:0o600});
 const host=await f.start({NOTALONE_SYNTHETIC_RUNTIME_FAULTS:control}),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成磁盘故障前输入'));const saved=await f.request(host,path);
 const root=join(f.businessHome,'assistant-runtime'),files=await readdir(root,{recursive:true});await rm(join(root,files.find(file=>file.endsWith('.jsonl'))));
 await writeFile(control,JSON.stringify({fail_reference:true}));
 for(let attempt=1;attempt<=2;attempt++){
  const response=await fetch(host.url+`${path}/resume`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:'{}'});
  assert.equal(response.status,503);assert.deepEqual(await f.request(host,path),saved);assert.equal(host.requests.length,1);
  assert.equal(host.output.split('VALIDATION_RUNTIME_WRITE_REFUSED').length-1,attempt,'一次明确动作仅一次建档，不自动循环');
 }
 await writeFile(control,'{}');await f.request(host,`${path}/resume`,{});assert.deepEqual(await f.request(host,path),saved);assert.equal(host.requests.length,1);
});

test('缺档但官方SDK写锁仍活时拒绝重建，不解除或删除活锁',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成活锁前输入'));
 const row=(await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0],root=join(f.businessHome,'assistant-runtime',f.owner,f.contact,session,row.runtime_session_id);
 const holder=spawn(process.execPath,[new URL('./assistant-runtime-lock-holder.mjs',import.meta.url).pathname,root,row.runtime_session_id],{stdio:['pipe','pipe','pipe']}),exited=once(holder,'exit');let output='';holder.stdout.on('data',data=>{output+=data;});holder.stderr.on('data',data=>{output+=data;});
 const holderState={child:holder,get output(){return output;}};
 t.after(async()=>{if(holder.exitCode===null&&holder.signalCode===null)holder.kill('SIGTERM');await exited;});
 await hostOutput(holderState,'VALIDATION_LOCK_READY');
 assert.equal(holder.exitCode,null);
 const files=await readdir(root,{recursive:true}),log=join(root,files.find(file=>file.endsWith('.jsonl'))),lock=join(root,files.find(file=>file.endsWith('/session.lock'))),before=await stat(lock);await rm(log);
 const response=await fetch(host.url+`${path}/resume`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:'{}'});
 assert.equal(response.status,503);assert.equal(host.requests.length,1);assert.equal((await stat(lock)).ino,before.ino);assert.equal((await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0].runtime_session_id,row.runtime_session_id);
 holder.kill('SIGTERM');await exited;
 await f.request(host,`${path}/resume`,{});assert.equal(host.requests.length,1);
});

test('分段准备回执全丢后可按原会话和请求键只读找回受理，不改变输入或再生成',{timeout:60000},async t=>{
 const f=await fixture(t),clock=join(f.businessHome,'domain-clock');await writeFile(clock,'2030-06-01T00:00:00Z');
 const host=await f.start({NOTALONE_SYNTHETIC_ASSISTANT_CLOCK:clock}),base=`/api/contacts/${f.contact}/assistant-sessions`,{session_id:old}=await f.request(host,base,{}),path=`${base}/${old}`;
 await f.request(host,`${path}/replies`,f.input('合成分段前讨论'));await writeFile(clock,'2030-06-01T13:00:00Z');
 const input=f.input('合成准备回执丢失原输入'),prepared=await f.request(host,`${path}/replies/prepare`,input);
 assert.notEqual(prepared.session_id,old);assert.equal(prepared.previous_session_id,old);
 const before=await f.request(host,base),history=await f.request(host,`${base}/${prepared.session_id}`),calls=host.requests.length;
 assert.ok(!(await f.request(host,path)).turns.some(turn=>turn.request_key===input.idempotency_key));
 assert.deepEqual(await f.request(host,`${path}/generation-receipt`,{request_key:input.idempotency_key}),prepared);
 assert.deepEqual(await f.request(host,base),before);assert.deepEqual(await f.request(host,`${base}/${prepared.session_id}`),history);assert.equal(host.requests.length,calls);
 assert.deepEqual(await f.request(host,`${path}/replies/prepare`,input),prepared,'旧URL同冻结命令仍返回原受理');
 const {session_id:unrelated}=await f.request(host,base,{});
 const wrong=await fetch(host.url+`${base}/${unrelated}/generation-receipt`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify({request_key:input.idempotency_key})});assert.equal(wrong.status,404);
 await f.request(host,`${path}/replies`,input);assert.equal(host.requests.length,calls+1);
 assert.equal((await f.request(host,`${path}/generation-receipt`,{request_key:input.idempotency_key})).state,'completed');assert.equal(host.requests.length,calls+1);
});

test('未来格式、SDK身份、链接和权限错误保持原档与业务历史，零出站失败关闭',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成不可信档案前输入'));const saved=await f.request(host,path);
 const row=(await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0],root=join(f.businessHome,'assistant-runtime',f.owner,f.contact,session,row.runtime_session_id),files=await readdir(root,{recursive:true}),log=join(root,files.find(file=>file.endsWith('.jsonl'))),original=await readFile(log,'utf8');
 for(const damage of ['future','identity','cwd','symlink','permissions']){
  if(['future','identity','cwd'].includes(damage)){
   const lines=original.split('\n'),header=JSON.parse(lines[0]);if(damage==='future')header.version=10000;if(damage==='identity')header.id=randomUUID();if(damage==='cwd')header.cwd='/synthetic-unrelated';lines[0]=JSON.stringify(header);await writeFile(log,lines.join('\n'));
  }
  if(damage==='symlink'){await rm(log);const target=join(f.businessHome,'synthetic-unrelated.jsonl');await writeFile(target,original,{mode:0o600});await symlink(target,log);}
  if(damage==='permissions')await chmod(log,0o644);
  const before=await readFile(log,'utf8'),response=await fetch(host.url+`${path}/resume`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:'{}'});
  assert.ok([409,503].includes(response.status),damage);assert.equal(await readFile(log,'utf8'),before,damage);assert.deepEqual(await f.request(host,path),saved);assert.equal(host.requests.length,1);
  assert.equal((await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0].runtime_session_id,row.runtime_session_id);
  if(damage==='symlink')await rm(log);await writeFile(log,original,{mode:0o600});await chmod(log,0o600);
 }
 await f.request(host,`${path}/resume`,{});assert.equal(host.requests.length,1);
});

test('官方写句柄关闭未确认时保留同会话占用，重启前不假定可修',{timeout:60000},async t=>{
 const f=await fixture(t),control=join(f.businessHome,'runtime-faults.json');await writeFile(control,'{}',{mode:0o600});
 const host=await f.start({NOTALONE_SYNTHETIC_RUNTIME_FAULTS:control}),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成关闭未确认前输入'));const saved=await f.request(host,path);
 await writeFile(control,JSON.stringify({fail_lock_close:true}));
 const resume=()=>fetch(host.url+`${path}/resume`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:'{}'});
 assert.equal((await resume()).status,503);await writeFile(control,'{}');assert.equal((await resume()).status,409);
 assert.deepEqual(await f.request(host,path),saved);assert.equal(host.requests.length,1);
 await host.stop();const restarted=await f.start();await f.request(restarted,`${path}/resume`,{});assert.deepEqual(await f.request(restarted,path),saved);assert.equal(restarted.requests.length,0);
});

test('官方open解码失败且释放锁也失败时保留未知占用，不能立即覆盖坏档',{timeout:60000},async t=>{
 const f=await fixture(t),control=join(f.businessHome,'runtime-faults.json');await writeFile(control,'{}',{mode:0o600});
 const host=await f.start({NOTALONE_SYNTHETIC_RUNTIME_FAULTS:control}),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成open释放未知前输入'));const saved=await f.request(host,path);
 const root=join(f.businessHome,'assistant-runtime'),files=await readdir(root,{recursive:true}),log=join(root,files.find(file=>file.endsWith('.jsonl')));await writeFile(log,'{broken\n');await writeFile(control,JSON.stringify({fail_lock_close:true}));
 const resume=()=>fetch(host.url+`${path}/resume`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:'{}'});
 assert.equal((await resume()).status,503);await writeFile(control,'{}');assert.equal((await resume()).status,409);assert.equal(await readFile(log,'utf8'),'{broken\n');
 assert.deepEqual(await f.request(host,path),saved);await host.stop();const restarted=await f.start();await f.request(restarted,`${path}/resume`,{});assert.equal(restarted.requests.length,0);
});

test('修复写盘屏障期间来源修正必须拒绝旧资格发布，再恢复只带有效资料',{timeout:60000},async t=>{
 const f=await fixture(t),control=join(f.businessHome,'runtime-faults.json');await writeFile(control,'{}',{mode:0o600});
 const host=await f.start({NOTALONE_SYNTHETIC_RUNTIME_FAULTS:control}),source=randomUUID(),message=randomUUID();
 await f.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','synthetic.jsonl',$4,1)",[source,f.owner,f.contact,'6'.repeat(64)]);
 await f.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成修复前失效背景_06',now())",[message,f.owner,f.contact]);
 await f.f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic','{}')",[message,f.owner,f.contact,source]);
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`,input=text=>({...f.input(text),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:text,include_relationship_context:true}});
 await f.request(host,`${path}/replies`,input('合成修复前意图'));assert.match(JSON.stringify(host.requests[0].body),/合成修复前失效背景_06/);
 const root=join(f.businessHome,'assistant-runtime'),files=await readdir(root,{recursive:true});await rm(join(root,files.find(file=>file.endsWith('.jsonl'))));await writeFile(control,JSON.stringify({hold_reference:true}));
 const repairing=fetch(host.url+`${path}/resume`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:'{}'});await hostOutput(host,'VALIDATION_RUNTIME_WRITE_HELD');
 await f.f.client.query("UPDATE message SET text_content='合成修复后当前背景_06',speaker='user' WHERE id=$1",[message]);host.child.kill('SIGUSR2');
 assert.equal((await repairing).status,409);assert.equal(host.requests.length,1);assert.match(JSON.stringify(await f.request(host,path)),/合成修复前意图/);
 await writeFile(control,'{}');await f.request(host,`${path}/resume`,{});assert.equal(host.requests.length,1);
 await f.request(host,`${path}/replies`,input('合成修复后当前意图'));assert.doesNotMatch(JSON.stringify(host.requests[1].body),/合成修复前失效背景_06/);assert.match(JSON.stringify(host.requests[1].body),/合成修复后当前背景_06/);
});

test('目录与历史浏览保持当前和真实活动，明确继续原段才刷新活动且零模型',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),base=`/api/contacts/${f.contact}/assistant-sessions`;
 assert.deepEqual(await f.request(host,base),{sessions:[],current_session_id:null});
 const {session_id:old}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),oldPath=`${base}/${old}`;
 assert.equal((await f.request(host,base)).sessions[0].last_user_activity_at,null,'未知活动不从创建或通用更新时间伪造');
 await f.request(host,`${oldPath}/resume`,{});
 await f.request(host,`${oldPath}/replies`,f.input('合成旧讨论'));
 const {session_id:current}=await f.request(host,base,{});
 const before=await f.request(host,base),activity=before.sessions.find(item=>item.session_id===old).last_user_activity_at;
 assert.match(activity,/^\d{4}-\d{2}-\d{2}T/,'活动单独投影，不使用通用更新时间');
 await f.f.client.query('UPDATE assistant_session SET updated_at=clock_timestamp() WHERE id=$1',[old]);
 await f.request(host,oldPath);
 const after=await f.request(host,base);
 assert.deepEqual(after,before,'回看不切当前或刷新活动');
 const requests=host.requests.length;
 assert.deepEqual(await f.request(host,`${oldPath}/resume`,{}),{session_id:old});
 const resumed=await f.request(host,base);
 assert.equal(resumed.current_session_id,old);
 assert.ok(resumed.sessions.find(item=>item.session_id===old).last_user_activity_at>activity);
 assert.equal(resumed.sessions.find(item=>item.session_id===current).last_user_activity_at,before.sessions.find(item=>item.session_id===current).last_user_activity_at);
 assert.equal(host.requests.length,requests,'明确继续本身不得调用模型');
});

test('历史候选编辑保留版本，只刷新被编辑段；新段模型不自动带旧讨论',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:old}=await f.request(host,base,{}),oldPath=`${base}/${old}`;
 const first=await f.request(host,`${oldPath}/replies`,f.input('合成旧要求：只在旧段使用'));
 const candidate=first.candidates[0].candidate_id,versionsPath=`${oldPath}/candidates/${candidate}/versions`;
 const versions=await f.request(host,versionsPath),original=versions.versions[0];
 const {session_id:current}=await f.request(host,base,{}),before=await f.request(host,base);
 assert.deepEqual(await f.request(host,versionsPath),versions);
 assert.deepEqual(await f.request(host,base),before,'候选版本浏览不续期');
 const edit={edit_key:randomUUID(),parent_version_id:original.version_id,messages:original.messages.map(message=>({...message,text:'合成历史编辑'}))};
 const edited=await f.request(host,versionsPath,edit),after=await f.request(host,base);
 assert.equal(edited.versions.length,2);assert.equal(edited.versions[0].text,original.text);
 assert.equal(edited.versions[1].parent_version_id,original.version_id);
 assert.equal(edited.selected_version_id,null,'编辑与复制不证明已发送或选用');
 assert.equal(after.current_session_id,current);
 assert.ok(after.sessions.find(item=>item.session_id===old).last_user_activity_at>before.sessions.find(item=>item.session_id===old).last_user_activity_at);
 assert.equal(after.sessions.find(item=>item.session_id===current).last_user_activity_at,before.sessions.find(item=>item.session_id===current).last_user_activity_at);
 await f.request(host,`${base}/${current}/replies`,f.input('合成新段独立输入'));
 assert.doesNotMatch(JSON.stringify(host.requests.at(-1).body),/合成旧要求：只在旧段使用|合成历史编辑/);
 const selected=await f.request(host,`${oldPath}/selections`,{candidate_id:candidate,version_id:edited.versions[1].version_id,selection_key:randomUUID()});
 const carried=await f.request(host,`${oldPath}/new-with-candidate`,{expected_selection_id:selected.selection_id,candidate_id:candidate,version_id:edited.versions[1].version_id});
 await f.request(host,`${base}/${carried.session_id}/replies`,{...f.input('合成明确携入版本'),expected_input_version_id:carried.input_version_id});
 assert.match(JSON.stringify(host.requests.at(-1).body),/合成历史编辑/,'用户明确携入的保存版本才进入新段');
 assert.doesNotMatch(JSON.stringify(host.requests.at(-1).body),/合成旧要求：只在旧段使用/);
});

test('明确继续在改当前与活动前拒绝错误联系人、绑定变化及失效来源',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:old}=await f.request(host,base,{}),path=`${base}/${old}`;
 await f.request(host,`${path}/replies`,f.input('合成资格原句'));
 const {session_id:current}=await f.request(host,base,{}),before=await f.request(host,base),requests=host.requests.length;
 const resume=async(p=path,contact=f.contact,manual=true)=>{
  const response=await fetch(host.url+`${p}/resume`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json',...(manual?{'x-notalone-manual-contact':contact}:{})},body:'{}'});
  return {status:response.status,body:await response.json()};
 };
 const other=randomUUID();await f.f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成其他联系人')",[other,f.owner]);
 await f.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[randomUUID(),f.owner,other]);
 assert.equal((await resume(path.replace(f.contact,other),other)).status,404);
 const binding=randomUUID();await f.f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic','changed')",[binding,f.owner,f.contact]);
 assert.equal((await resume(path,f.contact,false)).status,409);
 await f.f.client.query('DELETE FROM conversation_binding WHERE id=$1',[binding]);
 await f.f.client.query('UPDATE assistant_session_turn SET dependency_ids=$1 WHERE session_id=$2',[[randomUUID()],old]);
 assert.equal((await resume()).status,409);
 await f.f.client.query("UPDATE assistant_session_turn SET dependency_ids='{}' WHERE session_id=$1",[old]);
 await f.f.client.query("INSERT INTO cross_domain_deletion_operation(id,subject_sha256,scope_kind,source_kind,owner_id,contact_id,target_id) VALUES($1,$2,'source','source_document',$3,$4,$5)",[randomUUID(),'f'.repeat(64),f.owner,f.contact,randomUUID()]);
 assert.equal((await resume()).status,409,'来源删除未完成时仍阻恢复');
 assert.match(JSON.stringify(await f.request(host,path)),/合成资格原句/,'未完成删除不阻断只读历史');
 assert.deepEqual(await f.request(host,base),before,'资格失败不应修改任何活动或当前指针');
 assert.equal((await f.request(host,base)).current_session_id,current);
 assert.equal(host.requests.length,requests);
});

test('连续两轮及真实宿主重启恢复同一讨论和官方历史，不重复复制整段讨论',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`${base}/${session}`;
 const first=await f.request(host,`${path}/replies`,f.input('合成首轮：周五一起散步'));
 assert.equal(first.session_id,session);assert.equal(host.requests.length,1);
 const secondInput=f.input('合成第二轮：改为周六');
 await f.request(host,`${path}/replies/prepare`,secondInput);assert.equal(host.requests.length,1,'恢复历史的准备仍为零HTTP');
 await f.request(host,`${path}/replies`,secondInput);
 assert.equal(host.requests.length,2);
 const body=host.requests[1].body;
 assert.ok(body.messages.some(message=>message.role==='assistant'&&JSON.stringify(message).includes('合成保存候选')),'第二次实际供应商请求必须含已提交候选的真实运行消息');
 assert.doesNotMatch(JSON.stringify(body.messages.at(-1)),/assistant_discussion|合成首轮：周五一起散步|合成保存候选/,'准备并恢复codec后，本轮只追加当前输入，旧正文来自SDK消息');
 const archiveBefore=await readdir(join(f.businessHome,'assistant-runtime'),{recursive:true});
 assert.ok(archiveBefore.some(path=>path.endsWith('.jsonl')),'稳定业务目录保存官方JSONL');
 assert.equal((await stat(join(f.businessHome,'assistant-runtime'))).mode&0o077,0);
 await host.stop();
 const restarted=await f.start();
 const history=await f.request(restarted,path);assert.ok(JSON.stringify(history).includes('合成保存候选'));
 await f.request(restarted,`${path}/select`,{});assert.equal(restarted.requests.length,0,'明确继续和读取不调用模型');
 await f.request(restarted,`${path}/replies`,f.input('合成第三轮：保留周六安排'));
 assert.equal(restarted.requests.length,1);
 assert.match(JSON.stringify(restarted.requests[0].body.messages),/合成首轮：周五一起散步/,'重启恢复原运行记录');
 assert.doesNotMatch(JSON.stringify(restarted.requests[0].body.messages.at(-1)),/assistant_discussion/);
 const disk=await readdir(join(f.businessHome,'assistant-runtime'),{recursive:true});
 assert.deepEqual(disk.filter(path=>path.endsWith('.jsonl')),archiveBefore.filter(path=>path.endsWith('.jsonl')),'稳定讨论不得每轮另建日志');
 const deleted=await f.request(restarted,path,{confirmed:true},'DELETE');assert.equal(deleted.state,'deleted');
 assert.equal((await readdir(join(f.businessHome,'assistant-runtime'),{recursive:true})).filter(path=>path.endsWith('.jsonl')).length,0,'公开删除清除基础存档');
});


test('正常运行续用只检查资格摘要，不再为长旧候选构造整段业务参考',{timeout:60000},async t=>{
 const f=await fixture(t),marker='合成旧候选数据量观察_04R',old=marker+'。旧候选不可当作当前要求。'.repeat(120),sqlLog=join(f.businessHome,'sql-results.jsonl');
 const host=await f.start({NOTALONE_SYNTHETIC_SQL_RESULT_LOG:sqlLog,NOTALONE_SYNTHETIC_SQL_MARKER:marker}),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:session}=await f.request(host,base,{}),path=`${base}/${session}`;
 f.setCandidateText(old);await f.request(host,`${path}/replies`,f.input('合成首轮当前输入'));
 const before=(await f.f.client.query('SELECT runtime_session_id,committed_event_count FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0];
 await writeFile(sqlLog,'');assert.equal((await f.request(host,`${path}/resume`,{})).session_id,session);assert.equal(host.requests.length,1);
 const qualificationReads=(await readFile(sqlLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.ok(qualificationReads.some(q=>q.rows>0),'观测实际PG返回结果，不以私有装配函数调用次数证明');
 assert.equal(qualificationReads.reduce((n,q)=>n+q.marker_bytes,0),0,'正常ready资格检查不把旧候选正文从PG搬回应用组装参考');
 f.setCandidateText('合成新轮候选');await f.request(host,`${path}/replies`,f.input('合成第二轮当前输入'));
 const after=(await f.f.client.query('SELECT runtime_session_id,committed_event_count,qualification FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0];
 assert.equal(after.runtime_session_id,before.runtime_session_id);assert.ok(after.committed_event_count>before.committed_event_count);
 assert.ok(host.requests[1].body.messages.some(m=>m.role==='assistant'&&JSON.stringify(m).includes(marker)),'第二轮保留官方SDK的真实历史');
 assert.doesNotMatch(JSON.stringify(host.requests[1].body.messages.at(-1)),/合成旧候选数据量观察_04R|assistant_discussion/);
 assert.equal(after.qualification.payload_sha256,undefined,'从未构建业务伴随正文的native运行不持有虚构正文凭据');
 const allReads=(await readFile(sqlLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 t.diagnostic('真实PG结果字节 '+JSON.stringify({ready_result_bytes:qualificationReads.reduce((n,q)=>n+q.result_bytes,0),ready_old_candidate_bytes:qualificationReads.reduce((n,q)=>n+q.marker_bytes,0),generation_guard_old_candidate_bytes:allReads.reduce((n,q)=>n+q.marker_bytes,0)}));
});

test('旧资格格式在同一业务段零HTTP重建，伴随正文凭据独立且篡改后拒绝出站',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:session}=await f.request(host,base,{}),path=`${base}/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成旧资格格式输入'));
 const before=(await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0];
 await f.f.client.query(`UPDATE assistant_runtime_session SET qualification=jsonb_set(jsonb_set(qualification,'{version}','1'),'{contract}','"notalone-reply:fidelity-v3:bounded-tools-v1:business-reference-v1"') WHERE session_id=$1`,[session]);
 assert.equal((await f.request(host,`${path}/resume`,{})).session_id,session);assert.equal(host.requests.length,1,'升级资格不产生新模型轮次');
 const built=(await f.f.client.query('SELECT runtime_session_id,qualification,origin,committed_request_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0];
 assert.notEqual(built.runtime_session_id,before.runtime_session_id);assert.equal(built.origin,'business_rebuild');assert.equal(built.committed_request_id,null);assert.equal(built.qualification.version,2);assert.match(built.qualification.payload_sha256,/^[a-f0-9]{64}$/);
 await host.stop();const restarted=await f.start(),reference=join(f.businessHome,'assistant-runtime',f.owner,f.contact,session,built.runtime_session_id,'business-reference.json');
 const payload=JSON.parse(await readFile(reference,'utf8'));assert.match(JSON.stringify(payload),/合成旧资格格式输入|合成保存候选/);
 payload.items[0].text='合成篡改伴随正文';await writeFile(reference,JSON.stringify(payload));
 const response=await fetch(restarted.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(f.input('合成篡改后新输入'))});
 assert.ok([409,503].includes(response.status),JSON.stringify({status:response.status,body:await response.json()}));assert.equal(restarted.requests.length,0,'独立资格相同不等于伴随正文仍合格');
 assert.match(JSON.stringify(await f.request(restarted,path)),/合成保存候选/,'拒绝恢复不改真实业务候选');
});

test('明确改变本轮范围时按合格业务记录重建，不读取被篡改的旧伴随正文',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:session}=await f.request(host,base,{}),path=`${base}/${session}`;await f.request(host,`${path}/resume`,{});
 const previous=(await f.f.client.query('SELECT runtime_session_id,qualification FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0];assert.equal(previous.qualification.policy.relationship,true);
 const reference=join(f.businessHome,'assistant-runtime',f.owner,f.contact,session,previous.runtime_session_id,'business-reference.json'),payload=JSON.parse(await readFile(reference,'utf8'));
 payload.notice='合成旧伴随篡改标记_04P';await writeFile(reference,JSON.stringify(payload));
 const result=await f.request(host,`${path}/replies`,f.input('合成本轮明确不使用关系资料'));
 assert.equal(result.session_id,session);assert.equal(host.requests.length,1);assert.doesNotMatch(JSON.stringify(host.requests[0].body),/合成旧伴随篡改标记_04P/);
 const current=(await f.f.client.query('SELECT runtime_session_id,qualification FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0];assert.notEqual(current.runtime_session_id,previous.runtime_session_id);assert.equal(current.qualification.policy.relationship,false);
});

test('公开同键并发只写一轮，其他联系人不能读取或恢复其运行历史',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 const command=f.input('合成并发原句'),gate=f.holdNext(),running=f.request(host,`${path}/replies`,command);await gate.entered;
 const response=await fetch(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(command)});
 assert.equal(response.status,409);assert.equal(host.requests.length,1);gate.release();const completed=await running;
 assert.deepEqual(await f.request(host,`${path}/replies`,command),completed);assert.equal(host.requests.length,1);
 const other=randomUUID();await f.f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成隔离联系人')",[other,f.owner]);
 await f.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[randomUUID(),f.owner,other]);
 const wrong=await fetch(host.url+path.replace(f.contact,other),{headers:{Authorization:`Bearer ${f.token}`,'x-notalone-manual-contact':other}});assert.equal(wrong.status,404);assert.equal(host.requests.length,1);
});

test('合法模型配置改变时安全替换底层运行，业务讨论与候选保持',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成配置原句'));await host.stop();
 const changed=await f.start({NOTALONE_SYNTHETIC_REPLY_TEMPERATURE:'0.1'});
 const history=await f.request(changed,path);assert.match(JSON.stringify(history),/合成保存候选/);
 const response=await fetch(changed.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(f.input('配置变化后需核验'))});
 assert.equal(response.status,200,JSON.stringify(await response.json())+(response.ok?"":changed.output));assert.equal(changed.requests.length,1);assert.equal(changed.requests[0].body.temperature,0.1);assert.match(JSON.stringify(changed.requests[0].body),/合成保存候选/);
});

test('模型日志已写而业务保存失败，未提交候选不会成为历史或下一轮运行上下文',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.f.client.query("CREATE FUNCTION synthetic_reject_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit refusal'; END $$; CREATE TRIGGER synthetic_reject_candidate BEFORE INSERT ON reply_candidate FOR EACH ROW EXECUTE FUNCTION synthetic_reject_candidate()");
 f.setCandidateText('合成未提交幽灵候选');const response=await fetch(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(f.input('合成未提交输入'))});
 assert.equal(response.status,502);assert.equal(host.requests.length,1);
 const before=await f.request(host,path);assert.doesNotMatch(JSON.stringify(before),/合成未提交幽灵候选/);
 await f.f.client.query('DROP TRIGGER synthetic_reject_candidate ON reply_candidate');await host.stop();
 const restarted=await f.start();assert.equal(restarted.requests.length,0);assert.doesNotMatch(JSON.stringify(await f.request(restarted,path)),/合成未提交幽灵候选/);
 f.setCandidateText('合成可靠候选');await f.request(restarted,`${path}/replies`,f.input('只使用可靠资料生成'));
 assert.doesNotMatch(JSON.stringify(restarted.requests[0].body),/合成未提交幽灵候选/);
});


test('归属标记被替换时不能恢复他人存档，已保存业务历史仍可读',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成归属原句'));await host.stop();
 await writeFile(join(f.businessHome,'assistant-runtime',f.owner,f.contact,session,'ownership.json'),JSON.stringify({version:1,owner_id:randomUUID(),contact_id:f.contact,session_id:session}));
 const restarted=await f.start();assert.match(JSON.stringify(await f.request(restarted,path)),/合成保存候选/);
 const response=await fetch(restarted.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(f.input('不允许错误恢复'))});
 assert.equal(response.status,409);assert.equal(restarted.requests.length,0);
});

// 65536窗口/256输出/128余量的合成边界；正常产品配置另由pure-ts-persistent-assistant覆盖。
test('合成小预算下恢复历史提示近限，预检及直达生成硬限仍可回看并明确新开',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 let rejected=false,warned=false;const text='合成文字'.repeat(250);
 for(let i=0;i<5;i++){
  const input=f.input(text),before=host.requests.length;
  const response=await fetch(host.url+`${path}/replies/prepare`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(input)}),prepared=await response.json();
  assert.equal(host.requests.length,before,'预检始终零HTTP');
  if(response.status===409){
   assert.equal(prepared.input_budget?.state,'exceeded',JSON.stringify(prepared));assert.ok(prepared.input_budget.input_tokens>65536-384);
   const direct=await fetch(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(input)}),failure=await direct.json();
   assert.equal(direct.status,409,JSON.stringify(failure));assert.equal(failure.input_budget?.state,'exceeded');assert.equal(host.requests.length,before,'绕过准备直达生成仍不得出站');
   rejected=true;break;
  }
  assert.equal(response.status,200,JSON.stringify(prepared));const generated=await f.request(host,`${path}/replies`,input);
  if(generated.input_budget?.state==='warning'){assert.equal(generated.input_budget.allowed,true);warned=true;}
  t.diagnostic(JSON.stringify({synthetic_budget_round:i+1,...generated.input_budget}));
 }
 assert.equal(rejected,true,'累积完整运行历史后必须拒绝，不能静默丢弃或用空会话低估');assert.ok(host.requests.length>=2);
 assert.equal(warned,true,'达到硬限之前已有可展示的近限提示');
 assert.ok(host.requests[1].body.messages.some(message=>message.role==='assistant'),'第二轮使用SDK真实历史');
 assert.match(JSON.stringify(await f.request(host,path)),/合成保存候选/);
 const before=host.requests.length,{session_id:next}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{});
 assert.notEqual(next,session);await f.request(host,`/api/contacts/${f.contact}/assistant-sessions/${next}/replies`,f.input('明确新开的短讨论'));
 assert.equal(host.requests.length,before+1);assert.doesNotMatch(JSON.stringify(host.requests.at(-1).body),/合成文字合成文字|合成保存候选/,'显式新段不自动带回超限的旧讨论');
});


test('同一运行不同键重叠请求保持单写者，模型等待期间不持有业务事务',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 const gate=f.holdNext(),first=f.request(host,`${path}/replies`,f.input('合成首个重叠请求'));await gate.entered;
 const idle=(await f.f.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()")).rows[0].n;assert.equal(idle,0,'模型在途不持有长业务事务');
 let handedOff;const sent=new Promise(resolve=>{handedOff=resolve;});
 const second=new Promise((resolve,reject)=>{const req=httpRequest(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact}},res=>{let raw='';res.on('data',part=>{raw+=part;});res.once('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.once('error',reject);req.once('finish',handedOff);req.end(JSON.stringify(f.input('合成第二个重叠请求')));});
 await sent;gate.release();const completed=await first,other=await second;assert.equal(completed.state,'completed');assert.ok([200,409].includes(other.status),JSON.stringify(other));assert.equal(f.maxActive(),1);
 assert.match(JSON.stringify(await f.request(host,path)),/合成保存候选/);
 const before=host.requests.length;await f.request(host,`${path}/replies`,f.input('单写结束后仍可继续'));assert.equal(host.requests.length,before+1);assert.equal(f.maxActive(),1);
});

test('空闲严格超过十二小时才原子新开，准备与旧URL同键重放固定同一真实归属',{timeout:60000},async t=>{
 const f=await fixture(t),clock=join(f.businessHome,'domain-clock');
 await writeFile(clock,'2030-01-01T23:00:00.000000Z');
 const host=await f.start({NOTALONE_SYNTHETIC_ASSISTANT_CLOCK:clock}),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:old}=await f.request(host,base,{}),path=`${base}/${old}`;
 await f.request(host,`${path}/replies`,f.input('合成跨午夜的原段'));
 await writeFile(clock,'2030-01-02T11:00:00.000000Z');
 const boundary=f.input('合成正好十二小时');
 const same=await f.request(host,`${path}/replies/prepare`,boundary);
 assert.equal(same.session_id,old,'正好十二小时仍续用');
 await f.request(host,`${path}/replies`,boundary);
 await writeFile(clock,'2030-01-02T23:00:00.000001Z');
 const before=await f.request(host,base),count=host.requests.length;
 assert.equal(before.sessions.length,1,'只读不触发分段');
 const input=f.input('合成空闲后独立要求');
 const started=await fetch(host.url+path+'/replies/prepare',{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact,Prefer:'respond-async'},body:JSON.stringify(input)});
 assert.equal(started.status,202);const job=await started.json();let prepared;
 for(let i=0;i<100;i++){
  const response=await fetch(host.url+path+'/replies/prepare/status/'+job.preparation_id,{headers:{Authorization:`Bearer ${f.token}`,'x-notalone-manual-contact':f.contact}});
  const body=await response.json();if(response.status===202)continue;assert.equal(response.status,200,JSON.stringify(body));prepared=body;break;
 }
 assert.ok(prepared,'有界等待应取得真实异步准备回执');
 assert.notEqual(prepared.session_id,old,'超过十二小时应在新任务受理前分段');
 assert.equal(prepared.previous_session_id,old);
 assert.equal(host.requests.length,count,'准备不调用供应商');
 const catalog=await f.request(host,base);
 assert.equal(catalog.current_session_id,prepared.session_id);assert.equal(catalog.sessions.length,2);
 const completed=await f.request(host,`${path}/replies`,input);
 assert.equal(completed.session_id,prepared.session_id);
 assert.equal(completed.turn_id,prepared.turn_id);
 assert.deepEqual(await f.request(host,`${path}/replies`,input),completed);
 assert.equal(host.requests.length,count+1);
 assert.equal((await f.request(host,base)).sessions.length,2);
 assert.doesNotMatch(JSON.stringify(host.requests.at(-1).body),/合成跨午夜的原段|合成正好十二小时|合成保存候选/);
 const actual=await f.request(host,`${base}/${prepared.session_id}`);
 assert.ok(actual.turns.some(turn=>turn.turn_id===completed.turn_id));
 assert.ok(!(await f.request(host,path)).turns.some(turn=>turn.turn_id===completed.turn_id));
});

test('旧活动未知时默认新段，明确继续则保留旧身份；被动读取与完成不续期',{timeout:60000},async t=>{
 const f=await fixture(t),clock=join(f.businessHome,'domain-clock');await writeFile(clock,'2030-02-01T00:00:00Z');
 const host=await f.start({NOTALONE_SYNTHETIC_ASSISTANT_CLOCK:clock}),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:legacy}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`${base}/${legacy}`;
 assert.equal((await f.request(host,base)).sessions[0].last_user_activity_at,null);
 const initial=await f.request(host,`${path}/replies`,f.input('合成未知活动默认新开'));
 assert.notEqual(initial.session_id,legacy);
 await f.request(host,`${path}/resume`,{});
 const command=f.input('合成明确继续旧身份'),gate=f.holdNext(),running=f.request(host,`${path}/replies`,command);await gate.entered;
 const before=await f.request(host,base);
 await writeFile(clock,'2030-02-01T13:00:00Z');
 await f.f.client.query('UPDATE assistant_session SET updated_at=clock_timestamp() WHERE id=$1',[legacy]);
 await f.request(host,path);await f.request(host,base);
 assert.deepEqual(await f.request(host,base),before,'只读与通用后台更新不续期或分段');
 const freshInput=f.input('合成旧任务仍在途的新段'),prepared=await f.request(host,`${path}/replies/prepare`,freshInput);
 assert.notEqual(prepared.session_id,legacy);
 gate.release();const oldResult=await running;
 assert.equal(oldResult.session_id,legacy,'旧任务不能迁往新段');
 assert.equal((await f.request(host,base)).current_session_id,prepared.session_id,'旧完成不夺回current');
 assert.equal((await f.request(host,base)).sessions.find(item=>item.session_id===legacy).last_user_activity_at,before.sessions.find(item=>item.session_id===legacy).last_user_activity_at);
 await f.request(host,`${path}/replies`,freshInput);
 assert.equal((await f.request(host,path)).turns.at(-1).request_key,command.idempotency_key);
 assert.equal(host.requests.length,3);
});

test('空闲后并发不同键不双开或覆盖已受理输入，同键重放不续期',{timeout:60000},async t=>{
 const f=await fixture(t),clock=join(f.businessHome,'domain-clock');await writeFile(clock,'2030-03-01T00:00:00Z');
 const host=await f.start({NOTALONE_SYNTHETIC_ASSISTANT_CLOCK:clock}),base=`/api/contacts/${f.contact}/assistant-sessions`,{session_id:old}=await f.request(host,base,{}),path=`${base}/${old}`;
 await writeFile(clock,'2030-03-01T13:00:00Z');
 const a=f.input('合成并发第一键'),b=f.input('合成并发第二键');
 const send=async body=>{const response=await fetch(host.url+`${path}/replies/prepare`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(body)});return {status:response.status,body:await response.json(),input:body};};
 const responses=await Promise.all([send(a),send(b)]),accepted=responses.filter(r=>r.status===200);
 assert.equal(accepted.length,1,'并发点击只能受理一个新任务');
 assert.equal(responses.find(r=>r.status!==200).body.error,'assistant_session_in_progress');
 assert.equal((await f.request(host,base)).sessions.length,2);assert.equal(host.requests.length,0);
 const chosen=accepted[0],before=await f.request(host,base);
 await writeFile(clock,'2030-03-01T14:00:00Z');
 assert.deepEqual(await f.request(host,`${path}/replies/prepare`,chosen.input),chosen.body);
 assert.deepEqual(await f.request(host,base),before,'同键重放不冒充新的主动操作');
 const completed=await f.request(host,`${path}/replies`,chosen.input);
 assert.equal(completed.session_id,chosen.body.session_id);assert.equal(host.requests.length,1);
});

test('用户明确补充探索才刷新被操作段，自动探索与模型完成不续期',{timeout:60000},async t=>{
 const f=await fixture(t),clock=join(f.businessHome,'domain-clock');await writeFile(clock,'2030-04-01T00:00:00Z');
 const host=await f.start({NOTALONE_SYNTHETIC_ASSISTANT_CLOCK:clock}),base=`/api/contacts/${f.contact}/assistant-sessions`,{session_id:session}=await f.request(host,base,{}),path=`${base}/${session}`;
 const source=randomUUID(),message=randomUUID();
 await f.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,f.owner,f.contact,'b'.repeat(64)]);
 await f.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content) VALUES($1,$2,$3,'contact','text','合成近况消息')",[message,f.owner,f.contact]);
 await f.f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,f.owner,f.contact,source]);
 await writeFile(clock,'2030-04-01T01:00:00Z');
 const content={type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'disabled'},first=await f.request(host,`${path}/explorations`,{operation_key:randomUUID(),content});
 const active=await f.request(host,base);
 assert.equal(active.sessions.find(item=>item.session_id===session).last_user_activity_at,'2030-04-01T01:00:00.000Z');
 await writeFile(clock,'2030-04-01T02:00:00Z');
 const second=await f.request(host,`${path}/explorations`,{operation_key:randomUUID(),content,previous_id:first.exploration_id,expected_input_version_id:first.input_version_id,automatic:true});
 assert.deepEqual(await f.request(host,base),active,'automatic不冒充主动补充');
 await writeFile(clock,'2030-04-01T03:00:00Z');
 await f.request(host,`${path}/explorations`,{operation_key:randomUUID(),content:{...content,requirements:'简短一点'},previous_id:second.exploration_id,expected_input_version_id:second.input_version_id});
 assert.equal((await f.request(host,base)).sessions[0].last_user_activity_at,'2030-04-01T03:00:00.000Z');
});

test('空闲后的明确补充要求生成新段，同键继续命令仍可重放原受理',{timeout:60000},async t=>{
 const f=await fixture(t),clock=join(f.businessHome,'domain-clock');await writeFile(clock,'2030-05-01T00:00:00Z');
 const host=await f.start({NOTALONE_SYNTHETIC_ASSISTANT_CLOCK:clock}),base=`/api/contacts/${f.contact}/assistant-sessions`,{session_id:old}=await f.request(host,base,{}),path=`${base}/${old}`;
 f.setCandidateText('合成未选择的旧候选标记');await f.request(host,`${path}/replies`,f.input('合成不应复制的旧轮')) ;
 f.setCandidateText('合成精确选择的旧候选标记');
 const first=await f.request(host,`${path}/replies`,f.input('合成明确继续候选的原输入')),candidate=first.candidates[0];
 const command={idempotency_key:randomUUID(),expected_input_version_id:first.input_version_id,instruction:'第一条，简短一点',displayed_group:{session_id:old,candidate_group_id:first.reply_request_id,candidates:[{number:1,candidate_id:candidate.candidate_id,version_id:candidate.candidate_id}]}};
 await writeFile(clock,'2030-05-01T13:00:00Z');
 const prepared=await f.request(host,`${path}/continue/prepare`,command);
 assert.notEqual(prepared.session_id,old);
 f.setCandidateText('合成本轮新候选');
 const completed=await f.request(host,`${path}/continue`,command);
 assert.equal(completed.session_id,prepared.session_id);assert.equal(completed.turn_id,prepared.turn_id);
 assert.deepEqual(completed.continuation.effective_requirements,['简短一点']);
 assert.deepEqual(await f.request(host,`${path}/continue`,command),completed);
 assert.equal(host.requests.length,3);
 assert.match(JSON.stringify(host.requests.at(-1).body),/合成精确选择的旧候选标记/);
 assert.doesNotMatch(JSON.stringify(host.requests.at(-1).body),/合成未选择的旧候选标记|合成不应复制的旧轮/);
 const count=host.requests.length;
 const forged=await fetch(host.url+`${path}/replies/prepare`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify({...f.input('合成不可伪造引用'),rollover_reference:true})});
 assert.equal(forged.status,400);
 await f.request(host,path,{confirmed:true},'DELETE');
 const rejected=await fetch(host.url+`${base}/${prepared.session_id}/continue`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(command)});
 assert.ok([404,409].includes(rejected.status));assert.equal(host.requests.length,count,'旧候选删除后零出站');
});


test('旧业务讨论仅首次明确继续零HTTP建档，真实重启后保留原候选及编辑版本',{timeout:60000},async t=>{
 const f=await fixture(t),legacy=await f.start({NOTALONE_SYNTHETIC_PERSISTENT:'0',NOTALONE_SYNTHETIC_PUBLIC:'1'}),base=`/api/contacts/${f.contact}/assistant-sessions`;
 const {session_id:session}=await f.request(legacy,base,{}),path=`${base}/${session}`;
 const first=await f.request(legacy,`${path}/replies`,f.input('合成旧记录一次性要求'));
 const versionsPath=`${path}/candidates/${first.candidates[0].candidate_id}/versions`,original=(await f.request(legacy,versionsPath)).versions[0];
 const edited=await f.request(legacy,versionsPath,{edit_key:randomUUID(),parent_version_id:original.version_id,messages:original.messages.map(m=>({...m,text:'合成旧记录编辑版本'}))});
 await legacy.stop();await upgradeLegacyProvenance(f);const host=await f.start(),before=await f.request(host,path);
 const exists=async()=>{try{return (await readdir(join(f.businessHome,'assistant-runtime'),{recursive:true})).filter(p=>p.endsWith('.jsonl'));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 assert.equal((await exists()).length,0,'只读历史不建立档案');
 const gatedInput=f.input('合成当前意图优先：保持随意'),beforeCatalog=await f.request(host,base);
 assert.equal(beforeCatalog.current_session_id,session,'旧段仍是当前段且刚被编辑，不能借空闲分段绕过明确继续');
 for(const action of ['replies/prepare','replies']){
  const response=await fetch(host.url+`${path}/${action}`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(gatedInput)});
  assert.equal(response.status,409);const rejected=await response.json();assert.equal(rejected.error,'assistant_session_rejected');assert.equal(rejected.reason,'resume_required');if(action==='replies/prepare')assert.deepEqual(rejected.no_generation,{contact_id:f.contact,session_id:session,request_key:gatedInput.idempotency_key,state:'not_reserved'});
  assert.equal(host.requests.length,0);assert.equal((await exists()).length,0,'未经resume不自动建立旧讨论档案');
  assert.deepEqual(await f.request(host,path),before,'拒绝前不写新turn或覆盖旧输入');assert.deepEqual(await f.request(host,base),beforeCatalog,'拒绝不刷新活动或切当前');
 }
 const resumed=await f.request(host,`${path}/resume`,{});assert.equal(resumed.session_id,session);assert.equal(host.requests.length,0);
 const bootstrap=(await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0];
 assert.equal((await exists()).length,1,'明确继续按真实业务记录建立官方可恢复档案');
 assert.deepEqual(await f.request(host,path),before,'建档不改旧业务记录');assert.deepEqual(await f.request(host,versionsPath),edited);
 await host.stop();const restarted=await f.start();await f.request(restarted,`${path}/resume`,{});assert.equal(restarted.requests.length,0);
 assert.equal((await f.f.client.query('SELECT runtime_session_id FROM assistant_runtime_session WHERE session_id=$1',[session])).rows[0].runtime_session_id,bootstrap.runtime_session_id,'相同资格跨重启继续时直接复用已建档实例');
 await f.request(restarted,`${path}/replies`,gatedInput);
 const body=JSON.stringify(restarted.requests[0].body);assert.match(body,/合成旧记录一次性要求/);assert.match(body,/合成旧记录编辑版本/);assert.match(body,/合成保存候选/);assert.match(body,/assistant_discussion_reference/);assert.match(body,/is_sent/);
 await f.request(restarted,`${path}/replies`,f.input('合成随后继续'));
 assert.doesNotMatch(JSON.stringify(restarted.requests[1].body.messages.at(-1)),/合成旧记录编辑版本|合成旧记录一次性要求/,'原讨论引用只携入一次，随后复用真实SDK历史');
});


test('修正模型曾见的背景后继续原段，整份新请求排除旧正文并提示变化',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),source=randomUUID(),message=randomUUID();
 await f.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','synthetic.jsonl',$4,1)",[source,f.owner,f.contact,'c'.repeat(64)]);
 await f.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成旧背景唯一标记_04A',now())",[message,f.owner,f.contact]);
 await f.f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic','{}')",[message,f.owner,f.contact,source]);
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 const contextual=text=>({...f.input(text),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:text,include_relationship_context:true}});
 await f.request(host,`${path}/replies`,contextual('合成有当前背景的问候'));
 assert.match(JSON.stringify(host.requests[0].body),/合成旧背景唯一标记_04A/,'测试材料确实曾在实际供应商请求中出现');
 await f.f.client.query("UPDATE message SET text_content='合成修正后背景_04B',speaker='user' WHERE owner_id=$1 AND contact_id=$2 AND id=$3",[f.owner,f.contact,message]);
 const count=host.requests.length,resumed=await f.request(host,`${path}/resume`,{});assert.equal(resumed.session_id,session);assert.equal(host.requests.length,count);assert.equal(resumed.context_refresh?.changed,true);
 await f.request(host,`${path}/replies`,contextual('合成当前意愿保持随意'));
 const body=JSON.stringify(host.requests.at(-1).body);assert.doesNotMatch(body,/合成旧背景唯一标记_04A/);assert.match(body,/合成修正后背景_04B/);assert.match(body,/speaker_role[^a-z]+owner/);
});


test('未重新点击继续时收窄背景范围仍先重建，旧prompt全文不得再次外发',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),source=randomUUID(),message=randomUUID();
 await f.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','synthetic.jsonl',$4,1)",[source,f.owner,f.contact,'d'.repeat(64)]);
 await f.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成范围收窄必须消失_04C',now())",[message,f.owner,f.contact]);
 await f.f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic','{}')",[message,f.owner,f.contact,source]);
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,{...f.input('合成原问候'),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'合成原问候',include_relationship_context:true}});
 assert.match(JSON.stringify(host.requests[0].body),/合成范围收窄必须消失_04C/);
 const input=f.input('合成本轮只改原句');await f.request(host,`${path}/replies/prepare`,input);assert.equal(host.requests.length,1);
 await f.request(host,`${path}/replies`,input);assert.doesNotMatch(JSON.stringify(host.requests[1].body),/合成范围收窄必须消失_04C/);
 assert.match(JSON.stringify(await f.request(host,path)),/合成保存候选/,'业务历史仍保留可回看候选');
});


test('新增合法聊天继续时背景变化可见，保留同一SDK历史并使用最新消息',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 const contextual=text=>({...f.input(text),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:text,include_relationship_context:true}});
 await f.request(host,`${path}/replies`,contextual('合成连续背景前轮'));const files=(await readdir(join(f.businessHome,'assistant-runtime'),{recursive:true})).filter(p=>p.endsWith('.jsonl'));
 const source=randomUUID(),message=randomUUID();await f.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','synthetic-new.jsonl',$4,1)",[source,f.owner,f.contact,'e'.repeat(64)]);
 await f.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成新增合法背景_04D',now())",[message,f.owner,f.contact]);
 await f.f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic','{}')",[message,f.owner,f.contact,source]);
 const resumed=await f.request(host,`${path}/resume`,{});assert.equal(resumed.context_refresh?.changed,true);assert.equal(host.requests.length,1);
 await f.request(host,`${path}/replies`,contextual('合成当前新意图优先'));
 const body=host.requests.at(-1).body;assert.match(JSON.stringify(body),/合成新增合法背景_04D/);assert.ok(body.messages.some(m=>m.role==='assistant'&&JSON.stringify(m).includes('合成保存候选')));
 assert.doesNotMatch(JSON.stringify(body.messages.at(-1)),/assistant_discussion|合成连续背景前轮/);assert.deepEqual((await readdir(join(f.businessHome,'assistant-runtime'),{recursive:true})).filter(p=>p.endsWith('.jsonl')),files);
});


test('停用已读取Skill后继续原段，旧system和read_file工具正文均不再外发',{timeout:60000},async t=>{
 const f=await fixture(t),pkg=join(f.businessHome,'synthetic-skill-04');await mkdir(pkg);await writeFile(join(pkg,'SKILL.md'),'---\nname: synthetic-skill-04\ndescription: 合成回复策略\n---\n\n合成旧Skill正文唯一标记_04E\n');
 const host=await f.start({NOTALONE_SYNTHETIC_SKILL_PACKAGE:pkg}),entry=(await f.f.client.query('SELECT v.id,s.id AS skill_id FROM reply_skill_version v JOIN reply_skill s ON s.id=v.skill_id WHERE s.owner_id=$1',[f.owner])).rows[0];
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 f.setUseSkill(true);f.setNextTool(body=>{const file=JSON.stringify(body).match(/\/notalone\/reply-skills\/[^"\\ ]+\/SKILL\.md/)?.[0];assert.ok(file);return {name:'read_file',args:{file_path:file}};});
 await f.request(host,`${path}/replies`,{...f.input('合成Skill本轮原句'),skill_disabled:false,skill_version_id:entry.id});
 assert.equal(host.requests.length,2);assert.ok(host.requests[1].body.messages.some(m=>JSON.stringify(m).includes('tool_result')&&JSON.stringify(m).includes('合成旧Skill正文唯一标记_04E')),'真实工具结果确实曾进入供应商请求');
 await f.request(host,`/api/skills/${entry.skill_id}/disable`,{});const count=host.requests.length,resumed=await f.request(host,`${path}/resume`,{});assert.equal(resumed.context_refresh?.changed,true);assert.equal(host.requests.length,count);
 f.setUseSkill(false);await f.request(host,`${path}/replies`,f.input('合成新原句不使用旧Skill'));
 assert.doesNotMatch(JSON.stringify(host.requests.at(-1).body),/合成旧Skill正文唯一标记_04E/);assert.match(JSON.stringify(await f.request(host,path)),/合成保存候选/);
});

test('旧历史独有背景在模型等待中被修正后逐阶段复验，迟到输出不保存也不再出站',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),source=randomUUID(),old=randomUUID(),freshSource=randomUUID();
 await f.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','synthetic-old.jsonl',$4,1),($5,$2,$3,'manual','synthetic-recent.jsonl',$6,55)",[source,f.owner,f.contact,'a'.repeat(64),freshSource,'b'.repeat(64)]);
 await f.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成旧历史独有背景_04F',now()-interval '1 day')",[old,f.owner,f.contact]);
 await f.f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic-old','{}')",[old,f.owner,f.contact,source]);
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 const contextual=text=>({...f.input(text),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:text,include_relationship_context:true}});
 await f.request(host,`${path}/replies`,contextual('合成前轮问候'));assert.match(JSON.stringify(host.requests[0].body),/合成旧历史独有背景_04F/);
 const added=(await f.f.client.query("INSERT INTO message(owner_id,contact_id,speaker,message_type,text_content,occurred_at) SELECT $1,$2,'contact','text','合成近期合法消息'||i,now()+i*interval '1 microsecond' FROM generate_series(1,55) i RETURNING id",[f.owner,f.contact])).rows.map(r=>r.id);
 await f.f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) SELECT id,$1,$2,'source_document',$3,id::text,'{}'::jsonb FROM unnest($4::uuid[]) id",[f.owner,f.contact,freshSource,added]);
 f.setCandidateText('合成迟到不得保存_04G');const gate=f.holdNext(),input=contextual('合成本轮只参考近期背景');
 const running=fetch(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(input)});
 await gate.entered;assert.doesNotMatch(JSON.stringify(host.requests.at(-1).body.messages.at(-1)),/合成旧历史独有背景_04F/,'本轮当前背景已不含旧消息，资格复验仍须覆盖SDK旧历史');
 await f.f.client.query("UPDATE message SET text_content='合成旧背景已修正_04H' WHERE owner_id=$1 AND contact_id=$2 AND id=$3",[f.owner,f.contact,old]);gate.release();
 const response=await running;assert.equal(response.status,409,JSON.stringify(await response.json()));assert.equal(host.requests.length,2,'来源改变后不得继续下一次物理出站');assert.doesNotMatch(JSON.stringify(await f.request(host,path)),/合成迟到不得保存_04G/);
});

test('无历史新段首次先准备再生成无需继续，零HTTP准备不自动建档',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`,input=f.input('合成新段首次请求');
 await f.request(host,`${path}/replies/prepare`,input);assert.equal(host.requests.length,0);
 const files=await readdir(join(f.businessHome,'assistant-runtime'),{recursive:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});assert.equal(files.filter(p=>p.endsWith('.jsonl')).length,0);
 assert.equal((await f.request(host,`${path}/replies`,input)).session_id,session);assert.equal(host.requests.length,1);
});

test('升级后新段方向输入跨重启首次生成不被误判为旧讨论',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/inputs`,{content:{type:'purpose_exploration',purpose_hint:'合成本轮新段方向'}});await host.stop();
 const restarted=await f.start(),input=f.input('合成新段首次表达');await f.request(restarted,`${path}/replies/prepare`,input);assert.equal(restarted.requests.length,0);
 assert.equal((await f.request(restarted,`${path}/replies`,input)).session_id,session);assert.equal(restarted.requests.length,1);assert.ok(JSON.stringify(restarted.requests[0].body).includes('合成本轮新段方向'));
});


test('升级前无历史空壳在升级后写新方向并生成，无需先继续',{timeout:60000},async t=>{
 const f=await fixture(t),legacy=await f.start({NOTALONE_SYNTHETIC_PERSISTENT:'0',NOTALONE_SYNTHETIC_PUBLIC:'1'}),{session_id:session}=await f.request(legacy,`/api/contacts/${f.contact}/assistant-sessions`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await legacy.stop();await upgradeLegacyProvenance(f);const host=await f.start();
 await f.request(host,`${path}/inputs`,{content:{type:'purpose_exploration',purpose_hint:'合成升级后空壳新方向'}});
 const input=f.input('合成空壳首次表达');await f.request(host,`${path}/replies/prepare`,input);assert.equal(host.requests.length,0);
 assert.equal((await f.request(host,`${path}/replies`,input)).session_id,session);assert.equal(host.requests.length,1);
});
