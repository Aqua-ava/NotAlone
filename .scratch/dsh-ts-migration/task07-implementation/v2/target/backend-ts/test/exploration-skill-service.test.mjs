import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './exploration-public-support.mjs';
import {useTool,sendEvents} from './exploration-runtime-support.mjs';

test('公开auto探索真实导入Skill版本，分别一次选择和探索并返回真实引用',{timeout:60000},async t=>{
 const x=await fixture(t);
 const request={operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'auto'}};
 const response=await x.send('open',request);assert.equal(response.status,200,JSON.stringify(response.body));const result=response.body;
 assert.equal(result.confirmed_intent,null);assert.equal(result.skill_version_id,x.version,JSON.stringify({result,requests:x.host.requests.map(r=>r.body.tools.map(t=>t.name)),catalog:(await x.f.client.query('SELECT status,enabled,is_current,directory_available,content_path FROM reply_skill_version')).rows}));assert.equal(result.used_skill.version_number,1);assert.equal(result.used_skill.name,'exploration-purpose');assert.equal(result.used_skill.selection_method,'auto');
 assert.equal(result.evidence[0].evidence_id,x.message);assert.deepEqual(result.options[0].citation_ids,[x.message]);assert.equal(x.host.requests.length,2);
 assert.deepEqual(x.host.requests.map(r=>r.body.tools.map(t=>t.name)),[['ExplorationSkillSelection'],['ExplorationOutput']]);
 const second=JSON.parse(x.host.requests[1].body.messages[0].content[0].text);assert.equal(second.skill.version_id,x.version);assert.match(second.skill.content,/EXPLORATION_STATIC_BODY/);assert.doesNotMatch(JSON.stringify(x.host.requests),/EXPLORATION_RESOURCE_FORBIDDEN/);
 const receipts=(await x.f.client.query('SELECT request_id,outcome,cost_amount FROM model_call_receipt WHERE owner_id=$1 ORDER BY called_at',[x.owner])).rows;
 assert.equal(receipts.length,2);assert.ok(receipts.every(row=>row.request_id===result.exploration_id&&row.outcome==='succeeded'&&row.cost_amount===null));
 assert.deepEqual((await x.send('open',request)).body,result);assert.equal(x.host.requests.length,2);
});
for(const mode of ['user','disabled','empty'])test(`公开${mode}探索只发一次，保留真实策略资格与当前引用`,{timeout:60000},async t=>{
 const x=await fixture(t,{importSkill:mode!=='empty'});
 const response=await x.send('open',{operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:mode==='empty'?'auto':mode,...(mode==='user'?{skill_version_id:x.version}:{})}});
 assert.equal(response.status,200,JSON.stringify(response.body));const result=response.body;
 assert.equal(x.host.requests.length,1);assert.deepEqual(x.host.requests[0].body.tools.map(t=>t.name),['ExplorationOutput']);assert.equal(result.confirmed_intent,null);assert.deepEqual(result.options[0].citation_ids,[x.message]);
 const payload=JSON.parse(x.host.requests[0].body.messages[0].content[0].text);
 if(mode==='user'){assert.equal(result.skill_version_id,x.version);assert.equal(result.used_skill.version_number,1);assert.equal(result.used_skill.name,'exploration-purpose');assert.equal(result.used_skill.selection_method,'user');assert.equal(payload.skill.version_id,x.version);assert.match(payload.skill.content,/EXPLORATION_STATIC_BODY/);}
 else{assert.equal(result.skill_version_id,null);assert.equal(result.used_skill,null);assert.equal(payload.skill,null);assert.equal(result.skill_choices.length,mode==='empty'?0:1);}
 assert.doesNotMatch(JSON.stringify(x.host.requests),/EXPLORATION_RESOURCE_FORBIDDEN/);
 const receipts=(await x.f.client.query('SELECT request_id,outcome FROM model_call_receipt WHERE owner_id=$1',[x.owner])).rows;assert.deepEqual(receipts,[{request_id:result.exploration_id,outcome:'succeeded'}]);
});

test('真实目录revision在选择响应前撤销，拒绝晚选择且不发送探索正文',{timeout:60000},async t=>{
 let changed=false;
 const x=await fixture(t,{onRequest:async({library,imported,payload})=>{
  if(payload.input_mode==='exploration_skill_selection'){await library.handle('POST',new URL(`http://local/api/skills/${imported.skill_id}/disable`));changed=true;}return false;
 }});
 const response=await x.send('open',{operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'auto'}});
 assert.equal(changed,true);assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(x.host.requests.length,1);assert.deepEqual(x.host.requests[0].body.tools.map(t=>t.name),['ExplorationSkillSelection']);
 const task=(await x.f.client.query('SELECT state,result_payload FROM reply_exploration WHERE owner_id=$1',[x.owner])).rows[0];assert.equal(task.state,'stale');assert.equal(task.result_payload,null);
});

