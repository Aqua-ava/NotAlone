import { expect, type Browser } from '@playwright/test';
import { withLayeredMemoryFixture } from '../layered-memory-fixture';
import { selectMemoryCategory } from '../memory-page-actions';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

export async function layeredMemory(browser: Browser, origin: string) {
  const released = ownResource();
  await withLayeredMemoryFixture(async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    const host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      const manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成概览联系人', exact: true }).first().click();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '主题资料');
      const panel = manager.getByRole('region', { name: '主题资料', exact: true });
      await expect(panel.getByText('本范围已关闭', { exact: false })).toBeVisible();
      await expect(panel.getByRole('button', { name: '确认范围并开启', exact: true })).toBeDisabled();
      await panel.getByRole('checkbox').check();
      await panel.getByRole('button', { name: '确认范围并开启', exact: true }).click();
      await expect(panel.getByText('已暂停，剩余资料可继续整理', { exact: true })).toBeVisible();
      await expect(panel.getByText('合格资料 2 条 · 已覆盖 1 条 · 剩余 1 条', { exact: true })).toBeVisible();
      await expect(panel.getByText('当前批次：1', { exact: true })).toBeVisible();
      await expect(panel.getByText('累计已用 2 / 已授权 2 次模型调用', { exact: true })).toBeVisible();
      const endpoint = `/api/contacts/${fixture.data.contact_ids[0]}/layered-memory`;
      const firstResponse = await fixture.request(endpoint);
      expect(firstResponse.status).toBe(200);
      const firstWork = firstResponse.data.layered_memory as { work_id: string; current_batch: number; covered_count: number };
      expect(firstWork.work_id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      expect(firstWork).toMatchObject({ current_batch: 1, covered_count: 1 });
      const firstParagraph = await panel.locator('.memory-text').innerText();
      expect(['双方共同参加合成学习课程。', '双方后来共同完成合成学习练习。']).toContain(firstParagraph);
      await panel.getByRole('button', { name: '继续整理主题资料', exact: true }).click();
      await expect(panel.getByText('合格资料 2 条 · 已覆盖 2 条 · 剩余 0 条', { exact: true })).toBeVisible();
      await expect(panel.getByText('当前批次：2', { exact: true })).toBeVisible();
      await expect(panel.getByText('累计已用 4 / 已授权 4 次模型调用', { exact: true })).toBeVisible();
      await expect(panel.getByText('本批主题资料整理成功', { exact: true })).toBeVisible();
      const continuedResponse = await fixture.request(endpoint);
      expect(continuedResponse.status).toBe(200);
      expect(continuedResponse.data.layered_memory).toMatchObject({ work_id: firstWork.work_id,
        current_batch: 2, covered_count: 2, remaining_count: 0, status: 'ready' });
      await expect(panel.getByText(firstParagraph, { exact: true })).toBeVisible();
      await expect(panel.getByRole('heading', { name: '合成学习记录', exact: true })).toHaveCount(1);
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toBeVisible();
      await expect(panel.getByText('双方后来共同完成合成学习练习。', { exact: true })).toBeVisible();
      await fixture.command('add_memory');
      await expect(panel.getByText('双方新近完成合成复习。', { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(panel.getByText('合格资料 3 条 · 已覆盖 3 条 · 剩余 0 条', { exact: true })).toBeVisible();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toBeVisible();
      await panel.getByText('查看第 1 段依据与时间', { exact: true }).click();
      await expect(panel.getByText(/底层记忆：.*版本 1.*来源支持/).first()).toBeVisible();
      await panel.getByRole('button', { name: '停用主题资料', exact: true }).click();
      await expect(panel.getByText('已停用', { exact: true })).toBeVisible();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '删除整理结果', exact: true }).click();
      await panel.getByRole('button', { name: '确认删除整理结果', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('双方后来共同完成合成学习练习。', { exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('双方后来共同完成合成学习练习。', { exact: true })).toHaveCount(0);
      await panel.getByRole('checkbox').check();
      await panel.getByRole('button', { name: '确认范围并开启', exact: true }).click();
      await expect(panel.getByText('已暂停，剩余资料可继续整理', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '继续整理主题资料', exact: true }).click();
      await expect(panel.getByText('已暂停，剩余资料可继续整理', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '继续整理主题资料', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toBeVisible();
      await fixture.command('delete_source');
      await panel.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('双方后来共同完成合成学习练习。', { exact: true })).toHaveCount(0);
      await manager.getByRole('combobox', { name: '资料联系人', exact: true }).selectOption(fixture.data.contact_ids[1]);
      await selectMemoryCategory(manager, '主题资料');
      await expect(panel.getByText('本范围已关闭', { exact: false })).toBeVisible();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
      await panel.getByRole('checkbox').check();
      await panel.getByRole('button', { name: '确认范围并开启', exact: true }).click();
      await expect(panel.getByText('暂无合格资料可整理', { exact: true })).toBeVisible();
    } catch (error) { process.stderr.write(`${(error as Error).stack}\n`); throw error; }
    finally { await host.close(); }
  }), released);
  process.stdout.write('page_test_scenario_passed: layered-memory-multi-batch-continue-scope-disable-delete-and-source-erasure\n');
}
