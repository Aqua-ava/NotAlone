import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {canonicalJSON,parseStoredJSON} from '../src/contact-overview-evidence.ts';
import {buildDimensionEvidence,candidateDigest,sourceStateDigest,dimensionEvidencePayload,bindDimensionEvidence,attachVerifiedSourceReceipt} from '../src/extraction-evidence.ts';
const owner='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',ref='44444444-4444-4444-8444-444444444444',source='55555555-5555-4555-8555-555555555555';
const snapshot=()=>parseStoredJSON(`{"source_ref_id":"${ref}","source_id":"${source}","source_kind":"source_document","locator":"line:1","raw_payload":{"id":900719925474099312345,"ratio":1.0},"source_content_sha256":"${'a'.repeat(64)}"}`);
const fact=()=>({text:'🙂有事直接打电话',category:'preference',subject:'contact',topic:'other',source_message_ids:[id],confidence:1,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成明确表达',requires_all_sources:true,source_dependency_mode:'any',_scene_name:'合成偏好',event:null,conditions:null,timing:{source_started_at:null,source_ended_at:null,source_time_complete:false}});
const window=()=>({owner_id:owner,contact_id:contact,messages:[{message_id:id,text:'🙂有事直接打电话',sender:'contact',occurred_at:'2026-01-01T08:00:00.123456+08:00',text_representation:'text',message_snapshot:{message_type:'text'},source_snapshots:[snapshot()]}],target_message_ids:[id]});
const verification=()=>({candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:'🙂有事直接打电话'}],verification_mode:'legacy-v4',model_verdict:'supported',model_issues:[],event:null,conditions:null});
function python(input){
 const script=`import json,sys\nfrom uuid import UUID\nfrom datetime import datetime\nfrom notalone.memory.models import MemoryCategory,MemoryTopic,FactSubject,SourceDependencyMode\nfrom notalone.memory.pragmatics import SpeechAct,AssertionStatus,FigurativeType\nfrom notalone.memory.events import MemoryEvent\nfrom notalone.memory.conditions import MemoryConditions\nfrom notalone.memory_extraction.models import MessageRef,MessageSender,ExtractionWindow,ExtractedFact\nfrom notalone.memory_extraction.verification import SourceVerificationResult,SourceVerificationVerdict,SourceVerificationMode,EvidenceQuote\nfrom notalone.memory_extraction.evidence import build_dimension_evidence\nfrom notalone.memory.evidence_binding import candidate_digest,source_state_digest\ndata=json.load(sys.stdin)\nf=data['fact'];w=data['window'];v=data.get('verification')\nwhen=lambda value:datetime.fromisoformat(value) if value is not None else None\nfact=ExtractedFact(text=f['text'],category=MemoryCategory(f['category']),subject=FactSubject(f['subject']),topic=MemoryTopic(f['topic']),source_message_ids=tuple(UUID(i) for i in f['source_message_ids']),confidence=float(f['confidence']),risk_flags=tuple(f['risk_flags']),valid_at=when(f['valid_at']),invalid_at=when(f['invalid_at']),speech_act=SpeechAct(f['speech_act']),assertion_status=AssertionStatus(f['assertion_status']),figurative_type=FigurativeType(f['figurative_type']),alternatives=tuple(f['alternatives']),interpretation_reason=f['interpretation_reason'],requires_all_sources=f['requires_all_sources'],source_dependency_mode=SourceDependencyMode(f['source_dependency_mode']),event=MemoryEvent.from_payload(f['event']),conditions=MemoryConditions.from_payload(f['conditions']))\nmessages=tuple(MessageRef(UUID(m['message_id']),m['text'],MessageSender(m['sender']),when(m['occurred_at']),tuple(m.get('source_snapshots',[])),m.get('message_snapshot',{}),m.get('message_type',m.get('message_snapshot',{}).get('message_type','unknown')),m.get('text_representation','unknown')) for m in w['messages'])\nwindow=ExtractionWindow(UUID(w['owner_id']),UUID(w['contact_id']),messages,tuple(UUID(i) for i in w['target_message_ids']) if w.get('target_message_ids') is not None else None)\nverified=SourceVerificationResult(v['candidate_index'],SourceVerificationVerdict(v['verdict']),(),tuple(EvidenceQuote(UUID(q['message_id']),q['quote']) for q in v['evidence']),verification_mode=SourceVerificationMode(v['verification_mode'])) if v else None\ne=build_dimension_evidence(window,fact,verified)\nprint(json.dumps({'candidate_sha256':candidate_digest(fact),'source_sha256':source_state_digest(messages[0].source_snapshots),'payload':e.to_payload(),'source_bound':e.source_bound},ensure_ascii=False))`;
 return JSON.parse(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',script],{input:canonicalJSON(input),env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}));
}
test('默认legacy-v4来源绑定与Python逐字段一致，保留Unicode/微秒/大整数及float1.0摘要',()=>{
 const w=window(),f=fact(),v=verification(),expected=python({window:w,fact:f,verification:v});
 const evidence=buildDimensionEvidence(w,f,v);
 assert.equal(candidateDigest(f),expected.candidate_sha256);assert.equal(sourceStateDigest(w.messages[0].source_snapshots),expected.source_sha256);
 assert.deepEqual(dimensionEvidencePayload(evidence),expected.payload);assert.equal(evidence.source_bound,expected.source_bound);assert.equal(evidence.source_bound,true);
 assert.equal(Object.keys(evidence).includes('source_bound'),false);
});

test('只有同次supported与source_bound同时满足才签原receipt，风险标签不替代来源资格',()=>{
 const w=window(),f={...fact(),risk_flags:['sarcasm']},v=verification();
 const supported=attachVerifiedSourceReceipt(w,f,v);
 assert.deepEqual(supported.verified_source_receipt,[candidateDigest(f),supported.dimension_evidence.window_sha256,'any',true]);
 assert.equal(supported.dimension_evidence.source_bound,true);
 const uncertain=attachVerifiedSourceReceipt(w,f,{...v,verdict:'uncertain',evidence:[]});
 assert.equal(uncertain.dimension_evidence.source_bound,true);assert.equal(uncertain.verified_source_receipt,null);
 const missing={...w,messages:[{...w.messages[0],source_snapshots:[]}]};
 assert.equal(attachVerifiedSourceReceipt(missing,f,v).verified_source_receipt,null);
 assert.equal(attachVerifiedSourceReceipt(w,f,null).verified_source_receipt,null);
});

test('完整窗口含context，来源raw/范围/候选变化与JSON恢复均需重验，不能复用旧bound',()=>{
 const w=window(),f=fact(),v=verification(),context='66666666-6666-4666-8666-666666666666';
 w.messages.unshift({...w.messages[0],message_id:context,text:'合成前文',occurred_at:'2025-12-31T00:00:00Z',sender:'self'});
 const expected=python({window:w,fact:f,verification:v}),e=buildDimensionEvidence(w,f,v);
 assert.deepEqual(dimensionEvidencePayload(e),expected.payload);assert.equal(e.messages.length,2);
 const persisted=JSON.parse(canonicalJSON(dimensionEvidencePayload(e)));assert.equal(persisted.source_bound,undefined);
 assert.equal(bindDimensionEvidence(persisted,w,f).source_bound,true);
 const changed={...w,messages:w.messages.map(m=>m.message_id===context?{...m,text:'变化后的前文'}:m)};
 assert.equal(bindDimensionEvidence(e,changed,f).source_bound,false);
 assert.equal(bindDimensionEvidence(e,{...w,owner_id:source},f).source_bound,false);
 assert.equal(bindDimensionEvidence(e,w,{...f,text:'不同候选'}).source_bound,false);
 const changedRaw={...w,messages:w.messages.map(m=>({...m,source_snapshots:m.source_snapshots.map(s=>({...s,raw_payload:{changed:true}}))}))};
 assert.equal(bindDimensionEvidence(e,changedRaw,f).source_bound,false);
});

test('事件和条件采纳字段、偏移时间及多种float摘要沿原Python合同，不纳入临时字段',()=>{
 const w=window(),position={message_id:id,char_start:0,char_end:1};
 const event={version:2,stage:'planned',stage_evidence:[position],stage_verified:true,occurrence_start:'2026-01-02T08:00:00.4+08:00',occurrence_end:null,occurrence_evidence:[position],occurrence_verified:true,occurrence_precision:'instant',occurrence_expression:'明早',anchor_message_id:id};
 const conditions={version:1,items:[{text:'合成条件',evidence:[position],source_supported:true}]};
 for(const confidence of [0,0.0000001,0.0001,0.5,1]){
  const f={...fact(),confidence,event,conditions,valid_at:'2026-01-01T08:00:00.4+08:00',invalid_at:'2026-01-02T00:00:00Z'};
  const expected=python({window:w,fact:f,verification:null});
  assert.equal(candidateDigest(f),expected.candidate_sha256);assert.deepEqual(dimensionEvidencePayload(buildDimensionEvidence(w,f)),expected.payload);
  assert.equal(candidateDigest({...f,_scene_name:'不改变候选身份',requires_all_sources:false}),expected.candidate_sha256);
 }
 const approved={...verification(),event,conditions};const attached=attachVerifiedSourceReceipt(w,fact(),approved);
 assert.equal(attached.dimension_evidence.candidate_sha256,candidateDigest({...fact(),event,conditions}));
});

test('缺失来源元数据保持未知，legacy拒绝ALL且不凭supported签造来源',()=>{
 const f=fact(),v=verification();
 for(const broken of [[],[{source_ref_id:ref,source_id:source}], [{...snapshot(),locator:''}], [{...snapshot(),source_content_sha256:null}], [{...snapshot(),source_id:'不是UUID'}]]){
  const w=window();w.messages[0].source_snapshots=broken;
  const expected=python({window:w,fact:f,verification:v}),e=buildDimensionEvidence(w,f,v);
  assert.deepEqual(dimensionEvidencePayload(e),expected.payload);assert.equal(e.source_bound,expected.source_bound);assert.equal(e.source_bound,false);
  assert.equal(attachVerifiedSourceReceipt(w,f,v).verified_source_receipt,null);
 }
 assert.throws(()=>buildDimensionEvidence(window(),{...f,source_dependency_mode:'all'},v),{code:'legacy_evidence_cannot_bind_all'});
 assert.throws(()=>buildDimensionEvidence(window(),f,{...v,verification_mode:'nullable-proof-v3'}),{code:'evidence_mode_unsupported'});
});

test('JSON恢复的伪片段不能取得source_bound，依据运行对象不可被调用方就地篡改',()=>{
 const w=window(),f=fact(),e=buildDimensionEvidence(w,f,verification());
 assert.throws(()=>{e.messages[0].text_sha256='0'.repeat(64);},TypeError);
 const clone=()=>JSON.parse(canonicalJSON(dimensionEvidencePayload(e)));
 const fractional=clone();fractional.paraphrase[0].candidate.start=0.2;
 assert.equal(bindDimensionEvidence(fractional,w,f).source_bound,false);
 const wrongHash=clone();wrongHash.paraphrase[0].source.span.sha256='0'.repeat(64);
 assert.equal(bindDimensionEvidence(wrongHash,w,f).source_bound,false);
});
