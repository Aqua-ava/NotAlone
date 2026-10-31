import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireBuildSpace } from './build-space.mjs';
import { hashWechatFile, wechatCliSourceDirectory } from './wechat-components.mjs';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const repository = path.dirname(desktop.replace(/\/$/, ''));
export const historyCliBuildRoot = path.join(repository, '.scratch/sqlite-history-cli');
const wcdbSha256 = '4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d';
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\r\n\0]/.test(value);
const stat = async file => lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });

export function parseHistoryBuildArguments(args) {
  const options = {};
  const names = { '--source-directory': 'sourceDirectory', '--go-archive': 'goArchive',
    '--wcdb-library': 'wcdbLibrary', '--output-directory': 'outputDirectory',
    '--module-cache': 'moduleCache', '--build-cache': 'buildCache' };
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]], value = args[index + 1];
    if (!name || options[name] !== undefined || !absolute(value)) fail('history_cli_arguments_invalid');
    options[name] = value;
  }
  if (['goArchive', 'wcdbLibrary', 'outputDirectory'].some(name => !options[name])) fail('history_cli_arguments_invalid');
  return { sourceDirectory: wechatCliSourceDirectory, ...options };
}

export async function validateHistoryOutputDirectory(output) {
  // 每轮使用直属的新目录，既不覆盖现工具，也不复用上次失败的半成品。
  if (!absolute(output) || path.dirname(output) !== historyCliBuildRoot) fail('history_cli_output_invalid');
  if (await stat(output)) fail('history_cli_output_exists');
  let selected = historyCliBuildRoot;
  for (;;) {
    const entry = await stat(selected);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) fail('history_cli_output_invalid');
    if (selected === repository) break;
    selected = path.dirname(selected);
  }
}

export async function verifyHistoryBuildFile(file, expected, code) {
  const entry = await stat(file);
  if (!entry?.isFile() || entry.isSymbolicLink() || await hashWechatFile(file) !== expected) fail(code);
}

async function command(executable, args, options, code) {
  try { return await run(executable, args, { timeout: 180_000, maxBuffer: 8 * 1024 ** 2, ...options }); }
  catch { return fail(code); }
}

export async function applyHistoryBuildPatch(sourceOutput, patch) {
  // 归档位于父仓库内；阻止 Git 向上发现父仓，确保按归档根应用全部补丁。
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
    GIT_CEILING_DIRECTORIES: path.dirname(sourceOutput), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  await command('/usr/bin/git', ['apply', '--whitespace=error-all', patch], { cwd: sourceOutput, env: environment }, 'history_cli_patch_apply');
}

export async function validateHistoryBuildInputs(input) {
  const options = { sourceDirectory: wechatCliSourceDirectory, moduleCache: path.join(homedir(), 'go/pkg/mod'), ...input };
  options.buildCache ??= path.join(options.outputDirectory ?? '', 'build-cache');
  if (['sourceDirectory', 'goArchive', 'wcdbLibrary', 'outputDirectory', 'moduleCache', 'buildCache'].some(name => !absolute(options[name]))) fail('history_cli_arguments_invalid');
  await validateHistoryOutputDirectory(options.outputDirectory);
  const lockBytes = await readFile(path.join(desktop, 'wechat-sources.lock.json'));
  const lock = JSON.parse(lockBytes);
  const go = lock.archives.find(item => item.name === 'go');
  const source = lock.gitSources.find(item => item.name === 'wechat-cli');
  await verifyHistoryBuildFile(options.goArchive, go.sha256, 'history_cli_go_hash');
  await verifyHistoryBuildFile(options.wcdbLibrary, wcdbSha256, 'history_cli_wcdb_hash');
  for (const directory of [options.sourceDirectory, options.moduleCache]) {
    const entry = await stat(directory);
    if (!entry?.isDirectory() || entry.isSymbolicLink()) fail('history_cli_input_directory_invalid');
  }
  const gitEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const identity = await command('/usr/bin/git', ['-C', options.sourceDirectory, 'rev-parse', 'HEAD', 'HEAD^{tree}'], { env: gitEnvironment }, 'history_cli_source_unavailable');
  if (identity.stdout.trim() !== `${source.commit}\n${source.tree}`) fail('history_cli_source_identity');
  const readonlyPath = path.join(desktop, lock.cliPatch.file);
  await verifyHistoryBuildFile(readonlyPath, lock.cliPatch.sha256, 'history_cli_readonly_patch_hash');
  const patchPath = path.join(desktop, 'wechat-history/history-cli.patch');
  const patchStat = await stat(patchPath);
  if (!patchStat?.isFile() || patchStat.isSymbolicLink() || patchStat.size === 0 || patchStat.size > 4 * 1024 ** 2) fail('history_cli_overlay_patch_missing');
  const readonlyTestPath = path.join(desktop, lock.cliPatch.testFile);
  await verifyHistoryBuildFile(readonlyTestPath, lock.cliPatch.testSha256, 'history_cli_readonly_test_hash');
  const overlays = [{ destination: 'cmd/wechat-cli/notalone_readonly_test.go', bytes: await readFile(readonlyTestPath) }];
  for (const [directory, destination] of [['cmd', 'cmd/wechat-cli'], ['wcdb', 'internal/wcdb']]) {
    const root = path.join(desktop, 'wechat-history', directory);
    for (const name of (await readdir(root)).filter(name => name.endsWith('.go')).sort()) {
      const entry = await stat(path.join(root, name));
      if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > 1024 ** 2) fail('history_cli_overlay_invalid');
      overlays.push({ destination: path.posix.join(destination, name), bytes: await readFile(path.join(root, name)) });
    }
    if (!overlays.some(item => item.destination.startsWith(destination + '/'))) fail('history_cli_overlay_missing');
  }
  const readonlyPatch = await readFile(readonlyPath);
  if (digest(readonlyPatch) !== lock.cliPatch.sha256) fail('history_cli_readonly_patch_hash');
  return { options, source, go, gitEnvironment, sourceLockSha256: digest(lockBytes),
    readonlyPatch, historyPatch: await readFile(patchPath), overlays };
}

