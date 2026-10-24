/** 整理沿真实SDK、私有许可、正式PG：完整错误可重试，半正文保持未知。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
const here=resolve(new URL('.',import.meta.url).pathname),root=resolve(here,'../..');
for(const ownerOnly of [false,true])for(const broken of [false,true])test(`整理 ${ownerOnly?'本人':'联系人'} ${broken?'半正文未知禁止重试':'完整400已知失败可重试'}`,{timeout:30000},async t=>{
 const f=await createStorageFixture(),temp=await mkdtemp(join(tmpdir(),'notalone-org-known-'));let server,http,child,childStopped;
 t.after(async()=>{if(child&&child.exitCode===null)child.kill('SIGKILL');if(childStopped)await Promise.allSettled([childStopped]);if(http){http.closeAllConnections();await new Promise(r=>http.close(r));}await server?.shutdown();await f.close();await rm(temp,{recursive:true,force:true});});
 const owner=randomUUID(),contact=ownerOnly?null:randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成')",[owner]);
 if(contact)await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成')",[contact,owner]);
 await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)",[task,owner,contact]);
 await f.client.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at) VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '2 minutes')",[step,task,worker]);
 await f.client.query('INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation) VALUES($1,$2,true,1)',[owner,contact]);
 await f.client.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit) VALUES($1,$2,$3,1,'synthetic','synthetic','{}','{}','active',1,3)",[task,owner,contact]);
 await f.client.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id) VALUES($1,$2,$3,1,$4,'running','[]','[]','{}',now(),$5)",[randomUUID(),owner,contact,randomUUID(),task]);
 const transaction=async work=>{const c=new pg.Client({host:'/tmp',database:f.client.database});await c.connect();try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}};
 const arbiter=new ModelPermitArbiter(1),socket=join(temp,'permit.sock'),token='synthetic'.repeat(6);
 server=await startModelPermitServer({path:socket,token,arbiter,accounting:createHostModelAccounting({transaction,provider:'deepseek',model:'synthetic-model',unconfirmedPermitIds:()=>server.unconfirmedPermitIds()})});
 let calls=0;const before=[];
 http=createServer(async(req,res)=>{for await(const chunk of req){}calls++;before.push((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n);
  if(calls===1){res.writeHead(400,{'content-type':'application/json',...(broken?{'content-length':'99999'}:{})});res.end(JSON.stringify({error:{message:'synthetic reject',type:'invalid_request_error'}}));return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'synthetic',object:'chat.completion',created:1,model:'synthetic-model',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'synthetic'}}]}));
 });await new Promise(r=>http.listen(0,'127.0.0.1',r));
 child=spawn(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[join(here,'model-organization-physical-fixture.py')],{env:{PATH:'/usr/bin:/bin',HOME:homedir(),PYTHONPATH:join(root,'backend/src'),NOTALONE_DISABLE_DOTENV:'1',NOTALONE_MODEL_PERMIT_SOCKET:socket},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const exited=childStopped=new Promise((r,j)=>{child.once('exit',r);child.once('error',j);});
 child.stdin.end(JSON.stringify({owner,contact,task,socket,token,url:`http://127.0.0.1:${http.address().port}/v1`,claim:{task_id:task,step_id:step,step_name:'organize_memory',worker_id:worker,lease_generation:1}})+'\n');
 assert.equal(await exited,0,stderr);const result=JSON.parse(stdout);
 const rows=(await f.client.query('SELECT attempt_id,ledger_entry_id,outcome,dispatch,called_at,input_tokens,output_tokens,cost_amount FROM model_call_receipt ORDER BY called_at')).rows;
 assert.deepEqual(rows.map(r=>r.outcome),broken?['unknown']:['failed','succeeded']);
 assert.equal(calls,broken?1:2);assert.deepEqual(before,broken?[1]:[1,2]);
 assert.equal(new Set(rows.map(r=>r.attempt_id)).size,calls);assert.ok(rows.every(r=>r.input_tokens===null&&r.output_tokens===null&&r.cost_amount===null));
 const legacy=(await f.client.query('SELECT id,outcome,called_at FROM outbound_ledger_entry ORDER BY called_at')).rows;
 assert.equal(legacy.length,ownerOnly?0:calls);if(legacy.length){assert.deepEqual(legacy.map(r=>r.id),rows.map(r=>r.ledger_entry_id));assert.deepEqual(legacy.map(r=>r.outcome),broken?['run_failed']:['run_failed','succeeded']);assert.deepEqual(legacy.map(r=>r.called_at),rows.map(r=>r.called_at));}
 assert.equal((await f.client.query('SELECT model_calls_used FROM layered_memory_job WHERE task_id=$1',[task])).rows[0].model_calls_used,calls);
 assert.equal(arbiter.snapshot().backgroundActive,0);assert.equal(result.results[1],broken?'ModelWorkStopped':'ok');
});
