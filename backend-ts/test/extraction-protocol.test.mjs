import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDirectExtraction, parseSourceVerification, validateSourceVerification, ExtractionProtocolError, LOW_VALUE_EXTRACTION_CONFIDENCE} from '../src/memory/extraction/protocol.ts';
import {DIRECT_EXTRACTION_PROMPT,DIRECT_EXTRACTION_SCHEMA} from '../src/memory/extraction/prompts.ts';

test('提取合同对齐宁缺毋滥、独立完整与归纳合并，alternatives 只记真实歧义，低把握候选按阈值丢弃',()=>{
 assert.match(DIRECT_EXTRACTION_PROMPT,/宁缺毋滥：寒暄、只推进本次对话的一次性指令和没有后续价值的零碎感叹不输出/);
 assert.match(DIRECT_EXTRACTION_PROMPT,/独立完整：每条记忆离开当前对话仍能读懂/);
 assert.match(DIRECT_EXTRACTION_PROMPT,/归纳合并：同一话题的连续多句（因果、前因后果，或同一计划的几个侧面）合并为一条完整记忆/);
 const alternativeDescription=String(DIRECT_EXTRACTION_SCHEMA.properties.scenes.items.properties.memories.items.properties.alternatives.description);
 assert.match(alternativeDescription,/不得写入 alternatives/);
 assert.match(alternativeDescription,/只在两种真实歧义下必须非空/);
 assert.match(String(DIRECT_EXTRACTION_SCHEMA.properties.scenes.items.properties.memories.items.properties.confidence.description),/低于 0\.5 的候选会被丢弃并记入追踪/);
 assert.equal(LOW_VALUE_EXTRACTION_CONFIDENCE,0.5);
});

const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const window={owner_id:id,contact_id:other,messages:[{message_id:id,text:'有事爱直接打电话',sender:'contact',occurred_at:'2024-02-01T00:00:00Z',text_representation:'text'}],target_message_ids:[id]};
function memory(overrides={}) {return {text:'联系人有事爱直接打电话',category:'preference',subject:'contact',topic:'other',source_message_ids:[id],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话明确表达偏好',...overrides};}
function direct(...memories){return {scenes:[{scene_name:'沟通偏好',memories}]};}

test('direct服务逐条拒绝非法候选，完整场景保留来源与时间',()=>{
 const result=parseDirectExtraction(direct(memory(),memory({source_message_ids:[other]}),memory({confidence:2})),window);
 assert.equal(result.rejected_count,2);
 assert.equal(result.accepted.length,1);
 assert.equal(result.accepted[0].text,'联系人有事爱直接打电话');
 assert.equal(result.accepted[0].requires_all_sources,true);
 assert.equal(result.accepted[0].timing.source_started_at,'2024-02-01T00:00:00Z');
 assert.deepEqual(result.accepted[0].risk_flags,[]);
});

test('只保留日期原话的空事件不伪造发生主张',()=>{
 const scoped={...window,messages:[{...window.messages[0],text:'周六去看看'}]};
 const event={version:2,stage:'unknown',stage_evidence:[],occurrence_start:null,occurrence_end:null,occurrence_evidence:[{message_id:id,char_start:0,char_end:2}],occurrence_precision:'day',occurrence_expression:'周六',anchor_message_id:id};
 const result=parseDirectExtraction(direct(memory({event})),scoped);
 assert.equal(result.rejected_count,0);assert.equal(result.accepted[0].event,null);
});

test('原ISO微秒参与来源身份和窗口顺序，非法日期不得宽松归一化',()=>{
 assert.throws(()=>parseDirectExtraction(direct(memory()),{...window,messages:[{...window.messages[0],occurred_at:'2024-02-30T00:00:00Z'}]}),ExtractionProtocolError);
 assert.throws(()=>parseDirectExtraction(direct(memory()),{...window,messages:[{...window.messages[0],occurred_at:'2024-02-01T00:00:00.000002Z'},{...window.messages[0],message_id:other,occurred_at:'2024-02-01T00:00:00.000001Z'}]}),ExtractionProtocolError);
});

test('完整引句不能为未消解所有者签supported，原模型判定仍可审计',()=>{
 const source={...window.messages[0],text:'我哥前天把他的雨伞借给我了。'};
 const scoped={...window,messages:[source]},facts=parseDirectExtraction(direct(memory({text:'联系人原话：“'+source.text+'”'})),scoped).accepted;
 const checked=validateSourceVerification([{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:source.text}]}],scoped,facts)[0];
 assert.equal(checked.model_verdict,'supported');assert.equal(checked.verdict,'uncertain');assert.deepEqual(checked.issues,['pragmatics']);
});

