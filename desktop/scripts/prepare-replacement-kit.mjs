import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './managed-runtime.mjs';
import { requireBuildSpace } from './build-space.mjs';
const run = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const components = JSON.parse(await readFile(new URL('./runtime/component-sources.lock.json', import.meta.url), 'utf8'));
const wheels = JSON.parse(await readFile(new URL('./runtime/psycopg-build-wheels.lock.json', import.meta.url), 'utf8'));

// 标准构建与独立材料刷新共享此入口；不编译或替换生产组件。
export async function prepareReplacementKit({ sourceCache, licensesDirectory, outputDirectory, download }) {
  if ([sourceCache, licensesDirectory, outputDirectory].some((value) => typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value))) throw new Error('replacement_kit_arguments');
  if (await lstat(outputDirectory).catch(() => undefined)) throw new Error('replacement_kit_output_exists');
  await requireBuildSpace([outputDirectory, ...(download ? [sourceCache] : [])]);
  const inputs = [components.python, ...wheels], selected = [];
  for (const item of inputs) {
    const file = download ? await download(item) : path.join(sourceCache, item.filename);
    if (!(await lstat(file)).isFile() || await hashFile(file) !== item.sha256) throw new Error(`replacement_kit_input_hash:${item.filename}`);
    selected.push(file);
  }
  const staging = `${outputDirectory}.partial-${process.pid}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    await mkdir(path.join(staging, 'scripts/runtime'), { recursive: true });
    await mkdir(path.join(staging, 'inputs'));
    await cp(path.join(directory, '../managed-runtime-contract.mjs'), path.join(staging, 'managed-runtime-contract.mjs'));
    for (const file of ['rebuild-psycopg-runtime.mjs', 'build-postgres.mjs', 'runtime-platform.mjs', 'managed-runtime.mjs', 'verify-runtime.mjs', 'install-runtime-copy.mjs', 'build-space.mjs']) await cp(path.join(directory, file), path.join(staging, 'scripts', file));
    for (const file of ['component-sources.lock.json', 'attribution-sources.lock.json', 'psycopg-build-wheels.lock.json']) await cp(path.join(directory, 'runtime', file), path.join(staging, 'scripts/runtime', file));
    await cp(path.join(directory, 'runtime/replacement-kit.mjs'), path.join(staging, 'kit.mjs'));
    await cp(path.join(directory, 'runtime/REPLACEMENT-KIT.md'), path.join(staging, 'README.md'));
    await cp(path.join(directory, 'runtime/psycopg-example.patch'), path.join(staging, 'example.patch'));
    const notices = path.join(staging, 'notices'); await mkdir(notices);
    // 从已锁定完整PBS元数据提取原文，不信任调用方任意复制的许可。
    const metadata = download ? await download(components.pythonMetadata) : path.join(sourceCache, components.pythonMetadata.filename);
    const supplement = download ? await download(components.pythonLicenseSupplement) : path.join(sourceCache, components.pythonLicenseSupplement.filename);
    for (const [file, item] of [[metadata, components.pythonMetadata], [supplement, components.pythonLicenseSupplement]]) {
      if (!(await lstat(file)).isFile() || await hashFile(file) !== item.sha256) throw new Error('replacement_kit_python_notice_hash');
    }
    await run('/usr/bin/tar', ['-xf', metadata, '-C', notices, 'python/PYTHON.json', 'python/licenses'], { maxBuffer: 1024 * 1024 });
    await cp(supplement, path.join(notices, 'python/licenses/LICENSE.zlib-ng.txt'));
    const index = [], pythonArchiveNotices = [];
    const pythonMembers = (await run('/usr/bin/tar', ['-tzf', selected[0]], { maxBuffer: 8 * 1024 * 1024 })).stdout.split('\n').filter((name) => name && !name.endsWith('/') && /(?:^|\/)(?:licenses?[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*|authors[^/]*)$/i.test(name));
    for (const member of pythonMembers) {
      if (!member.startsWith('python/') || member.split('/').some((part) => part === '..')) throw new Error('replacement_kit_notice_path');
      const target = path.join(notices, 'python-development', member); await mkdir(path.dirname(target), { recursive: true });
      const { stdout } = await run('/usr/bin/tar', ['-xOzf', selected[0], member], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
      await writeFile(target, stdout); pythonArchiveNotices.push({ member, path: path.relative(staging, target), sha256: await hashFile(target) });
    }
    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i]; await cp(selected[i], path.join(staging, 'inputs', item.filename));
      if (!item.filename.endsWith('.whl')) continue;
      const members = (await run('/usr/bin/unzip', ['-Z1', selected[i]], { maxBuffer: 4 * 1024 * 1024 })).stdout.split('\n').filter((name) => name && !name.endsWith('/') && /(?:^|\/)(?:licenses?[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*|authors[^/]*)$/i.test(name));
      if (!members.length) throw new Error(`replacement_kit_notice_missing:${item.filename}`);
      for (const member of members) {
        if (member.startsWith('/') || member.split('/').some((part) => part === '..') || /[\0\r\n]/.test(member)) throw new Error('replacement_kit_notice_path');
        const target = path.join(notices, item.name, member);
        await mkdir(path.dirname(target), { recursive: true });
        const { stdout } = await run('/usr/bin/unzip', ['-p', selected[i], member], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
        await writeFile(target, stdout);
        index.push({ package: item.name, version: item.version, archive: `inputs/${item.filename}`, archiveSha256: item.sha256, member, path: path.relative(staging, target), sha256: await hashFile(target) });
      }
    }
    async function inventory(root, relative = '') {
      const result = [];
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = path.posix.join(relative, entry.name), file = path.join(root, name);
        if (entry.isDirectory()) result.push(...await inventory(root, name));
        else if (entry.isFile()) result.push({ path: name, sha256: await hashFile(file), bytes: (await lstat(file)).size });
        else throw new Error('replacement_kit_file_kind');
      }
      return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    }
    const pythonNotices = await inventory(path.join(notices, 'python'));
    if (JSON.stringify(pythonNotices) !== JSON.stringify(await inventory(path.join(licensesDirectory, 'python')))) throw new Error('replacement_kit_base_python_notices_changed');
    await writeFile(path.join(notices, 'index.json'), JSON.stringify({ formatVersion: 1, buildOnly: true, python: { archive: components.python, metadataArchive: components.pythonMetadata, licenseSupplement: components.pythonLicenseSupplement, files: pythonNotices, developmentArchiveNotices: pythonArchiveNotices }, wheels: index }, null, 2) + '\n');
    const files = await inventory(staging);
    await writeFile(path.join(staging, 'kit-inventory.json'), JSON.stringify({ formatVersion: 1, scope: 'optional-source-modification-tools', files }, null, 2) + '\n');
    await run(process.execPath, [path.join(staging, 'kit.mjs'), 'check']);
    await rename(staging, outputDirectory);
    return { files: files.length + 1, bytes: files.reduce((sum, file) => sum + file.bytes, 0) + (await lstat(path.join(outputDirectory, 'kit-inventory.json'))).size, wheelNotices: index.length, pythonFiles: pythonNotices.length, pythonArchiveNotices: pythonArchiveNotices.length, inventorySha256: await hashFile(path.join(outputDirectory, 'kit-inventory.json')) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), keys = ['--source-cache', '--licenses-directory', '--output-directory'];
  if (args.length !== 6 || keys.some((key, i) => key !== args[i * 2])) throw new Error('replacement_kit_cli_arguments');
  console.log(JSON.stringify(await prepareReplacementKit({ sourceCache: args[1], licensesDirectory: args[3], outputDirectory: args[5] })));
}
