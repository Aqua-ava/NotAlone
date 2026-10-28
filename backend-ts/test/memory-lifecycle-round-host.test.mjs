import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
import {lifecycleHost} from './memory-lifecycle-host-support.mjs';
import {seedRoundInput,seedRoundMemory,sendSyntheticStrictTool,sendSyntheticTool,untilLifecycle} from './memory-lifecycle-round-support.mjs';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';

function roundProvider(state,{profileSupported=true}={}){
 return createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw),names=(input.tools??[]).map(tool=>tool.name);
  const toolName=names[0]??input.tools?.[0]?.function?.name;
  state.seen.push({names,message_count:input.messages?.length});
  if(toolName==='DirectMemoryExtractionOutput'){
   sendSyntheticTool(res,names[0],{scenes:[]});return;
  }
  if(['read','write','edit'].every(name=>names.includes(name))&&!names.includes('ProfileProposalComplete')){
   if(input.messages.length===1)sendSyntheticTool(res,'write',{path:'round-course.md',content:
    `<!-- META {"topic_key":"round-course","title":"合成课程","hint":"共同经历"} -->\n\n${state.text}\n<!-- SOURCES [{"memory_id":"${state.memory}","revision":1}] -->`});
   else sendSyntheticTool(res);
   return;
  }
  if(names.join(',')==='ScenarioVerificationOutput'){
   sendSyntheticTool(res,'ScenarioVerificationOutput',{results:[{scenario_index:0,paragraph_index:0,supported:true,
    evidence:[{memory_id:state.memory,quote:state.text}]}]});return;
  }
  if(['read','write','edit'].every(name=>names.includes(name))&&names.includes('ProfileProposalComplete')){
   if(input.messages.length===1)sendSyntheticTool(res,'write',{path:'profile.md',content:`# 长期背景

<!-- ENTRY ${JSON.stringify({kind:'fact',section:'life_context',basis:'合成课程记忆直接记载。',
  temporal_status:'historical',uncertainty:'',references:[{memory_id:state.memory,revision:1}]})} -->
双方有二〇二四年的共同合成课程经历。`});
   else sendSyntheticTool(res);
   return;
  }
  if(names.join(',')==='ProfileVerificationOutput'){
   sendSyntheticTool(res,'ProfileVerificationOutput',{results:[{entry_index:0,
    supported:state.profileSupported??profileSupported,
    evidence:[{memory_id:state.memory,quote:state.text}]}]});return;
  }
  res.writeHead(500);res.end('{}');
 });
}

async function seedObservationInput(fixture,owner,contactId,{localId,text}){
 const binding=randomUUID(),observation=randomUUID(),message=randomUUID();
 await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成观察') ON CONFLICT DO NOTHING",
  [contactId,owner]);
 await fixture.client.query(`INSERT INTO conversation_binding
  (id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
  VALUES($1,$2,$3,'wechat','synthetic-observation',$4,'active')`,
 [binding,owner,contactId,`synthetic-${observation}`]);
 await fixture.client.query(`INSERT INTO local_wechat_observation
  (id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,
   last_local_id,last_cursor,record_count,event_count)
  VALUES($1,$2,$3,$4,'live','synthetic',$5,$6,$7,1,1)`,
 [observation,owner,contactId,binding,`synthetic-${observation}`,localId,String(localId)]);
 await fixture.client.query(`INSERT INTO message
  (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text',$4,now())`,
 [message,owner,contactId,text]);
 await fixture.client.query(`INSERT INTO message_source_ref
  (message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload)
  VALUES($1,$2,$3,'local_wechat_observation',$4,$5,$6)`,
 [message,owner,contactId,observation,`synthetic:observation:${localId}`,
  {synthetic:true,local_id:localId}]);
 return {binding,observation,message};
}

