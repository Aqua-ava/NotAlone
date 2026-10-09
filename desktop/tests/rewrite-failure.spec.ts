import { test, openRewriteAppPages } from './rewrite-transport-fixture';
import { rewriteFailures } from './rewrite-page-scenarios';

test('真实模型超时和失败保留已有编辑，同键可恢复失败请求，空候选不会伪装成功', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  await rewriteFailures({ ...await openRewriteAppPages(app), rewriteBackend, replyTransport });
});
