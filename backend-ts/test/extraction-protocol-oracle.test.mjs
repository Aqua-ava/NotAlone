import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {parseDirectExtraction,parseSourceVerification} from '../src/extraction-protocol.ts';

const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const window={owner_id:id,contact_id:other,messages:[{message_id:id,text:'我哥前天把他的雨伞借给我了。',sender:'contact',occurred_at:'2024-02-01T00:00:00Z',text_representation:'text'}],target_message_ids:[id]};
const memory={text:'联系人原话：“'+window.messages[0].text+'”',category:'relationship_note',subject:'contact',topic:'family',source_message_ids:[id],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话'};
const script=`import json,sys
from uuid import UUID
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch
from notalone.memory_extraction.models import ExtractionWindow,MessageRef,MessageSender
from notalone.memory_extraction.flow import ExtractionFlow,_to_fact
from notalone.memory_extraction.direct_adapter import DirectExtractionRuntime
from notalone.memory_extraction.verification import validate_source_verification
from notalone.memory_extraction.verification_isolation import isolate_verification_payloads
from notalone.memory_extraction.event_quote_positions import event_quote_positions
from notalone.memory_extraction.errors import ExtractionInvalidOutputError
w,memories,payloads,isolated=json.loads(sys.argv[1])
messages=tuple(MessageRef(UUID(m['message_id']),m['text'],MessageSender(m['sender']),datetime.fromisoformat(m['occurred_at']) if m['occurred_at'] else None,text_representation=m.get('text_representation','unknown'),source_snapshots=tuple(m.get('source_snapshots',()))) for m in w['messages'])
window=ExtractionWindow(UUID(w['owner_id']),UUID(w['contact_id']),messages,tuple(UUID(x) for x in w['target_message_ids']))
if payloads is None:
 response=SimpleNamespace(tool_calls=[{'name':'DirectMemoryExtractionOutput','args':{'scenes':[{'scene_name':'合成','memories':memories}]}}])
 with patch('notalone.memory_extraction.direct_adapter.invoke_traced_model',return_value=response):
  outcome=ExtractionFlow(runtime=DirectExtractionRuntime(model=object(),max_retries=0)).run(window)
 keys=('text','category','subject','topic','source_message_ids','confidence','valid_at','invalid_at','speech_act','assertion_status','figurative_type','alternatives','interpretation_reason','requires_all_sources','source_dependency_mode')
 result={'accepted':[{k:getattr(f,k) for k in keys} for f in outcome.accepted],'rejected_count':outcome.rejected_count,'extraction_completed':outcome.extraction_completed}
else:
 facts=tuple(_to_fact({**m,'_requires_all_sources':True}) for m in memories)
 try:
  payloads=event_quote_positions(tuple(payloads),window=window,facts=facts)
  if isolated: payloads=isolate_verification_payloads(payloads,window=window,facts=facts,mode='legacy-v4')
  results=validate_source_verification(payloads,window=window,facts=facts)
  result=[{'candidate_index':r.candidate_index,'verdict':r.verdict,'issues':r.issues,'evidence':[{'message_id':q.message_id,'quote':q.quote} for q in r.evidence],'model_verdict':r.model_verdict,'model_issues':r.model_issues} for r in results]
 except ExtractionInvalidOutputError: result={'error':'invalid_output'}
print(json.dumps(result,ensure_ascii=False,default=lambda value:value.isoformat() if isinstance(value,datetime) else str(value)))`;
function oracle(w,memories,payloads=null,isolated=false){return JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script,JSON.stringify([w,memories,payloads,isolated])],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8',timeout:20000}));}
function project(f){return Object.fromEntries(['text','category','subject','topic','source_message_ids','confidence','valid_at','invalid_at','speech_act','assertion_status','figurative_type','alternatives','interpretation_reason','requires_all_sources','source_dependency_mode'].map(k=>[k,f[k]]));}

test('E混合合法与非法候选逐项结果对照原DirectExtractionRuntime→Flow',()=>{
 const missing={...memory};delete missing.valid_at;
 const memories=[memory,{...memory,confidence:[0.9]},{...memory,source_message_ids:[other]},missing,{...memory,subject:'other'}, {...memory,confidence:'0.5'}];
 const actual=parseDirectExtraction({scenes:[{scene_name:'合成',memories}]},window);
 assert.deepEqual({...actual,accepted:actual.accepted.map(project)},oracle(window,memories));
});

test('V覆盖、逐字来源、原角色歧义及逐项隔离对照原Python validator',()=>{
 const normal={...memory,text:'联系人借到了雨伞'},facts=parseDirectExtraction({scenes:[{scene_name:'合成',memories:[memory,normal]}]},window).accepted;
 const one={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:window.messages[0].text}]},two={...one,candidate_index:1};
 const cases=[[one,two],[one],[one,{...two,evidence:[{message_id:id,quote:'没有这段原话'}]}],[one,two,two],[{...one,candidate_index:true},two],[{...one,issues:['subject']},two]];
 for(const isolated of [false,true])for(const rows of cases){let actual;try{actual=parseSourceVerification({results:rows},window,facts,{isolate_items:isolated}).map(({candidate_index,verdict,issues,evidence,model_verdict,model_issues})=>({candidate_index,verdict,issues,evidence,model_verdict,model_issues}));}catch{actual={error:'invalid_output'};}
  assert.deepEqual(actual,oracle(window,[memory,normal],rows,isolated));}
});
