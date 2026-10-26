import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-managed-shutdown-'));
const built = await build({ stdin: { contents: `export { SetupController } from './src/main/setup/controller'; export { RuntimeClient } from './src/main/backend/runtime-client'; export { OwnedBackendProcess } from './src/main/backend/process'; export { BackendHost } from './src/main/backend/host'; export { BackendConnectionNote } from './src/renderer/backend-status'; export { renderToStaticMarkup } from 'react-dom/server'; export { createElement } from 'react';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false });
await writeFile(path.join(directory, 'subject.cjs'), built.outputFiles[0].text);
const { SetupController, RuntimeClient, OwnedBackendProcess, BackendHost, BackendConnectionNote, renderToStaticMarkup, createElement } = await import(path.join(directory, 'subject.cjs'));
after(() => rm(directory, { recursive: true, force: true }));
const runningStatus={"state":"running","runtime":"dsh","hostRuntime":"typescript","ownership":{"contacts":"typescript","deletion":"typescript","wechat":"typescript","skills":"typescript","skillLearning":"typescript","imports":"typescript","taskApi":"typescript","taskManagement":"typescript","tasks":"typescript","crossDomainDeletion":"typescript","wechatBodySync":"typescript","wechatIncremental":"typescript","wechatHistory":"typescript","foregroundLocation":"typescript","contactContext":"typescript","memory":"typescript","expressionPreferences":"typescript"}};
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


test('默认外置启动只有DSH入口，失效旧字段不再要求或执行Python', async () => {
  const project = path.join(directory, 'default-ts-project');
  const executable = path.join(project, 'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const marker = path.join(directory, 'default-ts-started');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(project, 'backend-ts/src'), { recursive: true });
  await mkdir(path.join(project, 'backend-ts/profile'), { recursive: true });
  await writeFile(path.join(project, 'backend-ts/src/launch.ts'), '// 合成入口\n');
  await writeFile(path.join(project, 'backend-ts/profile/host.patch.yml'), '[]\n');
  await writeFile(executable, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`);
  const child = await OwnedBackendProcess.launch({ source: 'external', projectDirectory: project,
    pythonExecutable: '/synthetic/missing-python', infoPath: path.join(directory,'default-ts.info') }, () => true);
  try {
    const deadline = Date.now()+5000;
    while(await readFile(marker,'utf8').catch(()=>'')!=='started' && child.isRunning() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(await readFile(marker,'utf8'), 'started');
  } finally { assert.equal(await child.terminate(),true); }
});

test('DSH 入口缺失时明确失败，不静默启动旧后台', async () => {
  const project = path.join(directory, 'missing-dsh-project');
  const executable = path.join(directory, 'fallback-python');
  await mkdir(path.join(project, 'backend/src/notalone/server'), { recursive: true });
  await writeFile(path.join(project, 'backend/src/notalone/server/command.py'), '# 合成后台\n');
  await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);`, { mode: 0o700 });
  let started;
  try {
    await assert.rejects(async () => {
      started = await OwnedBackendProcess.launch({ runtime: 'dsh', source: 'external',
        pythonExecutable: executable, projectDirectory: project, infoPath: path.join(directory, 'missing-dsh.info') }, () => true);
    });
    await assert.rejects(access(path.join(directory, 'missing-dsh.info.dsh-lock')), { code: 'ENOENT' });
  } finally { if (started) await started.terminate(); }
});


test('DSH连接必须证明唯一TS责任，拒绝旧壳、缺失归属和Python写者', async () => {
  let payload={state:'running'};
  const server=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer synthetic_token');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port,client=new RuntimeClient({address:`127.0.0.1:${port}`,port,token:'synthetic_token',pid:process.pid},'dsh');
    for(const invalid of [{state:'running'}, {...runningStatus,hostRuntime:'legacy'}, {...runningStatus,legacyPid:123}, {...runningStatus,ownership:{}}, {...runningStatus,ownership:{...runningStatus.ownership,memory:'python'}}]){
      payload=invalid;await assert.rejects(client.status());
    }
    payload=runningStatus;assert.equal(await client.status(),'running');
    payload={state:'stopped',runtime:'dsh'};assert.equal(await client.shutdown(),'stopped');
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('已认证旧DSH只保留停读入口，拒绝业务复用并在退出时认证关停', async () => {
  const userData=path.join(directory,'old-shell');await mkdir(userData);
  let shutdowns=0;
  const server=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic_token');
    const stopped=req.url==='/api/runtime/shutdown';if(stopped)shutdowns++;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({state:stopped?'stopped':'running',runtime:'dsh',...(stopped?{}:{hostRuntime:'legacy',legacyPid:123})}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(path.join(userData,'backend-launch.json'),JSON.stringify({backendInfoPath:path.join(userData,'backend.info')}));
  await writeFile(path.join(userData,'backend.info'),`address=127.0.0.1:${server.address().port}\ntoken=synthetic_token\npid=${process.pid}\n`,{mode:0o600});
  const host=new BackendHost(userData);
  try{
    await host.connect();assert.equal(host.getState().phase,'disconnected');
    assert.equal(host.getState().canPrepareConfiguration,true);assert.equal(host.getConnectionGeneration(),undefined);
    await assert.rejects(host.requestJson({method:'GET',path:'/api/setup/status'}));
    assert.equal(shutdowns,0);assert.equal(await host.stop(),true);assert.equal(shutdowns,1);
  }finally{await host.stop();await new Promise(resolve=>server.close(resolve));}
});

test('唯一已有本人仅在明确确认后恢复配置，认证重启后沿用原身份', async () => {
  const project = path.join(directory, 'recover-project');
  const userData = path.join(directory, 'recover-user');
  const executable = path.join(project, 'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const saved = path.join(directory, 'recovered-owner');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(project, 'backend-ts/src'), { recursive: true });
  await mkdir(path.join(project, 'backend-ts/profile'), { recursive: true });
  await mkdir(userData);
  await writeFile(path.join(project, 'backend-ts/src/launch.ts'), '// 合成入口\n');
  await writeFile(path.join(project, 'backend-ts/profile/host.patch.yml'), '[]\n');
  const script = `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http');
const info=process.env.NOTALONE_BACKEND_INFO,saved=${JSON.stringify(saved)};
const ready=fs.existsSync(saved);
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer synthetic_token'){res.writeHead(401);res.end('{}');return;}
 let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
 let result=${JSON.stringify(runningStatus)};
 if(req.url==='/api/setup/status')result={initialized:true,owner_configured:true,credentials_configured:false,runtime_owner_configured:ready,recoverable_owner:!ready};
 if(req.url==='/api/setup/recover-owner'){
  if(body!==JSON.stringify({confirm_existing_owner:true})){res.writeHead(400);res.end('{}');return;}
  fs.writeFileSync(saved,'11111111-1111-4111-8111-111111111111');result={owner_id:'11111111-1111-4111-8111-111111111111',created:false};
 }
 const stopping=req.url==='/api/runtime/shutdown';if(stopping)result={state:'stopped',runtime:'dsh'};
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
 if(stopping){fs.rmSync(info,{force:true});server.close(()=>process.exit(0));}
 });
});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(info,'address=127.0.0.1:'+server.address().port+'\\ntoken=synthetic_token\\npid='+process.pid+'\\n',{mode:0o600}));
`;
  await writeFile(executable, script, { mode: 0o700 });
  await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({ pythonExecutable: executable,
    projectDirectory: project, backendInfoPath: path.join(userData, 'backend.info') }));
  const host = new BackendHost(userData);
  const setup = new SetupController(host);
  try {
    await host.connect(); await setup.refresh();
    assert.equal(setup.getState().phase, 'identity-unbound');
    assert.equal(setup.getState().recoverableOwner, true);
    await assert.rejects(access(saved), { code: 'ENOENT' });
    await setup.recoverExistingOwner();
    assert.equal(setup.getState().phase, 'ready');
    assert.equal(await readFile(saved, 'utf8'), '11111111-1111-4111-8111-111111111111');
  } finally { assert.equal(await host.stop(), true); }
});
