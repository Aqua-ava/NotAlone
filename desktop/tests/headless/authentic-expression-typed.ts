import { setWorkspaceContext, fillWorkspaceInstruction, continueWorkspace } from '../workspace-actions';
import { openAssistantHistory, expandSavedDiscussion } from '../assistant-history-actions';
import { openImportManagement } from '../memory-page-actions';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, type Browser, type Page } from '@playwright/test';
import { confirmHelperContact } from '../foreground-confirmation-actions';
import type { RewritePages } from '../rewrite-page-scenarios';
import { PageHost } from './page-host';
import { withRewritePages } from './rewrite-acceptance';

const independentInput = '独立保存的合成讨论：稍后再确认。';
const independentOutput = '独立保存的合成候选：稍后再确认。';
const currentIntent = '明确拒绝本次合成邀请，不增加约定。';
type Candidate = { candidate_id: string; text: string; messages: Array<{ message_id: string; text: string }> };
type Generation = { route: 'replies' | 'continue'; request: Record<string, unknown>;
  output: Record<string, unknown>; candidate: Candidate };
type Turn = { turn_id: string; state: string; input: { continuation?: { submission: Record<string, unknown> } } | null;
  reply: { candidates: Candidate[] } | null };
type Capture = { case_id: string; payload: Record<string, unknown>; output: Record<string, unknown>;
  latency_ms: number; call_count: number; model_inputs: Record<string, unknown>[]; system_prompt: string;
  owner_id: string; contact_id: string };

async function capture(pages: RewritePages, mode: string, label: string, rows: Capture[],
  messages: string[], basis: string, action: () => Promise<void>, probeHistory = false) {
  const before = ((await pages.rewriteBackend.command('observations')).payloads as unknown[]).length;
  await pages.rewriteBackend.plan({ count: 1, message_groups: [messages], basis,
    ...(probeHistory ? { probe_history: true } : {}) });
  const started = performance.now();
  process.stdout.write(`page_test_typed_phase: ${mode}/${label}/start\n`);
  try { await action(); } catch (error) {
    const state = await pages.helper.evaluate(() => window.notalone.replies.getState());
    process.stdout.write(`page_test_typed_failure: ${JSON.stringify({ label, phase: state.phase, continuation: state.continuation, savedSession: { phase: state.savedSession?.phase, turns: state.savedSession?.turns.map(t => ({ state: t.state, turnId: t.turnId })) } })}\n`);
    throw error;
  }
  const observed = await pages.rewriteBackend.command('observations');
  const payloads = observed.payloads as Record<string, unknown>[];
  const callCount = probeHistory ? 2 : 1;
  expect(payloads).toHaveLength(before + callCount);
  const system = (observed.outbound as string[]).filter((text) => text.includes('## Reply Skills')).at(-1);
  expect(typeof system).toBe('string');
  const item = { case_id: `${mode}-typed-public-${label}`, owner_id: pages.rewriteBackend.data.owner_id,
    contact_id: pages.rewriteBackend.data.contact_ids[0], payload: payloads.at(-1)!, system_prompt: system!,
    output: {}, latency_ms: performance.now() - started, call_count: callCount, model_inputs: payloads.slice(before) };
  rows.push(item);
  return item;
}

async function ordinary(pages: RewritePages, mode: string, label: string, rows: Capture[],
  messages: string[], basis: string, probeHistory = false): Promise<Generation> {
  const before = pages.replyTransport.results.length;
  const row = await capture(pages, mode, label, rows, messages, basis, async () => {
    await pages.helper.getByRole('button', { name: '帮我表达', exact: true }).click();
    await expect.poll(() => pages.replyTransport.results.length).toBe(before + 1);
    await expect.poll(async () => (await pages.helper.evaluate(async () => window.notalone.replies.getState()))
      .result?.replyRequestId).toBe(pages.replyTransport.results.at(-1)!.data.reply_request_id);
  }, probeHistory);
  const result = pages.replyTransport.results.at(-1)!;
  expect(result.status).toBe(200); row.output = result.data;
  return { route: 'replies', request: pages.replyTransport.requests.at(-1)!,
    output: result.data, candidate: (result.data.candidates as Candidate[])[0] };
}

