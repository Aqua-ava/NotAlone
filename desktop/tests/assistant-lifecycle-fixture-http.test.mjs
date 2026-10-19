import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { build } from 'esbuild';

test('生命周期夹具经生产同步宿主返回非微信暂停，重建后仍有效', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-lifecycle-http-'));
  try {
    const compiled = await build({ stdin: { contents:
      "export { withRewriteFixture } from './tests/rewrite-backend-fixture';",
    resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
    const modulePath = path.join(directory, 'fixture.mjs');
    await writeFile(modulePath, compiled.outputFiles[0].text);
    const { withRewriteFixture } = await import(modulePath);
    await withRewriteFixture('notalone-lifecycle-http-', async fixture => {
      for (let round = 0; round < 2; round++) {
        const observed = await fixture.request('/api/sync/foreground/observe', {});
        assert.equal(observed.status, 200);
        assert.equal(observed.data.phase, 'paused', JSON.stringify(observed.data));
        assert.equal(observed.data.wechat_in_front, false);
        assert.equal(observed.data.contact_id, null);
        assert.equal((await fixture.command('observations')).payloads.length, 0);
        if (round === 0) await fixture.command('restart');
      }
    }, undefined, path.resolve('tests/fixtures/assistant-lifecycle-backend.py'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
