import { test, openRewriteAppPages } from './rewrite-transport-fixture';
import { rewriteFailures } from './rewrite-page-scenarios';
import { writeFile } from 'node:fs/promises';

test('真实模型超时和失败保留已有编辑，同键可恢复失败请求，空候选不会伪装成功', async ({ runningApp: { app, appProcess, userData }, rewriteBackend, replyTransport }) => {
  await writeFile(test.info().outputPath('owned-runtime.json'), JSON.stringify({
    appPid: appProcess.pid, fixturePid: rewriteBackend.child.pid, userData,
    fixtureDirectory: rewriteBackend.directory,
    databaseName: /(?:^|\s)dbname=(notalone_core_flow_[0-9a-f]{32}_test)(?:\s|$)/.exec(rewriteBackend.data.database_url)?.[1],
  }), { mode: 0o600 });
  const pages = await openRewriteAppPages(app);
  try { await rewriteFailures({ ...pages, rewriteBackend, replyTransport }); }
  finally {
    const state = await pages.helper.evaluate(async (contactId) => {
      const state = await window.notalone.replies.getState();
      return { phase: state.phase, errorCode: state.errorCode, canRetry: state.canRetry,
        contactMatchesFixture: state.contactId === contactId,
        savedSessionPhase: state.savedSession?.phase,
        savedTurnStates: state.savedSession?.turns.map((turn) => turn.state) };
    }, rewriteBackend.data.contact_ids[0]).catch(() => ({ diagnosticStateUnavailable: true }));
    const safeCode = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : null;
    await writeFile(test.info().outputPath('failure-observations.json'), JSON.stringify({
      preparations: replyTransport.replyPreparations,
      responses: replyTransport.results.map((row) => ({ status: row.status,
        error: safeCode(row.data.error), reason: safeCode(row.data.reason) })), state,
    }), { mode: 0o600 });
  }
});