test('正常导入自动接纳一个可验证首轮，而不是落入旧任务归属',{timeout:60000},async t=>{
 let seeded;
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw);
  assert.equal(input.tools[0].name,'DirectMemoryExtractionOutput');
  sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{
  const contactId=randomUUID(),source=randomUUID(),message=randomUUID();
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成自动轮次')",[contactId,owner]);
  await f.client.query(`INSERT INTO source_document
   (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
   VALUES($1,$2,$3,'wechat_jsonl','synthetic-auto-round.jsonl',$4,1)`,
  [source,owner,contactId,'e'.repeat(64)]);
  await f.client.query(`INSERT INTO message
   (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
   VALUES($1,$2,$3,'contact','text','合成自动轮次资料',$4)`,
  [message,owner,contactId,'2026-10-20T03:00:00Z']);
  await f.client.query(`INSERT INTO message_source_ref
   (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
   VALUES($1,$2,$3,'source_document',$4,'synthetic:auto',$5)`,
  [message,owner,contactId,source,{synthetic:true,time_iso:'2026-10-20T03:00:00Z'}]);
  const pool=new pg.Pool({host:'/tmp',database:f.client.database,max:2});
  try{
   const task=await new ExtractionTaskStore(pool).enqueueImport({ownerId:owner,contactId},source,1);
   const scope=(await f.client.query(`SELECT active_round_id AS round
    FROM memory_processing_scope WHERE owner_id=$1 AND contact_id=$2`,[owner,contactId])).rows[0];
   seeded={contactId,source,task,round:scope.round};
  }finally{await pool.end();}
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const root=`/api/contacts/${seeded.contactId}/memory-processing`;
 await untilLifecycle(async()=>(await host.request(`${root}/state`)).data.current.status==='completed',15000);
 const state=(await host.request(`${root}/state`)).data.current;
 assert.equal(state.round_id,seeded.round);
 assert.equal(state.processed_count,1);assert.equal(state.total_count,1);
 assert.equal((await host.client.query(`SELECT count(*)::int AS n FROM memory_processing_round_task
  WHERE round_id=$1 AND task_id=$2 AND active`,[seeded.round,seeded.task])).rows[0].n,1);
});

test('正式Worker零候选仍结束整轮，不伪造主题画像版本或额外调用',{timeout:60000},async t=>{
 let calls=0,seed;
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);calls++;
  assert.equal(input.tools[0].name,'DirectMemoryExtractionOutput');
  sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{seed=await seedRoundInput(f,owner);},{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const root=`/api/contacts/${seed.contactId}/memory-processing`;
 await untilLifecycle(async()=>(await host.request(`${root}/state`)).data.history.entries.some(row=>row.task_id===seed.task&&row.status==='succeeded'));
 const state=(await host.request(`${root}/state`)).data.current;
 assert.equal(state.status,'completed');assert.equal(state.round_id,seed.round);
 assert.equal(state.processed_count,1);assert.equal(state.total_count,1);
 assert.equal(calls,1);assert.equal((await host.request('/api/ledger/summary')).data.total_attempts,1);
 const layered=(await host.request(`/api/contacts/${seed.contactId}/layered-memory`)).data.layered_memory;
 assert.equal(layered.profile,null);assert.deepEqual(layered.scenarios,[]);
 assert.equal((await host.client.query('SELECT count(*)::int AS n FROM layered_memory_generation')).rows[0].n,0);
});

