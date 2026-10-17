import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, inspectManagedRuntime, runtimeInventory } from './managed-runtime.mjs';
import { prepareRuntimeAttribution } from './runtime-attribution.mjs';
import { prepareReplacementKit } from './prepare-replacement-kit.mjs';
import { buildPostgresRuntime } from './build-postgres.mjs';
import { requireBuildSpace } from './build-space.mjs';
const run = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scriptDirectory, '../..');
const locked = JSON.parse(await readFile(path.join(scriptDirectory, 'runtime/component-sources.lock.json'), 'utf8'));
const wheels = JSON.parse(await readFile(path.join(scriptDirectory, 'runtime/python-wheels.lock.json'), 'utf8'));
const buildWheels = JSON.parse(await readFile(path.join(scriptDirectory, 'runtime/build-wheels.lock.json'), 'utf8'));
const attributionLock = JSON.parse(await readFile(path.join(scriptDirectory, 'runtime/attribution-sources.lock.json'), 'utf8'));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!['--source-cache', '--output-directory', '--check-directory'].includes(key) || key in options || !value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('runtime_arguments');
  options[key] = path.resolve(value);
}
if (options['--check-directory']) {
  if (Object.keys(options).length !== 1) throw new Error('runtime_arguments');
  const checked = await inspectManagedRuntime(options['--check-directory']);
  console.log(`运行时完整性检查通过：${checked.files.length}个文件。`);
} else {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('runtime_platform');
  const output = options['--output-directory']; if (!output) throw new Error('runtime_output_required');
  const cache = options['--source-cache'] || path.join(repository, 'desktop/artifacts/runtime-sources');
  await requireBuildSpace([output, cache]);
  await mkdir(path.dirname(output), { recursive: true });
  if (await lstat(output).catch(() => undefined)) throw new Error('runtime_output_exists');
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), '.runtime-build-'));
  try {
    const downloads = async (item) => {
      const destination = path.join(cache, item.filename);
      if (await lstat(destination).catch(() => undefined)) {
        if ((await lstat(destination)).isSymbolicLink() || await hashFile(destination) !== item.sha256) throw new Error(`runtime_source_hash:${item.filename}`);
        return destination;
      }
      const response = await fetch(item.source || item.url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`runtime_source_unavailable:${item.filename}`);
      const temporary = `${destination}.partial-${process.pid}`;
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (await hashFile(temporary) !== item.sha256) throw new Error(`runtime_source_hash:${item.filename}`);
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
      return destination;
    };
    console.log('核验固定来源并准备离线wheelhouse。');
    const archives = {};
    for (const name of ['python', 'pythonMetadata', 'postgres', 'pythonLicenseSupplement']) archives[name] = await downloads(locked[name]);
    const wheelhouse = path.join(staging, 'wheelhouse'); await mkdir(wheelhouse);
    for (let i = 0; i < wheels.length + buildWheels.length; i += 8) await Promise.all([...wheels, ...buildWheels].slice(i, i + 8).map(async (item) => cp(await downloads(item), path.join(wheelhouse, item.filename))));
    const root = path.join(staging, 'notalone-runtime'); await mkdir(root);
    await run('/usr/bin/tar', ['-xzf', archives.python, '-C', root], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    const metadata = path.join(staging, 'python-metadata'); await mkdir(metadata);
    await run('/usr/bin/tar', ['-xf', archives.pythonMetadata, '-C', metadata, 'python/PYTHON.json', 'python/licenses'], { timeout: 60_000 });
    const licenses = path.join(root, 'licenses'); await mkdir(licenses);
    await cp(path.join(metadata, 'python'), path.join(licenses, 'python'), { recursive: true });
    await cp(archives.pythonLicenseSupplement, path.join(licenses, 'python/licenses/LICENSE.zlib-ng.txt'));
    console.log('从固定官方源码构建精简PostgreSQL，仅构建机需要系统clang与make。');
    await buildPostgresRuntime({ archive: archives.postgres, directory: path.join(root, 'postgres'), workDirectory: path.join(staging, 'postgres-build') });
    await cp(path.join(root, 'postgres/COPYRIGHT'), path.join(licenses, 'postgresql-COPYRIGHT'));
    await mkdir(path.join(licenses, 'postgresql-build'));
    await cp(path.join(scriptDirectory, 'build-postgres.mjs'), path.join(licenses, 'postgresql-build/build-postgres.mjs'));
    await cp(path.join(scriptDirectory, 'build-space.mjs'), path.join(licenses, 'postgresql-build/build-space.mjs'));
    await cp(path.join(scriptDirectory, 'runtime-platform.mjs'), path.join(licenses, 'postgresql-build/runtime-platform.mjs'));
    await mkdir(path.join(licenses, 'postgresql-build/runtime'));
    await cp(path.join(scriptDirectory, 'runtime/component-sources.lock.json'), path.join(licenses, 'postgresql-build/runtime/component-sources.lock.json'));
    await cp(path.join(scriptDirectory, 'runtime/POSTGRESQL-BUILD.md'), path.join(licenses, 'postgresql-build/README.md'));
    const python = path.join(root, 'python/bin/python3.12');
    const environment = { PATH: '/usr/bin:/bin', HOME: staging, TMPDIR: staging, LANG: 'en_US.UTF-8', PIP_CONFIG_FILE: '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1', SOURCE_DATE_EPOCH: '1783814400' };
    const pip = async (args) => run(python, ['-I', '-B', '-m', 'pip', ...args], { env: environment, cwd: staging, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const buildLock = path.join(staging, 'build.lock');
    await writeFile(buildLock, buildWheels.map((item) => `${item.name}==${item.version} --hash=sha256:${item.sha256}`).join('\n'));
    await pip(['install', '--no-index', '--no-compile', '--find-links', wheelhouse, '--require-hashes', '-r', buildLock]);
    const project = path.join(root, 'project/backend'); await mkdir(project, { recursive: true });
    for (const name of ['src', 'database', 'README.md', 'pyproject.toml']) await cp(path.join(repository, 'backend', name), path.join(project, name), { recursive: true, filter: (source) => !/(?:^|\/)__pycache__(?:\/|$)|\.egg-info(?:\/|$)|\.pyc$/.test(source) });
    console.log('构建普通后端wheel并离线安装固定依赖。');
    await pip(['wheel', '--no-deps', '--no-index', '--no-build-isolation', '--wheel-dir', wheelhouse, project]);
    const backendWheel = (await readdir(wheelhouse)).find((name) => name.startsWith('notalone-') && name.endsWith('.whl')); if (!backendWheel) throw new Error('runtime_backend_wheel_missing');
    const backendHash = await hashFile(path.join(wheelhouse, backendWheel)); const lock = path.join(staging, 'runtime.lock');
    await writeFile(lock, `${await readFile(path.join(scriptDirectory, 'runtime/requirements.lock'), 'utf8')}\nnotalone==0.1.0 --hash=sha256:${backendHash}\n`);
    await pip(['install', '--no-index', '--no-compile', '--find-links', wheelhouse, '--require-hashes', '-r', lock]);
    await pip(['check']); await pip(['uninstall', '-y', 'setuptools', 'pip']);
    // App以-I -B -m运行，不携带生成的脚本和构建缓存。
    for (const name of await readdir(path.join(root, 'python/bin'))) if (!['python', 'python3', 'python3.12'].includes(name)) await rm(path.join(root, 'python/bin', name));
    for (const name of await readdir(path.join(root, 'python/lib'))) if (/^(?:itcl|tcl|tk|libtcl)/.test(name)) await rm(path.join(root, 'python/lib', name), { recursive: true, force: true });
    await rm(path.join(root, 'python/lib/python3.12/tkinter'), { recursive: true, force: true });
    for (const name of await readdir(path.join(root, 'python/lib/python3.12/lib-dynload'))) if (name.startsWith('_tkinter')) await rm(path.join(root, 'python/lib/python3.12/lib-dynload', name));
    for (const name of ['include', 'share']) await rm(path.join(root, 'python', name), { recursive: true, force: true });
    for (const name of ['build', 'src/notalone.egg-info']) await rm(path.join(project, name), { recursive: true, force: true });
    await rm(path.join(project, 'pyproject.toml'));
    async function clean(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const selected = path.join(directory, entry.name);
        if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name === 'distutils-precedence.pth') await rm(selected, { recursive: true, force: true });
        else if (entry.isDirectory()) await clean(selected);
      }
    }
    await clean(root);
    await cp(lock, path.join(licenses, 'requirements.lock'));
    await cp(path.join(scriptDirectory, 'runtime/python-wheels.lock.json'), path.join(licenses, 'python-wheels.json'));
    await cp(path.join(scriptDirectory, 'runtime/component-sources.lock.json'), path.join(licenses, 'component-sources.json'));
    const attribution = await prepareRuntimeAttribution({ lock: attributionLock, download: downloads, directory: path.join(licenses, 'attribution') });
    await cp(path.join(scriptDirectory, 'runtime/THIRD-PARTY-SOURCES.md'), path.join(licenses, 'README.md'));
    for (const name of ['PSYCOPG-REBUILD.md', 'PSYCOPG-VALIDATION.md', 'NATIVE-WHEEL-NOTICES.md']) await cp(path.join(scriptDirectory, 'runtime', name), path.join(licenses, name));
    const kit = await prepareReplacementKit({ sourceCache: cache, licensesDirectory: licenses, outputDirectory: path.join(licenses, 'replacement-kit'), download: downloads });
    console.log(`随包离线修改工具包：${kit.files}个文件，${kit.bytes}字节。`);
    console.log(`保留${attribution.sourceCount}份固定来源归档，核对${attribution.noticeCount}份原始许可及通知。`);
    const native = [];
    async function audit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const selected = path.join(directory, entry.name); if (entry.isDirectory()) { await audit(selected); continue; } if (!entry.isFile()) continue;
        const handle = await open(selected); const magic = Buffer.alloc(4); await handle.read(magic, 0, 4, 0); await handle.close();
        if (!['cffaedfe','cefaedfe','cafebabe','bebafeca'].includes(magic.toString('hex'))) continue;
        await run('/usr/bin/lipo', [selected, '-verify_arch', 'arm64']);
        const { stdout } = await run('/usr/bin/otool', ['-L', selected]);
        const identifiers = new Set((await run('/usr/bin/otool', ['-D', selected])).stdout.split('\n').map((line) => line.trim()).filter((line) => !line.endsWith(':')));
        for (const line of stdout.split('\n')) {
          const dependency = /^\s+([^ ]+) \(compatibility/.exec(line)?.[1];
          if (!dependency || identifiers.has(dependency) || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
          if (dependency.startsWith('@loader_path/')) {
            const target = await realpath(path.resolve(path.dirname(selected), dependency.slice(13)));
            if (!target.startsWith(root + path.sep)) throw new Error('runtime_native_dependency_escape');
          } else if (dependency.startsWith('@rpath/')) {
            const candidates = [path.join(root, 'postgres/lib', dependency.slice(7)), path.join(root, 'python/lib', dependency.slice(7)), path.join(path.dirname(selected), dependency.slice(7))];
            if (!(await Promise.all(candidates.map((file) => lstat(file).catch(() => undefined)))).some(Boolean)) throw new Error(`runtime_native_dependency_missing:${dependency}`);
          } else if (dependency.startsWith('@executable_path/')) {
            const executableDirectory = selected.startsWith(path.join(root, 'postgres') + path.sep) ? path.join(root, 'postgres/bin') : path.join(root, 'python/bin');
            const target = await realpath(path.resolve(executableDirectory, dependency.slice(17)));
            if (!target.startsWith(root + path.sep)) throw new Error('runtime_native_dependency_escape');
          } else throw new Error(`runtime_external_native_dependency:${dependency}`);
        }
        try { await run('/usr/bin/codesign', ['--verify', '--strict', selected]); } catch { await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', selected]); }
        await run('/usr/bin/codesign', ['--verify', '--strict', selected]); native.push(path.relative(root, selected));
      }
    }
    await audit(root); console.log(`核验${native.length}个Mach-O的依赖与签名。`);
    const imported = await run(python, ['-I', '-B', '-c', 'import notalone.server.command,notalone.startup_diagnostics,psycopg,langgraph,deepagents,httpx,yaml; print("isolated_import_ok")'], { env: environment, cwd: staging, timeout: 60_000, maxBuffer: 4096 });
    if (!imported.stdout.includes('isolated_import_ok')) throw new Error('runtime_import_failed');
    const components = [...Object.values(locked).filter((item) => item && typeof item === 'object' && item.source), ...wheels.map(({ name, version, url, sha256 }) => ({ name, version, source: url, sha256 })), { name: 'notalone', version: '0.1.0', source: 'repository:backend', sha256: backendHash }].map(({ name, version, source, sha256 }) => ({ name, version, source, sha256 }));
    const manifest = { formatVersion: 1, architecture: 'arm64', components, paths: { python: 'python/bin/python3.12', project: 'project', postgres: 'postgres/bin' }, files: await runtimeInventory(root) };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); await inspectManagedRuntime(root);
    await rename(root, output); console.log(`受管本机运行时已准备：${output}`);
    console.log(`文件${manifest.files.length}；独立导入通过。尚未认证无开发环境机器、微信或完整App首启。`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
