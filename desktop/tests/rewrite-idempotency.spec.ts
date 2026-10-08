import { expect } from '@playwright/test';
import { test } from './rewrite-transport-fixture';

test('丢失响应后同键恢复原候选，编辑不被重放覆盖，新输入和重新生成使用新键', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('今晚我会晚一点回复你。');
  await rewriteBackend.plan({ count: 1 });
  replyTransport.nextReply = 'drop';
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('alert')).toContainText('未收到生成结果');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你（说法1）。');
  expect(replyTransport.requests[0]).toEqual(replyTransport.requests[1]);
  expect(replyTransport.results[0].data).toEqual(replyTransport.results[1].data);
  await helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }).fill('我忙完再回复你。');
  await helper.getByRole('button', { name: '重试同一次生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我忙完再回复你。');
  await expect.poll(() => replyTransport.results.length).toBe(3);
  expect(replyTransport.results[2].data).toEqual(replyTransport.results[0].data);
  const requestId = replyTransport.results[0].data.reply_request_id;
  const evidence = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/replies/${requestId}/evidence`);
  expect(evidence.status).toBe(200);
  expect(evidence.data.evidence).toEqual([expect.objectContaining({ kind: 'user_draft', text: '今晚我会晚一点回复你。' })]);
  await rewriteBackend.plan({ count: 3, prefix: '新生成的说法' });
  await helper.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选3编辑文本', exact: true })).toHaveValue('新生成的说法（说法3）。');
  expect(replyTransport.requests[3].idempotency_key).not.toBe(replyTransport.requests[0].idempotency_key);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('明天我会晚一点回复你。');
  await helper.getByRole('combobox', { name: '本次语气', exact: true }).selectOption('warm');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('只说明时间，不增加承诺');
  await rewriteBackend.plan({ count: 1, prefix: '新输入的说法' });
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('新输入的说法（说法1）。');
  expect(replyTransport.requests[4].idempotency_key).not.toBe(replyTransport.requests[3].idempotency_key);
  expect(replyTransport.requests[4]).toMatchObject({ contact_id: rewriteBackend.data.contact_ids[0], content: {
    type: 'rewrite_draft', draft_text: '明天我会晚一点回复你。', include_relationship_context: false,
    user_instruction: '本次语气自然温和。\n只说明时间，不增加承诺',
  } });
  const observations = await rewriteBackend.command('observations');
  expect(observations.payloads).toHaveLength(3);
});
