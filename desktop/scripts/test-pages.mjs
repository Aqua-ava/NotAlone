import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { build, stop as stopBuild } from 'esbuild';
import { acquireLease, leaseStatus, ownedGroupGone } from './app-test-lease.mjs';
import { withoutExternalTracing } from './test-environment.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function parse(args) {
  if (args[0] === '--probe') {
    const id = args[1];
    if (!/^[a-f\d-]{36}$/.test(id ?? '')) throw new Error('page_test_arguments: 探针标识不可核验');
    if (args.length === 3 && args[2] === '--status') return { mode: 'status', id };
    let hold = 0; let timeout; let uncertain = false;
    args.splice(0, 2);
    while (args.length) {
      const key = args.shift();
      if (key === '--hold-ms') hold = Number(args.shift());
      else if (key === '--timeout-seconds') timeout = Number(args.shift());
      else if (key === '--unconfirmed') uncertain = true;
      else throw new Error('page_test_arguments: 探针参数不可核验');
    }
    if (!Number.isInteger(hold) || hold < 0 || hold > 30_000 || !Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw new Error('page_test_arguments: 探针须有有限时段');
    return { mode: 'probe', id, hold, timeout, uncertain };
  }
  const names = []; let timeout;
  while (args.length) {
    const key = args.shift();
    if (key === '--case' && ['layered-memory', 'memory-skill-evolution', 'skill-feedback', 'skill-lifecycle', 'skill-review', 'memory-upgrade', 'skill-learning', 'expression-preferences', 'overview-reply-retrieval', 'owner-facts-overview', 'contact-relationship-overview', 'historical-reply-basis', 'memory-event-updates', 'memory-current-status', 'memory-correction-protection', 'assistant-session-combination', 'assistant-message-opt-in', 'reply-strategy-combination', 'assistant-session-full-history', 'assistant-input-budget-hard', 'assistant-candidate-carry', 'authentic-expression-typed', 'assistant-input-budget', 'authentic-expression-groups', 'reply-strategy-confirmed-lifecycle', 'reply-strategy-lifecycle', 'assistant-session-catalog', 'assistant-session-catalog-guards', 'assistant-session-deletion-recovered-copy', 'assistant-session-deletion-faults', 'assistant-session-deletion-lifecycle', 'assistant-session-deletion', 'understanding-direction', 'response-scene-entry', 'reply-strategy-skills', 'reply-strategy-skill-invalidation', 'reply-strategy-confirmed-clarification', 'style-session-editor-erasure', 'reply-strategy-bounded-updates', 'reply-strategy-message-groups', 'reply-strategy-group-boundaries', 'reply-strategy-version-edit-guard', 'reply-strategy-transition', 'reply-strategy-options', 'reply-strategy-dialogue', 'reply-strategy-invalidation', 'authentic-expression-session-retention', 'authentic-expression-recovery', 'assistant-session-recovery', 'assistant-session-recovery-guards', 'style-reference', 'style-copy-limits', 'style-copy-origin', 'style-samples', 'fidelity-intent', 'fidelity-content', 'assistant-session-persistence', 'conversation-strategy-entry', 'memory-traces-record-deletion', 'memory-traces-full', 'memory-traces-lifecycle', 'memory-traces', 'memory-reading', 'memory-reading-full', 'memory-stale-full', 'draft-rewrite', 'draft-rewrite-acceptance', 'draft-rewrite-session', 'candidate-visibility', 'direction-generation-feedback', 'directed-reply', 'candidate-copy', 'message-events', 'foreground-visual-preview', 'foreground-paused', 'foreground-verified', 'foreground-manual', 'foreground-confirmation-safety', 'source-deletion-full', 'source-deletion-stale-request', 'source-deletion-multi-source', 'source-deletion-unrelated', 'source-deletion-evidence-failure', 'source-deletion-cross-contact', 'source-deletion-replies', 'source-deletion-basic', 'source-deletion-verification', 'source-deletion-unknown', 'source-deletion-arguments', 'import-submit-acceptance', 'import-stale-acceptance', 'import-bootstrap', 'import-bootstrap-prepare-failure', 'binding-consent', 'binding-stale', 'sync-switch', 'sync-backfill-retry', 'sync-arguments', 'sync-control-full', 'reply-evidence', 'memory-editing-owner', 'memory-editing-addition', 'memory-editing-contact-correction', 'memory-editing-removal', 'memory-editing-confirm', 'memory-editing-discard', 'memory-editing-failures', 'memory-editing-arguments', 'memory-editing-stale', 'memory-editing-full'].includes(args[0])) names.push(args.shift());
    else if (key === '--timeout-seconds' && /^\d+$/.test(args[0] ?? '')) timeout = Number(args.shift());
    else throw new Error('page_test_arguments: 需要明确页面范围与有限截止时间');
  }
  if (!names.length || names.length > 2 || new Set(names).size !== names.length || !Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error('page_test_arguments: 页面范围最多两组且不重复，时限为1至300秒');
  }
  return { names, timeout };
}
function pageFixtureEnvironment(options, environment) {
  const result = {};
  for (const [name, key] of [['memory-skill-evolution', 'NOTALONE_EVOLUTION_EVIDENCE_DIR'], ['skill-feedback', 'NOTALONE_LEARNING_EVIDENCE_DIR'], ['skill-lifecycle', 'NOTALONE_LEARNING_EVIDENCE_DIR'], ['memory-upgrade', 'NOTALONE_UPGRADE_EVIDENCE_DIR'], ['skill-learning', 'NOTALONE_LEARNING_EVIDENCE_DIR'], ['skill-review', 'NOTALONE_LEARNING_EVIDENCE_DIR'], ['expression-preferences', 'NOTALONE_PREFERENCE_EVIDENCE_DIR'],
    ['overview-reply-retrieval', 'NOTALONE_REPLY_OVERVIEW_TEST_EVIDENCE_DIR'],
    ['layered-memory', 'NOTALONE_LAYERED_TEST_EVIDENCE_DIR'],
    ['contact-relationship-overview', 'NOTALONE_OVERVIEW_TEST_EVIDENCE_DIR'],
    ['owner-facts-overview', 'NOTALONE_OWNER_OVERVIEW_TEST_EVIDENCE_DIR']]) {
    if (!options.names?.includes(name)) continue;
    const directory = environment[key];
    const project = path.resolve(desktop, '..');
    if (!directory || !path.isAbsolute(directory) || path.resolve(directory) === project
      || path.resolve(directory).startsWith(`${project}${path.sep}`)) {
      throw new Error('page_test_environment: 概览页面须显式使用仓库外的验收证据目录');
    }
    result[key] = directory;
  }
  return result;
}
async function run(options) {
  if (options.mode !== 'probe' && (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX)) throw new Error('page_test_environment: 请先激活 Conda NotAlone');
  const fixtureEnvironment = pageFixtureEnvironment(options, process.env);
  for (const key of Object.keys(fixtureEnvironment)) {
    const directory = await realpath(fixtureEnvironment[key]);
    pageFixtureEnvironment(options, { ...fixtureEnvironment, [key]: directory });
    const evidence = await stat(directory);
    if (!evidence.isDirectory() || (evidence.mode & 0o777) !== 0o700) {
      throw new Error('page_test_environment: 页面验收证据目录须使用700权限');
    }
    fixtureEnvironment[key] = directory;
  }
  if (options.names?.includes('memory-skill-evolution')) {
    const guardKeys = ['NOTALONE_EVOLUTION_GUARD_ADAPTER_PATH', 'NOTALONE_EVOLUTION_GUARD_ADAPTER_SHA256',
      'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_PATH', 'NOTALONE_EVOLUTION_GUARD_DATABASE_GUARD_SHA256'];
    if (!guardKeys.every(key => process.env[key])) throw new Error('page_test_environment: 组合页面须固定本轮完整资源守卫');
    for (const key of guardKeys) fixtureEnvironment[key] = process.env[key];
    const { memorySkillEvolutionModules } = await import('../tests/fixtures/memory-skill-evolution-modules.mjs');
    fixtureEnvironment.NOTALONE_EVOLUTION_EXPECTED_MODULES = JSON.stringify(await memorySkillEvolutionModules(path.resolve(desktop, '..')));
  }
  if (options.names?.some(name => ['skill-learning', 'skill-review', 'skill-lifecycle', 'skill-feedback'].includes(name))) {
    const feedback = options.names.includes('skill-feedback');
    const lifecycle = options.names.includes('skill-lifecycle');
    const reviewing = feedback || lifecycle || options.names.includes('skill-review');
    if (feedback) fixtureEnvironment.NOTALONE_SKILL_FEEDBACK_PAGE = '1';
    if (lifecycle) fixtureEnvironment.NOTALONE_SKILL_LIFECYCLE_PAGE = '1';
    if (reviewing) fixtureEnvironment.NOTALONE_SKILL_REVIEW_PAGE = '1';
    const guardKeys = ['NOTALONE_LEARNING_GUARD_ADAPTER_PATH', 'NOTALONE_LEARNING_GUARD_ADAPTER_SHA256',
      'NOTALONE_LEARNING_GUARD_DATABASE_GUARD_PATH', 'NOTALONE_LEARNING_GUARD_DATABASE_GUARD_SHA256'];
    if (guardKeys.some(key => process.env[key])) {
      if (!guardKeys.every(key => process.env[key])) throw new Error('page_test_environment: 审核守卫须完整固定路径与摘要');
      for (const key of guardKeys) fixtureEnvironment[key] = process.env[key];
    }
    const { skillLearningModules } = await import('../tests/fixtures/skill-learning-modules.mjs');
    fixtureEnvironment.NOTALONE_LEARNING_EXPECTED_MODULES = JSON.stringify(await skillLearningModules(
      path.resolve(desktop, '..'), 'desktop/tests/fixtures/skill-learning-page.py', { reviewing, lifecycle, feedback }));
  }
  if (options.names?.includes('memory-upgrade')) {
    const guardKeys = ['NOTALONE_UPGRADE_GUARD_ADAPTER_PATH', 'NOTALONE_UPGRADE_GUARD_ADAPTER_SHA256',
      'NOTALONE_UPGRADE_DATABASE_GUARD_PATH', 'NOTALONE_UPGRADE_DATABASE_GUARD_SHA256'];
    if (guardKeys.some(key => process.env[key])) {
      if (!guardKeys.every(key => process.env[key])) throw new Error('page_test_environment: 升级守卫须完整固定路径与摘要');
      for (const key of guardKeys) fixtureEnvironment[key] = process.env[key];
    }
    const { memoryUpgradeModules } = await import('../tests/fixtures/memory-upgrade-modules.mjs');
    fixtureEnvironment.NOTALONE_UPGRADE_EXPECTED_MODULES = JSON.stringify(await memoryUpgradeModules(
      path.resolve(desktop, '..'), 'desktop/tests/fixtures/memory-upgrade-page.py'));
  }
  if (options.names?.includes('expression-preferences')) {
    const { expressionPreferenceModules } = await import('../tests/fixtures/expression-preference-modules.mjs');
    fixtureEnvironment.NOTALONE_PREFERENCE_EXPECTED_MODULES = JSON.stringify(await expressionPreferenceModules(
      path.resolve(desktop, '..'), 'desktop/tests/fixtures/expression-preferences-page.py'));
  }
  if (options.mode !== 'probe') await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', constants.X_OK)
    .catch(() => { throw new Error('page_test_browser_unavailable: 本机Chrome不可用；不会下载浏览器'); });
  const until = Date.now() + options.timeout * 1000;
  const lease = await acquireLease({ mode: 'headless', id: options.id, until, desktop, coordinator: 'page-checks' });
  let child; let code = 0; let confirmed = false; let forceTimer; let runtimeAttempted = false;
  const children = [];
  const nonce = randomBytes(32).toString('hex');
  const stop = (status) => {
    code ||= status;
    if (child?.exitCode === null && child.signalCode === null) {
      const owned = child;
      owned.kill('SIGTERM');
      forceTimer ??= setTimeout(() => {
        if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGKILL');
      }, 20_000);
    }
  };
  const interrupt = () => stop(130); const terminate = () => stop(143);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const deadline = setTimeout(() => stop(124), options.timeout * 1000);
  const executeBuild = (command = process.execPath, args = ['scripts/build.mjs']) => new Promise((resolve) => {
    child = spawn(command, args, { cwd: desktop, detached: true, stdio: 'inherit', env: withoutExternalTracing(process.env) });
    children.push(child);
    child.once('error', () => resolve(2)); child.once('close', (status) => resolve(status ?? 2));
  });
  const executeRunner = (probe) => new Promise((resolve) => {
    runtimeAttempted = true;
    const environment = withoutExternalTracing(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NOTALONE_') && !key.startsWith('DEEPSEEK_'))));
    child = fork(path.join(desktop, probe ? 'tests/headless/probe-child.mjs' : 'artifacts/headless-runtime/run.mjs'),
      probe ? [String(options.hold), String(options.uncertain)] : [], { cwd: desktop, detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...environment, ...fixtureEnvironment, NOTALONE_DISABLE_DOTENV: '1', NOTALONE_PAGE_RUN_NONCE: nonce, NOTALONE_PAGE_CASES: JSON.stringify(options.names) } });
    children.push(child);
    child.on('message', (message) => {
      if (message?.nonce !== nonce) return;
      if (message.cleanupConfirmed === true) confirmed = true;
      if (message.ready === true) process.stdout.write('page_test_probe_ready: 合成孩子就绪；无浏览器、Electron 未运行。\n');
    });
    child.once('error', () => resolve(2)); child.once('close', (status) => resolve(status ?? 2));
  });
  try {
    if (options.mode === 'probe') { const status = await executeRunner(true); code ||= status; return code; }
    process.stdout.write('验证范围：单个无头Chrome、生产页面与隔离HTTP/PG；Electron 未运行，原生验收未完成。\n');
    const buildStatus = await executeBuild(); code ||= buildStatus;
    if (!code && Date.now() < until) {
      await mkdir(path.join(desktop, 'artifacts/headless-runtime'), { recursive: true });
      const helperStatus = await executeBuild('/usr/bin/xcrun', ['swiftc', 'tests/headless/quiet-observation.swift', '-o', 'artifacts/headless-runtime/quiet-observation']); code ||= helperStatus;
      await build({ entryPoints: [path.join(desktop, 'tests/headless/renderer.ts')], outfile: path.join(desktop, 'artifacts/headless-runtime/renderer.js'), bundle: true, platform: 'browser', format: 'iife' });
      await build({ entryPoints: [path.join(desktop, 'tests/headless/run.ts')], outfile: path.join(desktop, 'artifacts/headless-runtime/run.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
      if (Date.now() >= until || code) { code ||= 124; confirmed = true; }
      else { const status = await executeRunner(false); code ||= status; }
    } else confirmed = true;
    return code;
  } finally {
    clearTimeout(deadline); clearTimeout(forceTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    stopBuild();
    if ((confirmed || !runtimeAttempted) && children.every(ownedGroupGone)) await lease.release();
    else { process.stderr.write('page_test_cleanup_unconfirmed: 保留本轮租约，禁止下一轮；不杀未知进程。\n'); process.exitCode = 2; }
  }
}
try {
  if (args.length === 1 && args[0] === '--status') {
    process.stdout.write(`${JSON.stringify(await leaseStatus(undefined, 'headless'))}\n验证范围：无头页面租约；Electron 未运行。\n`);
  } else {
    const options = parse(args);
    if (options.mode === 'status') process.stdout.write(`${JSON.stringify(await leaseStatus(options.id, 'headless'))}\nElectron 未运行。\n`);
    else { const status = await run(options); process.exitCode ||= status; }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
