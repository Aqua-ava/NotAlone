import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

// 使用真实配置控制器与桥接；宿主状态、保存和重启均为合成实现，不启动 App 或模型。
const built = await build({stdin: {contents: "export {SetupController} from './src/main/setup/controller'; export {BackendRequestFailure} from './src/main/backend/json-client';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
const {SetupController, BackendRequestFailure} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const defaults = {reply: {thinkingEffort: 'off', temperature: 0}, memory: {thinkingEffort: 'off', temperature: 0}};
const parameters = {reply: {thinkingEffort: 'low', temperature: 0.7}, memory: {thinkingEffort: 'max', temperature: 0.2}};
const wire = value => Object.fromEntries(Object.entries(value).map(([purpose, settings]) => [purpose, {thinking_effort: settings.thinkingEffort, temperature: settings.temperature}]));

function fixture({credentials = true, legacy = false, external = false, initial = defaults} = {}) {
  let generation = 1, pending = false, restarts = 0, failRestart = false, rejectSave = false, saved = wire(initial), override;
  const calls = [], listeners = [];
  const backend = {
    onStateChanged(listener) {listeners.push(listener);},
    getConnectionGeneration() {return generation;},
    async requestJson(request) {
      calls.push(structuredClone(request));
      if (request.method === 'POST') {
        if (rejectSave) throw new BackendRequestFailure('response', 400, 'configuration_environment_override');
        saved = structuredClone(request.body); pending = true;
        return {data: {configured: true, restart_required: true}};
      }
      return {data: {initialized: true, owner_configured: true, runtime_owner_configured: true, credentials_configured: credentials,
        runtime_configuration_pending: pending, ...(legacy ? {} : {model_parameters: saved}), ...override}};
    },
    async restart() {
      ++restarts;
      if (failRestart) return false;
      ++generation;
      if (!external) pending = false;
      for (const listener of listeners) listener();
      return true;
    },
  };
  return {controller: new SetupController(backend), calls, get restarts() {return restarts;},
    failRestart(value) {failRestart = value;}, rejectSave(value) {rejectSave = value;}, status(value) {override = value;},
    replaceExternalProcess() {pending = false;}, posts: () => calls.filter(value => value.method === 'POST')};
}

test('回复和记忆参数独立保存，无需凭据也能重启并确认新配置', async () => {
  const f = fixture({credentials: false});
  await f.controller.refresh();
  assert.deepEqual(f.controller.getState().modelParameters, defaults);
  await f.controller.saveModelParameters(parameters);
  assert.deepEqual(f.posts(), [{method: 'POST', path: '/api/setup/model-parameters', body: wire(parameters), maxResponseBytes: 4096}]);
  assert.equal(f.restarts, 1);
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().credentialsConfigured, false);
  assert.equal(f.controller.getState().configurationPending, false);
  assert.deepEqual(f.controller.getState().modelParameters, parameters);
});

test('合法对象的键顺序不影响保存后的参数生效核对', async () => {
  const f = fixture(); await f.controller.refresh();
  const reordered = {
    memory: {temperature: parameters.memory.temperature, thinkingEffort: parameters.memory.thinkingEffort},
    reply: {temperature: parameters.reply.temperature, thinkingEffort: parameters.reply.thinkingEffort},
  };
  await f.controller.saveModelParameters(reordered);
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().configurationPending, false);
  assert.deepEqual(f.controller.getState().modelParameters, parameters);
});

test('参数已保存但重载失败时保留待加载状态，重试只重载不重发保存', async () => {
  const f = fixture(); await f.controller.refresh();
  f.failRestart(true);
  await f.controller.saveModelParameters(parameters);
  assert.equal(f.controller.getState().phase, 'restart-failed');
  assert.equal(f.controller.getState().configurationPending, true);
  f.failRestart(false); await f.controller.retryRestart();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().configurationPending, false);
  assert.deepEqual(f.controller.getState().modelParameters, parameters);
  assert.equal(f.posts().length, 1); assert.equal(f.restarts, 2);
});

test('外部服务仍报告旧快照待加载时，不把参数保存成功当成运行生效', async () => {
  const f = fixture({external: true}); await f.controller.refresh();
  await f.controller.saveModelParameters(parameters);
  assert.equal(f.controller.getState().phase, 'restart-failed');
  assert.equal(f.controller.getState().configurationPending, true);
  f.replaceExternalProcess(); await f.controller.retryRestart();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.posts().length, 1);
});

test('启动环境拒绝保存参数时不重启，公开状态保留固定原因和原值', async () => {
  const f = fixture(); await f.controller.refresh(); f.rejectSave(true);
  await assert.rejects(f.controller.saveModelParameters(parameters));
  assert.equal(f.controller.getState().errorCode, 'configuration-environment-override');
  assert.deepEqual(f.controller.getState().modelParameters, defaults);
  assert.equal(f.controller.getState().configurationPending, false);
  assert.equal(f.restarts, 0);
});