test('本轮目标在首次领取时冻结，运行中形成的新任务进入后续等待集合',{timeout:60000},async t=>{
 let seed,entered;
 const held=[];
 const started=new Promise(resolve=>{entered=resolve;});
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw);held.push({res,input});if(held.length===1)entered();
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{
  seed=await seedRoundInput(f,owner);
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 await Promise.race([started,new Promise((_,reject)=>setTimeout(
  ()=>reject(new Error('提取供应商未收到首轮固定目标')),10000,
 ))]);
 const later=randomUUID(),laterSource=randomUUID();
 await host.client.query(`INSERT INTO source_document
  (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-later-round.jsonl',$4,1)`,
 [laterSource,host.owner,seed.contactId,'f'.repeat(64)]);
 await host.client.query(`INSERT INTO message
  (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text','运行中新消息',$4)`,
 [later,host.owner,seed.contactId,'2026-10-20T02:00:00Z']);
 await host.client.query(`INSERT INTO message_source_ref
  (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
  VALUES($1,$2,$3,'source_document',$4,'synthetic:later',$5)`,
 [later,host.owner,seed.contactId,laterSource,{synthetic:true,time_iso:'2026-10-20T02:00:00Z'}]);
 const pool=new pg.Pool({host:'/tmp',database:host.client.database,max:2});
 let laterTask;
 try{
  laterTask=await new ExtractionTaskStore(pool).enqueueImport(
   {ownerId:host.owner,contactId:seed.contactId},laterSource,1,
  );
 }finally{await pool.end();}
 sendSyntheticTool(held[0].res,held[0].input.tools[0].name,{scenes:[]});
 const root=`/api/contacts/${seed.contactId}/memory-processing`;
 let lastState;
 try{
  await untilLifecycle(async()=>{
   lastState=(await host.request(`${root}/state`)).data;
   const round=(await host.client.query(
    'SELECT status FROM memory_processing_round WHERE scope_id=$1 AND round_number=2',
    [seed.scope],
   )).rows[0];
   return round?.status==='processing'&&lastState.current.status==='processing';
  },15000);
 }catch(error){
  const tasks=(await host.client.query(`SELECT t.id,t.task_type,t.status,t.last_error_code,
    membership.round_id,membership.active,s.step_name,s.status AS step_status,s.last_error_code AS step_error
   FROM background_task t LEFT JOIN memory_processing_round_task membership ON membership.task_id=t.id
   LEFT JOIN background_task_step s ON s.task_id=t.id
   WHERE t.owner_id=$1 AND t.contact_id=$2 ORDER BY t.created_at,s.step_order`,
  [host.owner,seed.contactId])).rows;
  const roundFacts=(await host.client.query(`SELECT round.status,round.target_unit,round.target_count,
    (SELECT count(*)::int FROM memory_processing_round_target snapshot WHERE snapshot.round_id=round.id) AS frozen,
    (SELECT json_agg(json_build_object('message_id',target.message_id,'completed_at',target.completed_at,'outcome',target.outcome))
     FROM memory_processing_round_target snapshot JOIN memory_processing_target target
       ON target.task_id=snapshot.task_id AND target.message_id=snapshot.message_id
     WHERE snapshot.round_id=round.id) AS targets
   FROM memory_processing_round round WHERE round.id=$1`,[seed.round])).rows[0];
  assert.fail(JSON.stringify({state:lastState,tasks,roundFacts,host:host.output().slice(-5000),error:String(error)}));
 }
 const rounds=(await host.client.query(`SELECT id,round_number,status,target_count
  FROM memory_processing_round WHERE scope_id=$1 ORDER BY round_number`,[seed.scope])).rows;
 assert.equal(rounds.length,2);
 assert.equal(rounds[0].status,'completed');
 assert.equal(rounds[1].status,'processing');
 assert.notEqual(rounds[1].id,seed.round);
 const first=await untilLifecycle(async()=>{
  const current=(await host.request(`${root}/state`)).data.current;
  return current.round_id===rounds[1].id&&current.status==='processing'?current:null;
 },5000);
 assert.equal(first.processed_count,0);assert.equal(first.total_count,1);
 assert.equal(first.pending_count,0);
 assert.equal((await host.client.query(`SELECT count(*)::int AS n
  FROM memory_processing_round_target snapshot
  WHERE snapshot.round_id=$1`,[seed.round])).rows[0].n,1);
 assert.equal((await host.client.query(`SELECT count(*)::int AS n
  FROM memory_processing_round_target snapshot
  WHERE snapshot.round_id=$1 AND snapshot.message_id=$2`,[rounds[1].id,later])).rows[0].n,1);
 assert.equal((await host.client.query(`SELECT count(*)::int AS n
  FROM memory_processing_round_task WHERE round_id=$1 AND task_id=$2`,[seed.round,laterTask])).rows[0].n,0);
 assert.equal((await host.client.query(
  'SELECT status FROM background_task WHERE id=$1',[laterTask],
 )).rows[0].status,'running');
 await untilLifecycle(()=>held.length===2,5000);
 assert.equal(held.length,2);
 sendSyntheticTool(held[1].res,held[1].input.tools[0].name,{scenes:[]});
 await untilLifecycle(async()=>(await host.request(`${root}/state`)).data.current.status==='completed',15000);
 const completed=(await host.request(`${root}/state`)).data.current;
 assert.equal(completed.round_id,rounds[1].id);
 assert.equal(completed.processed_count,1);assert.equal(completed.total_count,1);
 assert.equal(completed.pending_count,0);
});

