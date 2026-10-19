import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withEventPages } from './message-events';
import { pendingCleanup } from './cleanup';

// 未保存编辑必须通知唯一主进程门禁，不能用保存后的通知代替。
export async function replyStrategyVersionEditGuard(browser: Browser, origin: string) {
  const failures: unknown[] = [];
  for (const messageNumber of [1, 2] as const) {
    const name = `恢复组编辑第${messageNumber}条消息后只提醒`;
    process.stdout.write(`page_test_scenario: ${name}\n`);
    try {
      await withEventPages(browser, origin, async ({ manager, helper, fixture }) => {
        await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
        await confirmHelperContact(helper, fixture.data.contact_ids[0]);
        await helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
        await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('只了解合成近况，不承诺安排。');
        await fixture.plan({ count: 1, message_groups: [['想问问最近怎么样。', '方便时再聊就好。']] });
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        const group = helper.getByRole('group', { name: '说法1消息组', exact: true });
        await expect(group.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true }))
          .toHaveValue('想问问最近怎么样。');
        const scope = await helper.evaluate(async () => {
          const state = await window.notalone.replies.getState();
          const scope = { contactId: state.contactId!, scopeRevision: state.scopeRevision,
            sessionId: state.savedSession!.sessionId! };
          await window.notalone.replies.selectSavedSession(scope);
          return scope;
        });
        await helper.getByRole('button', { name: '主动聊聊', exact: true }).click();
        await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想了解合成近况，还没有确认本次意愿。');
        await expect(helper.getByRole('status').filter({ hasText: '新消息提醒已连接' })).toBeVisible();
        await fixture.plan({ explore: { understanding: '编辑前已明确开启的未确认合成探索。' } });
        await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
        const directions = helper.getByRole('region', { name: '理解与方向', exact: true });
        await expect(directions).toContainText('编辑前已明确开启的未确认合成探索。');
        const prior = await helper.evaluate(async (scope) => {
          await window.notalone.replies.readSavedSession({ contactId: scope.contactId, scopeRevision: scope.scopeRevision });
          return window.notalone.replies.getState();
        }, scope);
        expect(prior.result).toBeNull();
        expect(prior.savedSession?.phase).toBe('ready');
        expect(prior.exploration.result?.sessionId).toBe(scope.sessionId);
        expect(prior.exploration.result?.confirmedIntent).toBeNull();
        const path = `/api/contacts/${scope.contactId}/assistant-sessions/${scope.sessionId}`;
        const before = await fixture.request(path);
        expect(before.status).toBe(200);
        const textbox = group.getByRole('textbox', { name: `说法1第${messageNumber}条编辑文本`, exact: true });
        const draft = `第${messageNumber}条仍未保存的合成消息编辑。`;
        await expect(textbox).toBeEnabled();
        await textbox.fill(draft);
        await fixture.plan({ explore: { understanding: '未保存编辑后不应出现的自动探索。' } });
        await fixture.command('append_burst');
        await expect(helper.getByRole('status').filter({ hasText: '当前联系人有新消息' })).toBeVisible();
        // 超过原150毫秒合并窗，再用第二次真实通知验证未悄悄重新开启。
        await new Promise((resolve) => setTimeout(resolve, 350));
        await fixture.command('append_burst');
        await new Promise((resolve) => setTimeout(resolve, 350));
        const observations = await fixture.command('observations');
        const after = await fixture.request(path);
        process.stdout.write(`page_test_version_edit_observation: ${JSON.stringify({
          messageNumber, payloadCount: (observations.payloads as unknown[]).length,
          currentUnchanged: after.data.current_input_version_id === before.data.current_input_version_id,
        })}\n`);
        expect(observations.payloads).toHaveLength(2);
        expect(after.status).toBe(200);
        expect(after.data.current_input_version_id).toBe(before.data.current_input_version_id);
        expect(after.data.turns).toEqual(before.data.turns);
        await expect(directions).toContainText('编辑前已明确开启的未确认合成探索。');
        await expect(textbox).toHaveValue(draft);
        const state = await helper.evaluate(async () => window.notalone.replies.getState());
        expect(state.exploration.result?.taskId).toBe(prior.exploration.result?.taskId);
        expect(state.candidateVersions?.items[0].history?.versions).toHaveLength(1);
      });
      process.stdout.write(`page_test_scenario_passed: ${name}\n`);
    } catch (error) {
      if (pendingCleanup.size) throw error;
      failures.push(error);
      process.stdout.write(`page_test_scenario_failed: ${name}\n`);
    }
  }
  if (failures.length) throw new AggregateError(failures, '未保存消息组编辑未满足仅提醒门禁。');
}
