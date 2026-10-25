// 单轮有限自检；不启动 App、DSH 后台、微信或模型。原始异常只写私有目录。
import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const privateLog = await mkdtemp(join(tmpdir(), 'notalone-final-fixture-check-'));
const modulePath = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
let prepared, cleanup;
try {
  const beforeDirectories = (await readdir(tmpdir())).filter(name => name.startsWith('notalone-final-native-')).sort();
  const handles = process._getActiveHandles().length;
  const fixture = await import('./fixture.mjs');
  const afterDirectories = (await readdir(tmpdir())).filter(name => name.startsWith('notalone-final-native-')).sort();
  if (JSON.stringify(beforeDirectories) !== JSON.stringify(afterDirectories)
    || process._getActiveHandles().length !== handles) throw new Error('fixture_import_has_side_effects');
  prepared = process.argv[2]
    ? {sessionPath: process.argv[2], directory: JSON.parse(await readFile(process.argv[2], 'utf8')).directory}
    : await fixture.prepare();
  // 新进程可恢复同一夹具，prepare 进程结束／stdin 关闭不会删除资源。
  const childEnvironment = {HOME: prepared.directory, PATH: '/usr/bin:/bin', TMPDIR: tmpdir()};
  const inspection = JSON.parse(execFileSync(process.execPath, [modulePath, 'inspect', prepared.sessionPath],
    {encoding: 'utf8', env: childEnvironment, timeout: 30000}));
  const snapshot = JSON.parse(await readFile(join(prepared.directory, 'source-snapshot.json'), 'utf8'));
  await writeFile(new URL('./source-snapshot.sha256', import.meta.url),
    snapshot.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n');
  cleanup = JSON.parse(execFileSync(process.execPath, [modulePath, 'close', prepared.sessionPath],
    {encoding: 'utf8', env: childEnvironment, timeout: 15000}));
  await stat(prepared.directory).then(() => {throw new Error('fixture_directory_remaining');}, error => {
    if (error.code !== 'ENOENT') throw error;
  });
  const publicResult = {base: '7a1f58a679245c6df84d88dfaafc3ff2c352c290',
    sourceHead: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    importedWithoutResources: true, recoveredInSeparateProcess: true, inspection, cleanup,
    commands: ['node --check fixture.mjs / seed.mjs / synthetic-cli.mjs', 'node self-check.mjs'],
    claims: {syntheticPgOnly: true, appStarted: false, wechatStarted: false, modelCalled: false,
      desktopAcceptancePassed: false, sourceModified: false, gitIndexModified: false}};
  await writeFile(new URL('./verification.json', import.meta.url), JSON.stringify(publicResult, null, 2) + '\n');
  await rm(privateLog, {recursive: true});
  console.log(JSON.stringify({verified: true, cleanup, migrationCount: inspection.migrationCount}));
} catch (error) {
  await writeFile(join(privateLog, 'error.private.txt'), String(error.stack) + '\n' + String(error.stderr ?? ''), {mode: 0o600});
  if (prepared && !cleanup) {
    try {await (await import('./fixture.mjs')).close(prepared.sessionPath);}
    catch (failure) {await writeFile(join(privateLog, 'cleanup.private.txt'), String(failure.stack), {mode: 0o600});}
  }
  console.error(JSON.stringify({verified: false, error: error.code ?? 'fixture_check_failed', privateLog}));
  process.exitCode = 1;
}
