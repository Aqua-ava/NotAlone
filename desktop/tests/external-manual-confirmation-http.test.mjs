import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { withoutExternalTracing } from '../scripts/test-environment.mjs';

test('外置模式无桌面绑定的粘贴输入经可见联系人确认后生成候选', {
  skip: process.env.CONDA_DEFAULT_ENV !== 'NotAlone', timeout: 90000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-external-manual-'));
  const bundle = await build({ stdin: { contents: `
    export { BackendHost } from './src/main/backend/host';
    export { installContactSessionBridge } from './src/main/contacts/bridge';
    export { installForegroundBridge } from './src/main/foreground/bridge';
    export { installReplyBridge } from './src/main/reply/bridge';
    export { createReplyBridge } from './src/preload/reply';
    export { ForegroundPanel } from './src/renderer/ForegroundPanel';
    export { HelperContactPicker } from './src/renderer/contact-session';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
  const file = path.join(directory, 'ports.mjs');
  await writeFile(file, bundle.outputFiles[0].text);
  const ports = await import(file), project = path.resolve('..');
  const child = spawn(path.join(process.env.CONDA_PREFIX, 'bin/python'),
    ['tests/fixtures/manual-connection-change-backend.py', '--reply-ready'], {
      stdio: ['pipe', 'pipe', 'inherit'], env: withoutExternalTracing({ ...process.env,
        NOTALONE_DISABLE_DOTENV: '1', NOTALONE_ENV_FILE: path.join(directory, 'unused.env'),
        NOTALONE_DATABASE_URL: '', NOTALONE_OWNER_ID: '', NOTALONE_DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY: '',
        PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1' }),
    });
  let cleanup = false;
  const ready = new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).on('line', line => {
      const value = JSON.parse(line);
      if (value.ready) resolve(value.ready);
      if (value.cleanup) cleanup = true;
    });
    child.once('exit', code => reject(new Error(`synthetic_backend_exit_${code}`)));
  });
  let host, foreground;
  t.after(async () => {
    foreground?.dispose();
    if (host?.getConnectionGeneration() !== undefined) assert.equal(await host.prepareConfiguration(), true);
    if (child.exitCode === null) {
      child.stdin.end('{"operation":"stop"}\n');
      await new Promise(resolve => child.once('exit', resolve));
    }
    assert.equal(child.exitCode, 0); assert.equal(cleanup, true);
    await rm(directory, { recursive: true, force: true });
  });
  const backend = await ready, info = path.join(directory, 'backend.info');
  await writeFile(info, `address=127.0.0.1:${backend.port}\ntoken=${backend.token}\npid=${backend.pid}\n`, { mode: 0o600 });
  await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({ backendInfoPath: info }));
  host = new ports.BackendHost(directory);
  const handlers = new Map(), listeners = new Map();
  const commands = { handle: (name, handler) => handlers.set(name, handler),
    publish: (name, state) => { for (const listener of listeners.get(name) ?? []) listener(undefined, state); } };
  const contacts = ports.installContactSessionBridge(commands, host);
  foreground = ports.installForegroundBridge(commands, host, contacts);
  const replies = ports.installReplyBridge(commands, host, contacts, () => foreground.getGenerationBlock());
  host.setConnectionChangePreparation(() => replies.prepareGenerationConnectionChange());
  const bridge = ports.createReplyBridge({ invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name)(...args)),
    on: (name, listener) => { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); },
    removeListener: (name, listener) => listeners.get(name)?.delete(listener) });
  await host.connect(); await contacts.refreshContacts();
  assert.equal(contacts.getState().contacts.length, 0);
  await handlers.get('contacts:create')({ displayName: '合成无绑定联系人', scopeRevision: contacts.getState().scopeRevision });
  const contactId = contacts.getState().contacts[0].contactId;
  await handlers.get('contacts:select')({ contactId, scopeRevision: contacts.getState().scopeRevision });
  let confirmation;
  const session = { state: contacts.getState(),
    confirmContact: (id, revision) => confirmation = handlers.get('foreground:confirm')({
      contactId: id, contactScopeRevision: contacts.getState().scopeRevision, foregroundRevision: revision }),
    confirmManualContact: id => confirmation = handlers.get('contacts:confirm-manual')({
      contactId: id, scopeRevision: contacts.getState().scopeRevision }),
  };
  // 点击生产面板公开的确认按钮；外置模式与实际粘贴输入一致，不预造渠道绑定。
  const panel = ports.ForegroundPanel({ state: foreground.getState(), session, manualRelease: false, manualInput: true });
  const confirmationButton = panel => [panel.props.children].flat(Infinity).find(item => item?.type === 'button');
  const button = confirmationButton(panel);
  assert.ok(button, '已选联系人的输入面板应提供确认入口');
  button.props.onClick(); await confirmation;
  assert.equal(foreground.getState().confirmation, 'manual-confirmed');
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  await handlers.get('contacts:set-draft')({ ...scope, text: '合成对方：今晚一起去吗？' });
  await bridge.updateOptions({ ...scope, options: { tone: 'original', instruction: '',
    includeRelationshipContext: true, inputKind: 'current_chat', pastedDirection: '今天不去，简短婉拒' } });
  await bridge.generate({ ...scope, newRequest: true });
  const result = await bridge.getState();
  assert.equal(result.phase, 'ready', `明确确认后的手动输入应可生成，实际错误：${result.errorCode}`);
  assert.equal(result.result.candidates[0].original.text, '今天先不去了，下次再约。');
  assert.equal(foreground.getState().manualInput, true);
  const confirmForeground = () => session.confirmContact(contactId, foreground.getState().foregroundRevision);
  await confirmForeground();
  assert.equal(foreground.getState().manualInput, false, '原前台确认仍保持独立语义');
  assert.equal(foreground.getGenerationBlock(), null);
  const manualPanel = ports.ForegroundPanel({ state: foreground.getState(), session, manualInput: true });
  assert.equal(manualPanel.props.children[0].props.children.join(''), '手动输入模式 · 请明确选择本次联系人');
  const reconfirm = confirmationButton(manualPanel);
  assert.ok(reconfirm, '前台已确认不能代替本次手动输入确认');
  reconfirm.props.onClick(); await confirmation;
  assert.equal(foreground.getState().manualInput, true);
  await confirmForeground();
  const picker = ports.HelperContactPicker({ session: { ...session, state: contacts.getState() },
    foreground: foreground.getState(), manualInput: true });
  picker.props.onChange({ target: { value: contactId } });
  await confirmation;
  assert.equal(foreground.getState().manualInput, true, '粘贴模式的联系人选择使用同一手动确认入口');
  assert.equal(contacts.getState().draft, '合成对方：今晚一起去吗？');
});
