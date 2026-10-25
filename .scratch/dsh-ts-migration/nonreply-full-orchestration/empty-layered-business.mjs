/** 原公开流程创建并完成的空任务；不把真实完成任务伪称 taskless。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';
const execute=promisify(execFile);
const id=value=>{const h=sha(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export const supportsEmptyLayered=run=>['l2_scenario','l3_profile'].includes(run.domain)&&!run.material.input.sources.some(s=>s.state==='active'&&s.subject==='contact'&&s.owner_id===run.material.input.scope.owner_id&&s.contact_id===run.material.input.scope.contact_id);
export function createEmptyLayeredBusiness({snapshot,directory,contexts,receipts}){
  const load=path=>import(pathToFileURL(join(snapshot.candidate,path)));
  return {async open(run){
    assert.ok(supportsEmptyLayered(run),'empty_layered_material_required');
    const {createFixture}=await load('.scratch/dsh-ts-migration/nonreply-skill-formal-driver/pg-fixture.mjs');
    const fixture=await createFixture(receipts,directory),c=fixture.client,scope=run.scope,args=[scope.owner_id,scope.contact_id];
    try{
      await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[scope.owner_id]);await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[scope.contact_id,scope.owner_id]);
      for(const source of run.material.input.sources){
        assert.equal(source.owner_id,run.material.input.scope.owner_id,'empty_source_owner_mapping_unavailable');assert.equal(source.contact_id,run.material.input.scope.contact_id,'empty_foreign_source_mapping_unavailable');
        const sourceId=id(run.run_id+':'+source.source_id),memory=id(sourceId+':memory');
        await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status,deleted_at)VALUES($1,$2,$3,'manual',$4,$5,$6,$7,$8)",
          [sourceId,...args,source.state==='deleted'?null:'synthetic-only',source.state==='deleted'?null:sha(source.text),source.state==='deleted'?0:1,source.state==='deleted'?'deleted':'active',source.state==='deleted'?source.observed_at:null]);
        if(source.state==='active'){
          assert.equal(source.subject,'owner','empty_contact_source_must_not_be_removed');
          await c.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method,status,revision)VALUES($1,$2,$3,'common_fact','other',$4,'manual','active',$5)",[memory,scope.owner_id,source.text,[sourceId],source.version]);
        }
      }
      await c.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation,status,organization_generation)VALUES($1,$2,true,1,'stale',0)",args);
      let response,entry;
      if(run.arm==='new'){
        const {createLayeredMemoryManagement}=await load('backend-ts/src/layered-memory-management.ts');
        const transaction=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}};
        const management=createLayeredMemoryManagement({ownerId:scope.owner_id,transaction,modelWorkAvailable:()=>true,wake(){throw Error('empty_layered_worker_must_not_start');}});
        response=await management.handle('POST',new URL(`http://localhost/api/contacts/${scope.contact_id}/layered-memory/refresh`),{settings_generation:1},new AbortController().signal);
        assert.equal(response.status,200,'empty_layered_public_refresh_failed');assert.equal(response.body.layered_memory.status,'empty','empty_public_status_not_observed');
        entry='createLayeredMemoryManagement.handle POST /api/contacts/:id/layered-memory/refresh';
      }else{
        const input=join(directory,'empty-old-input.json');await writeFile(input,JSON.stringify({scope,database:fixture.database,frozen_source:join(snapshot.legacy,'backend/src')}),{mode:0o600});
        const result=await execute(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[new URL('./empty-layered-old.py',import.meta.url).pathname,input],{
          env:{PATH:process.env.PATH,HOME:fixture.directory,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'},timeout:30000,maxBuffer:2*1024*1024});
        response=JSON.parse(result.stdout);entry=response.entry;await writeFile(join(directory,'empty-old-raw.log'),result.stdout+result.stderr,{mode:0o600});
      }
      const observe=async()=>({sources:(await c.query('SELECT id,owner_id,contact_id,status,content_sha256 FROM source_document ORDER BY id')).rows,
        memories:(await c.query('SELECT id,owner_id,revision,status FROM owner_memory ORDER BY id')).rows,
        authorization:(await c.query('SELECT owner_id,contact_id,enabled,settings_generation,status FROM layered_memory_state')).rows,
        tasks:(await c.query('SELECT id,status FROM background_task ORDER BY id')).rows,
        jobs:(await c.query('SELECT task_id,state,model_calls_used,profile_status FROM layered_memory_job ORDER BY task_id')).rows,
        ledger:(await c.query('SELECT id FROM outbound_ledger_entry')).rows});
      const state=await observe();assert.equal(state.ledger.length,0);assert.equal(state.authorization[0].enabled,true);assert.equal(state.authorization[0].status,'empty');
      assert.ok(state.tasks.length>0&&state.tasks.every(t=>t.status==='succeeded'),'actual_empty_task_not_terminal');assert.ok(state.jobs.every(j=>Number(j.model_calls_used)===0),'empty_task_inner_reservation_observed');
      const sourceSha=sha(state),task=state.tasks[0].id,proof={verified:true,scope,source_sha256:sourceSha,task_count:state.tasks.length,terminal_task_ids:state.tasks.map(t=>t.id),ledger_count:0,
        public_response_sha256:sha(response),authorization:{allowed:true,enabled:true},status:'empty',public_entry:entry};
      contexts.set(run.run_id,{run,fixture,response,async verify(){assert.equal(sha(await observe()),sourceSha,'empty_terminal_snapshot_changed');return proof;}});
      await writeFile(join(directory,'empty-layered-evidence.json'),JSON.stringify({response,state,proof}),{mode:0o600});
      return {evidence:{source_commit:run.commit,runtime:run.arm==='new'?'typescript':'isolated_python',inner_problem_budget_bound:false,profile_sha256:sha(await readFile(new URL('./empty-layered-business.mjs',import.meta.url))),
          model_host:{used:false,reason:'public_flow_committed_empty_without_model'},public_entry:entry},
        async assertCurrent(){await contexts.get(run.run_id).verify();return {scope,source_sha256:sourceSha,execution_kind:'observed_terminal',task_id:task,lease_generation:null};},
        async run(){return {terminal_status:'idle',business_output:{status:'empty',actual_completed_task:true},audit:{persisted_physical_count:0,pg_job_call_reservations:0}};},close:()=>fixture.close()};
    }catch(error){await writeFile(join(directory,'empty-open-error.log'),String(error.stack??error)+'\n'+String(error.stdout??'')+String(error.stderr??''),{mode:0o600});await fixture.close();throw error;}
  }};
}
