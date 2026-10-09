import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { withRewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 直接连接生产认证 HTTP/SSE；不能使用等待响应结束的改写代理。
export async function messageEvents(browser: Browser, origin: string) {
  const name = '真实新消息提醒与主动刷新保留编辑和依据快照';
  process.stdout.write(`page_test_scenario: ${name}\n`);
  const released = ownResource();
  await withRewriteFixture('notalone-headless-message-events-', async (fixture) => {
    await withControllerEnvironment(fixture, async (userData) => {
      const host = new PageHost(await browser.newContext(), origin, userData);
      try {
        await host.backend.connect();
        const manager = await host.open('manager');
        const opened = manager.context().waitForEvent('page');
        await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
        const helper = await opened;
        await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
        await helper.getByRole('button', { name: '回复', exact: true }).click();
        await helper.getByRole('radio', { name: /甲的原始合成消息/ }).check();
        await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('说明原时间安排。');
        await fixture.plan({ count: 1, prefix: '原快照候选' });
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
        await expect(editor).toHaveValue('原快照候选（说法1）。');
        await editor.fill('用户仍在编辑的措辞。');
        const requestId = await helper.evaluate(async () => (await window.notalone.replies.getState()).result!.replyRequestId);
        const endpoint = `/api/contacts/${fixture.data.contact_ids[0]}/replies/${requestId}/evidence`;
        const before = await fixture.request(endpoint);
        expect(before.status).toBe(200);
        await expect(helper.getByRole('status').filter({ hasText: '新消息提醒已连接' })).toBeVisible();
        await fixture.command('append_message');
        await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息，生成依据仍是原快照' })).toBeVisible();
        await expect(editor).toHaveValue('用户仍在编辑的措辞。');
        await expect(helper.getByRole('radio', { name: /甲的新合成消息/ })).toHaveCount(0);
        await helper.getByRole('button', { name: '刷新消息', exact: true }).click();
        await expect(helper.getByRole('radio', { name: /甲的新合成消息/ })).toBeVisible();
        await expect(editor).toHaveValue('用户仍在编辑的措辞。');
        expect((await fixture.request(endpoint)).data).toEqual(before.data);
        expect((await fixture.command('observations')).model_calls).toBe(1);
      } finally {
        await host.close();
        // 先确认自有夹具收尾并保留精确归属，再由通用生命周期幂等核验和移除目录。
        await fixture.cleanup();
        const evidence = path.resolve('artifacts/headless-pages/message-events-owned');
        await mkdir(evidence, { recursive: true });
        for (const suffix of ['database-ownership', 'owned']) {
          await copyFile(path.join(fixture.directory, `message-events-${suffix}.json`),
            path.join(evidence, `${fixture.data.owner_id}-${suffix}.json`));
        }
      }
    });
  }, released, path.resolve('tests/fixtures/message-events-backend.py'));
  process.stdout.write(`page_test_scenario_passed: ${name}\n`);
}
