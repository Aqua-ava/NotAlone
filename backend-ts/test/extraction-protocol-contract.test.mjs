import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {parseDirectExtraction} from '../src/extraction-protocol.ts';
import {buildSourceVerificationContract,buildSourceVerificationPayload} from '../src/extraction-protocol-contract.ts';

const id='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222';
const window={owner_id:id,contact_id:contact,messages:[{message_id:id,text:'🙂出差时不打电话',sender:'contact',occurred_at:'2024-02-01T00:00:00Z',text_representation:'text'}],target_message_ids:[id]};
const memory={text:'出差时不打电话',category:'taboo',subject:'contact',topic:'other',source_message_ids:[id],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话',conditions:{version:1,items:[{text:'出差时',evidence:[{message_id:id,char_start:1,char_end:4}]}]}};
const script=`import json,sys
from uuid import UUID
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch
from notalone.memory_extraction.models import ExtractionWindow,MessageRef,MessageSender
from notalone.memory_extraction.flow import _to_fact
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime,_verification_text
w,p=json.loads(sys.argv[1])
messages=tuple(MessageRef(UUID(m['message_id']),m['text'],MessageSender(m['sender']),datetime.fromisoformat(m['occurred_at']) if m['occurred_at'] else None,text_representation=m.get('text_representation','unknown'),source_snapshots=tuple(m.get('source_snapshots',()))) for m in w['messages'])
window=ExtractionWindow(UUID(w['owner_id']),UUID(w['contact_id']),messages,tuple(UUID(x) for x in w['target_message_ids']))
facts=tuple(_to_fact({**x,'_requires_all_sources':True}) for x in p)
captured={}
def invoke(model,**kwargs):
 captured.update(prompt=kwargs['messages'][0]['content'],schema=kwargs['schema'])
 return SimpleNamespace(tool_calls=[{'name':'SourceVerificationOutput','args':{'results':[{'candidate_index':i,'verdict':'unsupported','issues':['insufficient_evidence'],'evidence':[]} for i in range(len(facts))]}}])
with patch('notalone.memory_extraction.verification_adapters.invoke_traced_model',side_effect=invoke):
 LangChainSourceVerificationRuntime(model=object()).verify(window=window,facts=facts)
print(json.dumps({'contract':captured,'payload':json.loads(_verification_text(window,facts))},ensure_ascii=False))`;

test('V动态prompt/schema和实际用户payload逐字段对照原Python adapter',()=>{
 const env={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname};
 const event={version:1,stage:'planned',stage_evidence:[],occurrence_start:null,occurrence_end:null,occurrence_evidence:[]};
 for(const row of [memory,{...memory,conditions:null},{...memory,event},{...memory,event:{...event,version:2,occurrence_precision:'unknown',occurrence_expression:null,anchor_message_id:null}}]){
  const expected=JSON.parse(execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',script,JSON.stringify([window,[row]])],{env,encoding:'utf8',timeout:20000}));
  const facts=parseDirectExtraction({scenes:[{scene_name:'合成',memories:[row]}]},window).accepted;
  assert.deepEqual(buildSourceVerificationContract(facts),expected.contract);
  assert.deepEqual(buildSourceVerificationPayload(window,facts),expected.payload);
 }
});
