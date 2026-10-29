import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const ids={run:'11111111-1111-4111-8111-111111111111',task:'22222222-2222-4222-8222-222222222222',contact:'33333333-3333-4333-8333-333333333333',request:'44444444-4444-4444-8444-444444444444'};
const snapshot=()=>({runId:ids.run,state:'incomplete',total:1,succeeded:1,failed:0,unknown:0,stage:'extraction_verification',laterStages:'pending',
 tasks:[{taskId:ids.task,scopeKind:'contact',contactId:ids.contact,state:'succeeded',total:1,succeeded:1,errorCode:null}],inputs:[],candidates:[]});
async function fixture(t,handle){
 const root=await mkdtemp(path.join(tmpdir(),'notalone-fixed-processing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'controller.mjs');await build({entryPoints:['src/main/memory/fixed-processing.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {FixedMemoryProcessingController}=await import(pathToFileURL(output));let generation=1;const calls=[],invalidations=[];
 const backend={getConnectionGeneration:()=>generation,requestJson:async req=>{calls.push(req);return {generation,data:await handle(req)};}};
 const controller=new FixedMemoryProcessingController(backend,event=>invalidations.push(event));
 return {controller,calls,invalidations,changeGeneration:()=>{generation++;controller.synchronize();}};
}
test('固定轮次具名入口只发request_key，保留未完成阶段且旧连接写入不出站',async t=>{
 const f=await fixture(t,async()=>snapshot());const view=await f.controller.read();assert.equal(view.connectionGeneration,1);assert.equal(view.run.state,'incomplete');
 const started=await f.controller.start({requestKey:ids.request,connectionGeneration:1});assert.equal(started.run.succeeded,1);
 assert.deepEqual(f.calls[1].body,{request_key:ids.request});assert.equal(f.calls[1].path,'/api/memory-processing/runs');
 f.changeGeneration();const count=f.calls.length;await assert.rejects(f.controller.start({requestKey:ids.request,connectionGeneration:1}));assert.equal(f.calls.length,count);
 await assert.rejects(f.controller.start({requestKey:ids.request,connectionGeneration:2,ownerId:'other'}));assert.equal(f.calls.length,count);
});
test('状态读取拒绝会通知撤下旧快照，失效后旧回调不能返回正文',async t=>{
 let rejectRead=false,finish,entered;
 const started=new Promise(resolve=>{entered=resolve;});const pending=new Promise(resolve=>{finish=resolve;});let wait=false;
 const f=await fixture(t,async()=>{if(rejectRead)throw new Error('synthetic_denied');if(wait){entered();return pending;}return snapshot();});
 await f.controller.read();rejectRead=true;await assert.rejects(f.controller.read());assert.equal(f.invalidations.length,1);
 rejectRead=false;wait=true;const old=f.controller.read();await started;f.controller.synchronize();finish({...snapshot(),candidates:[{id:ids.request,scopeKind:'contact',contactId:ids.contact,body:'失效旧正文',state:'verified_pending_decision',origin:'auto'}]});
 await assert.rejects(old);assert.equal(f.invalidations.length,2);
});
test('unknown、无产出与缺失阶段不互相伪装，非法成功状态拒绝',async t=>{
 let data={...snapshot(),state:'failed',succeeded:0,unknown:1};
 const f=await fixture(t,async()=>data);assert.equal((await f.controller.read()).run.unknown,1);
 data={...snapshot(),state:'completed'};await assert.rejects(f.controller.read());assert.equal(f.invalidations.length,1);
});
