import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const built = await build({ stdin: { contents: `export { WechatSetupController } from './src/main/setup/wechat-controller'; export { installWechatSetupBridge } from './src/main/setup/wechat-bridge'; export { createWechatSetupBridge } from './src/preload/wechat-setup';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { WechatSetupController, installWechatSetupBridge, createWechatSetupBridge } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const status = (state='ready') => ({state,account_id:'synthetic-account',candidate_token:state==='ready'?'synthetic-token':null,failure_code:null});
const flush = async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(){
 let generation=1; const listeners=new Set(),requests=[];
 const control={status:{...status('needs_detection'),account_id:null},postBarrier:null,readBarrier:null,postLost:false,restartOk:true,restarts:0,restartBarrier:null};
 const connect=value=>{generation=value;for(const listener of listeners)listener();};
 const backend={getConnectionGeneration:()=>generation,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  async requestJson(request){requests.push(request);const captured=generation;
   if(request.path==='/api/setup/wechat/detect'){control.status=status();}
   else if(request.method==='POST'){if(control.postBarrier)await control.postBarrier;control.status=control.confirmResult??status('restart_required');if(control.postLost)throw new Error('lost');}
   else if(control.readBarrier)await control.readBarrier;
   return {generation:captured,data:control.status};},
  async restart(){control.restarts++;if(control.restartBarrier)await control.restartBarrier;if(!control.restartOk)return false;connect(undefined);control.status={...status('connected'),account_id:control.connectedAccount??'synthetic-account'};connect((generation??1)+1);return true;}};
 const controller=new WechatSetupController(backend);
 return {controller,control,requests,connect,backend};
}
test('首次连接只读展示账号，明确一次确认后保存并重启，成功复核连接',async()=>{
 const f=fixture();await f.controller.refresh();
 assert.equal(f.controller.getState().phase,'needs_detection');assert.ok(f.requests.every(r=>r.method==='GET'));
 await f.controller.detect();
 assert.equal(f.controller.getState().phase,'ready');
 assert.ok(!JSON.stringify(f.controller.getState()).includes('synthetic-token'));
 assert.equal(f.requests.filter(r=>r.path.endsWith('/detect')).length,1);
 await f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});
 assert.deepEqual(f.requests.find(r=>r.path.endsWith('/confirm')).body,{candidate_token:'synthetic-token',confirmed:true});
 assert.equal(f.control.restarts,1);assert.equal(f.controller.getState().phase,'connected');
});

test('授权响应丢失通过只读状态恢复，失败重启只重试加载，不重复授权',async()=>{
 const f=fixture();f.control.postLost=true;f.control.restartOk=false;await f.controller.detect();
 await f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});
 assert.equal(f.controller.getState().phase,'restart-failed');assert.equal(f.control.restarts,1);
 f.control.restartOk=true;await f.controller.retryRestart();
 assert.equal(f.controller.getState().phase,'connected');assert.equal(f.control.restarts,2);
 assert.equal(f.requests.filter(r=>r.path.endsWith('/confirm')).length,1);
});
test('应用重新打开可识别已保存授权并只重新加载，已有连接读取不改范围或开关',async()=>{
 const f=fixture();f.control.status=status('restart_required');await f.controller.refresh();await f.controller.retryRestart();
 assert.equal(f.controller.getState().phase,'connected');assert.ok(f.requests.every(r=>r.method==='GET'));
 await f.controller.refresh();await f.controller.retryRestart();assert.equal(f.control.restarts,1);
});
test('旧页面确认被拒绝；双击或刷新不能重复写入，旧连接迟到写入不触发重启',async()=>{
 const f=fixture();await f.controller.detect();const old=f.controller.getState().revision;await f.controller.refresh();
 await assert.rejects(f.controller.confirm({revision:old,confirmed:true}));
 let release;f.control.postBarrier=new Promise(resolve=>release=resolve);
 const request={revision:f.controller.getState().revision,confirmed:true};const writing=f.controller.confirm(request);
 await flush();await assert.rejects(f.controller.confirm(request));await f.controller.refresh();
 f.connect(undefined);release();await writing;
 assert.equal(f.controller.getState().phase,'offline');assert.equal(f.control.restarts,0);assert.equal(f.requests.filter(r=>r.path.endsWith('/confirm')).length,1);
});
test('迟到旧读取和错误不能覆盖新连接，工具未准备好不会提供授权',async()=>{
 const f=fixture();let release;f.control.readBarrier=new Promise(resolve=>release=resolve);
 const reading=f.controller.refresh();f.connect(undefined);release();await reading;
 assert.equal(f.controller.getState().phase,'offline');f.control.readBarrier=null;
 f.control.status={state:'tool_not_ready',account_id:null,candidate_token:null,failure_code:'cli_not_initialized'};
 f.connect(3);await flush();assert.equal(f.controller.getState().phase,'tool_not_ready');
 await f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});assert.ok(f.requests.every(r=>r.method==='GET'));
});
test('重启后的不同微信账号不能被当成原授权连接成功',async()=>{
 const f=fixture();await f.controller.detect();let release;
 f.control.restartBarrier=new Promise(resolve=>release=resolve);
 const writing=f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});await flush();
 // 后端服务重建后返回错误账号，必须保留未完成状态。
 f.control.restartBarrier=null;
 f.control.connectedAccount='another-account';
 release();await writing;
 assert.notEqual(f.controller.getState().phase,'connected');
});
test('桥接仅供管理窗口操作，拒绝额外字段和未确认请求，检测不接受账号输入',async()=>{
 const handlers=new Map(),roles=new Map(),calls=[];
 const commands={handle:(name,fn,role)=>{handlers.set(name,fn);roles.set(name,role);},publish(){}};
 const controller={getState:()=>({}),onStateChanged:()=>()=>{},refresh:async()=>{},detect:async()=>calls.push('detect'),confirm:async v=>calls.push(v),retryRestart:async()=>{}};
 installWechatSetupBridge(commands,controller);
 assert.ok([...roles.values()].every(role=>role==='manager'));
 for(const args of [[],[{}],[{revision:1,confirmed:false}],[{revision:1,confirmed:true,account_id:'injected'}],[{revision:NaN,confirmed:true}],[{revision:1,confirmed:true},{}]])assert.throws(()=>handlers.get('wechat-setup:confirm')(...args));
 assert.throws(()=>handlers.get('wechat-setup:detect')('injected'));
 await handlers.get('wechat-setup:detect')();await handlers.get('wechat-setup:confirm')({revision:1,confirmed:true});
 assert.deepEqual(calls,['detect',{revision:1,confirmed:true}]);
 const invokes=[];const preload=createWechatSetupBridge({invoke:async(...args)=>invokes.push(args)});
 await preload.detect();await preload.confirm({revision:1,confirmed:true});
 await assert.rejects(preload.detect('injected'));await assert.rejects(preload.confirm());
 assert.deepEqual(invokes,[['wechat-setup:detect'],['wechat-setup:confirm',{revision:1,confirmed:true}]]);
});
test('迟到重启失败不能覆盖新连接，当前连接状态只读复核后保留',async()=>{
 const f=fixture();await f.controller.detect();let reject;
 f.backend.restart=()=>new Promise((_resolve,fail)=>reject=fail);
 const writing=f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});await flush();
 f.control.status=status('connected');f.connect(4);reject(new Error('old restart failed'));await writing;
 assert.equal(f.controller.getState().phase,'connected');assert.equal(f.requests.filter(r=>r.path.endsWith('/confirm')).length,1);
});
test('重启后的旧核验响应不能覆盖再次变化的连接',async()=>{
 const f=fixture();await f.controller.detect();let release;
 f.control.readBarrier=new Promise(resolve=>release=resolve);
 const writing=f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});await flush();
 f.connect(undefined);release();await writing;
 assert.equal(f.controller.getState().phase,'offline');
});
test('确认时工具读取失败保留后端失败原因，不读回或误报账号变化',async()=>{
 const f=fixture();await f.controller.detect();
 f.control.confirmResult={state:'tool_not_ready',account_id:null,candidate_token:null,failure_code:'cli_unreadable'};
 const count=f.requests.length;
 await f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});
 assert.equal(f.controller.getState().phase,'tool_not_ready');assert.equal(f.controller.getState().failureCode,'cli_unreadable');
 assert.equal(f.requests.length,count+1);assert.equal(f.control.restarts,0);
});
test('确认时真实账号变化保留后端冲突原因，不重复探测或读回',async()=>{
 const f=fixture();await f.controller.detect();
 f.control.confirmResult={state:'conflict',account_id:null,candidate_token:null,failure_code:'wechat_account_changed'};
 const count=f.requests.length;
 await f.controller.confirm({revision:f.controller.getState().revision,confirmed:true});
 assert.equal(f.controller.getState().phase,'conflict');assert.equal(f.controller.getState().failureCode,'wechat_account_changed');
 assert.equal(f.requests.length,count+1);assert.equal(f.control.restarts,0);
});
