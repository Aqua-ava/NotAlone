import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const directory=await mkdtemp(path.join(tmpdir(),'notalone-lost-connection-'));
const built=await build({entryPoints:['src/main/backend/host.ts'],bundle:true,platform:'node',format:'esm',write:false});
await writeFile(path.join(directory,'host.mjs'),built.outputFiles[0].text);
const {BackendHost}=await import(path.join(directory,'host.mjs'));
after(()=>rm(directory,{recursive:true,force:true}));
const ownership=Object.fromEntries(['contacts','deletion','wechat','skills','skillLearning','imports','taskApi','taskManagement','tasks','crossDomainDeletion','wechatBodySync','wechatIncremental','wechatHistory','foregroundLocation','contactContext','memory','expressionPreferences'].map(name=>[name,'typescript']));
const until=async(predicate,message)=>{for(let i=0;i<60;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}assert.fail(message);};

// 合成的自有子进程：只模拟启动器返回的句柄，不启动任何真实后台。
function fakeChild({terminations=[true]}={}){
 const child={pid:424242,running:true,terminated:0,
  isRunning:()=>child.running,
  waitForExit:async()=>!child.running,
  async terminate(){const result=terminations[Math.min(child.terminated,terminations.length-1)];child.terminated++;if(result)child.running=false;return result;}};
 return child;
}

test('没有连接目标但自有子进程仍在运行：退出通过回收子进程收尾，不再永远停在失败',async t=>{
 const userData=await mkdtemp(path.join(directory,'user-'));
 let after=0;
 const host=new BackendHost(userData,undefined,undefined,async()=>{after++;return true;});
 const child=fakeChild();
 host.ownedChild=child;
 const phases=[];host.onStateChanged(state=>phases.push(state.phase));
 assert.equal(await host.stop(),true);
 assert.equal(child.terminated,1);assert.equal(after,1);
 assert.equal(host.getState().phase,'stopped');assert.equal(host.getState().canRetryShutdown,false);
 assert.ok(!phases.includes('shutdown-failed'),'不应经过失败态');
});

test('回收子进程失败保留重试入口，重试成功后完成退出',async t=>{
 const userData=await mkdtemp(path.join(directory,'user-'));
 const host=new BackendHost(userData);
 const child=fakeChild({terminations:[false,true]});
 host.ownedChild=child;
 assert.equal(await host.stop(),false);
 assert.equal(host.getState().phase,'shutdown-failed');assert.equal(host.getState().canRetryShutdown,true);
 assert.equal(host.getState().errorCode,'backend_shutdown_unconfirmed');
 assert.equal(await host.stop(),true);
 assert.equal(child.terminated,2);assert.equal(host.getState().phase,'stopped');
});

test('回收子进程抛错同样只保留重试入口',async t=>{
 const userData=await mkdtemp(path.join(directory,'user-'));
 const host=new BackendHost(userData);
 host.ownedChild={pid:1,isRunning:()=>true,waitForExit:async()=>false,terminate:async()=>{throw new Error('synthetic');}};
 assert.equal(await host.stop(),false);
 assert.equal(host.getState().phase,'shutdown-failed');assert.equal(host.getState().canRetryShutdown,true);
});

