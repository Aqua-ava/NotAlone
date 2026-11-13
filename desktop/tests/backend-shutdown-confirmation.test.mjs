import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const directory=await mkdtemp(path.join(tmpdir(),'notalone-shutdown-confirmation-'));
const built=await build({entryPoints:['src/main/backend/host.ts'],bundle:true,platform:'node',format:'esm',write:false});
await writeFile(path.join(directory,'host.mjs'),built.outputFiles[0].text);
const {BackendHost}=await import(path.join(directory,'host.mjs'));
after(()=>rm(directory,{recursive:true,force:true}));
const ownership=Object.fromEntries(['contacts','deletion','wechat','skills','skillLearning','imports','taskApi','taskManagement','tasks','crossDomainDeletion','wechatBodySync','wechatIncremental','wechatHistory','foregroundLocation','contactContext','memory','expressionPreferences'].map(name=>[name,'typescript']));

async function fixture(t,{protocol=true,failFirst=false,loseBegin=false,loseFirstStatus=false,expectedStorage=false,storageIdentity,stuck=false,owned=false,shutdownTimeoutMs,terminateResult=true}={}) {
  const userData=await mkdtemp(path.join(directory,'user-'));
  let state='running',shutdownFailed=false,attempts=0,legacy=0,release;
  const pending=new Promise(resolve=>{release=resolve;});
  let began;const started=new Promise(resolve=>{began=resolve;});
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic_token');
    const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.method==='POST') {
      if(req.url==='/api/runtime/shutdown')legacy++;
      else assert.equal(req.url,'/api/runtime/shutdown/begin');
      attempts++;state='stopping';began();
      if(failFirst&&attempts===1)shutdownFailed=true;
      else {shutdownFailed=false;if(!stuck)void pending.then(()=>{state='stopped';});}
      if(loseBegin){res.destroy();return;}
      if(req.url==='/api/runtime/shutdown'){await pending;state='stopped';reply(200,{state,runtime:'dsh'});return;}
      reply(202,{state,runtime:'dsh'});return;
    }
    assert.equal(req.url,'/api/runtime/status');
    if(attempts&&loseFirstStatus){loseFirstStatus=false;res.destroy();return;}
    reply(200,{state,runtime:'dsh',hostRuntime:'typescript',ownership,shutdownFailed,storageIdentity,...(protocol?{shutdownProtocol:'poll-v1'}:{})});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(path.join(userData,'backend-launch.json'),JSON.stringify({backendInfoPath:path.join(userData,'backend.info')}));
  await writeFile(path.join(userData,'backend.info'),`address=127.0.0.1:${server.address().port}\ntoken=synthetic_token\npid=${process.pid}\n`,{mode:0o600});
  const host=new BackendHost(userData,expectedStorage?async config=>{
    config.sqlite={userData,expectedDatabaseId:'synthetic-db',expectedOwnerId:'synthetic-owner',role:'test',capabilities:['contacts']};
  }:undefined,undefined,undefined,shutdownTimeoutMs?{shutdownTimeoutMs}:undefined);
  t.after(async()=>{release();await host.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await host.connect();if(!expectedStorage)assert.equal(host.getState().phase,'connected');
  let terminated=0,running=true;
  // 模拟本 App 自有的后端进程：pid 与握手一致才会被视为同一进程。
  if(owned)host.ownedChild={pid:process.pid,isRunning:()=>running,waitForExit:async()=>!running,terminate:async()=>{terminated++;if(terminateResult)running=false;return terminateResult;}};
  return {host,started,release,counts:()=>({attempts,legacy}),terminated:()=>terminated};
}

test('异步停读在排空期间保持stopping，原目标确认后才完成退出',async t=>{
  const f=await fixture(t);let settled=false;
  const stopping=f.host.stop().then(result=>{settled=true;return result;});
  await f.started;
  try {
    assert.equal(f.counts().legacy,0,'已认证支持异步停读，不再等待同步长请求');
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(settled,false);assert.equal(f.host.getState().phase,'stopping');
  } finally {f.release();}
  assert.equal(await stopping,true);assert.equal(f.host.getState().phase,'stopped');
  assert.equal(f.counts().attempts,1);
});

test('停读接纳回包丢失后只查原认证目标，不重放停止',async t=>{
  const f=await fixture(t,{loseBegin:true});
  const stopping=f.host.stop();await f.started;
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(f.host.getState().phase,'stopping');
  f.release();assert.equal(await stopping,true);
  assert.equal(f.counts().attempts,1);
});

test('资源停读失败保留恢复入口，明确重试后才重新收尾',async t=>{
  const f=await fixture(t,{failFirst:true});
  assert.equal(await f.host.stop(),false);
  assert.equal(f.host.getState().phase,'shutdown-failed');
  assert.equal(f.host.getState().canRetryShutdown,true);
  assert.equal(f.counts().attempts,1);
  f.release();assert.equal(await f.host.stop(),true);
  assert.equal(f.counts().attempts,2);
});

test('旧后台没有异步能力时沿用原停读接口，重复退出只执行一轮',async t=>{
  const f=await fixture(t,{protocol:false});
  const first=f.host.stop(),second=f.host.stop();await f.started;f.release();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.deepEqual(f.counts(),{attempts:1,legacy:1});
});

test('停读接纳和首次查询同时丢包时继续核验原服务，不过早要求重试',async t=>{
  const f=await fixture(t,{loseBegin:true,loseFirstStatus:true});
  let settled=false;const stopping=f.host.stop().then(result=>{settled=true;return result;});
  await f.started;
  try {
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(settled,false);
    assert.equal(f.host.getState().phase,'stopping');
  } finally {f.release();}
  assert.equal(await stopping,true);assert.equal(f.counts().attempts,1);
});

test('复用服务必须匹配当前已定位的数据库和本人，失配只保留停读入口',async t=>{
  for(const storageIdentity of [undefined,{databaseId:'other-db',ownerId:'synthetic-owner',available:true},
    {databaseId:'synthetic-db',ownerId:'other-owner',available:true},
    {databaseId:'synthetic-db',ownerId:'synthetic-owner',available:false}]) {
    const f=await fixture(t,{expectedStorage:true,storageIdentity});
    assert.equal(f.host.getState().phase,'disconnected');
    assert.equal(f.host.getState().canPrepareConfiguration,true);
    assert.equal(f.host.getConnectionGeneration(),undefined);
    f.release();assert.equal(await f.host.stop(),true);
  }
});

test('复用服务身份与资料文件均有效时直接连接，停读后仍可确认',async t=>{
  const f=await fixture(t,{expectedStorage:true,storageIdentity:{databaseId:'synthetic-db',ownerId:'synthetic-owner',available:true}});
  assert.equal(f.host.getState().phase,'connected');assert.equal(f.host.getState().reused,true);
  f.release();assert.equal(await f.host.stop(),true);
});

test('自有后端超过桌面等待上限仍在停读，强制回收进程后完成退出',async t=>{
  const f=await fixture(t,{stuck:true,owned:true,shutdownTimeoutMs:300});
  const stopping=f.host.stop();await f.started;
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(f.terminated(),0,'上限之前只等待、不强杀');assert.equal(f.host.getState().phase,'stopping');
  assert.equal(await stopping,true);
  assert.equal(f.terminated(),1);assert.equal(f.host.getState().phase,'stopped');assert.equal(f.counts().attempts,1);
});

test('复用的非自有后端超时不强杀，保留重试入口',async t=>{
  const f=await fixture(t,{stuck:true,shutdownTimeoutMs:300});
  assert.equal(await f.host.stop(),false);
  assert.equal(f.host.getState().phase,'shutdown-failed');assert.equal(f.host.getState().canRetryShutdown,true);
  assert.equal(f.terminated(),0);
});

test('后端明确报告停读失败时不强杀自有进程，仍保留重试入口',async t=>{
  const f=await fixture(t,{failFirst:true,owned:true,shutdownTimeoutMs:300});
  assert.equal(await f.host.stop(),false);
  assert.equal(f.host.getState().phase,'shutdown-failed');assert.equal(f.terminated(),0);
  f.release();assert.equal(await f.host.stop(),true);
});

test('强制回收失败时不宣称已停读，保留重试入口',async t=>{
  const f=await fixture(t,{stuck:true,owned:true,shutdownTimeoutMs:300,terminateResult:false});
  assert.equal(await f.host.stop(),false);
  assert.equal(f.terminated(),1);assert.equal(f.host.getState().phase,'shutdown-failed');assert.equal(f.host.getState().canRetryShutdown,true);
});
