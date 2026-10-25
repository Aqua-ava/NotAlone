// 有限夹具回归：真实开发租约监听 + 跨进程准备/读取/清理；不启动 Electron。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, rmdir, realpath, stat} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {once} from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = fileURLToPath(new URL('../fixture.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const phase = ['red', 'closure-red'].includes(process.argv[2]) ? process.argv[2] : 'green';
const unchangedFiles = ['manifest.json', 'SHA256SUMS', 'handoff.md', 'operations.md', 'verification.json', 'source-snapshot.sha256'];
const originals = new Map(await Promise.all(unchangedFiles.map(async path => [path, sha(await readFile(join(here, '..', path)))])));
const privateDirectory = await realpath(await mkdtemp('/tmp/na-lease-check-'));
const longTmp = join(privateDirectory, 'synthetic-long-tmp-'.repeat(4), 'synthetic-long-tmp-'.repeat(4));
await mkdir(longTmp, {recursive: true, mode: 0o700});
await mkdir(join(privateDirectory, 'home'), {mode: 0o700});
const npmCli = await realpath(join(homedir(), 'miniconda3/envs/NotAlone/lib/node_modules/npm/bin/npm-cli.js'));
const environment = {HOME: join(privateDirectory, 'home'), PATH: '/usr/bin:/bin', TMPDIR: longTmp};
const runModule = (path, args) => JSON.parse(execFileSync(process.execPath, [path, ...args], {
  encoding: 'utf8', timeout: 30000, env: environment,
}));
let prepared, result = {phase, fixtureSha256: sha(await readFile(fixturePath))};
let failure;
try {
  const setup = `const {prepare}=await import(${JSON.stringify(pathToFileURL(fixturePath).href)});console.log(JSON.stringify(await prepare({npmCli:${JSON.stringify(npmCli)}})));`;
  prepared = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', setup], {
    encoding: 'utf8', timeout: 30000, env: environment,
  }));
  const record = JSON.parse(await readFile(prepared.sessionPath, 'utf8'));
  const temporaryDirectory = record.temporaryDirectory ?? join(record.directory, 'tmp');
  const project = join(record.projectDirectory, 'desktop');
  const leaseModule = pathToFileURL(join(project, 'scripts/development-lease.mjs')).href;
  const leaseProbe = `
import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {acquireDevelopmentLease} from ${JSON.stringify(leaseModule)};
const project=${JSON.stringify(project)};
const key=createHash('sha256').update(resolve(project)).digest('hex').slice(0,24);
const socket=join(tmpdir(),'notalone-dev-'+key+'.sock');
let lease,second;const value={socketPathBytes:Buffer.byteLength(socket),acquired:false};
try {
 lease=await acquireDevelopmentLease(project);assert.ok(lease);value.acquired=true;
 const metadata=await stat(socket);assert.ok(metadata.isSocket());assert.equal(metadata.mode&0o777,0o600);
 assert.equal(await acquireDevelopmentLease(project),undefined);value.existingLeaseRecognized=true;
 await lease.close();lease=undefined;await assert.rejects(stat(socket),{code:'ENOENT'});value.released=true;
 second=await acquireDevelopmentLease(project);assert.ok(second);await second.close();second=undefined;
 await assert.rejects(stat(socket),{code:'ENOENT'});value.reacquiredAndReleased=true;
} catch(error) {value.error=error.code??'lease_assertion_failed';}
finally {await lease?.close();await second?.close();}
console.log(JSON.stringify(value));`;
  const lease = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', leaseProbe], {
    encoding: 'utf8', timeout: 10000, env: {...environment, TMPDIR: temporaryDirectory},
  }));
  result = {...result, lease, inheritedLongTmpBytes: Buffer.byteLength(longTmp),
    fixtureTemporaryDirectoryBytes: Buffer.byteLength(temporaryDirectory),
    temporaryDirectoryRecorded: record.temporaryDirectory === temporaryDirectory,
    temporaryDirectoryPrivate: ((await stat(temporaryDirectory)).mode & 0o777) === 0o700};
  assert.equal(lease.acquired, true, '真实开发租约未成功监听');
  assert.equal(lease.released, true); assert.equal(lease.reacquiredAndReleased, true);
  assert.equal(result.temporaryDirectoryRecorded, true); assert.equal(result.temporaryDirectoryPrivate, true);
  const devScript = await readFile(join(project, 'scripts/dev.mjs'), 'utf8');
  const watchDeclaration = /for \(const \[directory, extension\] of (\[\[.*?\]\])\)/.exec(devScript);
  assert.ok(watchDeclaration, '实际 dev.mjs watchRoots 声明已变化，需重新核对');
  const watchRoots = JSON.parse(watchDeclaration[1].replaceAll("'", '"'));
  const compatibilityRoot = join(record.projectDirectory, 'backend/src/notalone');
  await rmdir(compatibilityRoot);
  let missingWatchRoot;
  try {const watcher = watch(compatibilityRoot, {recursive: true}, () => {}); watcher.close();}
  catch (error) {missingWatchRoot = error.code;}
  assert.equal(missingWatchRoot, 'ENOENT');
  result.missingCompatibilityWatchRootFails = missingWatchRoot;
  await mkdir(compatibilityRoot, {mode: 0o700});
  result.watchRoots = [];
  for (const [relative, extension] of watchRoots) {
    const path = join(project, relative);
    assert.equal((await stat(path)).isDirectory(), true);
    const watcher = watch(path, {recursive: true}, () => {});
    const closed = once(watcher, 'close'); watcher.close(); await closed;
    result.watchRoots.push({path: relative.replace(/^\.\.\//, ''), extension, openedAndClosed: true});
  }
  assert.deepEqual(record.emptyCompatibilityDirectories, ['backend/src/notalone']);
  try {
    result.build = runModule(join(here, 'build-snapshot.mjs'), [project, join(record.directory, 'build-check')]);
  } catch (error) {
    try {result.build = JSON.parse(String(error.stdout));} catch {}
    throw error;
  }
  assert.equal(result.build.main && result.build.preload && result.build.renderer, true);
  result.inspection = runModule(fixturePath, ['inspect', prepared.sessionPath]);
  const snapshot = JSON.parse(await readFile(join(record.directory, 'source-snapshot.json'), 'utf8'));
  await writeFile(join(here, 'staging-source.sha256'), snapshot.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n');
  result.sourceHead = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  result.stagingManifestSha256 = sha(await readFile(join(here, 'staging-source.sha256')));
  result.stagingFiles = snapshot.length;
  const launcher = await readFile(prepared.startScript, 'utf8');
  assert.ok(launcher.includes(`'TMPDIR=${temporaryDirectory}'`));
  result.launcherUsesRecordedTemporaryDirectory = true;
} catch (error) {
  failure = error;
  await writeFile(join(privateDirectory, 'failure.private.txt'), String(error.stack) + '\n' + String(error.stderr ?? ''), {mode: 0o600});
  result.failure = error.code ?? 'regression_assertion_failed';
} finally {
  if (prepared) {
    try {
      result.cleanup = runModule(fixturePath, ['close', prepared.sessionPath]);
      await assert.rejects(stat(prepared.directory), {code: 'ENOENT'});
    } catch (error) {failure ??= error; result.cleanupFailed = true;}
  }
  for (const [path, expected] of originals) assert.equal(sha(await readFile(join(here, '..', path))), expected, '旧冻结记录不可改写');
  result.oldFrozenArtifactsUnchanged = true;
  result.passed = !failure;
  result.claims = {electronStarted: false, dshStarted: false, wechatStarted: false, modelCalled: false,
    originalConfigurationRead: false, gitIndexModified: false, rootRunningFixtureTouched: false};
  await writeFile(join(here, phase === 'green' ? 'verification.json' : `${phase}-result.json`), JSON.stringify(result, null, 2) + '\n');
  if (!result.cleanupFailed) await rm(privateDirectory, {recursive: true});
}
console.log(JSON.stringify({phase, passed: result.passed, lease: result.lease, build: result.build && {
  main: result.build.main, preload: result.build.preload, renderer: result.build.renderer,
  error: result.build.error, missingManagedRuntimeContract: result.build.missingManagedRuntimeContract}, cleanup: result.cleanup}));
if (failure) process.exitCode = 1;
