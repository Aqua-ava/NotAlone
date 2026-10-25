/** 两个具名真实业务 driver；只有外层 dispatch 有问题总账预约权。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,chmod,lstat,realpath} from 'node:fs/promises';
import {join,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {hash,OWN,REPO} from './snapshot.mjs';
import {startLayeredProfile} from './profile.mjs';
const execute=promisify(execFile),TOKEN='synthetic-layered-driver-token-00000000';
const id=value=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export const createL2ScenarioBusiness=options=>namedBusiness('l2_scenario',options);
export const createL3ProfileBusiness=options=>namedBusiness('l3_profile',options);
export function createLayeredBusiness(options){const l2=createL2ScenarioBusiness(options),l3=createL3ProfileBusiness(options);return {open:run=>(run.domain==='l2_scenario'?l2:l3).open(run)};}
function namedBusiness(domain,{snapshot,directory,contexts=new Map(),receipts=[],evaluationClock={mode:'wall',qualification:'engineering_only'},python=join(homedir(),'miniconda3/envs/NotAlone/bin/python')}={}){
  return {async open(run){
    assert.equal(run.domain,domain,'named_domain_driver_mismatch');assert.equal(run.commit,run.arm==='old'?snapshot.source.old_commit:snapshot.source.candidate_commit,'business_source_pin_changed');
    assert.ok(['wall','frozen_content'].includes(evaluationClock.mode),'explicit_evaluation_clock_mode_required');
    assert.ok(typeof directory==='string'&&isAbsolute(directory),'private_evidence_directory_required');
    const parent=await lstat(directory),actual=await realpath(directory),repository=await realpath(REPO);
    assert.ok(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700&&parent.uid===process.getuid()&&!actual.startsWith(repository+sep)&&actual!==repository,'private_evidence_directory_required');
    assert.equal(run.material.input.synthetic_only,true,'synthetic_material_required');assert.equal(run.material.input.existing_projection,null,'frozen_projection_adapter_not_qualified');
    const frozenEvents=run.material.input.events??[];
    assert.ok(frozenEvents.every(e=>['start','cancel','synthetic_late_result'].includes(e.event)),'frozen_event_adapter_not_qualified');
    const frozenCancel=frozenEvents.some(e=>e.event==='cancel');
    const root=join(directory,run.run_id.replaceAll(':','-'));await mkdir(root,{mode:0o700});
    const pg=await import(pathToFileURL(join(snapshot.candidate,'backend-ts/node_modules/pg/lib/index.js')));
    const {createStorageFixture}=await import(pathToFileURL(join(snapshot.candidate,'backend-ts/test/host-storage-fixture.mjs')));
    process.env.NOTALONE_TEST_PYTHON=python;
    const fixture=await createStorageFixture(),c=fixture.client;await chmod(fixture.directory,0o700);
    const receipt={database:c.database,dropped:false,scope:run.scope};receipts.push(receipt);
    await writeFile(join(root,'fixture-receipt.json'),JSON.stringify(receipt),{mode:0o600});
    let host,broker,pool,dispatch,currentSignal,claim,closed=false,cancelled=false;
    const sources=[],requests=[],timeline=[];let clock=run.material.input.as_of,httpOrdinal=0;
    function mark(phase){timeline.push({phase,at:new Date().toISOString(),monotonic_ms:performance.now()});}
    async function queryRows(sql,args=[]){return (await c.query(sql,args)).rows;}
    const scope=[run.scope.owner_id,run.scope.contact_id];
    async function stateRows(){return {sources:await queryRows('SELECT id,owner_id,contact_id,status,content_sha256 FROM source_document ORDER BY id'),
      memories:await queryRows('SELECT id,owner_id,contact_id,text_content,status,revision,source_ids FROM confirmed_memory ORDER BY id'),
      owner_memories:await queryRows('SELECT id,owner_id,text_content,status,revision,source_ids FROM owner_memory ORDER BY id')};}
    async function durable(){return {scenarios:await queryRows('SELECT * FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2 ORDER BY id',scope),
      profiles:await queryRows('SELECT * FROM layered_profile_version WHERE owner_id=$1 AND contact_id=$2 ORDER BY id',scope),
      jobs:await queryRows('SELECT * FROM layered_memory_job WHERE owner_id=$1 AND contact_id=$2',scope),
      ledger:await queryRows('SELECT to_jsonb(l) AS value FROM outbound_ledger_entry l WHERE owner_id=$1 AND contact_id=$2 ORDER BY id',scope),
      model_receipts:await queryRows('SELECT to_jsonb(r) AS value FROM model_call_receipt r WHERE owner_id=$1 AND contact_id=$2',scope),
      state:await queryRows('SELECT enabled,settings_generation,status,organization_generation,error_code FROM layered_memory_state WHERE owner_id=$1 AND contact_id=$2',scope),
      task:claim?await queryRows('SELECT t.status,s.status AS step_status,s.lease_generation,s.last_error_code FROM background_task t JOIN background_task_step s ON s.task_id=t.id WHERE t.id=$1',[claim.taskId]):[]};}
    async function old(action){const file=join(root,'old-'+action+'.json');await writeFile(file,JSON.stringify({action,scope:run.scope,database:c.database,provider:`http://127.0.0.1:${broker.address().port}/v1`,
      frozen_source:join(snapshot.legacy,'backend/src'),model_host_bridge:join(snapshot.candidate,'legacy-model-host-bridge/model_permit_client.py'),
      permit_socket:host.info.python_environment.NOTALONE_MODEL_PERMIT_SOCKET,permit_token:host.info.python_environment.NOTALONE_MODEL_PERMIT_TOKEN,
      claim_file:join(root,'old-claim.pickle'),as_of:clock,clock_mode:evaluationClock.mode}),{mode:0o600});
      try{const result=await execute(python,[join(snapshot.candidate,OWN,'old-layered.py'),file],{cwd:snapshot.candidate,
        env:{PATH:process.env.PATH,HOME:fixture.directory,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'},timeout:90000,maxBuffer:4*1024*1024});
        await writeFile(join(root,'old-'+action+'-raw.log'),result.stdout+result.stderr,{mode:0o600});return JSON.parse(result.stdout);
      }catch(error){await writeFile(join(root,'old-'+action+'-failure.log'),String(error.stdout??'')+String(error.stderr??'')+String(error.stack??error),{mode:0o600});throw Error('old_public_business_failed');}}
    async function http(path,body,{signal}={}){const r=await fetch(host.info.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+TOKEN,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})});const value=await r.json();const result={http_status:r.status,body:value};await writeFile(join(root,`business-http-${++httpOrdinal}.json`),JSON.stringify({path,request:body,response:result}),{mode:0o600});return result;}
    async function cancel(){if(cancelled)return;mark('persistent_cancel_requested');if(run.arm==='old')await old('cancel');else{
      const r=await http(`/api/contacts/${scope[1]}/layered-memory/disable`,{settings_generation:Number((await durable()).state[0].settings_generation)});assert.equal(r.http_status,200,'persistent_cancel_rejected');}
      cancelled=true;mark('persistent_cancel_committed');}
    async function close(){if(closed)return;closed=true;
      await writeFile(join(root,'requests-raw.json'),JSON.stringify(requests),{mode:0o600});
      if(host){try{await writeFile(join(root,'model-host-journal.json'),await readFile(host.info.model_host_state_path),{mode:0o600});}catch{}}
      await host?.close();broker?.closeAllConnections();if(broker)await new Promise(done=>broker.close(done));await pool?.end();
      await fixture.close();receipt.dropped=true;await writeFile(join(root,'fixture-receipt.json'),JSON.stringify(receipt),{mode:0o600});}
    try{
      await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[scope[0]]);await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[scope[1],scope[0]]);
      const originalScope=run.material.input.scope;
      for(const s of run.material.input.sources){
        const same=s.owner_id===originalScope.owner_id&&s.contact_id===originalScope.contact_id,contact=same?scope[1]:id(run.case_id+':foreign');
        if(!same)await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成干扰联系人')ON CONFLICT DO NOTHING",[contact,scope[0]]);
        const source=id(`${run.case_id}:${run.repeat}:${s.source_id}:source`),memory=id(`${run.case_id}:${run.repeat}:${s.source_id}:memory`);
        sources.push({...s,storage_id:source,memory_id:memory,scoped:same});
        if(s.state==='deleted'){await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,record_count,status,deleted_at)VALUES($1,$2,$3,'manual',0,'deleted',$4)",[source,scope[0],contact,s.observed_at]);continue;}
        await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)VALUES($1,$2,$3,'manual','synthetic-only',$4,1,'active')",[source,scope[0],contact,hash(s.text)]);
        const table=s.subject==='owner'?'owner_memory':'confirmed_memory';
        await c.query(`INSERT INTO ${table}(id,owner_id,${table==='confirmed_memory'?'contact_id,':''}text_content,category,topic,source_ids,adoption_method,status,revision)VALUES($1,$2,${table==='confirmed_memory'?'$6,':''}$3,'common_fact','other',$4,'manual',$5,${table==='confirmed_memory'?'$7':'$6'})`,
          [memory,scope[0],s.text,[source],s.state==='active'?'active':'deleted',...(table==='confirmed_memory'?[contact]:[]),s.version]);
      }
      // 冻结 observed_at 不冒充事件／保存时间；业务行保存时刻使用真实数据库默认值。
      await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation,status,organization_generation)VALUES($1,$2,true,1,'stale',0)ON CONFLICT DO NOTHING",scope);
      await c.query("UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale' WHERE owner_id=$1 AND contact_id=$2",scope);
      const originalSource=hash(await stateRows());
      broker=createServer(async(req,res)=>{let raw='';try{for await(const part of req)raw+=part;const request={raw,path:req.url,route:req.url==='/anthropic/v1/messages'?'messages':req.url==='/beta/chat/completions'?'strict_chat':'chat',signal:currentSignal};requests.push({path:req.url,raw});
        if(!dispatch)throw Error('physical_dispatch_not_bound');mark('broker_dispatch_entered');const response=await dispatch(request);mark('broker_response_received');
        // 冻结取消事件通过旧 command / 新 disable 持久化；真实返回正文仅在取消提交后交给 SDK。
        if(frozenCancel&&!cancelled){await cancel();mark('frozen_late_result_delivered_after_cancel');}
        res.writeHead(response.http_status??200,{'content-type':response.content_type??'application/json'});res.end(response.raw_response);
      }catch(error){await writeFile(join(root,`dispatch-error-${requests.length}.log`),String(error.stack??error),{mode:0o600});res.writeHead(502,{'content-type':'application/json'});res.end('{"error":"guarded_broker_rejected"}');}});
      broker.listen(0,'127.0.0.1');await once(broker,'listening');
      host=await startLayeredProfile({snapshot,home:join(root,'profile-home'),directory:root,database:c.database,owner:scope[0],token:TOKEN,broker:`http://127.0.0.1:${broker.address().port}`,asOf:clock,clockMode:evaluationClock.mode});
      if(run.arm==='old')claim=await old('prepare');else{
        const r=await http(`/api/contacts/${scope[1]}/layered-memory/refresh`,{settings_generation:1});assert.equal(r.http_status,200,'public_layered_refresh_failed');
        const tasks=await queryRows("SELECT id FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='layered_memory' AND status='queued'",scope);assert.equal(tasks.length,1,'public_layered_task_missing');
        pool=new pg.default.Pool({host:'/tmp',database:c.database,max:3});const {ExtractionTaskStore}=await import(pathToFileURL(join(snapshot.candidate,'backend-ts/src/extraction-task-store.ts')));
        claim=await new ExtractionTaskStore(pool).claim({ownerId:scope[0],contactId:scope[1]},{taskId:tasks[0].id,workerId:randomUUID(),leaseMs:300000,supportedSteps:['organize_memory']});assert.ok(claim,'public_layered_claim_missing');
      }
      const initialState=(await durable()).state[0];
      const context={run,claim,fixture,sources,requests,timeline,cancel,root,host:host.info,async durable(){return durable();}};contexts.set(run.run_id,context);
      const evidence={source_commit:run.commit,runtime:run.arm==='old'?'isolated_python':'typescript',inner_problem_budget_bound:false,profile_sha256:host.profileSha,profile_template_sha256:host.templateSha,
        model_host:{entry:'startModelHost',ownership:run.arm==='old'?'pinned_shared_priority_bridge_only':'production_createHostModelAccounting',actual_profile:true},
        public_entry:run.arm==='old'?'LayeredMemoryService.organize + PostgresBackgroundTaskRepository.claim_next_step + LayeredMemoryService.run_batch':'createLayeredMemoryManagement.refresh + ExtractionTaskStore.claim + createL2ScenarioHttp.handlePrivate',
        named_driver:domain,controls:host.info.controls,retries:{sdk:0,business:0,exhaustion_used_to_simulate_zero:false},frozen_events:{count:frozenEvents.length,cancel_policy:'persist_after_first_physical_response_before_sdk_delivery'},evaluation_clock:{...host.info.clock,recorded_times:'actual_pg_defaults',event_time:'unknown_unless_literal',operational_clock:'actual_wall_and_pg_clock_timestamp'}};
      return {evidence,cancel,async assertCurrent(){assert.equal(hash(await stateRows()),originalSource,'server_sources_changed');const s=(await durable()).state[0];assert.equal(s.enabled,true,'server_scope_disabled');assert.equal(s.settings_generation,initialState.settings_generation,'server_settings_changed');
        const step=(await queryRows('SELECT s.status,s.worker_id,s.lease_generation,s.lease_expires_at,t.status AS task_status FROM background_task_step s JOIN background_task t ON t.id=s.task_id WHERE s.id=$1',[claim.stepId]))[0];
        assert.equal(step?.status,'running','server_task_not_running');assert.equal(step.worker_id,claim.workerId,'server_worker_changed');assert.equal(Number(step.lease_generation),Number(claim.leaseGeneration),'server_lease_changed');assert.ok(new Date(step.lease_expires_at).getTime()>Date.now(),'server_lease_expired');
        return {scope:run.scope,source_sha256:originalSource,task_id:claim.taskId,lease_generation:Number(step.lease_generation)};},
        async run(onDispatch,signal){dispatch=onDispatch;currentSignal=signal;mark('business_run_entered');let output,failure,cancelPromise;
          const onAbort=()=>{cancelPromise=cancel().catch(error=>{failure=error;});};signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
          try{signal.throwIfAborted();if(run.arm==='old')output=await old('run');else{
            output=await http('/internal/layered-memory/run',{scope:run.scope,claim:{task_id:claim.taskId,step_id:claim.stepId,step_name:'organize_memory',worker_id:claim.workerId,lease_generation:Number(claim.leaseGeneration)}},{signal});
            if(output.http_status!==200)failure=Error(output.body.error??'layered_business_failed');
          }}catch(error){failure=error;}finally{signal.removeEventListener('abort',onAbort);await cancelPromise;}
          const persisted=await durable();mark('durable_result_observed');context.final=persisted;context.output=output;context.error=failure?.message??null;
          const count=Number(persisted.jobs.reduce((n,j)=>n+Number(j.model_calls_used),0)),ledgerCount=persisted.ledger.length;
          const status=cancelled||signal.aborted||persisted.task.some(t=>t.status==='cancelled')?'cancelled':failure||persisted.jobs.some(j=>j.state==='failed'||j.profile_status==='failed')||persisted.state.some(s=>s.status==='failed')?'failed':'succeeded';
          await writeFile(join(root,'business-result-raw.json'),JSON.stringify({output,persisted,timeline,sources,status,error:failure?.message??null},null,2),{mode:0o600});
          const result={terminal_status:status,output,audit:{persisted_physical_count:run.arm==='old'?count:ledgerCount,pg_job_call_reservations:count,outbound_ledger_count:ledgerCount,model_call_receipts:persisted.model_receipts.length,persistent_cancel_committed:!persisted.state[0]?.enabled&&persisted.task.some(t=>t.status==='cancelled'),
            legacy_outbound_ledger_gap:run.arm==='old'&&ledgerCount===0,source_snapshot_sha256:originalSource},business_output:{scenarios:persisted.scenarios,profiles:persisted.profiles,sources},
            five_phase_evidence:{complete:false,unknown_reason:'legacy_public_ingestion_and_first_token_boundaries_absent',observed:timeline,first_token:'unknown',final_persistence:timeline.at(-1)}};
          if(failure)result.business_error=failure.message;return result;
        },close};
    }catch(error){await writeFile(join(root,'open-failure.log'),String(error.stack??error),{mode:0o600});await close();throw error;}
  }};
}
