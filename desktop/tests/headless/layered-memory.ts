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
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true }).first()).toBeVisible();
      const profile = panel.getByRole('region', { name: '长期背景', exact: true });
      await expect(profile.getByText('双方共同参加合成学习课程。', { exact: true })).toBeVisible();
      await expect(profile.getByText('时间状态：尚不确定', { exact: true })).toBeVisible();
      await expect(profile.getByText('不确定性：是否持续共同学习尚未核实。', { exact: true })).toBeVisible();
      await profile.getByText('查看第 1 项依据与时间', { exact: true }).click();
      await expect(profile.getByText(/底层记忆：.*版本 1.*来源支持/)).toBeVisible();
      await profile.getByText('查看长期背景版本', { exact: true }).click();
      await expect(profile.getByText(/版本标识：/)).toBeVisible();
      await panel.getByText('查看第 1 段依据与时间', { exact: true }).click();
      await expect(panel.getByText(/底层记忆：.*版本 1.*来源支持/).first()).toBeVisible();
      await panel.getByRole('button', { name: '停用主题资料', exact: true }).click();
      await expect(panel.getByText('已停用', { exact: true })).toBeVisible();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true }).first()).toBeVisible();
      await expect(profile.getByText('双方共同参加合成学习课程。', { exact: true })).toBeVisible();
      await profile.getByRole('button', { name: '撤回本版长期背景', exact: true }).click();
      await expect(profile.getByText('暂无可展示的长期背景。', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
      await expect(profile.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '删除整理结果', exact: true }).click();
      await panel.getByRole('button', { name: '确认删除整理结果', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
      await panel.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
      await panel.getByRole('checkbox').check();
      await panel.getByRole('button', { name: '确认范围并开启', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true }).first()).toBeVisible();
      await fixture.command('delete_source');
      await panel.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
      await expect(panel.getByText('双方共同参加合成学习课程。', { exact: true })).toHaveCount(0);
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
  process.stdout.write('page_test_scenario_passed: layered-memory-profile-evidence-withdrawal-scope-disable-delete-and-source-erasure\n');
}
