/** 全删来源学习材料的真实零任务路径；源、授权、公开响应和PG计数均可复验。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sha} from '../nonreply-persistent-broker/attempt-journal.mjs';

const execute=promisify(execFile);
export const supportsTaskless=run=>run.domain==='skill_learning'&&run.material.input.sources.every(s=>s.state==='deleted');
export function createTasklessBusiness({snapshot,directory,contexts,receipts}){
  const importAt=path=>import(pathToFileURL(join(snapshot.candidate,path)));
  return {async open(run){
    assert.ok(supportsTaskless(run),'taskless_material_not_supported');
    const [{createFixture},{seedFixture}]=await Promise.all([importAt('.scratch/dsh-ts-migration/nonreply-skill-formal-driver/pg-fixture.mjs'),importAt('.scratch/dsh-ts-migration/nonreply-skill-formal-driver/seed.mjs')]);
    const fixture=await createFixture(receipts,directory),c=fixture.client,scope=run.scope;let server,closed=false;
    const close=async()=>{if(closed)return;closed=true;server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await fixture.close();};
    try{
      const owned=await seedFixture(fixture,run);let response,entry,auxiliaryRejection=null;
      if(run.arm==='new'){
        const [{SkillFiles},{SkillLearningStore},{SkillLearningHttp}]=await Promise.all(['skill-files.ts','skill-learning-store.ts','skill-learning-http.ts'].map(p=>importAt('backend-ts/src/'+p)));
        const transaction=async work=>{await c.query('BEGIN');try{const value=await work(c);await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK');throw error;}};
        const learning=new SkillLearningStore({transaction,files:new SkillFiles(owned.skillFilesRoot),taskStore:{async assertLease(){throw Error('taskless_lease_must_not_be_requested');}}});
        const handler=new SkillLearningHttp({ownerId:scope.owner_id,learning,canSchedule:true,wake(){throw Error('taskless_unexpected_task_created');}});
        const token='synthetic-taskless-auth-only';
        server=createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return;}
          try{let raw='';for await(const chunk of req)raw+=chunk;const value=await handler.handle(req.method,new URL(req.url,'http://localhost'),raw?JSON.parse(raw):undefined,new AbortController().signal);res.writeHead(value.status,{'content-type':'application/json'});res.end(JSON.stringify(value.body));}
          catch{res.writeHead(500);res.end('{"error":"taskless_boundary_failed"}');}});
        server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
        const result=await fetch(origin+`/api/contacts/${scope.contact_id}/skill-learning`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({enabled:true,confirmed:true,expected_revision:0,operation_key:randomUUID()})});
        response={http_status:result.status,body:await result.json()};assert.equal(response.http_status,200,'taskless_public_configuration_failed');
        const foreign=randomUUID(),denied=await fetch(origin+`/api/contacts/${foreign}/skill-learning`,{headers:{authorization:'Bearer '+token}});
        auxiliaryRejection={http_status:denied.status,body:await denied.json()};assert.equal(auxiliaryRejection.http_status,404,'taskless_foreign_scope_not_rejected');
        entry='SkillLearningHttp.handle POST/GET /api/contacts/:id/skill-learning';
      }else{
        const path=join(directory,'taskless-old-input.json');await writeFile(path,JSON.stringify({database:fixture.database,scope,frozen_source:join(snapshot.legacy,'backend/src')}),{mode:0o600});
        const result=await execute(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[new URL('./taskless-old.py',import.meta.url).pathname,path],{
          env:{PATH:process.env.PATH,HOME:fixture.directory,NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'},timeout:30000,maxBuffer:1024*1024});
        response=JSON.parse(result.stdout);entry=response.entry;await writeFile(join(directory,'taskless-old-raw.log'),result.stdout+result.stderr,{mode:0o600});
      }
      const state=async()=>({sources:(await c.query('SELECT id,owner_id,contact_id,status,content_sha256 FROM source_document ORDER BY id')).rows,
        authorization:(await c.query('SELECT owner_id,contact_id,enabled,revision FROM skill_learning_scope WHERE owner_id=$1 AND contact_id=$2',[scope.owner_id,scope.contact_id])).rows,
        tasks:(await c.query('SELECT id,status FROM background_task')).rows,ledger:(await c.query('SELECT id FROM outbound_ledger_entry')).rows,
        messages:(await c.query('SELECT id FROM message')).rows});
      const initial=await state();assert.equal(initial.tasks.length,0,'taskless_real_task_exists');assert.equal(initial.ledger.length,0);assert.equal(initial.messages.length,0);
      assert.equal(initial.authorization[0]?.enabled,true);assert.ok(initial.sources.every(s=>s.status==='deleted'&&s.owner_id===scope.owner_id&&s.contact_id===scope.contact_id));
      const sourceSha=sha(initial),proof={scope,source_sha256:sourceSha,task_count:0,ledger_count:0,public_response_sha256:sha(response),authorization:{allowed:true,enabled:true,revision:Number(initial.authorization[0].revision)},status:'not_ready',public_entry:entry};
      const context={run,fixture,response,auxiliaryRejection,async verify(){const current=await state();assert.equal(sha(current),sourceSha,'taskless_persistent_evidence_changed');return {...proof,verified:true};}};
      contexts.set(run.run_id,context);await writeFile(join(directory,'taskless-business-evidence.json'),JSON.stringify({response,auxiliaryRejection,initial,proof}),{mode:0o600});
      return {evidence:{runtime:run.arm==='new'?'typescript':'isolated_python',source_commit:run.commit,inner_problem_budget_bound:false,
        profile_sha256:sha(await readFile(new URL('./taskless-business.mjs',import.meta.url))),model_host:{used:false,reason:'public_business_did_not_create_task'},public_entry:entry},
        async assertCurrent(){await context.verify();return {scope,source_sha256:sourceSha,execution_kind:'taskless',task_id:null,lease_generation:null};},
        async run(){return {terminal_status:'idle',business_output:{status:'not_ready',task_created:false,source_states:initial.sources.map(s=>s.status)},
          audit:{persisted_physical_count:0,auxiliary_foreign_scope_rejection:auxiliaryRejection?{http_status:auxiliaryRejection.http_status,response_sha256:sha(auxiliaryRejection.body)}:null}};},close};
    }catch(error){await close();throw error;}
  }};
}
