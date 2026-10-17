import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { requireBuildSpace } from './build-space.mjs';
import { hashWechatFile, inspectWechatComponents, wechatAcceptance, wechatCapabilities, wechatDirectoryName, wechatInventory, wechatLockedComponents, wechatPaths } from './wechat-components.mjs';
const run = promisify(execFile);
const desktop = new URL('../', import.meta.url).pathname;
const lockFile = path.join(desktop, 'wechat-sources.lock.json');
const systemEnvironment = directory => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' });

async function checkedSource(cache, item, allowDownload) {
  const selected = path.join(cache, item.filename); const stat = await lstat(selected).catch(() => undefined);
  if (!stat) {
    if (!allowDownload) throw new Error(`wechat_source_missing:${item.filename}`);
    const response = await fetch(item.source, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`wechat_source_unavailable:${item.filename}`);
    const partial = `${selected}.partial-${process.pid}`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
      if (await hashWechatFile(partial) !== item.sha256) throw new Error(`wechat_source_hash:${item.filename}`);
      await rename(partial, selected);
    } finally { await rm(partial, { force: true }); }
  } else if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`wechat_source_kind:${item.filename}`);
  if (await hashWechatFile(selected) !== item.sha256) throw new Error(`wechat_source_hash:${item.filename}`);
  return selected;
}
async function gitSource(cache, item, allowDownload, staging) {
  const selected = path.join(cache, item.directory);
  if (!(await lstat(selected).catch(() => undefined))) {
    if (!allowDownload) throw new Error(`wechat_source_missing:${item.directory}`);
    await run('/usr/bin/git', ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', item.ref, item.source, selected], { timeout: 180_000, maxBuffer: 1024 * 1024 });
    // 部分克隆的需要对象仅在显式联网构建中取得。
    await run('/usr/bin/git', ['-C', selected, 'sparse-checkout', 'set', '--no-cone', ...(item.paths || ['/*'])], { timeout: 180_000 });
    await run('/usr/bin/git', ['-C', selected, 'checkout', '--detach', item.commit], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  }
  const identity = (await run('/usr/bin/git', ['-C', selected, 'rev-parse', 'HEAD', 'HEAD^{tree}'], { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } })).stdout.trim().split('\n');
  if (identity[0] !== item.commit || identity[1] !== item.tree) throw new Error(`wechat_source_commit:${item.directory}`);
  // 只构建固定对象；工作副本中的编辑、未追踪文件及Git钩子不参与。
  const output = path.join(staging, item.directory); await mkdir(output);
  const gitEnvironment = { ...process.env, GIT_NO_LAZY_FETCH: allowDownload ? '0' : '1' };
  if (item.paths) {
    // 部分克隆按选定子树归档，避免git archive为未选择的根目录预取全部blob。
    for (const [index, selectedPath] of item.paths.entries()) {
      const object = item.commit + ':' + selectedPath;
      const type = (await run('/usr/bin/git', ['-C', selected, 'cat-file', '-t', object], { env: gitEnvironment })).stdout.trim();
      if (type === 'tree') {
        const archive = path.join(staging, item.directory + '-' + index + '.tar');
        await run('/usr/bin/git', ['-C', selected, 'archive', '--format=tar', '--output=' + archive, object], { env: gitEnvironment, timeout: 60_000, maxBuffer: 1024 * 1024 });
        await mkdir(path.join(output, selectedPath), { recursive: true });
        await run('/usr/bin/tar', ['-xf', archive, '-C', path.join(output, selectedPath)], { timeout: 60_000 });
      } else if (type === 'blob') {
        await mkdir(path.dirname(path.join(output, selectedPath)), { recursive: true });
        const blob = await run('/usr/bin/git', ['-C', selected, 'cat-file', 'blob', object], { env: gitEnvironment, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
        await writeFile(path.join(output, selectedPath), blob.stdout);
      } else throw new Error('wechat_source_object');
    }
  } else {
    const archive = path.join(staging, item.directory + '.tar');
    await run('/usr/bin/git', ['-C', selected, 'archive', '--format=tar', '--output=' + archive, item.commit], { env: gitEnvironment, timeout: 60_000, maxBuffer: 1024 * 1024 });
    await run('/usr/bin/tar', ['-xf', archive, '-C', output], { timeout: 60_000 });
  }
  return output;
}
async function extractZip(source, directory) {
  const names = (await run('/usr/bin/unzip', ['-Z', '-1', source], { maxBuffer: 8 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
  if (names.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw new Error('wechat_archive_path');
  await mkdir(directory); await run('/usr/bin/unzip', ['-q', source, '-d', directory], { timeout: 60_000 });
}
async function collectNotices(source, destination) {
  await mkdir(destination, { recursive: true });
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const name = path.join(relative, entry.name), selected = path.join(source, name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(name);
      else if (/^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|AUTHORS)(?:[._-].*)?$/i.test(entry.name)) {
        await mkdir(path.dirname(path.join(destination, name)), { recursive: true }); await cp(selected, path.join(destination, name));
      }
    }
  }
  await visit();
}
async function cachedDebuggerDigest(directory) {
  const root = await realpath(directory); const files = [];
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name), selected = path.join(root, name); const stat = await lstat(selected);
      if (stat.isDirectory()) { await visit(name); continue; }
      if (stat.isSymbolicLink()) {
        const resolved = await realpath(selected); if (!resolved.startsWith(root + path.sep)) throw new Error('wechat_cache_symlink_escape');
        files.push({ path: name, link: await readlink(selected) });
      } else if (stat.isFile()) files.push({ path: name, bytes: stat.size, mode: stat.mode & 0o777, sha256: await hashWechatFile(selected) });
      else throw new Error('wechat_cache_kind');
    }
  }
  await visit(); files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
async function normalizeAndAudit(root) {
  const native = []; await chmod(root, 0o755);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const selected = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('wechat_symlink_forbidden');
      if (entry.isDirectory()) { await chmod(selected, 0o755); await visit(selected); continue; }
      const stat = await lstat(selected); await chmod(selected, stat.mode & 0o111 ? 0o755 : 0o644);
      const handle = await open(selected); const magic = Buffer.alloc(4); await handle.read(magic, 0, 4, 0); await handle.close();
      if (!['cffaedfe','cefaedfe','cafebabe','bebafeca'].includes(magic.toString('hex'))) continue;
      await run('/usr/bin/lipo', [selected, '-verify_arch', 'arm64']);
      const dependencies = (await run('/usr/bin/otool', ['-L', selected])).stdout;
      const ids = new Set((await run('/usr/bin/otool', ['-D', selected])).stdout.split('\n').map(x => x.trim()));
      for (const line of dependencies.split('\n')) {
        const dependency = /^\s+([^ ]+) \(compatibility/.exec(line)?.[1];
        if (!dependency || ids.has(dependency) || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
        let candidates;
        if (dependency.startsWith('@rpath/')) candidates = [path.join(root, 'debugger/lib', dependency.slice(7)), path.join(root, 'lib', dependency.slice(7)), path.join(path.dirname(selected), dependency.slice(7))];
        else if (dependency.startsWith('@loader_path/')) candidates = [path.resolve(path.dirname(selected), dependency.slice(13))];
        else if (dependency.startsWith('@executable_path/')) candidates = [path.resolve(root, 'debugger/bin', dependency.slice(17))];
        else throw new Error(`wechat_external_dependency:${dependency}`);
        if (!(await Promise.all(candidates.map(async candidate => candidate.startsWith(root + path.sep) && (await lstat(candidate).catch(() => undefined))?.isFile()))).some(Boolean)) throw new Error(`wechat_dependency_missing:${dependency}`);
      }
      // ad-hoc仅验证开发产物完整性，不认证Developer ID、系统授权或真实接入。
      await run('/usr/bin/codesign', ['--verify', '--strict', selected]); native.push(path.relative(root, selected));
    }
  }
  await visit(root); return native;
}
export async function buildWechatComponents({ sourceCache, outputDirectory, allowDownload = false }) {
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  await requireBuildSpace([outputDirectory, sourceCache]);
  await mkdir(sourceCache, { recursive: true });
  const archives = {};
  for (const item of lock.archives) archives[item.name] = await checkedSource(sourceCache, item, allowDownload);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('wechat_build_platform');
  if (await hashWechatFile(path.join(desktop, lock.cliPatch.file)) !== lock.cliPatch.sha256) throw new Error('wechat_patch_hash');
  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(outputDirectory), '.wechat-build-'));
  try {
    const sources = {};
    for (const item of lock.gitSources) sources[item.name] = await gitSource(sourceCache, item, allowDownload, staging);
    const root = path.join(staging, wechatDirectoryName); await mkdir(root); await mkdir(path.join(root, 'bin')); await mkdir(path.join(root, 'lib'));
    const environment = { ...systemEnvironment(staging), CGO_ENABLED: '1', NOTALONE_TEST_WCDB: path.join(root, wechatPaths.wcdb), GOOS: 'darwin', GOARCH: 'arm64', GOTOOLCHAIN: 'local', GOENV: 'off', GOTELEMETRY: 'off', GOVCS: '*:off', GOPATH: path.join(staging, 'gopath'), GOCACHE: path.join(sourceCache, 'go-cache'), GOMODCACHE: path.join(sourceCache, 'go-mod'), GOPROXY: allowDownload ? 'https://proxy.golang.org' : 'off', GOSUMDB: allowDownload ? 'sum.golang.org' : 'off', GOMAXPROCS: '2', CGO_CFLAGS: '-mmacosx-version-min=15.0', CGO_LDFLAGS: '-mmacosx-version-min=15.0' };
    console.log('核验固定公开来源；应用只读构建补丁，编译时不包含可运行wxkey。');
    await run('/usr/bin/tar', ['-xzf', archives.go, '-C', staging], { timeout: 60_000 });
    await run('/usr/bin/git', ['apply', path.join(desktop, lock.cliPatch.file)], { cwd: sources['wechat-cli'], env: environment });
    if (await hashWechatFile(path.join(desktop, lock.cliPatch.testFile)) !== lock.cliPatch.testSha256) throw new Error('wechat_patch_test_hash');
    await cp(path.join(desktop, lock.cliPatch.testFile), path.join(sources['wechat-cli'], 'cmd/wechat-cli/notalone_readonly_test.go'));
    const go = path.join(staging, 'go/bin/go');
    await run(go, ['mod', 'verify'], { cwd: sources['wechat-cli'], env: environment, timeout: 60_000 });
    await run(go, ['build', '-p', '2', '-trimpath', '-ldflags', `-s -w -X main.sourceCommit=${lock.gitSources[0].commit}`, '-o', path.join(root, wechatPaths.cli), './cmd/wechat-cli'], { cwd: sources['wechat-cli'], env: environment, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(root, wechatPaths.cli)]);
    const wcdbSource = path.join(staging, 'wcdb'); await extractZip(archives.wcdb, wcdbSource);
    const wcdbCache = path.join(sourceCache, lock.researchCache.wcdb.filename);
    if (await lstat(wcdbCache).catch(() => undefined)) {
      if (!(await lstat(wcdbCache)).isFile() || (await lstat(wcdbCache)).isSymbolicLink() || await hashWechatFile(wcdbCache) !== lock.researchCache.wcdb.sha256) throw new Error('wechat_wcdb_cache_hash');
      await cp(wcdbCache, path.join(root, wechatPaths.wcdb));
    } else {
      const build = path.join(staging, 'wcdb-build');
      const cmake = (await run('/usr/bin/which', ['cmake'])).stdout.trim();
      await run(cmake, ['-S', path.join(wcdbSource, 'wcdb-2.1.16/src'), '-B', build, ...lock.build.wcdbFlags], { env: { ...process.env, ...environment }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      await run(cmake, ['--build', build, '--parallel', '2'], { env: { ...process.env, ...environment }, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
      await cp(path.join(build, 'WCDB.framework/Versions/2.1.16/WCDB'), path.join(root, wechatPaths.wcdb));
      await run('/usr/bin/install_name_tool', ['-id', '@rpath/libWCDB.dylib', path.join(root, wechatPaths.wcdb)]);
      await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(root, wechatPaths.wcdb)]);
    }
    await run(go, ['test', '-p', '2', '-run', '^TestNotAlone', './cmd/wechat-cli'], { cwd: sources['wechat-cli'], env: environment, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const debuggerCache = path.join(sourceCache, lock.researchCache.debugger.directory), debuggerRoot = path.join(root, 'debugger');
    if (await lstat(debuggerCache).catch(() => undefined)) {
      if (await cachedDebuggerDigest(debuggerCache) !== lock.researchCache.debugger.inventorySha256) throw new Error('wechat_debugger_cache_hash');
      await cp(debuggerCache, debuggerRoot, { recursive: true, dereference: true });
    } else {
      await mkdir(debuggerRoot);
      await run('/usr/bin/tar', ['-xzf', archives.cpython, '--strip-components=1', '-C', debuggerRoot], { timeout: 60_000 });
      const lldb = path.join(staging, 'lldb'); await extractZip(archives['codelldb-lldb'], lldb);
      for (const name of ['bin/lldb', 'bin/lldb-argdumper', 'lib/liblldb.dylib', 'lib/lldb-python']) await cp(path.join(lldb, name), path.join(debuggerRoot, name), { recursive: true, dereference: true });
      await run('/usr/bin/install_name_tool', ['-change', lock.build.lldbPythonChange.from, lock.build.lldbPythonChange.to, path.join(debuggerRoot, 'lib/liblldb.dylib')]);
      const debugBuild = path.join(staging, 'debugserver-build');
      await run('/usr/bin/xcodebuild', ['-jobs', '2', '-project', path.join(sources.debugserver, 'lldb/tools/debugserver/debugserver.xcodeproj'), '-target', 'debugserver', '-configuration', 'Release', '-sdk', 'macosx', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES', 'MACOSX_DEPLOYMENT_TARGET=12.0', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGN_IDENTITY=', 'LLDB_ENERGY_LDFLAGS=', `SYMROOT=${debugBuild}`, `OBJROOT=${path.join(staging, 'debugserver-obj')}`, 'build'], { env: environment, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
      await cp(path.join(debugBuild, 'Release/debugserver'), path.join(debuggerRoot, 'bin/debugserver'));
      await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', '--entitlements', path.join(sources.debugserver, 'lldb/tools/debugserver/resources/debugserver-macosx-entitlements.plist'), path.join(debuggerRoot, 'bin/debugserver')]);
      await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(debuggerRoot, 'lib/liblldb.dylib')]);
      // 物化PBS内部链接；安装产物检查一律拒绝symlink。
      const materialized = path.join(staging, 'debugger-materialized'); await cp(debuggerRoot, materialized, { recursive: true, dereference: true }); await rm(debuggerRoot, { recursive: true }); await rename(materialized, debuggerRoot);
    }
    const licenses = path.join(root, 'licenses'); await mkdir(licenses);
    await cp(lockFile, path.join(licenses, 'wechat-sources.lock.json')); await cp(path.join(desktop, lock.cliPatch.file), path.join(licenses, 'readonly-cli.patch')); await cp(path.join(desktop, lock.cliPatch.testFile), path.join(licenses, 'readonly-cli-test.go'));
    for (const [name, directory] of Object.entries(sources)) await collectNotices(directory, path.join(licenses, name));
    await collectNotices(wcdbSource, path.join(licenses, 'wcdb')); await cp(path.join(staging, 'go/LICENSE'), path.join(licenses, 'Go-LICENSE'));
    for (const item of lock.archives.filter(item => item.version === 'source-notice')) await cp(archives[item.name], path.join(licenses, item.filename));
    const metadata = path.join(staging, 'pbs-metadata'); await mkdir(metadata);
    await run('/usr/bin/tar', ['-xf', archives['cpython-build-metadata'], '-C', metadata, 'python/PYTHON.json', 'python/licenses'], { timeout: 60_000 });
    await cp(path.join(metadata, 'python'), path.join(licenses, 'python'), { recursive: true });
    await cp(path.join(sources['wechat-cli'], 'go.mod'), path.join(licenses, 'go.mod')); await cp(path.join(sources['wechat-cli'], 'go.sum'), path.join(licenses, 'go.sum'));
    for (const module of ['github.com/ebitengine/purego@v0.10.0', 'github.com/klauspost/compress@v1.18.5']) await collectNotices(path.join(sourceCache, 'go-mod', module), path.join(licenses, module.split('/').at(-1)));
    await writeFile(path.join(licenses, 'README.txt'), '这些来源和许可材料用于研发组件追溯。LLVM/WCDB实际编译来源的完整第三方条款覆盖仍待复核；未认证正式分发。上游wxkey仅保留源码来源与许可，没有携带其可执行程序。\n');
    const native = await normalizeAndAudit(root);
    const result = await run(path.join(root, wechatPaths.cli), ['--version'], { env: systemEnvironment(staging), cwd: staging, timeout: 15_000 });
    const version = JSON.parse(result.stdout); if (!version.ok || version.data?.version !== '2.0.1-rc.5' || version.data?.commit !== lock.gitSources[0].commit) throw new Error('wechat_cli_version');
    const pythonProbe = 'script import hashlib,sys; assert sys.version_info[:3] == (3,12,14); assert hashlib.pbkdf2_hmac("sha512",b"notalone-synthetic-password",b"notalone-salt-16",256000,32).hex() == "2f01acc39aad5a131966fd2e141f68ced60aa379db01b193092fc104f6da1e83"; print("notalone_synthetic_python_ok")';
    // 固定合成探针不创建/附加调试目标，也不读取微信、Keychain或真实DB。
    const probe = await run(path.join(root, wechatPaths.lldb), ['--batch', '--no-lldbinit', '-o', pythonProbe], { env: { ...systemEnvironment(staging), PYTHONHOME: debuggerRoot, LLDB_DEBUGSERVER_PATH: path.join(root, wechatPaths.debugserver) }, cwd: staging, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (!probe.stdout.includes('notalone_synthetic_python_ok') || probe.stderr.includes('AssertionError')) throw new Error('wechat_python_probe');
    const manifest = { formatVersion: 1, runtimeKind: wechatDirectoryName, architecture: 'arm64', minimumMacOS: lock.minimumMacOS,
      components: wechatLockedComponents,
      paths: wechatPaths, capabilities: wechatCapabilities, acceptance: wechatAcceptance,
      provenance: { sourceLockSha256: await hashWechatFile(lockFile), signing: 'ad-hoc-development', developerId: false, notarized: false, licenseCoverage: lock.licenseCoverage.state, nativeFilesAudited: native.length, syntheticPython: true }, files: await wechatInventory(root) };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
    await inspectWechatComponents(root); await rename(root, outputDirectory);
    console.log(`微信研发组件已准备：${outputDirectory}；${manifest.files.length} 个文件。真实微信/系统授权/无开发环境均未验收。`); return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
