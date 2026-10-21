import { expect, type Page } from '@playwright/test';
import { initialCliState, type BindingFixture } from './binding-backend-fixture';

type SyncPage = { manager: Page; syncBackend: BindingFixture };

// 只修复合成 CLI 输入；恢复必须由真实后台心跳完成，不能调用 check/retry 代替自动恢复。
export async function syncBackfillRetriesConfirmedScope({ manager, syncBackend }: SyncPage): Promise<void> {
  const [contactA, contactB] = syncBackend.data.contact_ids;
  expect((await syncBackend.request('/api/sync/cli-bindings/confirm', { selections: [{
    locator: 'wxid_synthetic_a', contact_id: contactA,
  }] })).status).toBe(200);
  const cli = initialCliState();
  const now = Math.floor(Date.now() / 1000) + 10;
  for (const session of cli.sessions) session.last_timestamp = now;
  cli.messages.wxid_synthetic_a = [{ local_id: 1, text: '', create_time: now }];
  cli.messages.wxid_synthetic_b = [{ local_id: 1, text: '未确认范围的合成消息。', create_time: now }];
  await syncBackend.setCli(cli);
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const background = manager.getByRole('region', { name: '后台 CLI 同步', exact: true });
  await background.getByRole('button', { name: '开启后台同步', exact: true }).click();
  await expect(background.getByText('后台正文同步已开启', { exact: true })).toBeVisible();
  await expect(background.getByText('部分消息暂未同步，正在自动重试。', { exact: true })).toBeVisible();
  await expect(manager.getByRole('region', { name: '历史补齐', exact: true })).toHaveCount(0);
  await expect(manager.getByRole('button', { name: /暂停补齐|重试补齐/ })).toHaveCount(0);
  await expect(manager.getByText(/本轮已检查|已写入文字/)).toHaveCount(0);
  const failed = await syncBackend.request('/api/sync/status');
  expect(failed.data).toMatchObject({ sync_enabled: true, cli_backfill_phase: 'failed',
    cli_backfill_failure_code: 'cli_output_invalid', cli_backfill_failed_contacts: 1,
    cli_backfill_completed_contacts: 0, cli_backfill_last_cursor: null });
  expect((await syncBackend.request(`/api/contacts/${contactA}/messages`)).data.messages).toEqual([]);

  const recoveredText = '自动恢复的同一合成消息。';
  cli.messages.wxid_synthetic_a[0].text = recoveredText;
  await syncBackend.setCli(cli);
  await expect.poll(async () => (await syncBackend.request('/api/sync/status')).data,
    { timeout: 90_000, intervals: [500, 1000] }).toMatchObject({
    sync_enabled: true, cli_backfill_phase: 'complete', cli_backfill_failure_code: null,
    cli_backfill_failed_contacts: 0, cli_backfill_pending_contacts: 0, cli_backfill_last_cursor: 'local_id:1',
  });
  await expect(background.getByText('部分消息暂未同步，正在自动重试。', { exact: true })).toBeHidden();
  await expect(background.locator('[aria-label="遗漏消息同步"]')).toHaveCount(0);
  const messages = (await syncBackend.request(`/api/contacts/${contactA}/messages`)).data.messages as { text: string }[];
  expect(messages.map(message => message.text)).toEqual([recoveredText]);
  expect((await syncBackend.request(`/api/contacts/${contactB}/messages`)).data.messages).toEqual([]);
  const tails = await syncBackend.tails();
  expect(tails.length).toBeGreaterThan(1);
  expect(tails.every(locator => locator === 'wxid_synthetic_a')).toBe(true);

  await background.getByRole('button', { name: '关闭后台同步', exact: true }).click();
  await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  const stoppedReads = await syncBackend.tails();
  // 再次开启自动恢复同一可靠位置，不应重复写入已恢复消息。
  await background.getByRole('button', { name: '开启后台同步', exact: true }).click();
  await expect.poll(async () => (await syncBackend.tails()).length).toBeGreaterThan(stoppedReads.length);
  // 合成 CLI 没有新消息时不提供覆盖证明，不能要求空读被报告成完整。
  expect((await syncBackend.request('/api/sync/status')).data.sync_enabled).toBe(true);
  expect(((await syncBackend.request(`/api/contacts/${contactA}/messages`)).data.messages as { text: string }[])
    .map(message => message.text)).toEqual([recoveredText]);
  await background.getByRole('button', { name: '关闭后台同步', exact: true }).click();
  await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  expect((await syncBackend.request('/api/sync/status')).data.sync_enabled).toBe(false);
}
