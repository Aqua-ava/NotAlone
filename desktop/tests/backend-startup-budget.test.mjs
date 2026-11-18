import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syntheticDshProject } from './helpers/synthetic-dsh-project.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-start-budget-'));
const built = await build({ entryPoints: ['src/main/backend/host.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(path.join(directory, 'host.mjs'), built.outputFiles[0].text);
const { BackendHost } = await import(path.join(directory, 'host.mjs'));
after(() => rm(directory, { recursive: true, force: true }));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function subject(name, delay, failureStage) {
  const userData = path.join(directory, name), resources = path.join(userData, 'resources');
  const root = path.join(resources, 'notalone-runtime'), marker = path.join(userData, 'owned-pid');
  const executable = await syntheticDshProject(path.join(root, 'project'));
  await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({
    projectDirectory: path.join(root, 'project'), backendInfoPath: path.join(userData, 'backend.info') }));
  await writeFile(executable, `#!${process.execPath}\n
const fs=require('node:fs'),http=require('node:http');
const info=process.env.NOTALONE_BACKEND_INFO;
fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
fs.writeFileSync(${JSON.stringify(marker + '.environment')},JSON.stringify({
 budget:process.env.NOTALONE_PROBLEM_BUDGET??null,
 round:process.env.NOTALONE_PROBLEM_ROUND??null,
 apiKeyPresent:process.env.NOTALONE_DEEPSEEK_API_KEY!==undefined,
}));
let server;
const failureStage=${JSON.stringify(failureStage) ?? 'undefined'};
if(failureStage){
 fs.writeFileSync(info+'.startup-diagnostic.json',JSON.stringify({version:1,stage:failureStage,cause:'unexpected_failure',recordedAt:Date.now()}),{mode:0o600});
 process.exit(1);
}
const timer=setTimeout(()=>{
 server=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer synthetic_token'){res.writeHead(401);res.end('{}');return;}
  const stopped=req.method==='POST'&&req.url==='/api/runtime/shutdown';
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(stopped?{state:'stopped',runtime:'dsh'}:{"state":"running","runtime":"dsh","hostRuntime":"typescript","ownership":{"contacts":"typescript","deletion":"typescript","wechat":"typescript","skills":"typescript","skillLearning":"typescript","imports":"typescript","taskApi":"typescript","taskManagement":"typescript","tasks":"typescript","crossDomainDeletion":"typescript","wechatBodySync":"typescript","wechatIncremental":"typescript","wechatHistory":"typescript","foregroundLocation":"typescript","contactContext":"typescript","memory":"typescript","expressionPreferences":"typescript"}}));
  if(stopped){fs.rmSync(info,{force:true});server.close(()=>process.exit(0));}
 });
 server.listen(0,'127.0.0.1',()=>fs.writeFileSync(info,'address=127.0.0.1:'+server.address().port+'\\ntoken=synthetic_token\\npid='+process.pid+'\\n',{mode:0o600}));
},${delay});
process.on('SIGTERM',()=>{clearTimeout(timer);fs.rmSync(info,{force:true});if(server)server.close(()=>process.exit(0));else process.exit(0);});
setInterval(()=>{},1000);
`, { mode: 0o700 });
  const host = new BackendHost(userData, async config => {
    config.sqlite = { userData, expectedDatabaseId: `synthetic-${name}`, role: 'test', capabilities: ['contacts'] };
  }, resources);
  return { host, marker };
}
async function ownedPid(marker) {
  const deadline = Date.now() + 3000;
  let value;
  while (!(value = await readFile(marker, 'utf8').catch(() => '')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(Number(value) > 1); return Number(value);
}

test('真实启动失败从有界诊断公开具体阶段，临时运行目录清理后原因仍可查询',async()=>{
  for(const stage of ['runtime','configuration','storage','modules','handshake']){
    const {host,marker}=await subject(`failure-${stage}`,0,stage);
    try {
      await host.connect();
      assert.equal(host.getState().phase,'disconnected');
      assert.equal(host.getState().errorCode,`backend_startup_${stage}_failed`);
      assert.equal(host.getState().canRetryConnection,true);
      assert.equal(alive(Number(await readFile(marker,'utf8'))),false);
    }finally{await host.stop();}
  }
});

test('桌面启动真实子进程时保留显式诊断预算绑定，不传递模型凭据环境', async t => {
  const names = ['NOTALONE_PROBLEM_BUDGET', 'NOTALONE_PROBLEM_ROUND', 'NOTALONE_DEEPSEEK_API_KEY'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const budget = path.join(directory, 'synthetic-problem.sqlite');
  process.env.NOTALONE_PROBLEM_BUDGET = budget;
  process.env.NOTALONE_PROBLEM_ROUND = 'synthetic-r1';
  process.env.NOTALONE_DEEPSEEK_API_KEY = 'synthetic-only';
  const { host, marker } = await subject('diagnostic-budget', 0);
  try {
    await host.connect();
    assert.equal(host.getState().phase, 'connected');
    assert.deepEqual(JSON.parse(await readFile(marker + '.environment', 'utf8')), {
      budget, round: 'synthetic-r1', apiKeyPresent: false,
    });
  } finally { await host.stop(); }
});

test('SQLite后台迟到握手仍在有界冷启窗口内连接，认证退出回收孩子', { timeout: 10_000 }, async () => {
  const { host, marker } = await subject('delayed', 250);
  try {
    await host.connect();
    assert.equal(host.getState().phase, 'connected');
    const pid = await ownedPid(marker);
    assert.equal(await host.stop(), true);
    assert.equal(alive(pid), false);
  } finally { await host.stop(); }
});

test('启动中取消不发布连接、最终回收自有SQLite子进程', { timeout: 10_000 }, async t => {
  await Promise.all([
    t.test('启动中取消不发布连接且最终停止自有孩子', async () => {
      const { host, marker } = await subject('cancelled', 1_000);
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
  ]);
});

test('SQLite后台异常退出后公开失败，明确重试回收旧连接并启动新代际', async () => {
  const { host, marker } = await subject('explicit-crash-retry', 0, false);
  try {
    await host.connect();
    assert.equal(host.getState().phase, 'connected');
    const first = await ownedPid(marker);
    const generation = host.getConnectionGeneration();
    process.kill(first, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (host.getState().phase === 'connected' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(host.getState().phase, 'disconnected');
    assert.equal(host.getConnectionGeneration(), undefined);
    assert.equal(host.getState().canRetryConnection, true);
    await Promise.all([host.connect(), host.connect()]);
    assert.equal(host.getState().phase, 'connected');
    assert.notEqual(await ownedPid(marker), first);
    assert.ok(host.getConnectionGeneration() > generation);
    assert.equal(await host.stop(), true);
  } finally { await host.stop(); }
});

test('SQLite后台异常退出后直接退出仍能完成清理，不困在失联目标', async () => {
  const { host, marker } = await subject('crash-then-quit', 0, false);
  try {
    await host.connect();
    assert.equal(host.getState().phase, 'connected');
    const pid = await ownedPid(marker);
    process.kill(pid, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (host.getState().phase === 'connected' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(host.getState().phase, 'disconnected');
    assert.equal(await host.stop(), true);
    assert.equal(host.getState().phase, 'stopped');
  } finally { await host.stop(); }
});
