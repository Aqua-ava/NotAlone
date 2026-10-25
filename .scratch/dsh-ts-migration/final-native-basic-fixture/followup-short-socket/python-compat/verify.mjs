// 兼容路径只做文件核验；新记录另存，不改既有冻结记录，不启动产品。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, realpath, stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {once} from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const parent = dirname(here), base = dirname(parent);
const fixturePath = join(base, 'fixture.mjs');
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frozen = ['../manifest.json', '../SHA256SUMS', '../verification.json', '../handoff.md', '../staging-source.sha256',
  '../../manifest.json', '../../SHA256SUMS', '../../verification.json', '../../handoff.md', '../../source-snapshot.sha256'];
const originalHashes = new Map(await Promise.all(frozen.map(async path => [path, sha(await readFile(join(here, path)))])));
const python = await realpath(join(userInfo().homedir, 'miniconda3/envs/NotAlone/bin/python'));
const {prepare} = await import(pathToFileURL(fixturePath).href);
await assert.rejects(prepare({pythonExecutable: process.execPath}), /fixture_python_compatibility_path_invalid/);
const prepared = await prepare({pythonExecutable: python});
const record = JSON.parse(await readFile(prepared.sessionPath, 'utf8'));
const environment = {HOME: record.directory, PATH: '/usr/bin:/bin', TMPDIR: record.temporaryDirectory};
const run = (script, args) => JSON.parse(execFileSync(process.execPath, [script, ...args], {
  encoding: 'utf8', env: environment, timeout: 30000,
}));
const result = {fixtureSha256: sha(await readFile(fixturePath)), explicitCompatibilityPath: true,
  nodeAsPythonRejected: true, pythonInvocationsByThisTool: 0, productPythonExecutionValidated: false};
let failure;
try {
  const configuration = JSON.parse(await readFile(join(record.userData, 'backend-launch.json'), 'utf8'));
  assert.equal(configuration.pythonExecutable, python);
  assert.equal(record.compatibility.pathOnly, true);
  result.inspection = run(fixturePath, ['inspect', prepared.sessionPath]);
  const leaseModule = pathToFileURL(join(record.projectDirectory, 'desktop/scripts/development-lease.mjs')).href;
  const project = join(record.projectDirectory, 'desktop');
  const leaseScript = `import assert from 'node:assert/strict';import {stat} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {acquireDevelopmentLease} from ${JSON.stringify(leaseModule)};const p=${JSON.stringify(project)},s=join(tmpdir(),'notalone-dev-'+createHash('sha256').update(resolve(p)).digest('hex').slice(0,24)+'.sock');let a,b;try{a=await acquireDevelopmentLease(p);assert.ok(a);assert.equal(await acquireDevelopmentLease(p),undefined);await a.close();a=undefined;await assert.rejects(stat(s),{code:'ENOENT'});b=await acquireDevelopmentLease(p);assert.ok(b);await b.close();b=undefined;await assert.rejects(stat(s),{code:'ENOENT'});console.log(JSON.stringify({acquiredReleasedReacquired:true,socketPathBytes:Buffer.byteLength(s)}));}finally{await a?.close();await b?.close();}`;
  result.lease = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', leaseScript], {
    encoding: 'utf8', env: environment, timeout: 10000,
  }));
  result.watchRoots = [];
  const dev = await readFile(join(project, 'scripts/dev.mjs'), 'utf8');
  const declaration = /for \(const \[directory, extension\] of (\[\[.*?\]\])\)/.exec(dev);
  assert.ok(declaration);
  for (const [path, extension] of JSON.parse(declaration[1].replaceAll("'", '"'))) {
    const watcher = watch(join(project, path), {recursive: true}, () => {});
    const closed = once(watcher, 'close');watcher.close();await closed;
    result.watchRoots.push({path: path.replace(/^\.\.\//, ''), extension, openedAndClosed: true});
  }
  result.build = run(join(parent, 'build-snapshot.mjs'), [project, join(record.directory, 'build-check')]);
  assert.equal(result.build.main && result.build.preload && result.build.renderer, true);
  const snapshot = JSON.parse(await readFile(join(record.directory, 'source-snapshot.json'), 'utf8'));
  await writeFile(join(here, 'staging-source.sha256'), snapshot.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n');
  result.stagingFiles = snapshot.length;
  result.sourceHead = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
} catch (error) {failure = error;result.error = error.code ?? 'compatibility_preflight_failed';}
finally {
  result.cleanup = run(fixturePath, ['close', prepared.sessionPath]);
  await assert.rejects(stat(prepared.directory), {code: 'ENOENT'});
  for (const [path, hash] of originalHashes) assert.equal(sha(await readFile(join(here, path))), hash);
  result.preexistingFrozenArtifactsUnchanged = true;
  result.passed = !failure;
  result.boundaries = {electronStarted: false, dshStarted: false, wechatStarted: false, modelCalled: false,
    originalUserConfigurationRead: false, rootRunningFixtureTouched: false, gitIndexModified: false};
  await writeFile(join(here, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({passed: result.passed, compatibilityPythonPathConfigured: result.inspection?.config.compatibilityPythonPathConfigured,
  nodeAsPythonRejected: true, lease: result.lease, buildPassed: result.build?.main && result.build?.preload && result.build?.renderer,
  watchRoots: result.watchRoots?.length, cleanup: result.cleanup}));
if (failure) process.exitCode = 1;
