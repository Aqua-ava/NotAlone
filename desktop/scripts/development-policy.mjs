import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

// 进程命令只用于分类，不结束未知进程，也不打印其他应用参数。
export function classifyDevelopmentProcesses(output, project, userData) {
  const entry = `${path.resolve(project)}/.dev/app --notalone-dev`;
  const scope = userData ? `--user-data-dir=${userData}` : undefined;
  const result = { development: [], packaged: [], orphaned: [] };
  const processes = output.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean);
  for (const match of processes) {
    const command = match[3];
    if (command.includes(`/Electron.app/Contents/MacOS/Electron ${entry}`)
      && (scope ? command.endsWith(` ${scope}`) : !command.includes(' --user-data-dir='))) {
      const parent = processes.find(candidate => candidate[1] === match[2]);
      const supervised = parent && /(?:^|\/)node(?:\s|$)/.test(parent[3]) && /(?:^|[ /])scripts\/dev\.mjs(?:\s|$)/.test(parent[3]);
      result[supervised ? 'development' : 'orphaned'].push(Number(match[1]));
    }
    if (command.includes('/NotAlone.app/Contents/MacOS/NotAlone')
      && !command.includes(' --type=')) result.packaged.push(Number(match[1]));
  }
  return result;
}

export async function developmentProcesses(project, userData) {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 4 * 1024 * 1024 });
  return classifyDevelopmentProcesses(stdout, project, userData);
}

export function requireDevelopmentOnly(state) {
  if (state.orphaned?.length) throw new Error('开发宿主的热更新监督器已退出；请先正常退出遗留窗口，再运行 npm run dev。');
  if (state.packaged.length) throw new Error('检测到打包版 NotAlone。请通过应用菜单正常退出后运行 npm run dev；不会强杀或启动第二份。');
  if (state.development.length > 1) throw new Error('发现多个开发实例，请先核对归属；不会自动结束进程。');
}
