import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {startModelHost,modelBackgroundConcurrency} from '../src/platform/models/model-host.ts';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function options(t){const home=await mkdtemp(join(tmpdir(),'na-model-host-'));t.after(()=>rm(home,{recursive:true,force:true}));return {businessHome:home,infoPath:join(home,'backend.info'),envFilePath:join(home,'configuration.env'),runtimeEnvironment:{}};}
test('并发默认3且仅支持原1到4配置',()=>{
 assert.equal(modelBackgroundConcurrency({}),3);
 for(const n of ['1','2','3','4',' +03 '])assert.equal(modelBackgroundConcurrency({NOTALONE_EXTRACTION_BATCH_CONCURRENCY:n}),Number(n));
 for(const n of ['','0','5','3.0','NaN'])assert.throws(()=>modelBackgroundConcurrency({NOTALONE_EXTRACTION_BATCH_CONCURRENCY:n}));
});
test('仅匿名身份目录保持稳定，不创建socket或许可journal',async t=>{
 const config=await options(t),first=await startModelHost(config);assert.equal(first.arbiter.backgroundLimit,3);
 const identity=first.identityHome;assert.ok(identity.startsWith(join(config.businessHome,'.notalone')));
 assert.equal(Object.hasOwn(first.permit,'path'),false);assert.equal(Object.hasOwn(first.permit,'token'),false);
 assert.deepEqual(await readdir(dirname(identity)),[]);await first.close(async()=>{});
 const next=await startModelHost(config);assert.equal(next.identityHome,identity);await next.close(async()=>{});
});
test('先拒绝排队并停止新调用，再等待真实在途结算，不因pause造成退出死锁',async t=>{
 const host=await startModelHost(await options(t));
 const foreground=await host.arbiter.acquire('foreground'),background=await Promise.all(Array.from({length:3},()=>host.arbiter.acquire('background')));
 const rejected=Promise.all(['foreground','background'].map(kind=>assert.rejects(host.arbiter.acquire(kind),/stopped/)));
 let notified=false,closed=false;const closing=host.close(async()=>{notified=true;await rejected;}).then(()=>closed=true);
 await turn();assert.equal(notified,true);assert.equal(closed,false);
 for(const permit of background)permit.settle();await turn();assert.equal(closed,false);
 foreground.settle();await closing;
});
test('后续装配失败shutdown不创建额外持久许可状态',async t=>{
 const config=await options(t),host=await startModelHost(config);await host.shutdown();
 const recovered=await startModelHost(config);await recovered.close(async()=>{});
 assert.deepEqual(await readdir(dirname(host.identityHome)),[]);
});
test('Unicode数字、下划线和Python空白与旧int解析合成对照',()=>{
 const values=['３','٠٣','+०_३','0_3','𝟘𝟛','\u0085٣\u0085','\u001c3\u001f','\ufeff3','3__0','3_','²','-٣','３.０'];
 const expected=[3,3,3,3,3,3,3,null,null,null,null,null,null];
 assert.deepEqual(values.map(value=>{try{return modelBackgroundConcurrency({NOTALONE_EXTRACTION_BATCH_CONCURRENCY:value});}catch{return null;}}),expected);
});
test('关闭前置步骤暂时失败后同一模型宿主可重试完成关闭',async t=>{
 const host=await startModelHost(await options(t)),failure=new Error('合成暂时关闭失败');
 await assert.rejects(host.close(async()=>{throw failure;}),error=>error===failure);await host.close(async()=>{});
});
test('同宿主一个前台与三个后台共用仲裁但不借槽',async t=>{
 const host=await startModelHost(await options(t));const permits=await Promise.all(['foreground','background','background','background'].map(kind=>host.arbiter.acquire(kind)));
 assert.equal(host.arbiter.snapshot().foregroundActive,true);assert.equal(host.arbiter.snapshot().backgroundActive,3);
 for(const permit of permits)permit.settle();await host.close(async()=>{});
});
test('退出时孤儿许可不阻塞关闭，排空报告保留孤儿数量',async t=>{
 const host=await startModelHost(await options(t));
 const permit=await host.arbiter.acquire('background');permit.orphan();
 await host.close(async()=>{});
 assert.deepEqual(host.drainReport,{timedOut:false,inFlight:0,orphaned:1});
});
test('关闭时真实在途调用超过排空上限，关闭仍返回并标记超时',async t=>{
 const host=await startModelHost({...await options(t),drainTimeoutMs:30});
 await host.arbiter.acquire('foreground');
 await host.close(async()=>{});
 assert.deepEqual(host.drainReport,{timedOut:true,inFlight:1,orphaned:0});
});
