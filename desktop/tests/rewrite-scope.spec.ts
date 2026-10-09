import { test, openRewriteAppPages } from './rewrite-transport-fixture';
import { relationshipScope, unboundRejection } from './rewrite-page-scenarios';

test('主动开启关系语境只进入当前联系人范围，切换清除候选、编辑和当次要求', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  await relationshipScope({ ...await openRewriteAppPages(app), rewriteBackend, replyTransport });
});

test('没有 active 已确认绑定时真实拒绝生成，其他 owner 的联系人不出现在目录', async ({ runningApp: { app }, rewriteBackend, replyTransport }) => {
  await unboundRejection({ ...await openRewriteAppPages(app), rewriteBackend, replyTransport });
});
