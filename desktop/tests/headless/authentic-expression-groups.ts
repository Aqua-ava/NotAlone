import { fillWorkspaceThought, fillWorkspaceInstruction, setWorkspaceContext } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { openImportManagement } from '../memory-page-actions';
import { writeFile } from 'node:fs/promises';
import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { withRewritePages } from './rewrite-acceptance';
import { PageHost } from './page-host';

const independentInput = '独立保存的合成讨论：稍后再确认。';
const independentOutput = '独立保存的合成候选：稍后再确认。';
const stages = [
  { label: 'current', intent: '明确拒绝本次合成邀请，不增加约定。',
    requirement: '仅表达拒绝，不新增感受。', messages: ['这次不参加。', '谢谢你邀请。'],
    basis: '保留本次拒绝，保持本次表达。' },
  { label: 'regenerated', intent: '仍然拒绝本次合成邀请，改成短句，不增加约定。',
    requirement: '改成短句，仍然拒绝，不新增感受。', messages: ['这次不参加。', '谢谢。'],
    basis: '保留当前拒绝，历史表达只供参考。' },
  { label: 'unsupported', intent: '仍然拒绝本次合成邀请，改成短句，不增加约定。',
    requirement: '仍然拒绝；再整理短句，不增加感受或约定。',
    messages: ['这次不参加。', '那就明晚七点我陪你去合成海边。'],
    basis: '按旧背景中的邀约安排。' },
] as const;

type Candidate = { candidate_id: string; text: string; messages: Array<{ message_id: string; text: string }> };
type Generation = { request: Record<string, unknown>; output: Record<string, unknown>; candidate: Candidate };

// 模型计划只有合成输出；期望、语义标注和案例标签在独立报告侧。
async function captureGeneration(pages: RewritePages, mode: string, label: string, rows: object[],
  plan: ({ text: string; basis: string } | { message_groups: string[][]; basis: string }) & { probe_history?: boolean }) {
  const before = pages.replyTransport.results.length;
  const calls = ((await pages.rewriteBackend.command('observations')).payloads as unknown[]).length;
  await pages.rewriteBackend.plan({ count: 1, ...plan });
  const started = performance.now();
  await pages.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect.poll(() => pages.replyTransport.results.length).toBe(before + 1);
  const elapsed = performance.now() - started;
  const result = pages.replyTransport.results.at(-1)!;
  expect(result.status).toBe(200);
  const observed = await pages.rewriteBackend.command('observations');
  const payloads = observed.payloads as Record<string, unknown>[];
  const callCount = plan.probe_history ? 2 : 1;
  expect(payloads).toHaveLength(calls + callCount);
  const payload = payloads.at(-1)!;
  const system = (observed.outbound as string[]).filter((text) => text.includes('## Reply Skills')).at(-1);
  expect(typeof system).toBe('string');
  rows.push({ case_id: `${mode}-group-public-${label}`, owner_id: pages.rewriteBackend.data.owner_id,
    contact_id: pages.rewriteBackend.data.contact_ids[0], payload, system_prompt: system,
    output: result.data, latency_ms: elapsed, call_count: callCount, model_inputs: payloads.slice(calls) });
  expect(pages.replyTransport.requests.at(-1)).toMatchObject({ content: { type: 'rewrite_draft', input_kind: 'workspace', workspace_action: 'express' } });
  expect(payload.input_mode).toBe('workspace');
  const candidate = (result.data.candidates as Candidate[])[0];
  expect(candidate.text).toBe(candidate.messages.map((message) => message.text).join('\n\n'));
  return { request: pages.replyTransport.requests.at(-1)!, output: result.data, candidate } satisfies Generation;
}

async function chooseContact(manager: Page, helper: Page, contactId: string) {
  await manager.getByRole('button', { name: '联系人', exact: true }).click();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, contactId);
}

