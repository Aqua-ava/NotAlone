import { setWorkspaceContext, setWorkspaceTone, fillWorkspaceInstruction, openWorkspaceSettings } from './workspace-actions';
import { openImportManagement, selectMemoryCategory } from './memory-page-actions';
import { expect, type Page } from '@playwright/test';
import type { SourceDeletionFixture } from './source-deletion-fixture';
import type { MemoryHttpProxy } from './memory-http-proxy';
import type { CandidateCopyRequest } from '../src/shared/candidate-copy-bridge';

async function confirmHelperContact(helper: Page) {
  await helper.getByRole('button', { name: '确认本次联系人', exact: true }).click();
  await expect(helper.getByText('本次联系人已由你确认。', { exact: true })).toBeVisible();
}

function candidateGroup(helper: Page) {
  return helper.getByRole('group', { name: '说法1消息组', exact: true });
}

async function currentCopyRequest(helper: Page): Promise<CandidateCopyRequest> {
  await candidateGroup(helper).getByRole('textbox').blur();
  await expect(candidateGroup(helper).getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
  const request = await helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    const candidateId = state.result!.candidates[0].original.candidateId;
    const view = state.candidateVersions!.items.find(item => item.candidateId === candidateId)!;
    const version = view.history!.versions.find(item => item.versionId === view.displayVersionId)!;
    return { contactId: state.contactId!, scopeRevision: state.scopeRevision,
      replyRequestId: state.result!.replyRequestId, candidateId,
      versionId: version.versionId, messageId: version.messages[0].messageId, hideAfterCopy: false };
  });
  // 删除前先走同一公开复制桥成功一次，证明请求身份与合成接收端均有效。
  await helper.evaluate(request => window.notalone.candidateCopy.copy(request), request);
  return request;
}

