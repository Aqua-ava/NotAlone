import { expect, type Browser } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import type { RewritePages } from '../rewrite-page-scenarios';
import { EvidenceHttpProxy } from '../evidence-http-proxy';
import { RewriteHttpProxy } from '../rewrite-http-proxy';
import { withControllerEnvironment, withRewriteBackend } from './backend-fixture';
import { PageHost } from './page-host';
import { spawn } from 'node:child_process';
import path from 'node:path';

type EvidencePages = RewritePages & { evidenceTransport: EvidenceHttpProxy };
async function withEvidencePages(browser: Browser, origin: string, use: (pages: EvidencePages) => Promise<void>) {
  await withRewriteBackend(async (rewriteBackend) => {
    const evidenceTransport = await EvidenceHttpProxy.attach(rewriteBackend.infoPath);
    try {
      const replyTransport = await RewriteHttpProxy.attach(rewriteBackend.infoPath);
      try { await withControllerEnvironment(rewriteBackend, async (userData) => {
        const host = new PageHost(await browser.newContext(), origin, userData);
        try {
          await host.backend.connect();
          const manager = await host.open('manager');
          const opened = manager.context().waitForEvent('page');
          await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
          await use({ manager, helper: await opened, rewriteBackend, replyTransport, evidenceTransport });
        } finally { evidenceTransport.release(); replyTransport.release(); await host.close(); }
      }); } finally { await replyTransport.close(); }
    } finally { await evidenceTransport.close(); }
  });
}

async function prepare(pages: RewritePages, contact: '甲' | '乙' = '甲', count = 1) {
  await pages.manager.getByRole('button', { name: `选择合成联系人${contact}`, exact: true }).click();
  await pages.helper.getByRole('textbox', { name: '草稿', exact: true }).fill(`${contact}的原始生成输入。`);
  await pages.rewriteBackend.plan({ count, prefix: `${contact}的依据候选` });
  const regenerate = pages.helper.getByRole('button', { name: '重新生成', exact: true });
  // 同场景第二轮必须显式建立新请求，不把正确的同键重放误当作新模型结果。
  await (await regenerate.count() ? regenerate : pages.helper.getByRole('button', { name: '生成候选', exact: true })).click();
  await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(`${contact}的依据候选（说法1）。`);
}
function loadPending(pages: RewritePages) {
  return pages.helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    await window.notalone.replies.loadEvidence({ contactId: state.contactId!, scopeRevision: state.scopeRevision,
      replyRequestId: state.result!.replyRequestId, candidateId: state.result!.candidates[0].original.candidateId });
    return 'completed';
  });
}

// 点击生产页面，经具名控制器读取真实 HTTP/PG 的生成快照；不读取 React 私有状态。
async function draftEvidence({ manager, helper, rewriteBackend }: RewritePages) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('这是本次明确输入的合成草稿。');
  await rewriteBackend.plan({ count: 1, prefix: '依据验收候选' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('依据验收候选（说法1）。');
  const evidence = helper.getByRole('region', { name: '候选1依据', exact: true });
  await expect(evidence).toHaveCount(0);
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(evidence.getByText('这是本次明确输入的合成草稿。', { exact: true })).toBeVisible();
  await expect(evidence.getByText('用户草稿', { exact: true })).toBeVisible();
  await expect(evidence.getByText('本候选已引用', { exact: true })).toBeVisible();
  await expect(evidence.getByText('来源时间未知', { exact: true })).toBeVisible();
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我修改的措辞不改生成依据。');
  await expect(evidence.getByText('这是本次明确输入的合成草稿。', { exact: true })).toBeVisible();
  await helper.getByRole('button', { name: '收起候选1依据', exact: true }).click();
  await expect(evidence).toHaveCount(0);
}

async function failures(pages: EvidencePages) {
  await prepare(pages);
  expect(pages.evidenceTransport.paths).toEqual([]);
  pages.evidenceTransport.fail = true;
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(pages.helper.getByRole('alert')).toContainText('本次依据读取失败');
  await expect(pages.helper.getByText('合成原始错误不得显示', { exact: false })).toHaveCount(0);
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('甲的原始生成输入。', { exact: true })).toHaveCount(0);
  pages.evidenceTransport.fail = false;
  await pages.helper.getByRole('button', { name: '重试候选1依据', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('甲的原始生成输入。', { exact: true })).toBeVisible();
  expect(pages.evidenceTransport.paths).toHaveLength(2);
  expect(pages.evidenceTransport.paths[1]).toBe(pages.evidenceTransport.paths[0]);
  await expect(pages.helper.getByRole('alert')).toHaveCount(0);
}

async function newInput(pages: EvidencePages) {
  await prepare(pages, '甲', 2);
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('甲的原始生成输入。', { exact: true })).toBeVisible();
  await pages.helper.getByRole('textbox', { name: '草稿', exact: true }).fill('后来更改的草稿。');
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('甲的原始生成输入。', { exact: true })).toBeVisible();
  await pages.helper.getByRole('button', { name: '展开候选2依据', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true })).toHaveCount(0);
  await expect(pages.helper.getByRole('region', { name: '候选2依据', exact: true }).getByText('本候选已引用', { exact: true })).toBeVisible();
  await pages.rewriteBackend.plan({ count: 1, prefix: '后来草稿候选' });
  await pages.helper.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('后来草稿候选（说法1）。');
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true })).toHaveCount(0);
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('后来更改的草稿。', { exact: true })).toBeVisible();
  expect(pages.evidenceTransport.paths.at(-1)).not.toBe(pages.evidenceTransport.paths[0]);
}

