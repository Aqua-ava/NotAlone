import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {freezeExtractionSources} from '../src/extraction-sources.ts';
import {attachVerifiedSourceReceipt} from '../src/extraction-evidence.ts';
import {sha} from '../src/contact-overview-evidence.ts';
import {MemoryAdoption} from '../src/memory-adoption.ts';
import {mutateMemory} from '../src/memory-mutations.ts';

async function setup(){
 const fixture=await createExtractionFixture(),c=fixture.client,owner=randomUUID(),contact=randomUUID(),other=randomUUID();
 const scope={owner_id:owner,contact_id:contact};
 const transaction=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}};
 await c.query("INSERT INTO public.owner(id,display_name)VALUES($1,'合成所有者')",[owner]);
 await c.query("INSERT INTO public.contact(id,owner_id,display_name)VALUES($1,$2,'合成甲'),($3,$2,'合成乙')",[contact,owner,other]);
 const sources=new Map();
 async function addSource(contactId){
  const source=randomUUID();
  await c.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contactId,sha(source)]);
  sources.set(contactId,source);return source;
 }
 async function message(text,occurred_at,speaker='contact',contactId=contact){
  const source=sources.get(contactId)??await addSource(contactId),id=randomUUID();
  await c.query("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,$4,'text',$5,$6)",[id,owner,contactId,speaker,text,occurred_at]);
  await c.query("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,$5,$6)",
   [id,owner,contactId,source,`synthetic:${id}`,{synthetic:true,text,time_iso:occurred_at}]);
  return id;
 }
 async function fact(messageId,overrides={},contactId=contact){
  const frozen=await freezeExtractionSources(c,{ownerId:scope.owner_id,contactId},{target_message_ids:[messageId],context_message_ids:[]}),source=frozen.messages[0];
  const base={text:source.text,category:'preference',subject:'contact',topic:'health',source_message_ids:[messageId],confidence:0.91,
   risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',
   alternatives:[],interpretation_reason:'合成来源直接支持',requires_all_sources:false,source_dependency_mode:'any',_scene_name:'合成',
   event:null,conditions:null,timing:{source_started_at:source.occurred_at,source_ended_at:source.occurred_at,source_time_complete:source.occurred_at!==null},
   ...overrides};
  const verification={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:messageId,quote:source.text}],
   verification_mode:'legacy-v4',model_verdict:'supported',model_issues:[],event:base.event,conditions:base.conditions,proof:null,proof_verification:null};
  return attachVerifiedSourceReceipt({owner_id:owner,contact_id:contactId,messages:frozen.messages,target_message_ids:[messageId]},base,verification);
 }
 async function trace(contactId=contact){
  const traceId=randomUUID(),batchKey='a'.repeat(64);
  await c.query("INSERT INTO public.memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key)VALUES($1,$2,$3,$4,$5)",[traceId,owner,contactId,randomUUID(),batchKey]);
  return {trace_id:traceId,batch_key:batchKey};
 }
 const embed=async texts=>texts.map(text=>[1,Math.min(31,[...String(text)].length),0]);
 return {fixture,c,owner,contact,other,scope,transaction,addSource,message,fact,trace,embed};
}

