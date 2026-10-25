import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityModelFixture} from './quality-model-fixture.mjs';
import {inputAnnotations} from './organization-quality-fixture.mjs';
import {sendEvents,useTool} from './support.mjs';
import {renderProfile} from '../src/l3-profile-workspace.ts';

function syntheticOrganizationResponse(body,res){
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:''}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
  const payload=JSON.parse(body.messages[0].content.find(block=>block.type==='text').text);
  const tools=(body.tools??[]).map(tool=>tool.name),memory=payload.memories[0];
  const text=memory.text??memory.verbatim_text;
  if(tools.includes('ScenarioVerificationOutput')){
    const results=payload.proposal.scenarios.flatMap((scenario,i)=>scenario.paragraphs.map((paragraph,j)=>({scenario_index:i,paragraph_index:j,
      supported:paragraph.text===text,evidence:paragraph.text===text?[{memory_id:memory.memory_id,quote:text}]:[]})));
    useTool(events,'ScenarioVerificationOutput',{results});
  }else if(tools.includes('ProfileVerificationOutput')){
    useTool(events,'ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,i)=>({entry_index:i,supported:entry.text===text,
      evidence:entry.text===text?[{memory_id:memory.memory_id,quote:text}]:[]}))});
  }else if(payload.layer==='l2'&&body.messages.length===1){
    useTool(events,'write',{path:'course.md',content:`<!-- META ${JSON.stringify({topic_key:'synthetic-course',title:'合成课程',hint:'共同课程经历'})} -->\n\n${text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`});
  }else if(payload.layer==='l3'&&body.messages.length===1){
    useTool(events,'write',{path:'profile.md',content:renderProfile({entries:[{text,kind:'fact',section:'life_context',basis:'底层合成记忆明确记载课程经历。',
      temporal_status:'historical',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]}]})});
  }else if(payload.layer==='l3')useTool(events,'ProfileProposalComplete',{});
  sendEvents(res,events);return true;
}
async function request(f,path,body,method=body===undefined?'GET':'POST',signal){
  const response=await fetch(f.url+path,{method,headers:{'Content-Type':'application/json'},signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
}
async function createCase(f,{owner=false,max=16,challenges=true}={}){
  const base=owner?'/api/memories/owner':`/api/contacts/${f.contactId}`;
  const memory=owner?f.ownerMemoryId:f.memoryId;
  const created=await request(f,`${base}/layered-memory/quality-input`,{memory_versions:[{memory_id:memory,revision:1}]});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const input=created.body.quality_input,annotations=inputAnnotations(input);
  if(challenges){
    const references=[{memory_id:memory,revision:1}];
    annotations.verifier_challenges={
      l2:{proposal:{scenarios:[{topic_key:'negative-course',title:'合成错误候选',hint:'合成反例',replaces:[],
        paragraphs:[{text:'双方从未参加任何课程。',references}]}]},expected_supported:false},
      l3:{proposal:{entries:[{text:'本人从未参加任何课程。',kind:'fact',section:'life_context',basis:'合成错误候选。',
        temporal_status:'historical',uncertainty:'',references}]},expected_supported:false},
    };
  }
  assert.equal((await request(f,`/api/layered-memory/quality-inputs/${input.case_id}/annotations`,annotations)).status,200);
  const createdRun=await request(f,'/api/layered-memory/quality-runs',{case_ids:[input.case_id],max_http_attempts:max,
    dataset_version:'quality-public-six-phase-v1',data_kind:'fixed_synthetic',purpose_confirmed:true});
  assert.equal(createdRun.status,200);
  return {input,report:createdRun.body.quality_report};
}

test('公开六阶段通过正式模型caller与持久租约，重开保留完整分母且无产品发布',{timeout:60000},async t=>{
  const f=await qualityModelFixture(t,{pluginPath:'test/organization-quality-model-plugin.ts',problemBudget:true,
    onRequest:(body,_req,res)=>syntheticOrganizationResponse(body,res)});
  const {input,report}=await createCase(f);
  const executed=await request(f,`/api/layered-memory/quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(executed.status,200,JSON.stringify(executed.body));
  const result=executed.body.quality_report;
  assert.equal(result.state,'complete',JSON.stringify(result.failures));
  assert.equal(result.cases[0].execution_state,'complete',JSON.stringify(result.failures));
  assert.equal(result.http_attempts_used,8);
  assert.equal(result.transport_kind,'sdk');
  assert.equal(f.requests.length,8);
  assert.equal(result.cases[0].output.l2_verification,true);
  assert.equal(result.cases[0].output.l3_verification,true);
  assert.equal(result.cases[0].output.l2_challenge,false);
  assert.equal(result.cases[0].output.l3_challenge,false);
  assert.equal(result.cases[0].output.l3.entries.length,1);
  assert.equal(result.cases[0].stage_evidence.l3_checkpoint.published_to_product,false);
  assert.equal(result.organization.status,'unknown');
  assert.equal(result.automatic_use_allowed,false);
  for(const phase of Object.values(result.phase_counts))assert.equal(phase.case_denominator,1);
  assert.equal(result.attempts.every(attempt=>attempt.outcome==='succeeded'),true);
  assert.equal(result.attempts.every(attempt=>attempt.response_model===null),true);
  assert.equal(result.attempts.every(attempt=>attempt.measurements.source_ref===`organization-quality-input-v1:${input.case_id}:${input.input_sha256}`),true);
  assert.deepEqual(result.token_usage,{prompt_tokens:24,completion_tokens:16,total_tokens:40});
  assert.doesNotMatch(JSON.stringify(f.requests),/expected_supported|independence_notes|supported_claims|prohibited_claims/);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM scenario_document_version')).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM layered_profile_version')).rows[0].n,0);
  const reopened=await request(f,`/api/layered-memory/quality-runs/${report.report_id}`);
  assert.deepEqual(reopened.body.quality_report,result);
  assert.equal((await request(f,`/api/layered-memory/quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true})).status,200);
  assert.equal(f.requests.length,8);
  const review={output_sha256:result.cases[0].output_sha256,reviewer:{kind:'agent',name:'合成逐项审阅'},decision:'approved',
    projection_passed:true,verifier_challenges_reviewed:true,claims:result.cases[0].review_items.map(item=>({path:item.path,supported:true,
      references:[{memory_id:f.memoryId,revision:1}],critical_errors:[],notes:'仅合成工程核验。'}))};
  assert.equal((await request(f,`/api/layered-memory/quality-inputs/${input.case_id}/review`,review)).status,200);
  const calibrated=await request(f,`/api/layered-memory/quality-runs/${report.report_id}/calibration`,{contract_id:result.contract_id,
    reviewer:{kind:'agent',name:'合成逐项审阅'},decision:'approved',notes:'固定合成输入内的实际模型调用工程标定。'});
  assert.equal(calibrated.status,200);
  assert.equal(calibrated.body.quality_report.organization.status,'unknown');
});

