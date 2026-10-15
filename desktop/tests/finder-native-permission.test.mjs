import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function ports(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-finder-native-pure-'));
  try {
    const output = path.join(directory, 'acceptance.mjs');
    await build({ entryPoints: ['tests/finder-native-permission-acceptance.spec.ts'], outfile: output,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: '仅登记Finder验收', setup(builder) {
        builder.onResolve({ filter: /^(\.\/app-test-gate|@playwright\/test)$/ },
          ({ path: request }) => ({ path: request, namespace: 'registration' }));
        builder.onLoad({ filter: /.*/, namespace: 'registration' }, ({ path: request }) => ({ contents:
          request === './app-test-gate' ? "export function verifyAppTestLease() { throw Error('禁止申请App'); }"
            : `export const test = Object.assign(() => {}, {
                skip(value) { globalThis.finderNativeSkipped = value; },
                use(value) { globalThis.finderNativeOptions = value; }
              });
              export function expect() { throw Error('禁止执行真实验收'); }`, loader: 'js' }));
      } }] });
    await run(await import(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Finder验收默认关闭且禁用截图、trace与video，仅显式本场开关可登记启用', async () => {
  const previous = process.env.NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE;
  try {
    delete process.env.NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE;
    await ports(() => {
      assert.equal(globalThis.finderNativeSkipped, true);
      assert.deepEqual(globalThis.finderNativeOptions, { trace: 'off', screenshot: 'off', video: 'off' });
    });
    process.env.NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE = '1';
    await ports(() => assert.equal(globalThis.finderNativeSkipped, false));
  } finally {
    if (previous === undefined) delete process.env.NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE;
    else process.env.NOTALONE_FINDER_NATIVE_PERMISSION_ACCEPTANCE = previous;
  }
});

test('Finder收据须匹配本场runId和阶段且全部明确true，未知字段不能冒充实际操作', async () => {
  await ports(({ acceptedFinderReceipt }) => {
    const receipt = { schemaVersion: 1, runId: 'this-run', stage: 'wechat',
      syncEnabled: true, managerHidden: true, wechatForeground: true };
    assert.equal(acceptedFinderReceipt(receipt, 'this-run', 'wechat'), true);
    assert.equal(acceptedFinderReceipt(receipt, 'previous-run', 'wechat'), false);
    assert.equal(acceptedFinderReceipt(receipt, 'this-run', 'quit'), false);
    assert.equal(acceptedFinderReceipt({ ...receipt, wechatForeground: false }, 'this-run', 'wechat'), false);
    assert.equal(acceptedFinderReceipt({ ...receipt, privateName: '合成禁入字段' }, 'this-run', 'wechat'), false);
    assert.equal(acceptedFinderReceipt(null, 'this-run', 'wechat'), false);
  });
});

test('缺正常退出收据、未知后端或任一存活资源时保留原备份、库与租约', async () => {
  await ports(({ finderCleanupAllowed }) => {
    const known = { normalQuitReceipt: true, appGone: true, backendKnown: true, backendGone: true,
      nativeGone: true, handshakeGone: true };
    assert.equal(finderCleanupAllowed(known), true);
    for (const key of Object.keys(known)) {
      assert.equal(finderCleanupAllowed({ ...known, [key]: false }), false, key);
      const missing = { ...known }; delete missing[key];
      assert.equal(finderCleanupAllowed(missing), false, key);
    }
  });
});

test('匿名进程采样只接纳本用户且父PID正确的包内native，旧session参数不冒充无视觉', async () => {
  await ports(({ finderNativeProcessSample, nativeProbeArgumentKind, notAloneProcessPids }) => {
    const paths = { probe: '/synthetic/NotAlone.app/Contents/Resources/notalone-probe/notalone-sync-probe',
      helper: '/synthetic/NotAlone.app/Contents/Resources/notalone-probe/notalone-header-change-source' };
    const raw = `11 10 501 ${paths.probe}\n12 9 501 ${paths.helper}\n13 99 501 ${paths.helper}\n14 9 502 ${paths.helper}\n`;
    assert.deepEqual(finderNativeProcessSample(raw, 501, paths, 9, 10), {
      probePids: [11], helperPids: [12], unownedNativePids: [13],
    });
    assert.deepEqual(notAloneProcessPids(raw, 501), [11, 12, 13]);
    assert.deepEqual(notAloneProcessPids('21 1 501 /synthetic/native/notalone-header-change-source\n22 1 501 /synthetic/Other.app/Contents/MacOS/Other\n', 501), [21]);
    assert.equal(nativeProbeArgumentKind(`${paths.probe} --session --json --minimal-region --single-frame`, paths.probe), 'single-frame');
    assert.equal(nativeProbeArgumentKind(`${paths.probe} --session --json`, paths.probe), 'legacy-session');
    assert.equal(nativeProbeArgumentKind(`${paths.probe} --foreground-status --json`, paths.probe), 'unknown');
    assert.equal(nativeProbeArgumentKind(`${paths.probe} --session --json --private-input forbidden`, paths.probe), 'unknown');
  });
});

test('Finder后端启动脚本只传本轮固定环境，保留真实Python参数且不运行服务', async () => {
  assert.equal(process.env.CONDA_DEFAULT_ENV, 'NotAlone', '合成Python检查须激活NotAlone');
  await ports(async ({ finderPythonBootstrap }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-finder-python-'));
    try {
      const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
      const script = path.join(directory, 'python');
      await writeFile(script, finderPythonBootstrap(python, { PATH: '/usr/bin:/bin',
        NOTALONE_DATABASE_URL: 'synthetic-owned-only', NOTALONE_DEEPSEEK_API_KEY: '' }), { mode: 0o700 });
      const result = await execute(script, ['-c', 'import json, os, sys; print(json.dumps({"database": os.environ.get("NOTALONE_DATABASE_URL"), "modelKeyEmpty": os.environ.get("NOTALONE_DEEPSEEK_API_KEY") == "", "secretInherited": "SYNTHETIC_PARENT_SECRET" in os.environ, "argument": sys.argv[1]}))', 'synthetic-argument'],
        { timeout: 10_000, env: { SYNTHETIC_PARENT_SECRET: 'must-not-cross', NOTALONE_DATABASE_URL: 'synthetic-wrong-parent' } });
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { database: 'synthetic-owned-only', modelKeyEmpty: true,
        secretInherited: false, argument: 'synthetic-argument' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