async function pasteSelection(input: ReturnType<Page['getByRole']>, text: string) {
  return input.evaluate((element, value) => {
    const field = element as HTMLTextAreaElement;
    field.focus(); field.setSelectionRange(0, field.value.length);
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    return field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}

async function checkErased(helper: Page, sessionPath: string, pages: RewritePages, generated: Generation[],
  independent: Generation, expectedModelCalls: number) {
  const saved = await pages.rewriteBackend.request(sessionPath);
  expect(saved.status).toBe(200);
  const turns = saved.data.turns as Array<{ turn_id: string; state: string; input: unknown; reply: unknown }>;
  for (const item of generated) {
    const turn = turns.find((turn) => turn.turn_id === item.output.turn_id)!;
    expect(turn.state).toBe('redacted'); expect(turn.input).toBeNull(); expect(turn.reply).toBeNull();
    const path = sessionPath + `/candidates/${item.candidate.candidate_id}/versions`;
    expect((await pages.rewriteBackend.request(path)).status).toBe(404);
    expect((await pages.rewriteBackend.request(sessionPath + '/replies', item.request)).status).not.toBe(200);
    expect((await pages.rewriteBackend.request(`/api/contacts/${pages.rewriteBackend.data.contact_ids[0]}/replies/${item.output.reply_request_id}/evidence`)).status).not.toBe(200);
  }
  expect(turns.filter((turn) => turn.state === 'completed')).toHaveLength(1);
  expect((await pages.rewriteBackend.request(sessionPath + '/replies', independent.request)).data).toEqual(independent.output);
  expect((await pages.rewriteBackend.command('observations')).payloads).toHaveLength(expectedModelCalls);
  const visible = await helper.evaluate(async () => window.notalone.replies.getState());
  const erasedTurnIds = new Set(generated.map((item) => item.output.turn_id));
  const erasedCandidateIds = new Set(generated.map((item) => item.candidate.candidate_id));
  expect(visible.result).toBeNull();
  expect((visible.savedSession?.turns ?? []).filter((turn) => erasedTurnIds.has(turn.turnId))
    .every((turn) => turn.state === 'redacted' && turn.input === null && turn.reply === null)).toBe(true);
  expect((visible.candidateVersions?.items ?? []).filter((item) => erasedCandidateIds.has(item.candidateId))
    .every((item) => item.history === null)).toBe(true);
  // 删除先清空本地历史；沿现有公开动作重读，不能把空投影当删除占位已恢复。
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState()))
    .savedSession?.sessionId).toBe(sessionPath.split('/').at(-1));
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState()))
    .savedSession?.turns.filter((turn) => turn.state === 'redacted').length).toBe(3);
  const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
  await expect(discussion.getByText(independentInput, { exact: true })).toBeVisible();
  await expect(discussion.getByText(independentOutput, { exact: true })).toBeVisible();
  const selection = await pages.rewriteBackend.request(sessionPath + '/selections');
  expect(selection.status).toBe(200); expect(selection.data.selection).toBeNull();
}

