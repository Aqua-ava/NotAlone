import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {createAssistantErasure} from '../src/reply-assistant-erasure.ts';
import {setup} from './reply-assistant-erasure-support.mjs';
test('真实continuation父边递归清除turn/输入/准备/当前指针，学习得到全部输入身份',async t=>{
 const x=await setup(t),source=randomUUID(),root=await x.generation([source]),child=await x.generation([],root),leaf=await x.generation([],child);
 assert.deepEqual(new Set(await x.run([source],[root.request])),new Set([root.request,child.request,leaf.request]));
 const rows=(await x.f.client.query('SELECT state,input_payload,prepared_context FROM assistant_session_turn')).rows;
 assert.equal(rows.length,3);assert.ok(rows.every(r=>r.state==='redacted'&&r.input_payload===null&&r.prepared_context===null));
 assert.equal((await x.f.client.query('SELECT current_input_version_id FROM assistant_session WHERE id=$1',[x.session])).rows[0].current_input_version_id,null);
 for(const input of [root.input,child.input,leaf.input])assert.ok(x.calls[0].includes(input));
});
test('伪造跨session父引用不传播，撤租约的独立草稿仅failed并保留输入',async t=>{
 const x=await setup(t),source=randomUUID(),root=await x.generation([source]),other=randomUUID();
 await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default)VALUES($1,$2,$3,false)',[other,x.owner,x.contact]);
 const foreign=await x.generation([],root,other),draft=await x.generation();
 await x.f.client.query('UPDATE assistant_session_turn SET input_payload=$2 WHERE id=$1',[draft.turn,JSON.stringify({content:{type:'rewrite_draft',include_relationship_context:false}})]);
 const requests=await x.run([source],[root.request,draft.request]);assert.ok(!requests.includes(foreign.request));
 const rows=(await x.f.client.query('SELECT id,state,input_payload FROM assistant_session_turn WHERE id=ANY($1::uuid[])',[[foreign.turn,draft.turn]])).rows;
 assert.equal(rows.find(r=>r.id===foreign.turn).state,'running');assert.equal(rows.find(r=>r.id===draft.turn).state,'failed');assert.ok(rows.find(r=>r.id===draft.turn).input_payload);
});
test('损坏携入身份阻止整个来源删除并保留原准备副本',async t=>{
 const x=await setup(t),source=randomUUID(),root=await x.generation([source]);
 await x.f.client.query("INSERT INTO assistant_session_input(session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,'candidate_carry',$5)",[x.session,x.owner,x.contact,x.binding,JSON.stringify({type:'candidate_carry'})]);
 await assert.rejects(x.run([source],[root.request]),{code:'assistant_erasure_identity_invalid'});
 assert.equal((await x.f.client.query('SELECT state FROM assistant_session_turn WHERE id=$1',[root.turn])).rows[0].state,'running');assert.equal(x.calls.length,0);
});
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
function legacyHash(value) {return execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',"import sys,json,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest())"],{input:JSON.stringify(value),encoding:'utf8'}).trim();}
test('真实选择的跨会话携入依靠版本与消息指纹传递删除，改指纹时回滚',async t=>{
 const x=await setup(t),source=randomUUID(),root=await x.generation([source]),candidate=randomUUID(),selection=randomUUID(),childSession=randomUUID(),carry=randomUUID();
 const group=[{message_id:candidate,text:'合成旧候选'}];
 await x.f.client.query("UPDATE reply_request SET state='completed',context_snapshot='{}',skill_library_revision=0 WHERE id=$1",[root.request]);
 await x.f.client.query("UPDATE assistant_session_turn SET state='completed' WHERE id=$1",[root.turn]);
 await x.f.client.query("INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes,message_group)VALUES($1,$2,$3,$4,$5,0,'合成旧候选','合成依据','[]',$6)",[candidate,root.request,x.owner,x.contact,x.binding,JSON.stringify(group)]);
 await x.f.client.query('INSERT INTO assistant_candidate_version(id,owner_id,contact_id,session_id,turn_id,candidate_id,version_number)VALUES($1,$2,$3,$4,$5,$1,0)',[candidate,x.owner,x.contact,x.session,root.turn]);
 await x.f.client.query('INSERT INTO assistant_candidate_selection(id,owner_id,contact_id,session_id,selection_key,selection_number,candidate_id,version_id)VALUES($1,$2,$3,$4,$5,1,$6,$6)',[selection,x.owner,x.contact,x.session,randomUUID(),candidate]);
 await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id,is_default)VALUES($1,$2,$3,false)',[childSession,x.owner,x.contact]);
 const origin={type:'candidate_carry',metadata_version:2,origin_owner_id:x.owner,origin_contact_id:x.contact,origin_binding_id:x.binding,origin_session_id:x.session,origin_input_version_id:root.input,origin_turn_id:root.turn,origin_reply_request_id:root.request,origin_candidate_id:candidate,origin_version_id:candidate,origin_selection_id:selection,payload_sha256:legacyHash(group)};
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content)VALUES($1,$2,$3,$4,$5,'candidate_carry',$6)",[carry,childSession,x.owner,x.contact,x.binding,JSON.stringify({...origin,payload_sha256:'0'.repeat(64)})]);
 await assert.rejects(x.run([source],[root.request]),{code:'assistant_erasure_identity_invalid'});
 await x.f.client.query('UPDATE assistant_session_input SET content=$2 WHERE id=$1',[carry,JSON.stringify(origin)]);
 await x.run([source],[root.request]);
 assert.equal((await x.f.client.query('SELECT state,content FROM assistant_session_input WHERE id=$1',[carry])).rows[0].state,'redacted');
});
test('捕获discussion与generation原指纹选择真实父边，伪造摘要不得清空任何副本',async t=>{
 const x=await setup(t),source=randomUUID(),discussion=randomUUID(),root=await x.generation([source]),child=await x.generation();
 const content={type:'purpose_exploration',text:'合成讨论'};
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6,$7)",[discussion,x.session,x.owner,x.contact,x.binding,JSON.stringify(content),[source]]);
 const snap={version:1,scope:{owner_id:x.owner,contact_id:x.contact},session_id:x.session,request_key:child.key,current_input_version_id:child.input,current_turn_id:child.turn,current_payload_sha256:legacyHash(['a'.repeat(64),child.payload,x.binding]),records:[{kind:'discussion_input',input_version_id:discussion,payload_sha256:legacyHash([content,x.binding,[source]]),turn_id:null,candidate_id:null,version_id:null},{kind:'generation_input',input_version_id:root.input,payload_sha256:legacyHash([root.payload,'a'.repeat(64),x.binding,root.request,[source],[]]),turn_id:root.turn,candidate_id:null,version_id:null}]};
 const write=async snapshot=>x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[child.request,JSON.stringify({assistant_discussion_snapshot:snapshot})]);
 await write({...snap,current_payload_sha256:'0'.repeat(64)});await assert.rejects(x.run([source],[root.request]),{code:'assistant_erasure_identity_invalid'});
 await write(snap);const affected=await x.run([source],[root.request]);assert.ok(affected.includes(child.request));
 assert.equal((await x.f.client.query('SELECT state FROM assistant_session_input WHERE id=$1',[discussion])).rows[0].state,'redacted');
});
test('捕获候选版本来自实际turn/request/version，篡改消息不能成为合法删除父边',async t=>{
 const x=await setup(t),source=randomUUID(),root=await x.generation([source]),child=await x.generation(),candidate=randomUUID();
 const group=[{message_id:candidate,text:'合成候选'}];
 await x.f.client.query("UPDATE reply_request SET state='completed',context_snapshot='{}',skill_library_revision=0 WHERE id=$1",[root.request]);await x.f.client.query("UPDATE assistant_session_turn SET state='completed' WHERE id=$1",[root.turn]);
 await x.f.client.query("INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes,message_group)VALUES($1,$2,$3,$4,$5,0,'合成候选','合成依据','[]',$6)",[candidate,root.request,x.owner,x.contact,x.binding,JSON.stringify(group)]);
 // 原版尚未建立版本记录时仍只读投影，不补写任何历史。
 const candidateText=JSON.stringify({messages:group,requirements:null});
 const snap={version:1,scope:{owner_id:x.owner,contact_id:x.contact},session_id:x.session,request_key:child.key,current_input_version_id:child.input,current_turn_id:child.turn,current_payload_sha256:legacyHash(['a'.repeat(64),child.payload,x.binding]),records:[{kind:'candidate_version',input_version_id:root.input,payload_sha256:legacyHash([candidateText,0,null,root.request,1]),turn_id:root.turn,candidate_id:candidate,version_id:candidate}]};
 await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[child.request,JSON.stringify({assistant_discussion_snapshot:snap})]);
 await x.f.client.query("UPDATE reply_candidate SET candidate_text='篡改',message_group=$2 WHERE id=$1",[candidate,JSON.stringify([{message_id:candidate,text:'篡改'}])]);
 await assert.rejects(x.run([source],[root.request]),{code:'assistant_erasure_identity_invalid'});
 await x.f.client.query("UPDATE reply_candidate SET candidate_text='合成候选',message_group=$2 WHERE id=$1",[candidate,JSON.stringify(group)]);
 assert.ok((await x.run([source],[root.request])).includes(child.request));
 assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM assistant_candidate_version')).rows[0].n,0);
});
test('旧JSONB小数、指数、超安全整数摘要与Python独立编码一致',async t=>{
 const x=await setup(t),source=randomUUID(),discussion=randomUUID(),child=await x.generation();
 const raw='{"type":"purpose_exploration","text":"合成数值","whole":1.0,"tiny":0.000001,"decimal":1.25,"huge":9007199254740993}';
 await x.f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,content,dependency_ids)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6,$7)",[discussion,x.session,x.owner,x.contact,x.binding,raw,[source]]);
 const stored=(await x.f.client.query('SELECT content::text AS raw FROM assistant_session_input WHERE id=$1',[discussion])).rows[0].raw;
 const hash=execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',"import sys,json,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest())"],{input:`[${stored},"${x.binding}",["${source}"]]`,encoding:'utf8'}).trim();
 const snap={version:1,scope:{owner_id:x.owner,contact_id:x.contact},session_id:x.session,request_key:child.key,current_input_version_id:child.input,current_turn_id:child.turn,current_payload_sha256:legacyHash(['a'.repeat(64),child.payload,x.binding]),records:[{kind:'discussion_input',input_version_id:discussion,payload_sha256:hash,turn_id:null,candidate_id:null,version_id:null}]};
 await x.f.client.query('UPDATE reply_request SET context_snapshot=$2 WHERE id=$1',[child.request,JSON.stringify({assistant_discussion_snapshot:snap})]);
 assert.ok((await x.run([source],[])).includes(child.request));
});