test('合成PG：无相似项自动新增联系人/本人资料、幂等重放、删除指纹和追踪',async()=>{
 const x=await setup();
 try{
  const first=await x.message('合成联系人偏好周三散步','2026-10-01T08:00:00.123456+08:00');
  const self=await x.message('本人喜欢清晨散步','2026-10-01T08:01:00.123456+08:00','user');
  const shared=await x.message('合成双方约定周末看展','2026-10-01T08:02:00.123456+08:00');
  const trace=await x.trace();
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  const input={contact_id:x.contact,...trace,signal:new AbortController().signal,
   facts:[{fact:await x.fact(first),candidate_trace_id:randomUUID()},
    {fact:await x.fact(self,{subject:'self',confidence:0.1,risk_flags:['sensitivity:health']}),candidate_trace_id:randomUUID()},
    {fact:await x.fact(shared,{subject:'shared'}),candidate_trace_id:randomUUID()}]};
  const actual=await adoption.adoptBatch(input);
  assert.deepEqual({adopted:actual.adopted,updated:actual.updated,pending:actual.pending,duplicate:actual.skipped_duplicate},{adopted:3,updated:0,pending:0,duplicate:0});
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE adoption_method='auto' AND status='active'")).rows[0].n,2);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.owner_memory WHERE adoption_method='auto' AND status='active'")).rows[0].n,1);
  assert.deepEqual((await x.c.query('SELECT confidence,risk_flags FROM public.owner_memory')).rows[0],{confidence:0.1,risk_flags:['sensitivity:health']});
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.memory_candidate WHERE status='confirmed'")).rows[0].n,3);
  assert.deepEqual((await x.c.query("SELECT source_ids FROM public.confirmed_memory WHERE source_ids=$1",[[first]])).rows[0].source_ids,[first]);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='candidate_result'",[trace.trace_id])).rows[0].n,3);
  const replay=await adoption.adoptBatch(input);
  assert.equal(replay.skipped_duplicate,3);assert.equal((await x.c.query('SELECT count(*)::int n FROM public.confirmed_memory')).rows[0].n,2);
  const gone=await x.message('合成已删除指纹','2026-10-02T08:00:00.123456+08:00');
  const goneFact=await x.fact(gone);
  await x.c.query("INSERT INTO public.confirmed_memory(owner_id,contact_id,text_content,category,source_ids,adoption_method,status)VALUES($1,$2,$3,'preference',$4,'auto','deleted')",[x.owner,x.contact,goneFact.text,[gone]]);
  const skipped=await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:goneFact}]});
  assert.equal(skipped.skipped_deleted,1);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.memory_candidate WHERE text_content=$1",[goneFact.text])).rows[0].n,0);
 }finally{await x.fixture.close();}
});

test('合成PG：逐项提交失败返回已提交结果，重试只补未提交项',async()=>{
 const x=await setup();
 try{
  const first=await x.message('合成联系人偏好周末看展','2026-10-01T08:00:00.123456+08:00');
  const second=await x.message('合成联系人偏好清晨慢跑','2026-10-02T08:00:00.123456+08:00');
  const facts=[await x.fact(first),await x.fact(second)];
  let transactions=0;
  const flaky=async work=>{
   transactions++;
   if(transactions===5)throw new Error('synthetic_commit_failure');
   await x.c.query('BEGIN');
   try{const result=await work(x.c);await x.c.query('COMMIT');return result;}
   catch(error){await x.c.query('ROLLBACK');throw error;}
  };
  let failure;
  try{
   await new MemoryAdoption({ownerId:x.owner,transaction:flaky,embed:x.embed})
    .adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:facts.map(fact=>({fact}))});
  }catch(error){failure=error;}
  assert.equal(failure?.code,'adoption_commit_failed');
  assert.deepEqual(failure?.partial?.results.map(result=>[result.candidate_index,result.disposition]),[[0,'adopted']]);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='active'")).rows[0].n,1);
  const runtime={
   async adjudicate(items){const parent=items[0].similar[0];
    return [{candidate_index:1,action:'add',replaced_memory_id:null,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null,
     relation:{kind:'independent',related_memory_ids:[parent.memory_id],explanation:'看展与慢跑是两项独立偏好',claim_changed:false,condition_changed:false,
      evidence:[{message_id:first,quote:'合成联系人偏好周末看展'},{message_id:second,quote:'合成联系人偏好清晨慢跑'}]}}];},
   async verifyRelations(items){return [{candidate_index:1,supported:true,source_receipt:items[0].relation_source_receipt,
    claim_changed:false,condition_changed:false,evidence:[{message_id:first,quote:'合成联系人偏好周末看展'},{message_id:second,quote:'合成联系人偏好清晨慢跑'}]}];},
   async verifyMerge(){throw new Error('不应合并');},
  };
  const retried=await new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:runtime})
   .adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:facts.map(fact=>({fact}))});
  assert.deepEqual({duplicate:retried.skipped_duplicate,adopted:retried.adopted},{duplicate:1,adopted:1});
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='active'")).rows[0].n,2);
 }finally{await x.fixture.close();}
});

