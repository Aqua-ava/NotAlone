import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, chmod, readFile, rm, symlink, link, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

test('私有校准证据只读原字节，拒绝宽权限、软硬链接及缺失文件', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-foreground-credential-test-')));
  try {
    const bundle = path.join(directory, 'credential.mjs');
    await build({ entryPoints: ['tests/real-foreground-credential.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const helper = await import(pathToFileURL(bundle).href);
    const source = path.join(directory, 'synthetic-profile.json');
    const bytes = Buffer.from(' {"state":"synthetic-only"}\n');
    await writeFile(source, bytes, { mode: 0o600 });
    assert.deepEqual(await helper.readAcceptanceFile(source, 8192, true), bytes);
    await chmod(source, 0o644);
    await assert.rejects(helper.readAcceptanceFile(source, 8192, true), /real_foreground_credential_invalid/);
    await chmod(source, 0o600);
    await symlink(source, path.join(directory, 'symbolic.json'));
    await assert.rejects(helper.readAcceptanceFile(path.join(directory, 'symbolic.json'), 8192, true));
    await link(source, path.join(directory, 'hard.json'));
    await assert.rejects(helper.readAcceptanceFile(source, 8192, true));
    await rm(path.join(directory, 'hard.json'));
    await assert.rejects(helper.readAcceptanceFile(source, 2, true));
    await assert.rejects(helper.readAcceptanceFile(path.join(directory, 'absent.json'), 8192, true));
    const uid = process.getuid();
    const mockedUid = mock.method(process, 'getuid', () => uid + 1);
    try { await assert.rejects(helper.readAcceptanceFile(source, 8192, true)); }
    finally { mockedUid.mock.restore(); }
    assert.deepEqual(await readFile(source), bytes);
  } finally { stop(); await rm(directory, { recursive: true, force: true }); }
});

test('前台定位新模式的缺失或空账本不能成为退出成功证据', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-foreground-audit-test-')));
  try {
    const bundle = path.join(directory, 'credential.mjs');
    await build({ entryPoints: ['tests/real-foreground-credential.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const helper = await import(pathToFileURL(bundle).href);
    await t.test('缺账必须拒绝', async () => {
      await assert.rejects(helper.readForegroundAudit(path.join(directory, 'absent.jsonl')), /real_foreground_audit_invalid/);
    });
    await t.test('空账必须拒绝', async () => {
      const selected = path.join(directory, 'empty.jsonl');
      await writeFile(selected, '', { mode: 0o600 });
      await assert.rejects(helper.readForegroundAudit(selected), /real_foreground_audit_invalid/);
    });
  } finally { stop(); await rm(directory, { recursive: true, force: true }); }
});

test('定位退出必须保存退出前非空 PID，等数量替换或删除旧记录不能认证停读', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-foreground-quit-audit-test-')));
  try {
    const bundle = path.join(directory, 'credential.mjs');
    await build({ entryPoints: ['tests/real-foreground-credential.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const helper = await import(pathToFileURL(bundle).href);
    const selected = path.join(directory, 'audit.jsonl');
    const save = async rows => {
      await writeFile(selected, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      return helper.readForegroundAudit(selected);
    };
    const reservation = { event: 'started', kind: 'tail', pid: null, status: 'reserved' };
    const running = { event: 'started', kind: 'tail', pid: 123, status: 'running' };
    await t.test('只有预约而没有实际 PID 必须拒绝', async () => {
      const snapshot = await save([reservation]);
      assert.throws(() => helper.foregroundQuitPids(snapshot), /real_foreground_audit_invalid/);
    });
    const before = await save([reservation, running]);
    await t.test('同数量换 PID 必须拒绝', async () => {
      const changed = await save([reservation, { ...running, pid: 124 }]);
      assert.throws(() => helper.verifyForegroundAuditAppend(before, changed), /real_foreground_audit_invalid/);
    });
    await t.test('PID 相同但删除旧预约记录必须拒绝', async () => {
      const changed = await save([running]);
      assert.throws(() => helper.verifyForegroundAuditAppend(before, changed), /real_foreground_audit_invalid/);
    });
    await t.test('退出后新预约没有 PID 也不能认证无新启动', async () => {
      const changed = await save([reservation, running, reservation]);
      assert.throws(() => helper.verifyForegroundAuditAppend(before, changed, false), /real_foreground_audit_invalid/);
    });
    await t.test('已知记录完整追加退出结果可以核查同一 PID', async () => {
      const finished = { event: 'finished', kind: 'tail', pid: 123, status: 'exited', returncode: 0 };
      const after = await save([reservation, running, finished]);
      assert.deepEqual(helper.foregroundQuitPids(before), [123]);
      helper.verifyForegroundAuditAppend(before, after, false);
      assert.equal(Object.isFrozen(before.startedPids), true);
      assert.equal(Object.isFrozen(before.rows), true);
      assert.throws(() => before.startedPids.push(124), TypeError);
    });
  } finally { stop(); await rm(directory, { recursive: true, force: true }); }
});

test('定位元数据缺项、非法行及未知字段不能签为零或已核实', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-foreground-metadata-audit-test-')));
  try {
    const bundle = path.join(directory, 'credential.mjs');
    await build({ entryPoints: ['tests/real-foreground-credential.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const helper = await import(pathToFileURL(bundle).href);
    const selected = path.join(directory, 'audit.jsonl');
    const running = { event: 'started', kind: 'tail', pid: 123, status: 'running' };
    await writeFile(selected, JSON.stringify(running) + '\n', { mode: 0o600 });
    const snapshot = await helper.readForegroundAudit(selected);
    await t.test('实际启动记录不能替代缺失元数据', async () => {
      assert.throws(() => helper.foregroundMetadataCounts(snapshot), /real_foreground_audit_invalid/);
    });
    const metadata = { event: 'metadata', kind: 'foreground_metadata', pid: null, status: 'validated',
      candidate_count: 2, private_count: 1, group_count: 1, other_type_count: 0, exact_name_count: 2 };
    await t.test('只有实际已核数量才输出，零候选须有明确记录', async () => {
      await writeFile(selected, JSON.stringify(metadata) + '\n');
      assert.deepEqual(helper.foregroundMetadataCounts(await helper.readForegroundAudit(selected)), [
        { candidate_count: 2, private_count: 1, group_count: 1, other_type_count: 0, exact_name_count: 2 }]);
      await writeFile(selected, JSON.stringify({ ...metadata, candidate_count: 0, private_count: 0, group_count: 0, exact_name_count: 0 }) + '\n');
      assert.deepEqual(helper.foregroundMetadataCounts(await helper.readForegroundAudit(selected)), [
        { candidate_count: 0, private_count: 0, group_count: 0, other_type_count: 0, exact_name_count: 0 }]);
    });
    await t.test('未知形状、非法 PID 或数量及半行必须拒绝', async () => {
      for (const value of [{ ...running, pid: 0 }, { ...running, pid: -1 }, { ...running, pid: '123' },
        { ...running, event: 'unknown' }, { ...running, kind: 'unknown' }, { ...running, status: 'unknown' },
        { ...running, text: '不应保存的合成正文' }, { ...metadata, candidate_count: 3 },
        { ...metadata, exact_name_count: 3 }, { ...metadata, group_count: -1 }]) {
        await writeFile(selected, JSON.stringify(value) + '\n');
        await assert.rejects(helper.readForegroundAudit(selected), error => error.message === 'real_foreground_audit_invalid');
      }
      for (const value of ['{}\n', '\n', 'bad\n', JSON.stringify(running), JSON.stringify(running) + '\n\n']) {
        await writeFile(selected, value);
        await assert.rejects(helper.readForegroundAudit(selected), /real_foreground_audit_invalid/);
      }
    });
  } finally { stop(); await rm(directory, { recursive: true, force: true }); }
});

test('失败 G 收据、错误摘要和其它 E 包均先拒绝，真实身份不会出现在错误中',
  { skip: !process.env.NOTALONE_STATIC_E_APP }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-foreground-G-proof-test-')));
  try {
    const bundle = path.join(directory, 'credential.mjs');
    await build({ entryPoints: ['tests/real-foreground-credential.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const helper = await import(pathToFileURL(bundle).href);
    const files = Object.fromEntries(['credential', 'scope', 'profile', 'result', 'receipt'].map(key => [key, path.join(directory, key + '.json')]));
    const app = path.join(directory, 'NotAlone.app/Contents/MacOS/NotAlone');
    await mkdir(path.dirname(app), { recursive: true });
    const packageSource = process.env.NOTALONE_STATIC_E_APP;
    // 只复用已打包的公开字节作有意义的文件输入；不执行、载入或校验系统权限。
    for (const relative of ['Contents/MacOS/NotAlone', 'Contents/Resources/app.asar',
      'Contents/Resources/notalone-probe/manifest.json', 'Contents/Resources/notalone-probe/notalone-sync-probe',
      'Contents/Resources/notalone-probe/libNotAloneSyncCore.dylib']) {
      const target = path.join(directory, 'NotAlone.app', relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(packageSource, relative), target);
      await chmod(target, relative.endsWith('/NotAlone') || relative.endsWith('/notalone-sync-probe') ? 0o755 : 0o644);
    }
    const digest = value => createHash('sha256').update(value).digest('hex');
    const save = async (file, value) => { const bytes = Buffer.from(JSON.stringify(value)); await writeFile(file, bytes, { mode: 0o600 }); return digest(bytes); };
    const profile = { schemaVersion: 1, state: 'verified-minimal-layout', wechatVersion: '4.0.6', wechatBuild: '29387',
      processId: 123, windowId: 456, windowFrame: { x: 1, y: 2, width: 600, height: 400 }, pixelScale: 2,
      regions: Object.fromEntries(['displayName', 'selectedRowName', 'verticalDivider', 'headerDivider', 'selectedHighlight'].map(key => [key, { x: 1, y: 2, width: 20, height: 5 }])),
      sentinelDigests: Object.fromEntries(['verticalDivider', 'headerDivider', 'selectedHighlight'].map(key => [key, '0'.repeat(64)])) };
    const credential = { schemaVersion: 1, purpose: 'real-foreground-locator-acceptance', displayName: '合成测试名（非真人）',
      scopePath: files.scope, appExecutablePath: app, profilePath: files.profile, verificationResultPath: files.result, calibrationReceiptPath: files.receipt,
      scopeSha256: await save(files.scope, { synthetic: 'scope' }), profileSha256: await save(files.profile, profile),
      verificationResultSha256: await save(files.result, { state: 'verified', error: null, stage: 'profile' }),
      appExecutableSha256: digest(await readFile(app)), calibrationReceiptSha256: '' };
    const receipt = { schemaVersion: 1, kind: 'root-foreground-layout-verification', candidate: 'E', actualAppLaunches: 1,
      actualVerificationSucceeded: true, profileCopiedFromActualApp: true, probeSubstituted: false,
      appExecutableSha256: credential.appExecutableSha256, profileSha256: credential.profileSha256, verificationResultSha256: credential.verificationResultSha256,
      nativeBuildSourceDigest: '7f4fed1ef4edeb310f69897e9e007d6a8314a727606d956b2ebeb785b3288934',
      asarSha256: '376c9a53920c4b7e5c927383e1b170ec755033ca5a96aa6573707204c48449ab',
      probeSha256: 'e10512d1c287986c4eda2690f2853248d042ac2cb4e1914f714952c109e7605c',
      coreSha256: '9235a1e91850d58fd6e63aa05bf8866458145f38224c08f3ba11ba0ebf2f2570' };
    const rejected = async () => assert.rejects(helper.readForegroundCredential(files.credential, app, files.scope), error =>
      error.message === 'real_foreground_credential_invalid' && !error.message.includes('合成测试名'));
    credential.calibrationReceiptSha256 = await save(files.receipt, receipt);
    await save(files.credential, credential);
    const accepted = await helper.readForegroundCredential(files.credential, app, files.scope);
    assert.deepEqual(accepted.profileBytes, await readFile(files.profile));
    assert.equal(accepted.displayName, credential.displayName); // 合成 Root 声明只验证文件合同，不认证真正 G。
    for (const change of [{ actualVerificationSucceeded: false }, { actualAppLaunches: 0 }, { profileCopiedFromActualApp: false },
      { probeSubstituted: true }, { candidate: 'C' }, { profileSha256: 'f'.repeat(64) }]) {
      credential.calibrationReceiptSha256 = await save(files.receipt, { ...receipt, ...change });
      await save(files.credential, credential); await rejected();
    }
    credential.calibrationReceiptSha256 = await save(files.receipt, receipt);
    await save(files.credential, credential);
    await writeFile(app, 'synthetic-other-App-only'); await rejected();
    await copyFile(path.join(packageSource, 'Contents/MacOS/NotAlone'), app); await chmod(app, 0o755);
    credential.verificationResultSha256 = await save(files.result, { state: 'failed', error: 'session_name_confidence_low', stage: 'names' });
    receipt.verificationResultSha256 = credential.verificationResultSha256;
    credential.calibrationReceiptSha256 = await save(files.receipt, receipt); await save(files.credential, credential);
    await rejected();
    credential.verificationResultSha256 = await save(files.result, { state: 'verified', error: null, stage: 'profile' });
    receipt.verificationResultSha256 = credential.verificationResultSha256;
    credential.calibrationReceiptSha256 = await save(files.receipt, receipt); await save(files.credential, credential);
    await save(files.profile, { ...profile, processId: 999 }); await rejected();
    await rm(files.profile); await rejected();
  } finally { stop(); await rm(directory, { recursive: true, force: true }); }
});

test('没有 Root 本场成功凭据不能把任意 verified 字样授为真实校准', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-foreground-proof-test-')));
  try {
    const bundle = path.join(directory, 'credential.mjs');
    await build({ entryPoints: ['tests/real-foreground-credential.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const helper = await import(pathToFileURL(bundle).href);
    const credential = path.join(directory, 'credential.json');
    await writeFile(credential, JSON.stringify({ schemaVersion: 1, purpose: 'real-foreground-locator-acceptance', state: 'verified' }), { mode: 0o600 });
    await assert.rejects(helper.readForegroundCredential(credential, '/synthetic/NotAlone.app/Contents/MacOS/NotAlone', '/synthetic/scope.json'), /real_foreground_credential_invalid/);
    await assert.rejects(helper.readForegroundCredential(path.join(directory, 'G-absent.json'), '/synthetic/NotAlone.app/Contents/MacOS/NotAlone', '/synthetic/scope.json'), /real_foreground_credential_invalid/);
  } finally { stop(); await rm(directory, { recursive: true, force: true }); }
});

test('真实观察投影保留固定结果但不保存身份，并拒绝跨联系人、扩展原文及错误状态', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-foreground-projection-test-')));
  try {
    const bundle = path.join(directory, 'proxy.mjs');
    await build({ entryPoints: ['tests/contact-http-proxy.ts'], outfile: bundle,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { foregroundAcceptanceProjection } = await import(pathToFileURL(bundle).href);
    const contact = '00000000-0000-4000-8000-000000000001';
    const value = { observation_id: '00000000-0000-4000-8000-000000000002', observed_at: '2026-10-13T00:00:00Z',
      phase: 'confirmed', reason: 'confirmed_active_binding', probe_available: true, wechat_in_front: true,
      binding_id: '00000000-0000-4000-8000-000000000003', contact_id: contact };
    const encode = value => Buffer.from(JSON.stringify(value));
    assert.deepEqual(foregroundAcceptanceProjection(200, encode(value), contact), { phase: 'confirmed', reason: 'confirmed_active_binding',
      wechatInFront: true, probeAvailable: true, expectedContactMatched: true, hasBinding: true });
    for (const invalid of [{ ...value, contact_id: '00000000-0000-4000-8000-000000000004' },
      { ...value, summary: '不得保存的合成正文' }, { ...value, reason: '合成名字' },
      { ...value, wechat_in_front: false }, { ...value, contact_id: null }]) {
      assert.throws(() => foregroundAcceptanceProjection(200, encode(invalid), contact));
    }
    assert.throws(() => foregroundAcceptanceProjection(500, encode(value), contact));
    assert.throws(() => foregroundAcceptanceProjection(200, Buffer.alloc(4097), contact));
    const paused = { ...value, phase: 'paused', reason: 'wechat_not_in_front', wechat_in_front: false, binding_id: null, contact_id: null };
    assert.equal(foregroundAcceptanceProjection(200, encode(paused), contact).hasBinding, false);
  } finally { stop(); await rm(directory, { recursive: true, force: true }); }
});
