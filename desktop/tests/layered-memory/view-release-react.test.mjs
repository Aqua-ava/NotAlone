import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { fixture, payload } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

test('联系人React页面卸载发出释放，重入不复用旧读取', { timeout: 15000 }, async t => {
  let reads = 0, releases = 0;
  const f = await fixture(async request => {
    if (request.method === 'GET') reads++;
    return { generation: 1, data: request.path.includes('/layered-memory') ? payload()
      : request.path.endsWith('/memory-candidates') ? { candidates: [] }
      : request.path.endsWith('/sources') ? { sources: [] } : { memories: [] } };
  });
  const name = 'releaseLayeredMemory';
  const observing = { ...f, bridge: { ...f.bridge, [name]: async (...args) => { releases++; return f.bridge[name](...args); } } };
  await withMemoryPage(observing, t.signal, async page => {
    await expect.poll(() => reads).toBeGreaterThan(0);
    await page.evaluate(() => window.showMemory(false));
    await expect.poll(() => releases).toBe(1);
    const afterLeave = reads;
    f.controller.sourceDeletionChanged('started'); f.controller.sourceDeletionChanged('settled');
    await page.evaluate(() => window.showMemory(true));
    await expect.poll(() => reads).toBeGreaterThan(afterLeave);
    assert.equal(releases, 1);
    await page.evaluate(() => window.showMemory(false));
    await expect.poll(() => releases).toBe(2);
  });
});