test('合成PG：两段模型裁决后自动更新、父版本CAS、人工优先和自动撤销',async()=>{
 const x=await setup();
 try{
  const oldMessage=await x.message('合成联系人喜欢周三散步','2026-10-01T08:00:00.123456+08:00');
  const oldFact=await x.fact(oldMessage),first=await x.trace();
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  await adoption.adoptBatch({contact_id:x.contact, ...first,signal:new AbortController().signal,facts:[{fact:oldFact}]});
  const parent=(await x.c.query("SELECT id,revision FROM public.confirmed_memory WHERE status='active'")).rows[0];
  const nextMessage=await x.message('合成联系人现在改为周四散步','2026-10-10T08:00:00.123456+08:00');
  const nextFact=await x.fact(nextMessage);
  let adjudications=0,relations=0;
  const runtime={
   async adjudicate(items){
    adjudications++;assert.equal(items.length,1);assert.ok(items[0].similar.some(memory=>memory.memory_id===parent.id));
    return [{candidate_index:0,action:'update',replaced_memory_id:parent.id,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null,
     relation:{kind:'state_change',related_memory_ids:[parent.id],explanation:'合成来源明确把周三改为周四',claim_changed:true,condition_changed:false,
      evidence:[{message_id:oldMessage,quote:'合成联系人喜欢周三散步'},{message_id:nextMessage,quote:'合成联系人现在改为周四散步'}]},
     usage:{call_id:randomUUID(),model_name:'synthetic-adjudicator',input_tokens:12,output_tokens:4,purpose:'adjudication'}}];
   },
   async verifyRelations(items,decisions){
    relations++;assert.equal(items.length,1);
    return [{candidate_index:0,supported:true,source_receipt:items[0].relation_source_receipt,claim_changed:true,condition_changed:false,
     evidence:decisions[0].relation.evidence,usage:{call_id:randomUUID(),model_name:'synthetic-verifier',input_tokens:10,output_tokens:2,purpose:'relation_verification'}}];
   },
   async verifyMerge(){throw new Error('不应合并');},
  };
  const traced=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:runtime});
  const updateTrace=await x.trace();
  const result=await traced.adoptBatch({contact_id:x.contact,...updateTrace,signal:new AbortController().signal,facts:[{fact:nextFact}]});
  assert.deepEqual({adjudications,relations,updated:result.updated,usages:result.usages.length},{adjudications:1,relations:1,updated:1,usages:2});
  const usages=(await x.c.query("SELECT payload FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='candidate_result'",[updateTrace.trace_id])).rows[0].payload.usages;
  assert.deepEqual(usages.map(item=>item.purpose),['adjudication','relation_verification']);
  const active=(await x.c.query("SELECT * FROM public.confirmed_memory WHERE status='active'")).rows;
  assert.equal(active.length,1);assert.equal(active[0].revision,2);assert.equal(active[0].supersedes_memory_id,parent.id);
  assert.deepEqual([...active[0].source_ids].sort(),[oldMessage,nextMessage].sort());assert.ok(active[0].version_evidence);
  assert.equal((await x.c.query("SELECT status,revision FROM public.confirmed_memory WHERE id=$1",[parent.id])).rows[0].status,'invalidated');
  await x.c.query('BEGIN');
  const restored=await mutateMemory(x.c,x.owner,{level:'contact',contactId:x.contact},'revert-auto-update',active[0].id,{expected_revision:2});
  await x.c.query('COMMIT');
  assert.equal(restored.id,parent.id);assert.equal(restored.status,'active');

  const corrected=await (async()=>{await x.c.query('BEGIN');try{const value=await mutateMemory(x.c,x.owner,{level:'contact',contactId:x.contact},'correct',parent.id,{text:'合成用户明确修正为周五散步',change_kind:'state_changed'});await x.c.query('COMMIT');return value;}catch(error){await x.c.query('ROLLBACK');throw error;}})();
  const later=await x.message('合成联系人现在改为周六散步','2026-10-12T08:00:00.123456+08:00');
  const laterFact=await x.fact(later);
  const manualRuntime={...runtime,
   async adjudicate(items){return [{candidate_index:0,action:'update',replaced_memory_id:corrected.id,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null,
    relation:{kind:'state_change',related_memory_ids:[corrected.id],explanation:'合成来源表示再次变化',claim_changed:true,condition_changed:false,
     evidence:[{message_id:oldMessage,quote:'合成联系人喜欢周三散步'},{message_id:later,quote:'合成联系人现在改为周六散步'}]}}];},
   async verifyRelations(items){return [{candidate_index:0,supported:true,source_receipt:items[0].relation_source_receipt,claim_changed:true,condition_changed:false,
    evidence:[{message_id:oldMessage,quote:'合成联系人喜欢周三散步'},{message_id:later,quote:'合成联系人现在改为周六散步'}]}];}};
  const guarded=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:manualRuntime});
  const pending=await guarded.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:laterFact}]});
  assert.equal(pending.pending,1);
  assert.equal((await x.c.query("SELECT adoption_method,status FROM public.confirmed_memory WHERE id=$1",[corrected.id])).rows[0].adoption_method,'manual');
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE source_ids && $1::uuid[] AND adoption_method='auto' AND status='active'",[[later]] )).rows[0].n,0);
 }finally{await x.fixture.close();}
});

