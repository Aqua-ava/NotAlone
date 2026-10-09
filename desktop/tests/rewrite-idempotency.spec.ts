import { test, openRewriteAppPages } from './rewrite-transport-fixture';
import { idempotentRewrite } from './rewrite-page-scenarios';

test('丢失响应后同键恢复原候选，编辑不被重放覆盖，新输入和重新生成使用新键', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  await idempotentRewrite({ ...await openRewriteAppPages(app), rewriteBackend, replyTransport });
});
