import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// 存储线程被终止（动作超时）后，后台进程仍应答但不会自行恢复；宿主必须识别并整体重启自有进程。
const directory=await mkdtemp(path.join(tmpdir(),'notalone-storage-loss-'));
const built=await build({stdin:{contents:`export {BackendHost} from './src/main/backend/host.ts';export {RuntimeClient,BackendStorageUnavailable,RetiredBackendRuntime} from './src/main/backend/runtime-client.ts';`,
 resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
await writeFile(path.join(directory,'bundle.mjs'),built.outputFiles[0].text);
const {BackendHost,RuntimeClient,BackendStorageUnavailable,RetiredBackendRuntime}=await import(path.join(directory,'bundle.mjs'));
after(()=>rm(directory,{recursive:true,force:true}));
const until=async(predicate,message)=>{for(let i=0;i<60;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail(message);};
const ownership=Object.fromEntries(['contacts','deletion','wechat','skills','skillLearning','imports','taskApi','taskManagement','tasks','crossDomainDeletion','wechatBodySync','wechatIncremental','wechatHistory','foregroundLocation','contactContext','memory','expressionPreferences'].map(key=>[key,'typescript']));

async function statusServer(identity){
 const server=createServer((_req,res)=>{
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({state:'running',runtime:'dsh',hostRuntime:'typescript',ownership,shutdownFailed:false,shutdownProtocol:'poll-v1',storageIdentity:identity}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {port:server.address().port,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
const expected={databaseId:'db-1',ownerId:'owner-1'};

test('状态接口报告同一数据库的存储不可用：区别于换库或旧实现，仍属明确失联',async t=>{
 const same=await statusServer({...expected,available:false});
 t.after(same.close);
 const client=new RuntimeClient({port:same.port,token:'synthetic_token',pid:process.pid},'dsh',expected);
 await assert.rejects(client.status(),error=>error instanceof BackendStorageUnavailable&&error instanceof RetiredBackendRuntime);
 const other=await statusServer({databaseId:'db-2',ownerId:'owner-1',available:false});
 t.after(other.close);
 const mismatched=new RuntimeClient({port:other.port,token:'synthetic_token',pid:process.pid},'dsh',expected);
 await assert.rejects(mismatched.status(),error=>error instanceof RetiredBackendRuntime&&!(error instanceof BackendStorageUnavailable),'换库不得被当成可重启的存储丢失');
 const healthy=await statusServer({...expected,available:true});
 t.after(healthy.close);
 assert.equal(await new RuntimeClient({port:healthy.port,token:'synthetic_token',pid:process.pid},'dsh',expected).status(),'running');
});

// 合成的自有子进程与认证目标：不启动任何真实后台。
function fakeChild(){
 const child={pid:424242,running:true,terminated:0,isRunning:()=>child.running,waitForExit:async()=>!child.running,
  async terminate(){child.terminated++;child.running=false;return true;}};
 return child;
}
function fakeTarget(error){
 const target={cancelled:0,connection:{pid:424242},status:async()=>{throw error();},cancelPending(){target.cancelled++;},shutdown:async()=>{throw new Error('存储已不可用时不应再请求优雅停读');},isListening:async()=>false};
 return target;
}
async function connectedHost(t,{owned=true,error=()=>new BackendStorageUnavailable()}={}){
 const userData=await mkdtemp(path.join(directory,'user-'));
 let checks=0;
 const host=new BackendHost(userData,async()=>{checks++;});
 host.pollIntervalMs=20;host.recoveryDelaysMs=[600000];
 const child=owned?fakeChild():undefined,target=fakeTarget(error);
 host.ownedChild=child;host.target=target;
 host.publish({phase:'connected',errorCode:undefined,canRetryConnection:false});
 t.after(async()=>{clearTimeout(host.pollTimer);clearTimeout(host.recoveryTimer);});
 return {host,child,target,checks:()=>checks};
}

test('自有后台存储不可用：直接回收该进程并重新连接，不再接回同一个死存储',async t=>{
 const {host,child,target,checks}=await connectedHost(t);
 host.schedulePoll(host.generation);
 await until(()=>child.terminated===1,'应回收存储已不可用的自有后台');
 await until(()=>checks()>=1,'回收后应重新进入连接流程（启动预检）');
 assert.equal(host.target,undefined);assert.ok(target.cancelled>=1,'在途请求必须被取消');
});

test('重启预算：滚动窗口内最多自动重启上限次，之后保留明确重试入口',async t=>{
 const {host}=await connectedHost(t);
 let restarts=0;
 host.restart=async()=>{restarts++;return true;};
 host.storageRestartLimit=2;
 for(let round=0;round<4;round++){
  host.ownedChild=fakeChild();host.target=fakeTarget(()=>new BackendStorageUnavailable());
  host.publish({phase:'connected',errorCode:undefined,canRetryConnection:false});
  host.schedulePoll(host.generation);
  await until(()=>host.getState().phase==='disconnected','应进入断开态');
 }
 assert.equal(restarts,2);
 assert.equal(host.getState().canRetryConnection,true);
});

test('非自有后台或普通失联不触发重启：只走原有的自动接回',async t=>{
 const notOwned=await connectedHost(t,{owned:false});
 let restarts=0;
 notOwned.host.restart=async()=>{restarts++;return true;};
 notOwned.host.schedulePoll(notOwned.host.generation);
 await until(()=>notOwned.host.getState().phase==='disconnected','非自有进程存储不可用同样断开');
 const retired=await connectedHost(t,{error:()=>new RetiredBackendRuntime()});
 retired.host.restart=async()=>{restarts++;return true;};
 retired.host.schedulePoll(retired.host.generation);
 await until(()=>retired.host.getState().phase==='disconnected','旧实现仍断开');
 assert.equal(restarts,0,'换库或旧实现不是存储线程丢失，不能自动重启');
});
