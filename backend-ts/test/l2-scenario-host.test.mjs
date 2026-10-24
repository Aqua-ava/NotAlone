import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {sendEvents,useTool} from './support.mjs';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';

const budget={max_memories:20,max_batch_memories:20,max_scenarios:15,max_paragraphs:40,max_characters:128_000,max_model_calls:8};

async function seed(f){
  const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),memory=randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成所有者')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成手录',$4,1)",[source,owner,contact,'a'.repeat(64)]);
  await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,$3,'双方共同参加过合成课程。','common_fact','study',$4,'manual')",[memory,owner,contact,[source]]);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)",[task,owner,contact]);
  await f.client.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')",[step,task,worker]);
  await f.client.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation,status,organization_generation)VALUES($1,$2,true,1,'stale',0) ON CONFLICT DO NOTHING",[owner,contact]);
  await f.client.query("UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale',organization_generation=0 WHERE owner_id=$1 AND contact_id=$2",[owner,contact]);
  await f.client.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required)VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1','[]','{}','active',1,8,false)",[task,owner,contact,`synthetic:${task}`]);
  return {owner,contact,memory,task,scope:{owner_id:owner,contact_id:contact},claim:{task_id:task,step_id:step,step_name:'organize_memory',worker_id:worker,lease_generation:1}};
}

