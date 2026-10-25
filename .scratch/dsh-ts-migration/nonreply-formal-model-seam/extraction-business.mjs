/** 最小正式业务适配：双臂非空提取；其余域必须由根提供具名适配。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from '../../../backend-ts/test/host-storage-fixture.mjs';
import {ExtractionTaskStore} from '../../../backend-ts/src/extraction-task-store.ts';
import {ExtractionTaskRunner} from '../../../backend-ts/src/extraction-task-runner.ts';
import {startProfile} from './profile-host.mjs';
import {hash} from './formal-executor.mjs';
const execute=promisify(execFile),token='synthetic-seam-token-00000000-00000000';
const id=value=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export function extractionBusiness({snapshotRoot,directory,contexts,receipts}){
  return {async open(run){
    assert.equal(run.domain,'memory_extraction','named_domain_business_adapter_required');
    let f;try{f=await createStorageFixture();}catch(error){await writeFile(join(directory,`fixture-open-error-${run.arm}.log`),String(error.stack??error)+'\n'+String(error.cause?.stderr??error.cause??''),{mode:0o600});throw error;}
    const c=f.client,scope=[run.scope.owner_id,run.scope.contact_id];
    const receipt={database:c.database,directory_label:f.directory.split('/').at(-1),created_by:'nonreply-model-seam',dropped:false};
    receipts.push(receipt);const receiptPath=join(directory,`fixture-${run.arm}.json`);await writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});
    let pool,host,provider,dispatch,currentSignal,closed=false;
    const prepared={source:id(run.run_id+':source'),messages:[]};
    async function close(){if(closed)return;closed=true;
      await host?.close();
      const captured=contexts.get(run.run_id);if(captured){captured.final_trace=(await c.query('SELECT stage,payload,position FROM memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2 ORDER BY position',scope)).rows;
        captured.final_ledger_count=(await c.query('SELECT count(*)::int n FROM outbound_ledger_entry WHERE owner_id=$1 AND contact_id=$2',scope)).rows[0].n;}
      provider?.closeAllConnections();if(provider)await new Promise(done=>provider.close(done));
      await pool?.end();await f.close();receipt.dropped=true;await writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});}
    try{
      await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[scope[0]]);
      await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[scope[1],scope[0]]);
      await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic-only.jsonl',$4,$5)",[prepared.source,...scope,run.case_sha256,run.material.messages.length]);
      for(const [index,[sender,text]]of run.material.messages.entries()){
        const mid=id(`${run.run_id}:message:${index}`),occurred=new Date(Date.UTC(2026,8,15,0,index)).toISOString();prepared.messages.push(mid);
        await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,$4,'text',$5,$6)",[mid,...scope,sender==='self'?'user':'contact',text,occurred]);
        await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,$5,$6)",[mid,...scope,prepared.source,`frozen:${index}`,{time_iso:occurred}]);
      }
      const pg=await import('../../../backend-ts/node_modules/pg/lib/index.js');pool=new pg.default.Pool({host:'/tmp',database:c.database,max:3});const store=new ExtractionTaskStore(pool);
      const task=await store.enqueueImport({ownerId:scope[0],contactId:scope[1]},prepared.source,prepared.messages.length);
      await c.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id)VALUES($1,$2,$3)',[task,...scope]);
      for(const index of run.material.targets)await c.query('INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)VALUES($1,$2,$3,$4)',[task,prepared.messages[index],...scope]);
      await c.query("UPDATE background_task_step SET status='succeeded',processed_count=$2,total_count=$2 WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task,prepared.messages.length]);
      prepared.claim=await store.claim({ownerId:scope[0],contactId:scope[1]},{taskId:task,workerId:randomUUID(),leaseMs:120000,supportedSteps:['extract_memory']});
      contexts.set(run.run_id,{run,prepared,fixture:f});
      const sourceRows=async()=>({sources:(await c.query('SELECT id,owner_id,contact_id,status,content_sha256 FROM source_document WHERE id=$1',[prepared.source])).rows,
        messages:(await c.query('SELECT id,owner_id,contact_id,speaker,text_content,occurred_at FROM message WHERE id=ANY($1::uuid[]) ORDER BY id',[prepared.messages])).rows,
        refs:(await c.query('SELECT message_id,owner_id,contact_id,source_document_id,raw_payload FROM message_source_ref WHERE source_document_id=$1 ORDER BY message_id',[prepared.source])).rows});
      const original=hash(await sourceRows());
      const requests=[];
      provider=createServer(async(req,res)=>{
        try{
          let raw='';for await(const part of req)raw+=part;
          requests.push({path:req.url,raw,headers:req.headers});
          const route=req.url==='/beta/chat/completions'?'strict_chat':req.url==='/anthropic/v1/messages'?'messages':'chat';
          const result=await dispatch({raw,path:req.url,route,signal:currentSignal});
          res.writeHead(result.http_status??200,{'content-type':result.content_type});res.end(result.raw_response);
        }catch(error){await writeFile(join(directory,`broker-error-${run.arm}-${requests.length}.json`),JSON.stringify({error:String(error.stack??error)}),{mode:0o600});res.writeHead(502);res.end('{"error":"guarded_broker_rejected"}');}
      });provider.listen(0,'127.0.0.1');await once(provider,'listening');
      const broker=`http://127.0.0.1:${provider.address().port}`;
      if(run.arm==='new')host=await startProfile({database:c.database,owner:scope[0],token,broker,log:join(directory,'profile-new.log')});
      const evidence={runtime:run.arm==='new'?'typescript':'isolated_python',inner_problem_budget_bound:false,
        source_commit:run.commit,profile_sha256:host?.profileSha??hash(await readFile(new URL('../nonreply-formal-runner-preparation/old-arm.py',import.meta.url))),
        model_host:host?{entry:host.info.model_host,journal_path_redacted:true,ownership:host.info.ownership}: {entry:'frozen_python_run_extraction',isolated:true},
        automatic_retry_qualification:host?'requested_internal_zero_requires_fixed_pin_fault_evidence':'sdk_retries_0_failure_fixture_single_arrival',
        profile_template_sha256:host?.templateSha??null,controls:host?.info.controls??{source:'frozen_old_arm_configuration_actual_wire_captured'},
        public_entry:run.arm==='new'?'/internal/extraction/run-b':'run_extraction'};
      return {evidence,async assertCurrent(){
        const rows=await sourceRows();assert.equal(hash(rows),original,'server_sources_changed');
        assert.ok([...rows.sources,...rows.messages,...rows.refs].every(r=>r.owner_id===scope[0]&&r.contact_id===scope[1]),'server_owner_contact_mismatch');
        assert.equal(rows.sources[0]?.status,'active','server_source_deleted');
        assert.equal(rows.messages.length,prepared.messages.length,'server_message_missing');
        const step=(await c.query('SELECT worker_id,lease_generation,status,lease_expires_at FROM background_task_step WHERE id=$1',[prepared.claim.stepId])).rows[0];
        assert.equal(step?.status,'running','server_task_not_running');assert.equal(step.worker_id,prepared.claim.workerId,'server_worker_changed');
        assert.ok(new Date(step.lease_expires_at).getTime()>Date.now(),'server_lease_expired');
        return {scope:{owner_id:rows.sources[0].owner_id,contact_id:rows.sources[0].contact_id},source_sha256:original,task_id:task,lease_generation:Number(step.lease_generation)};
      },async run(onDispatch,signal){
        dispatch=onDispatch;currentSignal=signal;let output;
        if(run.arm==='old'){
          const file=join(directory,'old-input.json');
          await writeFile(file,JSON.stringify({run,prepared,database:c.database,provider:broker+'/v1',frozen_source:join(snapshotRoot,'legacy/backend/src')}),{mode:0o600});
          const response=await execute(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[new URL('../nonreply-formal-runner-preparation/old-arm.py',import.meta.url).pathname,file],
            {env:{PATH:process.env.PATH,HOME:f.directory,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'},timeout:60000,maxBuffer:3*1024*1024});
          output=JSON.parse(response.stdout);await writeFile(join(directory,'old-output.log'),response.stdout+response.stderr,{mode:0o600});
        }else{
          const adopted=new Map();
          const runner=new ExtractionTaskRunner({store:{targets:async claim=>({...await store.targets(claim),contextIds:prepared.messages}),fenced:(...args)=>store.fenced(...args),check:(...args)=>store.check(...args)},
            batches:{async run(input){const response=await fetch(host.info.url+'/internal/extraction/run-b',{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input),signal});
              const value=await response.json();assert.ok(response.ok,JSON.stringify(value));adopted.set(input.trace_id,value.adoption);return value.outcome;}},
            async adopt(input){const value=adopted.get(input.trace_id);assert.ok(value,'finalized_adoption_required');return {watermark:value.watermark};},
            provider:'deepseek',modelName:'deepseek-flash',concurrency:1,batchSize:prepared.messages.length,contextBefore:prepared.messages.length,contextAfter:prepared.messages.length});
          output={terminal_status:'succeeded',output:await runner.run(prepared.claim,signal)};
        }
        const trace_events=(await c.query('SELECT stage,payload,position FROM memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2 ORDER BY position',scope)).rows;
        const counts=(await c.query('SELECT count(*)::int n FROM outbound_ledger_entry WHERE owner_id=$1 AND contact_id=$2',scope)).rows[0].n;
        const modelReceipts=(await c.query('SELECT count(*)::int n FROM model_call_receipt WHERE owner_id=$1 AND contact_id=$2',scope)).rows[0].n;
        let journalSha=null;if(host){const bytes=await readFile(host.info.model_host_state_path);journalSha=hash(bytes);await writeFile(join(directory,'model-host-final-journal.json'),bytes,{mode:0o600});}
        const facts=(await c.query('SELECT text_content,source_ids,adoption_method,status FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2',scope)).rows;
        await writeFile(join(directory,`requests-${run.arm}.json`),JSON.stringify(requests),{mode:0o600});
        return {terminal_status:output.terminal_status,output:output.output,audit:{persisted_physical_count:counts,
          source_snapshot_sha256:original,actual_model_host:host?.info??null,model_call_receipts:modelReceipts,model_host_journal_sha256:journalSha},business_output:{facts},trace_events};
      },close};
    }catch(error){await writeFile(join(directory,`business-open-error-${run.arm}.log`),String(error.stack??error),{mode:0o600});await close();throw error;}
  }};
}
