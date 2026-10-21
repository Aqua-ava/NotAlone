import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

// 契约单一来源：上限常量、回复失败码到界面语义的映射、前台待选原因集合只在共享模块维护一份。
const require = createRequire(path.resolve('package.json'));
const generated = await build({
  stdin: { contents: `
    export * from './src/shared/foreground-failure.mjs';
  `, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const foreground = await import(`data:text/javascript;base64,${Buffer.from(generated.outputFiles[0].text).toString('base64')}`);

const contractSource = await readFile('src/shared/reply-contract.ts', 'utf8').catch(() => '');
const bridgeSource = await readFile('src/main/reply/bridge.ts', 'utf8');
const sessionSource = await readFile('src/main/reply/session.ts', 'utf8');
const controllerSource = await readFile('src/main/foreground/controller.ts', 'utf8');
const foregroundSource = await readFile('src/shared/foreground-failure.mjs', 'utf8');

test('回复文本上限只有共享模块一处定义且桌面按后端 4096 执行', async () => {
  const replyContract = await import(`data:text/javascript;base64,${Buffer.from((await build({
    stdin: { contents: `export { replyTextLimit } from './src/shared/reply-contract';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  })).outputFiles[0].text).toString('base64')}`);
  assert.equal(await replyContract.replyTextLimit, 4096);
  assert.match(contractSource, /replyTextLimit\s*=\s*4096/, '上限常量必须在共享契约中声明');
  assert.match(bridgeSource, /replyTextLimit/, 'bridge 必须引用共享上限');
  assert.match(sessionSource, /replyTextLimit/, 'session 必须引用共享上限');
  assert.equal(bridgeSource.includes('8193'), false, 'bridge 不得再放行 8193');
});

test('回复失败码映射集中一处：已知码分类明确，未知码显式走未知可重试策略', async () => {
  const generatedReply = await build({
    stdin: { contents: `export { replyFailureDecision, replyTextLimit } from './src/shared/reply-contract';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  const { replyFailureDecision } = await import(`data:text/javascript;base64,${Buffer.from(generatedReply.outputFiles[0].text).toString('base64')}`);
  const decide = (evidence) => replyFailureDecision(evidence);
  assert.deepEqual(decide({ kind: 'connection' }), { errorCode: 'connection', canRetry: true, known: true });
  assert.deepEqual(decide({ code: 'reply_candidates_rejected' }), { errorCode: 'candidates_rejected', canRetry: false, known: true });
  assert.deepEqual(decide({ code: 'input_budget_exceeded', inputBudgetState: 'exceeded' }),
    { errorCode: 'input_budget_exceeded', canRetry: false, known: true });
  assert.deepEqual(decide({ code: 'input_budget_unavailable', inputBudgetState: 'unavailable' }),
    { errorCode: 'input_budget_unavailable', canRetry: false, known: true });
  assert.deepEqual(decide({ code: 'provider_context_limit', providerLimit: true }),
    { errorCode: 'provider_context_limit', canRetry: false, known: true });
  assert.deepEqual(decide({ reason: 'prepared_context_generation_running', formatFailure: true }),
    { errorCode: 'prepared_context_running', canRetry: false, known: true });
  assert.deepEqual(decide({ reason: 'prepared_context_generation_unconfirmed', formatFailure: true }),
    { errorCode: 'prepared_context_unconfirmed', canRetry: false, known: true });
  assert.deepEqual(decide({ reason: 'prepared_context_reprepare_required', formatFailure: true }),
    { errorCode: 'prepared_context_reprepare_required', canRetry: false, known: true });
  for (const code of ['reply_timeout', 'assistant_preparation_timeout']) {
    assert.deepEqual(decide({ code }), { errorCode: 'timeout', canRetry: true, known: true });
  }
  assert.deepEqual(decide({ code: 'assistant_session_save_failed' }), { errorCode: 'save_failed', canRetry: true, known: true });
  assert.deepEqual(decide({ reason: 'target_message_unavailable' }), { errorCode: 'target_unavailable', canRetry: true, known: true });
  for (const reason of ['source_unavailable', 'source_deleted']) {
    assert.deepEqual(decide({ reason }), { errorCode: 'source_unavailable', canRetry: true, known: true });
  }
  for (const code of ['reply_rejected', 'assistant_session_rejected']) {
    assert.deepEqual(decide({ code }), { errorCode: 'rejected', canRetry: true, known: true });
  }
  for (const code of ['reply_unavailable', 'runtime_stopping', 'assistant_preparation_busy']) {
    assert.deepEqual(decide({ code }), { errorCode: 'unavailable', canRetry: true, known: true });
  }
  // 未知码不静默折叠成已知失败：显式标记未知并保留既定可重试策略，供主进程记录。
  assert.deepEqual(decide({ code: 'future_backend_failure_code' }),
    { errorCode: 'generation_failed', canRetry: true, known: false });
  assert.deepEqual(decide({ kind: 'response', code: 'assistant_session_conflict' }),
    { errorCode: 'generation_failed', canRetry: true, known: false });
  assert.match(sessionSource, /replyFailureDecision\(/, 'session 必须使用共享映射');
  assert.match(sessionSource, /decision\.known/, '未知失败码必须显式分支处理');
});

test('前台待选原因集合来自共享模块，且每个原因都有固定中文说明', () => {
  assert.match(controllerSource, /isAwaitingForegroundSelection/, 'controller 必须引用共享待选判断');
  assert.doesNotMatch(controllerSource, /const awaitingSelectionReasons/, 'controller 不得保留第二份原因集合');
  const awaiting = ['ambiguous_requires_selection', 'unmatched_requires_selection',
    'session_candidates_truncated', 'manual_confirmation_required'];
  for (const code of awaiting) {
    assert.equal(foreground.isAwaitingForegroundSelection(code), true, code);
    assert.ok(foreground.foregroundFailureReason(code), `${code} 必须有固定说明`);
  }
  assert.equal(foreground.isAwaitingForegroundSelection('quality_unverified'), false);
  assert.equal(foreground.isAwaitingForegroundSelection(null), false);
});

test('后端前台失败原因都有共享说明，不靠界面默认分支静默兜底', async () => {
  const files = ['../backend/src/notalone/front_sync/foreground_locator.py',
    '../backend/src/notalone/front_sync/full_sync_engine.py'];
  const produced = new Set();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/reason="([a-z_]+)"/g)) produced.add(match[1]);
  }
  // 成功或用独立状态表达的固定码不要求失败说明。
  const nonFailure = new Set(['confirmed_active_binding', 'group_chat_suspected', 'group_chat_unsupported']);
  for (const code of produced) {
    if (nonFailure.has(code)) continue;
    assert.ok(foreground.foregroundFailureReason(code), `后端原因 ${code} 缺少共享说明`);
  }
  assert.match(foregroundSource, /isKnownForegroundReason|isAwaitingForegroundSelection/);
});
