import { constants } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, inspectManagedRuntime } from './managed-runtime.mjs';
import { auditNative } from './rebuild-psycopg-runtime.mjs';
import { requireBuildSpace } from './build-space.mjs';
const run = promisify(execFile);
const execute = (file, args) => run(file, args, { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
const runtimePath = 'Contents/Resources/notalone-runtime';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function canonicalTarget(file) {
  try { return await realpath(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(await canonicalTarget(path.dirname(file)), path.basename(file)); }
}
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
async function appFiles(root, excludeRuntime = false, relative = '') {
  root = await realpath(root);
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name), file = path.join(root, name);
    if (excludeRuntime && (name === runtimePath || name === 'Contents/_CodeSignature')) continue;
    if (entry.isDirectory()) result.push(...await appFiles(root, excludeRuntime, name));
    else if (entry.isSymbolicLink()) {
      const resolved = await realpath(file);
      if (!resolved.startsWith(root + path.sep)) throw new Error('replacement_install_app_symlink_escape');
      result.push({ path: name, link: await readlink(file) });
    } else if (entry.isFile()) result.push({ path: name, sha256: await hashFile(file), mode: (await lstat(file)).mode & 0o777 });
    else throw new Error('replacement_install_app_file_kind');
    if (result.length > 50_000) throw new Error('replacement_install_app_budget');
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

// 只在新副本安装组件；不调用产品、用户资料或仓库打包器。
export async function installRuntimeCopy({ appDirectory, runtimeDirectory, outputApp, receipt }) {
  const selected = [appDirectory, runtimeDirectory, outputApp, receipt];
  if (selected.some((file) => typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) || !appDirectory.endsWith('.app') || !outputApp.endsWith('.app')) throw new Error('replacement_install_arguments');
  const canonical = await Promise.all(selected.map((file) => canonicalTarget(path.resolve(file))));
  if (canonical.some((file, i) => canonical.some((other, j) => i !== j && overlaps(file, other)))) throw new Error('replacement_install_path_overlap');
  for (const file of [outputApp, receipt]) if (await lstat(file).catch(() => undefined)) throw new Error('replacement_install_output_exists');
  await requireBuildSpace([outputApp, path.dirname(receipt)]);
  for (const file of [appDirectory, runtimeDirectory]) if (!(await lstat(file)).isDirectory() || (await lstat(file)).isSymbolicLink()) throw new Error('replacement_install_input_directory');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('replacement_install_platform');
  const [originalApp, replacement] = canonical;
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', originalApp]);
  const originalRuntime = await inspectManagedRuntime(path.join(originalApp, runtimePath));
  const modifiedRuntime = await inspectManagedRuntime(replacement);
  for (const name of ['cpython', 'notalone']) {
    const base = originalRuntime.components.find((item) => item.name === name), modified = modifiedRuntime.components.find((item) => item.name === name);
    if (!base || JSON.stringify(base) !== JSON.stringify(modified)) throw new Error(`replacement_install_incompatible_component:${name}`);
  }
  const project = (manifest) => manifest.files.filter((item) => item.path.startsWith('project/'));
  if (JSON.stringify(project(originalRuntime)) !== JSON.stringify(project(modifiedRuntime))) throw new Error('replacement_install_project_changed');
  const allNative = await auditNative(replacement, execute);
  if (!allNative.length) throw new Error('replacement_install_native_missing');
  const originalFiles = await appFiles(originalApp);
  const resources = await appFiles(originalApp, true);
  const asar = 'Contents/Resources/app.asar', asarSha256 = await hashFile(path.join(originalApp, asar));
  await mkdir(path.dirname(outputApp), { recursive: true });
  await mkdir(path.dirname(receipt), { recursive: true });
  // APFS可克隆文件节约峰值；不使用会联动原包字节的硬链接。
  await cp(originalApp, outputApp, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
  await rm(path.join(outputApp, runtimePath), { recursive: true });
  await cp(replacement, path.join(outputApp, runtimePath), { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
  if (JSON.stringify(resources) !== JSON.stringify(await appFiles(outputApp, true))) throw new Error('replacement_install_copy_changed');
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=identifier,entitlements,flags', outputApp]);
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', outputApp]);
  const copied = await inspectManagedRuntime(path.join(outputApp, runtimePath));
  if (JSON.stringify(copied) !== JSON.stringify(modifiedRuntime)) throw new Error('replacement_install_runtime_changed');
  const after = await appFiles(outputApp, true);
  const signingChanges = resources.filter((item, i) => JSON.stringify(item) !== JSON.stringify(after[i])).map((item) => item.path);
  // codesign可改外层主可执行文件的签名槽；其它非运行时资源必须逐字节保留。
  const executable = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(originalApp, 'Contents/Info.plist')])).stdout.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(executable) || resources.length !== after.length || signingChanges.some((name) => name !== `Contents/MacOS/${executable}`)) throw new Error('replacement_install_resources_changed');
  if (await hashFile(path.join(outputApp, asar)) !== asarSha256) throw new Error('replacement_install_asar_changed');
  if (JSON.stringify(originalFiles) !== JSON.stringify(await appFiles(originalApp))) throw new Error('replacement_install_original_changed');
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', originalApp]);
  const result = { formatVersion: 1, scope: 'copy-only-compatible-runtime-install', originalUnchanged: true, originalFiles: originalFiles.length,
    originalInventorySha256: digest(originalFiles), preservedFiles: resources.length, preservedInventorySha256: digest(resources), asarSha256,
    replacementManifestSha256: await hashFile(path.join(replacement, 'manifest.json')), installedManifestSha256: await hashFile(path.join(outputApp, runtimePath, 'manifest.json')),
    nativeCount: allNative.length, native: allNative, signing: 'local-ad-hoc', signingChanges, deepStrictSignature: true,
    userDataRead: false, appLaunched: false, developerId: false };
  await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`新App副本已安装并严格签名：${outputApp}；原包及${resources.length}项其它资源已核对，ASAR不变。`);
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), keys = ['--app-directory', '--runtime-directory', '--output-app', '--receipt'];
  if (args.length !== 8 || keys.some((key, i) => args[i * 2] !== key)) throw new Error('replacement_install_cli_arguments');
  await installRuntimeCopy({ appDirectory: args[1], runtimeDirectory: args[3], outputApp: args[5], receipt: args[7] });
}
