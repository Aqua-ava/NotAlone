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
      const history = manager.locator('details[aria-label="处理历史"]');
      await expect(card).toContainText('暂时无法处理，请稍后重试');
      await card.getByRole('button', { name: '详情', exact: true }).click();
      await expect(card.getByText('历史导入 · 记忆生成已中断', { exact: true })).toBeVisible();
      await expect(history).toHaveCount(0);
      expect((await fixture.command('processing_evidence')).model_calls).toBe(0);
      await manager.reload();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await expect(card).toContainText('暂时无法处理，请稍后重试');
      await card.getByRole('button', { name: '详情', exact: true }).click();
      await expect(card.getByText('历史导入 · 记忆生成已中断', { exact: true })).toBeVisible();
      expect((await fixture.command('processing_evidence')).model_calls).toBe(0);
      await card.getByRole('button', { name: '继续', exact: true }).first().click();
      await expect(history).toBeVisible({ timeout: 20_000 });
      await expect(card).toHaveCount(0);
      await expect(history).not.toHaveAttribute('open');
      await expect(history.getByText('历史导入 · 本次处理完成', { exact: true })).not.toBeVisible();
      expect((await fixture.command('processing_evidence')).model_calls).toBeGreaterThan(0);
      const completed = await fixture.command('processing_evidence');
      await history.locator('summary').click();
      await expect(history).toHaveAttribute('open');
      await expect(history.getByText('历史导入 · 本次处理完成', { exact: true })).toBeVisible();
      await expect(history.getByText('已处理 2 / 2 条聊天', { exact: true })).toBeVisible();
      expect((await fixture.command('processing_evidence')).model_calls).toBe(completed.model_calls);
      await history.getByRole('button', { name: '刷新进度', exact: true }).click();
      await expect(history.getByRole('button', { name: '刷新进度', exact: true })).toBeEnabled();
      await expect(card).toHaveCount(0);
      expect((await fixture.command('processing_evidence')).model_calls).toBe(completed.model_calls);
      await manager.reload();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await expect(history).toBeVisible();
      await expect(history).not.toHaveAttribute('open');
      await expect(card).toHaveCount(0);
      await history.locator('summary').click();
      await expect(history.getByText('已处理 2 / 2 条聊天', { exact: true })).toBeVisible();
      expect((await fixture.command('processing_evidence')).model_calls).toBe(completed.model_calls);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.empty_contact_id);
      await expect(card).toHaveCount(0);
      await expect(history).toHaveCount(0);
      expect((await fixture.command('processing_evidence')).model_calls).toBe(completed.model_calls);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.contact_ids[0]);
      await expect(history).toBeVisible();
      await expect(history).not.toHaveAttribute('open');
      await expect(card).toHaveCount(0);
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
