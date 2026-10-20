import path from 'node:path';
import { expect, type Browser } from '@playwright/test';
import { withControllerEnvironment, withRewriteBackend } from './backend-fixture';
import { PageHost } from './page-host';

export async function memoryProcessing(browser: Browser, origin: string) {
  await withRewriteBackend(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择恢复测试合成联系人', exact: true }).click();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      const card = manager.getByRole('region', { name: '记忆处理状态', exact: true });
      await expect(card).toContainText('已中断');
      expect((await fixture.command('processing_evidence')).model_calls).toBe(0);
      await manager.reload();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await expect(card).toContainText('已中断');
      expect((await fixture.command('processing_evidence')).model_calls).toBe(0);
      await card.getByRole('button', { name: '继续处理', exact: true }).first().click();
      await expect(card).toContainText('本次提取完成', { timeout: 20_000 });
      await expect(card).toContainText('2 / 2');
      expect((await fixture.command('processing_evidence')).model_calls).toBeGreaterThan(0);
      const completed = await fixture.command('processing_evidence');
      await manager.reload();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await expect(card).toContainText('本次提取完成');
      expect((await fixture.command('processing_evidence')).model_calls).toBe(completed.model_calls);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.empty_contact_id);
      await expect(card).toContainText('暂无记忆提取任务');
      await expect(card.getByRole('button', { name: '继续处理', exact: true })).toHaveCount(0);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.contact_ids[0]);
      await expect(card).toContainText('本次提取完成');
      await manager.screenshot({ path: 'artifacts/headless-pages/memory-processing.png' });
    } catch (error) {
      process.stderr.write(`memory_processing_original_failure: ${String(error)}\n`);
      throw error;
    } finally {
      await host.close();
    }
  }), path.resolve('tests/fixtures/memory-processing-pages.py'));
  process.stdout.write('page_test_scenario_passed: memory-processing-interrupted-resume-complete-scope\n');
}
