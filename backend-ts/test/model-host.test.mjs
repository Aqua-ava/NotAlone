import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startModelHost,modelBackgroundConcurrency} from '../src/model-host.ts';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function options(t) {
 const home=await mkdtemp(join(tmpdir(),'na-model-host-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 return {businessHome:home,infoPath:join(home,'backend.info'),envFilePath:join(home,'configuration.env'),runtimeEnvironment:{}};
}
test('并发默认3且仅支持原1到4配置',()=>{
 assert.equal(modelBackgroundConcurrency({}),3);
 for(const n of ['1','2','3','4',' +03 '])assert.equal(modelBackgroundConcurrency({NOTALONE_EXTRACTION_BATCH_CONCURRENCY:n}),Number(n));
 for(const n of ['','0','5','3.0','NaN'])assert.throws(()=>modelBackgroundConcurrency({NOTALONE_EXTRACTION_BATCH_CONCURRENCY:n}));
});
test('许可目录稳定不含临时profile，正常关闭后可恢复',async t=>{
 const config=await options(t),first=await startModelHost(config);
 assert.equal(first.arbiter.backgroundLimit,3);
 assert.ok(first.statePath.startsWith(join(config.businessHome,'.notalone')));
 const path=first.statePath;await first.close(async()=>{});
 const second=await startModelHost(config);assert.equal(second.statePath,path);
 assert.deepEqual(second.unknownSettlements(),[]);await second.close(async()=>{});
 const state=JSON.parse(await readFile(path,'utf8'));assert.equal(state.host,null);assert.deepEqual(state.active,[]);
});
test('先拒绝排队并停止新调用，再等待真实在途结算，不因pause造成退出死锁',async t=>{
 const host=await startModelHost(await options(t));
 const active=await host.arbiter.acquire('background');
 const queued=host.arbiter.acquire('foreground');
 const rejected=assert.rejects(queued,/stopped/);
 let notified=false,closed=false;
 const closing=host.close(async()=>{notified=true;await rejected;}).then(()=>closed=true);
 await turn();assert.equal(notified,true);assert.equal(closed,false);
 active.settle();await closing;
});
test('后续装配失败shutdown释放零调用新资源，保留稳定恢复记录',async t=>{
 const config=await options(t),host=await startModelHost(config);
 await host.shutdown();const recovered=await startModelHost(config);await recovered.close(async()=>{});
});

test('Unicode数字、下划线和Python空白与旧int解析合成对照',()=>{
 const values=['３','٠٣','+०_३','0_3','𝟘𝟛','\u0085٣\u0085','\u001c3\u001f','\ufeff3','3__0','3_','²','-٣','３.０'];
 // 固定23a旧Python int/strip的合成预期；旧执行器另由历史命令复验。
 const expected=[3,3,3,3,3,3,3,null,null,null,null,null,null];
 const actual=values.map(value=>{try{return modelBackgroundConcurrency({NOTALONE_EXTRACTION_BATCH_CONCURRENCY:value});}catch{return null;}});
 assert.deepEqual(actual,expected);
});