// 后台仍存活（进程号取测试进程）但状态接口短暂失败：重连必须接回同一实例，不启动第二个。
test('连接丢失后明确重连：接回仍存活的同一后台，不另起实例',async t=>{
 const userData=await mkdtemp(path.join(directory,'user-'));
 let failing=false,served=0,checks=0;
 const server=createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Bearer synthetic_token');
  // 收尾时的停读请求：直接确认已停止。
  if(req.method==='POST'){assert.equal(req.url,'/api/runtime/shutdown/begin');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({state:'stopped',runtime:'dsh'}));return;}
  assert.equal(req.url,'/api/runtime/status');
  if(failing){res.writeHead(500);res.end();return;}
  served++;
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({state:'running',runtime:'dsh',hostRuntime:'typescript',ownership,shutdownFailed:false,shutdownProtocol:'poll-v1'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await writeFile(path.join(userData,'backend-launch.json'),JSON.stringify({backendInfoPath:path.join(userData,'backend.info')}));
 await writeFile(path.join(userData,'backend.info'),`address=127.0.0.1:${server.address().port}\ntoken=synthetic_token\npid=${process.pid}\n`,{mode:0o600});
 // 缺少 projectDirectory：若重连试图启动新后台会以 backend_launch_unconfigured 失败，从而暴露第二次启动。
 const host=new BackendHost(userData,async()=>{checks++;});
 t.after(async()=>{failing=false;await host.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 host.probeFailureLimit=1;host.pollIntervalMs=30;host.recoveryDelaysMs=[600000];
 await host.connect();
 assert.equal(host.getState().phase,'connected');const firstGeneration=host.getConnectionGeneration();
 failing=true;
 await until(()=>host.getState().phase==='disconnected','状态接口失败后应进入断开态');
 assert.equal(host.getState().canRetryConnection,true);assert.equal(host.getConnectionGeneration(),undefined);
 failing=false;
 await host.connect();
 assert.equal(host.getState().phase,'connected',JSON.stringify(host.getState()));
 assert.equal(host.getState().reused,true);assert.equal(host.getState().errorCode,undefined);
 assert.notEqual(host.getConnectionGeneration(),firstGeneration);
 assert.equal(checks,2,'每次连接都先经过启动预检');assert.ok(served>=2);
});

// 合成后台：按脚本让状态接口失败，其余请求（收尾停读）直接确认已停止。
async function statusServer(userData,{fail=()=>false}={}){
 const counters={status:0,failed:0};
 const server=createServer((req,res)=>{
  if(req.method==='POST'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({state:'stopped',runtime:'dsh'}));return;}
  counters.status++;
  if(fail()){counters.failed++;res.writeHead(500);res.end();return;}
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({state:'running',runtime:'dsh',hostRuntime:'typescript',ownership,shutdownFailed:false,shutdownProtocol:'poll-v1'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await writeFile(path.join(userData,'backend-launch.json'),JSON.stringify({backendInfoPath:path.join(userData,'backend.info')}));
 await writeFile(path.join(userData,'backend.info'),`address=127.0.0.1:${server.address().port}\ntoken=synthetic_token\npid=${process.pid}\n`,{mode:0o600});
 const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
 return {server,counters,close};
}

test('状态探测偶发失败不断开连接：连续失败未达上限时代际与在途请求保持不变',async t=>{
 const userData=await mkdtemp(path.join(directory,'user-'));
 let remainingFailures=0;
 const backend=await statusServer(userData,{fail:()=>remainingFailures>0&&remainingFailures--> 0});
 const host=new BackendHost(userData);
 host.pollIntervalMs=20;host.probeFailureLimit=3;host.recoveryDelaysMs=[600000];
 t.after(async()=>{await host.stop();await backend.close();});
 await host.connect();
 const generation=host.getConnectionGeneration();
 const phases=[];host.onStateChanged(state=>phases.push(state.phase));
 remainingFailures=2;
 await until(()=>backend.counters.failed>=2,'应已出现两次连续探测失败');
 const served=backend.counters.status;
 await until(()=>backend.counters.status>=served+3,'失败后应继续探测并恢复正常');
 assert.equal(host.getState().phase,'connected');
 assert.equal(host.getConnectionGeneration(),generation,'偶发失败不得换代际，否则会取消回复生成等全部在途请求');
 assert.ok(!phases.includes('disconnected'),'不应经过断开态');
});

test('连续探测失败后进入断开态，后台仍存活时自动接回同一实例，无需手动重试',async t=>{
 const userData=await mkdtemp(path.join(directory,'user-'));
 let failing=false;
 const backend=await statusServer(userData,{fail:()=>failing});
 let checks=0;
 // 缺少 projectDirectory：若自动恢复试图启动新后台会以 backend_launch_unconfigured 失败，从而暴露第二次启动。
 const host=new BackendHost(userData,async()=>{checks++;});
 host.pollIntervalMs=20;host.probeFailureLimit=3;host.recoveryDelaysMs=[40];
 t.after(async()=>{failing=false;await host.stop();await backend.close();});
 await host.connect();
 const firstGeneration=host.getConnectionGeneration();
 failing=true;
 await until(()=>host.getState().phase==='disconnected','连续失败后应进入断开态');
 assert.equal(host.getConnectionGeneration(),undefined);
 failing=false;
 await until(()=>host.getState().phase==='connected','后台恢复后应自动接回');
 assert.equal(host.getState().reused,true);assert.equal(host.getState().errorCode,undefined);
 assert.notEqual(host.getConnectionGeneration(),firstGeneration);
 assert.ok(checks>=2,'自动接回同样经过启动预检');
});

test('后台进程已不存在时不自动接回或另起实例，保留明确重试入口',async t=>{
 const userData=await mkdtemp(path.join(directory,'user-'));
 let failing=false;
 const backend=await statusServer(userData,{fail:()=>failing});
 let checks=0;
 const host=new BackendHost(userData,async()=>{checks++;});
 host.pollIntervalMs=20;host.probeFailureLimit=1;host.recoveryDelaysMs=[40];
 await host.connect();
 assert.equal(checks,1);
 await backend.close();
 await until(()=>host.getState().phase==='disconnected','后台消失后应进入断开态');
 await new Promise(resolve=>setTimeout(resolve,400));
 assert.equal(host.getState().phase,'disconnected');
 assert.equal(host.getState().canRetryConnection,true);
 assert.equal(checks,1,'进程不存在时不得自动重连或启动替代后台');
});