async function typed(pages: RewritePages, host: PageHost, mode: string, label: string, rows: Capture[], sessionPath: string,
  instruction: string, messages: string[], basis: string): Promise<Generation> {
  const previous = await pages.rewriteBackend.request(sessionPath);
  expect(previous.status).toBe(200);
  const beforeTurns = (previous.data.turns as Turn[]).length;
  let completed: Turn | undefined;
  const row = await capture(pages, mode, label, rows, messages, basis, async () => {
    await pages.helper.getByRole('textbox', { name: '继续修改要求', exact: true }).fill(instruction);
    await continueWorkspace(pages.helper, host);
    await expect.poll(async () => {
      const saved = await pages.rewriteBackend.request(sessionPath);
      if (saved.status !== 200) return false;
      const turns = saved.data.turns as Turn[];
      if (turns.length !== beforeTurns + 1 || turns.at(-1)?.state !== 'completed') return false;
      completed = turns.at(-1); return true;
    }, { message: `${mode}/${label}继续修改须追加一个completed turn` }).toBe(true);
    await expect.poll(async () => (await pages.helper.evaluate(async () => window.notalone.replies.getState()))
      .result?.candidates[0]?.original.candidateId).toBe(completed!.reply!.candidates[0].candidate_id);
  });
  const command = completed!.input!.continuation!.submission;
  expect(command.instruction).toBe(instruction);
  // 从正式公开投影取得实际冻结命令；同键读取不再调用模型，避免伪造续写请求。
  const calls = ((await pages.rewriteBackend.command('observations')).payloads as unknown[]).length;
  const result = await pages.rewriteBackend.request(sessionPath + '/continue', command);
  expect(result.status).toBe(200); expect(result.data.candidates).toEqual(completed!.reply!.candidates);
  expect((await pages.rewriteBackend.command('observations')).payloads).toHaveLength(calls);
  await expect.poll(async () => (await pages.helper.evaluate(async () => window.notalone.replies.getState()))
    .result?.replyRequestId).toBe(result.data.reply_request_id);
  row.output = result.data;
  return { route: 'continue', request: command, output: result.data,
    candidate: (result.data.candidates as Candidate[])[0] };
}

async function chooseContact(manager: Page, helper: Page, contactId: string) {
  await manager.getByRole('button', { name: '联系人', exact: true }).click();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, contactId);
}


async function checkErased(helper: Page, pages: RewritePages, sessionPath: string, generated: Generation[],
  independent: Generation, expectedCalls: number) {
  const saved = await pages.rewriteBackend.request(sessionPath);
  expect(saved.status).toBe(200); expect(saved.data.current_input_version_id).toBeNull();
  const turns = saved.data.turns as Turn[];
  for (const item of generated) {
    const turn = turns.find((entry) => entry.turn_id === item.output.turn_id)!;
    expect(turn.state).toBe('redacted'); expect(turn.input).toBeNull(); expect(turn.reply).toBeNull();
    expect((await pages.rewriteBackend.request(sessionPath + `/candidates/${item.candidate.candidate_id}/versions`)).status).toBe(404);
    expect((await pages.rewriteBackend.request(sessionPath + '/' + item.route, item.request)).status).not.toBe(200);
    if (item.route === 'continue') {
      expect((await pages.rewriteBackend.request(sessionPath + '/continue/prepare', item.request)).status).not.toBe(200);
      expect((await pages.rewriteBackend.request(sessionPath + '/continue', {
        ...item.request, idempotency_key: randomUUID(),
      })).status).not.toBe(200);
    }
    expect((await pages.rewriteBackend.request(`/api/contacts/${pages.rewriteBackend.data.contact_ids[0]}/replies/${item.output.reply_request_id}/evidence`)).status).not.toBe(200);
  }
  expect(turns.filter((turn) => turn.state === 'completed')).toHaveLength(1);
  expect((await pages.rewriteBackend.request(sessionPath + '/replies', independent.request)).data).toEqual(independent.output);
  await openAssistantHistory(helper);
  await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
  await expandSavedDiscussion(helper);
  await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState()))
    .savedSession?.turns.filter((turn) => turn.state === 'redacted').length).toBe(3);
  const discussion = helper.getByRole('region', { name: '已保存的讨论', exact: true });
  await expect(discussion.getByText(independentInput, { exact: true })).toBeVisible();
  await expect(discussion.getByText(independentOutput, { exact: true })).toBeVisible();
  const visible = await helper.evaluate(async () => window.notalone.replies.getState());
  expect(visible.result).toBeNull();
  expect(JSON.stringify(visible)).not.toContain('这次不参加。');
  expect(JSON.stringify(visible)).not.toContain('那就明晚七点我陪你去合成海边。');
  expect((await pages.rewriteBackend.command('observations')).payloads).toHaveLength(expectedCalls);
}

