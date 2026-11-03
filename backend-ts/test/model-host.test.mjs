import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startModelHost,modelBackgroundConcurrency} from '../src/platform/models/model-host.ts';
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
 const foreground=await host.arbiter.acquire('foreground');
 const background=await Promise.all(Array.from({length:3},()=>host.arbiter.acquire('background')));
 const rejected=Promise.all(['foreground','background'].map(kind=>assert.rejects(host.arbiter.acquire(kind),/stopped/)));
 let notified=false,closed=false;
 const closing=host.close(async()=>{notified=true;await rejected;}).then(()=>closed=true);
 await turn();assert.equal(notified,true);assert.equal(closed,false);
 for(const permit of background)permit.settle();await turn();assert.equal(closed,false);
 foreground.settle();await closing;
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

test('关闭前置步骤暂时失败后同一模型宿主可重试完成关闭',async t=>{
 const host=await startModelHost(await options(t));const failure=new Error('合成暂时关闭失败');
 await assert.rejects(host.close(async()=>{throw failure;}),error=>error===failure);
 await host.close(async()=>{});
});


test('许可journal末写失败后恢复原状态文件，同一关闭操作继续释放真实资源',async t=>{
 const config=await options(t),host=await startModelHost(config),backup=host.statePath+'.backup';
 t.after(()=>host.shutdown().catch(()=>{}));
 await rename(host.statePath,backup);await mkdir(host.statePath);
 await assert.rejects(host.close(async()=>{}));
 await rm(host.statePath,{recursive:true});await rename(backup,host.statePath);
 await host.close(async()=>{});
 const next=await startModelHost(config);assert.deepEqual(next.unknownSettlements(),[]);await next.close(async()=>{});
});

test('宿主默认同时容纳一前台三后台，journal保留四路身份且结算后可重启',async t=>{
 const config=await options(t),host=await startModelHost(config);
 t.after(()=>host.shutdown());
 const permits=await Promise.all(['foreground','background','background','background'].map(kind=>host.arbiter.acquire(kind)));
 const state=JSON.parse(await readFile(host.statePath,'utf8'));
 assert.equal(state.active.filter(item=>item.kind==='foreground').length,1);
 assert.equal(state.active.filter(item=>item.kind==='background').length,3);
 assert.deepEqual(new Set(state.active.map(item=>item.id)),new Set(permits.map(item=>item.id)));
 for(const permit of permits)permit.settle();await host.close(async()=>{});
 const next=await startModelHost(config);assert.deepEqual(next.unknownSettlements(),[]);await next.close(async()=>{});
});

test('重启保留前后台未知调用记录，新许可与再次重启不能抹除未知结算',async t=>{
 const config=await options(t),first=await startModelHost(config),path=first.statePath;
 await first.close(async()=>{});
 // 合成不存在的执行者；只有已证实原执行者消失，journal才允许恢复宿主。
 const gone={pid:2147483647,parentPid:1,startedAt:'Tue Nov 3 00:00:00 2026',executable:process.execPath};
 const active=['foreground','background'].map(kind=>({id:`synthetic-${kind}`,kind,worker:gone,attempt_id:`synthetic-${kind}-attempt`}));
 await writeFile(path,JSON.stringify({version:1,host:gone,active,unknown:[]}));
 const expected=active.map(item=>({...item,settlement:'unknown'})),host=await startModelHost(config);
 t.after(()=>host.shutdown());
 assert.deepEqual(host.unknownSettlements(),expected);
 const permits=await Promise.all(['foreground','background'].map(kind=>host.arbiter.acquire(kind)));
 assert.deepEqual(host.unknownSettlements(),expected);
 assert.deepEqual(host.unconfirmedPermitIds().sort(),['synthetic-background','synthetic-foreground']);
 for(const permit of permits)permit.settle();await host.close(async()=>{});
 const next=await startModelHost(config);assert.deepEqual(next.unknownSettlements(),expected);await next.close(async()=>{});
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')).unknown,expected);
});