test('反例核验部分放行必须记失败，保留实际verdict与未运行分母',{timeout:60000},async t=>{
  const f=await qualityModelFixture(t,{pluginPath:'test/organization-quality-model-plugin.ts',onRequest:(body,_req,res)=>syntheticOrganizationResponse(body,res)});
  const {input,report}=await createCase(f);
  const annotations=(await request(f,`/api/layered-memory/quality-inputs/${input.case_id}`)).body.quality_input.annotations;
  annotations.verifier_challenges.l2.proposal.scenarios[0].paragraphs.unshift({text:'双方曾共同参加合成课程。',references:[{memory_id:f.memoryId,revision:1}]});
  assert.equal((await request(f,`/api/layered-memory/quality-inputs/${input.case_id}/annotations`,annotations)).status,200);
  const response=await request(f,`/api/layered-memory/quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(response.status,200);
  const result=response.body.quality_report;
  assert.equal(result.cases[0].execution_state,'failed');
  assert.equal(result.cases[0].error_code,'verifier_false_accept');
  assert.equal(result.cases[0].output.l2_challenge,true);
  assert.equal(result.cases[0].output.l2_challenge_isolation.verdict.results[0].supported,true);
  assert.equal(result.phase_counts.l3_challenge.not_run_cases,1);
  assert.equal(result.organization.status,'failed');
});

test('已发送后租约过期保留unknown，显式继续终结中断且不重放旧请求',{timeout:60000},async t=>{
  const f=await qualityModelFixture(t,{pluginPath:'test/organization-quality-model-plugin.ts',onRequest:async(body,_req,res,pool)=>{
    await pool.query("UPDATE organization_quality_case SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE execution_state='running'");
    return syntheticOrganizationResponse(body,res);
  }});
  const {report}=await createCase(f),path=`/api/layered-memory/quality-runs/${report.report_id}`;
  const first=await request(f,`${path}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(first.status,200);
  assert.equal(first.body.quality_report.attempts[0].outcome,'unknown');
  assert.equal(first.body.quality_report.attempts[0].response_payload,null);
  const resumed=await request(f,`${path}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(resumed.status,200);
  assert.equal(resumed.body.quality_report.state,'complete');
  assert.equal(resumed.body.quality_report.cases[0].error_code,'interrupted_request_unknown');
  assert.equal(resumed.body.quality_report.http_attempts_used,1);
  assert.equal(resumed.body.quality_report.phase_counts.l2_verification.not_run_cases,1);
  assert.equal(f.requests.length,1);
});

test('最终HTTP实体字符数等于上限可发送，超一字符拒绝且零HTTP',{timeout:60000},async t=>{
  const options={pluginPath:'test/organization-quality-model-plugin.ts',onRequest:(body,_req,res)=>syntheticOrganizationResponse(body,res)};
  const baseline=await qualityModelFixture(t,options);
  const baselineCase=await createCase(baseline,{max:1,challenges:false});
  const baselineResult=(await request(baseline,`/api/layered-memory/quality-runs/${baselineCase.report.report_id}/execute`,{allow_unreviewed_smoke:true})).body.quality_report;
  const measured=baselineResult.attempts[0].measurements.request_entity_characters;
  assert.equal(measured,[...JSON.stringify(baseline.requests[0])].length);
  const oldDigits=String(baseline.store.contract.budget.max_characters).length;
  let exact=measured;
  for(let iteration=0;iteration<3;iteration++)exact=measured+String(exact).length-oldDigits;
  const budget={...baseline.store.contract.budget,max_characters:exact};
  const atLimit=await qualityModelFixture(t,{...options,contractOverrides:{budget}});
  const atCase=await createCase(atLimit,{max:1,challenges:false});
  const at=(await request(atLimit,`/api/layered-memory/quality-runs/${atCase.report.report_id}/execute`,{allow_unreviewed_smoke:true})).body.quality_report;
  assert.equal(at.http_attempts_used,1);
  assert.equal(atLimit.requests.length,1);
  assert.equal(at.attempts[0].measurements.request_entity_characters,exact);
  const over=await qualityModelFixture(t,{...options,contractOverrides:{budget:{...budget,max_characters:exact-1}}});
  const overCase=await createCase(over,{max:1,challenges:false});
  const rejected=(await request(over,`/api/layered-memory/quality-runs/${overCase.report.report_id}/execute`,{allow_unreviewed_smoke:true})).body.quality_report;
  assert.equal(rejected.cases[0].error_code,'actual_request_budget_exceeded');
  assert.equal(rejected.http_attempts_used,0);
  assert.equal(over.requests.length,0);
  const evidence=rejected.cases[0].stage_evidence.budget_rejections[0];
  assert.equal(evidence.request_entity_characters,exact);
  assert.equal(evidence.limit_characters,exact-1);
  assert.equal(evidence.http_attempt_reserved,false);
  assert.equal(over.arbiter.snapshot().backgroundActive,0);
});

test('公开HTTP取消结算实际许可和未知用量，完成后执行不重放',{timeout:60000},async t=>{
  let release,arrived;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{arrived=resolve;});
  const f=await qualityModelFixture(t,{pluginPath:'test/organization-quality-model-plugin.ts',onRequest:async(body,_req,res)=>{
    arrived();await gate;return syntheticOrganizationResponse(body,res);
  }});
  const {report}=await createCase(f),path=`/api/layered-memory/quality-runs/${report.report_id}`;
  const controller=new AbortController();
  const pending=request(f,`${path}/execute`,{allow_unreviewed_smoke:true},'POST',controller.signal);
  const rejected=assert.rejects(pending,error=>error.name==='AbortError');
  await entered;
  controller.abort();await rejected;release();
  await f.arbiter.pauseAndDrain();
  let result;
  for(let attempt=0;attempt<30;attempt++){
    const observed=await request(f,path);
    result=observed.body.quality_report;
    if(result.state==='complete')break;
  }
  assert.equal(result.state,'complete');
  assert.equal(result.cases[0].execution_state,'failed');
  assert.equal(result.http_attempts_used,1);
  assert.equal(result.attempts[0].outcome,'cancelled');
  assert.deepEqual(result.token_usage,{prompt_tokens:null,completion_tokens:null,total_tokens:null});
  assert.equal(f.arbiter.snapshot().backgroundActive,0);
  assert.equal((await request(f,`${path}/execute`,{allow_unreviewed_smoke:true})).status,200);
  assert.equal(f.requests.length,1);
});

test('同run并发执行拒绝重复占用，撤销后晚到模型结果不重建输入与正文',{timeout:60000},async t=>{
  let release,arrived;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{arrived=resolve;});
  const f=await qualityModelFixture(t,{pluginPath:'test/organization-quality-model-plugin.ts',onRequest:async(body,_req,res)=>{
    arrived();await gate;return syntheticOrganizationResponse(body,res);
  }});
  const {input,report}=await createCase(f);
  const path=`/api/layered-memory/quality-runs/${report.report_id}`;
  const running=request(f,`${path}/execute`,{allow_unreviewed_smoke:true});
  await entered;
  try{
    assert.equal((await request(f,`${path}/execute`,{allow_unreviewed_smoke:true})).status,409);
    assert.equal(f.requests.length,1);
    assert.equal((await request(f,path,undefined,'DELETE')).status,200);
  }finally{release();}
  assert.equal((await running).status,404);
  assert.equal((await request(f,`/api/layered-memory/quality-inputs/${input.case_id}`)).status,404);
  assert.equal((await request(f,path)).status,404);
  assert.equal(f.requests.length,1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM organization_quality_attempt')).rows[0].n,0);
});

test('owner质量执行保留文字与时间白名单，不把私有来源定位发给模型',{timeout:60000},async t=>{
  const f=await qualityModelFixture(t,{pluginPath:'test/organization-quality-model-plugin.ts',onRequest:(body,_req,res)=>syntheticOrganizationResponse(body,res)});
  const {report}=await createCase(f,{owner:true,challenges:false});
  const executed=await request(f,`/api/layered-memory/quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(executed.status,200);
  const result=executed.body.quality_report;
  assert.equal(result.cases[0].execution_state,'complete',JSON.stringify(result.failures));
  assert.equal(result.cases[0].output.l3.entries[0].text,'本人曾参加合成课程。');
  assert.equal(f.requests.length,6);
  for(const body of f.requests){
    const payload=JSON.parse(body.messages[0].content.find(block=>block.type==='text').text);
    assert.equal(payload.memories.length,1);
    const memory=payload.memories[0];
    assert.deepEqual(Object.keys(memory).sort(),('verbatim_text'in memory?['memory_id','revision','verbatim_text','timing']:['memory_id','revision','text','timing']).sort());
    assert.doesNotMatch(JSON.stringify(payload),/source_ids|dependency_ids|input_manifest|source_refs|message_ids/);
    assert.equal(JSON.stringify(payload).includes(f.ownerId),false);
    assert.equal(JSON.stringify(payload).includes(f.contactId),false);
  }
});

test('公开run物理预算耗尽保留失败和未执行分母，不发送第四次请求',{timeout:60000},async t=>{
  const f=await qualityModelFixture(t,{pluginPath:'test/organization-quality-model-plugin.ts',onRequest:(body,_req,res)=>syntheticOrganizationResponse(body,res)});
  const {report}=await createCase(f,{max:3});
  const result=(await request(f,`/api/layered-memory/quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true})).body.quality_report;
  assert.equal(result.state,'complete');
  assert.equal(result.http_attempts_used,3);
  assert.equal(f.requests.length,3);
  assert.equal(result.cases[0].error_code,'physical_attempt_budget_exhausted');
  assert.equal(result.organization.status,'failed');
  assert.equal(result.phase_counts.l3_proposal.case_denominator,1);
  assert.equal(result.phase_counts.l3_proposal.not_run_cases,1);
  await request(f,`/api/layered-memory/quality-runs/${report.report_id}/execute`,{allow_unreviewed_smoke:true});
  assert.equal(f.requests.length,3);
});
