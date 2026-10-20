import { expect, type Locator, type Page } from '@playwright/test';
import type { PageHost } from './headless/page-host';
import type { ReplyGenerationJobState } from '../src/shared/reply-bridge';

// 通过现行统一工作区的可见控件操作；不把兼容模式或旧组件重新挂到页面。
export function workspaceInput(page: Page) {
  return page.getByRole('textbox', { name: '有什么想说的', exact: true });
}

export async function fillWorkspaceThought(page: Page, text: string): Promise<void> {
  const input = workspaceInput(page);
  await expect(input).toBeEditable();
  await input.fill(text);
}

export async function setWorkspaceContext(page: Page, enabled: boolean): Promise<void> {
  const workspace = page.getByRole('region', { name: '表达工作区', exact: true });
  const checkbox = workspace.getByRole('checkbox', { name: '参考最近聊天和相关关系资料', exact: true });
  if (!await checkbox.isVisible()) await workspace.getByText('最近聊天 · 查看／补充', { exact: true }).click();
  await checkbox.setChecked(enabled);
}

export async function fillWorkspaceInstruction(page: Page, text: string): Promise<void> {
  const workspace = page.getByRole('region', { name: '表达工作区', exact: true });
  const input = workspace.getByRole('textbox', { name: '本次要求', exact: true });
  if (!await input.isVisible()) await workspace.getByText('语气和本次要求', { exact: true }).click();
  await input.fill(text);
}

export async function generateWorkspace(page: Page, action: 'express' | 'suggest' = 'express'): Promise<void> {
  await page.getByRole('button', { name: action === 'express' ? '帮我表达' : '帮我想想', exact: true }).click();
}

// 等待真实公开续改命令收尾，沿用 prepare/execute 的业务预算；内容断言仍由调用者按原时限执行。
export async function continueWorkspace(page: Page, host: PageHost): Promise<ReplyGenerationJobState> {
  const before = await page.evaluate(() => window.notalone.replies.getState());
  const previousKeys = before.generationJobs?.map(job => job.requestKey) ?? [];
  const scope = { contactId: before.contactId, sessionId: before.savedSession?.sessionId,
    scopeRevision: before.scopeRevision, expectedInputVersionId: before.savedSession?.currentInputVersionId, previousKeys };
  expect(scope.contactId).toBeTruthy();
  expect(scope.sessionId).toBeTruthy();
  expect(scope.expectedInputVersionId).toBeTruthy();
  expect(before.continuation?.phase).not.toBe('waiting');
  await page.getByRole('region', { name: '连续修改', exact: true })
    .getByRole('button', { name: '继续修改', exact: true }).click();
  // job 在 prepare 返回 receipt 后才可见，不能用界面默认5秒限制合法的 prepare 请求。
  await expect.poll(() => page.evaluate(async captured => {
    const state = await window.notalone.replies.getState();
    if (!state.continuation) return false;
    return state.contactId === captured.contactId && state.scopeRevision === captured.scopeRevision
      && state.continuation.sessionId === captured.sessionId
      && state.continuation.expectedInputVersionId === captured.expectedInputVersionId
      && (state.continuation.phase === 'waiting' || Boolean(state.generationJobs?.some(job =>
        job.contactId === captured.contactId && job.sessionId === captured.sessionId
        && !captured.previousKeys.includes(job.requestKey))));
  }, scope)).toBe(true);
  await host.awaitPendingCommands();
  const finished = await page.evaluate(() => window.notalone.replies.getState());
  expect({ contactId: finished.contactId, scopeRevision: finished.scopeRevision,
    sessionId: finished.savedSession?.sessionId }).toEqual({ contactId: scope.contactId,
    scopeRevision: scope.scopeRevision, sessionId: scope.sessionId });
  const jobs = finished.generationJobs?.filter(job => job.contactId === scope.contactId
    && job.sessionId === scope.sessionId && !previousKeys.includes(job.requestKey)) ?? [];
  expect(jobs).toHaveLength(1);
  const [job] = jobs;
  expect(job.phase).toBe('completed');
  expect(finished.continuation?.phase).toBe('completed');
  expect(finished.savedSession?.currentInputVersionId).toBe(job.inputVersionId);
  expect(finished.savedSession?.turns.find(turn => turn.turnId === job.turnId)).toMatchObject({
    state: 'completed', requestKey: job.requestKey, inputVersionId: job.inputVersionId });
  return job;
}

export async function openWorkspaceSettings(page: Page): Promise<void> {
  const workspace = page.getByRole('region', { name: '表达工作区', exact: true });
  if (!await workspace.getByRole('combobox', { name: '本次语气', exact: true }).isVisible()) {
    await workspace.getByText('语气和本次要求', { exact: true }).click();
  }
}

export async function setWorkspaceTone(page: Page, tone: string): Promise<void> {
  await openWorkspaceSettings(page);
  await page.getByRole('combobox', { name: '本次语气', exact: true }).selectOption(tone);
}

// 候选的次要操作默认折叠；通过可见入口展开，再继续原业务操作。
export async function openCandidateMoreActions(scope: Page | Locator): Promise<void> {
  const actions = scope.locator('details.candidate-more-actions').first();
  await expect(actions).toBeVisible();
  if (await actions.getAttribute('open') === null) await actions.locator('summary').click();
}
