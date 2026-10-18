import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const id = '10000000-0000-4000-8000-000000000001';
const bundle = await build({ stdin: { contents: `
 export { installForegroundBridge } from './src/main/foreground/bridge';
 export { createForegroundBridge } from './src/preload/foreground';
 export { ForegroundPanel } from './src/renderer/ForegroundPanel';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
 banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const dir = await mkdtemp(path.join(tmpdir(), 'notalone-manual-resume-'));
await writeFile(path.join(dir, 'ports.mjs'), bundle.outputFiles[0].text);
const ports = await import(path.join(dir, 'ports.mjs'));
test.after(() => rm(dir, { recursive: true }));

function fixture(t) {
 const state = { contacts: [{ contactId: id, displayName: '合成联系人' }], selectedContactId: id,
  scopeRevision: 1, directoryPhase: 'ready', draft: '保留的合成草稿' };
 const handlers = new Map(), roles = new Map(), scheduled = new Map(); let sequence = 0, manual = false;
 let observation;
 const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
  confirmManualInput: () => { manual = true; }, clearManualInput: () => { manual = false; },
  requestJson: async request => request.path.endsWith('/manual-confirmation') ? { generation: 1 }
   : observation ? observation(request) : { generation: 1, data: { observation_id: id,
    observed_at: new Date().toISOString(), phase: 'paused', reason: 'wechat_not_in_front',
    probe_available: true, wechat_in_front: false, binding_id: null, contact_id: null } } };
 const contacts = { getState: () => ({ ...state }), onStateChanged: () => () => {},
  selectContact: selection => { assert.equal(selection.contactId, id); return { ...state }; } };
 const foreground = ports.installForegroundBridge({ handle: (name, handler, role) => {
  handlers.set(name, handler); roles.set(name, role); }, publish: () => {} }, backend, contacts);
 // 注入合成时钟，只触发宿主已有调度，不等待或运行原生探针。
 foreground.clock = { schedule: callback => { const key = ++sequence; scheduled.set(key, callback); return key; },
  cancel: key => scheduled.delete(key) };
 t.after(() => foreground.dispose());
 const bridge = ports.createForegroundBridge({ invoke: async (name, ...args) => handlers.get(name)(...args),
  on: () => {}, removeListener: () => {} });
 const selection = () => ({ contactId: id, contactScopeRevision: 1,
  foregroundRevision: foreground.getState().foregroundRevision });
 const enterManual = () => handlers.get('contacts:confirm-manual')({ contactId: id, scopeRevision: 1 });
 return { foreground, bridge, handlers, roles, scheduled, state, selection, enterManual,
  isManual: () => manual, setObservation: value => { observation = value; } };
}
function buttons(node) {
 if (!node || typeof node !== 'object') return [];
 return [...(node.type === 'button' ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(buttons)];
}

test('手动确认后通过公开恢复按钮退出手动模式，保留草稿与聚焦暂停', async t => {
 const f = fixture(t); f.foreground.startContinuous(); f.foreground.notifyHelperLifecycle('focused');
 await f.enterManual(); assert.equal(f.isManual(), true);
 let pending;
 const session = { state: f.state, resumeForeground: revision => {
  pending = f.bridge.resume({ ...f.selection(), foregroundRevision: revision }); return pending; } };
 const panel = ports.ForegroundPanel({ state: f.foreground.getState(), session, manualInput: false });
 const resume = buttons(panel).find(button => button.props.children === '恢复微信会话识别');
 assert.ok(resume, '回应消息界面应提供可点击恢复入口');
 resume.props.onClick(); await pending;
 assert.equal(f.roles.get('foreground:resume'), 'helper');
 assert.equal(f.foreground.getState().manualInput, false);
 assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
 assert.equal(f.isManual(), false);
 assert.equal(f.state.draft, '保留的合成草稿'); assert.equal(f.state.selectedContactId, id);
 assert.equal(f.scheduled.size, 0, '助手获焦时不能启动观察');
 f.foreground.notifyHelperLifecycle('blurred'); assert.equal(f.scheduled.size, 1);
});

test('纯手动管理版和改写输入不显示恢复按钮，过期确认不得恢复', async t => {
 const f = fixture(t); await f.enterManual();
 for (const options of [{ manualRelease: true }, { manualInput: true }]) {
  const panel = ports.ForegroundPanel({ state: f.foreground.getState(), session: { state: f.state }, ...options });
  assert.equal(buttons(panel).some(button => button.props.children === '恢复微信会话识别'), false);
 }
 for (const change of [{ contactScopeRevision: 0 }, { foregroundRevision: -1 },
   { contactId: '20000000-0000-4000-8000-000000000002' }, { extra: true }]) {
  await assert.rejects(f.bridge.resume({ ...f.selection(), ...change }));
  assert.equal(f.foreground.getState().manualInput, true); assert.equal(f.isManual(), true);
 }
});

test('恢复后丢弃手动确认前的在途观察，不沿用旧生成资格', async t => {
 const f = fixture(t); let resolve;
 f.setObservation(() => new Promise(done => { resolve = done; }));
 const old = f.foreground.observeBeforeShow(); await f.enterManual();
 await f.bridge.resume(f.selection());
 resolve({ generation: 1, data: { observation_id: id, observed_at: new Date().toISOString(),
  phase: 'confirmed', reason: 'confirmed_active_binding', probe_available: true,
  wechat_in_front: true, binding_id: id, contact_id: id } });
 await old;
 assert.equal(f.foreground.getState().manualInput, false);
 assert.equal(f.foreground.getState().recognizedName, null);
 assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
});
