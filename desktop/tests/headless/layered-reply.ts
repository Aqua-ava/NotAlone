import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { selectMemoryCategory } from '../memory-page-actions';
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
      async function generate(contactId: string, context: boolean, text: string, readScenario = false) {
        await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactId);
        await confirmHelperContact(helper, contactId);
        await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('聊聊共同参加的课程。');
        await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).setChecked(context);
        if (readScenario) await fixture.command('plan_scenario_reads', { text });
        else await fixture.command('plan', { plan: { text, basis: '按本次草稿，不扩大未知事实。' } });
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        try { await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(text); }
        catch (error) { process.stderr.write((await helper.locator('body').innerText()).slice(-8000)); throw error; }
        await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
        await expect.poll(() => helper.evaluate(() => window.notalone.replies.getEvidenceState().then(state => state.phase))).toBe('ready');
      }
      await generate(String(prepared.contact_id), true, '想聊聊共同学习的经历。');
      await expect(evidence.getByText(String(prepared.profile_text), { exact: true })).toBeVisible();
      await expect(evidence.getByText('初始仅加载主题目录，未读取主题正文。', { exact: true })).toBeVisible();
      await expect(evidence.getByText(`背景版本：${prepared.profile_version_id}。`, { exact: true })).toBeVisible();
      await expect(evidence.getByText(new RegExp(`目录版本：${prepared.scenario_version_id}`))).toBeVisible();
      const saved = await helper.evaluate(() => window.notalone.replies.getEvidenceState());
      expect(saved.layeredStatus).toBe('loaded');
      expect(saved.layeredContext?.profileVersionId).toBe(prepared.profile_version_id);
      expect(saved.layeredScenarioReads).toEqual([]);
      await generate(String(prepared.contact_id), true, '想聊聊已经共同参加过的课程。', true);
      await expect(evidence.getByRole('heading', { name: '系统整理 · 本次实际读取的主题正文与回执' })).toBeVisible();
      await expect(evidence.getByText(`第 1 段：${prepared.scenario_text}`, { exact: true })).toBeVisible();
      await expect(evidence.getByText('主题读取 2：重复读取，未追加正文。', { exact: true })).toBeVisible();
      const read = await helper.evaluate(() => window.notalone.replies.getEvidenceState());
      expect(read.layeredScenarioReads?.map((receipt) => receipt.status)).toEqual(['succeeded', 'duplicate']);
      expect(read.layeredScenarioReads?.[0].document?.versionId).toBe(prepared.scenario_version_id);
      expect(read.layeredScenarioReads?.[0].document?.paragraphRange).toEqual([0, 1]);
      expect(read.layeredContext?.directory[0].paragraphRange).toEqual([0, prepared.scenario_paragraph_count]);
      await helper.getByRole('button', { name: '收起候选1依据', exact: true }).click();
      expect((await helper.evaluate(() => window.notalone.replies.getEvidenceState())).layeredScenarioReads).toBeUndefined();
      await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
      await expect(evidence.getByText(`第 1 段：${prepared.scenario_text}`, { exact: true })).toBeVisible();
      await generate(String(prepared.other_contact_id), true, '另一个联系人的合成候选。');
      await expect(evidence.getByText(String(prepared.profile_text), { exact: true })).toHaveCount(0);
      await expect(evidence.getByText(`第 1 段：${prepared.scenario_text}`, { exact: true })).toHaveCount(0);
      expect((await helper.evaluate(() => window.notalone.replies.getEvidenceState())).layeredContext).toBeNull();
      await generate(String(prepared.contact_id), false, '关闭关系语境后按草稿表达。');
      await expect(evidence.getByText('本次未授权加载系统整理资料。', { exact: true })).toBeVisible();
      await expect(evidence.getByText(String(prepared.profile_text), { exact: true })).toHaveCount(0);
      expect((await fixture.command('runtime_proof')).external_model_calls).toBe(0);
      await generate(String(prepared.contact_id), true, '删除来源前保留本次合法课程依据。', true);
      await expect(evidence.getByText(`第 1 段：${prepared.scenario_text}`, { exact: true })).toBeVisible();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '来源与过程');
      const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
        .filter({ hasText: `来源标识：${prepared.source_id}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await helper.evaluate(() => window.notalone.replies.getEvidenceState())).layeredScenarioReads).toBeUndefined();
      await expect(evidence.getByText(`第 1 段：${prepared.scenario_text}`, { exact: true })).toHaveCount(0);
    } finally { await host.close(); }
  }), released);
  process.stdout.write('page_test_scenario_passed: layered-reply-background-directory-scenario-reads-versions-isolation-disabled\n');
}