test('官方DSH profile+本地provider+真实许可/PG：L2三轮逐次预约记账并发布',{timeout:30000},async t=>{
  const f=await createStorageFixture(),temporary=await mkdtemp(join(tmpdir(),'notalone-l2-host-'));const x=await seed(f);
  let child,http,permit,listening;
  t.after(async()=>{
    if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
    if(http){http.closeAllConnections();await new Promise(done=>http.close(done));}
    await permit?.shutdown();await f.close();await rm(temporary,{recursive:true,force:true});
  });
  const requests=[];
  let latestMemory;
  let cancelMemory;
  const callsByMemory=new Map();
  let secondRunInFlight;
  const secondRunStarted=new Promise(resolve=>{secondRunInFlight=resolve;});
  http=createServer(async(request,response)=>{
    let raw='';for await(const part of request)raw+=part;
    const body=JSON.parse(raw);requests.push(body);
    const names=(body.tools??[]).map(tool=>tool.name);
    if(names.join(',')==='read,write,edit'&&body.messages.length===1){
      const content=body.messages[0].content.find(block=>block.type==='text')?.text;
      latestMemory=JSON.parse(content).memories[0].memory_id;
    }
    const memoryCalls=(callsByMemory.get(latestMemory)??0)+1;
    callsByMemory.set(latestMemory,memoryCalls);
    if(latestMemory===cancelMemory&&memoryCalls===2){
      secondRunInFlight();
      return;
    }
    const events=[
      {type:'message_start',message:{id:`synthetic-${requests.length}`,model:'synthetic-model',usage:{input_tokens:9,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成L2'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}},
      {type:'message_stop'},
    ];
    if(names.join(',')==='read,write,edit'&&body.messages.length===1){
      useTool(events,'write',{path:'course.md',content:`<!-- META {"topic_key":"course","title":"合成课程","hint":"共同经历与当前状态"} -->

双方共同参加过合成课程。
<!-- SOURCES [{"memory_id":"${latestMemory}","revision":1}] -->`},'write-1');
    }else if(names.join(',')==='ScenarioVerificationOutput'){
      useTool(events,'ScenarioVerificationOutput',{results:[{scenario_index:0,paragraph_index:0,supported:true,
        evidence:[{memory_id:latestMemory,quote:'双方共同参加过合成课程。'}]}]},'verify-1');
    }
    sendEvents(response,events);
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  const socket=join(temporary,'permit.sock'),token='synthetic-l2-token-'.repeat(4),arbiter=new ModelPermitArbiter(2);
  const transaction=async work=>{const client=new pg.Client({host:'/tmp',database:f.client.database});await client.connect();try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}};
  let permitServer;
  const accounting=createHostModelAccounting({
    transaction,provider:'synthetic-route',model:'synthetic-model',unconfirmedPermitIds:()=>permitServer.unconfirmedPermitIds(),
  });
  permitServer=await startModelPermitServer({path:socket,token,arbiter,accounting});
  permit=permitServer;
  const home=join(temporary,'home'),profile=join(home,'profiles','notalone');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
  await writeFile(join(profile,'cordis.patch.yml'),`- insert:
    - name: '@deepseek-ai/dsh-llm'
    - name: ${JSON.stringify(resolve('test/l2-scenario-host-plugin.ts'))}
`);
  const config={scope:x.scope,claim:x.claim,budget};
  child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{
    cwd:home,
    env:{PATH:process.env.PATH,HOME:home,USER:process.env.USER,LOGNAME:process.env.LOGNAME,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',
      NOTALONE_DATABASE_URL:`host=/tmp dbname=${f.client.database}`,
      NOTALONE_L2_DATABASE:f.client.database,
      NOTALONE_MODEL_PERMIT_SOCKET:socket,NOTALONE_MODEL_PERMIT_TOKEN:token,
      NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${http.address().port}/anthropic`,
      NOTALONE_L2_SCENARIO_CONFIG:JSON.stringify(config)},
    stdio:['ignore','pipe','pipe'],
  });
  let output='';child.stderr.on('data',part=>output+=part);
  const url=await new Promise((done,reject)=>{
    const timer=setTimeout(()=>reject(new Error(output.slice(-2000))),15000);
    child.stdout.on('data',part=>{output+=part;const match=output.match(/L2_SCENARIO_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);done(match[1]);}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`l2_host_exit_${code}: ${output.slice(-2000)}`));});
  });
  const response=await fetch(`${url}/run`,{method:'POST'});
  const result=await response.json();
  assert.equal(response.status,200,`${JSON.stringify(result)}\n${output}`);
  assert.equal(result.status,'completed');
  assert.equal(requests.length,3);
  assert.deepEqual(requests.map(body=>(body.tools??[]).map(tool=>tool.name)),[
    ['read','write','edit'],['read','write','edit'],['ScenarioVerificationOutput'],
  ]);
  const receipts=(await f.client.query('SELECT attempt_id,request_id,scope_kind,outcome,dispatch FROM model_call_receipt ORDER BY called_at')).rows;
  assert.equal(receipts.length,3);
  assert.equal(new Set(receipts.map(row=>row.attempt_id)).size,3);
  assert.ok(receipts.every(row=>row.request_id===x.task&&row.scope_kind==='contact'&&row.outcome==='succeeded'&&row.dispatch==='response_observed'));
  assert.equal((await f.client.query('SELECT model_calls_used FROM layered_memory_job WHERE task_id=$1',[x.task])).rows[0].model_calls_used,3);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM outbound_ledger_entry WHERE outcome=\'succeeded\'')).rows[0].n,3);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2',[x.owner,x.contact])).rows[0].n,1);
  assert.equal(result.state.scenarios[0].paragraphs[0].references[0].memory_id,x.memory);

  const cancelled=await seed(f);
  cancelMemory=cancelled.memory;
  const controller=new AbortController();
  const cancelledResponse=fetch(`${url}/run`,{method:'POST',signal:controller.signal,body:JSON.stringify({
    scope:cancelled.scope,claim:cancelled.claim,budget,
  })});
  const startedOrFinished=await Promise.race([
    secondRunStarted.then(()=>null),
    cancelledResponse.then(async response=>({status:response.status,body:await response.text()})),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error(`synthetic_cancel_not_started ${requests.length} ${output}`)),5000)),
  ]);
  assert.equal(startedOrFinished,null,JSON.stringify(startedOrFinished));
  controller.abort();
  await assert.rejects(cancelledResponse);
  for(let remaining=0;remaining<50;remaining++){
    const row=(await f.client.query('SELECT status FROM layered_memory_batch WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1',[cancelled.task])).rows[0];
    if(row?.status==='failed')break;
    await new Promise(done=>setTimeout(done,20));
  }
  assert.equal((await f.client.query('SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2',[cancelled.owner,cancelled.contact])).rows[0].n,0);
  const cancelReceipts=(await f.client.query('SELECT outcome FROM model_call_receipt WHERE request_id=$1 ORDER BY called_at',[cancelled.task])).rows;
  assert.deepEqual(cancelReceipts.map(row=>row.outcome),['succeeded','cancelled']);
  assert.equal(arbiter.snapshot().backgroundActive,0);

  const limited=await seed(f);
  await f.client.query('UPDATE layered_memory_job SET model_call_limit=2 WHERE task_id=$1',[limited.task]);
  const limitedResponse=await fetch(`${url}/run`,{method:'POST',body:JSON.stringify({scope:limited.scope,claim:limited.claim,budget})});
  assert.equal(limitedResponse.status,502);
  assert.equal((await f.client.query('SELECT model_calls_used FROM layered_memory_job WHERE task_id=$1',[limited.task])).rows[0].model_calls_used,1);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2',[limited.owner,limited.contact])).rows[0].n,0);
  assert.equal(arbiter.snapshot().backgroundActive,0);
});
