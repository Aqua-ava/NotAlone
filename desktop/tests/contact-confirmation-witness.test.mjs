import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';

const options = { entryPoints: ['tests/contact-confirmation-witness.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false };
const original = await build(options);
const productionWitness = await import(`data:text/javascript;base64,${Buffer.from(original.outputFiles[0].text).toString('base64')}`);
const disk = '// 合成 Main 源码，仅供协议单元测试，不认证实际 C 构建或断点。\nvoid 0;\n';
const fingerprint = createHash('sha256').update(disk).digest('hex');
// 只替换测试编译副本的期望指纹；正式源码、默认固定 C 校验和断点不变。
const output = await build({ ...options, plugins: [{ name: 'synthetic-witness-fingerprint', setup(builder) {
  builder.onLoad({ filter: /contact-confirmation-witness\.ts$/ }, async ({ path }) => {
    const source = await readFile(path, 'utf8');
    const declaration = /export const C_MAIN_SHA256 = '[0-9a-f]{64}';/g;
    assert.equal([...source.matchAll(declaration)].length, 1);
    return { contents: source.replace(declaration, `export const C_MAIN_SHA256 = '${fingerprint}';`), loader: 'ts' };
  });
} }] });
const witness = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const versions = { electron: '44.7.0', chrome: '152.0.7977.130', node: '24.21.0', v8: '15.2.124.28-electron.0' };

test('正式默认见证仍拒绝合成源码，不因协议单元测试改变固定 C 契约', () => {
  assert.notEqual(productionWitness.C_MAIN_SHA256, fingerprint);
  assert.throws(() => productionWitness.verifyWitnessSource(disk, disk, versions), /source/);
  assert.throws(() => productionWitness.verifyWitnessSource(disk,
    productionWitness.NODE_WRAPPER[0] + disk + productionWitness.NODE_WRAPPER[1], versions), /source/);
});

test('来源或实际版本漂移时拒绝诊断，不把相近版本当作C', () => {
  assert.throws(() => witness.verifyWitnessSource(`${disk}\n`, `${disk}\n`, versions), /source/);
  assert.throws(() => witness.verifyWitnessSource(disk, `${disk}\n`, versions), /source/);
  assert.throws(() => witness.verifyWitnessSource(disk, disk, { ...versions, node: '24.20.0' }), /version/);
});

test('可执行位置为空、跨源码或跨原语句时拒绝，不补命中其他位置', () => {
  assert.throws(() => witness.chooseWitnessLocation('main-c', 126, []), /location/);
  assert.throws(() => witness.chooseWitnessLocation('main-c', 126,
    [{ scriptId: 'foreign', lineNumber: 126, columnNumber: 8 }]), /location/);
  assert.throws(() => witness.chooseWitnessLocation('main-c', 126,
    [{ scriptId: 'main-c', lineNumber: 127, columnNumber: 8 }]), /location/);
});

test('只接受C原源码或固定官方CommonJS包裹，不宽松修整源码', () => {
  assert.equal(witness.verifyWitnessSource(disk, disk, versions), 'unwrapped');
  assert.equal(witness.verifyWitnessSource(disk, witness.NODE_WRAPPER[0] + disk + witness.NODE_WRAPPER[1], versions), 'node-commonjs');
  assert.throws(() => witness.verifyWitnessSource(disk, ` ${disk}`, versions), /source/);
});

test('协议报告paused时诊断无效，不伪造非暂停见证', () => {
  const log = new witness.ConfirmationWitnessLog('owned-nonce');
  log.receive('Debugger.paused', { reason: 'other', callFrames: [{ private: '不得持久化' }] });
  assert.deepEqual(log.report(true), { valid: false, paused: 1, records: [], failure: 'paused', foreignIgnored: 0, cleanupConfirmed: true });
});

test('其他console记录只计忽略，不保存正文或把它充作本场证据', () => {
  const log = new witness.ConfirmationWitnessLog('owned-nonce');
  log.receive('Runtime.consoleAPICalled', { args: [{ value: 'foreign-nonce' }, { value: '其他内容不得存入诊断' }] });
  assert.equal(log.report(true).foreignIgnored, 1);
  assert.deepEqual(log.report(true).records, []);
  assert(!JSON.stringify(log.report(true)).includes('其他内容'));
});

const guard = { phase: 'guard', submittedScopeRevision: 2, submittedForegroundRevision: 12,
  currentScopeRevision: 2, currentForegroundRevision: 13, currentContactRevision: 5,
  currentForegroundStateRevision: 13, generationValid: true };
const emitRecord = (log, value) => log.receive('Runtime.consoleAPICalled', {
  args: [{ value: 'owned-nonce' }, { value: JSON.stringify(value) }],
});

test('只按实际分支配对见证，不因代算版本就认证accepted', () => {
  const rejected = new witness.ConfirmationWitnessLog('owned-nonce');
  emitRecord(rejected, guard);
  assert.equal(rejected.report(true).valid, false);
  emitRecord(rejected, { ...guard, phase: 'rejected' });
  assert.equal(rejected.report(true).valid, true);
  assert.equal(rejected.report(true).records.at(-1).phase, 'rejected');
  assert.equal(rejected.report(false).valid, false);
  assert.equal(rejected.report(false).failure, 'cleanup_unconfirmed');
  const returned = new witness.ConfirmationWitnessLog('owned-nonce');
  emitRecord(returned, { ...guard, currentForegroundRevision: 12 });
  emitRecord(returned, { ...guard, phase: 'returned', selectedScopeRevision: 3, selectedContactRevision: 6 });
  assert.equal(returned.report(true).valid, true);
});

test('自有记录多余身份字段、非法数字或超过24条均拒签且不保存多余内容', () => {
  for (const value of [{ ...guard, contactId: '不得保存联系人标识' }, { ...guard, currentContactRevision: -1 }]) {
    const log = new witness.ConfirmationWitnessLog('owned-nonce');
    emitRecord(log, value);
    assert.equal(log.report(true).failure, 'record_rejected');
    assert.deepEqual(log.report(true).records, []);
  }
  const log = new witness.ConfirmationWitnessLog('owned-nonce');
  for (let i = 0; i < 13; i += 1) { emitRecord(log, guard); emitRecord(log, { ...guard, phase: 'rejected' }); }
  assert.equal(log.report(true).records.length, 24);
  assert.equal(log.report(true).failure, 'overflow');
});

function protocolFixture(wrongLocation = false, closeConfirmed = true) {
  let listener, stopped = false, closed = false;
  const commands = [];
  const scriptUrl = 'file:///synthetic/app.asar/dist/main/index.cjs';
  const protocol = {
    onEvent(value) { listener = value; return () => { stopped = true; }; },
    async send(method, params = {}) {
      commands.push({ method, params });
      if (method === 'Debugger.enable') listener('Debugger.scriptParsed', { scriptId: 'main-c', url: scriptUrl });
      if (method === 'Debugger.getScriptSource') return { scriptSource: disk };
      if (method === 'Debugger.getPossibleBreakpoints') return { locations: [{ ...params.start, columnNumber: 8 }] };
      if (method === 'Debugger.setBreakpoint') return { breakpointId: `own-${commands.length}`,
        actualLocation: { ...params.location, lineNumber: params.location.lineNumber + Number(wrongLocation) } };
      return {};
    },
    async close() { closed = true; return closeConfirmed; },
  };
  return { protocol, commands, target: { disk, versions, scriptUrl, nonce: 'owned-nonce' },
    emit: (phase) => listener('Runtime.consoleAPICalled', { args: [{ value: 'owned-nonce' }, { value: JSON.stringify({ ...guard, phase }) }] }),
    cleaned: () => stopped && closed };
}

test('实际落点被迁移则拒绝并仅移除自有断点、关闭自有会话', async () => {
  const f = protocolFixture(true);
  await assert.rejects(witness.installMainConfirmationWitness(f.protocol, f.target), /location/);
  assert(f.cleaned());
  assert.equal(f.commands.filter(({ method }) => method === 'Debugger.setBreakpoint').length, 1);
  assert.deepEqual(f.commands.at(-1), { method: 'Debugger.removeBreakpoint', params: { breakpointId: 'own-5' } });
  assert(!f.commands.some(({ method }) => /resume|disable|setSkipAllPauses/.test(method)));
});

test('已验证协议仍须实际分支和明确收尾，不能以安装成功充验收', async () => {
  const f = protocolFixture(false, false);
  const running = await witness.installMainConfirmationWitness(f.protocol, f.target);
  f.emit('guard'); f.emit('rejected');
  const report = await running.stop();
  assert.equal(report.valid, false);
  assert.equal(report.failure, 'cleanup_unconfirmed');
  assert.equal(report.exactReactCommittedRevisionCertified, false);
  assert.equal(f.commands.filter(({ method }) => method === 'Debugger.removeBreakpoint').length, 3);
  assert(f.cleaned());
});

test('外部或带凭据的地址在建立WebSocket前拒绝', async () => {
  const Socket = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error('不允许测试访问任何网络'); } };
  try {
    for (const address of ['invalid', 'ws://example.com:1234/00000000-0000-0000-0000-000000000000',
      'ws://user:password@127.0.0.1:1234/00000000-0000-0000-0000-000000000000',
      'wss://127.0.0.1:1234/00000000-0000-0000-0000-000000000000', 'ws://127.0.0.1:1234/arbitrary']) {
      await assert.rejects(witness.connectLocalInspector(address), /endpoint/);
    }
  } finally { globalThis.WebSocket = Socket; }
});

test('未列入固定错误码的异常正文不能进入诊断收据', () => {
  assert.equal(witness.witnessFailureCode(new Error('witness_unapproved_private_text')), 'witness_protocol_rejected');
  assert.equal(witness.witnessFailureCode(new Error('witness_source_rejected')), 'witness_source_rejected');
});
