import { test, openRewriteAppPages } from './rewrite-transport-fixture';
import { defaultRewrite } from './rewrite-page-scenarios';

test('草稿默认只改写原句，真实候选可编辑且保留原快照', async ({ runningApp: { app }, rewriteBackend, replyTransport }, testInfo) => {
  await defaultRewrite({ ...await openRewriteAppPages(app), rewriteBackend, replyTransport,
    screenshotPath: testInfo.outputPath('draft-candidates.png') });
});
