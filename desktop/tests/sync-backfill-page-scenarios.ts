import { expect, type Page } from '@playwright/test';
import { initialCliState, type BindingFixture } from './binding-backend-fixture';

type SyncPage = { manager: Page; syncBackend: BindingFixture };

// 只操纵合成CLI输入；状态、消息、暂停与重试均走生产公开页面和真实HTTP。
export async function syncBackfillRetriesConfirmedScope({ manager, syncBackend }: SyncPage): Promise<void> {
  const [contactA, contactB] = syncBackend.data.contact_ids;
  expect((await syncBackend.request('/api/sync/cli-bindings/confirm', { selections: [{
    locator: 'wxid_synthetic_a', contact_id: contactA,
  }] })).status).toBe(200);
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const background = manager.getByRole('region', { name: '后台 CLI 同步', exact: true });
  await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  await background.getByRole('button', { name: '开启后台同步', exact: true }).click();
  await expect(background.getByText('后台正文同步已开启', { exact: true })).toBeVisible();

  const incomplete = await syncBackend.request('/api/sync/status');
  expect(incomplete.status).toBe(200);
  expect(incomplete.data).toMatchObject({ sync_enabled: true, cli_backfill_phase: 'incomplete',
    cli_backfill_failure_code: 'cli_freshness_unknown', cli_backfill_completed_contacts: 0,
    cli_backfill_incomplete_contacts: 1, cli_backfill_last_cursor: null });
  console.log('sync_backfill_initial_report:', JSON.stringify({ phase: incomplete.data.cli_backfill_phase,
    failureCode: incomplete.data.cli_backfill_failure_code, completed: incomplete.data.cli_backfill_completed_contacts }));
  const backfill = manager.getByRole('region', { name: '历史补齐', exact: true });
  await expect(backfill.getByText('无法确认补齐完整性', { exact: true })).toBeVisible();
  await expect(backfill.getByRole('button', { name: '暂停补齐', exact: true })).toBeHidden();
  await backfill.getByText('查看补齐详情与操作', { exact: true }).click();
  await backfill.getByRole('button', { name: '暂停补齐', exact: true }).click();
  await expect(backfill.getByText('补齐已暂停', { exact: true })).toBeVisible();
  const paused = await syncBackend.request('/api/sync/status');
  expect(paused.data).toMatchObject({ sync_enabled: true, cli_backfill_phase: 'paused',
    cli_backfill_completed_contacts: 0, cli_backfill_last_cursor: null });
  expect((await syncBackend.request(`/api/contacts/${contactA}/messages`)).data.messages).toEqual([]);

  const cli = initialCliState();
  const now = Math.floor(Date.now() / 1000) + 10;
  for (const session of cli.sessions) session.last_timestamp = now;
  // 空正文经过真实CLI解析拒绝；不能把失败当作无消息或推进游标。
  cli.messages.wxid_synthetic_a = [{ local_id: 1, text: '', create_time: now }];
  cli.messages.wxid_synthetic_b = [{ local_id: 1, text: '未确认范围的合成消息。', create_time: now }];
  await syncBackend.setCli(cli);
  await backfill.getByRole('button', { name: '重试补齐', exact: true }).click();
  await expect(backfill.getByText('补齐失败', { exact: true })).toBeVisible();
  await backfill.getByText('查看补齐详情与操作', { exact: true }).click();
  await expect(backfill.getByText('补齐失败', { exact: true })).toBeVisible();
  await expect(backfill.getByText('本轮已检查0／1个会话。 1个失败。', { exact: true })).toBeVisible();
  await backfill.getByText('查看补齐详情与操作', { exact: true }).click();
  const failed = await syncBackend.request('/api/sync/status');
  expect(failed.data).toMatchObject({ sync_enabled: true, cli_backfill_phase: 'failed',
    cli_backfill_failure_code: 'cli_output_invalid', cli_backfill_failed_contacts: 1,
    cli_backfill_completed_contacts: 0, cli_backfill_last_cursor: null });
  expect((await syncBackend.request(`/api/contacts/${contactA}/messages`)).data.messages).toEqual([]);

  const recoveredText = '显式重试恢复的同一合成消息。';
  cli.messages.wxid_synthetic_a[0].text = recoveredText;
  await syncBackend.setCli(cli);
  // 修正外部传输后只读状态，不调用check或伪造成功响应；恢复由用户按钮明确触发。
  expect((await syncBackend.request('/api/sync/status')).data.cli_backfill_phase).toBe('failed');
  await backfill.getByRole('button', { name: '重试补齐', exact: true }).click();
  await expect(backfill.getByText('补齐已完成', { exact: true })).toBeVisible();
  const completed = await syncBackend.request('/api/sync/status');
  expect(completed.data).toMatchObject({ sync_enabled: true, cli_backfill_phase: 'complete',
    cli_backfill_failure_code: null, cli_backfill_total_contacts: 1, cli_backfill_completed_contacts: 1,
    cli_backfill_failed_contacts: 0, cli_backfill_incomplete_contacts: 0, cli_backfill_pending_contacts: 0,
    cli_backfill_last_cursor: 'local_id:1' });
  const messages = (await syncBackend.request(`/api/contacts/${contactA}/messages`)).data.messages as { text: string }[];
  expect(messages.map(message => message.text)).toEqual([recoveredText]);
  expect((await syncBackend.request(`/api/contacts/${contactB}/messages`)).data.messages).toEqual([]);
  const tails = await syncBackend.tails();
  expect(tails.length).toBeGreaterThan(0);
  expect(tails.every(locator => locator === 'wxid_synthetic_a')).toBe(true);
  await background.getByRole('button', { name: '关闭后台同步', exact: true }).click();
  await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  expect((await syncBackend.request('/api/sync/status')).data.sync_enabled).toBe(false);
}
