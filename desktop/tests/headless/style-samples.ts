import { openCandidateMoreActions, setWorkspaceContext } from '../workspace-actions';
import { selectMemoryCategory } from '../memory-page-actions';
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
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('合成当前草稿。');
    await rewriteBackend.plan({ count: 1, prefix: '合成样本候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('合成样本候选（说法1）。');
    await editor.fill('用户主动选定的合成最终表达。');
    await editor.blur();
    await helper.getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect.poll(() => copies.length).toBe(1);
    await helper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.length)).toBe(0);
    await openCandidateMoreActions(helper);
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
    await setWorkspaceContext(helper, true);
    const sourceMessage = helper.getByRole('checkbox', { name: /甲的私密合成历史/ });
    await sourceMessage.check();
    await expect(sourceMessage).toBeChecked();
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('回应这条合成消息，不增加承诺。');
    await rewriteBackend.plan({ count: 1, prefix: '来源依赖候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(editor).toHaveValue('来源依赖候选（说法1）。');
    const derived = '候选编辑复制后仍有真实来源。';
    await editor.fill(derived);
    await editor.blur();
    await helper.getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect.poll(() => copies.length).toBe(2);
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(derived);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    const sampleList = helper.getByRole('list', { name: '表达样本目录', exact: true });
    await expect(sampleList.getByText(derived, { exact: true })).toBeVisible();
    const sample = await helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.find((item) => item.text === '候选编辑复制后仍有真实来源。'));
    expect(sample?.originKind).toBe('candidate');
    expect(sample?.sourceIds.length).toBeGreaterThan(0);
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(derived);
    await manager.getByRole('button', { name: '记忆', exact: true }).click();
    await selectMemoryCategory(manager, '来源与过程');
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
    await manager.getByRole('button', { name: '联系人', exact: true }).click();
    await manager.getByRole('button', { name: '选择合成联系人乙', exact: true }).click();
    await expect(helper.getByText('独立手工合成样本。', { exact: true })).toHaveCount(0);
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ input_mode: 'workspace', include_relationship_context: true });
    expect(payloads[1].evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message' })]));
  }, { async writeText(text) { copies.push(text); }, hideWindow() { throw new Error('样本测试不收起窗口。'); } });
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByText('我的表达样本', { exact: true }).click();
    await setWorkspaceContext(helper, true);
    const sourceMessage = helper.getByRole('checkbox', { name: /甲的私密合成历史/ });
    await sourceMessage.check();
    await expect(sourceMessage).toBeChecked();
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('仅回应选中消息。');
    await rewriteBackend.plan({ count: 1, prefix: '有来源旧候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
    await expect(editor).toHaveValue('有来源旧候选（说法1）。');
    const sameText = '两个不同来源的候选同一句表达。';
    await editor.fill(sameText);
    await editor.blur();
    const oldRequestId = await helper.evaluate(async () => (await window.notalone.replies.getState()).result!.replyRequestId);
    const sourceRead = await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/sources`);
    expect(sourceRead.status).toBe(200);
    const sourceIds = (sourceRead.data.sources as Array<{ source_id: string }>).map(source => source.source_id).sort();
    expect(sourceIds).toHaveLength(1);
    const copiedBefore = copies.length;
    await helper.getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect.poll(() => copies.length).toBe(copiedBefore + 1);
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('第二轮独立草稿。');
    await setWorkspaceContext(helper, false);
    await rewriteBackend.plan({ count: 1, prefix: '无历史新候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(editor).toHaveValue('无历史新候选（说法1）。');
    await editor.fill(sameText);
    await helper.getByRole('textbox', { name: '手工表达样本', exact: true }).fill(sameText);
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(helper.getByRole('alert').filter({ hasText: '样本操作暂时不可用' })).toBeVisible();
    await helper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.length)).toBe(0);
    // 已实际复制的旧候选来历不能仅凭当前保存入口改归新候选。
    await openCandidateMoreActions(helper);
    await helper.getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
    await expect(helper.getByRole('alert').filter({ hasText: '样本尚未保存，请核对当前版本后重试。' })).toBeVisible();
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.length)).toBe(0);
    const currentCandidateId = await helper.evaluate(async () =>
      (await window.notalone.replies.getState()).result!.candidates[0].original.candidateId);
    const copiesBeforeCurrent = copies.length;
    await helper.getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect.poll(() => copies.length).toBe(copiesBeforeCurrent + 1);
    expect(copies.at(-1)).toBe(sameText);
    // 明确复制当前已保存版不抹去同文多来源；手工入口仍拒绝，当前候选入口才明确归属。
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(helper.getByRole('alert').filter({ hasText: '样本操作暂时不可用' })).toBeVisible();
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples.length)).toBe(0);
    await openCandidateMoreActions(helper);
    await helper.getByRole('button', { name: '主动保存说法1为样本', exact: true }).click();
    const list = helper.getByRole('list', { name: '表达样本目录', exact: true });
    await expect(list.getByText(sameText, { exact: true })).toBeVisible();
    const sample = await helper.evaluate(async () => (await window.notalone.styleSamples.getState()).samples[0]);
    expect(sample.originKind).toBe('candidate');
    expect(sample.originId).toBe(currentCandidateId);
    // 关闭关系检索仍保留同一助手讨论；旧候选进入本轮时，其真实来源不能丢失。
    const observations = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    const discussion = observations[1].assistant_discussion as { items: Array<{ reply_request_id: string | null }> };
    expect(discussion.items.some(item => item.reply_request_id === oldRequestId)).toBe(true);
    expect([...sample.sourceIds].sort()).toEqual(sourceIds);
    await manager.getByRole('button', { name: '记忆', exact: true }).click();
    await selectMemoryCategory(manager, '来源与过程');
    await manager.getByRole('region', { name: '来源删除管理', exact: true }).getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(manager.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15000 });
    await helper.getByRole('button', { name: '刷新表达样本', exact: true }).click();
    await expect(list.getByText(sameText, { exact: true })).toHaveCount(0);
    expect((await helper.evaluate(() => window.notalone.styleSamples.getState())).samples).toHaveLength(0);
    const payloads = (await rewriteBackend.command('observations')).payloads as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ input_mode: 'workspace', include_relationship_context: true });
    expect(payloads[1]).toMatchObject({ input_mode: 'workspace', include_relationship_context: false });
  }, { async writeText(text) { copies.push(text); }, hideWindow() { throw new Error('来源歧义测试不收起窗口。'); } });
  await withRewritePages(browser, origin, async ({ manager, helper, rewriteBackend }) => {
    await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
    await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
    await helper.getByText('我的表达样本', { exact: true }).click();
    const input = helper.getByRole('textbox', { name: '手工表达样本', exact: true });
    const paste = async (text: string) => input.evaluate((element, value) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
      const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
      element.dispatchEvent(event); return event.defaultPrevented;
    }, text);
    expect(await paste('来源未知的合成剪贴板内容。')).toBe(true);
    await expect(helper.getByRole('alert').filter({ hasText: '无法核验粘贴来源' })).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(helper.getByRole('button', { name: '主动保存手工文字', exact: true })).toBeDisabled();
    expect((await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/style-samples`)).data.samples).toEqual([]);
    await input.fill('清空输入框后直接键入的合成表达。');
    await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(helper.getByRole('list', { name: '表达样本目录', exact: true }).getByText('清空输入框后直接键入的合成表达。', { exact: true })).toBeVisible();
    await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('合成合法候选来源。');
    await rewriteBackend.plan({ count: 1, prefix: '已登记复制候选' });
    await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('已登记复制候选（说法1）。');
    const before = copies.length;
    await helper.getByRole('button', { name: '复制第1条', exact: true }).click();
    await expect.poll(() => copies.length).toBe(before + 1);
    expect(await paste(copies.at(-1)!)).toBe(true);
    await expect(input).toHaveValue(copies.at(-1)!);
    await input.fill('');
    for (const stage of ['note', 'commit'] as const) {
      const typed = `${stage}回包尚未返回时新键入的独立合成文字。`;
      // 仅延迟既有具名 IPC 的返回，主进程来源校验与业务保存仍真实执行。
      await helper.evaluate((stage) => {
        const surface = window as unknown as { pageCommand: (channel: string, args: unknown[]) => Promise<unknown>;
          stylePasteGate?: { entered: boolean; release: () => void } };
        const original = surface.pageCommand;
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        surface.stylePasteGate = { entered: false, release };
        surface.pageCommand = async (channel, args) => {
          const result = await original(channel, args);
          if ((stage === 'note' && channel === 'style-samples:note-manual-paste')
            || (stage === 'commit' && channel === 'style-samples:update-manual-text'
              && Boolean((args[0] as { pasteId?: string })?.pasteId))) {
            surface.stylePasteGate!.entered = true;
            await held; surface.pageCommand = original;
          }
          return result;
        };
      }, stage);
      try {
        expect(await paste(copies.at(-1)!)).toBe(true);
        await expect.poll(() => helper.evaluate(() => (window as unknown as {
          stylePasteGate: { entered: boolean } }).stylePasteGate.entered)).toBe(true);
        await expect(input).toHaveValue('');
        await input.fill(typed);
      } finally {
        await helper.evaluate(() => (window as unknown as { stylePasteGate: { release: () => void } }).stylePasteGate.release());
      }
      await expect(input).toHaveValue(typed);
      await helper.getByRole('button', { name: '主动保存手工文字', exact: true }).click();
      await expect(input).toHaveValue('');
      const samples = (await rewriteBackend.request(`/api/contacts/${rewriteBackend.data.contact_ids[0]}/style-samples`)).data.samples as Array<{ text: string; origin_kind: string }>;
      expect(samples.find((item) => item.text === typed)?.origin_kind).toBe('manual');
    }
    expect((await rewriteBackend.command('observations')).payloads).toHaveLength(1);
  }, { async writeText(text) { copies.push(text); }, hideWindow() { throw new Error('粘贴边界测试不收起窗口。'); } });
}
