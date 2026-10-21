import { selectContact } from '../contact-picker-actions.mjs';
import { setWorkspaceContext } from '../workspace-actions';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { expect, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { withRewriteFixture, type RewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';
import { MessageEventHttpProxy } from '../message-event-http-proxy';

export type EventPages = { manager: Page; helper: Page; fixture: RewriteFixture; transport: MessageEventHttpProxy;
  awaitPendingCommands: () => Promise<void> };
// 直接连接生产认证 HTTP/SSE；不能使用等待响应结束的改写代理。
export async function withEventPages(browser: Browser, origin: string, use: (pages: EventPages) => Promise<void>) {
  const released = ownResource();
  await withRewriteFixture('notalone-headless-message-events-', async (fixture) => {
    const transport = await MessageEventHttpProxy.attach(fixture.infoPath);
    try { await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        const manager = await host.open('manager');
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        await use({ manager, helper: await opened, fixture, transport,
          awaitPendingCommands: () => host.awaitPendingCommands() });
      } finally {
        transport.release(); await host.close();
        // 先确认自有夹具收尾并保留精确归属，再由通用生命周期幂等核验和移除目录。
        await fixture.cleanup();
        const evidence = path.resolve('artifacts/headless-pages/message-events-owned');
        await mkdir(evidence, { recursive: true });
        for (const suffix of ['database-ownership', 'owned']) {
          await copyFile(path.join(fixture.directory, suffix === 'database-ownership'
            ? 'database-ownership.json' : 'message-events-owned.json'),
            path.join(evidence, `${fixture.data.owner_id}-${suffix}.json`));
        }
      }
    }); } finally { await transport.close(); }
  }, released, path.resolve('tests/fixtures/message-events-backend.py'), path.resolve('..'),
  'database-ownership.json');
}
async function generateAndWait(pages: EventPages) {
  const before = await pages.helper.evaluate(() => window.notalone.replies.getState());
  const requestKeys = before.generationJobs?.map(job => job.requestKey) ?? [];
  await pages.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  // 页面先提交 options 再发 generate；等新任务实际登记后，才能等待其具名命令结算。
  await expect.poll(() => pages.helper.evaluate(async ({ contactId, requestKeys }) => {
    const state = await window.notalone.replies.getState();
    return state.generationJobs?.some(job => job.contactId === contactId && !requestKeys.includes(job.requestKey)) ?? false;
  }, { contactId: before.contactId, requestKeys })).toBe(true);
  await pages.awaitPendingCommands();
}
async function prepare(pages: EventPages, contact: '甲' | '乙' = '甲') {
  const { manager, helper, fixture } = pages;
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: `合成联系人${contact}` });
  await confirmHelperContact(helper, fixture.data.contact_ids[contact === '甲' ? 0 : 1]);
  await setWorkspaceContext(helper, true);
  await expect(helper.getByRole('checkbox', { name: new RegExp(`${contact}的原始合成消息`) })).toBeChecked();
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('说明原时间安排。');
  await fixture.plan({ count: 1, prefix: `${contact}原快照候选` });
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  try {
    // 页面点击返回不代表认证 HTTP 生成与后续会话核验已经完成。
    await generateAndWait(pages);
    const completed = await helper.evaluate(() => window.notalone.replies.getState());
    expect({ phase: completed.phase, errorCode: completed.errorCode ?? null }).toEqual({ phase: 'ready', errorCode: null });
    await expect(editor).toHaveValue(`${contact}原快照候选（说法1）。`);
  }
  catch (error) {
    const state = await helper.evaluate(async () => {
      const reply = await window.notalone.replies.getState();
      const foreground = await window.notalone.foreground.getState();
      return { phase: reply.phase, errorCode: reply.errorCode ?? null,
        generationBlock: reply.generationBlock, explorationPhase: reply.exploration.phase,
        hasExplorationResult: Boolean(reply.exploration.result), candidateCount: reply.result?.candidates.length ?? 0,
        foregroundPhase: foreground.phase, foregroundConfirmation: foreground.confirmation,
        foregroundBlock: foreground.generationBlock };
    });
    process.stderr.write(`page_test_prepare_failure: ${JSON.stringify({ ...state,
      model: await fixture.command('model_status') })}\n`);
    throw error;
  }
  await editor.fill('用户仍在编辑的措辞。');
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState())
    .candidateDrafts?.[0]?.messages[0].text)).toBe('用户仍在编辑的措辞。');
  const requestId = await helper.evaluate(async () => (await window.notalone.replies.getState()).result!.replyRequestId);
  const endpoint = `/api/contacts/${fixture.data.contact_ids[contact === '甲' ? 0 : 1]}/replies/${requestId}/evidence`;
  const before = await fixture.request(endpoint);
  expect(before.status).toBe(200);
  await expect(helper.getByRole('status').filter({ hasText: '新消息提醒已连接' })).toBeVisible();
  return { editor, endpoint, before };
}
async function newMessage(pages: EventPages) {
  const { helper, fixture } = pages;
  const { editor, endpoint, before } = await prepare(pages);
  await fixture.command('append_message');
  await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息，生成依据仍是原快照' })).toBeVisible();
  await expect(helper.getByRole('checkbox', { name: /甲的新合成消息/ })).toBeVisible();
  await expect(helper.getByRole('checkbox', { name: /甲的原始合成消息/ })).toBeChecked();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('说明原时间安排。');
  await expect(editor).toHaveValue('用户仍在编辑的措辞。');
  expect((await fixture.request(endpoint)).data).toEqual(before.data);
  expect((await fixture.command('observations')).model_calls).toBe(1);
}
async function streamRecovery(pages: EventPages) {
  const { helper, fixture } = pages;
  const { editor, endpoint, before } = await prepare(pages);
  await fixture.command('disconnect_stream');
  await expect(helper.getByRole('status').filter({ hasText: '消息提醒已中断' })).toBeVisible();
  await fixture.command('append_message');
  await expect(editor).toHaveValue('用户仍在编辑的措辞。');
  await helper.getByRole('button', { name: '重连消息提醒', exact: true }).click();
  await expect(helper.getByRole('checkbox', { name: /甲的新合成消息/ })).toBeVisible();
  await expect(helper.getByRole('checkbox', { name: /甲的原始合成消息/ })).toBeChecked();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('说明原时间安排。');
  await expect(editor).toHaveValue('用户仍在编辑的措辞。');
  expect((await fixture.request(endpoint)).data).toEqual(before.data);
  expect((await fixture.command('observations')).model_calls).toBe(1);
}
async function pagedBurst(pages: EventPages) {
  const { helper, fixture } = pages;
  const { editor, endpoint, before } = await prepare(pages);
  const messages = helper.getByRole('group', { name: '最近聊天材料', exact: true });
  await fixture.command('append_paged_burst');
  const projection = await fixture.request(`/api/contacts/${fixture.data.contact_ids[0]}/messages?limit=100`);
  expect(projection.status).toBe(200);
  type Message = { message_id: string; text: string; occurred_at: string };
  const allMessages = projection.data.messages as Message[];
  const expectedAll = [...Array.from({ length: 25 }, (_, index) =>
    `甲的分页突发消息：第${String(25 - index).padStart(2, '0')}条近况更新。`), '甲的原始合成消息。'];
  expect(allMessages.map(message => message.text)).toEqual(expectedAll);
  expect(projection.data.next_cursor).toBeNull();
  const firstPage = await fixture.request(`/api/contacts/${fixture.data.contact_ids[0]}/messages?limit=20`);
  expect(firstPage.status).toBe(200);
  expect(firstPage.data.messages).toHaveLength(20);
  expect(firstPage.data.next_cursor).toEqual(expect.any(String));
  const secondPage = await fixture.request(`/api/contacts/${fixture.data.contact_ids[0]}/messages?limit=20&before=${firstPage.data.next_cursor}`);
  expect(secondPage.status).toBe(200);
  expect(secondPage.data.messages).toHaveLength(6);
  expect(secondPage.data.next_cursor).toBeNull();
  expect([...(firstPage.data.messages as Message[]), ...(secondPage.data.messages as Message[])])
    .toEqual(allMessages);
  const burst = allMessages.filter((message) => message.text.startsWith('甲的分页突发消息：'));
  expect(burst).toHaveLength(25);
  expect(new Set(burst.map((message) => message.occurred_at.slice(0, 19))).size).toBe(1);
  expect(new Set(burst.map((message) => message.occurred_at)).size).toBe(25);
  expect(new Set(burst.map((message) => Date.parse(message.occurred_at))).size).toBe(1);
  for (let index = 1; index < burst.length; index++) {
    expect(burst[index - 1].occurred_at > burst[index].occurred_at).toBe(true);
    expect(burst[index - 1].message_id < burst[index].message_id).toBe(true);
  }
  await expect(messages.getByRole('checkbox', { name: /甲的分页突发消息：第25条/ })).toBeVisible();
  // 新消息合并最近20条并保留已加载的原消息；完整分页顺序由同范围真实HTTP投影核验。
  await expect(messages.getByRole('checkbox')).toHaveCount(21);
  const expected = Array.from({ length: 20 }, (_, index) =>
    `甲的分页突发消息：第${String(25 - index).padStart(2, '0')}条近况更新。`);
  expected.push('甲的原始合成消息。');
  const labels = await messages.locator('label').allTextContents();
  for (const [index, text] of expected.entries()) expect(labels[index]).toContain(text);
  await expect(messages.getByRole('checkbox', { checked: true })).toHaveCount(21);
  await expect(messages.getByRole('checkbox', { name: /甲的原始合成消息/ })).toBeChecked();
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('说明原时间安排。');
  await expect(editor).toHaveValue('用户仍在编辑的措辞。');
  expect((await fixture.request(endpoint)).data).toEqual(before.data);
  expect((await fixture.command('observations')).model_calls).toBe(1);
}
async function staleNotice(pages: EventPages, change: 'contact' | 'connection') {
  const { manager, helper, fixture, transport } = pages;
  await prepare(pages);
  transport.holdNextMessages = true;
  await fixture.command('append_message');
  await expect.poll(() => transport.heldCount).toBe(1);
  if (change === 'connection') {
    await fixture.command('restart');
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
    await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  }
  const { editor, endpoint, before } = await prepare(pages, '乙');
  transport.release();
  await expect(editor).toHaveValue('用户仍在编辑的措辞。');
  const state = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(state.messageNotice.changed).toBe(false);
  expect(state.contactId).toBe(fixture.data.contact_ids[1]);
  await fixture.command('append_other_contact');
  await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  expect((await fixture.request(endpoint)).data).toEqual(before.data);
  expect((await fixture.command('observations')).model_calls).toBe(2);
}
async function scopeAndRegeneration(pages: EventPages) {
  const { helper, fixture, transport, manager } = pages;
  const { editor, endpoint, before } = await prepare(pages);
  const paths = transport.messagePaths.length;
  await fixture.command('append_other_contact');
  await fixture.command('append_other_owner');
  // 错误帧声称当前范围，但真实消息ID属于另一owner；必须经过真实投影核验。
  transport.holdNextMessages = true;
  await fixture.command('publish_foreign_id');
  await expect.poll(() => transport.heldCount).toBe(1);
  transport.release();
  await fixture.command('append_message');
  await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
  expect(transport.messagePaths.slice(paths)).toHaveLength(2);
  expect(transport.messagePaths.slice(paths).every((value) => value === `/api/contacts/${fixture.data.contact_ids[0]}/messages?limit=20`)).toBe(true);
  await expect(editor).toHaveValue('用户仍在编辑的措辞。');
  const notice = await helper.evaluate(async () => (await window.notalone.replies.getState()).messageNotice);
  expect(Object.keys(notice).sort()).toEqual(['changed', 'needsRefresh', 'phase']);
  const denied = await helper.evaluate(async ({ other }) => {
    const state = await window.notalone.replies.getState();
    const selection = { contactId: state.contactId!, scopeRevision: state.scopeRevision };
    const invalid = [[{ ...selection, contactId: other }], [{ ...selection, scopeRevision: state.scopeRevision - 1 }],
      [{ ...selection, url: 'https://invalid.example' }], [{ ...selection, ownerId: 'forbidden' }],
      [{ ...selection, contactId: ` ${selection.contactId}` }], [selection, {}]];
    return Promise.all(invalid.map(async (args) => {
      try { await Reflect.apply(window.notalone.replies.reconnectMessages, window.notalone.replies, args); return false; }
      catch { return true; }
    }));
  }, { other: fixture.data.contact_ids[1] });
  expect(denied).toEqual(Array(6).fill(true));
  expect(await manager.evaluate(async () => {
    const contacts = await window.notalone.contacts.getState();
    try { await window.notalone.replies.reconnectMessages({ contactId: contacts.selectedContactId!, scopeRevision: contacts.scopeRevision }); return 'accepted'; }
    catch { return 'rejected'; }
  })).toBe('rejected');
  await helper.getByRole('button', { name: '刷新最近聊天', exact: true }).click();
  const target = helper.getByRole('checkbox', { name: /甲的新合成消息/ });
  await target.check(); await expect(target).toBeChecked();
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('根据新时间安排表达。');
  await fixture.plan({ count: 1, prefix: '新请求候选' });
  await generateAndWait(pages);
  const regenerated = await helper.evaluate(() => window.notalone.replies.getState());
  expect({ phase: regenerated.phase, errorCode: regenerated.errorCode ?? null }).toEqual({ phase: 'ready', errorCode: null });
  await expect(editor).toHaveValue('新请求候选（说法1）。');
  const next = await helper.evaluate(async () => (await window.notalone.replies.getState()).result!.replyRequestId);
  expect(endpoint.endsWith(`/${next}/evidence`)).toBe(false);
  expect((await fixture.request(endpoint)).data).toEqual(before.data);
  const evidence = await fixture.request(`/api/contacts/${fixture.data.contact_ids[0]}/replies/${next}/evidence`);
  expect(evidence.status).toBe(200);
  expect(JSON.stringify(evidence.data)).toContain('甲的新合成消息：时间安排更新。');
  expect((await fixture.command('observations')).model_calls).toBe(2);
}
export async function messageEvents(browser: Browser, origin: string) {
  for (const [name, scenario] of [
    ['真实新消息自动更新列表且保留选择、编辑和依据快照', newMessage],
    ['真实断流后重连自动恢复最新消息且保留选择、编辑和依据', streamRecovery],
    ['超过一页的新消息合并最近20条与原选择，真实分页无缺口且保留编辑和依据', pagedBurst],
    ['联系人切换后迟到消息核验失效', (pages: EventPages) => staleNotice(pages, 'contact')],
    ['认证连接更换后迟到消息核验失效', (pages: EventPages) => staleNotice(pages, 'connection')],
    ['owner/contact投影、具名角色字段与新请求保留旧依据', scopeAndRegeneration],
  ] as const) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEventPages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
