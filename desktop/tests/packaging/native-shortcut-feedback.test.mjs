import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(use) {
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-shortcut-receipt-'));
  try {
    const modulePath = path.join(owned, 'feedback.mjs');
    await build({ entryPoints: ['tests/native-shortcut-feedback.ts'], outfile: modulePath, bundle: true,
      platform: 'node', format: 'esm', logLevel: 'silent' });
    await use(await import(modulePath), path.join(owned, 'response.json'), owned);
  } finally { await rm(owned, { recursive: true, force: true }); }
}

test('只有显式现场模式启用，Agent与人工模式冲突时拒绝', async () => {
  await fixture(async ({ shortcutAcceptanceMode }) => {
    assert.equal(shortcutAcceptanceMode({}), undefined);
    assert.equal(shortcutAcceptanceMode({ NOTALONE_NATIVE_DESKTOP_ACCEPTANCE: '1' }), 'human');
    assert.equal(shortcutAcceptanceMode({ NOTALONE_AGENT_NATIVE_DESKTOP_ACCEPTANCE: '1' }), 'agent');
    assert.throws(() => shortcutAcceptanceMode({ NOTALONE_NATIVE_DESKTOP_ACCEPTANCE: '1',
      NOTALONE_AGENT_NATIVE_DESKTOP_ACCEPTANCE: '1' }), /native_shortcut_mode_conflict/);
  });
});

test('Agent实际操作收据不能冒充人工认可，旧nonce或否定观察均不通过', async () => {
  await fixture(async ({ readNativeShortcutReceipt }, response) => {
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'agent'), 'pending');
    await writeFile(response, JSON.stringify({ requestId: 'fresh', performed: true, observed: true }), { mode: 0o600 });
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'agent'), 'confirmed');
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'human'), 'invalid');
    assert.equal(await readNativeShortcutReceipt(response, 'old', 'agent'), 'invalid');
    await writeFile(response, JSON.stringify({ requestId: 'fresh', confirmed: true }));
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'human'), 'confirmed');
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'agent'), 'invalid');
    await writeFile(response, JSON.stringify({ requestId: 'fresh', performed: true, observed: false }));
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'agent'), 'rejected');
  });
});

test('收据额外字段、过大内容及符号链接拒绝，不输出外部资料', async () => {
  await fixture(async ({ readNativeShortcutReceipt }, response, owned) => {
    await writeFile(response, JSON.stringify({ requestId: 'fresh', performed: true, observed: true, extra: 'synthetic_private' }), { mode: 0o600 });
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'agent'), 'invalid');
    await writeFile(response, 'synthetic_private'.repeat(100));
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'agent'), 'invalid');
    await rm(response);
    const outside = path.join(owned, 'external'); await writeFile(outside, 'synthetic_private', { mode: 0o600 });
    await symlink(outside, response);
    assert.equal(await readNativeShortcutReceipt(response, 'fresh', 'agent'), 'invalid');
  });
});
