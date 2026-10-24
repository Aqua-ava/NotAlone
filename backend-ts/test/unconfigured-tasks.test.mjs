/** 无模型时原共享 metadata RPC、真实来源删除与原模型任务隔离。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
const root=resolve(new URL('../..',import.meta.url).pathname),require=createRequire(join(root,'backend-ts/package.json')),pg=require('pg');
for(const phase of ['source','taskhost-delete','source-default','controls','automatic','learning','organization'])test(({source:'无模型的共享来源删除完成五步且不恢复同范围无关模型租约','taskhost-delete':'无模型TaskHost仍运行原删除五步而不构造模型','source-default':'默认能力保留原过期恢复且共享公开删除可完成',controls:'模型恢复和重试在持久重排前拒绝且仍可导入',automatic:'无模型观察唤醒不分配批次或启动自动重排',learning:'无模型时学习设置仍保存而读取和恢复不先排模型任务',organization:'无模型时手录保留而自动整理和refresh不先排模型任务'})[phase],{timeout:30000},async t=>{
 const f=await createStorageFixture(),directory=await mkdtemp(join(tmpdir(),'notalone-unconfigured-tasks-'));
 await mkdir(join(directory,'user-data'),{mode:0o700});let server,child;let metadataCalls=0;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}await server?.shutdown();await f.close();await rm(directory,{recursive:true,force:true});});
 const transaction=async work=>{const client=new pg.Client({host:'/tmp',database:f.client.database});await client.connect();
  try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{await client.end();}};
 const original=createHostModelAccounting({transaction,provider:'deepseek',model:'synthetic-model',unconfirmedPermitIds:()=>server.unconfirmedPermitIds()});
 const accounting={...original,unconfirmedRequests:async scope=>{metadataCalls++;return original.unconfirmedRequests(scope);}};
 const socket=join(directory,'permit.sock'),token='synthetic-permit-'+randomUUID();
 server=await startModelPermitServer({path:socket,token,arbiter:new ModelPermitArbiter(1),accounting});
 const config={database:`host=/tmp dbname=${f.client.database}`,directory,socket,token,phase};
 child=spawn(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[join(root,'backend-ts/test/unconfigured-tasks-fixture.py')],{
  env:{PATH:'/usr/bin:/bin',HOME:homedir(),USER:process.env.USER,PYTHONPATH:join(root,'backend/src'),NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1',NOTALONE_MANAGED_USER_DATA:join(directory,'user-data')},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const done=once(child,'exit');child.stdin.end(JSON.stringify(config));
 let timer;try{const [code]=await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic_task_timeout')),15000);})]);assert.equal(code,0,stderr);}finally{clearTimeout(timer);}
 const result=JSON.parse(stdout);if(['source','taskhost-delete','source-default'].includes(phase)){assert.equal(result.source_status,'deleted');assert.equal(result.completed_steps,5);assert.equal(result.unrelated_model_unchanged,phase!=='source-default');}
 else if(phase==='controls'){assert.deepEqual(result.statuses,[503,503,503]);assert.equal(result.model_task_unchanged,true);assert.equal(result.import_still_queued,true);}
 else if(phase==='automatic'){assert.equal(result.no_observation_task,true);assert.equal(result.schedule_unchanged,true);}
 else if(phase==='learning'){assert.equal(result.learning_settings_preserved,true);assert.equal(result.no_learning_task,true);assert.equal(result.resume_status,503);}
 else{assert.equal(result.manual_preserved,true);assert.equal(result.no_automatic_organization,true);assert.equal(result.refresh_rejected_before_write,true);assert.equal(result.pause_allowed,true);assert.equal(result.disable_allowed,true);}
 assert.equal(result.model_http,0);assert.equal(result.bge_calls,0);assert.ok(metadataCalls>0,'必须经过真实认证Unix metadata RPC');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM outbound_ledger_entry')).rows[0].n,0);
 t.diagnostic(JSON.stringify({...result,metadataCalls}));
});
