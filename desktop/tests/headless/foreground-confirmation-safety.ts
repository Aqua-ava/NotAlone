import type { Browser } from '@playwright/test';
import { withManualForegroundFixture } from '../foreground-backend-fixture';
import { foregroundConfirmationSafetyFlow } from '../foreground-confirmation-safety-page-scenarios';
import { withForegroundPages } from './foreground-cases';
import { ownResource } from './cleanup';

// 共用原认证生命周期，外部probe保持合成且总开关默认关闭。
export async function foregroundConfirmationSafety(browser: Browser, origin: string): Promise<void> {
  const name = '人工确认A后管理页换B，旧revision与错误角色不得恢复生成资格';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withManualForegroundFixture(async ({ backend }) => {
    await withForegroundPages(browser, origin, backend, async (manager, openHelper) => {
      await foregroundConfirmationSafetyFlow(manager, openHelper, backend);
    });
  }, released);
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
