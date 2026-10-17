import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { withRewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';
import type { MemoryUpgradeState } from '../../src/shared/memory-upgrade-bridge';

export async function memoryUpgrade(browser: Browser, origin: string) {
  const released = ownResource();
  let fixtureChild: ChildProcess | undefined;
  const preserved = path.join(process.env.NOTALONE_UPGRADE_EVIDENCE_DIR!, 'executed-' + randomUUID());
  await mkdir(preserved, { mode: 0o700 });
  const responses: Array<Promise<void>> = [];
  const assets: Array<{ path: string; bytes: number; sha256: string; preservedPath: string }> = [];
  let assetSequence = 0;
  const context = async () => {
    const value = await browser.newContext();
    value.on('response', response => {
      if (!response.url().startsWith(origin + '/')) return;
      const sequence = assetSequence++;
      responses.push(response.body().then(async body => {
        const preservedPath = path.join(preserved, 'browser-' + sequence + '.bin');
        await writeFile(preservedPath, body, { mode: 0o600, flag: 'wx' });
        assets.push({ path: new URL(response.url()).pathname, bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'), preservedPath });
      }));
    });
    return value;
  };
  const executed = await Promise.all([process.argv[1], path.resolve('artifacts/headless-runtime/renderer.js')]
    .map(async (file, index) => {
      const body = await readFile(file);
      const preservedPath = path.join(preserved, 'artifact-' + index + '.bin');
      await writeFile(preservedPath, body, { mode: 0o600, flag: 'wx' });
      return { path: file, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), preservedPath };
    }));
  try {
  await withRewriteFixture('notalone-upgrade-pages-', async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    fixtureChild = fixture.child;
    let host = new PageHost(await context(), origin, userData);
    try {
      await host.backend.connect();
      let manager = await host.open('manager');
      const expectUpgradeReady = async (afterRevision = -1) => {
        let verified: MemoryUpgradeState | undefined;
        await expect.poll(async () => {
          const { contacts, state } = await manager.evaluate(async () => ({
            contacts: await window.notalone.contacts.getState(), state: await window.notalone.memoryUpgrade.getState(),
          }));
          const contactId = fixture.data.contact_ids[0];
          const ready = contacts.selectedContactId === contactId && state.kind === 'contact'
            && state.contactId === contactId && state.scopeRevision === contacts.scopeRevision
            && state.phase === 'ready' && state.revision > afterRevision + 1;
          if (ready) verified = state;
          return ready;
        }).toBe(true);
        return verified!;
      };
      const expectMaterialCounts = async (pending: number) => {
        const observations = await fixture.command('observations');
        expect(observations.pending_candidates).toBe(pending);
        expect(observations.manual_unchanged).toBe(true);
        return observations;
      };
      await manager.getByRole('button', { name: '选择合成升级甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: '旧资料升级', exact: true }).click();
      let panel = manager.getByRole('region', { name: '旧资料升级', exact: true });
      await expectUpgradeReady();
      await expect(panel.getByText('尚无升级工作。不会自动重跑历史资料。', { exact: true })).toBeVisible();
      expect((await expectMaterialCounts(0)).model_calls).toBe(0);
      await panel.getByRole('spinbutton', { name: '总消息上限', exact: true }).fill('1');
      await panel.getByRole('spinbutton', { name: '每批消息上限', exact: true }).fill('1');
      await panel.getByRole('spinbutton', { name: '总模型调用上限', exact: true }).fill('4');
      await expect(panel.getByRole('button', { name: '确认范围与预算并比较', exact: true })).toBeDisabled();
      await panel.getByRole('checkbox', { name: '我确认此范围和预算，先生成差异预览', exact: true }).check();
      await panel.getByRole('button', { name: '确认范围与预算并比较', exact: true }).click();
      let card = panel.getByRole('article', { name: '升级工作', exact: true });
      await expect(card.getByText('批次 1 · 等待批准', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(card.getByText('旧资料：合成旧人工事实：联系人喜欢合成白茶。', { exact: true })).toBeVisible();
      await expect(card.getByText(/旧版证明未知/)).toBeVisible();
      await expect(card.getByText('预计加入待确认', { exact: true })).toBeVisible();
      await expectMaterialCounts(0);
      const preview = await expectUpgradeReady();
      expect(preview.jobs).toHaveLength(1);
      const originalJob = preview.jobs[0];
      const originalBatch = originalJob.batches[0];
      expect(originalBatch.state).toBe('ready');
      expect(originalJob.algorithm).not.toBeNull();
      expect(originalJob.algorithm?.protocol).toContain('grounded-labels-v3');
      expect(originalBatch.algorithm).toEqual(originalJob.algorithm);
      await expect(card.getByText(/比较算法：/)).toContainText(originalJob.algorithm!.digest);
      await card.getByRole('checkbox', { name: '选择批次 1', exact: true }).check();
      const beforePoll = await manager.evaluate(async () => (await window.notalone.memoryUpgrade.getState()).revision);
      const polled = await expectUpgradeReady(beforePoll);
      const polledJob = polled.jobs.find(job => job.job_id === originalJob.job_id)!;
      expect(polledJob.revision).toBe(originalJob.revision);
      expect(polledJob.batches.find(batch => batch.batch_id === originalBatch.batch_id)?.revision).toBe(originalBatch.revision);
      await expect(card.getByRole('checkbox', { name: '选择批次 1', exact: true })).toBeChecked();
      await card.getByRole('button', { name: '确认应用所选批次', exact: true }).click();
      await expect(card.getByText('批次 1 · 已应用', { exact: true })).toBeVisible();
      await expectMaterialCounts(1);

      await host.close();
      expect((await fixture.command('restart_backend')).state).toBe('restarted');
      host = new PageHost(await context(), origin, userData);
      await host.backend.connect();
      manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成升级甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: '旧资料升级', exact: true }).click();
      panel = manager.getByRole('region', { name: '旧资料升级', exact: true });
      card = panel.getByRole('article', { name: '升级工作', exact: true });
      await expect(card.getByText('批次 1 · 已应用', { exact: true })).toBeVisible();
      const restored = await expectUpgradeReady();
      expect(restored.jobs.find(job => job.job_id === originalJob.job_id)?.batches
        .find(batch => batch.batch_id === originalBatch.batch_id)?.state).toBe('applied');
      await card.getByRole('checkbox', { name: '选择批次 1', exact: true }).check();
      await card.getByRole('button', { name: '确认撤销所选批次', exact: true }).click();
      await expect(card.getByText('批次 1 · 已撤销', { exact: true })).toBeVisible();
      await expectMaterialCounts(0);
      await panel.getByRole('spinbutton', { name: '总消息上限', exact: true }).fill('1');
      await panel.getByRole('spinbutton', { name: '每批消息上限', exact: true }).fill('1');
      await panel.getByRole('spinbutton', { name: '总模型调用上限', exact: true }).fill('4');
      await panel.getByRole('checkbox', { name: '我确认此范围和预算，先生成差异预览', exact: true }).check();
      await panel.getByRole('button', { name: '确认范围与预算并比较', exact: true }).click();
      await expect(panel.getByText('预计加入待确认', { exact: true })).toBeVisible();
      const secondPreview = await expectUpgradeReady();
      const secondJob = secondPreview.jobs.find(job => job.job_id !== originalJob.job_id)!;
      const secondBatch = secondJob.batches.find(batch => batch.state === 'ready')!;
      expect(secondBatch.comparison).not.toBeNull();
      const observations = await expectMaterialCounts(0);
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '来源与过程');
      const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
        .filter({ hasText: `来源标识：${observations.source_id}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
      const beforeDeletedRead = await manager.evaluate(() => window.notalone.memoryUpgrade.getState());
      await manager.getByRole('button', { name: '旧资料升级', exact: true }).click();
      const deleted = await expectUpgradeReady(beforeDeletedRead.revision);
      const deletedBatch = deleted.jobs.find(job => job.job_id === secondJob.job_id)!.batches
        .find(batch => batch.batch_id === secondBatch.batch_id)!;
      expect(deletedBatch.state).toBe('invalidated');
      expect(deletedBatch.comparison).toBeNull();
      expect(deletedBatch.revision).toBeGreaterThan(secondBatch.revision);
      await expect(panel.getByText('预计加入待确认', { exact: true })).toHaveCount(0);
      expect((await expectMaterialCounts(0)).model_calls).toBe(4);
    } finally { try { await Promise.all(responses); } finally { await host.close(); } }
  }), released, path.resolve('tests/fixtures/memory-upgrade-page.py'), path.resolve('../backend'));
  } finally {
    await Promise.all(responses);
    await writeFile(path.join(process.env.NOTALONE_UPGRADE_EVIDENCE_DIR!, 'page-assets-' + randomUUID() + '.json'),
      JSON.stringify({ runnerPid: process.pid, fixtureChildPid: fixtureChild?.pid,
        fixtureChildExitCode: fixtureChild?.exitCode, fixtureChildSignal: fixtureChild?.signalCode,
        executedArtifacts: executed, actualBrowserResponses: assets.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2),
      { mode: 0o600, flag: 'wx' });
  }
  process.stdout.write('page_test_scenario_passed: memory-upgrade-explicit-budget-preview-apply-poll-restart-undo-source-deletion\n');
}
