import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuarantineVault } from '../src/history/quarantine-vault.ts';
import { QuarantineViewer } from '../src/history/quarantine-viewer.ts';

const digest = 'c'.repeat(64);
const xss = '<img src=x onerror=alert(1)> ran 私人合成文字';
async function fixture(t, records = [xss, '第二条合成隔离文字']) {
  const base = await mkdtemp(join(tmpdir(), 'notalone-quarantine-viewer-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const vault = await QuarantineVault.create(join(base, 'vault'), { scopeDigest: digest, displayName: 'ran' });
  t.after(() => vault.close());
  vault.begin({ expectedPartitions: ['part-1'] });
  vault.appendPage(records.map((text, index) => ({ kind: 'text', text, status: '2', originalType: '1', sender: 'unknown', sentAt: null,
    partition: 'part-1', table: 'message-table-1', localId: String(index + 1), serverId: null })));
  vault.complete({ scopeDigest: digest, sourceContinuity: 'held', snapshotComplete: true, completedPartitions: ['part-1'] });
  const viewer = await QuarantineViewer.start(vault);
  t.after(() => viewer.close());
  return { vault, viewer };
}
function apiHeaders(viewer, origin = new URL(viewer.url).origin) {
  const token = new URL(viewer.url).hash.slice('#token='.length);
  return { Authorization: `Bearer ${token}`, Origin: origin };
}

test('本机查看器不预渲染正文，token仅在URL fragment，匿名或跨Origin请求被拒绝', async t => {
  const { viewer } = await fixture(t);
  const url = new URL(viewer.url);
  assert.equal(url.search, '');
  assert.match(url.hash, /^#token=[a-f0-9]{64}$/);
  const page = await fetch(viewer.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(html.includes(xss), false);
  assert.match(html, /textContent/);
  assert.match(html, /本次快照期间守卫有效/);
  assert.match(html, /本次快照失证/);
  assert.match(html, /载入更多记录/);
  assert.doesNotMatch(html, /window\.confirm/);
  assert.match(html, /确认删除这条隔离文字/);
  assert.match(html, /确认删除全部隔离文字/);
  assert.match(html, /await load\(true, true\)/);
  assert.equal(html.includes('innerHTML'), false);

  const anonymous = await fetch(`${url.origin}/api/records`);
  assert.equal(anonymous.status, 401);
  const crossOrigin = await fetch(`${url.origin}/api/records`, { headers: apiHeaders(viewer, 'http://attacker.invalid') });
  assert.equal(crossOrigin.status, 403);
});

test('查看器只按页列出未核验记录，并在Origin守卫下删除单条或全部', async t => {
  const { vault, viewer } = await fixture(t);
  const origin = new URL(viewer.url).origin;
  const headers = apiHeaders(viewer);

  const deniedDelete = await fetch(`${origin}/api/records`, { method: 'DELETE', headers: { Authorization: headers.Authorization } });
  assert.equal(deniedDelete.status, 403);

  const response = await fetch(`${origin}/api/records?limit=1`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.json();
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].text, '第二条合成隔离文字');
  assert.equal(page.records[0].state, 'unverified');
  assert.equal(page.status.normalHistory, false);
  assert.ok(page.nextCursor);

  const next = await fetch(`${origin}/api/records?limit=1&after=${encodeURIComponent(page.nextCursor)}`, { headers });
  assert.equal((await next.json()).records[0].text, xss);
  const deleteOne = await fetch(`${origin}/api/records/${page.records[0].id}`, { method: 'DELETE', headers });
  assert.equal(deleteOne.status, 200);
  assert.equal(vault.summary().recordCount, 1);

  const deleteAll = await fetch(`${origin}/api/records`, { method: 'DELETE', headers });
  assert.equal(deleteAll.status, 200);
  assert.equal((await deleteAll.json()).deleted, 1);
  assert.equal(vault.summary().recordCount, 0);
});

test('Host不匹配的本机请求不读取隔离文字', async t => {
  const { viewer } = await fixture(t);
  const url = new URL(viewer.url);
  const response = await new Promise(resolve => {
    const request = httpRequest({ host: '127.0.0.1', port: Number(url.port), path: '/api/records', method: 'GET',
      headers: { ...apiHeaders(viewer), Host: '127.0.0.1:1' } }, result => {
      result.resume(); result.on('end', () => resolve(result.statusCode));
    });
    request.end();
  });
  assert.equal(response, 403);
});
