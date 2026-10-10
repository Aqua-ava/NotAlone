import { expect, type Browser } from '@playwright/test';
import { withRewritePages } from './rewrite-acceptance';
import { confirmHelperContact } from '../foreground-confirmation-actions';

// 复用生产controller/具名桥接与HTTP/随机PG，复制只替换必要宿主I/O。
export async function styleSamples(browser: Browser, origin: string) {
  const copies: string[] = [];
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByText('我的表达样本', { exact: true }).click();
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('合成当前草稿。');
    await rewriteBackend.plan({ count: 1, prefix: '合成样本候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('合成样本候选（说法1）。');
    await editor.fill('用户主动选定的合成最终表达。');
    await helper.getByRole('radio', { name: '说法 1', exact: true }).check();
    await helper.getByRole('button', { name: '复制', exact: true }).click();
    await expect.poll(() => copies.length).toBe(1);
    await helper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.length)).toBe(0);
    await helper.getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
    await expect(helper.getByText('用户主动选定的合成最终表达。', { exact: true })).toBeVisible();
    await expect(helper.getByText('候选衍生，保留来源依赖 · 发送状态未知', { exact: true })).toBeVisible();
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill('独立手工合成样本。');
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(helper.getByText('独立手工合成样本。', { exact: true })).toBeVisible();
    await expect(helper.getByRole('textbox', { name: '手工表达样本', exact: true })).toHaveValue('');
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill('用户主动选定的合成最终表达。');
    await helper.getByRole('button', { name: '删除表达样本：用户主动选定的合成最终表达。', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '手工表达样本', exact: true })).toHaveValue('');
    await expect(helper.getByText('用户主动选定的合成最终表达。', { exact: true })).toHaveCount(0);
    await helper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
    await expect(helper.getByText('独立手工合成样本。', { exact: true })).toBeVisible();
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    const sourceMessage = helper.getByRole('radio', { name: /甲的私密合成历史/ });
    await sourceMessage.click();
    await expect(sourceMessage).toBeChecked();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('回应这条合成消息，不增加承诺。');
    await rewriteBackend.plan({ count: 1, prefix: '来源依赖候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(editor).toHaveValue('来源依赖候选（说法1）。');
    const derived = '候选编辑复制后仍有真实来源。';
    await editor.fill(derived);
    await helper.getByRole('radio', { name: '说法 1', exact: true }).check();
    await helper.getByRole('button', { name: '复制', exact: true }).click();
    await expect.poll(() => copies.length).toBe(2);
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(derived);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    const sampleList = helper.getByRole('list', { name: '表达样本目录', exact: true });
    await expect(sampleList.getByText(derived, { exact: true })).toBeVisible();
    const sample = await helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.find((item) => item.text === '候选编辑复制后仍有真实来源。'));
    expect(sample?.originKind).toBe('candidate');
    expect(sample?.sourceIds.length).toBeGreaterThan(0);
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(derived);
    await manager.getByRole('button', { name: '关系资料', exact: true }).click();
    await manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '手工表达样本', exact: true })).toHaveValue('');
    try {
      await expect(manager.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15000 });
    } catch (error) {
      // 仅记录合成公开状态/固定错误码，不输出正文、文件名或身份。
      const controller = await manager.evaluate(async () => {
        const state = await window.notalone.sources.getState();
        return { phase: state.phase, error: state.error, busy: Boolean(state.busySourceId),
          sources: state.sources.map((source) => ({ status: source.status, taskStatus: source.task?.status ?? null, step: source.task?.step ?? null })) };
      });
      const sources = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/sources`);
      const entries = Array.isArray(sources.data.sources)
        ? sources.data.sources as Array<{ status: string; task_id: string | null }> : [];
      const tasks = await Promise.all(entries.filter((entry) => entry.task_id).map(async (entry) => {
        const read = await rewriteBackend.request(`/api/tasks/status?contact_id=${rewriteBackend.data.contact_ids[0]}&task_id=${entry.task_id}`);
        return { http: read.status, status: read.data.status, step: read.data.step,
          steps: (read.data.steps as Array<Record<string, unknown>> | undefined)?.map((step) => ({ name: step.name, status: step.status, errorCode: step.last_error_code ?? null })) };
      }));
      process.stdout.write(`${JSON.stringify({ styleSampleDeletion: { controller, sourceHttp: sources.status, sourceStatuses: entries.map((entry) => entry.status), tasks } })}\n`);
      throw error;
    }
    await expect(sampleList.getByText(derived, { exact: true })).toHaveCount(0);
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(derived);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(helper.getByRole('alert').filter({ hasText: '样本操作暂时不可用' })).toBeVisible();
    await expect(helper.getByText('独立手工合成样本。', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '联系人与绑定', exact: true }).click();
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await expect(helper.getByText('独立手工合成样本。', { exact: true })).toHaveCount(0);
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ input_mode: 'reply_to_message', current_text: '甲的私密合成历史：今晚我会晚一点回复你。' });
    expect(payloads[1].evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message' })]));
  }, { async writeText(text) { copies.push(text); }, hideWindow() { throw new Error('样本测试不收起窗口。'); } });
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByText('我的表达样本', { exact: true }).click();
    await helper.getByRole('button', { name: '回应消息', exact: true }).click();
    const sourceMessage = helper.getByRole('radio', { name: /甲的私密合成历史/ });
    await sourceMessage.click();
    await expect(sourceMessage).toBeChecked();
    await helper.getByRole('textbox', { name: '表达方向', exact: true }).fill('仅回应选中消息。');
    await rewriteBackend.plan({ count: 1, prefix: '有来源旧候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('有来源旧候选（说法1）。');
    const sameText = '两个不同来源的候选同一句表达。';
    await editor.fill(sameText);
    await helper.getByRole('radio', { name: '说法 1', exact: true }).check();
    const copiedBefore = copies.length;
    await helper.getByRole('button', { name: '复制', exact: true }).click();
    await expect.poll(() => copies.length).toBe(copiedBefore + 1);
    await helper.getByRole('button', { name: '改写', exact: true }).click();
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('第二轮独立草稿。');
    await helper.getByRole('checkbox', { name: '结合关系语境', exact: true }).uncheck();
    await rewriteBackend.plan({ count: 1, prefix: '无历史新候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(editor).toHaveValue('无历史新候选（说法1）。');
    await editor.fill(sameText);
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(sameText);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(helper.getByRole('alert').filter({ hasText: '样本操作暂时不可用' })).toBeVisible();
    await helper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.length)).toBe(0);
    // 来历有歧义时从明确当前候选入口主动保存，不把旧复制文字改归新来源。
    await helper.getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
    await expect(helper.getByRole('list', { name: '表达样本目录', exact: true }).getByText(sameText, { exact: true })).toBeVisible();
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ input_mode: 'reply_to_message', current_text: '甲的私密合成历史：今晚我会晚一点回复你。' });
    expect(payloads[1]).toMatchObject({ input_mode: 'rewrite_draft', include_relationship_context: false });
  }, { async writeText(text) { copies.push(text); }, hideWindow() { throw new Error('来源歧义测试不收起窗口。'); } });
}
