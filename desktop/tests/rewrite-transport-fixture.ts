import type { ElectronApplication } from '@playwright/test';
import { test as rewriteTest } from './rewrite-fixture';
import { RewriteHttpProxy } from './rewrite-http-proxy';

export const test = rewriteTest.extend<{ replyTransport: RewriteHttpProxy }>({
  replyTransport: async ({ rewriteBackend }, use) => {
    const proxy = await RewriteHttpProxy.attach(rewriteBackend.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  },
  appEnvironment: async ({ rewriteBackend, replyTransport }, use) => {
    void replyTransport;
    await use(rewriteBackend.environment());
  },
});

export async function openRewriteAppPages(app: ElectronApplication) {
  const manager = await app.firstWindow();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  return { manager, helper: await opened };
}
