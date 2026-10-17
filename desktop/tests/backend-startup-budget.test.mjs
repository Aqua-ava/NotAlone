import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-start-budget-'));
const built = await build({ entryPoints: ['src/main/backend/host.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'host.mjs'), built.outputFiles[0].text);
const { BackendHost } = await import(path.join(directory, 'host.mjs'));
after(() => rm(directory, { recursive: true, force: true }));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function subject(name, delay, managed = true) {
  const userData = path.join(directory, name), resources = path.join(userData, 'resources');
  const root = path.join(resources, 'notalone-runtime'), marker = path.join(userData, 'owned-pid');
  await mkdir(path.join(userData, 'managed'), { recursive: true });
  await writeFile(path.join(userData, 'managed/state.json'), '{}');
  await mkdir(path.join(root, 'project/backend/src/notalone/server'), { recursive: true });
  await writeFile(path.join(root, 'project/backend/src/notalone/server/command.py'), '# 合成受管后台\n');
  await mkdir(path.join(root, 'python/bin'), { recursive: true });
  await writeFile(path.join(root, 'python/bin/python3.12'), `#!${process.execPath}\n
const fs=require('node:fs'),http=require('node:http');
const info=process.env.NOTALONE_BACKEND_INFO;
fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
let server;
const timer=setTimeout(()=>{
 server=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer synthetic_token'){res.writeHead(401);res.end('{}');return;}
  const stopped=req.method==='POST'&&req.url==='/api/runtime/shutdown';
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({state:stopped?'stopped':'running'}));
  if(stopped){fs.rmSync(info,{force:true});server.close(()=>process.exit(0));}
 });
 server.listen(0,'127.0.0.1',()=>fs.writeFileSync(info,'address=127.0.0.1:'+server.address().port+'\\ntoken=synthetic_token\\npid='+process.pid+'\\n',{mode:0o600}));
},${delay});
process.on('SIGTERM',()=>{clearTimeout(timer);fs.rmSync(info,{force:true});if(server)server.close(()=>process.exit(0));else process.exit(0);});
setInterval(()=>{},1000);
`, { mode: 0o700 });
  if (!managed) await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({
    pythonExecutable: path.join(root, 'python/bin/python3.12'), projectDirectory: path.join(root, 'project'),
    backendInfoPath: path.join(userData, 'managed/backend.info') }));
  return { host: new BackendHost(userData, undefined, resources), marker };
}
async function ownedPid(marker) {
  const deadline = Date.now() + 3000;
  let value;
  while (!(value = await readFile(marker, 'utf8').catch(() => '')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(Number(value) > 1); return Number(value);
}

test('受管后台真实迟到握手超过旧12秒仍在有界冷启窗口内连接，认证退出回收孩子', { timeout: 40_000 }, async () => {
  const { host, marker } = await subject('delayed', 13_200);
  try {
    await host.connect();
    assert.equal(host.getState().phase, 'connected');
    const pid = await ownedPid(marker);
    assert.equal(await host.stop(), true);
    assert.equal(alive(pid), false);
  } finally { await host.stop(); }
});

test('有界窗口结束与用户取消都回收本次未握手进程，外置保持旧预算', { timeout: 40_000, concurrency: true }, async t => {
  await Promise.all([
    t.test('受管超时保留明确失败和重试入口', async () => {
      const { host, marker } = await subject('timeout', 60_000);
      try {
        await host.connect();
        const pid = await ownedPid(marker);
        assert.equal(host.getState().phase, 'disconnected');
        assert.equal(host.getState().errorCode, 'backend_connection_failed');
        assert.equal(host.getState().canRetryConnection, true);
        assert.equal(alive(pid), false);
      } finally { await host.stop(); }
    }),
    t.test('受管启动中取消不发布连接且最终停止自有孩子', async () => {
      const { host, marker } = await subject('cancelled', 60_000);
      const states = []; host.onStateChanged(state => states.push(state.phase));
      const connecting = host.connect();
      const pid = await ownedPid(marker);
      try {
        assert.equal(await host.stop(), true);
        await connecting;
        assert.equal(host.getState().phase, 'stopped');
        assert.equal(states.includes('connected'), false);
        assert.equal(alive(pid), false);
      } finally { await host.stop(); }
    }),
    t.test('外置迟到后台仍按旧12秒退出并回收', async () => {
      const { host, marker } = await subject('external-timeout', 13_200, false);
      try {
        await host.connect();
        const pid = await ownedPid(marker);
        assert.equal(host.getState().phase, 'disconnected');
        assert.equal(alive(pid), false);
      } finally { await host.stop(); }
    }),
  ]);
});