test('合成PG：更新裁决后父来源正文变化时不退役旧版本',async()=>{
 const x=await setup();
 try{
  const old=await x.message('合成联系人喜欢在公园喝水','2026-10-01T08:00:00.123456+08:00');
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:await x.fact(old)}]});
  const parent=(await x.c.query("SELECT id,revision FROM public.confirmed_memory WHERE status='active'")).rows[0];
  const next=await x.message('合成联系人现在改在体育馆喝水','2026-10-10T08:00:00.123456+08:00');
  const nextFact=await x.fact(next);
  const runtime={
   async adjudicate(){return [{candidate_index:0,action:'update',replaced_memory_id:parent.id,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null,
    relation:{kind:'state_change',related_memory_ids:[parent.id],explanation:'合成来源明确变更地点',claim_changed:true,condition_changed:false,
     evidence:[{message_id:old,quote:'合成联系人喜欢在公园喝水'},{message_id:next,quote:'合成联系人现在改在体育馆喝水'}]}}];},
   async verifyRelations(items){await x.c.query('UPDATE public.message SET text_content=$2 WHERE id=$1',[old,'合成联系人后来改在图书馆喝水']);
    return [{candidate_index:0,supported:true,source_receipt:items[0].relation_source_receipt,claim_changed:true,condition_changed:false,
     evidence:[{message_id:old,quote:'合成联系人喜欢在公园喝水'},{message_id:next,quote:'合成联系人现在改在体育馆喝水'}]}];},
   async verifyMerge(){throw new Error('不应合并');},
  };
  await assert.rejects(new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:runtime})
   .adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:nextFact}]}),
  {code:'adoption_source_changed'});
  const current=(await x.c.query("SELECT status,revision FROM public.confirmed_memory WHERE id=$1",[parent.id])).rows[0];
  assert.deepEqual(current,{status:'active',revision:parent.revision});
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE source_ids @> ARRAY[$1]::uuid[] AND id<>$2",[next,parent.id])).rows[0].n,0);
 }finally{await x.fixture.close();}
});

