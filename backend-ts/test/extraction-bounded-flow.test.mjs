import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {boundedExtractionPrompt,boundedExtractionSchema,compileGroundedLabels,sourceUnits,bindBoundedFact} from '../src/extraction-bounded.ts';
import {parseProofProposal,verifyBoundedProof} from '../src/extraction-bounded-proof.ts';
import {runExtractionFlow} from '../src/extraction-flow.ts';
import {attachVerifiedSourceReceipt,buildBoundedDimensionEvidence,dimensionEvidencePayload} from '../src/extraction-evidence.ts';

const owner='11111111-1111-4111-8111-111111111111';
const contact='22222222-2222-4222-8222-222222222222';
const message='33333333-3333-4333-8333-333333333333';
const ref='44444444-4444-4444-8444-444444444444';
const source='55555555-5555-4555-8555-555555555555';
const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const pythonEnvironment={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname};

function sampleWindow(text='我刚到家。'){
 return {owner_id:owner,contact_id:contact,messages:[{
  message_id:message,text,sender:'contact',occurred_at:'2026-01-01T00:00:00+00:00',message_type:'text',text_representation:'text',
  source_snapshots:[{source_ref_id:ref,source_id:source,source_kind:'source_document',locator:'line:1',
   raw_payload:{time_iso:'2026-01-01T08:00:00+08:00'},source_content_sha256:'a'.repeat(64)}],
 }],target_message_ids:[message]};
}

const label={kind:'event',subject:'contact',topic:'other',dependency:null,unresolved:false,confidence:0.92,sensitivity:'none'};
const arrivalProof={version:3,
 atom_links:[{rule_id:'BR_AUTHOR_ARRIVAL_V1',variant_id:'direct_quote',source:{message_id:message,start:0,end:5},candidate:{start:7,end:12}}],
 reference:[{rule_id:'BR_AUTHOR_ARRIVAL_V1',mention:{message_id:message,start:0,end:1},target:{message_id:message,start:0,end:1},binding:null}],
 reported:[{rule_id:'BR_AUTHOR_ARRIVAL_V1',frame:'direct',source:{message_id:message,start:0,end:5},candidate:{start:7,end:12}}]};

test('bounded-v1提示、动态schema与Python固定合同一致',()=>{
 const expected=JSON.parse(execFileSync(python,['-c',`import hashlib,json
from uuid import UUID
from datetime import datetime
from notalone.memory_extraction.models import ExtractionWindow,MessageRef,MessageSender
from notalone.memory_extraction.grounded_adapter import grounded_v2_prompt,BOUNDED_DEPENDENCY_PROMPT_PROFILE,grounded_schema
m=MessageRef(UUID(${JSON.stringify(message)}),'我刚到家。',MessageSender.CONTACT,datetime.fromisoformat('2026-01-01T08:00:00+08:00'),text_representation='text')
w=ExtractionWindow(UUID(${JSON.stringify(owner)}),UUID(${JSON.stringify(contact)}),(m,),target_message_ids=(m.message_id,))
print(json.dumps({'hash':hashlib.sha256(grounded_v2_prompt(BOUNDED_DEPENDENCY_PROMPT_PROFILE).encode()).hexdigest(),'schema':grounded_schema(w)},ensure_ascii=False))`],{env:pythonEnvironment,encoding:'utf8',timeout:20000}));
 assert.equal(createHash('sha256').update(boundedExtractionPrompt()).digest('hex'),expected.hash);
 assert.deepEqual(boundedExtractionSchema(sampleWindow()),expected.schema);
});

test('grounded-v2编译条件计划与Python逐字段一致',()=>{
 const window=sampleWindow('如果天晴，我计划明天只跑约3公里。');
 const draft={units:Object.fromEntries(sourceUnits(window).map((unit,index)=>[unit.id,{...label,kind:index===0?'condition':'plan'}]))};
 const actual=compileGroundedLabels(window,draft).map(({timing,requires_all_sources,_scene_name,source_dependency_mode,event,conditions,...fact})=>fact);
 const expected=JSON.parse(execFileSync(python,['-c',`import json,sys
from uuid import UUID
from datetime import datetime
from notalone.memory_extraction.models import ExtractionWindow,MessageRef,MessageSender
from notalone.memory_extraction.grounded import compile_labels
x=json.loads(sys.argv[1])
m=MessageRef(UUID(x['message']),x['text'],MessageSender.CONTACT,datetime.fromisoformat('2026-01-01T08:00:00+08:00'),text_representation='text',message_type='text')
w=ExtractionWindow(UUID(x['owner']),UUID(x['contact']),(m,),target_message_ids=(m.message_id,))
print(json.dumps(compile_labels(w,x['draft']),ensure_ascii=False))`,JSON.stringify({message,owner,contact,text:window.messages[0].text,draft})],{env:pythonEnvironment,encoding:'utf8',timeout:20000}));
 assert.deepEqual(actual,expected);
});