test('direct E不按消息观察点补有效期，来源未知日历保持未知',()=>{
 const facts=parseDirectExtraction(direct(memory({valid_at:'2024-02-01T00:00:00Z',invalid_at:'2024-02-02T00:00:00Z'})),window).accepted;
 assert.equal(facts[0].valid_at,null);assert.equal(facts[0].invalid_at,null);
 const event={version:2,stage:'planned',stage_evidence:[],occurrence_start:'2025-01-01T00:00:00',occurrence_end:'2026-01-01T00:00:00',occurrence_evidence:[],occurrence_precision:'year',occurrence_expression:'明年',anchor_message_id:id};
 const parsed=parseDirectExtraction(direct(memory({event})),window);
 assert.equal(parsed.rejected_count,0);assert.equal(parsed.accepted[0].event.occurrence_start,null);assert.equal(parsed.accepted[0].event.occurrence_precision,'unknown');
});

test('生产V逐项隔离缺失重复和非法quote，不丢弃相邻有效结果',()=>{
 const facts=parseDirectExtraction(direct(memory(),memory({text:'另一条合成偏好'}),memory({text:'第三条合成偏好'})),window).accepted;
 const one={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:window.messages[0].text}]};
 const payload={results:[one,{...one,candidate_index:1},{...one,candidate_index:1}]};
 const results=parseSourceVerification(payload,window,facts,{isolate_items:true});
 assert.deepEqual(results.map(r=>r.verdict),['supported','unsupported','unsupported']);
 assert.deepEqual(results[1].issues,['insufficient_evidence']);
 assert.throws(()=>parseSourceVerification(payload,window,facts),ExtractionProtocolError);
});

test('事件发生日期只接受活动来源原偏移与独立V位置，过期计划不补完成',()=>{
 const source={...window.messages[0],text:'去年去了北京',occurred_at:'2024-02-01T00:00:00Z',source_snapshots:[{source_ref_id:other,source_id:other,source_kind:'source_document',locator:'synthetic:1',raw_payload:{time_iso:'2024-02-01T08:00:00+08:00'},source_content_sha256:'a'.repeat(64)}]};
 const scoped={...window,messages:[source]};
 const ref={message_id:id,char_start:0,char_end:2};
 const event={version:2,stage:'occurred',stage_evidence:[ref],occurrence_start:'2023-01-01T00:00:00+08:00',occurrence_end:'2024-01-01T00:00:00+08:00',occurrence_evidence:[ref],occurrence_precision:'year',occurrence_expression:'去年',anchor_message_id:id};
 const facts=parseDirectExtraction(direct(memory({event})),scoped).accepted;
 const result={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:'去年去了北京'}],event_verification:{stage_verdict:'supported',occurrence_verdict:'supported',stage_evidence:[ref],occurrence_evidence:[ref]}};
 const checked=validateSourceVerification([result],scoped,facts)[0].event;
 assert.equal(checked.stage_verified,true);assert.equal(checked.occurrence_verified,true);assert.equal(checked.occurrence_start,event.occurrence_start);
 const quotes={...result,event_verification:{...result.event_verification,stage_evidence:[{message_id:id,quote:'去年去了北京'}],occurrence_evidence:[{message_id:id,quote:'去年'}]}};
 const located=parseSourceVerification({results:[quotes]},scoped,facts,{isolate_items:true})[0];
 assert.equal(located.verdict,'supported');assert.deepEqual(located.event.occurrence_evidence,[ref]);
 const ambiguous={...scoped,messages:[{...source,text:'去年去了北京，去年去了上海'}]};
 assert.equal(parseSourceVerification({results:[{...quotes,evidence:[{message_id:id,quote:'去年去了北京'}]}]},ambiguous,facts,{isolate_items:true})[0].verdict,'unsupported');
 const unknown=validateSourceVerification([result],{...scoped,messages:[{...source,source_snapshots:[]}]},facts)[0];
 assert.equal(unknown.event,null,'来源日历缺失时时间不可采纳');assert.equal(unknown.time_unverified,true);
 assert.equal(unknown.verdict,'supported');assert.equal(unknown.model_verdict,'supported');
 const unverified=validateSourceVerification([{...result,event_verification:{...result.event_verification,occurrence_verdict:'uncertain'}}],scoped,facts)[0];
 assert.equal(unverified.verdict,'supported','时间核验不确定不再拖垮整条候选');
 assert.equal(unverified.event,null);assert.equal(unverified.time_unverified,true);assert.equal(unverified.model_verdict,'supported');
 assert.equal(unverified.evidence.length,1);
 const isolated=parseSourceVerification({results:[{...result,event_verification:{...result.event_verification,
  stage_evidence:[{message_id:id,char_start:0,char_end:999}]}}]},scoped,facts,{isolate_items:true})[0];
 assert.equal(isolated.verdict,'unsupported');assert.deepEqual(isolated.issues,['insufficient_evidence']);
 assert.throws(()=>validateSourceVerification([{...result,event_verification:{...result.event_verification,stage_evidence:[]}}],scoped,facts),ExtractionProtocolError);
});