test('合成PG：本机embedding不可用时停止裁决且不写候选或记忆',async()=>{
 const x=await setup();
 try{
  const old=await x.message('合成联系人喜欢茶','2026-10-01T08:00:00.123456+08:00');
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:await x.fact(old)}]});
  const next=await x.message('合成联系人喜欢咖啡','2026-10-02T08:00:00.123456+08:00');
  let adjudicate=0;
  const unavailable=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:async()=>{throw new Error('embedding_unavailable');},
   adjudication:{async adjudicate(){adjudicate++;return [];},async verifyRelations(){return [];},async verifyMerge(){throw new Error();}}});
  await assert.rejects(unavailable.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,
   facts:[{fact:await x.fact(next)}]}),{code:'embedding_unavailable',retryable:true});
  assert.equal(adjudicate,0);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.memory_candidate WHERE text_content=$1",['合成联系人喜欢咖啡'])).rows[0].n,0);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='active'")).rows[0].n,1);
 }finally{await x.fixture.close();}
});

test('合成PG：用户删除后，新来源上同一正文只形成待确认差异，不自动复活',async()=>{
 const x=await setup();
 try{
  const original=await x.message('合成联系人明确不接受临时邀约','2026-10-01T08:00:00.123456+08:00');
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:await x.fact(original)}]});
  const memory=(await x.c.query("SELECT id,revision FROM public.confirmed_memory WHERE status='active'")).rows[0];
  await x.c.query('BEGIN');
  await mutateMemory(x.c,x.owner,{level:'contact',contactId:x.contact},'delete',memory.id,{}, {beforeErase:async()=>{}});
  await x.c.query('COMMIT');
  const repeated=await x.message('合成联系人明确不接受临时邀约','2026-10-03T08:00:00.123456+08:00');
  const result=await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:await x.fact(repeated)}]});
  assert.equal(result.adopted,0);assert.equal(result.pending,1);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='active'")).rows[0].n,0);
  const candidate=(await x.c.query("SELECT status,failure_reason FROM public.memory_candidate WHERE source_ids=$1",[[repeated]] )).rows[0];
  assert.equal(candidate.status,'pending');assert.match(candidate.failure_reason,/correction/);
 }finally{await x.fixture.close();}
});

test('合成PG：另一联系人删除的本人自动资料不阻断当前联系人范围',async()=>{
 const x=await setup();
 try{
  const otherMessage=await x.message('合成本人保留周末阅读习惯','2026-10-01T08:00:00.123456+08:00','user',x.other);
  await new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed})
   .adoptBatch({contact_id:x.other,...(await x.trace(x.other)),signal:new AbortController().signal,
    facts:[{fact:await x.fact(otherMessage,{subject:'self'},x.other)}]});
  await x.c.query("UPDATE public.owner_memory SET status='deleted' WHERE status='active'");
  const currentMessage=await x.message('合成本人保留周末阅读习惯','2026-10-03T08:00:00.123456+08:00','user');
  const result=await new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed})
   .adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,
    facts:[{fact:await x.fact(currentMessage,{subject:'self'})}]});
  assert.equal(result.adopted,1);assert.equal(result.skipped_deleted,0);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.owner_memory WHERE status='active'")).rows[0].n,1);
 }finally{await x.fixture.close();}
});

