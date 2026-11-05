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