test('时间表达没有逐字证据时按发生时间未知收口，合法核验输出不再被判成契约异常',()=>{
 const source={...window.messages[0],text:'咱们这周末去爬山吧'};
 const scoped={...window,messages:[source]};
 const event={version:2,stage:'unknown',stage_evidence:[{message_id:id,char_start:0,char_end:2}],occurrence_start:null,occurrence_end:null,
  occurrence_evidence:[],occurrence_precision:'unknown',occurrence_expression:'这周末',anchor_message_id:id};
 const facts=parseDirectExtraction(direct(memory({event})),scoped).accepted;
 assert.equal(facts[0].event.occurrence_expression,'这周末');
 const result={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:source.text}],
  event_verification:{stage_verdict:'uncertain',occurrence_verdict:'uncertain',stage_evidence:[{message_id:id,char_start:0,char_end:2}],occurrence_evidence:[]}};
 const checked=validateSourceVerification([result],scoped,facts)[0];
 assert.equal(checked.verdict,'supported','只有时间核验不过时正文候选仍可入库');
 assert.deepEqual(checked.issues,[]);
 assert.equal(checked.model_verdict,'supported');assert.equal(checked.evidence.length,1,'合法核验输出保留原证据，不能伪装成证据不足');
 assert.equal(checked.event,null,'不可采纳的时间标注被丢弃');assert.equal(checked.time_unverified,true);
 const quoted={...result,event_verification:{...result.event_verification,stage_evidence:[{message_id:id,quote:source.text}]}};
 const isolated=parseSourceVerification({results:[quoted]},scoped,facts,{isolate_items:true})[0];
 assert.equal(isolated.verdict,'supported');assert.equal(isolated.event,null);assert.equal(isolated.time_unverified,true);assert.equal(isolated.evidence.length,1);
});

