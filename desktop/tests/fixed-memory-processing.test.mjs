import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const ids={run:'11111111-1111-4111-8111-111111111111',task:'22222222-2222-4222-8222-222222222222',contact:'33333333-3333-4333-8333-333333333333',request:'44444444-4444-4444-8444-444444444444'};
const snapshot=()=>({runId:ids.run,state:'incomplete',total:1,succeeded:1,failed:0,unknown:0,stage:'extraction_verification',laterStages:'pending',status:'blocked',statusReason:'later_stages_pending',sharedFaultCode:null,actions:[],controlVersion:0,pending:0,revoked:0,calls:{prepared:0,sending:0,succeeded:4,failed:0,unknown:0},
 tasks:[{taskId:ids.task,scopeKind:'contact',contactId:ids.contact,state:'succeeded',total:1,succeeded:1,errorCode:null}],inputs:[],candidates:[]});
async function fixture(t,handle){
 const root=await mkdtemp(path.join(tmpdir(),'notalone-fixed-processing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'controller.mjs');await build({entryPoints:['src/main/memory/fixed-processing.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {FixedMemoryProcessingController}=await import(pathToFileURL(output));let generation=1;const calls=[],invalidations=[];
 const backend={getConnectionGeneration:()=>generation,requestJson:async req=>{calls.push(req);return {generation,data:req.path==='/api/memory-processing/schedule'?{pending:0,nextDueAt:null,blockedContacts:0}:await handle(req)};}};
 const controller=new FixedMemoryProcessingController(backend,event=>invalidations.push(event));
 return {controller,calls,invalidations,changeGeneration:()=>{generation++;controller.synchronize();}};
}
test('固定轮次具名入口只发request_key，保留未完成阶段且旧连接写入不出站',async t=>{
 const f=await fixture(t,async()=>snapshot());const view=await f.controller.read();assert.equal(view.connectionGeneration,1);assert.equal(view.run.state,'incomplete');
 const started=await f.controller.start({requestKey:ids.request,connectionGeneration:1});assert.equal(started.run.succeeded,1);
 assert.deepEqual(f.calls.find(call=>call.path==='/api/memory-processing/runs').body,{request_key:ids.request});
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
 let data={...snapshot(),state:'failed',succeeded:0,unknown:1,status:'blocked',statusReason:'model_receipt_unknown',actions:[],pending:0,calls:{prepared:0,sending:0,succeeded:1,failed:0,unknown:1}};
 const f=await fixture(t,async()=>data);assert.equal((await f.controller.read()).run.unknown,1);
 data={...snapshot(),state:'completed'};await assert.rejects(f.controller.read());assert.equal(f.invalidations.length,1);
});

test('控制动作携带控制修订与操作标识，旧版本不覆盖并撤下快照',async t=>{
 const operation='55555555-5555-4555-8555-555555555555';
 const f=await fixture(t,async req=>{
  if(req.path.endsWith('/pause')){assert.deepEqual(req.body,{action_version:0,operation_id:operation});return {...snapshot(),state:'paused',status:'paused',statusReason:null,actions:['continue'],controlVersion:1};}
  return snapshot();
 });
 const paused=await f.controller.control('pause',{runId:ids.run,controlVersion:0,operationId:operation,connectionGeneration:1});
 assert.equal(paused.run.status,'paused');assert.equal(paused.run.controlVersion,1);
 assert.equal(f.calls.at(-1).method,'POST');assert.equal(f.calls.at(-1).path,`/api/memory-processing/runs/${ids.run}/pause`);
 await assert.rejects(f.controller.control('pause',{runId:ids.run,controlVersion:9,operationId:operation,connectionGeneration:1}));
 await assert.rejects(f.controller.control('continue',{runId:ids.run,controlVersion:0,operationId:'not-a-uuid',connectionGeneration:1}));
});

test('共用故障原因码可展示，非法原因码拒绝且不撤下正在显示的原因',async t=>{
 let data={...snapshot(),sharedFaultCode:'document_model_unconfigured'};
 const f=await fixture(t,async()=>data);
 const view=await f.controller.read();assert.equal(view.run.sharedFaultCode,'document_model_unconfigured');
 data={...snapshot(),sharedFaultCode:'No Spaces Allowed'};
 await assert.rejects(f.controller.read());
 assert.equal(f.invalidations.length,1);
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

test('主进程接受权威的主题和画像运行阶段',async t=>{
 let data={...snapshot(),state:'running',stage:'document_scene'};
 const f=await fixture(t,async()=>data);assert.equal((await f.controller.read()).run.stage,'document_scene');
 data={...data,stage:'document_profile'};assert.equal((await f.controller.read()).run.stage,'document_profile');
 data={...data,stage:'invented'};await assert.rejects(f.controller.read());
});

test('主进程保留后续阶段到期时间并拒绝非法时间',async t=>{
 let data={...snapshot(),status:'waiting',statusReason:'later_stages_scheduled',stage:'document_scene',nextDueAt:1_800_000_000_000};
 const f=await fixture(t,async()=>data);
 assert.equal((await f.controller.read()).run.nextDueAt,1_800_000_000_000);
 for(const nextDueAt of [-1,NaN,'tomorrow',Infinity]){data={...data,nextDueAt};await assert.rejects(f.controller.read());}
});

test('最后合法小批收尾不清除用户暂停，已完成阶段仍可如实读取',async t=>{
 const data={...snapshot(),state:'paused',status:'paused',stage:'completed',laterStages:'completed',actions:['continue']};
 const f=await fixture(t,async()=>data),view=await f.controller.read();
 assert.equal(view.run.status,'paused');assert.equal(view.run.state,'paused');assert.equal(view.run.laterStages,'completed');
});
