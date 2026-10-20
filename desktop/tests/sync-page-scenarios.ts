import { expect, type Page } from '@playwright/test';
import { initialCliState, type BindingFixture } from './binding-backend-fixture';

export type SyncPage = { manager: Page; syncBackend: BindingFixture };

// 公开页面控制总开关，真实HTTP核对持久状态与消息；读取边界仅为本轮合成CLI。
export async function syncSwitchStopsReading({ manager, syncBackend }: SyncPage): Promise<void> {
  const [confirmedContact, unconfirmedContact] = syncBackend.data.contact_ids;
  expect((await syncBackend.request('/api/sync/cli-bindings/confirm', { selections: [{
    locator: 'wxid_synthetic_a', contact_id: confirmedContact,
  }] })).status).toBe(200);
  const status = await syncBackend.request('/api/sync/status');
  expect(status.status).toBe(200);
  expect(status.data.sync_enabled).toBe(false);
  expect(status.data.sync_mode).toBe('cli_background');
  expect(status.data.cli_sync_phase).toBe('disabled');
  expect(status.data.foreground_phase).toBe('sync_disabled');
  expect(await syncBackend.tails()).toEqual([]);

  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  await expect(manager.getByRole('region', { name: '前台定位最近报告', exact: true })).toHaveCount(0);
  const background = manager.getByRole('region', { name: '后台 CLI 同步', exact: true });
  await expect(background.getByRole('button', { name: '开启后台同步', exact: true })).toBeVisible();
  const readPublicStatus = () => manager.evaluate(async () => {
    const state = await window.notalone.syncControl.getState();
    return { phase: state.phase, enabled: state.report?.enabled ?? null, busy: state.busy, errorCode: state.errorCode,
      backgroundPhase: state.report?.backgroundPhase ?? null, foregroundPhase: state.report?.foregroundPhase ?? null };
  });
  console.log('sync_control_initial_report:', JSON.stringify(await readPublicStatus()));
  try {
    await expect.poll(readPublicStatus, { message: '公开同步状态应反映真实关闭报告' })
      .toMatchObject({ phase: 'ready', enabled: false });
    await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  } catch (error) {
    console.log('sync_control_initial_report_failure:', JSON.stringify({ state: await readPublicStatus(),
      alerts: await background.getByRole('alert').allTextContents() }));
    throw error;
  }

  const state = initialCliState();
  const timestamp = Math.floor(Date.now() / 1000) + 10;
  state.sessions.forEach((session) => { session.last_timestamp = timestamp; });
  state.messages = {
    wxid_synthetic_a: [{ local_id: 1, text: '已确认范围内的合成同步消息。', create_time: timestamp }],
    wxid_synthetic_b: [{ local_id: 1, text: '未授权会话的合成消息。', create_time: timestamp }],
  };
  await syncBackend.setCli(state);
  await background.getByRole('button', { name: '开启后台同步', exact: true }).click();
  await expect(background.getByText('后台正文同步已开启', { exact: true })).toBeVisible();
  expect((await syncBackend.request('/api/sync/status')).data.sync_enabled).toBe(true);
  await expect.poll(async () => {
    const response = await syncBackend.request(`/api/contacts/${confirmedContact}/messages`);
    expect(response.status).toBe(200);
    return (response.data.messages as { text: string }[]).map((message) => message.text);
  }).toEqual(['已确认范围内的合成同步消息。']);
  expect(await syncBackend.tails()).toContain('wxid_synthetic_a');
  expect((await syncBackend.tails()).every((locator) => locator === 'wxid_synthetic_a')).toBe(true);
  expect((await syncBackend.request(`/api/contacts/${unconfirmedContact}/messages`)).data.messages).toEqual([]);

  await background.getByRole('button', { name: '关闭后台同步', exact: true }).click();
  await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  expect((await syncBackend.request('/api/sync/status')).data.sync_enabled).toBe(false);
  const stoppedReads = await syncBackend.tails();
  state.messages.wxid_synthetic_a.push({ local_id: 2, text: '关闭期间不得读取的合成消息。', create_time: timestamp + 1 });
  await syncBackend.setCli(state);
  // 显式检查经过真实同一SyncHost循环，证明成功关闭后后续周期不会新增tail。
  for (let cycle = 0; cycle < 2; cycle++) {
    const report = await syncBackend.request('/api/sync/check', {});
    expect(report.status).toBe(200);
    expect(report.data.sync_enabled).toBe(false);
  }
  expect(await syncBackend.tails()).toEqual(stoppedReads);
  expect(((await syncBackend.request(`/api/contacts/${confirmedContact}/messages`)).data.messages as { text: string }[])
    .map((message) => message.text)).toEqual(['已确认范围内的合成同步消息。']);
  expect((await syncBackend.request(`/api/contacts/${unconfirmedContact}/messages`)).data.messages).toEqual([]);
}