test('重启后即使服务已就绪，读回参数与提交值不同仍需待加载重试', async () => {
  const f = fixture(); await f.controller.refresh();
  f.status({model_parameters: wire(defaults)});
  await f.controller.saveModelParameters(parameters);
  assert.equal(f.controller.getState().phase, 'restart-failed');
  f.status({}); await f.controller.retryRestart();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.deepEqual(f.controller.getState().modelParameters, parameters);
  assert.equal(f.posts().length, 1);
});

test('配置控制器拒绝非法档位、温度、缺失用途和额外字段，不发保存请求', async () => {
  const f = fixture(); await f.controller.refresh();
  for (const value of [null, [], {}, {reply: defaults.reply}, {...parameters, extra: true},
    {...parameters, memory: {...parameters.memory, extra: true}},
    ...['medium', '', false].map(thinkingEffort => ({...parameters, reply: {...parameters.reply, thinkingEffort}})),
    ...[-0.1, 2.1, NaN, Infinity, '0.5'].map(temperature => ({...parameters, memory: {...parameters.memory, temperature}}))]) {
    await assert.rejects(f.controller.saveModelParameters(value));
  }
  assert.equal(f.posts().length, 0); assert.equal(f.restarts, 0);
});

test('旧后台缺少参数时使用原默认值；显式非法参数不能被默默当作默认', async () => {
  const legacy = fixture({legacy: true}); await legacy.controller.refresh();
  assert.equal(legacy.controller.getState().phase, 'ready');
  assert.deepEqual(legacy.controller.getState().modelParameters, defaults);
  for (const model_parameters of [[], {}, {reply: wire(defaults).reply}, {...wire(defaults), extra: true},
    {...wire(defaults), reply: {thinking_effort: 'medium', temperature: 0}},
    {...wire(defaults), memory: {thinking_effort: 'off', temperature: '0'}},
    {...wire(defaults), memory: {thinking_effort: 'off', temperature: 0, extra: true}}]) {
    const f = fixture(); f.status({model_parameters}); await f.controller.refresh();
    assert.equal(f.controller.getState().phase, 'failed');
  }
});

test('后台明确报告参数无效时可在设置页重设，不能声称默认值已生效', async () => {
  const f = fixture(); f.status({model_parameters: null}); await f.controller.refresh();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().modelParametersInvalid, true);
  assert.equal(f.controller.getState().modelParameters, undefined);
  f.status({}); await f.controller.saveModelParameters(defaults);
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().modelParametersInvalid, false);
  assert.deepEqual(f.controller.getState().modelParameters, defaults);
});

test('公开状态中的嵌套参数是副本，调用方修改不能改写控制器状态', async () => {
  const f = fixture({initial: parameters}); await f.controller.refresh();
  const snapshot = f.controller.getState(); snapshot.modelParameters.memory.temperature = 2;
  assert.deepEqual(f.controller.getState().modelParameters, parameters);
});

test('参数保存 IPC 仅允许管理窗口且复验严格合同，预加载不转发额外参数', async () => {
  const handlers = new Map(), calls = [], invokes = [];
  globalThis.__modelParametersIpc = {ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    ipcRenderer: {invoke: async (...args) => {invokes.push(args);}, on() {}, removeListener() {}}};
  try {
    const buildResult = await build({stdin: {contents: "export {installSetupBridge} from './src/main/setup/bridge'; export {createSetupBridge} from './src/preload/setup';", resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false,
      plugins: [{name: 'synthetic-electron', setup(plugin) {
        plugin.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'synthetic'}));
        plugin.onLoad({filter: /.*/, namespace: 'synthetic'}, () => ({contents: 'export const ipcMain=globalThis.__modelParametersIpc.ipcMain; export const ipcRenderer=globalThis.__modelParametersIpc.ipcRenderer;'}));
      }}]});
    const {installSetupBridge, createSetupBridge} = await import(`data:text/javascript;base64,${Buffer.from(buildResult.outputFiles[0].text).toString('base64')}`);
    let url = 'notalone://app/index.html#manager';
    installSetupBridge({validateCaller: () => ({webContents: {getURL: () => url}}), publish() {}},
      {onStateChanged() {}, saveModelParameters: async value => calls.push(value)});
    const save = handlers.get('setup:save-model-parameters');
    assert.equal(typeof save, 'function');
    await save({}, parameters); assert.deepEqual(calls, [parameters]);
    url = 'notalone://app/index.html#assistant'; assert.throws(() => save({}, parameters));
    url = 'notalone://app/index.html#manager';
    assert.throws(() => save({}, parameters, {}));
    assert.throws(() => save({}, {...parameters, extra: true}));
    assert.throws(() => save({}, {...parameters, memory: {...parameters.memory, temperature: Infinity}}));
    const bridge = createSetupBridge(); await bridge.saveModelParameters(parameters);
    assert.deepEqual(invokes, [['setup:save-model-parameters', parameters]]);
    await assert.rejects(bridge.saveModelParameters(parameters, {}));
    await assert.rejects(bridge.saveModelParameters({...parameters, memory: {...parameters.memory, extra: true}}));
    assert.equal(invokes.length, 1);
  } finally {delete globalThis.__modelParametersIpc;}
});