test('已取消事件缺少发生时间证据仍可采纳，但时间保持未知；错误发生证据只丢时间不拒绝候选',()=>{
 const source={...window.messages[0],text:'周末的爬山活动取消了'};
 const scoped={...window,messages:[source]};
 const cancelled={version:2,stage:'cancelled',stage_evidence:[{message_id:id,char_start:0,char_end:2}],occurrence_start:null,occurrence_end:null,
  occurrence_evidence:[],occurrence_precision:'unknown',occurrence_expression:'周末',anchor_message_id:id};
 const cancelledFacts=parseDirectExtraction(direct(memory({event:cancelled})),scoped).accepted;
 const cancelledResult={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:source.text}],
  event_verification:{stage_verdict:'supported',occurrence_verdict:'uncertain',stage_evidence:[{message_id:id,char_start:0,char_end:2}],occurrence_evidence:[]}};
 const adopted=validateSourceVerification([cancelledResult],scoped,cancelledFacts)[0];
 assert.equal(adopted.verdict,'supported');
 assert.equal(adopted.event.stage_verified,true);assert.equal(adopted.event.occurrence_verified,false);assert.equal(adopted.event.occurrence_start,null,'缺少发生证据时只丢时间标注，不丢已取消事件');
 const wrongOccurrence={...cancelledResult,event_verification:{...cancelledResult.event_verification,
  stage_verdict:'supported',occurrence_verdict:'supported',occurrence_evidence:[{message_id:id,char_start:5,char_end:7}]}};
 const planned={version:2,stage:'planned',stage_evidence:[{message_id:id,char_start:0,char_end:2}],occurrence_start:'2026-09-19T00:00:00+08:00',
  occurrence_end:'2026-09-21T00:00:00+08:00',occurrence_evidence:[],occurrence_precision:'day',occurrence_expression:'周末',anchor_message_id:id};
 const plannedFacts=parseDirectExtraction(direct(memory({event:planned})),scoped).accepted;
 assert.equal(plannedFacts[0].event.occurrence_start,'2026-09-19T00:00:00+08:00');
 const rejected=validateSourceVerification([wrongOccurrence],scoped,plannedFacts)[0];
 assert.equal(rejected.verdict,'supported','发生证据不含时间表达只丢弃时间标注');
 assert.equal(rejected.event,null);assert.equal(rejected.time_unverified,true);
 assert.equal(rejected.model_verdict,'supported');
});

test('没有时间提案时忽略多余的 event_verification，不因此拒绝正文候选',()=>{
 const scoped={...window};
 const facts=parseDirectExtraction(direct(memory()),scoped).accepted;
 assert.equal(facts[0].event,null);
 const result={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:window.messages[0].text}],
  event_verification:{stage_verdict:'uncertain',occurrence_verdict:'uncertain',
   stage_evidence:[{message_id:id,char_start:0,char_end:2}],occurrence_evidence:[]}};
 const checked=validateSourceVerification([result],scoped,facts)[0];
 assert.equal(checked.verdict,'supported');
 assert.equal(checked.event,null);
 assert.equal(checked.time_unverified,undefined,'没有时间提案就没有可丢弃的时间标注');
});

test('条件必须独立覆盖且核验位置按Unicode码点回指正文',()=>{
 const scoped={...window,messages:[{...window.messages[0],text:'🙂出差时不打电话'}]};
 const conditions={version:1,items:[{text:'出差时',evidence:[{message_id:id,char_start:1,char_end:4}]}]};
 const facts=parseDirectExtraction(direct(memory({conditions})),scoped).accepted;
 const result={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:'出差时不打电话'}],condition_verification:[{index:0,verdict:'supported',evidence:[{message_id:id,char_start:1,char_end:4}]}]};
 assert.equal(validateSourceVerification([result],scoped,facts)[0].conditions.items[0].source_supported,true);
 const unverified=validateSourceVerification([{...result,condition_verification:[{index:0,verdict:'uncertain',evidence:[]}]}],scoped,facts)[0];
 assert.equal(unverified.verdict,'unsupported');assert.ok(unverified.issues.includes('condition'));
 assert.equal(facts[0].conditions.items[0].source_supported,false);
 for(const bad of [[],[{index:0,verdict:'supported',evidence:[]}],[{index:0,verdict:'supported',evidence:[{message_id:id,char_start:1,char_end:10}]}]])assert.throws(()=>validateSourceVerification([{...result,condition_verification:bad}],scoped,facts),ExtractionProtocolError);
});

test('V全覆盖、真实候选来源及target证据缺一则整批失败',()=>{
 const facts=parseDirectExtraction(direct(memory()),window).accepted;
 const supported={candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:id,quote:'直接打电话'}]};
 assert.equal(validateSourceVerification([supported],window,facts)[0].verdict,'supported');
 for(const bad of [[],[supported,supported],[{...supported,candidate_index:true}],[{...supported,evidence:[]}],[{...supported,issues:['time']}],[{...supported,evidence:[{message_id:other,quote:'直接打电话'}]}],[{...supported,evidence:[{message_id:id,quote:'爱发语音'}]}]])assert.throws(()=>validateSourceVerification(bad,window,facts),ExtractionProtocolError);
 assert.throws(()=>validateSourceVerification(Array.from({length:61},(_,candidate_index)=>({...supported,candidate_index})),window,Array(61).fill(facts[0])),ExtractionProtocolError);
});