export async function authenticExpressionTyped(browser: Browser, origin: string) {
  const rows: Capture[] = [], versions: object[] = [];
  try {
    for (const mode of ['response', 'proactive'] as const) {
      const removal = 'source';
      const name = `${mode}公开typed连续修改保留完整版本与要求，${removal}删除后重连拒绝旧来源`;
      process.stdout.write(`page_test_scenario: ${name}\n`);
      const copied: string[] = [];
      const copySurface = { writeText: async (text: string) => { copied.push(text); }, hideWindow: () => {} };
      await withRewritePages(browser, origin, async (pages, host, userData) => {
        const { manager, helper, rewriteBackend } = pages;
        const contactId = rewriteBackend.data.contact_ids[0];
        await rewriteBackend.command('fidelity_history');
        await chooseContact(manager, helper, contactId);
        await setWorkspaceContext(helper, false);
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(independentInput);
        const independent = await ordinary(pages, mode, 'independent', rows, [independentOutput], '只保留独立合成草稿。');
        await setWorkspaceContext(helper, true);
        await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill(currentIntent);
        await fillWorkspaceInstruction(helper, '不要承诺');
        const initial = await ordinary(pages, mode, 'current', rows, ['这次不参加。', '谢谢你邀请。'],
          '保留本次拒绝，仅使用本次来源和表达要求。', mode === 'proactive');
        const sessionPath = `/api/contacts/${contactId}/assistant-sessions/${initial.output.session_id}`;
        const group = helper.getByRole('group', { name: '说法1消息组', exact: true });
        await group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true }).fill('谢谢。');
        await group.getByRole('textbox', { name: '说法1第2条编辑文本', exact: true }).blur();
        await expect.poll(async () => (await helper.evaluate(async () => window.notalone.replies.getState()))
          .candidateVersions?.items.find((entry) => entry.candidateId === initial.candidate.candidate_id)?.history?.versions.length).toBe(2);
        const history = (await helper.evaluate(async () => window.notalone.replies.getState())).candidateVersions!
          .items.find((entry) => entry.candidateId === initial.candidate.candidate_id)!.history!;
        const editedVersion = history.versions[1];
        expect(editedVersion.messages.map((message) => message.text)).toEqual(['这次不参加。', '谢谢。']);
        expect(editedVersion.messages.map((message) => message.messageId)).toEqual(initial.candidate.messages.map((message) => message.message_id));
        await group.getByRole('button', { name: '复制第1条', exact: true }).click();
        expect(copied).toEqual(['这次不参加。']);
        const edited = await typed(pages, host, mode, 'edited', rows, sessionPath, '第一条自然一点',
          ['这次不参加。', '谢谢你。'], '完整保留拒绝与不要承诺，仅调整说法。');
        expect(rows.at(-1)!.payload.draft_text).toBe(currentIntent);
        expect(rows.at(-1)!.payload.user_instruction).toBe('不要承诺；自然一点');
        expect(rows.at(-1)!.payload.continuation_reference).toMatchObject({
          candidate_id: initial.candidate.candidate_id, version_id: editedVersion.versionId, is_current_draft: false,
          factual_role: 'previous_assistant_candidate', weight: 'low',
          messages: [{ text: '这次不参加。' }, { text: '谢谢。' }],
        });
        expect(rows.at(-1)!.payload.fidelity_contract).toMatchObject({
          current_intent: { text: currentIntent },
        });
        expect(edited.output.continuation).toMatchObject({ candidate_id: initial.candidate.candidate_id,
          version_id: editedVersion.versionId, effective_requirements: ['不要承诺', '自然一点'] });
        const unsupported = await typed(pages, host, mode, 'unsupported', rows, sessionPath, '第一条简短一点',
          ['这次不参加。', '那就明晚七点我陪你去合成海边。'], '故意加入没有依据的未来陪同。');
        expect(rows.at(-1)!.payload.user_instruction).toBe('不要承诺；自然一点；简短一点');
        expect(rows.at(-1)!.payload.draft_text).toBe(currentIntent);
        expect(rows.at(-1)!.payload.continuation_reference).toMatchObject({ is_current_draft: false,
          messages: [{ text: '这次不参加。' }, { text: '谢谢你。' }] });
        expect(unsupported.output.continuation).toMatchObject({ effective_requirements: ['不要承诺', '自然一点', '简短一点'] });
        const generated = [initial, edited, unsupported];
        const expectedCalls = mode === 'response' ? 4 : 5;
        versions.push({ mode, session_id: initial.output.session_id, edited_version: editedVersion,
          displayed_group: edited.request.displayed_group, frozen_command: edited.request,
          copy_surface: copied,
          external_sending: '仅合成复制surface，用户发送未执行' });
          await manager.getByRole('button', { name: '记忆', exact: true }).click();
          await openImportManagement(manager);
          const sources = manager.getByRole('region', { name: '已导入资料', exact: true });
          await sources.getByRole('button', { name: '删除来源', exact: true }).click();
          await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
          await expect(sources.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible();
        await checkErased(helper, pages, sessionPath, generated, independent, expectedCalls);
        await host.close(); await rewriteBackend.command('restart');
        const reopened = new PageHost(await browser.newContext(), origin, userData, { copySurface });
        try {
          await reopened.backend.connect(); const nextManager = await reopened.open('manager');
          await nextManager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
          const nextHelper = await reopened.open('helper');
          await confirmHelperContact(nextHelper, contactId);
          await checkErased(nextHelper, pages, sessionPath, generated, independent, expectedCalls);
        } finally { await reopened.close(); }
      }, copySurface);
      process.stdout.write(`page_test_scenario_passed: ${name}\n`);
    }
  } finally {
    await writeFile('artifacts/headless-pages/authentic-expression-typed-observations.json', JSON.stringify({
      data_kind: 'synthetic', data_version: 'authentic-expression-public-typed-v2', entry_point: 'page', rows, versions,
      coverage: { ordinary: '公开控件真实普通生成', continuation: '公开typed控件→唯一prepare/continue→隔离PG，实际冻结命令重放',
        privacy: '来源删除后的typed旧body、版本、依据及重连不复活',
        semantic_review: '整组故意错误单独报告；真人0，真实自然度与本人相似度未验' },
    }, null, 2) + '\n');
  }
}