export async function authenticExpressionGroups(browser: Browser, origin: string) {
  const rows: object[] = [], edits: object[] = [];
  try {
    for (const mode of ['workspace-recent', 'workspace-history'] as const) {
      const name = `${mode}公开消息组的编辑来源、普通重新生成及来源删除恢复`;
      process.stdout.write(`page_test_scenario: ${name}\n`);
      const copied: string[] = []; let hidden = 0;
      const copySurface = { writeText: async (text: string) => { copied.push(text); }, hideWindow: () => { hidden++; } };
      await withRewritePages(browser, origin, async (pages, host, userData) => {
        const { manager, helper, rewriteBackend } = pages;
        const contactId = rewriteBackend.data.contact_ids[0];
        await rewriteBackend.command('fidelity_history');
        await chooseContact(manager, helper, contactId);
        await setWorkspaceContext(helper, false);
        await fillWorkspaceThought(helper, independentInput);
        const independent = await captureGeneration(pages, mode, 'independent', rows,
          { text: independentOutput, basis: '只保留这份无关系语境的独立合成草稿。' });
        await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue(independentOutput);
        expect(independent.request).toMatchObject({ content: { include_relationship_context: false } });
        const generated: Generation[] = [];
        for (const [index, stage] of stages.entries()) {
          await setWorkspaceContext(helper, true);
          await fillWorkspaceThought(helper, stage.intent);
          await fillWorkspaceInstruction(helper, stage.requirement);
          await helper.getByRole('textbox', { name: '补充聊天上下文', exact: true })
            .fill('对方发来合成邀约，双方尚未确认约定。');
          const item = await captureGeneration(pages, mode, stage.label, rows,
            { message_groups: [[...stage.messages]], basis: stage.basis,
              ...(mode === 'workspace-history' && index === 0 ? { probe_history: true } : {}) });
          generated.push(item);
          expect(item.request).toMatchObject({ content: { draft_text: stage.intent,
            include_relationship_context: true, context_text: '对方发来合成邀约，双方尚未确认约定。' } });
          expect(item.candidate.messages.map((message) => message.text)).toEqual([...stage.messages]);
          expect(new Set(item.candidate.messages.map((message) => message.message_id)).size).toBe(2);
          const observed = await rewriteBackend.command('observations');
          const payload = (observed.payloads as Record<string, unknown>[]).at(-1)!;
          expect(payload.fidelity_contract).toMatchObject({ current_intent: { text: stage.intent } });
          expect(payload.user_instruction).toBe(stage.requirement);
          const group = helper.getByRole('group', { name: '说法1消息组', exact: true });
          for (const [number, text] of stage.messages.entries()) {
            await expect(group.getByRole('textbox', { name: `说法1第${number + 1}条编辑文本`, exact: true })).toHaveValue(text);
          }
          if (index !== 0) continue;
          const firstEditor = group.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true });
          const edited = ['这次我不参加。', stage.messages[1]];
          await expect(firstEditor).toBeEditable();
          expect(await pasteSelection(firstEditor, edited[0])).toBe(false);
          await expect(firstEditor).toHaveValue(edited[0]);
          await firstEditor.blur();
          await expect(group.getByText('修改版本 1', { exact: true })).toBeVisible();
          await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState()))
            .candidateVersions?.items.find((view) => view.candidateId === item.candidate.candidate_id)?.history?.versions.length,
            { message: `${mode}：公开组修改保存后，受信历史应有两个完整版本` }).toBe(2);
          const history = (await helper.evaluate(async () => window.notalone.replies.getState()))
            .candidateVersions!.items.find((view) => view.candidateId === item.candidate.candidate_id)!.history!;
          expect(history.versions[0].messages.map((message) => message.text)).toEqual([...stage.messages]);
          const version = history.versions[1];
          expect(version.parentVersionId).toBe(history.versions[0].versionId);
          expect(version.messages.map((message) => message.messageId)).toEqual(item.candidate.messages.map((message) => message.message_id));
          expect(version.messages.map((message) => message.text)).toEqual(edited); expect(version.requirements).toBeNull();
          await group.getByRole('button', { name: '复制第1条', exact: true }).click();
          await expect(group.getByRole('status').filter({ hasText: '已复制第1条，请自行粘贴并发送' })).toBeVisible();
          expect(copied).toEqual([edited[0]]); expect(hidden).toBe(0);
          const previousVersion = group.getByRole('button', { name: '查看说法1上一版', exact: true });
          await previousVersion.click();
          await expect(group.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue(stage.messages[0]);
          await openAssistantHistory(helper);
          await helper.getByRole('button', { name: '刷新会话列表', exact: true }).click();
          await openAssistantHistory(helper);
          await helper.getByRole('button', { name: `查看会话 ${item.output.session_id}`, exact: true }).click();
          await expandSavedDiscussion(helper);
          await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState())).result,
            { message: `${mode}：明确查看会话并完成重读后，实时结果应清空` }).toBeNull();
          await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState())).candidateVersions?.phase).toBe('ready');
          await expect(group.getByText('修改版本 1', { exact: true })).toBeVisible();
          await previousVersion.click();
          await expect(group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true })).toHaveValue(stage.messages[1]);
          await group.getByRole('button', { name: '查看说法1下一版', exact: true }).click();
          await expect(group.getByRole('textbox', { name: '说法1第1条编辑文本', exact: true })).toHaveValue(edited[0]);
          const finalDraft = [edited[0], '谢谢你邀请。先这样。'];
          const finalEditor = group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true });
          await finalEditor.fill(finalDraft[1]);
          await finalEditor.blur();
          await expect(group.getByText('修改版本 2', { exact: true })).toBeVisible();
          const afterEdits = (await helper.evaluate(async () => window.notalone.replies.getState())).candidateVersions!
            .items.find((view) => view.candidateId === item.candidate.candidate_id)!.history!;
          expect(afterEdits.versions).toHaveLength(3);
          expect(afterEdits.versions.slice(0, 2)).toEqual(history.versions);
          const finalVersion = afterEdits.versions[2];
          expect(finalVersion.parentVersionId).toBe(version.versionId);
          expect(finalVersion.messages.map(message => message.messageId)).toEqual(item.candidate.messages.map(message => message.message_id));
          expect(finalVersion.messages.map(message => message.text)).toEqual(finalDraft);
          edits.push({ mode, session_id: item.output.session_id, reply_request_id: item.output.reply_request_id,
            candidate_id: item.candidate.candidate_id, version, restored_result_was_null: true, final_saved_version: finalVersion, copied: [...copied], external_sending: '未调用外部发送；只使用合成复制surface', model_calls_for_edit_and_copy_and_save: 0 });
          expect((await rewriteBackend.command('observations')).payloads).toHaveLength(mode === 'workspace-history' ? 3 : 2);
        }
        const sessionPath = `/api/contacts/${contactId}/assistant-sessions/${generated[0].output.session_id}`;
        await manager.getByRole('button', { name: '记忆', exact: true }).click();
        await openImportManagement(manager);
        const sources = manager.getByRole('region', { name: '已导入资料', exact: true });
        await sources.getByRole('button', { name: '删除来源', exact: true }).click();
        await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
        await expect(sources.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
        const expectedModelCalls = mode === 'workspace-history' ? 5 : 4;
        await checkErased(helper, sessionPath, pages, generated, independent, expectedModelCalls);
        pages.replyTransport.failRuntime = true;
        await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
        pages.replyTransport.failRuntime = false;
        await manager.getByRole('button', { name: '重试连接', exact: true }).click();
        await chooseContact(manager, helper, contactId);
        await checkErased(helper, sessionPath, pages, generated, independent, expectedModelCalls);
        await host.close(); await rewriteBackend.command('restart');
        const reopened = new PageHost(await browser.newContext(), origin, userData, { copySurface });
        try {
          await reopened.backend.connect(); const nextManager = await reopened.open('manager');
          await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
          const nextHelper = await reopened.open('helper'); await confirmHelperContact(nextHelper, contactId);
          await checkErased(nextHelper, sessionPath, pages, generated, independent, expectedModelCalls);
          expect(copied).toHaveLength(1); expect(hidden).toBe(0);
        } finally { await reopened.close(); }
      }, copySurface);
      process.stdout.write(`page_test_scenario_passed: ${name}\n`);
    }
  } finally {
    await writeFile('artifacts/headless-pages/authentic-expression-groups-observations.json', JSON.stringify({
      data_kind: 'synthetic', data_version: 'authentic-expression-workspace-groups-v2', entry_point: 'page', rows,
      ui_edits: edits, coverage: { workspace_action: 'express', continuation: '本用例覆盖直接重新生成、逐条编辑及版本保存',
        native_acceptance: false, real_model_quality: 'unknown' },
    }, null, 2) + '\n', { mode: 0o600 });
  }
}
