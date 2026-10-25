import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
import {syntheticProvider} from './pure-ts-provider-fixture.mjs';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {renderProfile} from '../src/l3-profile-workspace.ts';
import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
function respond(body,res){
 const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:''}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
 const payload=JSON.parse(body.messages[0].content.find(block=>block.type==='text').text),tools=(body.tools??[]).map(tool=>tool.name),memory=payload.memories[0],text=memory.text??memory.verbatim_text;
 if(tools.includes('ScenarioVerificationOutput'))useTool(events,'ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scenario,i)=>scenario.paragraphs.map((paragraph,j)=>({scenario_index:i,paragraph_index:j,supported:paragraph.text===text,evidence:paragraph.text===text?[{memory_id:memory.memory_id,quote:text}]:[]})))});
 else if(tools.includes('ProfileVerificationOutput'))useTool(events,'ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,i)=>({entry_index:i,supported:entry.text===text,evidence:entry.text===text?[{memory_id:memory.memory_id,quote:text}]:[]}))});
 else if(payload.layer==='l2'&&body.messages.length===1)useTool(events,'write',{path:'course.md',content:`<!-- META ${JSON.stringify({topic_key:'synthetic-course',title:'合成课程',hint:'共同课程经历'})} -->\n\n${text}\n<!-- SOURCES ${JSON.stringify([{memory_id:memory.memory_id,revision:memory.revision}])} -->`});
 else if(payload.layer==='l3'&&body.messages.length===1)useTool(events,'write',{path:'profile.md',content:renderProfile({entries:[{text,kind:'fact',section:'life_context',basis:'合成底层记忆明确记载。',temporal_status:'historical',uncertainty:'',references:[{memory_id:memory.memory_id,revision:memory.revision}]}]})});
 else if(payload.layer==='l3')useTool(events,'ProfileProposalComplete',{});
 sendEvents(res,events);
}
test('纯 TS 产品公开质量入口执行六阶段，物理调用有据、重开不重放且不发布产品记忆',{timeout:45000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),source=randomUUID(),memory=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成手录',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,$3,'双方曾共同参加合成课程。','common_fact','study',$4,'manual')",[memory,owner,contact,[source]]);
 const ledger=join(f.directory,'synthetic-problem.sqlite');await writeFile(ledger,'',{mode:0o600});const budget=new DatabaseSync(ledger);
 try{budget.exec('CREATE TABLE budget(problem TEXT,max_calls INTEGER,deadline REAL,used INTEGER,streak INTEGER); CREATE TABLE rounds(id TEXT PRIMARY KEY,hypothesis TEXT,evidence TEXT,outcome TEXT)');budget.prepare('INSERT INTO budget VALUES(?,?,?,0,0)').run('pure-ts-public-synthetic-quality',8,Date.now()/1000+600);budget.prepare('INSERT INTO rounds VALUES(?,?,NULL,NULL)').run('r1','只验证本机假供应商的8次累计物理护栏');}finally{budget.close();}
 const provider=await syntheticProvider(t,respond),environment={NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SYNTHETIC_PROVIDER_URL:provider.url,NOTALONE_PROBLEM_BUDGET:ledger,NOTALONE_PROBLEM_ROUND:'r1'};
 const app=await f.start(environment);
 const current=await app.request(`/api/contacts/${contact}/layered-memory`);assert.equal(current.status,200);
 const disabled=await app.request(`/api/contacts/${contact}/layered-memory/disable`,{settings_generation:current.data.layered_memory.settings_generation});assert.equal(disabled.status,200);assert.equal(disabled.data.layered_memory.enabled,false);
 const created=await app.request(`/api/contacts/${contact}/layered-memory/quality-input`,{memory_versions:[{memory_id:memory,revision:1}]});assert.equal(created.status,200,JSON.stringify(created));const input=created.data.quality_input;
 const references=[{memory_id:memory,revision:1}];
 assert.equal((await app.request(`/api/layered-memory/quality-inputs/${input.case_id}/annotations`,{
  input_sha256:input.input_sha256,reviewer:{kind:'agent',name:'合成审阅者'},dimension:'subject',scenario_key:input.case_id,decision:'approved',supported_claims:[],prohibited_claims:[],independence_notes:'只核验工程合同，不登记人工质量资格。',empty_support_policy:'normal',
  verifier_challenges:{l2:{proposal:{scenarios:[{topic_key:'negative-course',title:'合成错误候选',hint:'合成反例',replaces:[],paragraphs:[{text:'双方从未参加任何课程。',references}]}]},expected_supported:false},l3:{proposal:{entries:[{text:'双方从未参加任何课程。',kind:'fact',section:'life_context',basis:'合成反例。',temporal_status:'historical',uncertainty:'',references}]},expected_supported:false}},
 })).status,200);
 const run=await app.request('/api/layered-memory/quality-runs',{case_ids:[input.case_id],max_http_attempts:16,dataset_version:'pure-ts-public-quality-v1',data_kind:'fixed_synthetic',purpose_confirmed:true});assert.equal(run.status,200,JSON.stringify(run));const id=run.data.quality_report.report_id;
 const completed=await app.request(`/api/layered-memory/quality-runs/${id}/execute`,{allow_unreviewed_smoke:true});
 assert.equal(completed.status,200,JSON.stringify(completed));const report=completed.data.quality_report;
 assert.equal(report.state,'complete',JSON.stringify(report.failures));assert.equal(report.cases[0].execution_state,'complete',JSON.stringify(report.failures));assert.equal(report.http_attempts_used,8);assert.equal(provider.requests.length,8);
 const accounting=new DatabaseSync(ledger,{readOnly:true});try{assert.equal(accounting.prepare('SELECT used FROM budget').get().used,8);}finally{accounting.close();}
 assert.equal(report.organization.status,'unknown');assert.equal(report.automatic_use_allowed,false);assert.equal(report.cases[0].stage_evidence.l3_checkpoint.published_to_product,false);
 await app.request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
 const restarted=await f.start(environment),reopened=await restarted.request(`/api/layered-memory/quality-runs/${id}`);assert.equal(reopened.status,200);assert.deepEqual(reopened.data.quality_report,report);assert.equal(provider.requests.length,8);
 await restarted.request('/api/runtime/shutdown',{});assert.equal(await restarted.host.waitForExit(7000),true);
});
