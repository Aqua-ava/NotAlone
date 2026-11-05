import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const compiled=await build({stdin:{contents:`export {installHistoryRecertifyBatchBridge} from './src/main/history-clear/recertify-batch-bridge';
export {createHistoryRecertifyBatchBridge} from './src/preload/history-recertify-batch';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const ports=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function controllerStub(){
 const listeners=new Set(),actions=[];
 return {actions,listeners,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  getState:()=>({revision:1,phase:'idle'}),refreshOverview:async()=>{actions.push('refresh');},
  start:async request=>{actions.push(['start',request]);},stop:async()=>{actions.push('stop');}};
}
function commandsStub(){
 const handlers=new Map(),roles=new Map(),published=[];
 return {handlers,roles,published,handle:(name,handler,role)=>{handlers.set(name,handler);roles.set(name,role);},
  publish:(name,state,role)=>published.push([name,state,role])};
}
const batchState={revision:2,phase:'idle',batchId:null};

test('批量 ICP 桥只在开发宿主注册，打包宿主不注册任何通道', ()=>{
 const packaged=commandsStub();
 ports.installHistoryRecertifyBatchBridge(packaged,controllerStub(),false);
 assert.equal(packaged.handlers.size,0);assert.equal(packaged.published.length,0);
 const developed=commandsStub(),controller=controllerStub();
 ports.installHistoryRecertifyBatchBridge(developed,controller,true);
 assert.deepEqual([...developed.handlers.keys()].sort(),['history-recertify-batch:get-state','history-recertify-batch:refresh-overview',
  'history-recertify-batch:start','history-recertify-batch:stop']);
 for(const role of developed.roles.values())assert.equal(role,'manager');
 controller.listeners.forEach(listener=>listener(batchState));
 assert.deepEqual(developed.published,[['history-recertify-batch:state-changed',batchState,undefined]]);
});

test('批量 IPC 只接受固定参数形状：明确确认、受限 limit、无多余字段', async ()=>{
 const commands=commandsStub(),controller=controllerStub();
 ports.installHistoryRecertifyBatchBridge(commands,controller,true);
 const invoke=(name,...args)=>commands.handlers.get(name)(...args);
 assert.deepEqual(await invoke('history-recertify-batch:get-state'),{revision:1,phase:'idle'});
 await invoke('history-recertify-batch:refresh-overview');
 controller.actions.length=0;
 await invoke('history-recertify-batch:start',{limit:5,confirmed:true});
 assert.deepEqual(controller.actions,[['start',{limit:5,confirmed:true}]]);
 await invoke('history-recertify-batch:start',{limit:null,confirmed:true});
 assert.deepEqual(controller.actions.at(-1),['start',{limit:null,confirmed:true}]);
 await invoke('history-recertify-batch:stop');
 for(const invalid of [[],[{limit:null,confirmed:false}],[{limit:null,confirmed:true,extra:1}],[{limit:0,confirmed:true}],
  [{limit:501,confirmed:true}],[{limit:1.5,confirmed:true}],[{limit:'5',confirmed:true}],[{confirmed:true}],[null],['x']]){
  await assert.rejects(async()=>invoke('history-recertify-batch:start',...invalid));
 }
 for(const name of ['history-recertify-batch:get-state','history-recertify-batch:refresh-overview','history-recertify-batch:stop']){
  await assert.rejects(async()=>invoke(name,'extra'));
 }
});

test('preload 批量桥只暴露具名操作并拒绝多余参数', async ()=>{
 const calls=[],listeners=new Map();
 const transport={invoke:async(...args)=>{calls.push(args);return batchState;},
  on:(channel,listener)=>{listeners.set(channel,listener);return()=>{};},removeListener:(channel,listener)=>{if(listeners.get(channel)===listener)listeners.delete(channel);}};
 const bridge=ports.createHistoryRecertifyBatchBridge(transport);
 assert.deepEqual(Object.keys(bridge).sort(),['getState','onStateChanged','refreshOverview','start','stop']);
 assert.deepEqual(await bridge.getState(),batchState);
 await bridge.refreshOverview();
 await bridge.start({limit:5,confirmed:true});
 await bridge.stop();
 assert.deepEqual(calls,[['history-recertify-batch:get-state'],['history-recertify-batch:refresh-overview'],
  ['history-recertify-batch:start',{limit:5,confirmed:true}],['history-recertify-batch:stop']]);
 await assert.rejects(bridge.getState('x'));await assert.rejects(bridge.stop('x'));
 await assert.rejects(bridge.start({limit:5,confirmed:true},'x'));
 let received;const off=bridge.onStateChanged(state=>{received=state;});
 listeners.get('history-recertify-batch:state-changed')({},batchState);
 assert.deepEqual(received,batchState);
 off();assert.equal(listeners.size,0);
 assert.throws(()=>bridge.onStateChanged('x'));
});

async function loadPreload(hostMode){
 const directory=await mkdtemp(join(tmpdir(),'notalone-batch-preload-'));
 const calls=[],listeners=new Map();
 const transport={
  sendSync:channel=>{calls.push(['sendSync',channel]);return hostMode;},
  invoke:async(...args)=>{calls.push(['invoke',...args]);return batchState;},
  on:(channel,listener)=>{listeners.set(channel,listener);return()=>{};},
  removeListener:channel=>listeners.delete(channel),
 };
 const token=`__batchPreload${Math.random().toString(16).slice(2)}`;
 let bridge;
 globalThis[token]={ipcRenderer:transport,contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'notalone');bridge=value;}}};
 try{
  const outfile=join(directory,'preload.mjs');
  await build({entryPoints:['src/preload/index.ts'],outfile,bundle:true,platform:'node',format:'esm',logLevel:'silent',
   plugins:[{name:'synthetic-electron-transport',setup(plugin){
    plugin.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));
    plugin.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const {ipcRenderer,contextBridge}=globalThis[${JSON.stringify(token)}];`}));
   }}]});
  await import(`${pathToFileURL(outfile).href}?mode=${hostMode}`);
  return {bridge,calls,listeners};
 }finally{
  delete globalThis[token];await rm(directory,{recursive:true,force:true});
 }
}

test('preload 只在开发宿主暴露批量入口，打包宿主完全没有该属性', async ()=>{
 const packaged=await loadPreload('packaged');
 assert.equal('historyRecertifyBatch' in packaged.bridge,false);
 assert.ok(packaged.bridge.historyClear);
 assert.deepEqual(packaged.calls.filter(([kind])=>kind==='sendSync'),[['sendSync','notalone:host-mode']]);
 const developed=await loadPreload('development');
 assert.ok(developed.bridge.historyRecertifyBatch);
 assert.deepEqual(Object.keys(developed.bridge.historyRecertifyBatch).sort(),['getState','onStateChanged','refreshOverview','start','stop']);
 assert.deepEqual(await developed.bridge.historyRecertifyBatch.getState(),batchState);
 assert.deepEqual(developed.calls.filter(([kind])=>kind==='invoke'),[['invoke','history-recertify-batch:get-state']]);
});