test('nullable-proof-v3重新核验真实来源并生成同Python的v4依据摘要',()=>{
 const window=sampleWindow(),fact=bindBoundedFact(window,compileGroundedLabels(window,{units:{'0:0':label}})[0]);
 const proposal=parseProofProposal(arrivalProof),checked=verifyBoundedProof(proposal,window,fact);
 assert.equal(checked.status,'verified');assert.equal(checked.semantic_basis.rules[0].rule_id,'BR_AUTHOR_ARRIVAL_V1');
 const verification={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:'我刚到家。'}],
  verification_mode:'nullable-proof-v3',model_verdict:'supported',model_issues:[],event:null,conditions:null,proof:proposal,proof_verification:checked};
 const evidence=buildBoundedDimensionEvidence(window,fact,verification);
 assert.equal(evidence.version,4);assert.equal(evidence.source_bound,true);assert.deepEqual(dimensionEvidencePayload(evidence).target_message_ids,[message]);
 assert.equal(dimensionEvidencePayload(evidence).candidate_sha256,'6062e9d8601129953e3c5fa5a25fc190e8efe4d6819e5c452dba3229356fed54');
 assert.equal(dimensionEvidencePayload(evidence).window_sha256,'506aee49ac1a1f807e22dbd02c26a59da1011f227feff0ee1377a0cf9c7e481f');
});

test('bounded flow执行GroundedMemoryLabels与单次V且非法提案整项拒绝',async()=>{
 const window=sampleWindow(),calls=[],events=[];
 const reply=(name,args)=>({blocks:[{type:'tool-call',name,arguments:JSON.stringify(args)}]});
 const result=await runExtractionFlow({window,mode:'bounded-runtime-v1',signal:new AbortController().signal,max_retries:0,retry_delay_ms:0,
  requireCurrent:async()=>{},record:async event=>events.push(event),invoke:async request=>{
   calls.push(request);return request.purpose==='extraction'?reply('GroundedMemoryLabels',{units:{'0:0':label}}):
    reply('SourceVerificationOutput',{results:[{candidate_index:0,verdict:'supported',issues:[],
     evidence:[{message_id:message,quote:'我刚到家。'}],proof:arrivalProof}]});
  }});
 assert.deepEqual(calls.map(call=>[call.purpose,call.tool.name]),[['extraction','GroundedMemoryLabels'],['verification','SourceVerificationOutput']]);
 assert.equal(result.failure_kind,null);assert.equal(result.accepted[0].source_dependency_mode,'all');
 const attached=attachVerifiedSourceReceipt(window,result.accepted[0],result.verification[0].result);
 assert.equal(attached.dimension_evidence.version,4);assert.ok(attached.dimension_evidence.semantic_basis);
 assert.ok(events.some(event=>event.stage==='grounded_draft'));assert.ok(events.some(event=>event.stage==='verification_contract'));
 for(const invalid of [
  {...arrivalProof,version:2},
  {...arrivalProof,atom_links:[{...arrivalProof.atom_links[0],source:{...arrivalProof.atom_links[0].source,start:true}}]},
  {...arrivalProof,atom_links:[arrivalProof.atom_links[0],arrivalProof.atom_links[0]]},
 ])assert.throws(()=>parseProofProposal(invalid),{failure_kind:'invalid_output'});
});

test('proof为空仍生成ALL正文v4依据但不授予语义支持',()=>{
 const window=sampleWindow(),fact=bindBoundedFact(window,compileGroundedLabels(window,{units:{'0:0':label}})[0]);
 const evidence=buildBoundedDimensionEvidence(window,fact,null);
 assert.equal(evidence.version,4);assert.equal(evidence.source_bound,true);assert.equal(evidence.semantic_basis,null);
});
