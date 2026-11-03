import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function mount(t, topSpace = 24) {
  const bundle = await build({ entryPoints: ['tests/fixtures/contact-chat-timeline.tsx'], bundle: true, platform: 'browser',
    format: 'iife', jsx: 'automatic', write: false, outdir: 'timeline-view', logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 850, height: 900 }, timezoneId: 'Asia/Taipei' });
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:${topSpace}px 24px 24px;font-family:sans-serif}:root{--panel-border:#c4d3d6;--panel-radius:12px;--panel-background:#fffdf5;--panel-heading:#354d59}</style><div id="root"></div>`);
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  await expect(page.locator('[data-message-id]')).toHaveCount(40);
  return page;
}
const bottomGap = page => page.locator('.contact-chat-body').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
const offset = (page, id) => page.locator(`[data-message-id="${id}"]`).evaluate(element => element.getBoundingClientRect().top - element.closest('.contact-chat-body').getBoundingClientRect().top);

test('微信式时间线：正序、分段时间、消息详情及紧凑左右气泡', async t => {
  const page = await mount(t, 360);
  assert.equal(await page.locator('[data-message-id]').first().getAttribute('data-message-id'), 'm1');
  assert.equal(await page.locator('[data-message-id]').last().getAttribute('data-message-id'), 'm40');
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  assert.ok(await page.locator('[data-message-id="m40"]').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight));
  await expect(page.getByRole('heading', { name: '合成联系人甲' })).toBeVisible();
  await expect(page.locator('.contact-chat-time')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '刷新记录' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试加载聊天' })).toHaveCount(0);
  const own = page.locator('[data-message-id="m39"]');
  const other = page.locator('[data-message-id="m40"]');
  assert.ok((await own.locator('.contact-chat-bubble').boundingBox()).x > (await other.locator('.contact-chat-bubble').boundingBox()).x);
  assert.ok((await own.locator('.contact-chat-bubble').boundingBox()).height < 45);
  await own.getByLabel('消息详情', { exact: true }).click();
  await expect(own.locator('.contact-chat-meta')).toContainText('我');
  await expect(own.locator('.contact-chat-meta time')).toHaveAttribute('datetime', '2026-11-02T16:17:30.000Z');
  await page.evaluate(() => window.replaceRows([
    { messageId: 'latest', speaker: 'contact', text: '跨间隔后的消息', messageType: 'text', occurredAt: '2026-11-03T01:10:00Z', ordering: 'verified' },
    { messageId: 'tie2', speaker: 'user', text: '同时间第二条', messageType: 'text', occurredAt: '2026-11-03T01:00:00Z', ordering: 'unknown' },
    { messageId: 'tie1', speaker: 'contact', text: '同时间第一条', messageType: 'text', occurredAt: '2026-11-03T01:00:00Z', ordering: 'unknown' },
    { messageId: 'unknown', speaker: 'system', text: '合成系统消息', messageType: 'text', occurredAt: null, ordering: 'unknown' },
  ]));
  await expect(page.locator('[data-message-id]')).toHaveCount(4);
  assert.deepEqual(await page.locator('[data-message-id]').evaluateAll(rows => rows.map(row => row.dataset.messageId)), ['unknown', 'tie1', 'tie2', 'latest']);
  await expect(page.locator('.contact-chat-time')).toHaveCount(3);
  await expect(page.locator('.contact-chat-time').first()).toHaveText('时间未知');
  await expect(page.locator('[data-speaker="system"] .contact-chat-avatar')).toHaveCount(0);
  await expect(page.locator('.contact-chat-order > summary')).toHaveText('部分顺序未核验');
  await page.locator('.contact-chat-order > summary').click();
  await expect(page.getByText('按消息时间展示；同一时间或时间未知的消息先后未核验。')).toBeVisible();
  await page.setViewportSize({ width: 380, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('历史分页保持锚点，增量与异步内容不打断阅读，回到最新和切换正确定位', async t => {
  const page = await mount(t);
  await page.locator('.contact-chat-body').evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByRole('button', { name: '回到最新' })).toBeVisible();
  const before = await offset(page, 'm1');
  await page.getByRole('button', { name: '加载更早记录' }).click();
  await expect(page.getByRole('status')).toContainText('正在读取');
  await page.evaluate(() => window.completeOlder());
  await expect(page.locator('[data-message-id]')).toHaveCount(50);
  await expect.poll(async () => Math.abs(await offset(page, 'm1') - before)).toBeLessThan(2);
  await page.evaluate(() => window.addMessage());
  await expect(page.locator('[data-message-id]')).toHaveCount(51);
  await expect.poll(async () => Math.abs(await offset(page, 'm1') - before)).toBeLessThan(2);
  await page.locator('[data-message-id="m-5"] .contact-chat-bubble').evaluate(element => { element.style.height = '280px'; });
  await expect.poll(async () => Math.abs(await offset(page, 'm1') - before)).toBeLessThan(2);
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  await page.evaluate(() => window.addMessage());
  await expect(page.locator('[data-message-id]')).toHaveCount(52);
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  await page.locator('[data-message-id="m41"] .contact-chat-bubble').evaluate(element => { element.style.height = '160px'; });
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  await page.locator('.contact-chat-body').evaluate(element => { element.scrollTop = 100; });
  await page.getByRole('button', { name: '回到最新' }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(52);
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
  await page.getByLabel('聊天选项', { exact: true }).click();
  await page.getByRole('button', { name: '同步与资料', exact: true }).click();
  await expect(page.getByText('合成资料设置')).toBeVisible();
  await page.evaluate(() => window.selectOther());
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await expect(page.getByText('合成资料设置')).toBeHidden();
  await page.evaluate(() => window.publishOld());
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await page.evaluate(() => window.publishOther());
  await expect(page.getByText('乙的合成消息')).toBeVisible();
  await expect(page.locator('[data-message-id]')).toHaveCount(1);
  await expect.poll(() => bottomGap(page)).toBeLessThan(2);
});
