import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const output=await build({stdin:{contents:`export {HistoryClearController} from './src/main/history-clear/controller';export {installHistoryClearBridge} from './src/main/history-clear/bridge';export {createHistoryClearBridge} from './src/preload/history-clear';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const ports=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const contact='00000000-0000-4000-8000-000000000001',scopeRevision=7;
const clear={contact_id:contact,phase:'none',completed:false,boundary:null,boundary_pending:false,failure_code:null,boundary_reason:null,stored_messages:2,stored_sources:2,open_goals:0};
const resync={contact_id:contact,request_key:null,state:'none',completed:false,goal:null};
function fixture(){
 const calls=[],listeners=new Set(),lifecycleEvents=[];let generation=1,resyncState=resync;
 const backend={getConnectionGeneration:()=>generation,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},requestJson:async r=>{
  calls.push(r);
  if(r.path.endsWith('/clear'))return {generation,data:r.method==='POST'?{...clear,phase:'completed',completed:true}:clear};
  if(r.path.endsWith('/resync')){
   if(r.method==='POST')resyncState={...resync,state:'completed',completed:true,request_key:r.body.request_key};
   return {generation,data:resyncState};
  }
  throw new Error('退役接口不可调用');
 }};
 const contacts={getState:()=>({selectedContactId:contact,scopeRevision,directoryPhase:'ready',contacts:[{contactId:contact}]}),onStateChanged:()=>()=>{}};
 const lifecycle = {
  beginHistoryClear() {
   lifecycleEvents.push('begin');
   return async () => { lifecycleEvents.push('settle'); };
  },
  historyResyncCompleted(contactId) { lifecycleEvents.push(contactId); },
 };
 return {backend,contacts,calls,lifecycle,lifecycleEvents,disconnect(){generation=undefined;for(const fn of listeners)fn();}};
}

test('认证接口退役后清空与明确重读仍只依赖各自的公开状态接口',async t=>{
 const f=fixture(),controller=new ports.HistoryClearController(f.backend,f.contacts,f.lifecycle);t.after(()=>controller.dispose());
 await new Promise(setImmediate);
 assert.equal(controller.getState().phase,'ready');
 await controller.clear({contactId:contact,scopeRevision});
 await controller.resync({contactId:contact,scopeRevision,requestKey:'synthetic-resync',confirmed:true});
 assert.ok(f.calls.some(r=>r.method==='POST'&&r.path.endsWith('/clear')));
 assert.ok(f.calls.some(r=>r.method==='POST'&&r.path.endsWith('/resync')));
 assert.ok(f.calls.every(r=>/\/history\/(clear|resync)$/.test(r.path)));
 assert.deepEqual(f.lifecycleEvents, ['begin', 'settle', contact]);
 f.disconnect();assert.equal(controller.getState().contactId,null);
 await assert.rejects(controller.clear({contactId:contact,scopeRevision}));
});

test('历史IPC与preload仅保留清空和明确重读，退役认证入口不再暴露',async t=>{
 const f=fixture(),handlers=new Map(),commands={handle:(name,handler)=>handlers.set(name,handler),publish:()=>{}};
 const controller=ports.installHistoryClearBridge(commands,f.backend,f.contacts,f.lifecycle);t.after(()=>controller.dispose());
 assert.deepEqual([...handlers.keys()].sort(),['history-clear:clear','history-clear:get-state','history-clear:refresh','history-clear:resync']);
 const calls=[],transport={invoke:async(...args)=>calls.push(args),on:()=>{},removeListener:()=>{}};
 const bridge=ports.createHistoryClearBridge(transport);
 assert.deepEqual(Object.keys(bridge).sort(),['clear','getState','onStateChanged','refresh','resync']);
 await bridge.resync({contactId:contact,scopeRevision,requestKey:'synthetic-bridge',confirmed:true});
 assert.deepEqual(calls,[['history-clear:resync',{contactId:contact,scopeRevision,requestKey:'synthetic-bridge',confirmed:true}]]);
 await assert.rejects(async()=>handlers.get('history-clear:resync')({contactId:contact,scopeRevision,requestKey:'synthetic-bridge',confirmed:false}));
 await assert.rejects(bridge.clear({contactId:contact,scopeRevision},'extra'));
});

test('清空已发出后连接变化，迟到成功不能恢复旧范围状态',async t=>{
 const f=fixture(),original=f.backend.requestJson,gate=Promise.withResolvers();
 f.backend.requestJson=async request=>{const response=await original(request);if(request.method==='POST')await gate.promise;return response;};
 const controller=new ports.HistoryClearController(f.backend,f.contacts,f.lifecycle);t.after(()=>controller.dispose());await new Promise(setImmediate);
 const clearing=controller.clear({contactId:contact,scopeRevision});await new Promise(setImmediate);f.disconnect();gate.resolve();await clearing;
 assert.deepEqual(f.lifecycleEvents, ['begin', 'settle']);
 const state=controller.getState();assert.equal(state.contactId,null);assert.equal(state.phase,'idle');assert.equal(state.clear,null);assert.equal(state.resync,null);assert.equal(state.busy,null);assert.equal(state.error,null);
});

test('跨联系人回执不进入清空状态或触发重读完成', async t => {
 const f=fixture(),original=f.backend.requestJson;
 const controller=new ports.HistoryClearController(f.backend,f.contacts,f.lifecycle);t.after(()=>controller.dispose());
 await controller.refresh({contactId:contact,scopeRevision});
 f.backend.requestJson=async request=>{
  const response=await original(request);
  return { ...response, data: { ...response.data, contact_id: '00000000-0000-4000-8000-000000000002' } };
 };
 await controller.clear({contactId:contact,scopeRevision});
 assert.equal(controller.getState().clear.completed,false);
 assert.match(controller.getState().error,/尚未确认/);
 await controller.resync({contactId:contact,scopeRevision,requestKey:'synthetic-other',confirmed:true});
 assert.equal(controller.getState().resync.completed,false);
 assert.deepEqual(f.lifecycleEvents,['begin','settle']);
});
