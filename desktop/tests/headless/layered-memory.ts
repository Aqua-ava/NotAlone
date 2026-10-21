import { selectContact } from '../contact-picker-actions.mjs';
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
      await selectMemoryCategory(manager, '联系人记忆');
      await expect(manager.getByRole('region', { name: '联系人记忆', exact: true })).toBeVisible();
      await expect(manager.getByText('查看摘要', { exact: true })).toHaveCount(0);
      await expect(manager.getByRole('region', { name: '主题资料', exact: true })).toHaveCount(0);
      await expect(manager.getByText('整理管理', { exact: true })).toHaveCount(0);
      await selectContact(manager.getByRole('combobox', { name: '本次联系人', exact: true }), fixture.data.contact_ids[1]);
      await expect(manager.getByRole('region', { name: '联系人记忆', exact: true })).toBeVisible();
      await expect(manager.getByText('查看摘要', { exact: true })).toHaveCount(0);
    } catch (error) { process.stderr.write(`${(error as Error).stack}\n`); throw error; }
    finally { await host.close(); }
  }), released, { initiallyDisabled: true });
  process.stdout.write('page_test_scenario_passed: contact-memory-without-summary-entry\n');
}
