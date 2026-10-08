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
