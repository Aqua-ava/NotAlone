import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeMinimumMacOS } from './runtime-platform.mjs';
import { buildPostgresRuntime } from './build-postgres.mjs';
import { hashFile, inspectManagedRuntime, runtimeInventory } from './managed-runtime.mjs';
import { requireBuildSpace } from './build-space.mjs';

const run = promisify(execFile);
const componentLock = JSON.parse(await readFile(new URL('./runtime/component-sources.lock.json', import.meta.url), 'utf8'));
const attributionLock = JSON.parse(await readFile(new URL('./runtime/attribution-sources.lock.json', import.meta.url), 'utf8'));
const buildWheels = JSON.parse(await readFile(new URL('./runtime/psycopg-build-wheels.lock.json', import.meta.url), 'utf8'));
const sourceLock = attributionLock.sources.find((item) => item.name === 'psycopg-upstream');
const marker = 'notalone_source_rebuild_probe_20261016';

async function canonicalTarget(selected) {
  try { return await realpath(selected); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(await canonicalTarget(path.dirname(selected)), path.basename(selected)); }
}

export async function auditNative(directory, execute) {
  const root = await realpath(directory), audit = [];
  for (const item of await runtimeInventory(root)) {
    const file = path.join(root, item.path), handle = await open(file, 'r');
    const header = Buffer.alloc(4);
    try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
    if (!['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) continue;
    await execute('/usr/bin/lipo', [file, '-verify_arch', 'arm64']);
    const dependencies = (await execute('/usr/bin/otool', ['-L', file])).stdout.split('\n').map((line) => /^\s+([^ ]+) \(compatibility/.exec(line)?.[1]).filter(Boolean);
    const identifiers = (await execute('/usr/bin/otool', ['-D', file])).stdout.split('\n').map((line) => line.trim()).filter((line) => line && !line.endsWith(':'));
    for (const dependency of dependencies) {
      if (identifiers.includes(dependency) || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      let candidates;
      if (dependency.startsWith('@loader_path/')) candidates = [path.resolve(path.dirname(file), dependency.slice(13))];
      else if (dependency.startsWith('@executable_path/')) candidates = [path.resolve(root, item.path.startsWith('postgres/') ? 'postgres/bin' : 'python/bin', dependency.slice(17))];
      else if (dependency.startsWith('@rpath/')) candidates = [path.join(root, 'python/lib', dependency.slice(7)), path.join(root, 'postgres/lib', dependency.slice(7)), path.join(path.dirname(file), dependency.slice(7))];
      else throw new Error(`psycopg_rebuild_external_dependency:${dependency}`);
      const found = (await Promise.all(candidates.map((candidate) => realpath(candidate).catch(() => undefined)))).filter(Boolean);
      if (!found.some((candidate) => candidate.startsWith(root + path.sep))) throw new Error(`psycopg_rebuild_dependency_escape:${dependency}`);
    }
    await execute('/usr/bin/codesign', ['--verify', '--strict', file]);
    audit.push({ path: item.path, dependencies });
  }
  return audit;
}

// 开发验证入口：只在全新副本构建修改库，不改变产品默认依赖与冻结原包。
export async function rebuildPsycopgRuntime({ sourceArchive, runtimeDirectory, outputDirectory, workDirectory, sourceCache, patchFile }) {
  let recipientPatch;
  if (patchFile !== undefined) {
    if (typeof patchFile !== 'string' || !path.isAbsolute(patchFile) || /[\0\r\n]/.test(patchFile) || !(await lstat(patchFile)).isFile() || (await lstat(patchFile)).size > 1024 * 1024) throw new Error('psycopg_rebuild_patch_file');
    recipientPatch = await readFile(patchFile, 'utf8');
    const headers = recipientPatch.split('\n').filter((line) => /^(---|\+\+\+) /.test(line));
    if (!headers.length || headers.some((line) => !/^(?:--- a|\+\+\+ b)\/[A-Za-z0-9_./-]+(?:\t[^\r\n]*)?$/.test(line) || line.split('\t')[0].slice(6).split('/').some((part) => !part || part === '.' || part === '..'))) throw new Error('psycopg_rebuild_patch_path');
  }
  const directories = [runtimeDirectory, outputDirectory, workDirectory, sourceCache];
  if ([sourceArchive, ...directories].some((value) => typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) ||
    directories.some((value, index) => directories.some((other, otherIndex) => index !== otherIndex && (value === other || value.startsWith(other + path.sep))))) throw new Error('psycopg_rebuild_arguments');
  await requireBuildSpace([outputDirectory, workDirectory]);
  if ((await lstat(sourceArchive)).isSymbolicLink() || await hashFile(sourceArchive) !== sourceLock.sha256) throw new Error('psycopg_rebuild_source_hash');
  const canonical = await Promise.all(directories.map(canonicalTarget));
  if (canonical.some((value, index) => canonical.some((other, otherIndex) => index !== otherIndex && (value === other || value.startsWith(other + path.sep))))) throw new Error('psycopg_rebuild_directory_overlap');
  if (await lstat(outputDirectory).catch(() => undefined) || await lstat(workDirectory).catch(() => undefined)) throw new Error('psycopg_rebuild_output_exists');
  const original = await inspectManagedRuntime(runtimeDirectory);
  if (!original.components.some((item) => item.name === 'cpython' && item.sha256 === componentLock.python.sha256) ||
    !original.components.some((item) => item.name === 'psycopg-binary' && item.version === '3.3.6')) throw new Error('psycopg_rebuild_component_version');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('psycopg_rebuild_platform');
  const postgresArchive = path.join(runtimeDirectory, 'licenses/attribution/sources', componentLock.postgres.filename);
  if (await hashFile(postgresArchive) !== componentLock.postgres.sha256) throw new Error('psycopg_rebuild_postgres_hash');
  for (const item of [componentLock.python, ...buildWheels]) {
    const file = path.join(sourceCache, item.filename);
    if ((await lstat(file)).isSymbolicLink() || await hashFile(file) !== item.sha256) throw new Error(`psycopg_rebuild_build_dependency_hash:${item.filename}`);
  }
  await mkdir(workDirectory, { mode: 0o700 });
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: workDirectory, TMPDIR: workDirectory, LANG: 'en_US.UTF-8',
    PIP_CONFIG_FILE: '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1', SOURCE_DATE_EPOCH: '1783814400',
    CC: '/usr/bin/clang', CFLAGS: `-O2 -arch arm64 -mmacosx-version-min=${runtimeMinimumMacOS(componentLock)}`, LDFLAGS: `-arch arm64 -mmacosx-version-min=${runtimeMinimumMacOS(componentLock)}`, MACOSX_DEPLOYMENT_TARGET: runtimeMinimumMacOS(componentLock) };
  const execute = async (file, args, cwd = workDirectory, extra = {}) => {
    try { return await run(file, args, { cwd, env: { ...environment, ...extra }, timeout: 900_000, maxBuffer: 32 * 1024 * 1024 }); }
    catch (error) { await writeFile(path.join(workDirectory, 'failed-command.log'), `${file}\n${JSON.stringify(args)}\n${error.stdout || ''}\n${error.stderr || ''}`); throw error; }
  };
  console.log('核验完成；准备独立PBS构建解释器和相同版本PostgreSQL开发头文件。');
  await execute('/usr/bin/tar', ['-xzf', path.join(sourceCache, componentLock.python.filename), '-C', workDirectory]);
  const python = path.join(workDirectory, 'python/bin/python3.12');
  const wheelhouse = path.join(workDirectory, 'wheelhouse'); await mkdir(wheelhouse);
  for (const item of buildWheels) await cp(path.join(sourceCache, item.filename), path.join(wheelhouse, item.filename));
  const buildRequirements = path.join(workDirectory, 'build-requirements.lock');
  await writeFile(buildRequirements, buildWheels.map((item) => `${item.name}==${item.version} --hash=sha256:${item.sha256}`).join('\n') + '\n');
  await execute(python, ['-I', '-B', '-m', 'pip', 'install', '--no-index', '--no-compile', '--find-links', wheelhouse, '--require-hashes', '-r', buildRequirements]);
  await buildPostgresRuntime({ archive: postgresArchive, directory: path.join(workDirectory, 'postgres'), workDirectory: path.join(workDirectory, 'postgres-build') });
  const development = path.join(workDirectory, 'postgres-build/install/notalone-postgresql');
  const bin = path.join(workDirectory, 'bin'); await mkdir(bin);
  // pg_config报告固定安装prefix；只向构建暴露本次DESTDIR的头文件和库。
  await writeFile(path.join(bin, 'pg_config'), '#!/bin/sh\ncase "$1" in\n--includedir) printf \'%s\\n\' "$NOTALONE_PG_CONFIG_INCLUDE";;\n--libdir) printf \'%s\\n\' "$NOTALONE_PG_CONFIG_LIB";;\n*) exit 2;;\nesac\n', { mode: 0o700 });
  environment.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  environment.NOTALONE_PG_CONFIG_INCLUDE = path.join(development, 'include');
  environment.NOTALONE_PG_CONFIG_LIB = path.join(development, 'lib');
  await execute('/usr/bin/tar', ['-xzf', sourceArchive, '-C', workDirectory]);
  const source = path.join(workDirectory, 'psycopg-3.3.6');
  const sourceFile = path.join(source, 'psycopg_c/psycopg_c/pq.pyx');
  const before = await readFile(sourceFile, 'utf8');
  const needle = '__build_version__ = libpq.PG_VERSION_NUM\n';
  if (before.split(needle).length !== 2) throw new Error('psycopg_rebuild_patch_context');
  const addition = `_notalone_rebuild_marker = "${marker}"\n`;
  const material = path.join(workDirectory, 'materials'); await mkdir(material);
  const patch = path.join(material, 'source.patch');
  await writeFile(patch, recipientPatch ?? `--- a/psycopg_c/psycopg_c/pq.pyx\n+++ b/psycopg_c/psycopg_c/pq.pyx\n@@ -13,7 +13,8 @@\n logger = logging.getLogger("psycopg")\n \n __impl__ = 'c'\n ${needle.trimEnd()}\n+${addition} \n \n def version():\n`);
  // 补丁本身就是实际修改入口；不能保存一份未被真正应用的说明性diff。
  const patched = await execute('/usr/bin/patch', ['--batch', '--forward', '--fuzz=0', '-p1', '-i', patch], source);
  await writeFile(path.join(workDirectory, 'patch-application.log'), patched.stdout + patched.stderr);
  if (!recipientPatch && await readFile(sourceFile, 'utf8') !== before.replace(needle, needle + addition)) throw new Error('psycopg_rebuild_patch_result');
  await execute('/usr/bin/tar', ['-czf', path.join(material, 'psycopg-3.3.6-modified.tar.gz'), '-C', workDirectory, 'psycopg-3.3.6']);
  await execute(python, ['-I', '-B', path.join(source, 'tools/ci/copy_to_binary.py')]);
  console.log('从修改后的Cython源码编译两个psycopg_binary扩展。');
  const built = await execute(python, ['-I', '-B', '-m', 'pip', 'wheel', '--verbose', '--no-deps', '--no-index', '--no-build-isolation', '--wheel-dir', material, path.join(source, 'psycopg_binary')]);
  await writeFile(path.join(workDirectory, 'extension-build.log'), built.stdout + built.stderr);
  const wheelName = (await readdir(material)).find((name) => /^psycopg_binary-3\.3\.6-cp312-cp312-macosx_.*_arm64.whl$/.test(name));
  if (!wheelName) throw new Error('psycopg_rebuild_wheel_missing');
  await cp(runtimeDirectory, outputDirectory, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  const site = path.join(outputDirectory, 'python/lib/python3.12/site-packages');
  for (const name of await readdir(site)) if (name === 'psycopg_binary' || /^psycopg_binary[-.]/.test(name)) await rm(path.join(site, name), { recursive: true });
  await execute(python, ['-I', '-B', '-m', 'pip', 'install', '--no-deps', '--no-index', '--no-compile', '--target', site, path.join(material, wheelName)]);
  await rm(path.join(site, 'psycopg_binary-3.3.6.dist-info/direct_url.json'), { force: true });
  const audit = [];
  for (const name of (await readdir(path.join(site, 'psycopg_binary'))).filter((name) => name.endsWith('.so'))) {
    const selected = path.join(site, 'psycopg_binary', name);
    await execute('/usr/bin/lipo', [selected, '-verify_arch', 'arm64']);
    const dependencies = (await execute('/usr/bin/otool', ['-L', selected])).stdout.split('\n').map((line) => /^\s+([^ ]+) \(compatibility/.exec(line)?.[1]).filter(Boolean);
    for (const dependency of dependencies) {
      if (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      if (dependency !== '/notalone-postgresql/lib/libpq.5.dylib') throw new Error(`psycopg_rebuild_external_dependency:${dependency}`);
      await execute('/usr/bin/install_name_tool', ['-change', dependency, `@loader_path/${path.relative(path.dirname(selected), path.join(outputDirectory, 'postgres/lib/libpq.5.dylib'))}`, selected]);
    }
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', selected]);
    await execute('/usr/bin/codesign', ['--verify', '--strict', selected]);
    if ((await readFile(selected)).includes(Buffer.from(workDirectory))) throw new Error('psycopg_rebuild_build_path_leak');
    audit.push({ path: path.relative(outputDirectory, selected), sha256: await hashFile(selected), dependencies: (await execute('/usr/bin/otool', ['-L', selected])).stdout.trim().split('\n').slice(1).map((line) => line.trim()) });
  }
  if (audit.length !== 2) throw new Error('psycopg_rebuild_extension_count');
  // 重定位和签名改变扩展字节；同步wheel RECORD，不保留失效摘要。
  await execute(python, ['-I', '-B', '-c', `import base64,csv,hashlib,pathlib,sys
site=pathlib.Path(sys.argv[1]); record=site/'psycopg_binary-3.3.6.dist-info/RECORD'
rows=[row for row in csv.reader(record.open()) if not row[0].endswith('/direct_url.json')]
for row in rows:
    if row[0].endswith('.so'):
        data=(site/row[0]).read_bytes(); row[1]='sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode(); row[2]=str(len(data))
with record.open('w',newline='') as out: csv.writer(out).writerows(rows)
`, site]);
  let rejected = false;
  try { await inspectManagedRuntime(outputDirectory); } catch (error) { if (error.message !== 'runtime_inventory_mismatch') throw error; rejected = true; }
  if (!rejected) throw new Error('psycopg_rebuild_old_inventory_accepted');
  const runtimePython = path.join(outputDirectory, 'python/bin/python3.12');
  const probe = JSON.parse((await execute(runtimePython, ['-I', '-B', '-c', `import json,psycopg,psycopg_binary.pq as p; print(json.dumps(dict(version=psycopg.__version__,implementation=psycopg.pq.__impl__,libpq=psycopg.pq.version(),buildLibpq=p.__build_version__,marker=getattr(p,"_notalone_rebuild_marker",None))))`])).stdout);
  if (probe.version !== '3.3.6' || probe.implementation !== 'binary' || probe.libpq !== 160015 || probe.buildLibpq !== 160015 || (!recipientPatch && probe.marker !== marker)) throw new Error('psycopg_rebuild_probe_failed');
  const allNative = await auditNative(outputDirectory, execute);
  const buildInfo = { scope: 'modified-psycopg-binary-development-probe', source: sourceLock, marker: probe.marker, patch: { kind: recipientPatch ? 'recipient-provided' : 'built-in-example', sha256: await hashFile(patch) }, python: componentLock.python, buildWheels,
    modifiedSourceSha256: await hashFile(path.join(material, 'psycopg-3.3.6-modified.tar.gz')), wheel: { filename: wheelName, sha256: await hashFile(path.join(material, wheelName)) },
    compiler: (await execute('/usr/bin/clang', ['--version'])).stdout.trim(), sdk: (await execute('/usr/bin/xcrun', ['--show-sdk-version'])).stdout.trim(),
    flags: { CFLAGS: environment.CFLAGS, LDFLAGS: environment.LDFLAGS }, probe, native: audit, allNative, oldInventoryRejected: rejected,
    originalManifestSha256: await hashFile(path.join(runtimeDirectory, 'manifest.json')), app: false, cleanMachine: false, licenseClosure: false };
  const evidence = path.join(outputDirectory, 'licenses/psycopg-replacement'); await mkdir(evidence);
  await cp(material, evidence, { recursive: true });
  await cp(new URL('./runtime/psycopg-build-wheels.lock.json', import.meta.url), path.join(evidence, 'build-wheels.lock.json'));
  await writeFile(path.join(evidence, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');
  const requirementsFile = path.join(outputDirectory, 'licenses/requirements.lock');
  const baseRequirements = await readFile(requirementsFile, 'utf8');
  const installedRequirements = baseRequirements.replace(/^psycopg-binary==3\.3\.6 --hash=sha256:[a-f0-9]{64}$/m,
    `psycopg-binary==3.3.6 --hash=sha256:${buildInfo.wheel.sha256}`);
  if (installedRequirements === baseRequirements) throw new Error('psycopg_rebuild_requirements_declaration');
  await writeFile(path.join(evidence, 'base-requirements.lock'), baseRequirements);
  await writeFile(requirementsFile, installedRequirements);
  const wheelsFile = path.join(outputDirectory, 'licenses/python-wheels.json');
  const baseWheels = await readFile(wheelsFile, 'utf8');
  await writeFile(path.join(evidence, 'base-python-wheels.json'), baseWheels);
  await writeFile(wheelsFile, JSON.stringify(JSON.parse(baseWheels).map((item) => item.name === 'psycopg-binary' ?
    { name: item.name, version: item.version, filename: wheelName, url: 'repository:replacement-kit/scripts/rebuild-psycopg-runtime.mjs', sha256: buildInfo.wheel.sha256 } : item), null, 2) + '\n');
  await writeFile(path.join(evidence, 'replacement-receipt.json'), JSON.stringify({ formatVersion: 1, component: 'psycopg-binary',
    base: { component: original.components.find((item) => item.name === 'psycopg-binary'), requirements: 'base-requirements.lock', wheels: 'base-python-wheels.json',
      attributionRole: '原始sources-and-notices.json保留基础wheel与上游通知来源，不声明修改扩展等于上游wheel字节' },
    replacement: { wheel: buildInfo.wheel, modifiedSource: 'psycopg-3.3.6-modified.tar.gz', modifiedSourceSha256: buildInfo.modifiedSourceSha256,
      patch: 'source.patch', patchSha256: buildInfo.patch.sha256, buildInfo: 'build-info.json', buildWheels: 'build-wheels.lock.json' },
    installed: { requirements: '../requirements.lock', wheels: '../python-wheels.json', manifest: '../../manifest.json', native: audit,
      transformations: '安装重建wheel后，将libpq改为包内相对依赖、ad-hoc重签并更新RECORD；安装后扩展摘要以native及manifest为准' },
    productDefaultChanged: false, fullLicenseClosureVerified: false }, null, 2) + '\n');
  await writeFile(path.join(evidence, 'README.md'), '# 修改库开发探针收据\n\n此运行时在独立副本中以修改源码重建psycopg-binary。`replacement-receipt.json`区分原始基础来源、重建wheel和重定位／签名后的安装字节。`../requirements.lock`与`../python-wheels.json`声明重建wheel，原声明保留为`base-*`；原归因库存仍证明基础来源与通知，不能充当修改扩展的字节证明。修改源码、补丁、构建工具锁、wheel和最终扩展摘要一并保留。构建缓存中的匹配PBS开发头文件及工具wheel需按锁准备；此有限工程探针不认证全部对应构建材料、许可闭包或正式分发资格。\n');
  const licensesReadme = path.join(outputDirectory, 'licenses/README.md');
  await writeFile(licensesReadme, `> 此副本已执行修改库开发探针，当前安装来源见[替换收据](psycopg-replacement/README.md)。下文及attribution库存保留基础来源与通知，未将原psycopg-binary wheel摘要冒充当前扩展字节。\n\n${await readFile(licensesReadme, 'utf8')}`);
  original.components = original.components.map((item) => item.name === 'psycopg-binary' ? { ...item, source: 'repository:replacement-kit/scripts/rebuild-psycopg-runtime.mjs', sha256: buildInfo.wheel.sha256 } : item);
  original.files = await runtimeInventory(outputDirectory);
  await writeFile(path.join(outputDirectory, 'manifest.json'), JSON.stringify(original, null, 2) + '\n');
  await inspectManagedRuntime(outputDirectory); await inspectManagedRuntime(runtimeDirectory);
  console.log(`修改库副本已重签并更新库存：${JSON.stringify(probe)}；尚须运行verify-runtime与实际App回归。`);
  return buildInfo;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keys = ['--source-archive', '--runtime-directory', '--output-directory', '--work-directory', '--source-cache'];
  const args = process.argv.slice(2);
  if (![10, 12].includes(args.length) || (args.length === 12 && args[10] !== '--patch-file') || keys.some((key, index) => args[index * 2] !== key)) throw new Error('psycopg_rebuild_cli_arguments');
  await rebuildPsycopgRuntime({ sourceArchive: args[1], runtimeDirectory: args[3], outputDirectory: args[5], workDirectory: args[7], sourceCache: args[9], patchFile: args[11] });
}
