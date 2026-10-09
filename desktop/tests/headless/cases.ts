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
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await manager.getByRole('button', { name: '关系资料', exact: true }).click();
      const contact = manager.getByRole('region', { name: '联系人记忆' });
      await expect(contact.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
      await expect(contact.getByText('自动采纳（可撤销）', { exact: true })).toBeVisible();
      await expect(contact.getByText('甲的新版本关系备注。', { exact: true })).toBeVisible();
      await expect(contact.getByText('旧版关系备注。', { exact: true })).toHaveCount(0);
      await expect(manager.getByText('另一用户的本人资料。', { exact: true })).toHaveCount(0);
      await expect(manager.getByText('待确认 · 不是已确认事实', { exact: true })).toHaveCount(3);
      await contact.getByRole('button', { name: '查看来源与版本：甲喜欢合成茉莉茶。' }).click();
      await expect(contact.getByText(`来源引用：${fixture.data.direct_message_id}`, { exact: true })).toBeVisible();
      await manager.screenshot({ path: 'artifacts/headless-pages/memory-reading.png' });
      await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(fixture.data.contact_ids[1]);
      await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
      await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
      await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
      await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(fixture.data.empty_contact_id);
      await expect(manager.getByText('这位联系人暂无当前有效记忆。', { exact: true })).toBeVisible();
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
      expect(await manager.evaluate(() => Object.keys(window.notalone.memory).sort())).toEqual(['add', 'confirmCandidate', 'correct', 'discardCandidate', 'getState', 'onStateChanged', 'refresh', 'remove']);
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
        await expect(helper.getByRole('button', { name: '生成候选', exact: true })).toBeDisabled();
        await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
        await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
        await fixture.plan({ count: 2 });
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
        await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我今晚忙完再回复你。');
        await helper.getByText('查看原候选', { exact: true }).first().click();
        await expect(helper.getByText('我会晚一点回复你（说法1）。', { exact: true })).toBeVisible();
        await helper.getByRole('radio', { name: '说法 2', exact: true }).click();
        await expect(helper.getByRole('radio', { name: '说法 2', exact: true })).toBeChecked();
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
        await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
        proxy.release();
        expect(await pendingGeneration).toBe('completed');
        await expect(helper.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('');
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
        await expect(helper.getByText('迟到的甲候选（说法1）。', { exact: true })).toHaveCount(0);
        await helper.screenshot({ path: 'artifacts/headless-pages/draft-scope.png' });
      } finally { proxy.release(); await host.close(); }
    }); } finally { await proxy.close(); }
  });
}
