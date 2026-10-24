/** 直接运行验收文件实际after-hook，注入失败资源；不启动业务/SDK/PG。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const sourcePath=process.env.NOTALONE_CLEANUP_SOURCE??new URL('./reply-arbitration-handover.test.mjs',import.meta.url);
const source=await readFile(sourcePath,'utf8');
const hooks=source.split('\n').filter(line=>line.trimStart().startsWith('t.after(async()=>'));
assert.equal(hooks.length,2);
let cleanupReplyFixture;
try { ({cleanupReplyFixture}=await import('./reply-fixture-cleanup.mjs')); }
catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }
for(const [index,hook] of hooks.entries())test(`实际B5-0${index+2}钩子stop失败仍释放provider/client并保留现场`,async()=>{
 const calls=[],original=Error('synthetic_stop_failed');let after,proof;
 const host={child:{pid:100,exitCode:null,signalCode:null}};
 const context={t:{after:fn=>after=fn},releaseB1:undefined,workers:[],hosts:[host],host,bridge:undefined,legacyPids:new Set(),legacyUnconfirmed:false,
  cleanupReplyFixture,stop:async()=>{calls.push('stop');throw original;},
  provider:{listening:false,closeAllConnections:()=>calls.push('provider')},
  f:{directory:'synthetic-directory',client:{database:'synthetic_test',end:async()=>calls.push('client')},close:async()=>calls.push('dispose')},
  save:async(_name,value)=>{calls.push('proof');proof=value;},gone:()=>true,absent:async()=>true,assert,
 };
 vm.runInNewContext(hook,context);
 await assert.rejects(after(),error=>error===original||error.errors?.includes(original));
 assert.ok(calls.includes('provider'),'stop失败后仍须关闭自有provider');
 assert.ok(calls.includes('client'),'stop失败后仍须关闭自己PG client');
 assert.ok(!calls.includes('dispose'),'stop失败必须保留DB/temp现场');
 assert.equal(proof.state,'unconfirmed');assert.equal(proof.fixtureRetained,true);
});

const {stopOwnedChild}=await import('./reply-fixture-cleanup.mjs');
function operations() {
 const calls=[];let proof;
 return {calls,proof:()=>proof,options:{
  closeProvider:async()=>calls.push('provider'),closeClient:async()=>calls.push('client'),
  disposeFixture:async()=>calls.push('dispose'),writeProof:async value=>{proof=value;calls.push('proof');},
 }};
}
test('worker等待有界；未退出时关闭连接、保留现场且失败',async()=>{
 const f=operations(),started=Date.now();
 await assert.rejects(cleanupReplyFixture({...f.options,workers:[{child:{pid:200}}],
  stopChild:()=>new Promise(()=>{}),stageTimeoutMs:10,
  confirmOwnedProcesses:()=>[{pid:200,state:'unconfirmed'}]}),error=>{
   assert.equal(error.errors[0].code,'CLEANUP_TIMEOUT');return true;
  });
 assert.ok(Date.now()-started<1000);assert.deepEqual(f.calls,['provider','client','proof']);
 assert.equal(f.proof().state,'unconfirmed');assert.equal(f.proof().fixtureRetained,true);
});
for(const [index,hook] of hooks.entries())for(const spawned of [false,true])test(`实际B5-0${index+2}钩子${spawned?'正常退出':'host从未spawn'}可安全删除自有现场`,async()=>{
 const calls=[];let after,proof;
 const host=spawned?{child:{pid:100,exitCode:0,signalCode:null}}:undefined;
 vm.runInNewContext(hook,{t:{after:fn=>after=fn},host,hosts:host?[host]:[],workers:[],releaseB1:undefined,bridge:undefined,legacyPids:new Set(),legacyUnconfirmed:false,
  cleanupReplyFixture,stop:stopOwnedChild,
  provider:{listening:false,closeAllConnections:()=>calls.push('provider')},
  f:{directory:'synthetic-directory',client:{database:'synthetic_test',end:async()=>calls.push('client')},close:async()=>{assert.ok(calls.includes('client'));calls.push('dispose');}},
  save:async(_name,value)=>{proof=value;calls.push('proof');},gone:()=>true,absent:async()=>true,assert});
 await after();assert.deepEqual(calls,['provider','client','dispose','proof']);
 assert.equal(proof.state,'cleaned');assert.equal(proof.fixtureRetained,false);
});
test('强退即使取得退出回执也必须保留失败',async()=>{
 const signals=[];let exited;
 const process={child:{pid:100,exitCode:null,signalCode:null,kill(signal){signals.push(signal);if(signal==='SIGKILL')exited([null,'SIGKILL']);}},exited:new Promise(resolve=>exited=resolve)};
 await assert.rejects(stopOwnedChild(process,{graceMs:5,forcedMs:5}),/强退，不能记为正常清理/);
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);
});
test('provider与client各自失败仍写unconfirmed，保留原始stop异常',async()=>{
 const f=operations(),original=Error('synthetic-stop'),provider=Error('synthetic-provider'),client=Error('synthetic-client');
 await assert.rejects(cleanupReplyFixture({...f.options,hosts:[{}],stopChild:async()=>{throw original;},
  closeProvider:async()=>{f.calls.push('provider');throw provider;},closeClient:async()=>{f.calls.push('client');throw client;},
  confirmOwnedProcesses:()=>[{state:'gone'}]}),error=>{
   assert.deepEqual(error.errors,[original,provider,client]);assert.equal(error.cause,original);return true;
  });
 assert.deepEqual(f.calls,['provider','client','proof']);assert.equal(f.proof().fixtureRetained,true);
});
