import { selectContact } from '../contact-picker-actions.mjs';
import { expect, type Browser, type Page } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import type { RewritePages } from '../rewrite-page-scenarios';
import { confirmHelperContact } from '../foreground-confirmation-actions';

const groupOn = (page: Page, number = 1) => page.getByRole('group', { name: `说法${number}消息组`, exact: true });
const editorOn = (page: Page, number = 1) => groupOn(page, number).getByRole('textbox');
async function saveEdit(page: Page, text: string, number = 1) {
  const editor = editorOn(page, number);
  await editor.fill(text);
  await expect(groupOn(page, number).getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
  await editor.blur();
  await expect(groupOn(page, number).getByText('修改版本 1', { exact: true })).toBeVisible();
  await expect(groupOn(page, number).getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
}
async function copyRequest(page: Page, number = 1, hideAfterCopy = false) {
  return page.evaluate(async ({ number, hideAfterCopy }) => {
    const state = await window.notalone.replies.getState();
    const view = state.candidateVersions!.items[number - 1];
    const version = view.history!.versions.find(item => item.versionId === view.displayVersionId)!;
    const turn = state.savedSession!.turns.find(item => item.turnId === view.history!.turnId)!;
    return { contactId: state.contactId!, scopeRevision: state.scopeRevision,
      replyRequestId: turn.reply!.replyRequestId, candidateId: view.candidateId,
      versionId: version.versionId, messageId: version.messages[0].messageId, hideAfterCopy };
  }, { number, hideAfterCopy });
}

// 操作系统复制边界由本轮宿主提供合成接收端，业务生成和快照仍经过真实 HTTP/PG。
async function copyCurrentCandidate({ manager, helper, rewriteBackend }: RewritePages, copiedTexts: string[]) {
  await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
  await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('只说明今天到不了，不增加其他承诺。');
  await rewriteBackend.plan({ count: 1, prefix: '复制原候选' });
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  const editor = editorOn(helper, 1);
  await expect(editor).toHaveValue('复制原候选（说法1）。');
  const edited = '今天确实到不了，下次时间再联系。';
  await saveEdit(helper, edited);
  await groupOn(helper).getByRole('button', { name: '复制第1条', exact: true }).click();
  await expect(helper.getByRole('status').filter({ hasText: '已复制第1条' })).toBeVisible();
  expect(copiedTexts).toEqual([edited]);
  await expect(editor).toHaveValue(edited);
  await groupOn(helper).getByRole('button', { name: '查看说法1上一版', exact: true }).click();
  await expect(editor).toHaveValue('复制原候选（说法1）。');
  await groupOn(helper).getByRole('button', { name: '查看说法1下一版', exact: true }).click();
  await expect(editor).toHaveValue(edited);
}

// 仅替换操作系统复制接收端；生成、编辑和版本保存保持生产路径。
export async function candidateCopy(browser: Browser, origin: string) {
  const copiedTexts: string[] = [];
  process.stdout.write('page_test_scenario: 当前编辑文本复制与原快照分离\n');
  await withRewritePages(browser, origin, async (pages) => {
    await copyCurrentCandidate(pages, copiedTexts);
  }, { async writeText(text) { copiedTexts.push(text); }, hideWindow() { throw new Error('单独复制不应收起。'); } });
  process.stdout.write('page_test_scenario_passed: 当前编辑文本复制与原快照分离\n');

  // 分别在页面复制与公开收起请求安排失败，验证编辑保留和成功之后才收起。
  const attempts: string[] = [];
  const completed: string[] = [];
  const actions: string[] = [];
  process.stdout.write('page_test_scenario: 复制失败保留编辑与重试成功后收起\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今天先这样，稍后再联系。');
    await rewriteBackend.plan({ count: 1, prefix: '失败后保留原候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    const editor = editorOn(helper, 1);
    await expect(editor).toHaveValue('失败后保留原候选（说法1）。');
    const edited = '我先处理眼前的事情，稍后再联系你。';
    await saveEdit(helper, edited);
    await groupOn(helper).getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect(helper.getByRole('alert')).toContainText('复制未确认，编辑文字仍保留，请重试。');
    await expect(editor).toHaveValue(edited);
    await expect(editor).toBeVisible();
    await expect(helper.getByText('合成系统原始错误不应回显。', { exact: true })).toHaveCount(0);
    await expect(helper.getByRole('status').filter({ hasText: '已复制第1条' })).toHaveCount(0);
    expect(attempts).toEqual([edited]);
    expect(completed).toEqual([]);
    expect(actions).toEqual([]);
    await groupOn(helper).getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '已复制第1条' })).toBeVisible();
    expect(attempts).toEqual([edited, edited]);
    expect(completed).toEqual([edited]);
    expect(actions).toEqual(['write-completed']);
    // 工作区逐条复制不收起；公开收起请求仍须等待实际写入成功。
    const request = await copyRequest(helper, 1, true);
    const copyFailure = await helper.evaluate(async (request) => {
      try { await window.notalone.candidateCopy.copy(request); return { outcome: 'accepted', message: '' }; }
      catch (error) { return { outcome: 'rejected', message: String(error) }; }
    }, request);
    expect(copyFailure.outcome).toBe('rejected');
    expect(copyFailure.message).not.toContain('合成系统原始错误');
    expect(attempts).toHaveLength(3);
    expect(completed).toEqual([edited]);
    expect(actions).toEqual(['write-completed']);
    await helper.evaluate(request => window.notalone.candidateCopy.copy(request), request);
    expect(attempts).toEqual([edited, edited, edited, edited]);
    expect(completed).toEqual([edited, edited]);
    expect(actions).toEqual(['write-completed', 'write-completed', 'hide']);
    await expect(editor).toHaveValue(edited);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  }, {
    async writeText(text) {
      attempts.push(text);
      if (attempts.length === 1 || attempts.length === 3) throw new Error('合成系统原始错误不应回显。');
      await Promise.resolve();
      completed.push(text); actions.push('write-completed');
    },
    hideWindow() { actions.push('hide'); },
  });
  process.stdout.write('page_test_scenario_passed: 复制失败保留编辑与重试成功后收起\n');

  const selectedCopies: string[] = [];
  process.stdout.write('page_test_scenario: 逐组复制当前版本且拒绝空白、错配身份与角色越界\n');
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('只说明稍后联系，不补充其他事情。');
    await rewriteBackend.plan({ count: 2, prefix: '双候选选择' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    const second = editorOn(helper, 2);
    await expect(second).toHaveValue('双候选选择（说法2）。');
    await saveEdit(helper, '第一条保留自己的编辑。');
    const edited = '我稍后再联系你，我们到时再说。';
    await saveEdit(helper, edited, 2);
    await groupOn(helper, 2).getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect(helper.getByRole('status').filter({ hasText: '已复制第1条' })).toBeVisible();
    expect(selectedCopies).toEqual([edited]);
    const request = await copyRequest(helper, 2);
    expect(await helper.evaluate(async ({ request, otherContact }) => {
      const state = await window.notalone.replies.getState();
      const invoke = window.notalone.candidateCopy.copy as (...args: unknown[]) => Promise<void>;
      const invalid = [[], [request, {}], [{ ...request, text: '不得直接指定任意正文。' }],
        [{ ...request, ownerId: crypto.randomUUID() }], [{ ...request, contactId: otherContact }],
        [{ ...request, scopeRevision: request.scopeRevision + 1 }],
        [{ ...request, candidateId: state.candidateVersions!.items[0].candidateId }]];
      const results: string[] = [];
      for (const args of invalid) {
        try { await invoke(...args); results.push('accepted'); } catch { results.push('rejected'); }
      }
      return results;
    }, { request, otherContact: rewriteBackend.data.contact_ids[1] })).toEqual(Array(7).fill('rejected'));
    expect(await manager.evaluate(async (request) => {
      try { await window.notalone.candidateCopy.copy(request); return 'accepted'; } catch { return 'rejected'; }
    }, request)).toBe('rejected');
    expect(await helper.evaluate(async (request) => {
      window.location.hash = '#manager';
      try { await window.notalone.candidateCopy.copy(request); return 'accepted'; }
      catch { return 'rejected'; } finally { window.location.hash = '#helper'; }
    }, request)).toBe('rejected');
    expect(selectedCopies).toEqual([edited]);
    await second.fill('   \n ');
    await expect(groupOn(helper, 2).getByRole('button', { name: '复制第1条', exact: true })).toBeDisabled();
    expect(await helper.evaluate(async (request) => {
      try { await window.notalone.candidateCopy.copy(request); return 'accepted'; } catch { return 'rejected'; }
    }, request)).toBe('rejected');
    expect(selectedCopies).toEqual([edited]);
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  }, { async writeText(text) { selectedCopies.push(text); }, hideWindow() { throw new Error('单独复制不应收起。'); } });
  process.stdout.write('page_test_scenario_passed: 逐组复制当前版本且拒绝空白、错配身份与角色越界\n');

  for (const copyAndHide of [false, true]) {
    const completedCopies: string[] = [];
    let releaseFirstCopy: (() => void) | undefined;
    let copyStarts = 0;
    let hidden = 0;
    let pendingCopy: Promise<string> | undefined;
    process.stdout.write(`page_test_scenario: ${copyAndHide ? '公开复制并收起' : '页面逐条复制'}期间切换联系人不污染新会话\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
      try {
        await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
        await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('甲的本次草稿。');
        await rewriteBackend.plan({ count: 1, prefix: '甲待复制候选' });
        await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        const editor = editorOn(helper, 1);
        await expect(editor).toHaveValue('甲待复制候选（说法1）。');
        await saveEdit(helper, '甲触发复制时的编辑文本。');
        if (copyAndHide) {
          const request = await copyRequest(helper, 1, true);
          pendingCopy = helper.evaluate(async (request) => {
            try { await window.notalone.candidateCopy.copy(request); return 'accepted'; } catch { return 'rejected'; }
          }, request);
        } else {
          await groupOn(helper).getByRole('button', { name: '复制第1条', exact: true }).click();
          await expect(groupOn(helper).getByRole('status').filter({ hasText: '正在复制…' })).toBeVisible();
        }
        await expect.poll(() => copyStarts).toBe(1);
        expect(completedCopies).toEqual([]);
        expect(hidden).toBe(0);
        await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人乙' });
        await confirmHelperContact(helper, rewriteBackend.data.contact_ids[1]);
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('乙的独立草稿。');
        await rewriteBackend.plan({ count: 1, prefix: '乙当前候选' });
        await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(editor).toHaveValue('乙当前候选（说法1）。');
        await editor.fill('乙继续保留自己的编辑文本。');
        releaseFirstCopy!();
        await expect.poll(() => completedCopies.length).toBe(1);
        if (pendingCopy) expect(await pendingCopy).toBe('rejected');
        await expect(helper.getByRole('status').filter({ hasText: '正在复制…' })).toHaveCount(0);
        await expect(helper.getByRole('status').filter({ hasText: '已复制第1条' })).toHaveCount(0);
        await expect(helper.getByRole('alert')).toHaveCount(0);
        await expect(editor).toHaveValue('乙继续保留自己的编辑文本。');
        expect(hidden).toBe(0);
        // 已触发的系统写入不推断为撤销；只验证旧结果不会收起或污染当前乙会话。
        expect(completedCopies).toEqual(['甲触发复制时的编辑文本。']);
        await editor.blur();
        await expect(groupOn(helper).getByText('修改版本 1', { exact: true })).toBeVisible();
        await groupOn(helper).getByRole('button', { name: '复制第1条', exact: true }).click();
        await expect(helper.getByRole('status').filter({ hasText: '已复制第1条' })).toBeVisible();
        expect(completedCopies).toEqual(['甲触发复制时的编辑文本。', '乙继续保留自己的编辑文本。']);
        expect(hidden).toBe(0);
        expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
      } finally { releaseFirstCopy?.(); await pendingCopy; }
    }, {
      async writeText(text) {
        copyStarts++;
        if (copyStarts === 1) await new Promise<void>((resolve) => { releaseFirstCopy = resolve; });
        completedCopies.push(text);
      },
      hideWindow() { hidden++; },
    });
    process.stdout.write(`page_test_scenario_passed: ${copyAndHide ? '公开复制并收起' : '页面逐条复制'}期间切换联系人不污染新会话\n`);
  }
}
