import { context } from 'esbuild';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import electron from 'electron';
import { requireBuildSpace } from './build-space.mjs';
import { createDevelopmentServer } from './development-server.mjs';
import { superviseDevelopmentApp } from './development-app.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('npm run dev [-- --user-data-dir /绝对路径]\nReact/CSS 热更新；main、preload、共享代码与 Python 保存后安全重启。\n沿用本机配置，不自动迁移数据库。终端输入 r 回车重启；Ctrl+C 或 App 菜单退出。');
} else {
  if (args.length && (args.length !== 2 || args[0] !== '--user-data-dir' || !path.isAbsolute(args[1]) || /[\0\r\n]/.test(args[1]))) {
    throw new Error('使用 npm run dev -- --help 查看启动方式');
  }
  await develop();
}

async function develop() {
  const appDirectory = path.join(project, '.dev/app');
  await requireBuildSpace([appDirectory, tmpdir()]);
  await mkdir(appDirectory, { recursive: true });
  await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'notalone-development', version: '0.1.0', main: 'dist/main/index.cjs' }));
  let builder, renderer, running, input, timer, signature, stopping = false;
  const watchers = [];
  const restart = () => {
    if (stopping) return;
    clearTimeout(timer); timer = setTimeout(() => running?.restart(), 180);
  };
  const stop = () => { stopping = true; clearTimeout(timer); void running?.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    builder = await context({
      absWorkingDir: project,
      entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts' },
      outdir: path.join(appDirectory, 'dist'), outExtension: { '.js': '.cjs' },
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
      plugins: [{ name: 'notalone-restart-after-build', setup(build) {
        build.onEnd(async result => {
          if (result.errors.length) { console.error('编译失败；保留当前 App，修正后保存会自动重试。'); return; }
          const next = createHash('sha256');
          for (const file of result.outputFiles) next.update(file.contents);
          const hash = next.digest('hex');
          if (hash === signature) return;
          for (const file of result.outputFiles) {
            await mkdir(path.dirname(file.path), { recursive: true }); await writeFile(file.path, file.contents);
          }
          signature = hash; restart();
        });
      } }],
    });
    await builder.rebuild();
    renderer = await createDevelopmentServer(project);
    if (stopping) return;
    clearTimeout(timer);
    const environment = { ...process.env, NOTALONE_DEV_SERVER: JSON.stringify({ origin: renderer.origin,
      token: renderer.token, projectDirectory: path.dirname(project) }) };
    delete environment.ELECTRON_RUN_AS_NODE;
    running = superviseDevelopmentApp(() => spawn(electron,
      [appDirectory, '--notalone-dev', ...(args.length ? [`--user-data-dir=${args[1]}`] : [])], { cwd: project, env: environment, detached: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
    await builder.watch();
    for (const [directory, extension] of [['../backend/src/notalone', '.py'], ['../backend/database/migrations', '.sql']]) {
      watchers.push(watch(path.resolve(project, directory), { recursive: true }, (_event, filename) => {
        if (filename?.endsWith(extension) && !filename.split(path.sep).includes('__pycache__')) restart();
      }));
    }
    if (process.stdin.isTTY) {
      input = createInterface({ input: process.stdin, output: process.stdout });
      input.on('line', line => { if (line.trim() === 'r') restart(); });
      input.on('SIGINT', stop);
    }
    console.log('开发模式：React/CSS 保存即更新；main/preload/Python 变化会安全重启。数据库迁移仍需明确确认。');
    process.exitCode = await running.closed;
  } finally {
    stopping = true; clearTimeout(timer); input?.close();
    for (const watcher of watchers) watcher.close();
    await running?.stop(); await builder?.dispose(); await renderer?.server.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