async function expectCopyBlocked(helper: Page, request: CandidateCopyRequest) {
  await expect(candidateGroup(helper)).toHaveCount(0);
  // 具名版本请求必须被生产状态校验拒绝，不能用缺少系统复制接收端的夹具错误代替。
  expect(await helper.evaluate(async (request) => {
    try { await window.notalone.candidateCopy.copy(request); return 'accepted'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, request)).toMatch(/^本次候选(?:版本)?已变化，请重新确认。$/);
}

// 公共页面发起真实删除；最终证明来自原持久任务，不用来源标记或百分比替代。
export async function sourceDeletionBasic(manager: Page, fixture: SourceDeletionFixture) {
  const contactId = fixture.data.contact_ids[0];
  const before = await fixture.http(`/api/contacts/${contactId}/sources`);
  expect(before.status).toBe(200);
  const sourceId = (before.data.sources as { source_id: string }[])[0].source_id;
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${sourceId}"]`);
  await expect(source).toBeVisible();
  await source.getByRole('button', { name: '删除来源', exact: true }).click();
  const confirmation = manager.getByRole('dialog', { name: '确认来源删除', exact: true });
  await expect(confirmation.getByText(/删除 合成联系人甲 的「.+」及失去有效来源支持的资料；其他有效来源支持的内容保留。/)).toBeVisible();
  await confirmation.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  const after = await fixture.http(`/api/contacts/${contactId}/sources`);
  const deleted = (after.data.sources as { source_id: string; task_id: string; status: string }[]).find((entry) => entry.source_id === sourceId)!;
  expect(deleted.status).toBe('deleted');
  const task = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`);
  expect(task.status).toBe(200);
  expect(task.data.status).toBe('succeeded');
  expect((task.data.steps as { name: string; status: string }[]).find((step) => step.name === 'verify_not_retrievable')?.status).toBe('succeeded');
  const messages = await fixture.http(`/api/contacts/${contactId}/messages`);
  expect(messages.data.messages).toEqual([]);
  const other = await fixture.http(`/api/contacts/${fixture.data.contact_ids[1]}/messages`);
  expect((other.data.messages as unknown[]).length).toBe(1);
}

export async function sourceDeletionVerification(manager: Page, fixture: SourceDeletionFixture) {
  await sourceDeletionBasic(manager, fixture);
  const contactId = fixture.data.contact_ids[0];
  const sources = await fixture.http(`/api/contacts/${contactId}/sources`);
  const deleted = (sources.data.sources as { source_id: string; task_id: string }[])[0];
  await fixture.failFinalVerification(contactId, deleted.task_id);
  await manager.getByRole('button', { name: '刷新资料与删除状态', exact: true }).click();
  await openImportManagement(manager);
  const source = manager.getByRole('region', { name: '已导入资料', exact: true }).locator(`[data-source-id="${deleted.source_id}"]`);
  await expect(source.getByText('删除失败：不可检索校验，可重试原任务', { exact: true })).toBeVisible();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toHaveCount(0);
  const failed = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`);
  expect(failed.data.status).toBe('failed');
  await source.getByRole('button', { name: '重试来源删除', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(source.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  const after = await fixture.http(`/api/contacts/${contactId}/sources`);
  expect((after.data.sources as { task_id: string }[])[0].task_id).toBe(deleted.task_id);
  const task = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`);
  expect(task.data.status).toBe('succeeded');
  expect((task.data.steps as { status: string }[]).every((step) => step.status === 'succeeded')).toBe(true);
}

export async function sourceDeletionUnknown(manager: Page, fixture: SourceDeletionFixture, proxy: MemoryHttpProxy) {
  const contactId = fixture.data.contact_ids[0];
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const panel = manager.getByRole('region', { name: '已导入资料', exact: true });
  await expect(panel.getByRole('button', { name: '删除来源', exact: true })).toBeVisible();
  proxy.failurePaths.add(`/api/contacts/${contactId}/sources`);
  await panel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('删除结果尚未确认');
  await expect(panel.getByText('已删除，已通过不可检索校验', { exact: true })).toHaveCount(0);
  expect(proxy.requests.some((request) => request.method === 'DELETE' && request.path.startsWith(`/api/contacts/${contactId}/sources/`))).toBe(true);
  proxy.failurePaths.clear();
  await panel.getByRole('button', { name: '刷新资料与删除状态', exact: true }).click();
  await expect(panel.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  const result = await fixture.http(`/api/contacts/${contactId}/sources`);
  const taskId = (result.data.sources as { task_id: string }[])[0].task_id;
  const task = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${taskId}`);
  expect(task.data.status).toBe('succeeded');
}

export async function sourceDeletionArguments(manager: Page, helper: Page, fixture: SourceDeletionFixture, proxy: MemoryHttpProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  await expect(manager.getByRole('region', { name: '已导入资料', exact: true }).getByRole('button', { name: '删除来源', exact: true })).toBeVisible();
  const state = await manager.evaluate(() => window.notalone.sources.getState());
  const request = { contactId: state.contactId!, scopeRevision: state.scopeRevision, sourceId: state.sources[0].sourceId };
  const before = proxy.requests.filter((request) => request.method === 'DELETE').length;
  const outcomes = await manager.evaluate(async ({ request, otherContact }) => {
    const invoke = window.notalone.sources.delete as (...args: unknown[]) => Promise<unknown>;
    const results: string[] = [];
    for (const args of [[request, 'extra'], [{ ...request, ownerId: 'renderer-owner' }], [{ ...request, scopeRevision: -1 }],
      [{ ...request, contactId: otherContact }], [{ ...request, sourceId: otherContact }], [{ ...request, sourceId: '../../source' }]]) {
      try { await invoke(...args); results.push('accepted'); } catch { results.push('rejected'); }
    }
    return results;
  }, { request, otherContact: fixture.data.other_contact_id });
  expect(outcomes).toEqual(Array(6).fill('rejected'));
  expect(await helper.evaluate(async (request) => {
    try { await window.notalone.sources.delete(request); return 'accepted'; } catch { return 'rejected'; }
  }, request)).toBe('rejected');
  expect(proxy.requests.filter((request) => request.method === 'DELETE').length).toBe(before);
  const source = await fixture.http(`/api/contacts/${request.contactId}/sources`);
  expect((source.data.sources as { status: string }[])[0].status).toBe('active');
}

export async function sourceDeletionReplies(manager: Page, helper: Page, fixture: SourceDeletionFixture) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('说明本人喜欢合成绿茶。');
  await setWorkspaceContext(helper, true);
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('来源引用合成候选。', { timeout: 15_000 });
  await editor.fill('本人资料引用的本轮编辑稿。');
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  const evidence = helper.getByRole('region', { name: '候选1依据', exact: true });
  await expect(evidence.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  const copy = await currentCopyRequest(helper);
  const state = await helper.evaluate(() => window.notalone.replies.getState());
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const sourcePanel = manager.getByRole('region', { name: '已导入资料', exact: true });
  await sourcePanel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(sourcePanel.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  // 两窗不得继续保留被删来源支持的候选、编辑和已展开正文；不推断供应商副本。
  await expect(editor).toHaveCount(0);
  await expect(evidence).toHaveCount(0);
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('说明本人喜欢合成绿茶。');
  await expectCopyBlocked(helper, copy);
  const gone = await fixture.http(`/api/contacts/${state.contactId}/replies/${state.result!.replyRequestId}/evidence`);
  expect(gone.status).toBe(404);
  await selectMemoryCategory(manager, '本人记忆');
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toHaveCount(0);
}

export async function sourceDeletionCrossContact(manager: Page, helper: Page, fixture: SourceDeletionFixture,
  proxy: import('./source-deletion-proxy').SourceDeletionProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const panel = manager.getByRole('region', { name: '已导入资料', exact: true });
  await expect(panel.getByRole('button', { name: '删除来源', exact: true })).toBeVisible();
  const source = await manager.evaluate(() => window.notalone.sources.getState());
  proxy.holdDelete = true;
  await panel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect.poll(() => proxy.heldCount, { timeout: 1500 }).toBe(1);
  await manager.getByRole('combobox', { name: '管理资料的联系人', exact: true }).selectOption(fixture.data.contact_ids[1]);
  await confirmHelperContact(helper);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('说明本人喜欢合成绿茶。');
  await setWorkspaceContext(helper, true);
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('来源引用合成候选。', { timeout: 2500 });
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible({ timeout: 1500 });
  const copy = await currentCopyRequest(helper);
  const reply = await helper.evaluate(() => window.notalone.replies.getState());
  proxy.release();
  await expect.poll(async () => {
    const response = await fixture.http(`/api/contacts/${source.contactId}/sources`);
    const taskId = (response.data.sources as { task_id: string | null }[])[0].task_id;
    if (!taskId) return 'missing';
    const task = await fixture.http(`/api/tasks/status?contact_id=${source.contactId}&task_id=${taskId}`);
    return task.data.status;
  }, { timeout: 15_000 }).toBe('succeeded');
  expect((await fixture.http(`/api/contacts/${reply.contactId}/replies/${reply.result!.replyRequestId}/evidence`)).status).toBe(404);
  await expect(editor).toHaveCount(0);
  await expect(helper.getByRole('region', { name: '候选1依据', exact: true })).toHaveCount(0);
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('说明本人喜欢合成绿茶。');
  await expectCopyBlocked(helper, copy);
}

export async function sourceDeletionUnrelated(manager: Page, helper: Page, fixture: SourceDeletionFixture,
  proxy?: MemoryHttpProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('仅改写这份合成草稿。');
  await setWorkspaceContext(helper, false);
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('来源引用合成候选。', { timeout: 15_000 });
  await editor.fill('与被删来源无关的本轮编辑稿。');
  const copy = await currentCopyRequest(helper);
  const before = await helper.evaluate(() => window.notalone.replies.getState());
  const evidencePath = `/api/contacts/${before.contactId}/replies/${before.result!.replyRequestId}/evidence`;
  if (proxy) proxy.failurePaths.add(evidencePath);
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const panel = manager.getByRole('region', { name: '已导入资料', exact: true });
  await panel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  await expect(panel.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  if (proxy) {
    await expect(helper.getByRole('alert')).toContainText('删除后的依据尚未确认');
    await expect(editor).toHaveCount(0);
    await expectCopyBlocked(helper, copy);
    proxy.failurePaths.clear();
    await helper.getByRole('button', { name: '重新核对依据', exact: true }).click();
  }
  await expect(editor).toHaveValue('与被删来源无关的本轮编辑稿。');
  const after = await helper.evaluate(() => window.notalone.replies.getState());
  expect(after.result!.replyRequestId).toBe(before.result!.replyRequestId);
  expect(after.selectedCandidateId).toBe(before.selectedCandidateId);
  const evidence = await fixture.http(evidencePath);
  expect(evidence.status).toBe(200);
  expect((evidence.data.evidence as { kind: string; text: string }[])
    .map(({ kind, text }) => ({ kind, text })).sort((left, right) => left.kind.localeCompare(right.kind))).toEqual([
      { kind: 'user_draft', text: '仅改写这份合成草稿。' },
      { kind: 'user_purpose', text: '帮我表达' },
    ]);
  await expect(helper.getByRole('textbox', { name: '有什么想说的', exact: true })).toHaveValue('仅改写这份合成草稿。');
  await expect(candidateGroup(helper).getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
}

export async function sourceDeletionMultiSource(manager: Page, fixture: SourceDeletionFixture) {
  const contactId = fixture.data.contact_ids[0];
  const sources = await fixture.http(`/api/contacts/${contactId}/sources`);
  const entries = sources.data.sources as { source_id: string; file_name: string; status: string }[];
  expect(entries).toHaveLength(2);
  expect(entries.every((entry) => entry.status === 'active')).toBe(true);
  const before = await fixture.http(`/api/contacts/${contactId}/memories`);
  const memory = (before.data.memories as { memory_id: string; text: string; source_ids: string[] }[])
    .find((entry) => entry.text === '两个合成来源共同支持的记忆。')!;
  expect(memory.source_ids).toHaveLength(1);
  const messageId = memory.source_ids[0];
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await expect(manager.getByText(memory.text, { exact: true })).toBeVisible();
  await openImportManagement(manager);
  const panel = manager.getByRole('region', { name: '已导入资料', exact: true });
  const ordered = [...entries].sort((a, b) => a.file_name.localeCompare(b.file_name));
  for (const [index, source] of ordered.entries()) {
    const card = panel.locator(`[data-source-id="${source.source_id}"]`);
    await card.getByRole('button', { name: '删除来源', exact: true }).click();
    await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
    await expect(card.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
    const directory = await fixture.http(`/api/contacts/${contactId}/sources`);
    const deleted = (directory.data.sources as { source_id: string; task_id: string }[]).find((entry) => entry.source_id === source.source_id)!;
    const task = await fixture.http(`/api/tasks/status?contact_id=${contactId}&task_id=${deleted.task_id}`);
    expect(task.data.status).toBe('succeeded');
    expect((task.data.steps as { name: string; status: string }[]).find((step) => step.name === 'verify_not_retrievable')?.status).toBe('succeeded');
    const messages = await fixture.http(`/api/contacts/${contactId}/messages`);
    const memories = await fixture.http(`/api/contacts/${contactId}/memories`);
    const supported = (memories.data.memories as { memory_id: string; source_ids: string[] }[]).find((entry) => entry.memory_id === memory.memory_id);
    if (index === 0) {
      expect((messages.data.messages as { message_id: string }[]).some((entry) => entry.message_id === messageId)).toBe(true);
      expect(supported?.source_ids).toEqual([messageId]);
      await selectMemoryCategory(manager, '联系人记忆');
      await expect(manager.getByText(memory.text, { exact: true })).toBeVisible();
      await openImportManagement(manager);
    } else {
      expect((messages.data.messages as { message_id: string }[]).some((entry) => entry.message_id === messageId)).toBe(false);
      expect(supported).toBeUndefined();
      await selectMemoryCategory(manager, '联系人记忆');
      await expect(manager.getByText(memory.text, { exact: true })).toHaveCount(0);
      await openImportManagement(manager);
    }
  }
  const other = await fixture.http(`/api/contacts/${fixture.data.contact_ids[1]}/messages`);
  expect(other.data.messages).toHaveLength(1);
}

export async function sourceDeletionStaleRequest(manager: Page, helper: Page, fixture: SourceDeletionFixture,
  proxy: import('./source-deletion-proxy').SourceDeletionProxy) {
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper);
  const draft = helper.getByRole('textbox', { name: '有什么想说的', exact: true });
  await draft.fill('旧请求的独立合成草稿。');
  await setWorkspaceContext(helper, false);
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  const editor = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(editor).toHaveValue('来源引用合成候选。', { timeout: 15_000 });
  await editor.fill('旧请求编辑稿不得恢复。');
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  await expect(helper.getByRole('region', { name: '候选1依据', exact: true }).getByText('旧请求的独立合成草稿。', { exact: true })).toBeVisible();
  const copy = await currentCopyRequest(helper);
  const old = await helper.evaluate(() => window.notalone.replies.getState());
  proxy.holdEvidencePath = `/api/contacts/${old.contactId}/replies/${old.result!.replyRequestId}/evidence`;
  await manager.getByRole('button', { name: '记忆', exact: true }).click();
  await openImportManagement(manager);
  const panel = manager.getByRole('region', { name: '已导入资料', exact: true });
  await panel.getByRole('button', { name: '删除来源', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除来源', exact: true }).click();
  try {
    await expect.poll(() => proxy.heldCount, { timeout: 1500, message: '删除后应拦截旧候选真实依据响应' }).toBe(1);
  } catch (error) {
    console.log('page_test_source_stale_capture:', JSON.stringify({ evidence: proxy.evidenceRequests,
      state: await helper.evaluate(async () => {
        const reply = await window.notalone.replies.getState();
        const sources = await window.notalone.sources.getState();
        return { phase: reply.phase, sourceAvailability: reply.sourceAvailability, hasResult: Boolean(reply.result),
          savedPhase: reply.savedSession?.phase, deletionPhase: sources.phase, deletionError: sources.error,
          sources: sources.sources.map(source => ({ status: source.status, taskStatus: source.task?.status, step: source.task?.step })) };
      }) }));
    throw error;
  }
  expect(proxy.heldStatuses).toEqual([200]);
  await expect(editor).toHaveCount(0);
  await expect(helper.getByRole('region', { name: '候选1依据', exact: true })).toHaveCount(0);
  await expectCopyBlocked(helper, copy);
  await expect(draft).toBeDisabled();
  await expect(helper.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await expect(helper.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
  // 复验期间不能在原范围继续编辑；通过真实联系人往返开启新范围，旧响应仍未释放。
  const picker = helper.getByRole('combobox', { name: '本次联系人', exact: true });
  const contacts = manager.getByRole('combobox', { name: '管理资料的联系人', exact: true });
  await contacts.selectOption(fixture.data.contact_ids[1]);
  await expect(picker).toHaveValue(fixture.data.contact_ids[1]);
  await contacts.selectOption(fixture.data.contact_ids[0]);
  await expect(picker).toHaveValue(fixture.data.contact_ids[0]);
  await confirmHelperContact(helper);
  await expect(draft).toBeEditable();
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase)).toBe('ready');
  expect((await helper.evaluate(() => window.notalone.replies.getState())).scopeRevision).toBeGreaterThan(old.scopeRevision);
  expect(proxy.heldCount).toBe(1);
  await draft.fill('新请求的独立合成草稿。');
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(editor).toHaveValue('来源引用合成候选。', { timeout: 2500 });
  await editor.fill('新请求的本轮编辑稿。');
  const current = await helper.evaluate(() => window.notalone.replies.getState());
  expect(current.result!.replyRequestId).not.toBe(old.result!.replyRequestId);
  // 必须先形成新请求，再显式放回旧范围响应；不能以提前释放后的串行结果冒充迟到覆盖。
  expect(proxy.heldCount).toBe(1);
  expect(proxy.heldStatuses).toEqual([200]);
  proxy.holdEvidencePath = null;
  proxy.release();
  // 联系人范围变化会回到“联系人记忆”；重新打开来源分类，由当前范围读取原删除任务。
  await openImportManagement(manager);
  await expect(panel.getByText('已删除，已通过不可检索校验', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(editor).toHaveValue('新请求的本轮编辑稿。');
  await expect(draft).toHaveValue('新请求的独立合成草稿。');
  await helper.getByRole('button', { name: '展开候选1依据', exact: true }).click();
  const basis = helper.getByRole('region', { name: '候选1依据', exact: true });
  await expect(basis.getByText('新请求的独立合成草稿。', { exact: true })).toBeVisible();
  await expect(basis.getByText('旧请求的独立合成草稿。', { exact: true })).toHaveCount(0);
  // 独立用户输入仍属于历史讨论；唯一旧文本必须位于该历史轮次，不能回到当前候选依据。
  expect(await helper.getByText('旧请求的独立合成草稿。', { exact: true }).evaluateAll(nodes => nodes.map(node => ({
    section: node.closest('section')?.getAttribute('aria-label'),
    turn: node.closest('article')?.getAttribute('aria-label'),
  })))).toEqual([{ section: '已保存的讨论', turn: '第1轮讨论' }]);
  const final = await helper.evaluate(() => window.notalone.replies.getState());
  expect(final.result!.replyRequestId).toBe(current.result!.replyRequestId);
  expect(final.savedSession!.currentInputVersionId).toBe(current.result!.inputVersionId);
  expect(final.savedSession!.turns.find(turn => turn.inputVersionId === old.result!.inputVersionId)?.input?.content.draft_text)
    .toBe('旧请求的独立合成草稿。');
  expect(final.selectedCandidateId).toBe(current.selectedCandidateId);
  expect((await fixture.http(`/api/contacts/${final.contactId}/replies/${final.result!.replyRequestId}/evidence`)).status).toBe(200);
}
