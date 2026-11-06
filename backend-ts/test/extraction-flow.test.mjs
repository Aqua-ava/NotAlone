import test from 'node:test';
import assert from 'node:assert/strict';
import {runExtractionFlow} from '../src/memory/extraction/flow.ts';
import {canonicalJSON} from '../src/memory/evidence/canonical-json.ts';
const owner='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222',message='33333333-3333-4333-8333-333333333333';
const window={owner_id:owner,contact_id:contact,messages:[{message_id:message,text:'有事爱直接打电话',sender:'contact',occurred_at:'2024-02-01T00:00:00Z',text_representation:'text'}],target_message_ids:[message]};
const fact={text:'联系人有事爱直接打电话',category:'preference',subject:'contact',topic:'other',source_message_ids:[message],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话明确表达偏好'};
const reply=(name,args)=>({blocks:[{type:'tool-call',name,arguments:args}],receipt:{outcome:'succeeded'}});
test('E坏结构按原业务上限重试，V只请求一次，非支持结果不进入候选',async()=>{
 const calls=[],events=[];
 const result=await runExtractionFlow({window,signal:new AbortController().signal,max_retries:1,retry_delay_ms:0,
  requireCurrent:async()=>{},record:async event=>{events.push(event);},
  invoke:async request=>{calls.push(request);if(calls.length===1)return reply('DirectMemoryExtractionOutput','{"scenes":');
   if(calls.length===2)return reply('DirectMemoryExtractionOutput',JSON.stringify({scenes:[{scene_name:'沟通偏好',memories:[fact]}]}));
   return reply('SourceVerificationOutput',JSON.stringify({results:[{candidate_index:0,verdict:'unsupported',issues:['meaning'],evidence:[{message_id:message,quote:'有事爱直接打电话'}]}]}));
  }});
 assert.deepEqual(calls.map(call=>call.purpose),['extraction','extraction','verification']);
 assert.equal(result.extraction_completed,true);assert.equal(result.failure_kind,null);
 assert.deepEqual(result.accepted,[]);assert.equal(result.rejected_count,1);
 assert.ok(events.some(event=>event.stage==='extraction_recovery'));
});

test('低把握候选解析后记 low_value_dropped 丢弃，不进核验也不影响批次完成',async()=>{
 const events=[];
 const kept={...fact,confidence:0.5,text:'联系人有事爱直接打电话'};
 const result=await runExtractionFlow({window,signal:new AbortController().signal,retry_delay_ms:0,
  requireCurrent:async()=>{},record:async event=>{events.push(event);},
  invoke:async request=>request.purpose==='extraction'
   ?reply('DirectMemoryExtractionOutput',JSON.stringify({scenes:[{scene_name:'闲聊',memories:[{...fact,confidence:0.2,text:'联系人也说了一些零碎的话。'},kept]}]}))
   :reply('SourceVerificationOutput',JSON.stringify({results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:'有事爱直接打电话'}]}]}))});
 const dropped=events.filter(event=>event.stage==='low_value_dropped');
 assert.equal(dropped.length,1);
 assert.equal(dropped[0].payload.threshold,0.5);assert.equal(dropped[0].payload.confidence,0.2);
 const traceId=text=>events.find(event=>event.stage==='candidate_raw'&&event.payload.fields.text===text)?.candidate_trace_id;
 assert.equal(dropped[0].candidate_trace_id,traceId('联系人也说了一些零碎的话。'));
 assert.deepEqual(events.find(event=>event.stage==='verification_input').payload.candidate_trace_ids,[traceId('联系人有事爱直接打电话')]);
 assert.deepEqual(result.accepted.map(item=>item.confidence),[0.5]);
 assert.equal(result.rejected_count,0);assert.equal(result.extraction_completed,true);
});

test('追踪故障直接终止本批，不转成模型非法输出或重新调用',async()=>{
 let calls=0,records=0;
 await assert.rejects(runExtractionFlow({window,signal:new AbortController().signal,retry_delay_ms:0,
  requireCurrent:async()=>{},invoke:async()=>{calls++;return reply('DirectMemoryExtractionOutput','{"scenes":[]}');},
  record:async()=>{records++;throw Object.assign(new Error('合成追踪写入失败'),{code:'trace_write_failed'});}}),{code:'trace_write_failed'});
 assert.equal(calls,1);assert.equal(records,1);
});

test('E仅重试已结算的短暂HTTP失败，未知/非重试失败不重发且追踪可写JSON',async()=>{
 for(const [retryable,outcome,expected] of [[true,'failed',2],[true,'unknown',1],[false,'failed',1]]){
  let calls=0;const records=[];
  const result=await runExtractionFlow({window,signal:new AbortController().signal,max_retries:1,retry_delay_ms:0,
   requireCurrent:async()=>{},record:async event=>{records.push(JSON.parse(canonicalJSON(event.payload)));},
   invoke:async()=>{if(++calls===1)throw Object.assign(new Error('合成HTTP失败'),{code:'extraction_model_call_failed',retryable,receipt:{outcome}});
    return reply('DirectMemoryExtractionOutput','{"scenes":[]}');}});
  assert.equal(calls,expected);assert.equal(result.extraction_completed,expected===2);
  assert.ok(records.some(record=>record.raw===null));
 }
});

test('每个原始候选在解析前获得稳定ID，结构拒绝与核验去向可回到原候选',async()=>{
 const events=[];
 const supported={...fact,text:'联系人有事爱直接打电话'},unsupported={...fact,text:'联系人不爱直接打电话'},question={...fact,text:'联系人有事会直接打电话吗？',speech_act:'question'};
 const result=await runExtractionFlow({window,signal:new AbortController().signal,retry_delay_ms:0,
  requireCurrent:async()=>{},record:async event=>{events.push(event);},
  invoke:async request=>request.purpose==='extraction'
   ?reply('DirectMemoryExtractionOutput',JSON.stringify({scenes:[{scene_name:'沟通偏好',memories:[null,supported,unsupported,question]},{scene_name:'',memories:[fact]}]}))
   :reply('SourceVerificationOutput',JSON.stringify({results:[
    {candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:'有事爱直接打电话'}]},
    {candidate_index:1,verdict:'unsupported',issues:['meaning'],evidence:[{message_id:message,quote:'有事爱直接打电话'}]},
   ]})),
 });
 const raw=events.filter(event=>event.stage==='candidate_raw');
 assert.equal(raw.length,5);
 assert.equal(new Set(raw.map(event=>event.candidate_trace_id)).size,5);
 for(const event of raw)assert.match(event.candidate_trace_id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 const parses=events.filter(event=>event.stage==='parse');
 assert.equal(parses.length,5);
 assert.ok(events.indexOf(raw.at(-1))<events.indexOf(parses[0]),'全部原候选先登记，再逐项解析');
 const traceId=text=>raw.find(event=>event.payload.fields.text===text).candidate_trace_id;
 assert.deepEqual(parses.filter(event=>event.payload.disposition==='structure_rejected').map(event=>event.candidate_trace_id),[raw[0].candidate_trace_id,raw[4].candidate_trace_id]);
 assert.equal(events.find(event=>event.stage==='verification'&&event.payload.disposition==='unsupported_rejected').candidate_trace_id,traceId(unsupported.text));
 assert.deepEqual(result.accepted.map(item=>item.text),[supported.text,question.text]);
 assert.deepEqual(result.candidate_trace_ids,[traceId(supported.text),traceId(question.text)]);
 assert.equal(result.rejected_count,3);
 assert.deepEqual(events.find(event=>event.stage==='verification_input').payload.candidate_trace_ids,[traceId(supported.text),traceId(unsupported.text)]);
});
