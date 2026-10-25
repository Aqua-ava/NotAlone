/** 具名真实Skill business.open；所有模型HTTP仍经统一执行器dispatch。 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createFixture} from './pg-fixture.mjs';
import {seedFixture,skillVersions} from './seed.mjs';
import {startProfile} from './profile-host.mjs';
import {sha} from './snapshot.mjs';
import {fivePhases} from './timing.mjs';
const execute=promisify(execFile),token='synthetic-skill-driver-only-token-00000000';
function oldProcess(file,rawDirectory,fixture){
  const python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
  const environment={PATH:process.env.PATH,HOME:fixture.directory,NOTALONE_SKILLS_DIR:join(fixture.directory,'skills'),NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'};
  const child=spawn(python,[new URL('./old-worker.py',import.meta.url).pathname,file],{env:environment,stdio:['pipe','pipe','pipe']});
  const queue=[],pending=[];let output='',stderr='',buffer='';
  child.stdout.on('data',bytes=>{output+=bytes;buffer+=bytes;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let value;try{value=JSON.parse(line);}catch{continue;}if(pending.length)pending.shift().resolve(value);else queue.push(value);}});
  child.stderr.on('data',b=>{stderr+=b;});const exited=once(child,'exit');
  child.once('exit',()=>{for(const next of pending.splice(0))next.reject(Error('isolated_old_worker_exited'));});
  async function next(){if(queue.length)return queue.shift();return new Promise((resolve,reject)=>{const entry={resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};const timer=setTimeout(()=>{pending.splice(pending.indexOf(entry),1);reject(Error('isolated_old_worker_timeout'));},60000);pending.push(entry);});}
  return {environment,python,next,async run(){child.stdin.end('{"action":"run"}\n');return next();},
    async close(){if(child.exitCode===null&&child.signalCode===null&&!child.stdin.writableEnded)child.stdin.end('{"action":"close"}\n');await exited;await writeFile(join(rawDirectory,'old-worker.log'),output+stderr,{mode:0o600});}};
}
export function createSkillBusiness({snapshotRoot,directory,contexts,receipts,modes=new Map()}){
  return {async open(run){
    assert.equal(run.domain,'skill_learning','named_skill_business_required');
    const rawDirectory=join(directory,sha(run.run_id).slice(0,16));await mkdir(rawDirectory,{mode:0o700});
    const fixture=await createFixture(receipts,directory);let host,old,provider,dispatch,signal,closed=false;
    const c=fixture.client,scope=[run.scope.owner_id,run.scope.contact_id];let owned,prepared,initial;
    const context={run,mode:modes.get(run.run_id)??'correction',fixture,rawDirectory};contexts.set(run.run_id,context);
    async function close(){if(closed)return;closed=true;await old?.close();await host?.close();provider?.closeAllConnections();if(provider)await new Promise(done=>provider.close(done));await fixture.close();}
    const http=async(path,body)=>{const response=await fetch(host.info.url+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,'production_skill_http_'+response.status+':'+JSON.stringify(value));return value;};
    const sourceRows=async()=>({
      sources:(await c.query('SELECT id,owner_id,contact_id,status,content_sha256 FROM source_document WHERE id=ANY($1::uuid[]) ORDER BY id',[owned.adaptation.sources.map(s=>s.storage_id)])).rows,
      messages:(await c.query('SELECT id,owner_id,contact_id,speaker,text_content,occurred_at FROM message WHERE id=ANY($1::uuid[]) ORDER BY id',[owned.adaptation.sources.map(s=>s.message_id)])).rows,
      refs:(await c.query('SELECT message_id,owner_id,contact_id,source_document_id,raw_payload FROM message_source_ref WHERE source_document_id=ANY($1::uuid[]) ORDER BY message_id',[owned.adaptation.sources.map(s=>s.storage_id)])).rows,
      inputs:(await c.query('SELECT id,owner_id,contact_id,state,content,dependency_ids,created_at FROM assistant_session_input WHERE owner_id=$1 AND contact_id=$2 ORDER BY id',scope)).rows,
      binding:(await c.query('SELECT id,owner_id,contact_id,status FROM conversation_binding WHERE id=$1',[owned.binding])).rows,
      skill_versions:await skillVersions(fixture,run),library:(await c.query('SELECT revision FROM skill_library WHERE owner_id=$1',[scope[0]])).rows,
      setting:(await c.query('SELECT owner_id,contact_id,enabled,revision FROM skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',scope)).rows});
    try{
      owned=await seedFixture(fixture,run);
      provider=createServer(async(req,res)=>{try{let raw='';for await(const part of req)raw+=part;
        const route=req.url==='/anthropic/v1/messages'?'messages':req.url==='/v1/chat/completions'?'chat':null;
        assert.ok(route,'unexpected_skill_model_route');
        const value=await dispatch({raw,path:req.url,route,signal});res.writeHead(value.http_status??200,{'content-type':value.content_type});res.end(value.raw_response);
      }catch(error){await writeFile(join(rawDirectory,'broker-error.log'),String(error.stack??error),{mode:0o600});res.writeHead(502,{'content-type':'application/json'});res.end('{"error":"guarded_broker_rejected"}');}});
      provider.listen(0,'127.0.0.1');await once(provider,'listening');const broker='http://127.0.0.1:'+provider.address().port;
      const oldInput={scope:run.scope,database:fixture.database,provider:broker,frozen_source:join(snapshotRoot,'candidate/backend/src')};
      if(run.arm==='new'){
        host=await startProfile({fixture,run,broker,token,rawDirectory,skillsRoot:owned.skillFilesRoot});prepared=await http('/driver/open',{});
      }else{
        const file=join(rawDirectory,'old-input.json');await writeFile(file,JSON.stringify(oldInput),{mode:0o600});old=oldProcess(file,rawDirectory,fixture);prepared=await old.next();
      }
      assert.ok(prepared.batch?.ready,'nonempty_skill_batch_required');assert.ok(prepared.claim?.taskId,'persistent_skill_claim_required');
      Object.assign(context,{prepared,owned});initial=sha(await sourceRows());
      context.cancel=async()=>{
        if(run.arm==='new')context.cancel_receipt=await http(`/api/contacts/${run.scope.contact_id}/skill-learning`,{enabled:false,confirmed:true,operation_key:randomUUID(),expected_revision:1});
        else{
          const file=join(rawDirectory,'old-cancel.json');await writeFile(file,JSON.stringify({...oldInput,cancel_only:true}),{mode:0o600});
          const result=await execute(old.python,[new URL('./old-worker.py',import.meta.url).pathname,file],{env:old.environment,timeout:10000,maxBuffer:4096});context.cancel_receipt=JSON.parse(result.stdout);
        }
        const state=(await c.query('SELECT enabled,revision FROM skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',scope)).rows[0];
        assert.equal(state.enabled,false);assert.equal(Number(state.revision),2);context.cancel_persisted=true;
      };
      const evidence={runtime:run.arm==='new'?'typescript':'isolated_python',source_commit:run.commit,inner_problem_budget_bound:false,
        profile_sha256:host?.profileSha??sha(await readFile(new URL('./old-worker.py',import.meta.url))),profile_template_sha256:host?.templateSha??null,
        model_host:host?{entry:host.info.model_host,ownership:host.info.ownership,background_worker_started:false}:{entry:'frozen_python_public_entry_no_ModelHost',isolated:true},
        public_entry:run.arm==='new'?'SkillLearningTaskRunner.run → SkillLearningRuntime.propose → createHostReplyRuntime.callExtraction':'PostgresSkillLearningStore.capture → LangChainSkillProposalRuntime.propose → PostgresSkillLearningStore.save',
        automatic_retries:0,source_manifest:owned.adaptation.sources.map(s=>({source_id:s.source_id,version:s.version,state:s.state,speaker:s.speaker,observed_at:s.observed_at,text_sha256:sha(s.text)})),
        clock:{frozen_as_of:owned.adaptation.as_of,applied_as_of:false,public_learning_clock:'absent',global_Date_mocked:false,pg_now_mocked:false},
        controls:host?.info.controls??{model:'deepseek-flash',maxTokens:393216,temperature:0,top_p:1,reasoningEffort:'off'}};
      return {evidence,async assertCurrent(){
        const rows=await sourceRows();assert.equal(sha(rows),initial,'server_skill_sources_or_authorization_changed');
        assert.equal(rows.setting[0]?.enabled,true,'server_skill_authorization_revoked');
        assert.ok([...rows.sources,...rows.messages,...rows.refs,...rows.inputs].every(row=>row.owner_id===scope[0]&&row.contact_id===scope[1]),'server_skill_scope_mismatch');
        for(const s of owned.adaptation.sources){const source=rows.sources.find(row=>row.id===s.storage_id);assert.equal(source?.status,'active');assert.equal(source?.content_sha256,sha(s.text),'independent_source_text_mismatch');
          const message=rows.messages.find(row=>row.id===s.message_id);assert.equal(message?.text_content,s.text);assert.equal(message?.speaker,s.speaker);assert.equal(new Date(message?.occurred_at).toISOString(),new Date(s.observed_at).toISOString());}
        const lease=(await c.query('SELECT task_id,worker_id,lease_generation,status,lease_expires_at FROM background_task_step WHERE id=$1',[prepared.claim.stepId])).rows[0];
        assert.equal(lease.status,'running');assert.equal(lease.worker_id,prepared.claim.workerId);assert.equal(Number(lease.lease_generation),prepared.claim.leaseGeneration);assert.ok(new Date(lease.lease_expires_at).getTime()>Date.now(),'server_skill_lease_expired');
        context.source_rechecks=(context.source_rechecks??0)+1;
        return {scope:run.scope,source_sha256:initial,task_id:lease.task_id,lease_generation:Number(lease.lease_generation)};
      },async run(onDispatch,requestSignal){
        dispatch=onDispatch;signal=requestSignal;const result=host?await http('/driver/run',{}):await old.run();
        const drafts=(await c.query('SELECT id,status,revision,proposal_kind,strategy,target_versions,dependency_ids,source_generation,created_at FROM skill_draft WHERE owner_id=$1 AND contact_id=$2 ORDER BY created_at',scope)).rows;
        const ledger=(await c.query('SELECT outcome,input_tokens,output_tokens,model_name FROM outbound_ledger_entry WHERE owner_id=$1 AND contact_id=$2',scope)).rows;
        const receiptsRows=(await c.query('SELECT outcome,dispatch,input_tokens,output_tokens,cost_status FROM model_call_receipt WHERE owner_id=$1 AND contact_id=$2',scope)).rows;
        const versions=await skillVersions(fixture,run),tasks=(await c.query('SELECT status,retry_count,last_error_code FROM background_task WHERE owner_id=$1 AND contact_id=$2',scope)).rows;
        const taskSteps=(await c.query('SELECT step_name,status,attempt_count FROM background_task_step WHERE task_id=$1 ORDER BY step_order',[prepared.claim.taskId])).rows;
        const correction=owned.adaptation.sources.find(s=>s.corrects_source_ids?.length),bound=correction?drafts.length>0&&drafts.every(d=>d.dependency_ids.includes(correction.storage_id)&&d.dependency_ids.includes(correction.message_id)):null;
        let approvalProbe=null;
        if(host&&drafts.length){
          const response=await fetch(host.info.url+`/api/contacts/${scope[1]}/skill-learning/drafts/${drafts[0].id}/approve`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
            body:JSON.stringify({expected_revision:1,operation_key:randomUUID(),comparison_id:randomUUID(),scope:{kind:'contact',contact_id:scope[1],scene:null},confirmed:true,replacements_confirmed:true})});
          const body=await response.text();approvalProbe={http_status:response.status,rejected:!response.ok,controlled_rejection:response.status>=400&&response.status<500,response_sha256:sha(body)};
          await writeFile(join(rawDirectory,'approval-without-comparison.json'),JSON.stringify({status:response.status,body}),{mode:0o600});
          assert.equal(approvalProbe.rejected,true,'uncompared_draft_publication_must_be_rejected');
          const unchanged=(await c.query('SELECT status,revision FROM skill_draft WHERE id=$1',[drafts[0].id])).rows[0];assert.equal(unchanged.status,'pending');assert.equal(unchanged.revision,1);
        }
        const audit={persisted_physical_count:ledger.length,model_call_receipts:receiptsRows,task_states:tasks,task_steps:taskSteps,actual_ledger:ledger,
          actual_source_snapshot_sha256:initial,existing_v1_unchanged:sha(versions)===sha(owned.skillBefore),correction_source_bound:bound,
          source_versions:owned.adaptation.sources.map(s=>({source_id:s.source_id,version:s.version,observed_at:s.observed_at})),cancel_persisted:context.cancel_persisted??false,
          source_rechecks:context.source_rechecks??0,target_version_bound:drafts.length>0&&drafts.every(d=>d.target_versions.length===1&&d.target_versions.every(t=>owned.skillBefore.some(v=>v.id===t.skill_id&&v.version_id===t.version_id&&v.version_number===t.version_number))),
          actual_pg_observed_at:(await c.query('SELECT clock_timestamp() AS current')).rows[0].current,
          approval_without_comparison:approvalProbe,published_count:drafts.filter(d=>d.status==='published').length,automatic_retries:0};
        if(host){const journal=await readFile(host.info.model_host_state_path);await writeFile(join(rawDirectory,'model-host-journal.json'),journal,{mode:0o600});audit.model_host_journal_sha256=sha(journal);}
        const output={terminal_status:result.terminal_status,error_code:result.error_code??null,audit,business_output:{drafts,skill_versions:versions},
          observed_events:result.events,five_phase_evidence:fivePhases(result.events,result.terminal_status,drafts.length>0)};
        context.output=output;await writeFile(join(rawDirectory,'business-output.json'),JSON.stringify(output,null,2),{mode:0o600});return output;
      },close};
    }catch(error){await writeFile(join(rawDirectory,'business-open-failure.log'),String(error.stack??error),{mode:0o600});await close();throw error;}
  }};
}