async function stale(pages: EvidencePages, change: 'contact' | 'connection' | 'generation') {
  for (const fail of [false, true]) {
    await prepare(pages);
    pages.evidenceTransport.fail = fail;
    pages.evidenceTransport.next = 'hold';
    const held = pages.evidenceTransport.heldCount;
    const pending = loadPending(pages);
    await expect.poll(() => pages.evidenceTransport.heldCount).toBe(held + 1);
    pages.evidenceTransport.fail = false;
    if (change === 'connection') {
      pages.replyTransport.failRuntime = true;
      await expect(pages.manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
      pages.replyTransport.failRuntime = false;
      await pages.manager.getByRole('button', { name: '重试连接', exact: true }).click();
      await prepare(pages, '乙');
    } else if (change === 'contact') await prepare(pages, '乙');
    else {
      await pages.rewriteBackend.plan({ count: 1, prefix: '新一轮生成' });
      await pages.helper.getByRole('button', { name: '重新生成', exact: true }).click();
      await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('新一轮生成（说法1）。');
    }
    pages.evidenceTransport.release();
    expect(await pending).toBe('completed');
    await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true })).toHaveCount(0);
    await expect(pages.helper.getByRole('alert')).toHaveCount(0);
    await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
    await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true }).getByText(change === 'generation' ? '甲的原始生成输入。' : '乙的原始生成输入。', { exact: true })).toBeVisible();
    await pages.helper.getByRole('button', { name: '收起候选1依据', exact: true }).click();
  }
}

async function parameterGuards(pages: EvidencePages) {
  await prepare(pages);
  const result = pages.replyTransport.results[0].data;
  const requestId = result.reply_request_id as string;
  expect((await pages.rewriteBackend.request(`/api/contacts/${pages.rewriteBackend.data.contact_ids[1]}/replies/${requestId}/evidence`)).status).toBe(404);
  expect((await pages.rewriteBackend.request(`/api/contacts/${pages.rewriteBackend.data.other_contact_id}/replies/${requestId}/evidence`)).status).toBe(404);
  // 以上真实 HTTP 越界读取只产生404；后续比较仅计具名桥接的拒绝。
  const paths = pages.evidenceTransport.paths.length;
  const denied = await pages.helper.evaluate(async ({ other, outside }) => {
    const state = await window.notalone.replies.getState();
    const scope = { contactId: state.contactId!, scopeRevision: state.scopeRevision,
      replyRequestId: state.result!.replyRequestId, candidateId: state.result!.candidates[0].original.candidateId };
    const invalid = [
      [{ ...scope, contactId: other }], [{ ...scope, contactId: outside }], [{ ...scope, scopeRevision: scope.scopeRevision - 1 }],
      [{ ...scope, ownerId: 'forbidden' }], [{ ...scope, url: 'https://invalid.example' }],
      [{ ...scope, replyRequestId: 'https://invalid.example' }], [{ ...scope, candidateId: outside }],
      [{ ...scope, replyRequestId: outside }], [{ ...scope }, {}], [{ ...scope, contactId: ` ${scope.contactId}` }],
    ];
    return Promise.all(invalid.map(async (args) => {
      try { await Reflect.apply(window.notalone.replies.loadEvidence, window.notalone.replies, args); return false; }
      catch { return true; }
    }));
  }, { other: pages.rewriteBackend.data.contact_ids[1], outside: pages.rewriteBackend.data.other_contact_id });
  expect(denied).toEqual(Array(10).fill(true));
  expect(pages.evidenceTransport.paths).toHaveLength(paths);
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(pages.helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('甲的原始生成输入。', { exact: true })).toBeVisible();
  const rejected = await pages.manager.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    try { await window.notalone.replies.loadEvidence({ contactId: state.contactId!, scopeRevision: state.scopeRevision,
      replyRequestId: state.result!.replyRequestId, candidateId: state.result!.candidates[0].original.candidateId }); return false; }
    catch { return true; }
  });
  expect(rejected).toBe(true);
}

