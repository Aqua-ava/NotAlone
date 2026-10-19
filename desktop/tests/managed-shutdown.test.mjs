import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-managed-shutdown-'));
const built = await build({ stdin: { contents: `export { OwnedBackendProcess } from './src/main/backend/process'; export { BackendHost } from './src/main/backend/host'; export { BackendConnectionNote } from './src/renderer/backend-status'; export { renderToStaticMarkup } from 'react-dom/server'; export { createElement } from 'react';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false });
await writeFile(path.join(directory, 'subject.cjs'), built.outputFiles[0].text);
const { OwnedBackendProcess, BackendHost, BackendConnectionNote, renderToStaticMarkup, createElement } = await import(path.join(directory, 'subject.cjs'));
after(() => rm(directory, { recursive: true, force: true }));
for (const throws of [false, true]) test(`后台尚未形成时资料服务停止${throws ? '异常' : '未确认'}仍公开可重试停服，重试成功才完成`, async () => {
  let attempts = 0;
  const host = new BackendHost(directory, undefined, undefined, async () => { if (++attempts === 1) { if (throws) throw Error('synthetic'); return false; } return true; });
  assert.equal(await host.stop(), false);
  assert.equal(host.getState().phase, 'shutdown-failed');
  assert.equal(host.getState().canRetryShutdown, true);
  assert.equal(host.getState().canRetryConnection, false);
  const html = renderToStaticMarkup(createElement(BackendConnectionNote, { state: host.getState(), startup: { mode: 'managed', phase: 'blocked', code: 'runtime_stop_unconfirmed', revision: 1, helperWarnings: [] } }));
  assert.match(html, /重试停读并退出/);
  assert.match(html, /后端关闭未获确认/);
  assert.equal(await host.stop(), true);
  assert.equal(host.getState().phase, 'stopped');
  assert.equal(host.getState().canRetryShutdown, false);
});


test("既有外置后台保持原命令协议，旧版不必识别受管寿命参数", async () => {
  const project = path.join(directory, "legacy-project");
  const executable = path.join(directory, "legacy-python");
  const marker = path.join(directory, "legacy-started");
  await mkdir(path.join(project, "backend/src/notalone/server"), { recursive: true });
  await writeFile(path.join(project, "backend/src/notalone/server/command.py"), "# 合成旧版后台\n");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require("node:fs"); if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["-m","notalone.server.command","--host","127.0.0.1"]))process.exit(2);fs.writeFileSync(${JSON.stringify(marker)},"started");setInterval(()=>{},1000);`, {mode:0o700});
  const child = await OwnedBackendProcess.launch({ source: "external", pythonExecutable: executable, projectDirectory: project, infoPath: path.join(directory,"legacy.info") }, () => true);
  try {
    // 全量测试会并行编译；这里核验旧版命令兼容性，不把进程调度延迟当作启动性能要求。
    const deadline = Date.now()+10000;
    while(await readFile(marker,"utf8").catch(()=>"")!=="started" && child.isRunning() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(await readFile(marker,"utf8").catch(()=>""), "started");
    assert.equal(child.isRunning(),true);
  } finally { assert.equal(await child.terminate(),true); }
});
