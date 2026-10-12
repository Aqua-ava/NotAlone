import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test, initialCliState } from './binding-fixture';
import { selectMenu } from './app-fixture';
import { syncSwitchStopsReading } from './sync-page-scenarios';
import { syncBackfillRetriesConfirmedScope } from './sync-backfill-page-scenarios';
import { syncArgumentsPreserveStoppedScope } from './sync-arguments-page-scenarios';

test.skip(process.env.NOTALONE_MAC_DELIVERY_ACCEPTANCE !== '1', '只在主Agent有限交付验收时段执行');

const cases = [
  ['签名包同步总开关只读取确认范围，关闭后后续检查停读', syncSwitchStopsReading],
  ['签名包补齐暂停／失败／重试保留原确认范围和游标', syncBackfillRetriesConfirmedScope],
  ['签名包真实IPC拒绝小窗／额外参数／旧范围的同步操作', syncArgumentsPreserveStoppedScope],
] as const;

for (const [name, scenario] of cases) {
  test(name, async ({ runningApp: { app, appProcess, userData }, bindingBackend, bindingProxy }) => {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await writeFile(test.info().outputPath('owned-runtime.json'), JSON.stringify({
      appPid: appProcess.pid, userData, fixtureDirectory: bindingBackend.directory,
      backendPid: bindingBackend.cleanupOwnership().childPid, databaseName: bindingBackend.data.database_name,
    }), { mode: 0o600 });
    await scenario({ manager: await app.firstWindow(), syncBackend: bindingBackend });
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    expect(bindingProxy.authenticatedRuntimeStopped).toBe(true);
    await writeFile(test.info().outputPath('sync-native-results.json'), JSON.stringify({
      packaged: true, scenario: name, normalQuit: true, authenticatedStopped: true,
      controlledSyntheticCli: true, realWechatRead: false, ocrRun: false,
    }), { mode: 0o600 });
  });
}

test('签名包同步开启时正常退出，认证停读及自有后端退场后不再读取',
  async ({ runningApp: { app, appProcess, userData }, bindingBackend, bindingProxy }) => {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const backendPid = bindingBackend.cleanupOwnership().childPid!;
    await writeFile(test.info().outputPath('owned-runtime.json'), JSON.stringify({
      appPid: appProcess.pid, userData, fixtureDirectory: bindingBackend.directory,
      backendPid, databaseName: bindingBackend.data.database_name,
    }), { mode: 0o600 });
    const contact = bindingBackend.data.contact_ids[0];
    expect((await bindingBackend.request('/api/sync/cli-bindings/confirm', {
      selections: [{ locator: 'wxid_synthetic_a', contact_id: contact }],
    })).status).toBe(200);
    const state = initialCliState();
    const timestamp = Math.floor(Date.now() / 1000) + 10;
    state.sessions.forEach((session) => { session.last_timestamp = timestamp; });
    state.messages.wxid_synthetic_a = [{ local_id: 1, text: '退出前确认入库的合成消息。', create_time: timestamp }];
    await bindingBackend.setCli(state);
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '同步设置', exact: true }).click();
    await manager.getByRole('button', { name: '开启后台同步', exact: true }).click();
    await expect.poll(async () => (await bindingBackend.request(`/api/contacts/${contact}/messages`)).data.messages)
      .toEqual([expect.objectContaining({ text: '退出前确认入库的合成消息。' })]);
    const before = await bindingBackend.tails();
    expect(before.length).toBeGreaterThan(0);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode).toBe(0);
    expect(bindingProxy.authenticatedRuntimeStopped).toBe(true);
    await expect.poll(() => {
      try { process.kill(backendPid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }).toBe(true);
    const stoppedReads = await bindingBackend.tails();
    expect(stoppedReads.length).toBeGreaterThanOrEqual(before.length);
    state.messages.wxid_synthetic_a.push({ local_id: 2, text: '退出后不应读取的合成消息。', create_time: timestamp + 1 });
    await bindingBackend.setCli(state);
    expect(await bindingBackend.tails()).toEqual(stoppedReads);
    await writeFile(test.info().outputPath('sync-native-results.json'), JSON.stringify({
      packaged: true, normalQuit: true, authenticatedStopped: true, backendGone: true,
      readsBeforeQuit: before.length, readsAtConfirmedStop: stoppedReads.length, readsAfterConfirmedStop: stoppedReads.length,
      controlledSyntheticCli: true, realWechatRead: false, ocrRun: false,
    }), { mode: 0o600 });
  });
