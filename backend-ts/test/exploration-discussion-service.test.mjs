import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fixture} from './exploration-public-support.mjs';
import {useTool,sendEvents} from './exploration-runtime-support.mjs';
const require=createRequire(new URL('../../desktop/package.json',import.meta.url));
const {build}=require('esbuild');
const bundled=await build({entryPoints:[new URL('../../desktop/src/main/reply/exploration-client.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const desktop=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text+'\n//# sourceURL=notalone-exploration-client.mjs\n').toString('base64')}`);
function backend(x){return {requestJson:async({path,method,body,signal})=>{const r=await fetch(x.publicHost.url+path,{method,signal,headers:{Authorization:`Bearer ${x.publicHost.token}`,'Content-Type':'application/json',[x.publicHost.manual_header]:x.contact},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error),{status:r.status,code:data.error});return {data,generation:1};}};}
const input=x=>({contactId:x.contact,sessionId:x.session,operationKey:randomUUID(),expectedInputVersionId:null,previousId:null,scene:'initiate_conversation',targetMessageId:null,purposeHint:'',correction:'',requirements:'',skill:{mode:'disabled',versionId:null},changeGroup:false});
function output(id,question=null,intents=['了解近况','稍后联系']){return {understanding:'基于当前原话的合成理解',ambiguities:[],citation_ids:[id],options:intents.map((intent,i)=>({intent,label:'方向'+i,reason:'当前合成原话与用户选择',citation_ids:[id],recommended:i===0,pause:false})),question,current_step:'明确本次意愿',tradeoffs:[]};}
test('桌面正式适配器经公开HTTP澄清；回答不确认，明确选择后原A准备与C仅生成一次',{timeout:60000},async t=>{
 let phases=0;
 const x=await fixture(t,{importSkill:false,onRequest:async({requests,payload,events,res})=>{
  const id=payload.evidence[0].evidence_id;
  if(requests.at(-1).body.tools.some(v=>v.name==='ReplyRuntimeOutput')){useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'最近怎么样？',basis:'仅按本次明确选择了解近况',citation_ids:[id],risk_notes:[]}]});}
  else{phases++;useTool(events,'ExplorationOutput',output(id,phases===1?{text:'本次是否承诺新的安排？',impact:'commitment'}:null));}
  sendEvents(res,events);return true;
 }});
 const b=backend(x),signal=new AbortController().signal;
 const first=await desktop.openExploration(b,input(x),signal);assert.equal(first.kind,'exploration');assert.ok(first.result.question);assert.equal(first.result.confirmedIntent,null);assert.equal(x.host.requests.length,1);
 const answered=await desktop.actOnExploration(b,{contactId:x.contact,sessionId:x.session,taskId:first.result.taskId,inputVersion:first.result.inputVersion,action:'answer',questionId:first.result.question.questionId,answer:'只了解近况，不承诺安排。',operationKey:randomUUID(),generate:true},signal);
 assert.equal(answered.kind,'exploration');assert.equal(answered.result.confirmedIntent,null);assert.equal(answered.result.question,null);assert.equal(x.host.requests.length,2);assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM assistant_session_turn')).rows[0].n,0);
 const action={contactId:x.contact,sessionId:x.session,taskId:answered.result.taskId,inputVersion:answered.result.inputVersion,action:'confirm',suggestionId:answered.result.directions[0].suggestionId,generate:true};
 const prepared=await desktop.prepareExplorationAction(b,action,signal);assert.equal(prepared.kind,'prepared');assert.equal(x.host.requests.length,2);
 const generated=await desktop.actOnExploration(b,action,signal,prepared.receipt);assert.equal(generated.kind,'generated');assert.equal(generated.confirmedIntent,'了解近况');assert.equal(x.host.requests.length,3);
 assert.deepEqual(await desktop.actOnExploration(b,action,signal,prepared.receipt),generated);assert.equal(x.host.requests.length,3);assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n,1);
});
test('已选意愿经原问题回答续接A准备，保留原选择并重放唯一C候选',{timeout:60000},async t=>{
 let phases=0;
 const x=await fixture(t,{importSkill:false,onRequest:async({requests,payload,events,res})=>{
  const id=payload.evidence[0].evidence_id;
  if(requests.at(-1).body.tools.some(v=>v.name==='ReplyRuntimeOutput'))useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'最近怎么样？',basis:'只了解近况，不增加安排承诺',citation_ids:[id],risk_notes:[]}]});
  else useTool(events,'ExplorationOutput',output(id,++phases===1?{text:'是否愿意作出安排承诺？',impact:'commitment'}:null));
  sendEvents(res,events);return true;
 }});
 const b=backend(x),signal=new AbortController().signal,first=await desktop.openExploration(b,input(x),signal);
 const selected=await desktop.actOnExploration(b,{contactId:x.contact,sessionId:x.session,taskId:first.result.taskId,inputVersion:first.result.inputVersion,action:'confirm',suggestionId:first.result.directions[0].suggestionId,generate:true},signal);
 assert.equal(selected.kind,'exploration');assert.equal(selected.result.confirmedIntent,'了解近况');assert.ok(selected.result.question);assert.equal(x.host.requests.length,1);
 const answer={contactId:x.contact,sessionId:x.session,taskId:first.result.taskId,inputVersion:first.result.inputVersion,action:'answer',questionId:first.result.question.questionId,answer:'不作出安排承诺。',operationKey:randomUUID(),generate:true};
 const prepared=await desktop.prepareExplorationAction(b,answer,signal);assert.equal(prepared.kind,'prepared');assert.equal(x.host.requests.length,2);
 const payload=JSON.parse(x.host.requests[1].body.messages[0].content[0].text);assert.equal(payload.confirmed_intent,'了解近况');assert.equal(payload.answer,answer.answer);
 const result=await desktop.actOnExploration(b,answer,signal,prepared.receipt);assert.equal(result.kind,'generated');assert.equal(result.confirmedIntent,'了解近况');assert.equal(x.host.requests.length,3);
 assert.deepEqual(await desktop.actOnExploration(b,answer,signal,prepared.receipt),result);assert.equal(x.host.requests.length,3);
 const rejected={...answer,answer:'改成另一个回答'};await assert.rejects(desktop.actOnExploration(b,rejected,signal,prepared.receipt),{status:409});assert.equal(x.host.requests.length,3);
});
test('换组拒绝重复方向；同一失败操作可有界重试且不刷新原根时效或重选Skill',{timeout:60000},async t=>{
 let phases=0;
 const x=await fixture(t,{importSkill:false,onRequest:async({payload,events,res})=>{
  useTool(events,'ExplorationOutput',output(payload.evidence[0].evidence_id,null,++phases<3?['了解近况','稍后联系']:['表达感谢','暂不回应']));sendEvents(res,events);return true;
 }});
 const b=backend(x),signal=new AbortController().signal,firstInput=input(x),first=await desktop.openExploration(b,firstInput,signal);
 await x.f.client.query("UPDATE reply_exploration SET root_created_at=clock_timestamp()-interval '4 minutes'+interval '0.123456 seconds' WHERE id=$1",[first.result.taskId]);
 const root=(await x.f.client.query('SELECT root_created_at::text AS root FROM reply_exploration WHERE id=$1',[first.result.taskId])).rows[0].root;
 const next={...firstInput,operationKey:randomUUID(),expectedInputVersionId:first.result.inputVersion,previousId:first.result.taskId,changeGroup:true};
 await assert.rejects(desktop.openExploration(b,next,signal),{status:409});assert.equal(x.host.requests.length,2);
 const failed=(await x.f.client.query("SELECT id,input_version_id,request_key,root_created_at::text AS root FROM reply_exploration WHERE operation_key=$1",[next.operationKey])).rows[0];assert.equal(failed.root,root);
 const changed=await desktop.openExploration(b,next,signal);assert.equal(changed.result.taskId,failed.id);assert.equal(changed.result.inputVersion,failed.input_version_id);assert.deepEqual(changed.result.directions.map(x=>x.direction),['表达感谢','暂不回应']);assert.equal(changed.result.confirmedIntent,null);assert.equal(x.host.requests.length,3);
 assert.deepEqual(JSON.parse(x.host.requests[2].body.messages[0].content[0].text).previous_intents,['了解近况','稍后联系']);
 assert.deepEqual(await desktop.openExploration(b,next,signal),changed);assert.equal(x.host.requests.length,3);
 const current=(await x.f.client.query('SELECT request_key,root_created_at::text AS root,skill_version_id,input_payload FROM reply_exploration WHERE id=$1',[failed.id])).rows[0];assert.equal(current.request_key,failed.request_key);assert.equal(current.root,root);assert.equal(current.skill_version_id,null);assert.equal(current.input_payload.skill_selection_complete,true);
 const receipts=(await x.f.client.query('SELECT request_id,count(*)::int AS calls FROM model_call_receipt GROUP BY request_id')).rows;assert.equal(receipts.find(r=>r.request_id===failed.id).calls,2);
});
test('公开在途停止保留原暂停状态；晚模型结果不提交且SDK退出后才释放共享许可',{timeout:60000},async t=>{
 let entered,release;const began=new Promise(r=>entered=r),released=new Promise(r=>release=r);
 const x=await fixture(t,{importSkill:false,onRequest:async({payload,events,res})=>{
  entered();await released;useTool(events,'ExplorationOutput',output(payload.evidence[0].evidence_id));sendEvents(res,events);return true;
 }});
 const b=backend(x),signal=new AbortController().signal,command=input(x),inflight=desktop.openExploration(b,command,signal);
 // 立即接住后续拒绝，测试先完成停止握手再检查原响应。
 const observed=inflight.then(value=>({value}),error=>({error}));await began;
 const task=(await x.f.client.query('SELECT id,input_version_id FROM reply_exploration WHERE operation_key=$1',[command.operationKey])).rows[0];assert.ok(task);assert.equal((await x.host.request('/health')).foregroundActive,true);
 const stopped=await desktop.actOnExploration(b,{contactId:x.contact,sessionId:x.session,taskId:task.id,inputVersion:task.input_version_id,action:'stop'},signal);assert.equal(stopped.kind,'paused');assert.equal((await x.host.request('/health')).foregroundActive,true);
 const row=(await x.f.client.query('SELECT state,result_payload FROM reply_exploration WHERE id=$1',[task.id])).rows[0];assert.equal(row.state,'paused');assert.equal(row.result_payload,null);
 release();const settled=await observed;assert.equal(settled.error?.status,409);assert.equal((await x.host.request('/health')).foregroundActive,false);assert.equal(x.host.requests.length,1);
 assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n,0);assert.equal((await x.f.client.query('SELECT state FROM reply_exploration WHERE id=$1',[task.id])).rows[0].state,'paused');
 await assert.rejects(desktop.openExploration(b,command,signal),{status:409});assert.equal(x.host.requests.length,1);
 const next=await desktop.openExploration(b,{...command,operationKey:randomUUID(),expectedInputVersionId:task.input_version_id},signal);assert.equal(next.kind,'exploration');assert.equal(next.result.confirmedIntent,null);assert.notEqual(next.result.taskId,task.id);assert.equal(x.host.requests.length,2);
});
test('并发切换联系人保留各自输入与Skill；旧任务身份不能给另一联系人确认',{timeout:60000},async t=>{
 const seen=[];let entered,release;const began=new Promise(r=>entered=r),released=new Promise(r=>release=r);
 const x=await fixture(t,{onRequest:async({payload,events,res})=>{seen.push(payload);if(seen.length===1){entered();await released;}useTool(events,'ExplorationOutput',output(payload.evidence[0].evidence_id));sendEvents(res,events);return true;}});
 const other=randomUUID(),session=randomUUID(),message=randomUUID(),source=randomUUID();
 await x.f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'另一合成联系人')",[other,x.owner]);await x.f.client.query('INSERT INTO manual_contact_confirmation(owner_id,contact_id)VALUES($1,$2)',[x.owner,other]);await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,other]);
 await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','另一合成来源',$4,1)",[source,x.owner,other,'b'.repeat(64)]);
 await x.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content)VALUES($1,$2,$3,'contact','text','另一联系人独立原话')",[message,x.owner,other]);await x.f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,x.owner,other,source]);
 const b={requestJson:async({path,method,body,signal})=>{const cid=path.match(/\/contacts\/([^/]+)/)[1],r=await fetch(x.publicHost.url+path,{method,signal,headers:{Authorization:`Bearer ${x.publicHost.token}`,'Content-Type':'application/json',[x.publicHost.manual_header]:cid},...(body?{body:JSON.stringify(body)}:{})}),data=await r.json();if(!r.ok)throw Object.assign(Error(data.error),{status:r.status});return {data,generation:1};}};
 const signal=new AbortController().signal,firstInput={...input(x),skill:{mode:'user',versionId:x.version}},first=desktop.openExploration(b,firstInput,signal);await began;
 const second=desktop.openExploration(b,{...input(x),contactId:other,sessionId:session,purposeHint:'另一联系人的本次目的'},signal);release();const [a,c]=await Promise.all([first,second]);
 assert.notEqual(a.result.taskId,c.result.taskId);assert.equal(a.result.usedSkill.versionId,x.version);assert.equal(c.result.usedSkill,null);assert.equal(a.result.evidence[0].evidenceId,x.message);assert.equal(c.result.evidence[0].evidenceId,message);assert.equal(x.host.requests.length,2);
 assert.equal(seen[0].skill.version_id,x.version);assert.equal(seen[1].skill,null);assert.equal(seen[1].purpose_hint,'另一联系人的本次目的');assert.equal(seen[1].evidence.some(e=>e.evidence_id===x.message),false);
 await assert.rejects(desktop.actOnExploration(b,{contactId:other,sessionId:session,taskId:a.result.taskId,inputVersion:a.result.inputVersion,action:'confirm',suggestionId:a.result.directions[0].suggestionId,generate:true},signal),{status:409});assert.equal(x.host.requests.length,2);
 const rows=(await x.f.client.query('SELECT contact_id,session_id,skill_version_id,source_ids FROM reply_exploration ORDER BY created_at')).rows;assert.equal(rows.length,2);assert.equal(rows[0].contact_id,x.contact);assert.equal(rows[0].session_id,x.session);assert.equal(rows[0].skill_version_id,x.version);assert.equal(rows[1].contact_id,other);assert.equal(rows[1].session_id,session);assert.equal(rows[1].source_ids.includes(x.message),false);assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n,0);
});
test('回应探索固定原目标，用户直填意愿经桌面适配器进入唯一C候选',{timeout:60000},async t=>{
 const intent='明确说明现在没空，稍后再联系';const x=await fixture(t,{importSkill:false,onRequest:async({requests,payload,events,res})=>{
  const id=payload.evidence[0].evidence_id;
  if(requests.at(-1).body.tools.some(v=>v.name==='ReplyRuntimeOutput')){assert.equal(payload.input_mode,'reply_to_message');assert.equal(payload.confirmed_direction,intent);assert.equal(payload.direction_source,'direct_input');useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'我现在有点忙，晚点再联系你。',basis:'仅表达本次用户直填意愿',citation_ids:[id],risk_notes:[]}]});}
  else{assert.equal(payload.scene,'reply_to_message');assert.equal(payload.target_message_id,id);useTool(events,'ExplorationOutput',output(id));}
  sendEvents(res,events);return true;
 }});
 const b=backend(x),signal=new AbortController().signal,first=await desktop.openExploration(b,{...input(x),scene:'reply_to_message',targetMessageId:x.message},signal);
 assert.equal(first.result.confirmedIntent,null);const action={contactId:x.contact,sessionId:x.session,taskId:first.result.taskId,inputVersion:first.result.inputVersion,action:'confirm',directIntent:intent,generate:true};
 const prepared=await desktop.prepareExplorationAction(b,action,signal);assert.equal(prepared.kind,'prepared');const result=await desktop.actOnExploration(b,action,signal,prepared.receipt);assert.equal(result.kind,'generated');assert.equal(result.confirmedIntent,intent);assert.equal(x.host.requests.length,2);
 assert.deepEqual(await desktop.actOnExploration(b,action,signal,prepared.receipt),result);assert.equal(x.host.requests.length,2);
 const row=(await x.f.client.query('SELECT selected_intent,selection_source FROM reply_exploration WHERE id=$1',[first.result.taskId])).rows[0];assert.deepEqual(row,{selected_intent:intent,selection_source:'direct_input'});
});
