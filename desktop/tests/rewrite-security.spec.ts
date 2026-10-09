import { test, openRewriteAppPages } from './rewrite-transport-fixture';
import { rewriteSecurity } from './rewrite-page-scenarios';

test('受限桥接拒绝管理窗口生成、任意 owner 参数和未选择联系人，不发起业务请求', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  await rewriteSecurity({ ...await openRewriteAppPages(app), rewriteBackend, replyTransport });
});
