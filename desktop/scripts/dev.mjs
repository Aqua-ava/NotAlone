import { acquireDevelopmentLease } from './development-lease.mjs';
import { developmentProcesses, requireDevelopmentOnly, developmentDebugArguments } from './development-policy.mjs';
import { context } from 'esbuild';
import { createHash } from 'node:crypto';
import { watch, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import electron from 'electron';
import { requireBuildSpace } from './build-space.mjs';
import { createDevelopmentServer } from './development-server.mjs';
import { superviseDevelopmentApp } from './development-app.mjs';
import { createDevelopmentUpdates } from './development-update.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('npm run dev [-- --user-data-dir /绝对路径]\nReact/CSS 热更新；main、preload、共享代码与 DSH/TypeScript 后台源码保存后安全重启。\n沿用本机配置与数据库，缺少的表结构在原库补齐。终端输入 r 回车重启；Ctrl+C 或 App 菜单退出。');
} else {
  if (args.length && (args.length !== 2 || args[0] !== '--user-data-dir' || !path.isAbsolute(args[1]) || /[\0\r\n]/.test(args[1]))) {
    throw new Error('使用 npm run dev -- --help 查看启动方式');
  }
  developmentDebugArguments(process.env.NOTALONE_DEV_CDP, args[1]);
  const lease = await acquireDevelopmentLease(project);
  if (!lease) {
    requireDevelopmentOnly(await developmentProcesses(project, args[1]));
    console.log('当前项目的开发监督器已运行或正在启动；复用现有实例，不创建第二套构建器。可运行 npm run dev:status 检查宿主。');
  }
  else { try { await develop(); } finally { await lease.close(); } }
}

async function develop() {
  const existing = await developmentProcesses(project, args[1]);
  requireDevelopmentOnly(existing);
  if (existing.development.length === 1) {
    console.log('已复用当前开发实例；保存源码即可更新。运行 npm run dev:status 可核验。');
    return;
  }
  const appDirectory = path.join(project, '.dev/app');
  await requireBuildSpace([appDirectory, tmpdir()]);
  // 固定用途 Skill 只读器按源码时间复用；产品读取时从不临时编译或回落 Node。
  execFileSync('bash', [path.resolve(project, '../native/skill-read/build.sh')], { stdio: 'inherit' });
  await mkdir(appDirectory, { recursive: true });
  await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'notalone-development', version: '0.1.0', main: 'dist/main/index.cjs' }));
  let builder, renderer, running, input, updates, signature, stopping = false;
  const watchers = [];
  const stop = () => { stopping = true; void updates?.close(); void running?.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    builder = await context({
      absWorkingDir: project,
      entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts' },
      outdir: path.join(appDirectory, 'dist'), outExtension: { '.js': '.cjs' },
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
    });
    renderer = await createDevelopmentServer(project);
    if (stopping) return;
    const environment = { ...process.env, NOTALONE_DEV_SERVER: JSON.stringify({ origin: renderer.origin,
      token: renderer.token, projectDirectory: path.dirname(project) }) };
    delete environment.ELECTRON_RUN_AS_NODE;
    const execute = promisify(execFile);
    updates = createDevelopmentUpdates({
      check: signal => execute('pnpm', ['run', 'typecheck'], { cwd: path.dirname(project), signal, maxBuffer: 4 * 1024 * 1024 }),
      build: () => builder.rebuild(),
      publish: result => {
        const next = createHash('sha256');
        for (const file of result.outputFiles) next.update(file.contents);
        const hash = next.digest('hex');
        if (hash === signature) return;
        // main 与 preload 在同一个同步提交中落盘；新保存或停止不会插入两份产物之间。
        for (const file of result.outputFiles) {
          mkdirSync(path.dirname(file.path), { recursive: true }); writeFileSync(file.path, file.contents);
        }
        signature = hash;
      },
      restart: () => {
        if (stopping) return;
        if (running) { running.restart(); return; }
        running = superviseDevelopmentApp(({ background }) => spawn(electron,
          [appDirectory, '--notalone-dev', ...developmentDebugArguments(process.env.NOTALONE_DEV_CDP, args[1]), ...(background ? ['--notalone-dev-background'] : []), ...(args.length ? [`--user-data-dir=${args[1]}`] : [])], { cwd: project, env: environment, detached: true,
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
      },
      report: (stage, error) => {
        console.error(`${stage === 'check' ? '类型检查' : '开发构建'}失败；保留当前 App，修正后保存会自动重试。`);
        if (stage === 'check') console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`.trim());
      },
    });
    // 所有后台与桌面源码共用同一核验队列，不让独立 watcher 绕过类型检查。
    for (const directory of ['src/main', 'src/preload', 'src/shared', '../backend-ts/src']) {
      watchers.push(watch(path.resolve(project, directory), { recursive: true }, (_event, filename) => {
        if (!filename || /\.tsx?$/.test(filename)) void updates.update();
      }));
    }
    if (!await updates.update()) { if (!stopping) process.exitCode = 1; return; }
    if (stopping) return;
    if (process.stdin.isTTY) {
      input = createInterface({ input: process.stdin, output: process.stdout });
      input.on('line', line => { if (line.trim() === 'r') void updates.update(); });
      input.on('SIGINT', stop);
    }
    console.log('开发模式：React/CSS 保存即更新；main/preload/后台源码变化会在类型检查通过后安全重启。沿用现有数据库，仅补齐缺少的结构。');
    process.exitCode = await running.closed;
  } finally {
    stopping = true; input?.close();
    for (const watcher of watchers) watcher.close();
    await updates?.close(); await running?.stop(); await builder?.dispose(); await renderer?.server.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
