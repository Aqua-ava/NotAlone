import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';

export async function replyStrategyOptions(browser: Browser, origin: string) {
  for (const scene of ['回应消息', '主动聊聊']) {
    process.stdout.write(`page_test_scenario: ${scene}换组、拒绝旧选择、暂不回应与自填方向\n`);
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      const contactId = rewriteBackend.data.contact_ids[0];
      await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
      await confirmHelperContact(helper, contactId);
      await helper.getByRole('button', { name: scene, exact: true }).click();
      if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
      else await helper.getByRole('textbox', { name: '主动目的', exact: true }).fill('想聊聊，还没有决定本次意愿。');
      await rewriteBackend.plan({ explore: {} });
      await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
      await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toBeVisible();
      const first = replyTransport.explorationResults.at(-1)!.data;
      expect(first.confirmed_intent).toBeNull();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      await rewriteBackend.plan({ explore: { understanding: '这次提供另一组不同的意愿。', options: [
        { label: '只确认收到', intent: '只确认收到消息，不承诺等待或之后联系。', reason: '希望只说明收到时适用。' },
        { label: '说明今天忙', intent: '说明自己今天忙，不决定下一次联系。', reason: '想说明自己的状态时适用。' },
        { label: '本次先停下', intent: '本次先不联系，由自己之后决定。', reason: '仍未决定时可以停下。', pause: true },
      ] } });
      await helper.getByRole('button', { name: '换一组方向', exact: true }).click();
      await expect(helper.getByRole('region', { name: '理解与方向', exact: true })).toContainText('这次提供另一组不同的意愿。');
      await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toHaveCount(0);
      const latest = replyTransport.explorationResults.at(-1)!.data;
      expect(latest.input_version_id).not.toBe(first.input_version_id);
      expect(latest.confirmed_intent).toBeNull();
      const old = (first.options as Array<{ suggestion_id: string }>)[0];
      const rejected = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${first.session_id}/explorations/${first.exploration_id}/confirm`, {
        input_version_id: first.input_version_id, suggestion_id: old.suggestion_id,
      });
      expect(rejected.status).toBe(409);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
      await helper.getByRole('button', { name: '确认方向：本次先停下', exact: true }).click();
      await expect(helper.getByRole('region', { name: '理解与方向', exact: true }).getByRole('status')).toContainText('本次已暂停');
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(2);
      const paused = await rewriteBackend.request(`/api/contacts/${contactId}/assistant-sessions/${latest.session_id}/explorations/${latest.exploration_id}`);
      expect(paused.status).toBe(409);
      const input = scene === '回应消息' ? '表达方向' : '主动目的';
      await helper.getByRole('textbox', { name: input, exact: true }).fill('只说明本次收到了消息，不安排后续。');
      await rewriteBackend.plan({ count: 1, prefix: '我已收到，先到这里' });
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我已收到，先到这里（说法1）。');
      expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
      expect(replyTransport.requests.at(-1)).toMatchObject({ content: scene === '回应消息'
        ? { direction: '只说明本次收到了消息，不安排后续。', direction_source: 'direct_input' }
        : { purpose: '只说明本次收到了消息，不安排后续。' } });
    });
  }
}
