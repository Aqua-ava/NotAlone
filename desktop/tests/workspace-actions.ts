import { expect, type Page } from '@playwright/test';

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
