import { _electron as electron, expect, test } from '@playwright/test';
import '../app-test-gate';

test('原始 _electron.launch 没有活租约时在进程边界之前拒绝', async () => {
  await expect(electron.launch({ executablePath: process.execPath, args: ['--version'], timeout: 200 }))
    .rejects.toThrow(/app_test_unapproved/);
});