test('合成PG：相关独立事实KEEP并存且不消费旧父版本来源',async()=>{
 const x=await setup();
 try{
  const tea=await x.message('合成联系人喜欢茶','2026-10-01T08:00:00.123456+08:00');
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:await x.fact(tea)}]});
  const old=(await x.c.query("SELECT id,revision,source_ids FROM public.confirmed_memory WHERE status='active'")).rows[0];
  const coffee=await x.message('合成联系人喜欢咖啡','2026-10-02T08:00:00.123456+08:00');
  const runtime={
   async adjudicate(){return [{candidate_index:0,action:'keep',replaced_memory_id:null,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null,
    relation:{kind:'independent',related_memory_ids:[old.id],explanation:'茶与咖啡是两个独立偏好',claim_changed:false,condition_changed:false,
     evidence:[{message_id:tea,quote:'合成联系人喜欢茶'},{message_id:coffee,quote:'合成联系人喜欢咖啡'}]}}];},
   async verifyRelations(items){return [{candidate_index:0,supported:true,source_receipt:items[0].relation_source_receipt,
    claim_changed:false,condition_changed:false,evidence:[{message_id:tea,quote:'合成联系人喜欢茶'},{message_id:coffee,quote:'合成联系人喜欢咖啡'}]}];},
   async verifyMerge(){throw new Error('不应合并');},
  };
  const traced=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:runtime});
  const result=await traced.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:await x.fact(coffee)}]});
  assert.equal(result.adopted,1);
  const rows=(await x.c.query("SELECT revision,status,source_ids,evolution FROM public.confirmed_memory ORDER BY created_at")).rows;
  assert.equal(rows.length,2);assert.deepEqual(rows[0].source_ids,[tea]);assert.equal(rows[0].revision,1);assert.equal(rows[0].status,'active');
  assert.deepEqual(rows[1].source_ids,[coffee]);assert.equal(rows[1].revision,1);assert.equal(rows[1].evolution.kind,'independent');
  const milk=await x.message('合成联系人喜欢牛奶','2026-10-03T08:00:00.123456+08:00');
  const unknownRelation=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:{
   async adjudicate(){return [{candidate_index:0,action:'add',replaced_memory_id:null,merged_memory_ids:[],merged_text:null,duplicate_memory_id:null,relation:null}];},
   async verifyRelations(){throw new Error('关系未知不应被当成已验证');},async verifyMerge(){throw new Error('不应合并');}}});
  const unknown=await unknownRelation.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:await x.fact(milk)}]});
  assert.equal(unknown.adopted,0);assert.equal(unknown.pending,1);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='active'")).rows[0].n,2);
 }finally{await x.fixture.close();}
});

