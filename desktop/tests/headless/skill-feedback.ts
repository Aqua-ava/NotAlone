import { selectContact } from '../contact-picker-actions.mjs';
import { fillWorkspaceThought, generateWorkspace } from '../workspace-actions';
import { declareReplyScene } from '../reply-settings-actions';
import { openImportManagement } from '../memory-page-actions';
import { expect, type Browser } from '@playwright/test';
import path from 'node:path';
import { withRewriteFixture } from '../rewrite-backend-fixture';
import { withControllerEnvironment } from './backend-fixture';
import { ownResource } from './cleanup';
import { PageHost } from './page-host';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { BackendRequestFailure } from '../../src/main/backend/json-client';
import { createSkillFeedbackEvidenceWriter } from './skill-feedback-evidence';

export async function skillFeedback(browser: Browser, origin: string) {
  const writeGenerationEvidence = createSkillFeedbackEvidenceWriter(process.env.NOTALONE_LEARNING_EVIDENCE_DIR);
  const released = ownResource();
  await withRewriteFixture('notalone-feedback-pages-', async fixture => withControllerEnvironment(fixture, async userData => {
    let host = new PageHost(await browser.newContext(), origin, userData);
    try {
      await host.backend.connect();
      let manager = await host.open('manager');
      const open = async () => {
        await manager.getByRole('button', { name: '联系人', exact: true }).click();
        await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
        await manager.getByRole('button', { name: 'Skill', exact: true }).click();
        await manager.getByRole('tab', { name: '已有 Skill', exact: true }).click();
        await manager.getByRole('button', { name: '管理方法停用', exact: true }).click();
        return manager.getByRole('region', { name: '方法与Skill反馈', exact: true });
      };
      await manager.getByRole('button', { name: '选择合成学习甲联系人', exact: true }).click();
      await manager.getByRole('button', { name: 'Skill', exact: true }).click();
      await manager.getByRole('tab', { name: /^待审核/ }).click();
      await manager.getByRole('button', { name: '开启此联系人的经验整理', exact: true }).click();
      await expect(manager.getByRole('button', { name: '关闭经验整理', exact: true })).toBeEnabled();
      const prepared = await fixture.command('prepare_feedback');
      const helper = await host.open('helper');
      const [contactA, contactB] = fixture.data.contact_ids;
      await confirmHelperContact(helper, contactA);
      await fillWorkspaceThought(helper, '只说明我的想法，不作额外承诺');
      await declareReplyScene(helper, '核对安排');
      await helper.evaluate(async versionId => {
        const contact = await window.notalone.contacts.getState();
        await window.notalone.replies.updateSkill({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision,
          skill: { mode: 'user', versionId } });
      }, prepared.version_id as string);
      await generateWorkspace(helper);
      const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
      await expect(editor).toHaveValue('先核对一下，再说明我的想法。');
      await editor.fill('这句太生硬，我只改当前候选的说法。');
      await expect(editor).toHaveValue('这句太生硬，我只改当前候选的说法。');
      const originalRequestKey = await helper.evaluate(async () => {
        const state = await window.notalone.replies.getState();
        return state.savedSession!.turns.find(turn => turn.inputVersionId === state.result!.inputVersionId)!.requestKey;
      });
      expect((await fixture.command('observations')).policies).toEqual({ revision: 0, policies: [] });
      let panel = await open();
      await expect(panel.getByRole('button', { name: '按此范围停用', exact: true })).toBeDisabled();
      await panel.getByRole('combobox', { name: '明确停用目标', exact: true }).selectOption({ label: 'careful-response · 方法「合成被排除方法甲」' });
      await expect(panel.getByRole('button', { name: '按此范围停用', exact: true })).toBeDisabled();
      await panel.getByRole('combobox', { name: '停用范围', exact: true }).selectOption('contact_scene');
      await panel.getByRole('textbox', { name: '反馈精确场景', exact: true }).fill('核对安排');
      const policyWrites: Array<{ path: string; body: unknown }> = [];
      const realRequest = host.backend.requestJson.bind(host.backend);
      let loseResponse = true;
      // 真实HTTP已提交后丢失传输结果；业务控制器必须保留原动作身份。
      host.backend.requestJson = async request => {
        if (request.method === 'POST' && request.path.endsWith('/policies')) {
          policyWrites.push(structuredClone({ path: request.path, body: request.body }));
          const result = await realRequest(request);
          if (loseResponse) { loseResponse = false; throw new Error('合成范围决定响应丢失'); }
          return result;
        }
        return realRequest(request);
      };
      await panel.getByRole('button', { name: '按此范围停用', exact: true }).click();
      await panel.getByRole('button', { name: '重试原反馈动作', exact: true }).click();
      await expect(panel.getByRole('heading', { name: 'careful-response · 方法已停用', exact: true })).toBeVisible();
      expect(policyWrites).toHaveLength(2); expect(policyWrites[0]).toEqual(policyWrites[1]);
      const generationPrepares: Array<{ requestKey: unknown; failure?: { status: number | undefined; code: string | undefined; reason: string | undefined } }> = [];
      host.backend.requestJson = async request => {
        if (request.method !== 'POST' || !request.path.endsWith('/replies/prepare')) return realRequest(request);
        const record: typeof generationPrepares[number] = { requestKey: (request.body as Record<string, unknown>).idempotency_key };
        generationPrepares.push(record);
        try { return await realRequest(request); }
        catch (error) {
          if (error instanceof BackendRequestFailure) record.failure = { status: error.status, code: error.code, reason: error.reason };
          throw error;
        }
      };
      const captureGeneration = async (stage: 'original' | 'regenerated') => {
        const state = await helper.evaluate(async () => {
          const reply = await window.notalone.replies.getState();
          return { contactId: reply.contactId, scopeRevision: reply.scopeRevision, phase: reply.phase,
            errorCode: reply.errorCode, canRetry: reply.canRetry, scene: reply.scene,
            result: reply.result && { replyRequestId: reply.result.replyRequestId, inputVersionId: reply.result.inputVersionId,
              scene: reply.result.input.scene, executionView: reply.result.usedSkill?.executionView },
            turns: reply.savedSession?.turns.map(turn => ({ turnId: turn.turnId, inputVersionId: turn.inputVersionId,
              requestKey: turn.requestKey, state: turn.state, generationActive: turn.generationActive, requiresReprepare: turn.requiresReprepare })),
            generationJobs: reply.generationJobs };
        });
        await writeGenerationEvidence(stage, { originalRequestKey, generationPrepares, state });
      };
      await expect(editor).toHaveValue('这句太生硬，我只改当前候选的说法。');
      // 幂等与权限边界：故意经公开 bridge 重放原准备；新工作区按钮总是发起新请求。
      await helper.evaluate(async () => {
        const state = await window.notalone.replies.getState();
        await window.notalone.replies.generate({ contactId: state.contactId!, scopeRevision: state.scopeRevision, newRequest: false });
      });
      try {
        await expect.poll(async () => helper.evaluate(async () => (await window.notalone.replies.getState()).phase)).toBe('failed');
      } finally { await captureGeneration('original'); }
      expect(generationPrepares).toEqual([{ requestKey: originalRequestKey,
        failure: { status: 409, code: 'assistant_session_rejected', reason: 'skill_policy_changed' } }]);
      await expect(editor).toHaveValue('这句太生硬，我只改当前候选的说法。');
      expect((await fixture.command('observations')).reply_calls).toBe(5);
      await generateWorkspace(helper);
      try {
        await expect.poll(async () => helper.evaluate(async () =>
          (await window.notalone.replies.getState()).result?.usedSkill?.executionView?.policyRevision ?? 0)).toBeGreaterThan(0);
      } finally { await captureGeneration('regenerated'); }
      expect(generationPrepares).toHaveLength(2);
      expect(generationPrepares[1].requestKey).not.toBe(originalRequestKey);
      expect(generationPrepares[1].failure).toBeUndefined();
      host.backend.requestJson = realRequest;
      await expect(helper.getByRole('region', { name: '候选回复', exact: true })).toContainText('允许1种做法');
      const actual = await helper.evaluate(async () => (await window.notalone.replies.getState()).result!.usedSkill!);
      expect(actual.executionView!.methodIds).toHaveLength(1);
      expect((await fixture.command('feedback_observation')).excluded_text_present).toBe(false);
      await editor.fill('甲在范围停用后的独立编辑。');
      await selectContact(helper.getByRole('combobox', { name: '本次联系人', exact: true }), contactB);
      await expect.poll(async () => helper.evaluate(async () => {
        const state = await window.notalone.replies.getState();
        return { contact: state.contactId, phase: state.savedSession?.phase };
      })).toEqual({ contact: contactB, phase: 'ready' });
      await declareReplyScene(helper, '乙的独立场景');
      await selectContact(helper.getByRole('combobox', { name: '本次联系人', exact: true }), contactA);
      await expect.poll(() => helper.evaluate(async () => {
        const state = await window.notalone.replies.getState();
        return { contact: state.contactId, phase: state.savedSession?.phase, scene: state.scene };
      })).toEqual({ contact: contactA, phase: 'ready', scene: '核对安排' });
      await expect(editor).toHaveValue('甲在范围停用后的独立编辑。');
      expect((await helper.evaluate(async () => (await window.notalone.replies.getState()).result!.usedSkill!)).executionView).toEqual(actual.executionView);
      panel = await open();
      let releaseHistory!: () => void;
      let historyReached!: () => void;
      const reached = new Promise<void>(resolve => { historyReached = resolve; });
      const held = new Promise<void>(resolve => { releaseHistory = resolve; });
      let holdHistory = true;
      host.backend.requestJson = async request => {
        const result = await realRequest(request);
        if (holdHistory && request.method === 'GET' && request.path.endsWith('/skill-learning/skills')) {
          holdHistory = false; historyReached(); await held;
        }
        return result;
      };
      const refreshing = manager.evaluate(async () => {
        const contact = await window.notalone.contacts.getState();
        await window.notalone.skillLearning.refresh({ contactId: contact.selectedContactId!, scopeRevision: contact.scopeRevision });
      });
      try {
        await reached;
        await panel.getByRole('button', { name: '关闭方法反馈', exact: true }).click();
      } finally { releaseHistory(); host.backend.requestJson = realRequest; }
      await refreshing;
      await expect(panel).toHaveCount(0);
      expect((await manager.evaluate(() => window.notalone.skillLearning.getState())).policies).toBeNull();
      for (const extra of [{ scene: '其他场景' }, { scene: '核对安排', other: true }]) {
        expect((await fixture.command('feedback_reply', { version_id: prepared.version_id, ...extra })).excluded_text_present).toBe(true);
      }
      await host.close(); await fixture.command('restart_backend');
      host = new PageHost(await browser.newContext(), origin, userData);
      await host.backend.connect(); manager = await host.open('manager'); panel = await open();
      await expect(panel.getByRole('heading', { name: 'careful-response · 方法已停用', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: '撤销此停用', exact: true }).click();
      await expect(panel.getByText('当前没有明确停用的范围决定。', { exact: true })).toBeVisible();
      expect((await fixture.command('feedback_reply', { version_id: prepared.version_id, scene: '核对安排' })).excluded_text_present).toBe(true);
      await panel.getByRole('combobox', { name: '明确停用目标', exact: true }).selectOption({ label: 'careful-response · 整个Skill' });
      await panel.getByRole('combobox', { name: '停用范围', exact: true }).selectOption('owner');
      await panel.getByRole('button', { name: '按此范围停用', exact: true }).click();
      await expect(panel.getByRole('heading', { name: 'careful-response · 整个Skill已停用', exact: true })).toBeVisible();
      for (const other of [false, true]) expect((await fixture.command('feedback_reply', { version_id: prepared.version_id, other })).used).toBe(false);
      await manager.getByRole('button', { name: '记忆', exact: true }).click();
      await openImportManagement(manager);
      const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${prepared.source_id}"]`);
      await source.getByRole('button', { name: '删除来源', exact: true }).click();
      await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
      try { await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible(); }
      catch (error) {
        const state = await manager.evaluate(() => window.notalone.sources.getState());
        if (state.phase !== 'ready' || state.error || state.sources.find(item => item.sourceId === prepared.source_id)?.task?.status !== 'queued') throw error;
        await source.getByRole('button', { name: '重试来源删除', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
      }
      await manager.getByRole('button', { name: 'Skill', exact: true }).click();
      await manager.getByRole('tab', { name: '已有 Skill', exact: true }).click();
      await expect(manager.getByRole('region', { name: 'Skill版本历史', exact: true })).toContainText('当前没有可查看的有效发布版本。');
      await manager.getByRole('button', { name: '管理方法停用', exact: true }).click();
      panel = manager.getByRole('region', { name: '方法与Skill反馈', exact: true });
      await panel.getByRole('button', { name: '撤销此停用', exact: true }).click();
      await expect(panel.getByText('当前没有明确停用的范围决定。', { exact: true })).toBeVisible();
    } finally { await host.close(); }
  }), released, path.resolve('tests/fixtures/skill-learning-page.py'), path.resolve('../backend'));
  process.stdout.write('page_test_scenario_passed: skill-feedback-current-edit-explicit-scopes-unknown-retry-late-poll-contact-scene-restore-real-view-undo-restart-source-erasure\n');
}
