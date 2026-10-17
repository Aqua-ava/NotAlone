import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { runtimeMinimumMacOS } from './runtime-platform.mjs';
import { requireBuildSpace } from './build-space.mjs';

const run = promisify(execFile);
const locked = JSON.parse(await readFile(new URL('./runtime/component-sources.lock.json', import.meta.url), 'utf8'));
const minimumMacOS = runtimeMinimumMacOS(locked);
const prefix = '/notalone-postgresql';
const configure = [`--prefix=${prefix}`, '--without-readline', '--without-icu', '--without-openssl', '--without-zlib',
  '--without-lz4', '--without-zstd', '--disable-nls', '--disable-rpath'];
const binaries = ['initdb', 'postgres', 'pg_ctl', 'pg_isready', 'psql', 'pg_dump', 'pg_restore', 'createdb', 'dropdb'];

async function sourceDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// 仅构建机需要系统开发工具；产物由独立依赖审计及搬动验证确认可重定位。
export async function buildPostgresRuntime({ archive, directory, workDirectory }) {
  if ([archive, directory, workDirectory].some((value) => typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) ||
    directory === workDirectory || directory.startsWith(workDirectory + path.sep) || workDirectory.startsWith(directory + path.sep)) throw new Error('runtime_postgres_arguments');
  await requireBuildSpace([directory, workDirectory]);
  if ((await lstat(archive)).isSymbolicLink() || await sourceDigest(archive) !== locked.postgres.sha256) throw new Error('runtime_postgres_source_hash');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('runtime_postgres_platform');
  if (await lstat(directory).catch(() => undefined) || await lstat(workDirectory).catch(() => undefined)) throw new Error('runtime_postgres_output_exists');
  await mkdir(workDirectory, { recursive: true });
  const source = path.join(workDirectory, `postgresql-${locked.postgres.version}`), build = source;
  const install = path.join(workDirectory, 'install'); await mkdir(install);
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: workDirectory, TMPDIR: workDirectory, LANG: 'C', LC_ALL: 'C',
    CC: '/usr/bin/clang', CFLAGS: `-O2 -arch arm64 -mmacosx-version-min=${minimumMacOS}`, LDFLAGS: `-arch arm64 -mmacosx-version-min=${minimumMacOS}`,
    MACOSX_DEPLOYMENT_TARGET: minimumMacOS, SOURCE_DATE_EPOCH: '1783814400' };
  const execute = async (file, args, cwd = build) => run(file, args, { cwd, env: environment, timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
  await execute('/usr/bin/tar', ['-xjf', archive, '-C', workDirectory], workDirectory);
  // 使用源码内构建，让C的__FILE__保留相对文件名；PG的VPATH会强制绝对源目录。
  await execute('./configure', configure);
  await execute('/usr/bin/make', ['-j2']);
  await execute('/usr/bin/make', ['install', `DESTDIR=${install}`]);
  const original = path.join(install, prefix.slice(1));
  await mkdir(path.join(directory, 'bin'), { recursive: true }); await mkdir(path.join(directory, 'lib'), { recursive: true });
  const outputRoot = await realpath(directory);
  for (const name of binaries) await cp(path.join(original, 'bin', name), path.join(directory, 'bin', name));
  await cp(path.join(original, 'share'), path.join(directory, 'share'), { recursive: true });
  // 只保留内置SQL语言、编码转换与默认词典模块；不引入contrib或额外语言。
  const conversionModules = (await readdir(path.join(source, 'src/backend/utils/mb/conversion_procs'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (conversionModules.length !== 24 || conversionModules.some((name) => !/^[a-z0-9_]+$/.test(name))) throw new Error('runtime_postgres_conversion_inventory');
  const builtInModules = ['plpgsql', 'dict_snowball', ...conversionModules];
  const originalLibraries = await readdir(path.join(original, 'lib'));
  const libraryFiles = ['libpq.5.dylib'];
  for (const name of builtInModules) {
    const matches = originalLibraries.filter((file) => file === `${name}.so` || file === `${name}.dylib`);
    if (matches.length !== 1) throw new Error(`runtime_postgres_module_missing:${name}`);
    libraryFiles.push(matches[0]);
  }
  for (const name of libraryFiles) await cp(await realpath(path.join(original, 'lib', name)), path.join(directory, 'lib', name));
  const extension = path.join(directory, 'share/extension');
  for (const name of await readdir(extension).catch(() => [])) if (!name.startsWith('plpgsql')) await rm(path.join(extension, name), { recursive: true });
  // PostgreSQL默认Mach-O标识带安装prefix；逐项改为实际加载者的包内相对位置。
  const native = [...binaries.map((name) => path.join(directory, 'bin', name)), ...(await readdir(path.join(directory, 'lib'))).map((name) => path.join(directory, 'lib', name))];
  const audit = [];
  for (const selected of native) {
    if ((await readFile(selected)).includes(Buffer.from(workDirectory))) throw new Error('runtime_postgres_build_path_leak');
    const { stdout } = await execute('/usr/bin/otool', ['-L', selected]);
    const dependencies = stdout.split('\n').map((line) => /^\s+([^ ]+) \(compatibility/.exec(line)?.[1]).filter(Boolean);
    const identifiers = (await execute('/usr/bin/otool', ['-D', selected])).stdout.split('\n').map((line) => line.trim()).filter((line) => line && !line.endsWith(':'));
    if (identifiers.length) await execute('/usr/bin/install_name_tool', ['-id', `@loader_path/${path.basename(selected)}`, selected]);
    for (const dependency of dependencies) {
      if (identifiers.includes(dependency) || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      if (!dependency.startsWith(`${prefix}/lib/`)) throw new Error(`runtime_postgres_external_dependency:${dependency}`);
      const library = path.basename(dependency), target = path.join(directory, 'lib', library);
      if (!(await lstat(target).catch(() => undefined))) throw new Error(`runtime_postgres_dependency_missing:${library}`);
      const relative = path.relative(path.dirname(selected), target);
      await execute('/usr/bin/install_name_tool', ['-change', dependency, `@loader_path/${relative}`, selected]);
    }
    await execute('/usr/bin/lipo', [selected, '-verify_arch', 'arm64']);
    const finalDependencies = (await execute('/usr/bin/otool', ['-L', selected])).stdout.split('\n').map((line) => /^\s+([^ ]+) \(compatibility/.exec(line)?.[1]).filter(Boolean);
    for (const dependency of finalDependencies) {
      if (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      if (!dependency.startsWith('@loader_path/')) throw new Error('runtime_postgres_external_dependency');
      const target = await realpath(path.resolve(path.dirname(selected), dependency.slice(13)));
      if (!target.startsWith(outputRoot + path.sep)) throw new Error('runtime_postgres_dependency_escape');
    }
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', selected]);
    await execute('/usr/bin/codesign', ['--verify', '--strict', selected]);
    audit.push({ path: path.relative(directory, selected), dependencies: finalDependencies });
  }
  const compiler = (await execute('/usr/bin/clang', ['--version'])).stdout.trim();
  const make = (await execute('/usr/bin/make', ['--version'])).stdout.split('\n')[0];
  const sdk = (await execute('/usr/bin/xcrun', ['--show-sdk-version'])).stdout.trim();
  await writeFile(path.join(directory, 'build-info.json'), JSON.stringify({ source: locked.postgres, configure, environment: {
    CC: environment.CC, CFLAGS: environment.CFLAGS, LDFLAGS: environment.LDFLAGS, MACOSX_DEPLOYMENT_TARGET: environment.MACOSX_DEPLOYMENT_TARGET,
    SOURCE_DATE_EPOCH: environment.SOURCE_DATE_EPOCH }, compiler, make, sdk, commands: ['configure', 'make -j2', 'make install DESTDIR=${STAGING}'],
    relocation: 'install_name_tool: prefix/lib → @loader_path relative path; ad-hoc codesign', builtInModules, native: audit }, null, 2) + '\n');
  await cp(path.join(source, 'COPYRIGHT'), path.join(directory, 'COPYRIGHT'));
  return { nativeCount: audit.length };
}
