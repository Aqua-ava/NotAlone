import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const usage = '使用 pnpm run dev:stable --help 查看启动方式';

// 仅共享运行必需且被 Git 忽略的本机资源。Electron 与原生产物沿用主工作区的真实路径，
// 系统权限不会因换目录重新授权；Skill 只读器由稳定副本自行构建，避免互相覆盖。
export const sharedResources = ['node_modules', 'desktop/node_modules', 'backend-ts/node_modules', '.env',
  'model-permits', 'local-tools', 'native/media-validation/.build'];

export function stableDirectory(mainRoot) {
  return path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-stable`);
}

export function sharedLinks(mainRoot, stableRoot) {
  return sharedResources.map(relative => ({ source: path.join(mainRoot, relative), target: path.join(stableRoot, relative) }));
}

export function parseStableArguments(args) {
  const rest = args[0] === '--' ? args.slice(1) : args;
  const result = { help: false, update: false, userData: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--help') result.help = true;
    else if (argument === '--update') result.update = true;
    else if (argument === '--user-data-dir' && index + 1 < rest.length) {
      const value = rest[index += 1];
      if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(usage);
      result.userData = value;
    } else throw new Error(usage);
  }
  return result;
}

const git = (cwd, args) => run('git', args, { cwd }).then(({ stdout }) => stdout.trim());
const exists = file => lstat(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
const commonDirectory = cwd => git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(realpath);

async function linkSharedResources(mainRoot, stableRoot) {
  for (const { source, target } of sharedLinks(mainRoot, stableRoot)) {
    if (!await exists(source)) { console.warn(`主工作区缺少 ${path.relative(mainRoot, source)}，稳定副本不创建对应链接。`); continue; }
    if (await exists(target)) {
      // 已有真实文件或其他链接不覆盖；只有指向别处的旧链接才提示。
      const stat = await lstat(target);
      if (stat.isSymbolicLink() && path.resolve(path.dirname(target), await readlink(target)) !== source)
        console.warn(`${path.relative(stableRoot, target)} 链接到其他位置，保持不动。`);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(source, target);
  }
}

export async function prepareStableCopy(scriptRoot, { update }, report = console.log) {
  const mainGit = await commonDirectory(scriptRoot);
  if (path.basename(mainGit) !== '.git') throw new Error('无法定位主工作区；请在 NotAlone 仓库中运行。');
  const mainRoot = path.dirname(mainGit);
  const stableRoot = stableDirectory(mainRoot);
  if (await realpath(scriptRoot) === (await exists(stableRoot) ? await realpath(stableRoot) : stableRoot))
    throw new Error('请在主工作区运行 dev:stable，不要在稳定副本内运行。');
  const head = await git(mainRoot, ['rev-parse', 'HEAD']);
  if (!await exists(stableRoot)) {
    await git(mainRoot, ['worktree', 'add', '--detach', stableRoot, head]);
    report(`已创建稳定副本 ${stableRoot}（${head.slice(0, 9)}）。`);
  } else {
    if (await commonDirectory(stableRoot).catch(() => undefined) !== mainGit) throw new Error(`${stableRoot} 不是本仓库的稳定副本；请先核对，不会覆盖。`);
    const current = await git(stableRoot, ['rev-parse', 'HEAD']);
    if (update && current !== head) {
      // 共享资源链接是未跟踪文件（.gitignore 的目录规则匹配不到符号链接），只看已跟踪文件的改动。
      if (await git(stableRoot, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('稳定副本存在未提交改动；请先核对，不会覆盖。');
      await git(stableRoot, ['checkout', '--detach', head]);
      report(`稳定副本已更新到 ${head.slice(0, 9)}（原 ${current.slice(0, 9)}）；若实例正在运行，会在更新后安全重启。`);
    } else if (current !== head) {
      const behind = await git(mainRoot, ['rev-list', '--count', `${current}..${head}`]).catch(() => '?');
      report(`稳定副本停在 ${current.slice(0, 9)}，主工作区已领先 ${behind} 个提交；需要最新提交时运行 pnpm run dev:stable --update。`);
    }
  }
  await linkSharedResources(mainRoot, stableRoot);
  return { mainRoot, stableRoot };
}

async function main() {
  const options = parseStableArguments(process.argv.slice(2));
  if (options.help) {
    console.log('pnpm run dev:stable [--update] [--user-data-dir /绝对路径]\n'
      + '在独立的稳定副本（主工作区 HEAD 的只读快照）中运行热更新开发实例；其他 Agent 在主工作区改代码、保存或编译失败都不会重启或打断它。\n'
      + '默认沿用已有稳定副本；--update 把它切到主工作区当前 HEAD（仅已提交内容），运行中的实例随后自动重启。\n'
      + '实例使用真实资料目录；同一资料目录只能有一个实例，Agent 验收请用 pnpm run dev --user-data-dir 独立资料目录。');
    return;
  }
  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const { stableRoot } = await prepareStableCopy(scriptRoot, options);
  const child = spawn(process.execPath, [path.join(stableRoot, 'desktop/scripts/dev.mjs'),
    ...(options.userData ? ['--user-data-dir', options.userData] : [])], { cwd: path.join(stableRoot, 'desktop'), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise(resolve => child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
