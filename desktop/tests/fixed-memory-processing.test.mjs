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

test('记忆入口沿认证运行状态识别存储模式，未知模式不回落旧页面',async t=>{
 let storage='sqlite';const f=await fixture(t,async req=>{assert.equal(req.path,'/api/runtime/status');assert.equal(req.method,'GET');assert.equal(req.body,undefined);return {state:'running',runtime:'dsh',hostRuntime:'typescript',...(storage===undefined?{}:{storage})};});
 assert.deepEqual(await f.controller.mode(),{connectionGeneration:1,mode:'sqlite'});
 storage=undefined;assert.deepEqual(await f.controller.mode(),{connectionGeneration:1,mode:'legacy'});
 storage='unverified';await assert.rejects(f.controller.mode());assert.equal(f.invalidations.length,1);
});

test('具名模式桥不接受renderer自选模式或额外参数',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'notalone-fixed-mode-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'preload.mjs');await build({entryPoints:['src/preload/fixed-memory-processing.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {createFixedMemoryProcessingBridge}=await import(pathToFileURL(output));const calls=[];
 const bridge=createFixedMemoryProcessingBridge({invoke:async(...args)=>{calls.push(args);return {mode:'sqlite',connectionGeneration:1};}});
 assert.deepEqual(await bridge.readMode(),{mode:'sqlite',connectionGeneration:1});assert.deepEqual(calls,[['memory:fixed-processing-mode']]);
 await assert.rejects(bridge.readMode('legacy'));assert.equal(calls.length,1);
});

test('面板释放只取消正文，模式核验仍等待其回执且完整资格变化会取消模式',async t=>{
 let entered=Promise.withResolvers(),response=Promise.withResolvers();
 const f=await fixture(t,async()=>{entered.resolve();return response.promise;});
 const mode=f.controller.mode();await entered.promise;f.controller.release();
 response.resolve({state:'running',runtime:'dsh',hostRuntime:'typescript',storage:'sqlite'});
 assert.deepEqual(await mode,{connectionGeneration:1,mode:'sqlite'});
 entered=Promise.withResolvers();response=Promise.withResolvers();
 const staleMode=f.controller.mode();await entered.promise;f.changeGeneration();
 response.resolve({state:'running',runtime:'dsh',hostRuntime:'typescript',storage:'sqlite'});await assert.rejects(staleMode);
 entered=Promise.withResolvers();response=Promise.withResolvers();
 const body=f.controller.read();await entered.promise;f.controller.release();response.resolve(snapshot());await assert.rejects(body);
});

test('只有全部阶段完成的权威合同才接受整轮完成',async t=>{
 let data={...snapshot(),state:'completed',stage:'completed',laterStages:'completed'};
 const f=await fixture(t,async()=>data);const completed=await f.controller.read();assert.equal(completed.run.state,'completed');assert.equal(completed.run.laterStages,'completed');
 for(const invalid of [{...data,laterStages:'pending'},{...data,state:'incomplete'},{...data,stage:'extraction_verification'}]){data=invalid;await assert.rejects(f.controller.read());}
});
