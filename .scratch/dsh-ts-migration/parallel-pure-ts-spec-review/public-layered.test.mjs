/** 分层管理公开入口贯穿正式worker、DSH与本机假供应商。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const source=process.env.NOTALONE_SPEC_REVIEW_SOURCE;
if(!source)throw new Error('需要固定源码快照');
const load=path=>import(pathToFileURL(`${source}/backend-ts/${path}`).href);
const {pureTsFixture}=await load('test/pure-ts-runtime-fixture.mjs');
const {syntheticProvider}=await load('test/pure-ts-provider-fixture.mjs');
const {sendEvents,useTool}=await load('test/reply-service-runtime-support.mjs');
const {renderProfile}=await load('src/l3-profile-workspace.ts');
const evidence={candidate:'ff45f2ec296c4cead326d2ab6f3cf7770c9396ab',checks:[]};

test('正式launcher：21条冻结目标继续原任务与dirty维护',{timeout:60000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),sourceId=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成手录',$4,21)",[sourceId,owner,contact,'a'.repeat(64)]);
 const memories=[];
 for(let i=0;i<21;i++){const id=randomUUID();memories.push(id);await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,$3,$4,'common_fact','study',$5,'manual')",[id,owner,contact,`双方共同参加了合成课程${i+1}。`,[sourceId]]);}
 const payloads=[];let proposalSerial=0;
 const provider=await syntheticProvider(t,async(body,res)=>{
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:''}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  const payload=JSON.parse(body.messages[0].content.find(item=>item.type==='text').text),tools=(body.tools??[]).map(item=>item.name);
  payloads.push(payload);
  const first=payload.memories[0],text=first.text??first.verbatim_text;
  if(tools.includes('ScenarioVerificationOutput'))useTool(events,'ScenarioVerificationOutput',{results:payload.proposal.scenarios.flatMap((scenario,i)=>scenario.paragraphs.map((paragraph,j)=>({scenario_index:i,paragraph_index:j,supported:true,evidence:paragraph.references.map(ref=>{const m=payload.memories.find(item=>item.memory_id===ref.memory_id);return {memory_id:m.memory_id,quote:m.text??m.verbatim_text};})})))});
  else if(tools.includes('ProfileVerificationOutput'))useTool(events,'ProfileVerificationOutput',{results:payload.proposal.entries.map((entry,i)=>({entry_index:i,supported:true,evidence:entry.references.map(ref=>{const m=payload.memories.find(item=>item.memory_id===ref.memory_id);return {memory_id:m.memory_id,quote:m.text??m.verbatim_text};})}))});
  else if(payload.layer==='l2'&&body.messages.length===1){proposalSerial++;useTool(events,'write',{path:`course-${proposalSerial}.md`,content:`<!-- META ${JSON.stringify({topic_key:`course-${proposalSerial}`,title:'合成课程',hint:'共同课程经历'})} -->\n\n${text}\n<!-- SOURCES ${JSON.stringify([{memory_id:first.memory_id,revision:first.revision}])} -->`});}
  else if(payload.layer==='l3'&&body.messages.length===1)useTool(events,'write',{path:'profile.md',content:renderProfile({entries:[{text,kind:'fact',section:'life_context',basis:'合成原记忆明确记载。',temporal_status:'historical',uncertainty:'',references:[{memory_id:first.memory_id,revision:first.revision}]}]})});
  else if(payload.layer==='l3')useTool(events,'ProfileProposalComplete',{});
  sendEvents(res,events);
 });
 const app=await f.start({NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SYNTHETIC_PROVIDER_URL:provider.url});
 const path=`/api/contacts/${contact}/layered-memory`;
 const read=async()=>{const result=await app.request(path);assert.equal(result.status,200,JSON.stringify(result));return result.data.layered_memory;};
 const wait=async(predicate)=>{let value;for(let i=0;i<180;i++){value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('分层公开状态未终结：'+JSON.stringify(value));};
 let current=await read();
 const disabled=await app.request(`${path}/disable`,{settings_generation:current.settings_generation});assert.equal(disabled.status,200);current=disabled.data.layered_memory;
 const enabled=await app.request(`${path}/enable`,{settings_generation:current.settings_generation,purpose_confirmed:true});assert.equal(enabled.status,200,JSON.stringify(enabled));
 const taskId=enabled.data.layered_memory.work_id;
 const paused=await wait(value=>['paused','failed'].includes(value.status)||value.status==='ready'&&value.remaining_count===0);assert.equal(paused.status,'paused',JSON.stringify(paused));assert.equal(paused.covered_count,20);assert.equal(paused.remaining_count,1);
 const continued=await app.request(`${path}/continue`,{settings_generation:paused.settings_generation,work_revision:paused.work_revision});assert.equal(continued.status,200,JSON.stringify(continued));assert.equal(continued.data.layered_memory.work_id,taskId);
 const completed=await wait(value=>['failed','paused'].includes(value.status)||value.status==='ready'&&value.remaining_count===0);assert.equal(completed.status,'ready',JSON.stringify(completed));assert.equal(completed.covered_count,21);assert.equal(completed.remaining_count,0);assert.equal(completed.work_id,taskId);
 evidence.checks.push({name:'21 frozen targets explicit continuation',covered_count:completed.covered_count,physical_calls:provider.requests.length});
 // dirty由正式状态维护器推进；SQL只改变合成原记忆，不预造派生或任务。
 const addition=randomUUID();await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method) VALUES($1,$2,$3,'双方共同参加了新增合成课程。','common_fact','study',$4,'manual')",[addition,owner,contact,[sourceId]]);
 const next=await wait(value=>value.work_id!==taskId&&(['failed','paused'].includes(value.status)||value.status==='ready'&&value.remaining_count===0));assert.ok(['paused','ready'].includes(next.status),JSON.stringify(next));assert.equal(next.eligible_count,22);
 evidence.checks.push({name:'dirty input notification starts new frozen target',eligible_count:next.eligible_count,covered_count:next.covered_count});
 // 确认原暂停任务不会被后台扫描偷偷继续。
 const countBefore=provider.requests.length;await f.client.query('NOTIFY layered_memory_changed');
 const preserved=await read();assert.equal(preserved.work_id,next.work_id);assert.equal(preserved.status,next.status);assert.equal(provider.requests.length,countBefore);
 const pausedRows=(await f.client.query('SELECT state,target_manifest FROM layered_memory_job WHERE task_id=$1',[next.work_id])).rows[0];assert.ok(['paused','complete'].includes(pausedRows.state));assert.equal(pausedRows.target_manifest.length,22);
 await app.request(`${path}/disable`,{settings_generation:preserved.settings_generation});
 const calls=provider.requests.length;await app.request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
 evidence.checks.push({name:'paused coverage not automatically resumed; shutdown drained',physical_calls:calls});
});
test.after(async()=>{if(process.env.NOTALONE_SPEC_REVIEW_RESULT)await writeFile(process.env.NOTALONE_SPEC_REVIEW_RESULT,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});});