test('合成PG：合并父版本原子退役、完整来源依赖和提交前来源复验',async()=>{
 const x=await setup();
 try{
  const m1=await x.message('合成联系人喜欢周三跑步','2026-10-01T08:00:00.123456+08:00');
  const m2=await x.message('合成联系人喜欢周四游泳','2026-10-02T08:00:00.123456+08:00');
  const f1=await x.fact(m1),f2=await x.fact(m2,{topic:'other'});
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:f1},{fact:f2}]});
  const parents=(await x.c.query("SELECT id,revision FROM public.confirmed_memory WHERE status='active' ORDER BY created_at,id")).rows;
  assert.equal(parents.length,2);
  const target=await x.message('合成联系人两项运动都安排','2026-10-10T08:00:00.123456+08:00');
  const fact=await x.fact(target);
  const mergedText='合成联系人喜欢周三跑步，也喜欢周四游泳';
  let mergeCalls=0;
  const runtime={
   async adjudicate(){return [{candidate_index:0,action:'merge',replaced_memory_id:null,merged_memory_ids:parents.map(parent=>parent.id),merged_text:mergedText,duplicate_memory_id:null,
    relation:{kind:'supplement',related_memory_ids:parents.map(parent=>parent.id),explanation:'合成来源补充两段安排',claim_changed:false,condition_changed:false,
     evidence:[{message_id:m1,quote:'合成联系人喜欢周三跑步'},{message_id:m2,quote:'合成联系人喜欢周四游泳'},{message_id:target,quote:'合成联系人两项运动都安排'}]}}];},
   async verifyRelations(items){return [{candidate_index:0,supported:true,source_receipt:items[0].relation_source_receipt,claim_changed:false,condition_changed:false,
    evidence:[{message_id:m1,quote:'合成联系人喜欢周三跑步'},{message_id:m2,quote:'合成联系人喜欢周四游泳'},{message_id:target,quote:'合成联系人两项运动都安排'}]}];},
   async verifyMerge(_item,_decision,sourceIds,receipt){mergeCalls++;return {candidate_index:0,supported:true,text:mergedText,source_message_ids:[...sourceIds],source_receipt:receipt,
    evidence:[{message_id:m1,quote:'合成联系人喜欢周三跑步'},{message_id:m2,quote:'合成联系人喜欢周四游泳'},{message_id:target,quote:'合成联系人两项运动都安排'}]};},
  };
  const traced=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:runtime});
  const mergeTrace=await x.trace();
  const result=await traced.adoptBatch({contact_id:x.contact,...mergeTrace,signal:new AbortController().signal,facts:[{fact}]});
  assert.equal(mergeCalls,1);assert.equal(result.merged,1);
  const merged=(await x.c.query("SELECT * FROM public.confirmed_memory WHERE merge_parent_ids<>'{}'")).rows[0];
  assert.equal(merged.adoption_method,'auto');assert.equal(merged.source_dependency_mode,'all');assert.equal(merged.requires_all_sources,true);
  assert.deepEqual([...merged.merge_parent_ids].sort(),parents.map(parent=>parent.id).sort());
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='invalidated' AND id=ANY($1::uuid[])",[parents.map(parent=>parent.id)])).rows[0].n,2);
  assert.equal((await x.c.query("SELECT count(DISTINCT source_id)::int n FROM public.memory_extraction_trace_dependency WHERE trace_id=$1",[mergeTrace.trace_id])).rows[0].n,3);

  const m3=await x.message('合成联系人偏好早起','2026-10-21T08:00:00.123456+08:00');
  const m4=await x.message('合成联系人偏好早睡','2026-10-22T08:00:00.123456+08:00');
  const p3=randomUUID(),p4=randomUUID();
  await x.c.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,status)VALUES($1,$2,$3,'合成联系人偏好早起','preference',$4,'auto','active'),($5,$2,$3,'合成联系人偏好早睡','preference',$6,'auto','active')",
   [p3,x.owner,x.contact,[m3],p4,[m4]]);
  const freshParents=(await x.c.query("SELECT id FROM public.confirmed_memory WHERE status='active' AND id<>$1 ORDER BY id",[merged.id])).rows;
  const cancel=await x.message('合成联系人早晚都要安排','2026-10-23T08:00:00.123456+08:00');
  const cancelFact=await x.fact(cancel),cancelText='合成联系人习惯早晚都安排';
  const sourceId=(await x.c.query("SELECT source_document_id FROM public.message_source_ref WHERE message_id=$1",[cancel])).rows[0].source_document_id;
  let removed=false;
  const unstable={...runtime,
   async verifyRelations(items){return [{candidate_index:0,supported:true,source_receipt:items[0].relation_source_receipt,claim_changed:false,condition_changed:false,
    evidence:[{message_id:m3,quote:'合成联系人偏好早起'},{message_id:m4,quote:'合成联系人偏好早睡'},{message_id:cancel,quote:'合成联系人早晚都要安排'}]}];},
   async verifyMerge(_item,_decision,sourceIds,receipt){
    if(!removed){removed=true;await x.c.query("UPDATE public.source_document SET status='delete_requested' WHERE id=$1",[sourceId]);}
    return {candidate_index:0,supported:true,text:cancelText,source_message_ids:[...sourceIds],source_receipt:receipt,
     evidence:[{message_id:m3,quote:'合成联系人偏好早起'},{message_id:m4,quote:'合成联系人偏好早睡'},{message_id:cancel,quote:'合成联系人早晚都要安排'}]};
   }};
  const unstableRuntime=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:{...unstable,
   async adjudicate(){return [{candidate_index:0,action:'merge',replaced_memory_id:null,merged_memory_ids:freshParents.map(parent=>parent.id),merged_text:cancelText,duplicate_memory_id:null,
    relation:{kind:'supplement',related_memory_ids:freshParents.map(parent=>parent.id),explanation:'合成来源补充早晚安排',claim_changed:false,condition_changed:false,
     evidence:[{message_id:m3,quote:'合成联系人偏好早起'},{message_id:m4,quote:'合成联系人偏好早睡'},{message_id:cancel,quote:'合成联系人早晚都要安排'}]}}];}}});
  await assert.rejects(unstableRuntime.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact:cancelFact}]}),{code:'adoption_source_changed'});
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE text_content=$1",[cancelText])).rows[0].n,0);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='active' AND id=ANY($1::uuid[])",[freshParents.map(parent=>parent.id)])).rows[0].n,2);
 }finally{await x.fixture.close();}
});

