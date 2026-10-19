import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `export { installForegroundBridge } from './src/main/foreground/bridge';`,
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { installForegroundBridge } = module.exports;
const contactId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const binding = (id = contactId, suffix = '1') => ({ binding_id: `20000000-0000-4000-8000-00000000000${suffix}`,
  contact_id: id, conversation_locator: `wxid_synthetic_${suffix}`, display_name: '合成绑定', status: 'active' });

function fixture(t, bindings = []) {
  let generation = 1, read = async () => ({ generation, data: { bindings } });
  const calls = [], handlers = new Map();
  const state = { contacts: [contactId, otherId].map(contactId => ({ contactId, displayName: '合成联系人' })),
    selectedContactId: contactId, scopeRevision: 1, directoryPhase: 'ready' };
  const backend = { getConnectionGeneration: () => generation, onStateChanged: () => () => {},
    clearManualInput: id => calls.push({ clearManual: id }), confirmManualInput() { throw new Error('不得静默授予手动输入'); },
    requestJson: options => { calls.push(options); return read(); } };
  const contacts = { getState: () => ({ ...state }), onStateChanged: () => () => {},
    selectContact: selection => { state.selectedContactId = selection.contactId; return { ...state }; } };
  const foreground = installForegroundBridge({ handle: (name, handler) => handlers.set(name, handler), publish() {} }, backend, contacts);
  t.after(() => foreground.dispose());
  const selection = () => ({ contactId, contactScopeRevision: state.scopeRevision, foregroundRevision: foreground.getState().foregroundRevision });
  return { foreground, state, calls, selection, confirm: value => handlers.get('foreground:confirm')(value ?? selection()),
    setRead: value => { read = value; }, reconnect: () => { generation += 1; } };
}

for (const [name, bindings] of [['未绑定', []], ['仅另一联系人绑定', [binding(otherId)]],
  ['已撤销', [{ ...binding(), status: 'revoked' }]], ['绑定歧义', [binding(), binding(contactId, '2')]]]) {
  test(`${name}不能通过前台确认解除生成门或静默切换手动输入`, async t => {
    const f = fixture(t, bindings);
    await assert.rejects(Promise.resolve().then(() => f.confirm()), /foreground_binding_required/);
    assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
    assert.equal(f.foreground.getState().confirmation, 'required');
    assert.equal(f.state.selectedContactId, contactId);
    assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/api/sync/cli-bindings']]);
  });
}

test('唯一已有绑定允许显式确认，只读授权目录不读取聊天或自动生成', async t => {
  const f = fixture(t, [binding(), binding(otherId, '2')]);
  await f.confirm();
  assert.equal(f.foreground.getGenerationBlock(), null);
  assert.equal(f.foreground.getState().confirmedContactId, contactId);
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/api/sync/cli-bindings' }, { clearManual: contactId }]);
});

for (const change of ['contact', 'foreground', 'connection']) {
  test(`绑定核验中${change}改变，迟到成功不得确认旧范围`, async t => {
    const f = fixture(t, [binding()]);
    let release;
    f.setRead(() => new Promise(resolve => { release = resolve; }));
    const pending = Promise.resolve().then(() => f.confirm());
    await new Promise(setImmediate);
    assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
    if (change === 'contact') { f.state.selectedContactId = otherId; f.state.scopeRevision += 1; }
    else if (change === 'foreground') { f.foreground.notifyHelperLifecycle('focused'); }
    else f.reconnect();
    release({ generation: 1, data: { bindings: [binding()] } });
    await assert.rejects(pending);
    assert.equal(f.foreground.getGenerationBlock(), 'foreground-confirmation-required');
    assert.equal(f.calls.length, 1);
  });
}

test('过时或未知联系人确认在读取授权目录前拒绝', async t => {
  const f = fixture(t, [binding()]);
  await assert.rejects(Promise.resolve().then(() => f.confirm({ ...f.selection(), contactScopeRevision: 0 })));
  await assert.rejects(Promise.resolve().then(() => f.confirm({ ...f.selection(), contactId: '30000000-0000-4000-8000-000000000003' })));
  assert.deepEqual(f.calls, []);
});
