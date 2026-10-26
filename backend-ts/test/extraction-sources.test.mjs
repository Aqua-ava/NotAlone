import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {freezeExtractionSources,loadExtractionSourceMessages,loadExtractionSources,requireCurrent} from '../src/extraction-sources.ts';
import {canonicalJSON} from '../src/contact-overview-evidence.ts';

async function fixture(){
 const storageFixture=await createStorageFixture(),c=storageFixture.client;
 const scope={ownerId:randomUUID(),contactId:randomUUID()},source=randomUUID(),batch=randomUUID(),ids=[randomUUID(),randomUUID()],refs=[randomUUID(),randomUUID()];
 await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成')",[scope.ownerId]);await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成')",[scope.contactId,scope.ownerId]);
 await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,2)",[source,scope.ownerId,scope.contactId,'a'.repeat(64)]);
 await c.query("INSERT INTO source_processing_batch(batch_id,owner_id,contact_id,source_kind,source_id)VALUES($1,$2,$3,'source_document',$4)",[batch,scope.ownerId,scope.contactId,source]);
 for(let i=0;i<2;i++){
  await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,$5)",[ids[i],scope.ownerId,scope.contactId,`合成${i}`,`2026-10-24T00:00:00.00000${i+1}Z`]);
  await c.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,$6,$7::jsonb)",[refs[i],ids[i],scope.ownerId,scope.contactId,source,`line:${i+1}`,'{"time_iso":"2026-10-24T08:00:00+08:00","big":9007199254740993}']);
  await c.query("INSERT INTO source_processing_record(record_id,batch_id,owner_id,contact_id,position,message_id,source_ref_id,outcome,payload)VALUES($1,$2,$3,$4,$5,$6,$7,'normalized','{\"capture_layer\":\"normalized\"}')",[randomUUID(),batch,scope.ownerId,scope.contactId,i,ids[i],refs[i]]);
 }
 return {c,scope,source,batch,ids,refs,close:()=>storageFixture.close()};
}
test('真实PG：有界target/context冻结、微秒/大整数保真；辅助来源变更撤销提交且不补新证据',async()=>{
 const f=await fixture();try{
  const frozen=await freezeExtractionSources(f.c,f.scope,{target_message_ids:[f.ids[1]],context_message_ids:[f.ids[0]]});
  assert.deepEqual(frozen.target_message_ids,[f.ids[1]]);assert.deepEqual(frozen.context_message_ids,[f.ids[0]]);
  const messages=await loadExtractionSources(f.c,f.scope,frozen);assert.deepEqual(messages.map(m=>m.message_id),f.ids);
  assert.equal(messages[0].owner_id,f.scope.ownerId);assert.equal(messages[0].contact_id,f.scope.contactId);
  assert.equal(messages[0].occurred_at,'2026-10-24T00:00:00.000001+00:00');assert.equal(messages[1].occurred_at,'2026-10-24T00:00:00.000002+00:00');
  assert.ok(canonicalJSON(messages[0].source_snapshots).includes('9007199254740993'));assert.equal(messages[0].source_snapshots[0].processing_status,'recorded');
  await requireCurrent(f.c,f.scope,frozen);
  const serialized=canonicalJSON(frozen);await requireCurrent(f.c,f.scope,serialized);assert.equal(canonicalJSON(await loadExtractionSources(f.c,f.scope,serialized)),canonicalJSON(messages));
  const check=async(sql,args=[])=>{await f.c.query('BEGIN');try{await f.c.query(sql,args);await assert.rejects(requireCurrent(f.c,f.scope,frozen),{code:'extraction_sources_changed'});}finally{await f.c.query('ROLLBACK');}};
  await check("UPDATE message SET text_content='变化' WHERE id=$1",[f.ids[0]]);
  await check("UPDATE message_source_ref SET raw_payload=jsonb_set(raw_payload,'{big}','9007199254740994') WHERE id=$1",[f.refs[0]]);
  await check("UPDATE source_document SET content_sha256=$1 WHERE id=$2",['b'.repeat(64),f.source]);
  await check("UPDATE source_processing_batch SET status='deleted' WHERE batch_id=$1",[f.batch]);
  await check("DELETE FROM source_processing_record WHERE source_ref_id=$1",[f.refs[0]]);
  await check("UPDATE source_processing_record SET payload='{\"capture_layer\":\"parsed_only\"}' WHERE source_ref_id=$1",[f.refs[0]]);
  await check("DELETE FROM message_source_ref WHERE id=$1",[f.refs[0]]);
  await f.c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'replacement','{}')",[f.ids[0],f.scope.ownerId,f.scope.contactId,f.source]);
  assert.equal((await loadExtractionSources(f.c,f.scope,frozen))[0].source_snapshots.length,1,'新引用不能补入旧窗口');
  await f.c.query('DELETE FROM message_source_ref WHERE id=$1',[f.refs[0]]);await assert.rejects(requireCurrent(f.c,f.scope,frozen),{code:'extraction_sources_changed'});
  await assert.rejects(freezeExtractionSources(f.c,f.scope,{target_message_ids:[randomUUID()],context_message_ids:[]}),{code:'extraction_sources_unavailable'});
  await assert.rejects(freezeExtractionSources(f.c,f.scope,{target_message_ids:[f.ids[1]],context_message_ids:Array.from({length:640},()=>randomUUID())}),{code:'extraction_sources_bounds'});
  await assert.rejects(loadExtractionSourceMessages(f.c,f.scope,Array.from({length:641},()=>randomUUID())),{code:'extraction_sources_bounds'});
  await assert.rejects(loadExtractionSourceMessages(f.c,f.scope,Array.from({length:640},()=>randomUUID())),{code:'extraction_sources_unavailable'},
   '任务规划允许原提取窗口的600目标与最多40辅助上下文');
  await assert.rejects(requireCurrent(f.c,{...f.scope,contactId:randomUUID()},frozen),{code:'extraction_sources_scope'});
 }finally{await f.close();}
});
