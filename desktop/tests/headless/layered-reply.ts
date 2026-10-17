import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withLayeredReplyFixture } from '../layered-reply-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

export async function layeredReply(browser: Browser, origin: string) {
  const released = ownResource();
  await withLayeredReplyFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const prepared = await fixture.command('prepared');
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager'), opened = manager.context().waitForEvent('page');
      await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
      const helper = await opened;
      const evidence = helper.getByRole('region', { name: '候选1依据', exact: true });
      async function generate(contactId: string, context: boolean, text: string) {
        await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactId);
        await confirmHelperContact(helper, contactId);
        await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('聊聊共同参加的课程。');
        await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).setChecked(context);
        await fixture.command('plan', { plan: { text, basis: '按本次草稿，不扩大未知事实。' } });
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        try { await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(text); }
        catch (error) { process.stderr.write((await helper.locator('body').innerText()).slice(-8000)); throw error; }
        await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
        await expect.poll(() => helper.evaluate(() => window.notalone.replies.getEvidenceState().then(state => state.phase))).toBe('ready');
      }
      await generate(String(prepared.contact_id), true, '想聊聊共同学习的经历。');
      await expect(evidence.getByText(String(prepared.profile_text), { exact: true })).toBeVisible();
      await expect(evidence.getByText('本次仅加载主题目录，未读取主题正文。', { exact: true })).toBeVisible();
      await expect(evidence.getByText(`背景版本：${prepared.profile_version_id}。`, { exact: true })).toBeVisible();
      await expect(evidence.getByText(new RegExp(`目录版本：${prepared.scenario_version_id}`))).toBeVisible();
      const saved = await helper.evaluate(() => window.notalone.replies.getEvidenceState());
      expect(saved.layeredStatus).toBe('loaded');
      expect(saved.layeredContext?.profileVersionId).toBe(prepared.profile_version_id);
      await generate(String(prepared.other_contact_id), true, '另一个联系人的合成候选。');
      await expect(evidence.getByText(String(prepared.profile_text), { exact: true })).toHaveCount(0);
      expect((await helper.evaluate(() => window.notalone.replies.getEvidenceState())).layeredContext).toBeNull();
      await generate(String(prepared.contact_id), false, '关闭关系语境后按草稿表达。');
      await expect(evidence.getByText('本次未授权加载系统整理资料。', { exact: true })).toBeVisible();
      await expect(evidence.getByText(String(prepared.profile_text), { exact: true })).toHaveCount(0);
      expect((await fixture.command('runtime_proof')).external_model_calls).toBe(0);
    } finally { await host.close(); }
  }), released);
  process.stdout.write('page_test_scenario_passed: layered-reply-background-directory-versions-isolation-disabled\n');
}