test('真实Worker持续接续后续轮次，受阻联系人保留排队而另一联系人完成',{timeout:90000},async t=>{
 const firstText='自动接续第一轮合成资料';
 let heldFirst=null,firstStartedResolve;
 const firstStarted=new Promise(resolve=>{firstStartedResolve=resolve;});
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw);
  if(raw.includes(firstText)&&heldFirst===null){
   heldFirst={res,input};firstStartedResolve();return;
  }
  sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 let blocked,other;
 const host=await lifecycleHost(t,async(f,owner)=>{
  blocked=await seedRoundInput(f,owner,{texts:['受阻联系人原有合成资料。']});
  other=await seedRoundInput(f,owner,{texts:['另一联系人合成资料。']});
  await f.client.query(`UPDATE background_task_step SET status='failed',attempt_count=3,
    last_error_code='temporary_model_failure'
   WHERE task_id=$1`,[blocked.task]);
  await f.client.query(`UPDATE background_task SET status='failed',retry_count=3,
    last_error_code='temporary_model_failure',finished_at=now() WHERE id=$1`,[blocked.task]);
  await f.client.query("UPDATE memory_processing_round SET status='blocked' WHERE id=$1",[blocked.round]);
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const blockedRoot=`/api/contacts/${blocked.contactId}/memory-processing`;
 const otherRoot=`/api/contacts/${other.contactId}/memory-processing`;
 await untilLifecycle(async()=>(await host.request(`${otherRoot}/state`)).data.current.status==='completed',20000);
 assert.equal((await host.request(`${blockedRoot}/state`)).data.current.status,'blocked');
 const blockedLater=await seedObservationInput(host,host.owner,blocked.contactId,{
  localId:9,text:'受阻后保存的合成观察。',
 });
 const pool=new pg.Pool({host:'/tmp',database:host.client.database,max:2});
 try{
  const store=new ExtractionTaskStore(pool),scope={ownerId:host.owner,contactId:blocked.contactId};
  await store.transaction(scope,client=>store.recordObservation(client,scope,blockedLater.observation,[blockedLater.message]));
  await Promise.all(Array.from({length:4},()=>store.enqueueObservation(scope,[blockedLater.message])));
 }finally{await pool.end();}
 assert.equal((await host.request(`${blockedRoot}/state`)).data.current.status,'blocked');
 assert.equal((await host.client.query(`SELECT task_id FROM memory_extraction_receipt WHERE message_id=$1`,
  [blockedLater.message])).rows[0].task_id,null);
 assert.equal((await host.client.query(`SELECT count(*)::int AS n FROM background_task
  WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation'`,
 [host.owner,blocked.contactId])).rows[0].n,0);

 await host.client.query('BEGIN');
 let first;
 try{
  first=await seedRoundInput(host,host.owner,{texts:[firstText]});
  await host.client.query('COMMIT');
 }catch(error){
  await host.client.query('ROLLBACK');
  throw error;
 }
 await Promise.race([firstStarted,new Promise((_,reject)=>setTimeout(
  ()=>reject(new Error('真实Worker未领取第一轮固定目标')),15000,
 ))]);
 const later=await seedObservationInput(host,host.owner,first.contactId,{
  localId:10,text:'自动接续第二轮合成资料。',
 });
 const pool2=new pg.Pool({host:'/tmp',database:host.client.database,max:2});
 try{
  const store=new ExtractionTaskStore(pool2),scope={ownerId:host.owner,contactId:first.contactId};
  await store.transaction(scope,client=>store.recordObservation(client,scope,later.observation,[later.message]));
  await store.enqueueObservation(scope,[later.message]);
 }finally{await pool2.end();}
 sendSyntheticTool(heldFirst.res,heldFirst.input.tools[0].name,{scenes:[]});
 const root=`/api/contacts/${first.contactId}/memory-processing`;
 await untilLifecycle(async()=>{
  const state=(await host.request(`${root}/state`)).data.current;
  const rounds=(await host.client.query(`SELECT id,status FROM memory_processing_round
   WHERE scope_id=$1 ORDER BY round_number`,[first.scope])).rows;
  return rounds.length===2&&rounds.every(round=>round.status==='completed')
   &&state.status==='completed';
 },25000);
 const rounds=(await host.client.query(`SELECT id,round_number,status,target_count
  FROM memory_processing_round WHERE scope_id=$1 ORDER BY round_number`,[first.scope])).rows;
 assert.equal(rounds.length,2);
 assert.deepEqual(rounds.map(round=>round.status),['completed','completed']);
 assert.deepEqual(rounds.map(round=>round.target_count),['1','1']);
 const secondFrozen=(await host.client.query(`SELECT snapshot.message_id,member.task_id,
   task.task_type,task.status
  FROM memory_processing_round_target snapshot
  JOIN memory_processing_round_task member
    ON member.round_id=snapshot.round_id AND member.task_id=snapshot.task_id
  JOIN background_task task ON task.id=member.task_id
  WHERE snapshot.round_id=$1 AND member.active`,[rounds[1].id])).rows;
 assert.deepEqual(secondFrozen.map(row=>({...row})),[{message_id:later.message,
  task_id:secondFrozen[0].task_id,task_type:'observation',status:'succeeded'}]);
 const final=(await host.request(`${root}/state`)).data.current;
 assert.equal(final.round_id,rounds[1].id);
 assert.equal(final.status,'completed');
 assert.equal(final.processed_count,1);assert.equal(final.total_count,1);
 assert.equal(final.pending_count,0);
});

test('逐条拒绝不合格候选时其余合法记忆继续保存并完成整轮',{timeout:60000},async t=>{
 let seed;
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw),names=(input.tools??[]).map(tool=>tool.name);
  const toolName=names[0]??input.tools?.[0]?.function?.name;
  if(toolName==='DirectMemoryExtractionOutput'){
   const base={category:'common_fact',subject:'shared',topic:'study',
    source_message_ids:[seed.messages[0].id],confidence:0.9,risk_flags:[],
    valid_at:null,invalid_at:null,speech_act:'assertion',
    assertion_status:'asserted',figurative_type:'literal',alternatives:[],
    interpretation_reason:'合成原话直接记载'};
   sendSyntheticTool(res,toolName,{scenes:[{scene_name:'合成课程',memories:[
    {...base,text:'双方共同参加合成课程。'},
    {...base,text:'双方从未参加合成课程。'},
   ]}]});
   return;
  }
  if(toolName==='SourceVerificationOutput'){
   const quote=seed.messages[0].text;
   const send=input.tools?.[0]?.type==='function'?sendSyntheticStrictTool:sendSyntheticTool;
   send(res,'SourceVerificationOutput',{results:[
    {candidate_index:0,verdict:'supported',issues:[],
     evidence:[{message_id:seed.messages[0].id,quote}]},
    {candidate_index:1,verdict:'unsupported',issues:['meaning'],
     evidence:[{message_id:seed.messages[0].id,quote}]},
   ]});
   return;
  }
  res.writeHead(500);res.end('{}');
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{
  seed=await seedRoundInput(f,owner,{texts:['双方共同参加合成课程。'],verification:'legacy'});
  await f.client.query(`INSERT INTO layered_memory_state(owner_id,contact_id,enabled,status)
   VALUES($1,$2,false,'disabled') ON CONFLICT DO NOTHING`,[owner,seed.contactId]);
  await f.client.query(`UPDATE layered_memory_state SET enabled=false,status='disabled',error_code=NULL
   WHERE owner_id=$1 AND contact_id=$2`,[owner,seed.contactId]);
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const root=`/api/contacts/${seed.contactId}/memory-processing`;
 let lastState;
 try{
  await untilLifecycle(async()=>{
   lastState=(await host.request(`${root}/state`)).data;
   return lastState.current.status==='completed';
  },15000);
 }catch(error){
  const tasks=(await host.client.query(`SELECT t.task_type,t.status,t.last_error_code,s.step_name,s.status AS step_status,
    s.last_error_code AS step_error
   FROM background_task t LEFT JOIN background_task_step s ON s.task_id=t.id
   WHERE t.owner_id=$1 AND t.contact_id=$2 ORDER BY t.created_at,s.step_order`,
  [host.owner,seed.contactId])).rows;
  assert.fail(JSON.stringify({state:lastState,tasks,host:host.output().slice(-5000),error:String(error)}));
 }
 const state=(await host.request(`${root}/state`)).data.current;
 assert.equal(state.processed_count,1);
 assert.equal(state.total_count,1);
 const memories=(await host.client.query(
  "SELECT text_content FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND status='active'",
  [host.owner,seed.contactId],
 )).rows;
 assert.deepEqual(memories.map(row=>row.text_content),['双方共同参加合成课程。']);
 const results=(await host.client.query(`SELECT payload->'result'->>'disposition' AS disposition
  FROM memory_extraction_trace_event event
  JOIN memory_extraction_trace trace ON trace.trace_id=event.trace_id
  WHERE trace.owner_id=$1 AND trace.contact_id=$2 AND event.stage='candidate_result'
  `,[host.owner,seed.contactId])).rows;
 assert.deepEqual(results.map(row=>row.disposition),['adopted']);
 const rejected=(await host.client.query(`SELECT count(*)::int AS n
  FROM memory_extraction_trace_event event
  JOIN memory_extraction_trace trace ON trace.trace_id=event.trace_id
  WHERE trace.owner_id=$1 AND trace.contact_id=$2 AND event.stage='verification'
    AND event.payload->>'disposition'='unsupported_rejected'`,
 [host.owner,seed.contactId])).rows[0].n;
 assert.equal(rejected,1);
});

test('本人经正式认证入口独立接纳并完成主题与画像轮次',{timeout:90000},async t=>{
 const state={text:'本人参加过合成课程。',memory:null,seen:[]};
 const provider=roundProvider(state);
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{
  state.memory=randomUUID();
  await f.client.query(`INSERT INTO owner_memory
   (id,owner_id,text_content,category,topic,source_ids,adoption_method,status,revision)
   VALUES($1,$2,$3,'common_fact','study',ARRAY[$2::uuid],'manual','active',1)`,
  [state.memory,owner,state.text]);
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const initial=(await host.request('/api/memories/owner/layered-memory')).data.layered_memory;
 assert.equal(initial.eligible_count,1);
 const enabled=await host.request('/api/memories/owner/layered-memory/enable',{
  method:'POST',body:{settings_generation:initial.settings_generation,purpose_confirmed:true},
 });
 assert.equal(enabled.status,200,JSON.stringify(enabled.data));
 const root='/api/owner/memory-processing';
 let lastState;
 try{
  await untilLifecycle(async()=>{
   lastState=(await host.request(`${root}/state`)).data;
   return lastState.current.status==='completed';
  },20000);
 }catch(error){
  assert.fail(JSON.stringify({state:lastState,host:host.output().slice(-5000),error:String(error)}));
 }
 const completed=(await host.request(`${root}/state`)).data;
 assert.equal(completed.scope,'owner');
 assert.equal(completed.current.unit,'memories');
 assert.equal(completed.current.processed_count,1);
 assert.equal(completed.current.total_count,1);
 const layered=(await host.request('/api/memories/owner/layered-memory')).data.layered_memory;
 assert.equal(layered.scenarios.length,1);
 assert.equal(layered.profile.entries.length,1);
});

test('同一轮从提取衔接主题与画像，完成后保留固定任务归属',{timeout:90000},async t=>{
 const seen=[];
 const state={text:'双方共同参加过合成课程。',memory:null,seen};
 let seed;
 const provider=roundProvider(state);
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{
  seed=await seedRoundMemory(f,owner,{text:state.text});
  state.memory=seed.memory;
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const root=`/api/contacts/${seed.contactId}/memory-processing`;
 let observed;
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  const result=(await host.request(`${root}/state`)).data;
  observed=result;
  if(['completed','blocked'].includes(result.current.status))break;
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 const timing=await host.client.query(`SELECT t.task_type,t.status,t.current_step,t.last_error_code,
   j.state AS job_state,j.profile_status
  FROM memory_processing_round_task membership JOIN background_task t ON t.id=membership.task_id
  LEFT JOIN layered_memory_job j ON j.task_id=t.id
  WHERE membership.round_id=$1`,[seed.round]);
 const receipts=await host.client.query(`SELECT outcome,dispatch,count(*)::int AS n
  FROM model_call_receipt GROUP BY outcome,dispatch ORDER BY outcome,dispatch`);
 const stage=await host.client.query(`SELECT
   (SELECT count(*)::int FROM layered_memory_batch WHERE owner_id=$1 AND contact_id=$2) AS batches,
   (SELECT count(*)::int FROM layered_profile_batch WHERE owner_id=$1 AND contact_id=$2) AS profiles,
   (SELECT row_to_json(step) FROM background_task_step step JOIN background_task task ON task.id=step.task_id
     WHERE task.owner_id=$1 AND task.contact_id=$2 AND task.task_type='layered_memory'
     ORDER BY step.created_at DESC LIMIT 1) AS step`,
  [host.owner,seed.contactId]);
 assert.equal(observed.current.status,'completed',JSON.stringify({seen,observed,tasks:timing.rows,receipts:receipts.rows,stage:stage.rows[0],host:host.output().slice(-6000)}));
 const processingState=(await host.request(`${root}/state`)).data;
 assert.equal(processingState.current.round_id,seed.round);
 assert.equal(processingState.current.processed_count,1);
 assert.equal(processingState.current.total_count,1);
 assert.equal(processingState.current.pending_count,0);
 const layered=(await host.request(`/api/contacts/${seed.contactId}/layered-memory`)).data.layered_memory;
 const debug=await host.client.query(`SELECT j.task_id,j.state,j.target_manifest,t.status
  FROM layered_memory_job j JOIN background_task t ON t.id=j.task_id WHERE j.contact_id=$1`,
 [seed.contactId]);
 assert.equal(layered.scenarios.length,1,JSON.stringify({layered,jobs:debug.rows}));
 assert.equal(layered.profile.entries.length,1);
 const tasks=(await host.client.query(`SELECT t.id,t.task_type,t.status,membership.active
  FROM memory_processing_round_task membership JOIN background_task t ON t.id=membership.task_id
  WHERE membership.round_id=$1 ORDER BY t.task_type,t.id`,[seed.round])).rows;
 assert.deepEqual(tasks.map(row=>row.task_type).sort(),['import','layered_memory']);
 assert.equal(tasks.every(row=>row.active&&row.status==='succeeded'),true);
});

test('主题已发布而画像核验失败时整轮受阻，并保留可用主题结果',{timeout:90000},async t=>{
 const state={text:'双方共同参加过合成课程。',memory:null,seen:[],profileSupported:false};
 let seed;
 const provider=roundProvider(state,{profileSupported:false});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{
  seed=await seedRoundMemory(f,owner,{text:state.text});
  state.memory=seed.memory;
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const root=`/api/contacts/${seed.contactId}/memory-processing`;
 let blockedResponse;
 const blockedDeadline=Date.now()+15000;
 while(Date.now()<blockedDeadline){
  blockedResponse=await host.request(`${root}/state`);
  if(blockedResponse.data.current?.status==='blocked')break;
  await new Promise(resolve=>setTimeout(resolve,40));
 }
 assert.equal(blockedResponse.data.current?.status,'blocked',JSON.stringify({
  response:blockedResponse,host:host.output().slice(-4000),
 }));
 const current=(await host.request(`${root}/state`)).data.current;
 assert.match(current.reason,/核验|处理|修复/);
 assert.equal(current.has_usable_results,true);
 const recoveryFacts=(await host.client.query(`SELECT t.status AS task_status,t.last_error_code,
   j.state AS job_state,j.pending_receipt,j.profile_status,j.profile_required,
   j.model_calls_used,j.model_call_limit,b.status AS batch_status,
   j.settings_generation AS job_generation,b.settings_generation AS batch_generation,
   state.enabled,state.settings_generation AS state_generation
  FROM background_task t JOIN layered_memory_job j ON j.task_id=t.id
  JOIN layered_memory_batch b ON b.id=j.receipt_batch_id
  JOIN layered_memory_state state ON state.owner_id=j.owner_id AND state.contact_id=j.contact_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.task_type='layered_memory'`,
  [host.owner,seed.contactId])).rows;
 assert.ok(current.actions.includes('continue'),JSON.stringify({current,recoveryFacts}));
 const layered=(await host.request(`/api/contacts/${seed.contactId}/layered-memory`)).data.layered_memory;
 assert.equal(layered.scenarios.length,1);
 assert.equal(layered.profile,null);
 const round=(await host.client.query(
  'SELECT status FROM memory_processing_round WHERE id=$1',[seed.round],
 )).rows[0];
 assert.equal(round.status,'blocked');
 const profileBatch=(await host.client.query(
  `SELECT status FROM layered_profile_batch WHERE owner_id=$1 AND contact_id=$2`,
  [host.owner,seed.contactId],
 )).rows[0];
 assert.equal(profileBatch.status,'failed');
 const layeredTasksBefore=(await host.client.query(`SELECT t.id FROM memory_processing_round_task membership
  JOIN background_task t ON t.id=membership.task_id
  WHERE membership.round_id=$1 AND t.task_type='layered_memory'`,[seed.round])).rows;
 assert.equal(layeredTasksBefore.length,1);
 const budgetBefore=(await host.client.query(`SELECT task_id,model_calls_used,model_call_limit
  FROM layered_memory_job WHERE task_id=$1`,[layeredTasksBefore[0].id])).rows[0];
 const profileBatchBefore=(await host.client.query(`SELECT id,status,attempt_count
  FROM layered_profile_batch WHERE owner_id=$1 AND contact_id=$2`,
 [host.owner,seed.contactId])).rows[0];
 state.profileSupported=true;
 const actionVersion=(await host.request(`${root}/state`)).data.action_version;
 const continued=await host.request(`${root}/continue`,{method:'POST',body:{
  action_version:actionVersion,operation_id:randomUUID(),
 }});
 assert.equal(continued.status,200,JSON.stringify(continued.data));
 await untilLifecycle(async()=>(await host.request(`${root}/state`)).data.current.status==='completed',15000);
 const recovered=(await host.request(`/api/contacts/${seed.contactId}/layered-memory`)).data.layered_memory;
 assert.equal(recovered.scenarios.length,1);
 assert.equal(recovered.profile.entries.length,1);
 const layeredTasksAfter=(await host.client.query(`SELECT t.id FROM memory_processing_round_task membership
  JOIN background_task t ON t.id=membership.task_id
  WHERE membership.round_id=$1 AND t.task_type='layered_memory'`,[seed.round])).rows;
 assert.deepEqual(layeredTasksAfter,layeredTasksBefore);
 const budgetAfter=(await host.client.query(`SELECT task_id,model_calls_used,model_call_limit
  FROM layered_memory_job WHERE task_id=$1`,[budgetBefore.task_id])).rows[0];
 const profileBatchesAfter=(await host.client.query(`SELECT id,status,attempt_count
  FROM layered_profile_batch WHERE owner_id=$1 AND contact_id=$2`,
 [host.owner,seed.contactId])).rows;
 assert.equal((await host.client.query('SELECT count(*)::int AS n FROM layered_memory_batch WHERE owner_id=$1 AND contact_id=$2',
  [host.owner,seed.contactId])).rows[0].n,1);
 assert.equal(budgetAfter.task_id,budgetBefore.task_id);
 assert.equal(budgetAfter.model_call_limit,budgetBefore.model_call_limit);
 assert.ok(budgetAfter.model_calls_used>budgetBefore.model_calls_used);
 assert.ok(budgetAfter.model_calls_used<=budgetAfter.model_call_limit);
 assert.equal(profileBatchesAfter.length,1);
 assert.equal(profileBatchesAfter[0].id,profileBatchBefore.id);
 assert.equal(profileBatchesAfter[0].status,'succeeded');
});
