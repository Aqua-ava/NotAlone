import { workspaceInput, fillWorkspaceThought, fillWorkspaceInstruction, generateWorkspace } from '../workspace-actions';
import { selectMemoryCategory } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';

// 沿已有单Chrome租约、生产React和具名控制器验证；不使用Electron或原生能力。
export async function expressionPreferences(browser: Browser, origin: string) {
  const released = ownResource();
  let fixtureChild: ChildProcess | undefined;
  const responses: Array<Promise<void>> = [], assets = new Map<string, { path: string; bytes: number; sha256: string }>();
  const context = async () => {
    const value = await browser.newContext();
    value.on('response', (response) => {
      if (!response.url().startsWith(`${origin}/`)) return;
      responses.push(response.body().then((body) => {
        const pathname = new URL(response.url()).pathname;
        assets.set(pathname, { path: pathname, bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex') });
      }));
    });
    return value;
  };
  const executed = await Promise.all([process.argv[1], path.resolve('artifacts/headless-runtime/renderer.js')]
    .map(async (file) => { const content = await readFile(file); return { path: file, bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex') }; }));
  try {
  await withRewriteFixture('notalone-preference-pages-', async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    fixtureChild = fixture.child;
    const [contactId, otherContactId] = fixture.data.contact_ids;
    let host = new PageHost(await context(), origin, userData);
    try {
      await host.backend.connect();
      let helper = await host.open('helper');
      await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactId);
      await confirmHelperContact(helper, contactId);
      await helper.getByText('长期表达偏好', { exact: true }).click();
      let panel = helper.locator('#assistant-expression-preferences');
      let directory = panel.getByRole('list', { name: '长期表达偏好目录', exact: true });
      await expect(panel.getByRole('checkbox', { name: '明确长期保存', exact: true })).not.toBeChecked();
      await panel.getByRole('textbox', { name: '长期表达要求', exact: true }).fill('平时尽量用短句。');
      await panel.getByRole('combobox', { name: '适用输入模式', exact: true }).selectOption('rewrite_draft');
      await panel.getByRole('checkbox', { name: '明确长期保存', exact: true }).check();
      await panel.getByRole('button', { name: '确认保存长期偏好', exact: true }).click();
      await expect(directory.getByText('平时尽量用短句。', { exact: true })).toBeVisible();
      await fillWorkspaceThought(helper, '好的，收到安排，我会再核对具体内容。');
      expect((await fixture.command('pause_response')).state).toBe('paused');
      let waiting: Record<string, unknown>;
      try {
        await generateWorkspace(helper);
        expect((await fixture.command('await_model')).started_calls).toBe(1);
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
        waiting = await fixture.command('observations');
        expect(waiting.model_calls).toBe(0);
        expect(waiting.turns).toMatchObject([{ state: 'running', schema_revision: 9, preference_revisions: [1] }]);
        await panel.getByRole('button', { name: '修改长期偏好：平时尽量用短句。', exact: true }).click();
        await panel.getByRole('textbox', { name: '长期表达要求', exact: true }).fill('恢复时明确修改的合成表达要求。');
        await panel.getByRole('checkbox', { name: '明确长期保存', exact: true }).check();
        await panel.getByRole('button', { name: '确认修改长期偏好', exact: true }).click();
        await expect(directory.getByText('恢复时明确修改的合成表达要求。', { exact: true })).toBeVisible();
      } finally { await fixture.command('release_response'); }
      await expect(helper.getByText('旧准备已停止，已填写内容仍会保留。请明确重新准备后生成。', { exact: true })).toBeVisible();
      await host.awaitPendingCommands();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      await expect(workspaceInput(helper)).toHaveValue('好的，收到安排，我会再核对具体内容。');
      const rejected = await fixture.command('observations');
      expect(rejected.model_calls).toBe(1); expect(rejected.started_calls).toBe(1);
      const waitingTurns = waiting.turns as Array<{ request_key: string }>;
      const rejectedTurns = rejected.turns as Array<{ request_key: string }>;
      expect(rejectedTurns).toHaveLength(1); expect(rejectedTurns[0].request_key).toBe(waitingTurns[0].request_key);
      expect(rejectedTurns[0]).toMatchObject({ state: 'failed' });
      await helper.getByRole('button', { name: '核对旧准备并重新生成', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('好。');
      const basis = panel.getByLabel('生成时使用的长期表达偏好', { exact: true });
      await expect(basis.getByText('恢复时明确修改的合成表达要求。', { exact: true })).toBeVisible();
      await expect(basis).toContainText('生成时版本2');
      const regenerated = await fixture.command('observations');
      expect(regenerated.model_calls).toBe(2); expect(regenerated.started_calls).toBe(2);
      const freshTurns = regenerated.turns as Array<{ request_key: string }>;
      expect(freshTurns).toHaveLength(2); expect(freshTurns[1].request_key).not.toBe(waitingTurns[0].request_key);
      expect(freshTurns[1]).toMatchObject({ state: 'completed', schema_revision: 9, preference_revisions: [2] });
      process.stdout.write('page_test_step: expression-preferences-first-rejected-explicit-reprepare-revision2-complete\n');
      await fillWorkspaceInstruction(helper, '这次详细说明，保留两句话。');
      await generateWorkspace(helper);
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
        .toHaveValue('好的，收到安排。我会再核对具体内容。');
      await expect(directory.getByRole('listitem')).toHaveCount(1);
      await panel.getByRole('button', { name: '修改长期偏好：恢复时明确修改的合成表达要求。', exact: true }).click();
      await expect(panel.getByRole('checkbox', { name: '明确长期保存', exact: true })).not.toBeChecked();
      await panel.getByRole('textbox', { name: '长期表达要求', exact: true }).fill('长期保留自然称呼。');
      await panel.getByRole('checkbox', { name: '明确长期保存', exact: true }).check();
      await panel.getByRole('button', { name: '确认修改长期偏好', exact: true }).click();
      await expect(directory.getByText('长期保留自然称呼。', { exact: true })).toBeVisible();
      await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(otherContactId);
      await expect(directory.getByRole('listitem')).toHaveCount(0);
      await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactId);
      await expect(directory.getByText('长期保留自然称呼。', { exact: true })).toBeVisible();

      process.stdout.write('page_test_step: expression-preferences-management-and-scope-complete\n');
      await host.close();
      expect((await fixture.command('restart_backend')).state).toBe('restarted');
      host = new PageHost(await context(), origin, userData);
      await host.backend.connect();
      helper = await host.open('helper');
      await helper.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactId);
      await confirmHelperContact(helper, contactId);
      await helper.getByText('长期表达偏好', { exact: true }).click();
      panel = helper.locator('#assistant-expression-preferences');
      directory = panel.getByRole('list', { name: '长期表达偏好目录', exact: true });
      await expect(directory.getByText('长期保留自然称呼。', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '删除长期偏好：长期保留自然称呼。', exact: true }).click();
      await expect(directory.getByRole('listitem')).toHaveCount(0);

      const prepared = await fixture.command('prepare_source');
      await panel.getByRole('button', { name: '刷新长期偏好', exact: true }).click();
      await expect(directory.getByText('有来源的合成表达要求。', { exact: true })).toBeVisible();
      const manager = await host.open('manager');
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await selectMemoryCategory(manager, '来源与过程');
      const source = manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('listitem')
        .filter({ hasText: `来源标识：${prepared.source_id}` });
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
      await expect(directory.getByRole('listitem')).toHaveCount(0);
      await panel.getByRole('button', { name: '刷新长期偏好', exact: true }).click();
      await expect(directory.getByRole('listitem')).toHaveCount(0);
      expect((await fixture.command('observations')).model_calls).toBe(3);
    } finally { try { await Promise.all(responses); } finally { await host.close(); } }
  }), released, path.resolve('tests/fixtures/expression-preferences-page.py'), path.resolve('../backend'));
  } finally {
    await Promise.all(responses);
    await writeFile(path.join(process.env.NOTALONE_PREFERENCE_EVIDENCE_DIR!, `page-assets-${randomUUID()}.json`),
      JSON.stringify({ runnerPid: process.pid, fixtureChildPid: fixtureChild?.pid,
        fixtureChildExitCode: fixtureChild?.exitCode, fixtureChildSignal: fixtureChild?.signalCode, executedArtifacts: executed,
        actualBrowserResponses: [...assets.values()].sort((a, b) => a.path.localeCompare(b.path)) }, null, 2),
      { mode: 0o600, flag: 'wx' });
  }
  process.stdout.write('page_test_scenario_passed: expression-preferences-explicit-reprepare-management-intent-scope-recovery-and-deletion\n');
}