export async function buildHistoryCli(input) {
  // 构建产物、临时卷与显式缓存的写卷都先检查，任何输入失败前不创建输出。
  await validateHistoryOutputDirectory(input.outputDirectory);
  await requireBuildSpace([input.outputDirectory, tmpdir(), input.moduleCache ?? path.join(homedir(), 'go/pkg/mod'), input.buildCache ?? input.outputDirectory]);
  const plan = await validateHistoryBuildInputs(input);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('history_cli_platform_unsupported');
  const { options, source, go, gitEnvironment } = plan;
  await mkdir(historyCliBuildRoot, { recursive: true });
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const output = options.outputDirectory;
  const sourceOutput = path.join(output, 'source');
  const toolchain = path.join(output, 'toolchain');
  for (const directory of [sourceOutput, toolchain, path.join(output, 'bin'), path.join(output, 'lib'), path.join(output, 'tmp'), options.buildCache]) await mkdir(directory, { recursive: true });
  const sourceArchive = path.join(output, 'source.tar');
  await command('/usr/bin/git', ['-C', options.sourceDirectory, 'archive', '--format=tar', '--output=' + sourceArchive, source.commit], { env: gitEnvironment }, 'history_cli_source_archive');
  await command('/usr/bin/tar', ['-xf', sourceArchive, '-C', sourceOutput], {}, 'history_cli_source_extract');
  await rm(sourceArchive);
  const readonlyPatch = path.join(output, 'readonly-cli.patch'), historyPatch = path.join(output, 'history-cli.patch');
  await writeFile(readonlyPatch, plan.readonlyPatch, { flag: 'wx', mode: 0o600 });
  await writeFile(historyPatch, plan.historyPatch, { flag: 'wx', mode: 0o600 });
  for (const patch of [readonlyPatch, historyPatch]) await applyHistoryBuildPatch(sourceOutput, patch);
  for (const overlay of plan.overlays) await writeFile(path.join(sourceOutput, overlay.destination), overlay.bytes);
  const goArchive = path.join(output, 'go.tar.gz');
  await copyFile(options.goArchive, goArchive, constants.COPYFILE_EXCL);
  await verifyHistoryBuildFile(goArchive, go.sha256, 'history_cli_go_hash');
  await command('/usr/bin/tar', ['-xzf', goArchive, '-C', toolchain], {}, 'history_cli_go_extract');
  await rm(goArchive);
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: path.join(output, 'tmp'),
    GOTOOLCHAIN: 'local', GOENV: 'off', GOTELEMETRY: 'off', GOVCS: '*:off', GOPROXY: 'off', GOSUMDB: 'off',
    GOMODCACHE: options.moduleCache, GOCACHE: options.buildCache, GOPATH: path.join(output, 'gopath'),
    GOMAXPROCS: '2', CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: 'arm64' };
  const goExecutable = path.join(toolchain, 'go/bin/go');
  const version = await command(goExecutable, ['version'], { env: environment }, 'history_cli_go_version');
  if (version.stdout.trim() !== `go version go${go.version} darwin/arm64`) fail('history_cli_go_version');
  await command(goExecutable, ['mod', 'verify'], { cwd: sourceOutput, env: environment }, 'history_cli_module_verify');
  const executable = path.join(output, 'bin/wechat-cli');
  await command(goExecutable, ['build', '-p', '2', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X main.sourceCommit=${source.commit}`, '-o', executable, './cmd/wechat-cli'], { cwd: sourceOutput, env: environment }, 'history_cli_build_failed');
  await command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', executable], {}, 'history_cli_sign_failed');
  await command('/usr/bin/codesign', ['--verify', '--strict', executable], {}, 'history_cli_signature_invalid');
  const library = path.join(output, 'lib/libWCDB.dylib');
  await copyFile(options.wcdbLibrary, library, constants.COPYFILE_EXCL);
  await verifyHistoryBuildFile(library, wcdbSha256, 'history_cli_wcdb_hash');
  const manifest = { formatVersion: 1, kind: 'notalone-history-cli-development', architecture: 'arm64',
    version: source.version, sourceCommit: source.commit, sourceTree: source.tree, sourceLockSha256: plan.sourceLockSha256,
    goVersion: go.version, goArchiveSha256: go.sha256, readonlyPatchSha256: digest(plan.readonlyPatch),
    historyPatchSha256: digest(plan.historyPatch), overlaySha256: digest(JSON.stringify(plan.overlays.map(item => [item.destination, digest(item.bytes)]))),
    wcdbSha256, cliSha256: await hashWechatFile(executable), signing: 'ad-hoc-development', realWechatVerified: false };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await buildHistoryCli(parseHistoryBuildArguments(process.argv.slice(2)));
    console.log('历史CLI开发构建完成；真实微信支持仍须单独认证。');
  } catch (error) {
    console.error(error.code ?? error.message ?? 'history_cli_build_failed');
    process.exitCode = 1;
  }
}
