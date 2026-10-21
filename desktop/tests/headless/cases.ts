import { selectContact } from '../contact-picker-actions.mjs';
import { setWorkspaceContext } from '../workspace-actions';
import { selectMemoryCategory } from '../memory-page-actions';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { expect, type Browser } from '@playwright/test';
import { PageHost } from './page-host';
import { withControllerEnvironment, withMemoryBackend, withRewriteBackend } from './backend-fixture';
import { RewriteHttpProxy } from '../rewrite-http-proxy';

export async function memoryReading(browser: Browser, origin: string) {
  await withMemoryBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '联系人记忆');
      const contact = manager.getByRole('region', { name: '联系人记忆' });
      const automatic = contact.getByRole('article').filter({ has: manager.getByText('甲喜欢合成茉莉茶。', { exact: true }) });
      await expect(automatic.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
      await expect(automatic.getByText('系统记下 · 可移除', { exact: true })).toBeVisible();
      await expect(contact.getByText('甲的新版本关系备注。', { exact: true })).toBeVisible();
      await expect(contact.getByText('旧版关系备注。', { exact: true })).toHaveCount(0);
      await expect(manager.getByText('另一用户的本人资料。', { exact: true })).toHaveCount(0);
      await expect(manager.getByText('查看摘要', { exact: true })).toHaveCount(0);
      await expect(manager.getByRole('region', { name: '主题资料', exact: true })).toHaveCount(0);
      await manager.screenshot({ path: 'artifacts/headless-pages/memory-reading.png' });
      await selectMemoryCategory(manager, '待确认候选');
      await expect(manager.getByText('尚未记住', { exact: true })).toHaveCount(3);
      await expect(manager.getByRole('region', { name: '记忆处理状态', exact: true })).toHaveCount(0);
      await manager.screenshot({ path: 'artifacts/headless-pages/memory-pending.png' });
      await selectMemoryCategory(manager, '联系人记忆');
      await automatic.getByRole('button', { name: '查看来源与版本：甲喜欢合成茉莉茶。' }).click();
      await expect(automatic.getByText(`来源引用：${fixture.data.direct_message_id}`, { exact: true })).toBeVisible();
      await selectContact(manager.getByRole('combobox', { name: '本次联系人' }), fixture.data.contact_ids[1]);
      await selectMemoryCategory(manager, '联系人记忆');
      await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
      await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
      await selectMemoryCategory(manager, '本人记忆');
      await expect(manager.getByText('还没有记住你和这位联系人交流中的事。', { exact: true })).toBeVisible();
      await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toHaveCount(0);
      await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true })).toBeVisible();
      await selectMemoryCategory(manager, '联系人记忆');
      await selectContact(manager.getByRole('combobox', { name: '本次联系人' }), fixture.data.empty_contact_id);
      await selectMemoryCategory(manager, '联系人记忆');
      await expect(manager.getByText('还没有记住关于对方的事。', { exact: true })).toBeVisible();
      const denied = await manager.evaluate(async (outsideContactId) => {
        const current = await window.notalone.contacts.getState();
        const invalid = [
          { contactId: outsideContactId, scopeRevision: current.scopeRevision },
          { contactId: current.selectedContactId, scopeRevision: current.scopeRevision - 1 },
          { contactId: current.selectedContactId, scopeRevision: current.scopeRevision, role: 'manager' },
          { contactId: current.selectedContactId, scopeRevision: current.scopeRevision, section: 'http' },
        ];
        return Promise.all(invalid.map(async (value) => {
          try { await window.notalone.memory.refresh(value as Parameters<typeof window.notalone.memory.refresh>[0]); return false; } catch { return true; }
        }));
      }, fixture.data.other_contact_id);
      expect(denied).toEqual([true, true, true, true]);
      expect(await manager.evaluate(() => Object.keys(window.notalone.memory).sort())).toEqual(['add', 'addOwnerMemory', 'applyCandidateUpdate', 'cancelProcessingRead', 'confirmCandidate', 'correct', 'correctOwnerMemory', 'deleteOwnerMemory', 'discardCandidate', 'getOwnerLayeredMemoryState', 'getState', 'manageLayeredMemory', 'manageOwnerLayeredMemory', 'onOwnerLayeredMemoryChanged', 'onStateChanged', 'openVersions', 'readLayeredMemory', 'readOwnerLayeredMemory', 'readOwnerMemories', 'readProcessing', 'refresh', 'refreshOverview', 'refreshOwnerOverview', 'refreshProcessingResults', 'remove', 'resumeProcessing', 'revertAutoUpdate']);
      expect(await manager.evaluate(async () => {
        const current = await window.notalone.contacts.getState();
        try { await window.notalone.replies.generate({ contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, newRequest: true }); return false; }
        catch { return true; }
      })).toBe(true);
      expect(await manager.evaluate(async () => {
        window.location.hash = '#helper';
        try { await window.notalone.contacts.getState(); return false; }
        catch { return true; } finally { window.location.hash = '#manager'; }
      })).toBe(true);
    } finally { await host.close(); }
  }));
}

export async function draftRewrite(browser: Browser, origin: string) {
  await withRewriteBackend(async (fixture) => {
    const proxy = await RewriteHttpProxy.attach(fixture.infoPath);
    try { await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        const manager = await host.open('manager');
        const nextPage = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        const helper = await nextPage;
        await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
        await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人甲' });
        await confirmHelperContact(helper, fixture.data.contact_ids[0]);
        await setWorkspaceContext(helper, false);
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('今晚我会晚一点回复你。');
        await fixture.plan({ count: 2 });
        await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
        await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我今晚忙完再回复你。');
        await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).blur();
        await helper.getByRole('button', { name: '查看说法1上一版', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
        await helper.getByRole('button', { name: '查看说法1下一版', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我今晚忙完再回复你。');
        await expect(helper.getByRole('textbox', { name: '候选2编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法2）。');
        await helper.screenshot({ path: 'artifacts/headless-pages/draft-candidates.png' });
        const observations = await fixture.command('observations');
        expect(observations.payloads).toHaveLength(1);
        expect((observations.payloads as unknown[])[0]).toMatchObject({ draft_text: '今晚我会晚一点回复你。', include_relationship_context: false });
        expect(observations.tool_names).toEqual(['read_file', 'ReplyRuntimeOutput']);
        proxy.nextReply = 'hold';
        await fixture.plan({ count: 1, prefix: '迟到的甲候选' });
        // 本次迟到操作保留公开具名 Promise；完成后才核验新范围，避免收尾取消掩盖串人。
        const pendingGeneration = helper.evaluate(async () => {
          const current = await window.notalone.contacts.getState();
          try {
            await window.notalone.replies.generate({ contactId: current.selectedContactId!, scopeRevision: current.scopeRevision, newRequest: true });
            return 'completed';
          } catch { return 'rejected'; }
        });
        await expect.poll(() => proxy.heldCount).toBe(1);
        await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), { label: '合成联系人乙' });
        proxy.release();
        expect(await pendingGeneration).toBe('completed');
        await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('');
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
        await expect(helper.getByText('迟到的甲候选（说法1）。', { exact: true })).toHaveCount(0);
        await helper.screenshot({ path: 'artifacts/headless-pages/draft-scope.png' });
      } finally { proxy.release(); await host.close(); }
    }); } finally { await proxy.close(); }
  });
}