// 只改变本轮自有合成快照；不以SQL查询作为验收，不证明来源删除任务15。
async function arrangeSnapshot(pages: RewritePages, operation: 'remove_request' | 'legacy_timing', requestId: string) {
  const fixture = pages.rewriteBackend;
  const child = spawn(fixture.pythonExecutable, [path.resolve('tests/fixtures/evidence-snapshot-arrangement.py')], {
    stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ...fixture.environment() },
  });
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }, 5000);
  const ended = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('本轮依据安排未启动。')));
    child.stdin!.once('error', () => reject(new Error('本轮依据安排输入未完成。')));
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('本轮依据安排未完成。')));
  });
  child.stdin!.end(JSON.stringify({ operation, database_url: fixture.data.database_url,
    owner_id: fixture.data.owner_id, contact_id: fixture.data.contact_ids[0], request_id: requestId }));
  try { await ended; } finally { clearTimeout(timer); }
}

async function removedEvidence(pages: EvidencePages) {
  await prepare(pages);
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  const region = pages.helper.getByRole('region', { name: '候选1依据', exact: true });
  await expect(region.getByText('甲的原始生成输入。', { exact: true })).toBeVisible();
  await pages.helper.getByRole('button', { name: '收起候选1依据', exact: true }).click();
  const requestId = pages.replyTransport.results[0].data.reply_request_id as string;
  await arrangeSnapshot(pages, 'remove_request', requestId);
  const endpoint = `/api/contacts/${pages.rewriteBackend.data.contact_ids[0]}/replies/${requestId}/evidence`;
  expect(await pages.rewriteBackend.request(endpoint)).toEqual({ status: 404, data: { error: 'not_found' } });
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(region.getByText('本次依据不存在或已删除，无法恢复原正文。', { exact: true })).toBeVisible();
  await expect(region.getByText('甲的原始生成输入。', { exact: true })).toHaveCount(0);
  await pages.helper.getByRole('button', { name: '收起候选1依据', exact: true }).click();
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(region.getByText('甲的原始生成输入。', { exact: true })).toHaveCount(0);
}

async function legacySnapshot(pages: EvidencePages) {
  await pages.manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await pages.helper.getByRole('button', { name: '回复', exact: true }).click();
  await pages.helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
  await pages.helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('只说明现在可以回复。');
  await pages.rewriteBackend.plan({ count: 1, prefix: '旧快照候选' });
  await pages.helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(pages.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('旧快照候选（说法1）。');
  const requestId = pages.replyTransport.results[0].data.reply_request_id as string;
  await arrangeSnapshot(pages, 'legacy_timing', requestId);
  await pages.helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  const region = pages.helper.getByRole('region', { name: '候选1依据', exact: true });
  await expect(region.getByText('甲的私密合成历史：今晚我会晚一点回复你。', { exact: true })).toBeVisible();
  await expect(region.getByText('来源时间未知', { exact: true })).toBeVisible();
  await expect(region.getByText('保存时间：未知', { exact: true })).toBeVisible();
  const current = await pages.rewriteBackend.request(`/api/contacts/${pages.rewriteBackend.data.contact_ids[0]}/messages`);
  expect((current.data.messages as Array<{ occurred_at: string | null }>)[0].occurred_at).not.toBeNull();
  // 当前消息有时间，但生成旧快照缺时间，页面仍保持未知。
  await expect(region.getByText('来源时间未知', { exact: true })).toBeVisible();
}

export async function replyEvidence(browser: Browser, origin: string) {
  process.stdout.write('page_test_scenario: 默认折叠与真实草稿依据快照\n');
  await withRewritePages(browser, origin, draftEvidence);
  process.stdout.write('page_test_scenario_passed: 默认折叠与真实草稿依据快照\n');
  const scenarios: Array<[string, (pages: EvidencePages) => Promise<void>]> = [
    ['安全失败、无正文残留与同请求重试', failures],
    ['候选关联、后来输入不倒填与重新生成折叠', newInput],
    ['换联系人后迟到成功与失败丢弃', (pages) => stale(pages, 'contact')],
    ['换连接后迟到成功与失败丢弃', (pages) => stale(pages, 'connection')],
    ['新生成后迟到成功与失败丢弃', (pages) => stale(pages, 'generation')],
    ['真实HTTP越界404及具名范围、字段和角色拒绝', parameterGuards],
    ['本轮原请求移除后真实404且不恢复已缓存正文', removedEvidence],
    ['旧快照缺时间时不从当前消息倒填', legacySnapshot],
  ];
  for (const [name, scenario] of scenarios) {
    process.stdout.write(`page_test_scenario: ${name}\n`);
    await withEvidencePages(browser, origin, scenario);
    process.stdout.write(`page_test_scenario_passed: ${name}\n`);
  }
}
