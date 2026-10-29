import test,{after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
let loaded,owned;
after(async()=>{if(owned)await rm(owned,{recursive:true,force:true});});
function modules(){return loaded??=(async()=>{owned=await mkdtemp(join(tmpdir(),'notalone-discussion-bridge-test-'));const outfile=join(owned,'bridge.mjs');await build({stdin:{contents:"export * from './src/main/reply/sqlite-discussion-bridge';export * from './src/preload/sqlite-discussion';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'});return import(pathToFileURL(outfile).href);})();}
const contactA='11111111-1111-4111-8111-111111111111',contactB='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333';
function fixture(api){
 let generation=3,selected=contactA,scopeRevision=1,directoryPhase='ready';
 const backendListeners=new Set(),contactListeners=new Set(),requests=[],handlers=new Map(),published=[];let respond=async request=>({generation,data:{session_id:session,segmented:false,replayed:false,request_key:request.body.request_key}});
 const backend={getConnectionGeneration:()=>generation,onStateChanged:fn=>{backendListeners.add(fn);return()=>backendListeners.delete(fn);},requestJson:options=>{requests.push(options);return respond(options);}};
 const contacts={getState:()=>({revision:scopeRevision,scopeRevision,selectedContactId:selected,directoryPhase,contacts:[{contactId:contactA},{contactId:contactB}],draft:''}),onStateChanged:fn=>{contactListeners.add(fn);return()=>contactListeners.delete(fn);}};
 const controller=api.installSqliteDiscussionBridge({handle:(channel,fn,role)=>{assert.equal(role,'helper');handlers.set(channel,fn);},publish:(channel,state,role)=>{assert.equal(role,'helper');published.push({channel,state});}},backend,contacts);
 return {controller,handlers,published,requests,respond:fn=>respond=fn,request:()=>({contactId:contactA,scopeRevision:1,sessionId:session,requestKey:randomUUID(),text:'合成讨论要求'}),select(id){selected=id;++scopeRevision;for(const fn of contactListeners)fn();},generation(value,notify=true){generation=value;if(notify)for(const fn of backendListeners)fn();},phase(value){directoryPhase=value;for(const fn of contactListeners)fn();}};
}
test('联系人切换立即取消讨论请求并撤销旧范围，迟到成功回包不可发布',async()=>{
 const api=await modules(),f=fixture(api);const gate=Promise.withResolvers();f.respond(()=>gate.promise);
 const request=f.request(),pending=f.controller.submit(request);const rejected=assert.rejects(pending,/失效|变化/);
 f.select(contactB);assert.equal(f.requests[0].signal.aborted,true);assert.ok(f.published.some(e=>e.channel==='sqlite-discussion:invalidated'));
 gate.resolve({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:request.requestKey}});await rejected;
});
test('HTTP失败显式重试沿用原key，成功回执不带正文且不允许同key换内容',async()=>{
 const api=await modules(),f=fixture(api),request=f.request();let fail=true;
 f.respond(async options=>{if(fail)throw new Error('合成私密响应不应传出');return {generation:3,data:{session_id:session,segmented:false,replayed:true,request_key:options.body.request_key}};});
 await assert.rejects(f.controller.submit(request),error=>/未确认/.test(error.message)&&!error.message.includes('私密'));
 fail=false;const result=await f.controller.submit(request);assert.deepEqual(result,{sessionId:session,segmented:false,replayed:true,requestKey:request.requestKey});
 assert.equal(f.requests.length,2);assert.deepEqual(f.requests.map(r=>r.body.request_key),[request.requestKey,request.requestKey]);
 assert.deepEqual(f.requests[1].body,{request_key:request.requestKey,text:request.text,confirmed_contact:true});assert.equal(f.requests[1].path,`/api/contacts/${contactA}/assistant-sessions/${session}/entries`);
 await assert.rejects(f.controller.submit({...request,text:'改变后的要求'}),/变化/);assert.equal(f.requests.length,2);
});
test('相同在途请求合并，目录不就绪或连接换代均拒绝迟到响应',async()=>{
 const api=await modules(),f=fixture(api),request=f.request(),gate=Promise.withResolvers();f.respond(()=>gate.promise);
 const pending=f.controller.submit(request),same=f.controller.submit(request);assert.equal(pending,same);assert.equal(f.requests.length,1);
 const rejected=assert.rejects(pending,/失效|变化/);f.generation(4,false);gate.resolve({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:request.requestKey}});await rejected;
 f.phase('loading');await assert.rejects(f.controller.submit(f.request()),/失效/);assert.equal(f.requests.length,1);
});
test('来源失效在同范围取消等待，旧key不复活，新的明确请求可受理',async()=>{
 const api=await modules(),f=fixture(api),request=f.request(),gate=Promise.withResolvers();f.respond(()=>gate.promise);
 const pending=f.controller.submit(request),rejected=assert.rejects(pending,/失效/);f.controller.synchronize(true);assert.equal(f.requests[0].signal.aborted,true);
 gate.resolve({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:request.requestKey}});await rejected;
 await assert.rejects(f.controller.submit(request),/失效/);
 f.respond(async options=>({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:options.body.request_key}}));
 assert.equal((await f.controller.submit(f.request())).sessionId,session);
});
test('主进程和preload均拒绝额外参数与通用HTTP字段，失效订阅可注销',async()=>{
 const api=await modules(),f=fixture(api),calls=[],listeners=new Map();
 const transport={invoke:async(...args)=>{calls.push(args);return f.handlers.get(args[0])(...args.slice(1));},on:(name,fn)=>listeners.set(name,fn),removeListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
 const bridge=api.createSqliteDiscussionBridge(transport),request=f.request();
 await assert.rejects(bridge.submit(request,'extra'),/无效/);await assert.rejects(bridge.submit({...request,ownerId:randomUUID()}),/无效/);assert.equal(calls.length,0);
 assert.throws(()=>f.handlers.get('sqlite-discussion:submit')(request,'extra'),/无效/);
 assert.throws(()=>f.handlers.get('sqlite-discussion:submit')({...request,path:'/other'}),/无效/);assert.equal(f.requests.length,0);
 let received;const off=bridge.onInvalidated(event=>received=event),event={revision:1,contactId:contactA,scopeRevision:1};listeners.get('sqlite-discussion:invalidated')(undefined,event);assert.deepEqual(received,event);off();assert.equal(listeners.size,0);
 await bridge.submit(request);assert.equal(calls.length,1);assert.equal(calls[0][0],'sqlite-discussion:submit');
});
test('非法或多余正文回执拒绝且保留原请求重试，分段与重放可返回新session',async()=>{
 const api=await modules(),f=fixture(api),request=f.request(),newSession=randomUUID();
 f.respond(async()=>({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:request.requestKey,text:'不能进入桌面的额外正文'}}));
 await assert.rejects(f.controller.submit(request),/未确认/);
 f.respond(async()=>({generation:3,data:{session_id:newSession,segmented:false,replayed:true,request_key:request.requestKey}}));
 assert.equal((await f.controller.submit(request)).sessionId,newSession);assert.equal(f.requests.length,2);
});
test('旧范围取消后新联系人可立即提交，不等待忽略AbortSignal的旧回包',async()=>{
 const api=await modules(),f=fixture(api),old=f.request(),gate=Promise.withResolvers();f.respond(()=>gate.promise);
 const pending=f.controller.submit(old),rejected=assert.rejects(pending,/失效/);f.select(contactB);
 f.respond(async options=>({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:options.body.request_key}}));
 const next={...f.request(),contactId:contactB,scopeRevision:2};assert.equal((await f.controller.submit(next)).requestKey,next.requestKey);
 gate.resolve({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:old.requestKey}});await rejected;
});
test('正文上限与后端十万UTF-16字符合同一致',async()=>{
 const api=await modules(),f=fixture(api),request=f.request();
 await f.controller.submit({...request,text:'中'.repeat(100_000)});assert.equal(f.requests[0].body.text.length,100_000);
 await assert.rejects(f.controller.submit({...f.request(),text:'中'.repeat(100_001)}),/无效/);assert.equal(f.requests.length,1);
});
test('有界保留已确认回执而不遗忘未知请求正文约束，失效后撤销旧key',async()=>{
 const api=await modules(),f=fixture(api),unknown=f.request();f.respond(async()=>{throw new Error('合成未确认');});
 await assert.rejects(f.controller.submit(unknown));
 f.respond(async options=>({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:options.body.request_key}}));
 for(let i=0;i<260;i++)await f.controller.submit(f.request());
 const before=f.requests.length;await assert.rejects(f.controller.submit({...unknown,text:'不能替换未知请求的正文'}),/变化/);assert.equal(f.requests.length,before);
 f.controller.invalidate();await assert.rejects(f.controller.submit(unknown),/失效/);await f.controller.submit(f.request());
});
test('过多未知结果不会无界积累或遗忘幂等身份，重新确认范围后可继续',async()=>{
 const api=await modules(),f=fixture(api);f.respond(async()=>{throw new Error('合成未确认');});
 for(let i=0;i<256;i++)await assert.rejects(f.controller.submit(f.request()),/未确认/);
 await assert.rejects(f.controller.submit(f.request()),/核对已保存讨论/);assert.equal(f.requests.length,256);
 f.controller.invalidate();f.respond(async options=>({generation:3,data:{session_id:session,segmented:false,replayed:false,request_key:options.body.request_key}}));
 await f.controller.submit(f.request());assert.equal(f.requests.length,257);
});
