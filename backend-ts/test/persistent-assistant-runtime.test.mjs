/** 公开产品 Host、隔离 PG 和官方存档真实运行，仅模型网络为合成供应商。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';

async function fixture(t){
 let candidateText='合成保存候选',gate=null,active=0,maxActive=0;
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token=randomUUID()+randomUUID();
 const businessHome=await mkdtemp(join(tmpdir(),'notalone-persistent-assistant-'));
 t.after(async()=>{await f.close();await rm(businessHome,{recursive:true,force:true});});
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成持久用户')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成持久联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 const start=(environment={})=>startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:async()=>{}},(_req,res,requests,events)=>{
   active++;maxActive=Math.max(maxActive,active);res.once('finish',()=>{active--;});
   const body=requests.at(-1).body,last=body.messages.at(-1),raw=JSON.stringify(last),citation=[...raw.matchAll(/(?:evidence_id\\?"\s*:\s*\\?")(c\d+)/g)].at(-1)?.[1]??'c1';
   useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:candidateText,basis:'本轮明确原句',citation_ids:[citation],risk_notes:[]}]});if(gate){const current=gate;gate=null;current.enter();current.wait.then(()=>sendEvents(res,events));return;}sendEvents(res,events);
 },{pluginPath:'test/host-reply-runtime-plugin.ts',environment:{NOTALONE_SYNTHETIC_PERSISTENT:'1',NOTALONE_SYNTHETIC_BUSINESS_HOME:businessHome,...environment}});
 const request=async(host,path,body,method=body===undefined?'GET':'POST')=>{
  const response=await fetch(host.url+path,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json','x-notalone-manual-contact':contact},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
 };
 return {f,owner,contact,binding,token,businessHome,start,request,maxActive:()=>maxActive,setCandidateText:text=>{candidateText=text;},holdNext:()=>{let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);gate={enter,wait};return {entered,release};},input:text=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:text,include_relationship_context:false},skill_disabled:true})};
}

test('目录与历史浏览保持当前和真实活动，明确继续原段才刷新活动且零模型',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),base=`/api/contacts/${f.contact}/assistant-sessions`;
 assert.deepEqual(await f.request(host,base),{sessions:[],current_session_id:null});
 const {session_id:old}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),oldPath=`${base}/${old}`;
 assert.equal((await f.request(host,base)).sessions[0].last_user_activity_at,null,'未知活动不从创建或通用更新时间伪造');
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
 const {session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`${base}/${session}`;
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


test('公开同键并发只写一轮，其他联系人不能读取或恢复其运行历史',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 const command=f.input('合成并发原句'),gate=f.holdNext(),running=f.request(host,`${path}/replies`,command);await gate.entered;
 const response=await fetch(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(command)});
 assert.equal(response.status,409);assert.equal(host.requests.length,1);gate.release();const completed=await running;
 assert.deepEqual(await f.request(host,`${path}/replies`,command),completed);assert.equal(host.requests.length,1);
 const other=randomUUID();await f.f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成隔离联系人')",[other,f.owner]);
 await f.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[randomUUID(),f.owner,other]);
 const wrong=await fetch(host.url+path.replace(f.contact,other),{headers:{Authorization:`Bearer ${f.token}`,'x-notalone-manual-contact':other}});assert.equal(wrong.status,404);assert.equal(host.requests.length,1);
});

test('运行配置不符时零出站，业务候选仍可查看',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成配置原句'));await host.stop();
 const changed=await f.start({NOTALONE_SYNTHETIC_REPLY_TEMPERATURE:'0.1'});
 const history=await f.request(changed,path);assert.match(JSON.stringify(history),/合成保存候选/);
 const response=await fetch(changed.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(f.input('配置变化后需核验'))});
 assert.equal(response.status,409);assert.equal(changed.requests.length,0);
});

test('模型日志已写而业务保存失败，未提交候选不会成为历史或下一轮运行上下文',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
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
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 await f.request(host,`${path}/replies`,f.input('合成归属原句'));await host.stop();
 await writeFile(join(f.businessHome,'assistant-runtime',f.owner,f.contact,session,'ownership.json'),JSON.stringify({version:1,owner_id:randomUUID(),contact_id:f.contact,session_id:session}));
 const restarted=await f.start();assert.match(JSON.stringify(await f.request(restarted,path)),/合成保存候选/);
 const response=await fetch(restarted.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(f.input('不允许错误恢复'))});
 assert.equal(response.status,409);assert.equal(restarted.requests.length,0);
});

test('恢复的真实模型历史计入零HTTP预检与出站硬上限，历史仍可回看',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 let rejected=false;const text='合成文字'.repeat(250);
 for(let i=0;i<5;i++){
  const input=f.input(text),before=host.requests.length;
  const response=await fetch(host.url+`${path}/replies/prepare`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact},body:JSON.stringify(input)}),prepared=await response.json();
  assert.equal(host.requests.length,before,'预检始终零HTTP');
  if(response.status===409){assert.equal(prepared.input_budget?.state,'exceeded',JSON.stringify(prepared));assert.ok(prepared.input_budget.input_tokens>65536-384);rejected=true;break;}
  assert.equal(response.status,200,JSON.stringify(prepared));await f.request(host,`${path}/replies`,input);
 }
 assert.equal(rejected,true,'累积完整运行历史后必须拒绝，不能静默丢弃或用空会话低估');assert.ok(host.requests.length>=2);
 assert.ok(host.requests[1].body.messages.some(message=>message.role==='assistant'),'第二轮使用SDK真实历史');
 assert.match(JSON.stringify(await f.request(host,path)),/合成保存候选/);
});


test('同一运行不同键重叠请求保持单写者，模型等待期间不持有业务事务',{timeout:60000},async t=>{
 const f=await fixture(t),host=await f.start(),{session_id:session}=await f.request(host,`/api/contacts/${f.contact}/assistant-session/default`,{}),path=`/api/contacts/${f.contact}/assistant-sessions/${session}`;
 const gate=f.holdNext(),first=f.request(host,`${path}/replies`,f.input('合成首个重叠请求'));await gate.entered;
 const idle=(await f.f.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()")).rows[0].n;assert.equal(idle,0,'模型在途不持有长业务事务');
 let handedOff;const sent=new Promise(resolve=>{handedOff=resolve;});
 const second=new Promise((resolve,reject)=>{const req=httpRequest(host.url+`${path}/replies`,{method:'POST',headers:{Authorization:`Bearer ${f.token}`,'content-type':'application/json','x-notalone-manual-contact':f.contact}},res=>{let raw='';res.on('data',part=>{raw+=part;});res.once('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.once('error',reject);req.once('finish',handedOff);req.end(JSON.stringify(f.input('合成第二个重叠请求')));});
 await sent;gate.release();const completed=await first,other=await second;assert.equal(completed.state,'completed');assert.ok([200,409].includes(other.status),JSON.stringify(other));assert.equal(f.maxActive(),1);
 assert.match(JSON.stringify(await f.request(host,path)),/合成保存候选/);
 const before=host.requests.length;await f.request(host,`${path}/replies`,f.input('单写结束后仍可继续'));assert.equal(host.requests.length,before+1);assert.equal(f.maxActive(),1);
});