test('在途来源撤销拒绝晚探索结果，实际异CID访问不新增模型调用',{timeout:60000},async t=>{
 let removed=false;
 const x=await fixture(t,{onRequest:async({f,payload})=>{
  if(payload.input_mode==='direction_exploration'){await f.client.query('DELETE FROM message_source_ref');removed=true;}return false;
 }});
 const response=await x.send('open',{operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'user',skill_version_id:x.version}});
 assert.equal(removed,true);assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(x.host.requests.length,1);
 const task=(await x.f.client.query('SELECT id,state,result_payload,input_payload,snapshots,intent_snapshots FROM reply_exploration WHERE owner_id=$1',[x.owner])).rows[0];assert.equal(task.state,'redacted');assert.equal(task.result_payload,null);assert.equal(task.input_payload,null);assert.deepEqual(task.snapshots,[]);assert.deepEqual(task.intent_snapshots,[]);
 const other=randomUUID();await x.f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'另一合成联系人')",[other,x.owner]);await x.f.client.query('INSERT INTO manual_contact_confirmation(owner_id,contact_id)VALUES($1,$2)',[x.owner,other]);
 assert.equal((await x.send('read',{exploration_id:task.id},{contact_id:other})).status,409);assert.equal(x.host.requests.length,1);
});

test('auto明确NoSkill经公开确认与原A到C仍固定不用目录中的策略',{timeout:60000},async t=>{
 const x=await fixture(t,{onRequest:async({requests,events,res,payload})=>{
  const names=requests.at(-1).body.tools.map(t=>t.name);
  if(names.includes('ExplorationSkillSelection')){useTool(events,'ExplorationSkillSelection',{version_id:null});sendEvents(res,events);return true;}
  if(names.includes('ReplyRuntimeOutput')){assert.equal(names.includes('read_file'),false);useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'最近还好吗？',basis:'用户确认本次了解近况，引用对方当前原话',citation_ids:[payload.evidence[0].evidence_id],risk_notes:[]}]});sendEvents(res,events);return true;}
  return false;
 }});
 const response=await x.send('open',{operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'auto'}});assert.equal(response.status,200,JSON.stringify(response.body));const result=response.body;
 assert.equal(result.skill_version_id,null);assert.equal(result.used_skill,null);assert.equal(result.skill_choices.length,1);assert.equal(result.confirmed_intent,null);assert.equal(x.host.requests.length,2);
 const command={exploration_id:result.exploration_id,input_version_id:result.input_version_id,suggestion_id:result.options[0].suggestion_id,generate:true};
 const prepared=await x.send('prepare-confirm',command);assert.equal(prepared.status,200,JSON.stringify(prepared.body));assert.equal(prepared.body.kind,'prepared');assert.equal(x.host.requests.length,2);
 const generated=await x.send('confirm',command);assert.equal(generated.status,200,JSON.stringify(generated.body));assert.equal(generated.body.kind,'generated');assert.match(JSON.stringify(generated.body),/最近还好吗/);assert.equal(x.host.requests.length,3);
 assert.deepEqual(x.host.requests.map(r=>r.body.tools.filter(t=>t.name==='ExplorationSkillSelection').length),[1,0,0]);
 const cPayload=JSON.parse(x.host.requests[2].body.messages[0].content[0].text);assert.doesNotMatch(JSON.stringify(cPayload),/EXPLORATION_STATIC_BODY|EXPLORATION_RESOURCE_FORBIDDEN/);
 const request=(await x.f.client.query('SELECT reply_request_id FROM assistant_session_turn WHERE owner_id=$1 AND session_id=$2 AND state=\'completed\'',[x.owner,x.session])).rows[0].reply_request_id;
 assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM reply_candidate WHERE reply_request_id=$1',[request])).rows[0].n,1);
 assert.deepEqual((await x.send('confirm',command)).body,generated.body);assert.equal(x.host.requests.length,3);
});
for(const {mode,legacy} of [{mode:'auto'},{mode:'user'},{mode:'auto',legacy:true}])test(`${legacy?'兼容缺少选择完成标记的':''}${mode}探索实际版本沿原A到C固定使用，候选依据保留选择来历`,{timeout:60000},async t=>{
 const x=await fixture(t,{onRequest:async({requests,events,res,payload,version})=>{
  if(requests.at(-1).body.tools.some(v=>v.name==='ReplyRuntimeOutput')){assert.match(JSON.stringify(requests.at(-1).body),/EXPLORATION_STATIC_BODY/);useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:version,candidates:[{text:'最近还好吗？',basis:'当前原话及本次自动匹配的方法',citation_ids:[payload.evidence[0].evidence_id],risk_notes:[]}]});sendEvents(res,events);return true;}return false;
 }});
 const first=await x.send('open',{operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:mode,...(mode==='user'?{skill_version_id:x.version}:{})}});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.used_skill.selection_method,mode);
 if(legacy)await x.f.client.query("UPDATE reply_exploration SET input_payload=input_payload-'skill_selection_complete' WHERE id=$1",[first.body.exploration_id]);
 const command={exploration_id:first.body.exploration_id,input_version_id:first.body.input_version_id,suggestion_id:first.body.options[0].suggestion_id,generate:true};
 const prepared=await x.send('prepare-confirm',command);assert.equal(prepared.status,200,JSON.stringify(prepared.body));const generated=await x.send('confirm',command);assert.equal(generated.status,200,JSON.stringify(generated.body));assert.equal(x.host.requests.length,mode==='auto'?3:2);
 const row=(await x.f.client.query("SELECT skill_version_id,skill_selection_method,skill_selection_reason FROM reply_request WHERE owner_id=$1 AND state='completed'",[x.owner])).rows[0];assert.equal(row.skill_version_id,x.version);assert.equal(row.skill_selection_method,mode);assert.match(row.skill_selection_reason,mode==='auto'?/自动/:/用户在方向探索明确选择/);if(mode==='auto')assert.doesNotMatch(row.skill_selection_reason,/用户明确选择/);
 assert.deepEqual((await x.send('confirm',command)).body,generated.body);assert.equal(x.host.requests.length,mode==='auto'?3:2);
});
