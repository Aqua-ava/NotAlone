import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {readReplyOwnerOverview,readReplyContactOverview} from '../src/reply/context/reply-context-overview.ts';
test('双概览同事务隔离；本人手录版本、内容及来源模式变化进入修订',async t=>{
 const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),other=randomUUID(),contact=randomUUID(),id=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人'),($2,'合成另一用户')",[owner,other]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,'喜欢清淡饮食','preference','other',$3,'manual')",[id,owner,[owner]]);
 const first=await readReplyOwnerOverview(f.client,owner);assert.equal(first.entries.length,1);assert.equal(first.entries[0].provenance.kind,'manual_entry');assert.equal(first.entries[0].is_latest,true);assert.deepEqual((await readReplyOwnerOverview(f.client,other)).entries,[]);
 assert.equal((await readReplyContactOverview(f.client,{owner_id:owner,contact_id:contact})).entries.length,0);
 await f.client.query("UPDATE owner_memory SET text_content='喜欢原味饮食' WHERE id=$1",[id]);assert.notEqual((await readReplyOwnerOverview(f.client,owner)).projection_revision,first.projection_revision);
 await f.client.query("UPDATE owner_memory SET source_dependency_mode='all' WHERE id=$1",[id]);assert.deepEqual((await readReplyOwnerOverview(f.client,owner)).entries,[]);
});
test('默认概览导航复验本人概览修订',async t=>{
 const {PostgresReplyContext}=await import('../src/reply/context/reply-context.ts');const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID(),memory=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,'清淡饮食','preference','other',$3,'manual')",[memory,owner,[owner]]);
 const service=new PostgresReplyContext(f.client),input={owner_id:owner,contact_id:contact,reply_request_id:randomUUID(),request:{contact_id:contact,continued_from_candidate_id:null,content:{type:'rewrite_draft',input_kind:'draft',draft_text:'清淡饮食',include_relationship_context:true}}};
 const result=await service.build(input),item=result.evidence.find(e=>e.kind==='owner_memory');assert.equal(item.navigation.scope_kind,'owner');assert.deepEqual(item.navigation.source_message_ids,[]);assert.ok(result.retrieval.owner_overview.projection_revision);await service.validateCurrent(result);
 const forged=structuredClone(result);forged.evidence.find(e=>e.kind==='owner_memory').navigation.dependency_ids.push(randomUUID());await assert.rejects(service.validateCurrent(forged),/导航/);
 await f.client.query("UPDATE owner_memory SET text_content='原味饮食' WHERE id=$1",[memory]);await assert.rejects(service.validateCurrent(result),/概览导航修订/);
});
test('来源窗口只由可核验联系人导航补齐且复用同事务',async t=>{
 const {PostgresReplyContext}=await import('../src/reply/context/reply-context.ts');const {captureSnapshot}=await import('../src/memory/overview/evidence/sources.ts');
 const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),candidate=randomUUID(),memory=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,owner,contact,source.replaceAll('-','').repeat(2)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','清淡饮食','2026-01-01T01:02:03.123456Z')",[message,owner,contact]);
 await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,owner,contact,source]);
 const frozen=await captureSnapshot(f.client,owner,[message],[message],contact);
 await f.client.query("INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,topic,source_ids,status,correction_evidence) VALUES($1,$2,$3,'清淡饮食','common_fact','other',$4,'pending',$5)",[candidate,owner,contact,[message],frozen]);
 await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method) VALUES($1,$2,$3,'清淡饮食','common_fact','other',$4,$5,'auto')",[memory,owner,contact,[message],candidate]);
 const service=new PostgresReplyContext(f.client),input={owner_id:owner,contact_id:contact,reply_request_id:randomUUID(),conversation_binding_id:randomUUID(),history_message_ids:[],request:{contact_id:contact,continued_from_candidate_id:null,content:{type:'rewrite_draft',input_kind:'draft',draft_text:'清淡饮食',include_relationship_context:true}}};
 await f.client.query('BEGIN');t.after(()=>f.client.query('ROLLBACK').catch(()=>{}));
 const result=await service.build(input);assert.ok(result.evidence.some(e=>e.evidence_id===memory));assert.ok(result.evidence.some(e=>e.evidence_id===message),JSON.stringify({retrieval:result.retrieval,tools:result.tool_calls,nav:result.evidence.map(e=>e.navigation)}));assert.equal(result.retrieval.source_messages.used_calls,1);assert.equal(result.tool_calls[0].status,'succeeded');await service.validateCurrent(result);
 await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1",[source]);await assert.rejects(service.validateCurrent(result),/概览导航修订/);await f.client.query('ROLLBACK');
});
test('可选资料SQL失败退回保存点，外部事务仍可用且不伪装为空成功',async t=>{
 const {readOptionalContext}=await import('../src/reply/context/reply-context-read.ts');const f=await createStorageFixture();t.after(()=>f.close());
 await f.client.query('BEGIN');
 const failed=await readOptionalContext(f.client,async()=>{await f.client.query('SELECT * FROM public.synthetic_missing_context_table');return [];});
 assert.equal(failed.failed,true);assert.equal(failed.value,null);assert.equal((await f.client.query('SELECT 1 AS value')).rows[0].value,1);
 const empty=await readOptionalContext(f.client,async()=>[]);assert.equal(empty.failed,false);assert.deepEqual(empty.value,[]);await f.client.query('ROLLBACK');
});
