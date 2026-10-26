import {cp, lstat, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

/** 从共享锁导出独立生产依赖；只准备后端文件，不构建或启动 App。 */
export async function prepareBackendRuntime({repository, project, workDirectory}) {
  const deployed = path.join(workDirectory, 'backend-deploy');
  const lockPath = path.join(repository, 'pnpm-lock.yaml');
  const manifestPath = path.join(repository, 'backend-ts/package.json');
  const originalLock = await readFile(lockPath);
  const originalManifest = await readFile(manifestPath);
  await mkdir(workDirectory, {recursive: true});
  const execution = {cwd: repository, timeout: 300_000, maxBuffer: 8 * 1024 * 1024};
  // deploy 从锁生成清单，单独校验才能拒绝原 package.json 已改变但未更新锁的情况。
  await run('pnpm', ['--filter', './backend-ts', '--fail-if-no-match', 'install', '--frozen-lockfile',
    '--lockfile-only', '--ignore-scripts'], execution);
  // hoisted 只用于交付目录：受管清单不接受目录符号链接，也不能引用工作区虚拟仓库。
  await run('pnpm', ['--filter', './backend-ts', '--fail-if-no-match', '--prod', '--config.node-linker=hoisted',
    '--config.force-legacy-deploy=false', 'deploy', deployed], execution);
  if (!originalLock.equals(await readFile(lockPath)) || !originalManifest.equals(await readFile(manifestPath))) {
    throw new Error('runtime_backend_lock_changed');
  }
  const dependencyRoot = path.join(deployed, 'node_modules');
  const deployedRoot = await realpath(deployed);
  async function checkLinks(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const selected = path.join(directory, entry.name);
      if (entry.isDirectory()) await checkLinks(selected);
      else if (entry.isSymbolicLink()) {
        const resolved = await realpath(selected);
        if (!resolved.startsWith(deployedRoot + path.sep) || !(await lstat(resolved)).isFile()) {
          throw new Error('runtime_backend_dependency_link');
        }
      }
    }
  }
  await checkLinks(dependencyRoot);
  const backend = path.join(project, 'backend-ts');
  await mkdir(backend, {recursive: true});
  for (const name of ['src', 'profile', 'database']) {
    await cp(path.join(repository, 'backend-ts', name), path.join(backend, name), {
      recursive: true, dereference: true,
      filter: source => !/(?:^|\/)(?:\.cache|__pycache__|\.env(?:\.[^/]*)?)(?:\/|$)/.test(source),
    });
  }
  await cp(dependencyRoot, path.join(backend, 'node_modules'), {recursive: true, dereference: true});
  // 保留原始元数据字节，使提取策略身份在开发树和独立运行时一致。
  await writeFile(path.join(project, 'pnpm-lock.yaml'), originalLock);
  await writeFile(path.join(backend, 'package.json'), originalManifest);
  await cp(path.join(deployed, 'pnpm-lock.yaml'), path.join(backend, 'pnpm-lock.yaml'));
  return backend;
}