test('合成PG：合并拒绝不同有效期或事件语义的父版本',async()=>{
 const x=await setup();
 try{
  const m1=await x.message('合成联系人偏好周末看展','2026-10-01T08:00:00.123456+08:00');
  const m2=await x.message('合成联系人偏好清晨慢跑','2026-10-02T08:00:00.123456+08:00');
  const adoption=new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed});
  await adoption.adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,
   facts:[{fact:await x.fact(m1)},{fact:await x.fact(m2,{topic:'other'})}]});
  const parents=(await x.c.query("SELECT id FROM public.confirmed_memory WHERE status='active' ORDER BY created_at,id")).rows;
  await x.c.query("UPDATE public.confirmed_memory SET valid_at='2026-10-01T00:00:00+00:00' WHERE id=$1",[parents[0].id]);
  const target=await x.message('合成联系人周末看展并清晨慢跑','2026-10-10T08:00:00.123456+08:00');
  const fact=await x.fact(target),mergedText='合成联系人周末看展并清晨慢跑';
  const runtime={
   async adjudicate(){return [{candidate_index:0,action:'merge',replaced_memory_id:null,merged_memory_ids:parents.map(parent=>parent.id),merged_text:mergedText,
    duplicate_memory_id:null,relation:{kind:'supplement',related_memory_ids:parents.map(parent=>parent.id),explanation:'合成来源补充两项安排',
     claim_changed:false,condition_changed:false,evidence:[{message_id:m1,quote:'合成联系人偏好周末看展'},{message_id:m2,quote:'合成联系人偏好清晨慢跑'},
      {message_id:target,quote:'合成联系人周末看展并清晨慢跑'}]}}];},
   async verifyRelations(items){return [{candidate_index:0,supported:true,source_receipt:items[0].relation_source_receipt,claim_changed:false,condition_changed:false,
    evidence:[{message_id:m1,quote:'合成联系人偏好周末看展'},{message_id:m2,quote:'合成联系人偏好清晨慢跑'},{message_id:target,quote:'合成联系人周末看展并清晨慢跑'}]}];},
   async verifyMerge(_item,_decision,sourceIds,receipt){return {candidate_index:0,supported:true,text:mergedText,source_message_ids:[...sourceIds],source_receipt:receipt,
    evidence:[{message_id:m1,quote:'合成联系人偏好周末看展'},{message_id:m2,quote:'合成联系人偏好清晨慢跑'},{message_id:target,quote:'合成联系人周末看展并清晨慢跑'}]};},
  };
  const pending=await new MemoryAdoption({ownerId:x.owner,transaction:x.transaction,embed:x.embed,adjudication:runtime})
   .adoptBatch({contact_id:x.contact,...(await x.trace()),signal:new AbortController().signal,facts:[{fact}]});
  assert.equal(pending.pending,1);assert.equal(pending.merged,0);
  assert.equal((await x.c.query("SELECT count(*)::int n FROM public.confirmed_memory WHERE status='active' AND id=ANY($1::uuid[])",[parents.map(parent=>parent.id)])).rows[0].n,2);
  const candidate=(await x.c.query('SELECT status,failure_reason FROM public.memory_candidate WHERE source_ids=$1',[[target]])).rows[0];
  assert.deepEqual(candidate,{status:'pending',failure_reason:'timeline:merge_incompatible'});
 }finally{await x.fixture.close();}
});
