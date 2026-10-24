/** 实际sendEvents+ServerResponse、实际late分支和afterhook纯顺序回归；无监听/请求/PG。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ServerResponse} from 'node:http';
import vm from 'node:vm';
import {cleanupB5BackgroundFixture} from './reply-background-cleanup.mjs';
const source=await readFile(process.env.NOTALONE_B501_CLEANUP_SOURCE??new URL('./reply-background-public.test.mjs',import.meta.url),'utf8');
let support;try{support=await readFile(new URL('./reply-service-runtime-support.mjs',import.meta.url),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;support=await readFile(new URL('../../../../../../backend-ts/test/reply-service-runtime-support.mjs',import.meta.url),'utf8');}
const sendEventsSource=support.slice(support.indexOf('export function sendEvents('),support.indexOf('export function useTool(')).replace('export ','');
const branch=source.match(/if\(mode==='late'\)\{([\s\S]*?)lateObserved\?\.\(\);return;\}/)?.[1];assert.ok(branch,'必须抽取实际late赋值分支');
const start=source.indexOf(' t.after(async()=>{'),end=source.indexOf('\n });',start)+5;assert.ok(start>=0&&end>start);const hook=source.slice(start,end);
function fixture({late=false,queryNever=false,endNever=false,endError,providerError}={}){
 const calls=[];let after,proof;const response=new ServerResponse({method:'POST'});
 const context={res:response,events:[{type:'message_stop'}],releaseLate:undefined,t:{after:fn=>after=fn},cleanupB5BackgroundFixture,cleanupStageTimeoutMs:10,
 child:{pid:100,exitCode:0,signalCode:null},exited:Promise.resolve([0,null]),legacyPid:200,provider:{listening:false,closeAllConnections:()=>{calls.push('provider');if(providerError)throw providerError;}},control:undefined,
 f:{directory:'synthetic',client:{database:'synthetic_test',query:()=>{calls.push('query');return queryNever?new Promise(()=>{}):Promise.resolve({rows:[{n:0}]});},end:()=>{calls.push('client');if(endError)throw endError;return endNever?new Promise(()=>{}):Promise.resolve();}},close:async()=>calls.push('dispose')},
 process:{kill(){const e=Error('gone');e.code='ESRCH';throw e;}},seen:[],requests:[],checkpoints:[],output:'',request:async()=>({data:{state:'stopped'}}),writeArtifact:async(name,value)=>{calls.push(name==='cleanup.json'?'proof':'evidence');if(name==='cleanup.json')proof=value;}};
 vm.createContext(context);vm.runInContext(sendEventsSource,context);if(late)vm.runInContext(branch,context);vm.runInContext(hook,context);
 return{response,calls,after:()=>after(),proof:()=>proof,release:()=>context.releaseLate?.(),originalRelease:context.releaseLate};
}
test('实际sendEvents：正常body先释放，再after清理不会重复写已结束响应',async()=>{
 const f=fixture({late:true});f.release();assert.equal(f.response.writableEnded,true);assert.equal(f.response.headersSent,true);
 await f.after();assert.equal(f.proof().state,'cleaned');assert.ok(f.calls.includes('client')&&f.calls.includes('dispose'));assert.doesNotThrow(()=>f.release());assert.doesNotThrow(()=>f.originalRelease());
});
test('实际sendEvents：失败路径尚未完成的SSE由after释放且重复调用无操作',async()=>{
 const f=fixture({late:true});assert.equal(f.response.writableEnded,false);await f.after();assert.equal(f.response.writableEnded,true);assert.equal(f.proof().state,'cleaned');assert.doesNotThrow(()=>f.originalRelease());assert.doesNotThrow(()=>f.release());
});
test('实际sendEvents：响应已结束时释放闭包无操作',async()=>{
 const f=fixture({late:true});f.response.end();assert.doesNotThrow(()=>f.release());await f.after();assert.equal(f.proof().state,'cleaned');
});
test('实际afterhook：只读query永不返回仍独立尝试client.end，保留超时和现场',async()=>{
 const f=fixture({queryNever:true});await assert.rejects(f.after(),e=>e.errors?.some(x=>x.code==='CLEANUP_TIMEOUT'));assert.ok(f.calls.includes('client'),'不能因query悬挂漏掉end');assert.ok(!f.calls.includes('dispose'));assert.equal(f.proof().fixtureRetained,true);
});
test('实际afterhook：query超时与end异常均保留',async()=>{
 const original=Error('synthetic-end-error'),f=fixture({queryNever:true,endError:original});await assert.rejects(f.after(),e=>e.errors?.some(x=>x.code==='CLEANUP_TIMEOUT')&&e.errors?.includes(original));assert.ok(f.calls.includes('client'));assert.ok(!f.calls.includes('dispose'));
});
test('实际afterhook：独立end永不返回也有界失败并保留现场',async()=>{
 const f=fixture({endNever:true});await assert.rejects(f.after(),e=>e.errors?.some(x=>x.code==='CLEANUP_TIMEOUT'));assert.ok(f.calls.includes('client'));assert.equal(f.proof().fixtureRetained,true);assert.ok(!f.calls.includes('dispose'));
});

test('实际afterhook：query悬挂仍保留独立provider与end原异常',async()=>{
 const a=Error('synthetic-provider-error'),b=Error('synthetic-client-error'),f=fixture({queryNever:true,providerError:a,endError:b});
 await assert.rejects(f.after(),e=>e.errors?.some(x=>x.code==='CLEANUP_TIMEOUT')&&e.errors.includes(a)&&e.errors.includes(b));assert.ok(f.calls.includes('client'));assert.ok(!f.calls.includes('dispose'));
});
