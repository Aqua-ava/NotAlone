import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// 生产控制器 seam；只有宿主传输与受控重启使用合成实现，不启动 App 或模型。
const built = await build({ stdin: { contents: "export { SetupController } from './src/main/setup/controller'; export { BackendRequestFailure } from './src/main/backend/json-client';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { SetupController, BackendRequestFailure } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
function fixture(mode = 'managed') {
  let pending = false, generation = 1, restarts = 0, writes = 0, failRestart = false, rejectRestart = false, rejectSave = false, environmentOverride = false;
  const listeners = [], calls = [];
  const backend = {
    onStateChanged(listener) { listeners.push(listener); },
    getConnectionGeneration() { return generation; },
    async requestJson(request) {
      calls.push({ method: request.method, path: request.path });
      if (request.method === 'POST' && rejectSave) throw new BackendRequestFailure('response', 400, 'configuration_environment_override');
      if (request.method === 'POST') { pending = true; ++writes; return { data: { provider: 'deepseek', configured: true, restart_required: true } }; }
      return { data: { initialized: true, owner_configured: true, runtime_owner_configured: true, credentials_configured: true, runtime_configuration_pending: pending, runtime_configuration_environment_override: environmentOverride } };
    },
    async restart() {
      ++restarts;
      if (rejectRestart) throw new Error('synthetic-secret-error-canary');
      if (failRestart) return false;
      ++generation;
      if (mode === 'managed') pending = false;
      for (const listener of listeners) listener();
      return true;
    },
  };
  return { controller: new SetupController(backend), calls, get writes() { return writes; }, get restarts() { return restarts; },
    setSaveReject(value) { rejectSave = value; }, setEnvironmentOverride() { environmentOverride = true; pending = true; },
    setFail(value) { failRestart = value; }, setReject(value) { rejectRestart = value; }, replaceExternalProcess() { pending = false; } };
}

test('受控宿主保存凭据后重启并确认新快照，公开状态从不包含密钥', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.saveDeepSeekConfiguration({ baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-secret-canary' });
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().configurationPending, false);
  assert.equal(f.restarts, 1);
  assert.equal(f.writes, 1);
  assert.doesNotMatch(JSON.stringify(f.controller.getState()), /synthetic-secret-canary/);
});

test('external 重连同一快照不能声称已生效，替换进程后安全重试不重发保存', async () => {
  const f = fixture('external');
  await f.controller.refresh();
  await f.controller.saveDeepSeekConfiguration({ baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-official-canary' });
  assert.equal(f.controller.getState().phase, 'restart-failed');
  assert.equal(f.controller.getState().configurationPending, true);
  await f.controller.refresh();
  assert.equal(f.controller.getState().phase, 'restart-failed');
  f.replaceExternalProcess();
  await f.controller.retryRestart();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().configurationPending, false);
  assert.equal(f.writes, 1);
  assert.equal(f.restarts, 2);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('重载失败保留已保存待加载事实，重试只加载配置', async () => {
  const f = fixture();
  await f.controller.refresh();
  f.setFail(true);
  await f.controller.saveDeepSeekConfiguration({ baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-retry-canary' });
  assert.equal(f.controller.getState().phase, 'restart-failed');
  assert.equal(f.controller.getState().configurationPending, true);
  f.setFail(false);
  await f.controller.retryRestart();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().configurationPending, false);
  assert.equal(f.writes, 1);
});

 test('重载抛错不能误称保存失败或公开原始异常，重试不再传递密钥', async () => {
  const f = fixture();
  await f.controller.refresh();
  f.setReject(true);
  await f.controller.saveDeepSeekConfiguration({ baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-private-key' });
  assert.equal(f.controller.getState().phase, 'restart-failed');
  assert.equal(f.controller.getState().errorCode, 'reload-failed');
  assert.equal(f.controller.getState().configurationPending, true);
  assert.doesNotMatch(JSON.stringify(f.controller.getState()), /synthetic-secret-error-canary|synthetic-private-key/);
  f.setReject(false);
  await f.controller.retryRestart();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.writes, 1);
});


test('启动环境拒绝保存时显示固定原因，不重启、不公开密钥或响应原文', async () => {
  const f = fixture();
  await f.controller.refresh();
  f.setSaveReject(true);
  await f.controller.saveDeepSeekConfiguration({ baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-environment-private-key' });
  const state = f.controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.errorCode, 'configuration-environment-override');
  assert.equal(state.configurationPending, false);
  assert.equal(f.restarts, 0);
  assert.equal(f.writes, 0);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-environment-private-key/);
});

test('重开检测到历史文件被环境覆盖时仍待加载，重复重启不能抹去固定原因', async () => {
  const f = fixture('external');
  f.setEnvironmentOverride();
  await f.controller.refresh();
  assert.equal(f.controller.getState().phase, 'restart-failed');
  assert.equal(f.controller.getState().errorCode, 'configuration-environment-override');
  await f.controller.retryRestart();
  assert.equal(f.controller.getState().phase, 'restart-failed');
  assert.equal(f.controller.getState().errorCode, 'configuration-environment-override');
  assert.equal(f.writes, 0);
});


test('保存AI服务地址与新密钥走专用接口并确认受控重启，状态仅回显无凭据地址', async () => {
 const calls=[];let generation=1,pending=false;
 const controller=new SetupController({onStateChanged(){},getConnectionGeneration:()=>generation,
  async requestJson(request){calls.push(request);if(request.method==='POST'){pending=true;return {data:{provider:'deepseek',configured:true}};}
   return {data:{initialized:true,owner_configured:true,runtime_owner_configured:true,credentials_configured:true,deepseek_base_url:'https://synthetic.example/messages',runtime_configuration_pending:pending}};},
  async restart(){generation++;pending=false;return true;}});
 await controller.refresh();assert.equal(controller.getState().baseUrl,'https://synthetic.example/messages');
 await controller.saveDeepSeekConfiguration({baseUrl:'https://synthetic.example/messages',apiKey:'synthetic-config-secret'});
 assert.deepEqual(calls.find(call=>call.method==='POST'),{method:'POST',path:'/api/setup/deepseek-configuration',body:{base_url:'https://synthetic.example/messages',api_key:'synthetic-config-secret'},maxResponseBytes:4096});
 assert.equal(controller.getState().phase,'ready');assert.equal(controller.getState().configurationPending,false);
 assert.doesNotMatch(JSON.stringify(controller.getState()),/synthetic-config-secret/);
});

test('AI服务配置拒绝不安全地址和无新密钥，不能发出保存或触发重启',async()=>{
 const f=fixture();await f.controller.refresh();
 for(const baseUrl of ['https://user:secret@example.com','https://example.com/?key=secret','https://example.com/#secret','http://example.com','https://example.com/\\path','https://example.com/ spaced','https://example.com/"quoted']){
  await assert.rejects(f.controller.saveDeepSeekConfiguration({baseUrl,apiKey:'synthetic-key'}));
 }
 await assert.rejects(f.controller.saveDeepSeekConfiguration({baseUrl:'https://example.com',apiKey:''}));
 assert.equal(f.writes,0);assert.equal(f.restarts,0);
});


test('状态地址兼容旧后端与非法旧配置，公开状态不会携带URL凭据',async()=>{
 for(const baseUrl of [undefined,null,'https://user:synthetic-secret@example.com/path','https://example.com?key=synthetic-secret']){
  const controller=new SetupController({onStateChanged(){},getConnectionGeneration:()=>1,async requestJson(){return {data:{initialized:true,owner_configured:true,runtime_owner_configured:true,credentials_configured:true,deepseek_base_url:baseUrl}};}});
  await controller.refresh();assert.equal(controller.getState().phase,'ready');assert.equal(controller.getState().baseUrl,undefined);
  assert.doesNotMatch(JSON.stringify(controller.getState()),/synthetic-secret/);
 }
});

test('状态读取本机语义模型是否就绪；旧后端不返回时保持未知，类型错误视为状态不可用',async()=>{
 const read=async value=>{
  const controller=new SetupController({onStateChanged(){},getConnectionGeneration:()=>1,async requestJson(){return {data:{initialized:true,owner_configured:true,runtime_owner_configured:true,credentials_configured:true,...value}};}});
  await controller.refresh();return controller.getState();
 };
 assert.equal((await read({semantic_model_ready:false})).semanticModelReady,false);
 assert.equal((await read({semantic_model_ready:true})).semanticModelReady,true);
 const legacy=await read({});assert.equal(legacy.phase,'ready');assert.equal(legacy.semanticModelReady,undefined);
 assert.equal((await read({semantic_model_ready:'yes'})).phase,'failed');
});

test('AI配置专用IPC与预加载桥复验管理窗口和严格参数，错误不包含凭据',async()=>{
 const handlers=new Map(),calls=[],invokes=[];
 globalThis.__setupIpc={ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},ipcRenderer:{invoke:async(...args)=>{invokes.push(args);},on(){},removeListener(){}}};
 const built=await build({stdin:{contents:"export {installSetupBridge} from './src/main/setup/bridge';export {electronPageCommands} from './src/main/electron-page-commands';export {createSetupBridge} from './src/preload/setup';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'synthetic-electron',setup(plugin){plugin.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'synthetic'}));plugin.onLoad({filter:/.*/,namespace:'synthetic'},()=>({contents:'export const ipcMain=globalThis.__setupIpc.ipcMain;export const ipcRenderer=globalThis.__setupIpc.ipcRenderer;'}));}}]});
 const {installSetupBridge,electronPageCommands,createSetupBridge}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
 let url='notalone://app/index.html#manager';
 installSetupBridge(electronPageCommands({validateCaller:()=>({webContents:{getURL:()=>url}}),publish(){}}),{onStateChanged(){},saveDeepSeekConfiguration:async value=>calls.push(value)});
 const save=handlers.get('setup:save-deepseek-configuration'),value={baseUrl:'https://synthetic.example',apiKey:'synthetic-ipc-key'};
 await save({},value);assert.deepEqual(calls,[value]);
 url='notalone://app/index.html#assistant';assert.throws(()=>save({},value),error=>!error.message.includes(value.apiKey));url='notalone://app/index.html#manager';
 assert.throws(()=>save({}, {...value,extra:true}));assert.throws(()=>save({},value,{}));assert.throws(()=>save({}, {...value,baseUrl:'http://external.example'}));
 const bridge=createSetupBridge();await bridge.saveDeepSeekConfiguration(value);
 assert.deepEqual(invokes,[['setup:save-deepseek-configuration',value]]);
 await assert.rejects(bridge.saveDeepSeekConfiguration({...value,extra:true}));await assert.rejects(bridge.saveDeepSeekConfiguration(value,{}));
 assert.equal(invokes.length,1);delete globalThis.__setupIpc;
});
