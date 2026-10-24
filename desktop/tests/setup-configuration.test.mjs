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
      if (request.method === 'POST') { pending = true; ++writes; return { data: { provider: 'deepseek', configured: true, official_deepseek_defaults: true, restart_required: true } }; }
      return { data: { initialized: true, owner_configured: true, runtime_owner_configured: true, credentials_configured: true, official_deepseek_defaults: true, runtime_configuration_pending: pending, runtime_configuration_environment_override: environmentOverride } };
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
  await f.controller.saveDeepSeekKey('synthetic-secret-canary');
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().configurationPending, false);
  assert.equal(f.restarts, 1);
  assert.equal(f.writes, 1);
  assert.doesNotMatch(JSON.stringify(f.controller.getState()), /synthetic-secret-canary/);
});

test('external 重连同一快照不能声称已生效，替换进程后安全重试不重发保存', async () => {
  const f = fixture('external');
  await f.controller.refresh();
  await f.controller.saveOfficialDeepSeekKey('synthetic-official-canary');
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
  await f.controller.saveDeepSeekKey('synthetic-retry-canary');
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
  await f.controller.saveDeepSeekKey('synthetic-private-key');
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
  await f.controller.saveDeepSeekKey('synthetic-environment-private-key');
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
