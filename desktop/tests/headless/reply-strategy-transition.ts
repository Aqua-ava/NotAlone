import { expect, type Browser } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import { withRewritePages } from './rewrite-acceptance';
import { pendingCleanup } from './cleanup';

export async function replyStrategyTransition(browser: Browser, origin: string) {
  const failures: string[] = [];
  for (const scene of ['回应消息', '主动聊聊']) {
    process.stdout.write(`page_test_scenario: ${scene}普通生成后确认新意愿并再次普通生成\n`);
    let scenarioFailure: unknown;
    await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend, replyTransport }) => {
      try {
        const contactId = rewriteBackend.data.contact_ids[0];
        await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
        await confirmHelperContact(helper, contactId);
        await helper.getByRole('button', { name: scene, exact: true }).click();
        if (scene === '回应消息') await helper.getByRole('radio', { name: /甲的私密合成历史/ }).click();
        await helper.getByRole('textbox', { name: scene === '回应消息' ? '表达方向' : '主动目的', exact: true })
          .fill('只说明本次收到消息，不继续等待。');
        await rewriteBackend.plan({ count: 1, prefix: '普通生成意愿A' });
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('普通生成意愿A（说法1）。');
        const oldRequest = replyTransport.requests.at(-1)!;
        const oldResult = replyTransport.results.at(-1)!;
        await rewriteBackend.plan({ explore: {} });
        await helper.getByRole('button', { name: '帮我理清方向', exact: true }).click();
        await expect(helper.getByRole('button', { name: '确认方向：愿意等待', exact: true })).toBeVisible();
        await rewriteBackend.plan({ count: 1, prefix: '探索确认意愿B' });
        await helper.getByRole('button', { name: '确认方向：愿意等待', exact: true }).click();
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('探索确认意愿B（说法1）。');
        await expect(helper.getByRole('textbox', { name: scene === '回应消息' ? '表达方向' : '主动目的', exact: true }))
          .toHaveValue('表示愿意等待，但不增加承诺。');
        expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
        const confirmed = replyTransport.explorationResults.at(-1)!;
        const confirmRequest = replyTransport.explorationRequests.at(-1);
        const confirmCount = replyTransport.explorationResults.length;
        await helper.getByRole('button', { name: '重试策略操作', exact: true }).click();
        await expect.poll(() => replyTransport.explorationResults.length).toBe(confirmCount + 1);
        expect(replyTransport.explorationRequests.at(-1)).toEqual(confirmRequest);
        expect(replyTransport.explorationResults.at(-1)).toEqual(confirmed);
        expect((await rewriteBackend.command('observations')).payloads).toHaveLength(3);
        // 此间不编辑任何输入，避免已有输入失效回调掩盖旧普通attempt复活。
        await rewriteBackend.plan({ count: 1, prefix: '普通生成继续意愿B' });
        await helper.getByRole('button', { name: '生成候选', exact: true }).click();
        await expect.poll(() => replyTransport.requests.length).toBe(2);
        const nextRequest = replyTransport.requests.at(-1)!;
        expect(nextRequest.idempotency_key).not.toBe(oldRequest.idempotency_key);
        expect(nextRequest).toMatchObject({ skill_disabled: true, content: scene === '回应消息'
          ? { direction: '表示愿意等待，但不增加承诺。' } : { purpose: '表示愿意等待，但不增加承诺。' } });
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('普通生成继续意愿B（说法1）。');
        const nextResult = replyTransport.results.at(-1)!;
        expect(nextResult.data.reply_request_id).not.toBe(oldResult.data.reply_request_id);
        const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
        expect(payloads).toHaveLength(4);
        expect(payloads.at(-1)).toMatchObject({ fidelity_contract: { current_intent: { text: '表示愿意等待，但不增加承诺。' } } });
        await helper.getByRole('button', { name: scene === '回应消息' ? '重试同一次生成' : '生成候选', exact: true }).click();
        await expect.poll(() => replyTransport.results.length).toBe(3);
        expect(replyTransport.requests.at(-1)).toEqual(nextRequest);
        expect(replyTransport.results.at(-1)).toEqual(nextResult);
        expect((await rewriteBackend.command('observations')).payloads).toHaveLength(4);
      } catch (error) { scenarioFailure = error; }
    });
    // 夹具收尾错误在上方直接透传；只有已完整收尾的页面断言才允许汇总。
    if (pendingCleanup.size) throw new Error('本场收尾尚未确认，停止后续场景。');
    if (scenarioFailure) failures.push(`${scene}: ${scenarioFailure instanceof Error ? scenarioFailure.message : String(scenarioFailure)}`);
    else process.stdout.write(`page_test_scenario_passed: ${scene}普通与探索请求边界\n`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
