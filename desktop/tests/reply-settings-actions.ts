import type { Page } from '@playwright/test';

// 学习与反馈回归经公开 bridge 显式声明权限范围，不从自动匹配结果推断场景授权。
export async function declareReplyScene(helper: Page, scene: string): Promise<void> {
  await helper.evaluate(async value => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.replies.updateScene({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, scene: value });
  }, scene);
}
