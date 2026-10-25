import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {sendEvents,startReplyServiceHost,useTool} from './reply-service-runtime-support.mjs';
import {canonicalJSON} from '../src/contact-overview-evidence.ts';
import {auditReplyRuntimeSources,captureReplyRuntimeSourceAttempt,replyComparisonCollectorBinding} from '../src/reply-comparison-sources.ts';

const INPUT=['current_intent','available_facts','unknowns','allowed_changes','current_message','recent_context'];
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const inputFor=member=>Object.fromEntries(INPUT.filter(key=>key in member).map(key=>[key,member[key]]));
function projectCase(member){
 const context=Object.fromEntries(['available_facts','current_message','recent_context'].filter(key=>key in member).map(key=>[key,member[key]]));
 const strategy=Object.fromEntries(['unknowns','allowed_changes'].filter(key=>key in member).map(key=>[key,member[key]]));
 return {type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:member.current_intent,
  user_instruction:canonicalJSON(strategy),include_relationship_context:true,context_text:canonicalJSON(context),excluded_message_ids:[]};
}
function modelPayload(body){
 const found=[];
 const visit=value=>{
  if(Array.isArray(value)){value.forEach(visit);return;}
  if(value&&typeof value==='object'){
   if(Array.isArray(value.evidence)&&value.fidelity_contract)found.push(value);
   for(const [key,item]of Object.entries(value))if(key!=='evidence')visit(item);
   return;
  }
  if(typeof value!=='string')return;
  let parsed;try{parsed=JSON.parse(value);}catch{const start=value.indexOf('{'),end=value.lastIndexOf('}');if(start<0||end<=start)return;try{parsed=JSON.parse(value.slice(start,end+1));}catch{return;}}
  if(parsed!==value)visit(parsed);
 };
 visit(body);assert.equal(found.length,1);return found[0];
}
test('实际DSH请求完成后从PG重建v2来源并交现有审计通过',{timeout:60000},async t=>{
 const f=await createStorageFixture(),dataset=JSON.parse(await readFile(new URL('../../backend/tests/fixtures/fidelity/synthetic-v1.json',import.meta.url),'utf8'));
 const member=dataset.cases.find(item=>item.case_id==='paired-decline');assert.ok(member);
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'manual'};
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成采集本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成采集联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);
 let captured;
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,close:()=>f.close()},(_req,res,requests,events)=>{
  const request=structuredClone(requests.at(-1).body),payload=modelPayload(request),capturedAt=new Date().toISOString();
  assert.deepEqual(payload.evidence.map(source=>source.evidence_id),['c1','c2','c3']);
  captured={body:request,capturedAt,requestSha256:hash(request),responseStartedAt:new Date().toISOString()};
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'这次先不参加了，谢谢你邀请。',basis:'仅按本次输入表达',citation_ids:[payload.evidence[0].evidence_id],risk_notes:['合成运行，不代表真实关系结论。']}]});
  sendEvents(res,events);
 });
 await host.request('/configure-model',{physical_limit:4});
 const input={contact_id:contact,idempotency_key:randomUUID(),content:projectCase(member),skill_disabled:true},startedAt=new Date().toISOString(),result=await host.request('/generate',{id:randomUUID(),scope,body:input}),endedAt=new Date().toISOString();
 assert.ok(captured);
 const requestRow=(await f.client.query('SELECT id,owner_id,contact_id,conversation_binding_id,skill_id,skill_version_id,skill_name,skill_selection_method,skill_selection_reason,skill_load_state,skill_loaded_resources FROM reply_request WHERE idempotency_key=$1 AND state=\'completed\'',[input.idempotency_key])).rows[0];
 assert.ok(requestRow);
 const persistedSources=(await f.client.query('SELECT evidence_id,kind,evidence_text,owner_id,contact_id,conversation_binding_id,source_ids FROM reply_context_evidence WHERE reply_request_id=$1 ORDER BY ordinal',[requestRow.id])).rows;
 assert.deepEqual(persistedSources.map(source=>source.kind),['user_purpose','user_draft','user_current_chat']);
 const collectorBinding=replyComparisonCollectorBinding(new URL('../..',import.meta.url).pathname,['--production-runtime-capture',member.case_id]);
 assert.match(collectorBinding.source_tree_sha256,/^[a-f0-9]{64}$/);
 const capturedSource=captureReplyRuntimeSourceAttempt({member,body:captured.body,
  request:{request_id:requestRow.id,hash_kind:'canonical_json_sha256',sha256:captured.requestSha256},scope,
  case_id:member.case_id,repeat:1,arm:'new',attempt_id:randomUUID(),started_at:startedAt,captured_at:captured.capturedAt,response_started_at:captured.responseStartedAt,
  persisted_sources:persistedSources,collector_binding:collectorBinding});
 const candidates=(await f.client.query(`SELECT c.id AS candidate_id,c.reply_request_id,c.owner_id,c.contact_id,c.conversation_binding_id,c.candidate_text AS text,c.basis,c.risk_notes,c.message_group AS messages,
  COALESCE((SELECT json_agg(k.evidence_id ORDER BY k.ordinal) FROM reply_candidate_citation k WHERE k.candidate_id=c.id),'[]'::json) AS citation_ids
  FROM reply_candidate c WHERE c.reply_request_id=$1 ORDER BY c.ordinal`,[requestRow.id])).rows;
 const persistence={catalog_sha256:capturedSource.catalog_sha256,request_id:requestRow.id,scope,snapshot:persistedSources,snapshot_sha256:hash(persistedSources),
  candidate_snapshot:candidates,request_snapshot:requestRow,output:result,output_sha256:hash(result),observed_at:new Date(Date.parse(endedAt)+1).toISOString(),verified_after_completion:true};
 const runtimeSources={schema_version:'reply-runtime-sources-v1',scope,request_id:requestRow.id,attempts:[capturedSource.attempt],persistence};
 const row={case_id:member.case_id,repeat:1,arm:'new',commit:collectorBinding.source_commit,scope,physical_calls:1,case_sha256:hash(member),input_sha256:hash(inputFor(member)),
  started_at:startedAt,ended_at:endedAt,request_sha256:captured.requestSha256,output:result,runtime_sources:runtimeSources};
 const audit=auditReplyRuntimeSources(member,row,result,'model_run');
 assert.equal(audit.status,'verified',audit.reason);
 assert.equal(audit.output_scope,'complete_http_result');
 assert.equal(audit.attempt_count,1);
 assert.equal(capturedSource.catalog.entries.every(entry=>!('model_evidence_id'in entry)),true);
 assert.deepEqual(capturedSource.model_alias_mapping,capturedSource.catalog.entries.map((entry,index)=>({model_evidence_id:`c${index+1}`,evidence_id:entry.evidence_id})));
});
