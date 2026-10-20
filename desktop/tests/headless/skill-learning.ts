import { setWorkspaceContext } from '../workspace-actions';
import { declareReplyScene } from '../reply-settings-actions';
import { openImportManagement } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { withRewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';
import { confirmHelperContact } from '../foreground-confirmation-actions';

export async function skillLearning(browser: Browser, origin: string, reviewMode = false) {
  const released = ownResource();
  let fixtureChild: ChildProcess | undefined;
  const preserved = path.join(process.env.NOTALONE_LEARNING_EVIDENCE_DIR!, 'executed-' + randomUUID());
  await mkdir(preserved, { mode: 0o700 });
  const responses: Array<Promise<void>> = [];
  const assets = new Map<string, { path: string; bytes: number; sha256: string; preservedPath: string }>();
  let assetSequence = 0;
  const context = async () => {
    const value = await browser.newContext();
    value.on('response', (response) => {
      if (!response.url().startsWith(origin + '/')) return;
      responses.push(response.body().then(async (body) => {
        const pathname = new URL(response.url()).pathname;
        const preservedPath = path.join(preserved, 'browser-' + assetSequence++ + '.bin');
        await writeFile(preservedPath, body, { mode: 0o600, flag: 'wx' });
        assets.set(pathname, { path: pathname, bytes: body.length,
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
  await withRewriteFixture('notalone-learning-pages-', async (fixture) => withControllerEnvironment(fixture, async (userData) => {
    fixtureChild = fixture.child;
    let host = new PageHost(await context(), origin, userData);
    try {
      await host.backend.connect();
      let manager = await host.open('manager');
      const expectLearningReady = async (contactId: string, afterRevision = -1) => {
        await expect.poll(async () => manager.evaluate(async ({ contactId, afterRevision }) => {
          const [contacts, state] = await Promise.all([
            window.notalone.contacts.getState(), window.notalone.skillLearning.getState(),
          ]);
          return contacts.selectedContactId === contactId && state.contactId === contactId
            && state.scopeRevision === contacts.scopeRevision && state.phase === 'ready'
            && state.revision > afterRevision + 1;
        }, { contactId, afterRevision })).toBe(true);
      };
      await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: 'Skill', exact: true }).click();
      await manager.getByRole('tab', { name: /^待审核/ }).click();
      let panel = manager.getByRole('region', { name: 'Skill待审核', exact: true });
      await expect(panel.getByRole('button', { name: '开启此联系人的经验整理', exact: true })).toBeEnabled();
      await panel.getByRole('button', { name: '开启此联系人的经验整理', exact: true }).click();
      await expect(panel.getByRole('button', { name: '关闭经验整理', exact: true })).toBeEnabled();
      const prepared = await fixture.command('prepare_source');
      await expect(panel.getByRole('article')).toHaveCount(1, { timeout: 20_000 });
      await expect(panel.getByText('建议范围：当前联系人。目前只有此联系人的有限经验，待审核。', { exact: true })).toBeVisible();
      await panel.getByText('查看真实来源与私人审核依据', { exact: true }).click();
      await expect(panel.getByText('明确纠正：合成纠正：先澄清含义再作答。', { exact: true })).toBeVisible();
      await expect(panel.getByText('合成私密来话：先核对安排，再说明原因。', { exact: true })).toBeVisible();
      const beforePoll = await manager.evaluate(() => window.notalone.skillLearning.getState());
      await expect.poll(async () => {
        const state = await manager.evaluate(() => window.notalone.skillLearning.getState());
        return state.phase === 'ready' && state.revision > beforePoll.revision + 1;
      }).toBe(true);
      await expect(panel.getByText('合成私密来话：先核对安排，再说明原因。', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: '批准并发布', exact: true })).toHaveCount(0);
      expect((await fixture.command('observations')).skills).toEqual([]);
      if (reviewMode) {
        await panel.getByRole('button', { name: '打开对照审核', exact: true }).click();
        const review = manager.getByRole('region', { name: 'Skill对照审核', exact: true });
        const instruction = '先核对当前表达意愿，再说明情况；不自动补充事实或承诺。';
        await review.getByRole('textbox', { name: '方法正文', exact: true }).fill(instruction);
        const editing = await manager.evaluate(() => window.notalone.skillLearning.getState());
        await expect.poll(async () => {
          const next = await manager.evaluate(() => window.notalone.skillLearning.getState());
          return next.phase === 'ready' && next.revision > editing.revision + 1;
        }).toBe(true);
        await expect(review.getByRole('textbox', { name: '方法正文', exact: true })).toHaveValue(instruction);
        await review.getByRole('button', { name: '保存方法编辑', exact: true }).click();
        await expect(review.getByRole('button', { name: '保存方法编辑', exact: true })).toBeDisabled();
        await review.getByRole('textbox', { name: '对照来话', exact: true }).fill('合成审核情境：怎样说明自己的想法？');
        await review.getByRole('textbox', { name: '当前意图与约束', exact: true }).fill('说明想法，不作额外承诺');
        await review.getByRole('textbox', { name: '精确场景', exact: true }).fill('核对安排');
        await review.getByRole('combobox', { name: '适用范围', exact: true }).selectOption('scene');
        await review.getByRole('button', { name: '相同输入生成对照', exact: true }).click();
        const comparison = review.getByRole('region', { name: '冻结输入对照', exact: true });
        await expect(comparison.getByText('我先说明一下想法。', { exact: true })).toBeVisible();
        await expect(comparison.getByText('先核对一下，再说明我的想法。', { exact: true })).toBeVisible();
        const firstComparison = await manager.evaluate(async () => (await window.notalone.skillLearning.getState()).review!.comparison!);
        await review.getByRole('textbox', { name: '当前意图与约束', exact: true }).fill('说明想法，先核对事实，不作额外承诺');
        await expect(comparison).toHaveCount(0);
        await expect(review.getByRole('button', { name: '批准并发布', exact: true })).toBeDisabled();
        await review.getByRole('button', { name: '相同输入生成对照', exact: true }).click();
        await expect(comparison).toBeVisible();
        const nextComparison = await manager.evaluate(async () => (await window.notalone.skillLearning.getState()).review!.comparison!);
        const reviewedState = await manager.evaluate(() => window.notalone.skillLearning.getState());
        await expect.poll(async () => {
          const state = await manager.evaluate(() => window.notalone.skillLearning.getState());
          return state.phase === 'ready' && state.revision > reviewedState.revision + 1;
        }).toBe(true);
        expect((await manager.evaluate(() => window.notalone.skillLearning.getState())).review!.comparison?.comparison_id)
          .toBe(nextComparison.comparison_id);
        await expect(comparison).toBeVisible();
        expect(nextComparison.input_version).not.toBe(firstComparison.input_version);
        expect(nextComparison.scope).toEqual({ kind: 'scene', contact_id: null, scene: '核对安排' });
        expect((await fixture.command('observations')).skills).toEqual([]);
        await review.getByRole('checkbox', { name: '已核对当前意图、事实与承诺，并确认上述适用范围', exact: true }).check();
        await review.getByRole('checkbox', { name: '确认新建方法且无替代关系', exact: true }).check();
        await review.getByRole('button', { name: '批准并发布', exact: true }).click();
        await expect(review.getByRole('heading', { name: '已发布 careful-response · 版本 1', exact: true })).toBeVisible();
        const published = await manager.evaluate(async () => (await window.notalone.skillLearning.getState()).review!.published!);
        expect((await fixture.command('observations')).skills).toHaveLength(1);
        await host.close();
        expect((await fixture.command('restart_backend')).state).toBe('restarted');
        host = new PageHost(await context(), origin, userData);
        await host.backend.connect();
        manager = await host.open('manager');
        await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
        const helper = await host.open('helper');
        await confirmHelperContact(helper, fixture.data.contact_ids[0]);
        await setWorkspaceContext(helper, true);
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('说明想法，不作额外承诺');
        await declareReplyScene(helper, '核对安排');
        await helper.evaluate(async versionId => {
          const contact = await window.notalone.contacts.getState();
          await window.notalone.replies.updateSkill({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision,
            skill: { mode: 'user', versionId } });
        }, published.version_id);
        await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('先核对一下，再说明我的想法。');
        let actual = await helper.evaluate(async () => (await window.notalone.replies.getState()).result!);
        expect(actual.usedSkill).toMatchObject({ versionId: published.version_id, versionNumber: 1, scope: published.scope });
        expect(actual.input.scene).toBe('核对安排');
        await expect(helper.getByRole('region', { name: '候选回复', exact: true })).toContainText('范围：精确场景「核对安排」');
        await declareReplyScene(helper, '其他场景');
        await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我先说明一下想法。');
        actual = await helper.evaluate(async () => (await window.notalone.replies.getState()).result!);
        expect(actual.usedSkill).toBeNull();
        await manager.getByRole('button', { name: '记忆', exact: true }).click();
        await openImportManagement(manager);
        const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${prepared.source_id}"]`);
        await source.getByRole('button', { name: '删除来源', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        let queuedTaskId: string | undefined;
        try {
          await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
        } catch (error) {
          const state = await manager.evaluate(() => window.notalone.sources.getState());
          const originalTask = state.sources.find(item => item.sourceId === prepared.source_id)?.task;
          if (state.phase !== 'ready' || state.error || originalTask?.status !== 'queued') throw error;
          queuedTaskId = originalTask.taskId;
          // 全局Worker忙时保留原任务；用户显式继续，不能把202或queued当作删除完成。
          await source.getByRole('button', { name: '重试来源删除', exact: true }).click();
          await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        }
        await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
        if (queuedTaskId) expect((await manager.evaluate(() => window.notalone.sources.getState()))
          .sources.find(item => item.sourceId === prepared.source_id)!.task!.taskId).toBe(queuedTaskId);
        await manager.getByRole('button', { name: 'Skill', exact: true }).click();
        await manager.getByRole('tab', { name: /^待审核/ }).click();
        await expectLearningReady(fixture.data.contact_ids[0]);
        expect((await manager.evaluate(() => window.notalone.skillLearning.getState())).review).toBeNull();
        await expect(manager.getByRole('region', { name: 'Skill待审核', exact: true }).getByRole('article')).toHaveCount(0);
        return;
      }
      await manager.getByRole('button', { name: '联系人', exact: true }).click();
      await manager.getByRole('button', { name: '选择合成学习乙联系人', exact: true }).click();
      await manager.getByRole('button', { name: 'Skill', exact: true }).click();
      await manager.getByRole('tab', { name: /^待审核/ }).click();
      await expectLearningReady(fixture.data.contact_ids[1]);
      await expect(panel.getByRole('article')).toHaveCount(0);
      await manager.getByRole('button', { name: '联系人', exact: true }).click();
      await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: 'Skill', exact: true }).click();
      await manager.getByRole('tab', { name: /^待审核/ }).click();
      await expectLearningReady(fixture.data.contact_ids[0]);
      await expect(panel.getByRole('article')).toHaveCount(1);

      await host.close();
      expect((await fixture.command('restart_backend')).state).toBe('restarted');
      host = new PageHost(await context(), origin, userData);
      await host.backend.connect();
      manager = await host.open('manager');
      await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: 'Skill', exact: true }).click();
      await manager.getByRole('tab', { name: /^待审核/ }).click();
      panel = manager.getByRole('region', { name: 'Skill待审核', exact: true });
      await expectLearningReady(fixture.data.contact_ids[0]);
      await expect(panel.getByRole('article')).toHaveCount(1);
      await panel.getByRole('button', { name: '关闭经验整理', exact: true }).click();
      await expect(panel.getByRole('button', { name: '开启此联系人的经验整理', exact: true })).toBeEnabled();
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await openImportManagement(manager);
      const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${prepared.source_id}"]`);
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
      const beforeDeletedRead = await manager.evaluate(() => window.notalone.skillLearning.getState());
      await manager.getByRole('button', { name: 'Skill', exact: true }).click();
      await manager.getByRole('tab', { name: /^待审核/ }).click();
      await expectLearningReady(fixture.data.contact_ids[0], beforeDeletedRead.revision);
      await expect(panel.getByRole('article')).toHaveCount(0);
      const beforeRefresh = await manager.evaluate(() => window.notalone.skillLearning.getState());
      await panel.getByRole('button', { name: '刷新待审核', exact: true }).click();
      await expectLearningReady(fixture.data.contact_ids[0], beforeRefresh.revision);
      await expect(panel.getByRole('article')).toHaveCount(0);
      expect((await fixture.command('observations')).model_calls).toBe(1);
    } finally { try { await Promise.all(responses); } finally { await host.close(); } }
  }), released, path.resolve('tests/fixtures/skill-learning-page.py'), path.resolve('../backend'));
  } finally {
    await Promise.all(responses);
    await writeFile(path.join(process.env.NOTALONE_LEARNING_EVIDENCE_DIR!, 'page-assets-' + randomUUID() + '.json'),
      JSON.stringify({ runnerPid: process.pid, fixtureChildPid: fixtureChild?.pid,
        fixtureChildExitCode: fixtureChild?.exitCode, fixtureChildSignal: fixtureChild?.signalCode,
        executedArtifacts: executed, actualBrowserResponses: [...assets.values()].sort((a, b) => a.path.localeCompare(b.path)) }, null, 2),
      { mode: 0o600, flag: 'wx' });
  }
  process.stdout.write('page_test_scenario_passed: ' + (reviewMode ? 'skill-review-edit-frozen-comparison-scene-publication-actual-reply-restart-source-deletion' : 'skill-learning-consent-draft-basis-scope-restart-and-source-deletion') + '\n');
}

export async function skillReview(browser: Browser, origin: string) { await skillLearning(browser, origin, true); }
