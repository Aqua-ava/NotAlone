import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {PostgresReplyContext, modelVisibleEvidence} from '../src/reply/context/reply-context.ts';
async function setup(t){const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID();await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成用户')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);return {f,owner,contact};}
function input(owner,contact,content){return {owner_id:owner,contact_id:contact,reply_request_id:randomUUID(),request:{contact_id:contact,content,continued_from_candidate_id:null}};}
test('无历史草稿只构造本次输入，隐形证据不可出站',async t=>{
 const {f,owner,contact}=await setup(t);const service=new PostgresReplyContext(f.client,{overview:false});
 const args=input(owner,contact,{type:'rewrite_draft',input_kind:'draft',draft_text:'明天见',include_relationship_context:false});
 const result=await service.build(args);
 assert.equal(result.evidence.length,1);assert.equal(result.evidence[0].evidence_id,args.reply_request_id);assert.equal(result.evidence[0].kind,'user_draft');
 assert.equal(result.evidence[0].status,'user_input');await service.validateCurrent(result);
 assert.deepEqual(modelVisibleEvidence({...result,evidence:result.evidence.map(e=>({...e,model_visible:false}))}),[]);
 await assert.rejects(service.validateCurrent({...result,evidence:[{...result.evidence[0],scope:{owner_id:owner,contact_id:randomUUID()}}]}),/reply_context/);
});
async function message(f,owner,contact,text='喜欢清淡饮食'){const source=randomUUID(),id=randomUUID(),ref=randomUUID();await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,owner,contact,source.replaceAll('-','').repeat(2)]);await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,'2026-10-01T01:02:03.123456Z')",[id,owner,contact,text]);await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[ref,id,owner,contact,source]);return {source,id,ref};}
test('同联系人消息、作者与微秒来源时间复验，删除和改正文不得复用',async t=>{
 const {f,owner,contact}=await setup(t),m=await message(f,owner,contact);const service=new PostgresReplyContext(f.client,{overview:false});
 const args=input(owner,contact,{type:'reply_to_message',target_message_id:m.id,direction:'回应饮食偏好',direction_source:'direct_input'});
 const result=await service.build(args);assert.equal(result.current_text,'喜欢清淡饮食');assert.equal(result.evidence[0].speaker_role,'contact');assert.match(result.evidence[0].timing.source_started_at,/123456/);await service.validateCurrent(result);
 await f.client.query("UPDATE message SET speaker='user' WHERE id=$1",[m.id]);await assert.rejects(service.validateCurrent(result),/reply_context/);
 await f.client.query("UPDATE message SET speaker='contact',text_content='改变的正文' WHERE id=$1",[m.id]);await assert.rejects(service.validateCurrent(result),/reply_context/);
 await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1",[m.source]);await assert.rejects(service.build(args),/reply_context/);
});
test('关系与本人分轨读取，记忆版本变化使快照失效',async t=>{
 const {f,owner,contact}=await setup(t),m=await message(f,owner,contact);const memory=randomUUID(),self=randomUUID();
 await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,$3,'喜欢清淡饮食','preference','other',$4,'manual')",[memory,owner,contact,[m.id]]);
 await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,'喜欢清淡饮食','preference','other',$3,'manual')",[self,owner,[owner]]);
 const service=new PostgresReplyContext(f.client,{overview:false}),args=input(owner,contact,{type:'rewrite_draft',input_kind:'draft',draft_text:'清淡饮食',include_relationship_context:true});
 const result=await service.build(args);assert.deepEqual(result.evidence.map(e=>e.kind),['user_draft','confirmed_memory','owner_memory']);await service.validateCurrent(result);
 await f.client.query('UPDATE confirmed_memory SET revision=revision+1 WHERE id=$1',[memory]);await assert.rejects(service.validateCurrent(result),/reply_context/);
});
test('pending保留未确认属性，缺失旧快照排除且用户排除停用派生记忆',async t=>{
 const {f,owner,contact}=await setup(t),m=await message(f,owner,contact,'清淡饮食'),candidate=randomUUID();
 const proof={version:1,message_ids:[],message_snapshots:{},message_scopes:{},source_ids:[m.source],source_refs:[],manual_entry:true};
 await f.client.query("INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,topic,source_ids,status,confidence,correction_evidence) VALUES($1,$2,$3,'清淡饮食','preference','other',$4,'pending',0.125,$5)",[candidate,owner,contact,[m.source],proof]);
 const service=new PostgresReplyContext(f.client,{overview:false}),args=input(owner,contact,{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'清淡饮食',include_relationship_context:true,excluded_message_ids:[]});
 const result=await service.build(args),pending=result.evidence.find(e=>e.kind==='pending_candidate');assert.ok(pending);assert.match(pending.selection_reason,/未确认候选.*置信度 0.12/);assert.equal(pending.revision,null);await service.validateCurrent(result);
 await f.client.query("UPDATE memory_candidate SET confidence=.25 WHERE id=$1",[candidate]);await assert.rejects(service.validateCurrent(result),/reply_context/);
 const excluded=await service.build({...args,request:{...args.request,content:{...args.request.content,excluded_message_ids:[m.id]}}});assert.deepEqual(excluded.evidence.map(e=>e.kind),['user_purpose','user_draft']);
 await f.client.query('UPDATE memory_candidate SET correction_evidence=NULL WHERE id=$1',[candidate]);assert.equal((await service.build(args)).evidence.some(e=>e.kind==='pending_candidate'),false);
});
test('事件/条件保留未知，来源全部依赖和半开有效期生效',async t=>{
 const {f,owner,contact}=await setup(t),a=await message(f,owner,contact),b=await message(f,owner,contact),memory=randomUUID();
 const event={version:1,stage:'planned',stage_evidence:[{message_id:a.id,char_start:0,char_end:2}],stage_verified:true,occurrence_start:null,occurrence_end:null,occurrence_evidence:[],occurrence_verified:false};
 const conditions={version:1,items:[{text:'有时间时',evidence:[{message_id:a.id,char_start:0,char_end:2}],source_supported:true}]};
 await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,source_dependency_mode,event,conditions) VALUES($1,$2,$3,'清淡饮食','preference','other',$4,'auto','all',$5,$6)",[memory,owner,contact,[a.id,b.id],event,conditions]);
 const service=new PostgresReplyContext(f.client,{overview:false}),args=input(owner,contact,{type:'rewrite_draft',input_kind:'draft',draft_text:'清淡饮食',include_relationship_context:true});
 const result=await service.build(args),item=result.evidence.find(e=>e.kind==='confirmed_memory');assert.equal(item.event.stage_verified,false);assert.equal(item.conditions.items[0].source_supported,false);await service.validateCurrent(result);
 await f.client.query("UPDATE confirmed_memory SET event=jsonb_set(event,'{stage}','\"agreed\"') WHERE id=$1",[memory]);await assert.rejects(service.validateCurrent(result),/reply_context/);
 await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1",[b.source]);assert.equal((await service.build(args)).evidence.some(e=>e.kind==='confirmed_memory'),false);
 await f.client.query("UPDATE source_document SET status='active' WHERE id=$1",[b.source]);await f.client.query('UPDATE confirmed_memory SET invalid_at=now() WHERE id=$1',[memory]);assert.equal((await service.build(args)).evidence.some(e=>e.kind==='confirmed_memory'),false);
});
test('pending完整追踪记忆上下文来源删除后不可继续召回',async t=>{
 const {f,owner,contact}=await setup(t),direct=await message(f,owner,contact,'清淡饮食'),context=await message(f,owner,contact,'合成旧记忆来源');
 const candidate=randomUUID(),contextCandidate=randomUUID(),memory=randomUUID(),trace=randomUUID();
 const proof=source=>({version:1,message_ids:[],message_snapshots:{},message_scopes:{},message_digests:{},source_ids:[source],source_refs:[],manual_entry:true});
 for(const [id,source] of [[candidate,direct.source],[contextCandidate,context.source]])await f.client.query("INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,topic,source_ids,status,correction_evidence) VALUES($1,$2,$3,'清淡饮食','preference','other',$4,'pending',$5)",[id,owner,contact,[source],proof(source)]);
 await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method) VALUES($1,$2,$3,'合成旧记忆','preference','other',$4,$5,'auto')",[memory,owner,contact,[context.source],contextCandidate]);
 await f.client.query("INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES($1,$2,$3,$4,'synthetic')",[trace,owner,contact,randomUUID()]);
 await f.client.query("INSERT INTO memory_extraction_trace_link(trace_id,owner_id,contact_id,record_kind,record_id,commit_status) VALUES($1,$2,$3,'candidate',$4,'committed')",[trace,owner,contact,candidate]);
 await f.client.query('INSERT INTO memory_extraction_trace_dependency(trace_id,owner_id,contact_id,source_id) VALUES($1,$2,$3,$4)',[trace,owner,contact,memory]);
 const service=new PostgresReplyContext(f.client,{overview:false}),args=input(owner,contact,{type:'rewrite_draft',input_kind:'draft',draft_text:'清淡饮食',include_relationship_context:true});
 assert.ok((await service.build(args)).evidence.some(e=>e.evidence_id===candidate));
 await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1",[context.source]);
 assert.equal((await service.build(args)).evidence.some(e=>e.evidence_id===candidate),false);
});
test('本人ALL来源不能把owner身份当手录豁免',async t=>{
 const {f,owner,contact}=await setup(t),memory=randomUUID();
 await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method,source_dependency_mode) VALUES($1,$2,'清淡饮食','preference','other',$3,'manual','all')",[memory,owner,[owner]]);
 const service=new PostgresReplyContext(f.client,{overview:false}),args=input(owner,contact,{type:'rewrite_draft',input_kind:'draft',draft_text:'清淡饮食',include_relationship_context:true});
 assert.equal((await service.build(args)).evidence.some(e=>e.evidence_id===memory),false);
 const {ownerMemorySourceDependencies}=await import('../src/reply/context/reply-context-memory.ts');
 const row=(await f.client.query('SELECT to_jsonb(m) AS value FROM owner_memory m WHERE id=$1',[memory])).rows[0].value;
 await assert.rejects(ownerMemorySourceDependencies(f.client,owner,row),/reply_context/);
});
test('显式续写须同事务资格端口并复验完整basis，普通请求不得夹带候选',async t=>{
 const {f,owner,contact}=await setup(t),candidate=randomUUID(),binding=randomUUID();
 let basis={candidate_id:candidate,scope:{owner_id:owner,contact_id:contact},conversation_binding_id:binding,text:'合成旧候选',basis_revision_sha256:'a'.repeat(64),basis_changes:[]};
 const service=new PostgresReplyContext(f.client,{readContinuationBasis:async(client,scope,b,id)=>{assert.equal(client,f.client);assert.deepEqual(scope,basis.scope);assert.equal(b,binding);assert.equal(id,candidate);return structuredClone(basis);}});
 const args={...input(owner,contact,{type:'rewrite_draft',input_kind:'draft',draft_text:'本次明确意图',include_relationship_context:false}),conversation_binding_id:binding};args.request.continued_from_candidate_id=candidate;
 await assert.rejects(new PostgresReplyContext(f.client).build(args),/已验证续写端口/);
 const context=await service.build(args);assert.equal(context.evidence.at(-1).kind,'continued_candidate');assert.equal(context.current_text,'本次明确意图');await service.validateCurrent(context);
 basis={...basis,basis_changes:[{reason:'合成来源已变化'}]};await assert.rejects(service.validateCurrent(context),/续写正文或依据已变化/);
});
