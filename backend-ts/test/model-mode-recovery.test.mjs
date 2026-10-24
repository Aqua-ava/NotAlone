/** 回退先验只读稳定ModelHost journal；不伪造新路径，不调用模型或PG。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile,chmod,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startModelHost} from '../src/model-host.ts';
import {startHostModelRuntime} from '../src/host-model-runtime.ts';
const expected={code:'reply_runtime_recovery_required'};
async function options(t){const home=await mkdtemp(join(tmpdir(),'na-fallback-'));t.after(()=>rm(home,{recursive:true,force:true}));return {businessHome:home,infoPath:join(home,'backend.info'),envFilePath:join(home,'synthetic.env'),runtimeEnvironment:{}};}
const fallback=config=>startHostModelRuntime({environment:config.runtimeEnvironment,businessHome:config.businessHome,infoPath:config.infoPath,envFilePath:config.envFilePath});
async function realClosed(t){const config=await options(t),host=await startModelHost(config);const path=host.statePath;await host.close(async()=>{});return {config,path};}
test('实际ModelHost active journal不能回退Python，原文件字节保留',async t=>{
 const config=await options(t),host=await startModelHost(config),permit=await host.arbiter.acquire('background');
 await host.shutdown();const before=await readFile(host.statePath);
 await assert.rejects(fallback(config),expected);assert.deepEqual(await readFile(host.statePath),before);permit.orphan();
});
test('全新默认无模型无文件，回退不创建任何模型资源',async t=>{const config=await options(t);assert.equal(await fallback(config),undefined);assert.deepEqual(await readdir(config.businessHome),[]);});
test('实际ModelHost正常settled后可以回退，不改journal',async t=>{const {config,path}=await realClosed(t),before=await readFile(path);assert.equal(await fallback(config),undefined);assert.deepEqual(await readFile(path),before);});
test('实际ModelHost仍活跃时即使active为空也拒绝',async t=>{const config=await options(t),host=await startModelHost(config);try{await assert.rejects(fallback(config),expected);}finally{await host.close(async()=>{});}});
test('实际ModelHost重启恢复unknown后拒回退，不变更PG/原journal',async t=>{
 const config=await options(t);
 const script="import {startModelHost} from './src/model-host.ts';const h=await startModelHost(JSON.parse(process.argv[1]));await h.arbiter.acquire('background');console.log(h.statePath);process.exit(0);";
 const path=execFileSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000}).trim();
 const host=await startModelHost(config);assert.equal(host.statePath,path);assert.equal(host.unknownSettlements().length,1);await host.shutdown();const before=await readFile(path);
 await assert.rejects(fallback(config),expected);assert.deepEqual(await readFile(path),before);
});
for(const [label,content] of [['坏JSON','{'],['null','null'],['false','false'],['错版本',JSON.stringify({version:2,host:null,active:[],unknown:[]})],['缺host',JSON.stringify({version:1,active:[],unknown:[]})],['未知host',JSON.stringify({version:1,host:{pid:1},active:[],unknown:[]})]])test(label+'必须failclosed且不改原journal',async t=>{
 const {config,path}=await realClosed(t);await writeFile(path,content,{mode:0o600});await assert.rejects(fallback(config),expected);assert.equal(await readFile(path,'utf8'),content);
});
test('私有权限不满足时拒回退',async t=>{const {config,path}=await realClosed(t);await chmod(path,0o644);await assert.rejects(fallback(config),expected);});
test('符号链接不作为journal读取',async t=>{const {config,path}=await realClosed(t),body=await readFile(path);await rm(path);const other=join(config.businessHome,'other.json');await writeFile(other,body,{mode:0o600});await symlink(other,path);await assert.rejects(fallback(config),expected);assert.deepEqual(await readFile(other),body);});
test('超限私有journal有界拒绝且保留',async t=>{const {config,path}=await realClosed(t);const body=' '.repeat(1048577);await writeFile(path,body);await assert.rejects(fallback(config),expected);assert.equal((await readFile(path)).length,body.length);});
test('未知旧host身份即使空数组也拒回退',async t=>{const {config,path}=await realClosed(t);await writeFile(path,JSON.stringify({version:1,host:{pid:process.pid,parentPid:process.ppid,startedAt:'',executable:process.execPath},active:[],unknown:[]}));await assert.rejects(fallback(config),expected);});

test('实际ModelHost崩溃留下active且host已gone仍拒回退',async t=>{
 const config=await options(t);
 const script="import {startModelHost} from './src/model-host.ts';const h=await startModelHost(JSON.parse(process.argv[1]));await h.arbiter.acquire('background');console.log(h.statePath);process.exit(0);";
 const path=execFileSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:10000}).trim(),before=await readFile(path);
 assert.equal(JSON.parse(before).active.length,1);await assert.rejects(fallback(config),expected);assert.deepEqual(await readFile(path),before);
});
test('实际managed identity与回退共用同一路径',async t=>{
 const config=await options(t);config.runtimeEnvironment.NOTALONE_MANAGED_USER_DATA=join(config.businessHome,'managed');
 const host=await startModelHost(config),path=host.statePath;assert.ok(path.startsWith(join(config.runtimeEnvironment.NOTALONE_MANAGED_USER_DATA,'model-permits')));
 await host.close(async()=>{});assert.equal(await fallback(config),undefined);await writeFile(path,'null');await assert.rejects(fallback(config),expected);
});
test('FIFO不会阻塞为普通journal',async t=>{const {config,path}=await realClosed(t);await rm(path);execFileSync('/usr/bin/mkfifo',[path]);await chmod(path,0o600);await assert.rejects(fallback(config),expected);});
test('journal目录权限不私有则拒回退',async t=>{const {config,path}=await realClosed(t);await chmod(join(path,'..'),0o755);await assert.rejects(fallback(config),expected);});
for(const kind of ['null','缺host','unknown错误结算'])test('TS opener共享parser拒绝'+kind+'且不覆盖journal',async t=>{
 const {config,path}=await realClosed(t);let body=kind==='null'?'null':JSON.stringify({version:1,active:[],unknown:[]});
 if(kind==='unknown错误结算'){
  const {captureProcessIdentity}=await import('../src/process-identity.ts');
  const worker=await captureProcessIdentity(process.pid,process.ppid,process.execPath);
  body=JSON.stringify({version:1,host:null,active:[],unknown:[{id:'synthetic-permit',kind:'background',worker,settlement:'settled'}]});
 }
 await writeFile(path,body);await assert.rejects(startModelHost(config),/model_permit_journal_invalid/);assert.equal(await readFile(path,'utf8'),body);
});
