import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {UnifiedDiagnosticLog,readDiagnosticRecords,writeObservedDiagnostic} from '../src/diagnostics/unified-log.mjs';
import {diagnosticOverflow} from '../src/diagnostics/buffer.mjs';

const prefix='11111111',oldTrace='11111111-1111-4111-8111-111111111111',newTrace='22222222-2222-4222-8222-222222222222';
const temporaryNames={control:name=>/^\.diagnostic-control-[a-f0-9-]{36}\.tmp$/.test(name),settings:name=>/^\.diagnostic-settings-[a-f0-9-]{36}\.tmp$/.test(name)};
const directoryFor=(root,target)=>target==='control'?path.join(root,'logs'):root;
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'notalone-clear-control-race-'))),writers=[];
 await fs.chmod(root,0o700);
 t.after(async()=>{await Promise.all(writers.map(log=>log.close()));await fs.rm(root,{recursive:true,force:true});});
 return {root,writer(proc='main'){const log=new UnifiedDiagnosticLog(root,{proc});writers.push(log);return log;}};
}
const temporaryFiles=async(root,target)=>(await fs.readdir(directoryFor(root,target))).filter(temporaryNames[target]);

test('整清除屏障拒绝旧溢出提示回放，同时保留清除后的新提示',async t=>{
 const f=await fixture(t),main=f.writer(),backend=f.writer('backend');await Promise.all([main.flush(),backend.flush()]);
 const observedAt=Date.now(),observedNs=process.hrtime.bigint();
 assert.equal(await main.clear(),true);
 writeObservedDiagnostic(backend,diagnosticOverflow('diagnostic_transport',7,oldTrace),observedAt,observedNs);
 await backend.flush();
 assert.deepEqual(await readDiagnosticRecords(f.root),[],'旧提示也必须经过单调清除屏障');
 backend.diagnose(diagnosticOverflow('diagnostic_transport',3,newTrace));await backend.flush();
 const rows=await readDiagnosticRecords(f.root);assert.equal(rows.length,1);assert.equal(rows[0].count,3);assert.equal(rows[0].traceId,newTrace);
 assert.equal(await main.clear(),true);
 writeObservedDiagnostic(backend,diagnosticOverflow('diagnostic_transport',7,oldTrace),observedAt,observedNs);
 backend.diagnose(diagnosticOverflow('diagnostic_transport',3,newTrace));await backend.flush();
 const mixed=await readDiagnosticRecords(f.root);assert.equal(mixed.length,1);assert.equal(mixed[0].count,3);assert.equal(mixed[0].traceId,newTrace,'同一保留槽内的新贡献不能被旧贡献连带丢弃或清掉trace');
});

test('关闭返回前排空已经读到开启状态的后台批次，随后事件不再写盘',{timeout:10000},async t=>{
 const f=await fixture(t),main=f.writer(),backend=f.writer('backend');await Promise.all([main.flush(),backend.flush()]);
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),setterPath=Promise.withResolvers();
 const originalRefresh=backend.refreshSettings.bind(backend),originalOpen=fs.open;
 let writing,disabling,writerFinished=false,finishedBeforeDisable;
 // 在真实维护锁内暂停已完成设置读取的批次，固定复现原来的读后写间隙。
 backend.refreshSettings=async()=>{await originalRefresh();entered.resolve();await release.promise;};
 try{
  backend.diagnose({event:'diagnostics.changed',count:1});writing=backend.flush().then(()=>{writerFinished=true;});await entered.promise;
  fs.open=async function(file,...args){
   if(typeof file==='string'){
    if(file===path.join(f.root,'logs','diagnostic-maintenance.lock'))setterPath.resolve('lock');
    else if(path.dirname(file)===f.root&&path.basename(file).startsWith('.diagnostic-settings-'))setterPath.resolve('settings');
   }
   return originalOpen.call(this,file,...args);
  };syncBuiltinESMExports();
  disabling=main.setEnabled(false).then(value=>{finishedBeforeDisable=writerFinished;return value;});
  const first=await Promise.race([setterPath.promise,disabling.then(()=> 'returned')]);
  // 新协议先尝试持锁；旧协议会直接修改设置，此时让它返回后才放行旧批次。
  if(first==='lock')release.resolve();else await disabling;
  release.resolve();await writing;assert.equal(await disabling,true);
  assert.equal(finishedBeforeDisable,true,'关闭不能先返回成功再允许后台旧批次完成追加');
  const before=(await readDiagnosticRecords(f.root)).length;assert.equal(before,1);
  backend.refreshSettings=originalRefresh;
  backend.diagnose({event:'diagnostics.changed',count:2});await backend.flush();
  assert.equal((await readDiagnosticRecords(f.root)).length,before);
 }finally{
  fs.open=originalOpen;syncBuiltinESMExports();backend.refreshSettings=originalRefresh;release.resolve();
  await Promise.allSettled([writing,disabling].filter(Boolean));
 }
});

async function failPrivateReplacement(root,target,kind,work){
 const probe=await fs.open(path.join(root,'handle-probe'),'wx',0o600),prototype=Object.getPrototypeOf(probe);
 await probe.close();await fs.rm(path.join(root,'handle-probe'));
 const originalOpen=fs.open,method=kind==='write'?'writeFile':'sync',originalMethod=prototype[method],handles=new WeakSet();let failed=false;
 fs.open=async function(file,...args){const handle=await originalOpen.call(this,file,...args);if(typeof file==='string'&&path.dirname(file)===directoryFor(root,target)&&temporaryNames[target](path.basename(file)))handles.add(handle);return handle;};
 prototype[method]=async function(...args){
  if(handles.has(this)&&!failed){failed=true;if(kind==='write')await originalMethod.apply(this,args);const error=new Error('synthetic_control_io_failure');error.code='EIO';throw error;}
  return originalMethod.apply(this,args);
 };syncBuiltinESMExports();
 try{await work();assert.equal(failed,true,'故障必须实际命中对应私有临时文件');}
 finally{fs.open=originalOpen;prototype[method]=originalMethod;syncBuiltinESMExports();}
}
test('控制与设置文件写入或同步失败不遗留临时文件，恢复后可成功重试',async t=>{
 for(const target of ['control','settings'])await t.test(target,async t=>{
 for(const kind of ['write','sync'])await t.test(kind,async t=>{
  const f=await fixture(t),log=f.writer();await log.flush();
  const replace=()=>target==='control'?log.eraseContact(prefix):log.setEnabled(false);
  await failPrivateReplacement(f.root,target,kind,async()=>{assert.equal(await replace(),false);});
  assert.deepEqual(await temporaryFiles(f.root,target),[],'失败的临时文件必须在返回前清理');
  assert.equal(await replace(),true);assert.equal(await log.clear(),true);assert.deepEqual(await temporaryFiles(f.root,target),[]);
  if(target==='settings')assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'diagnostic-settings.json'),'utf8')).enabled,false);
 });
 });
});

test('启动安全清理崩溃遗留控制与设置临时文件，不跟随或删除不安全目标',async t=>{
 for(const targetKind of ['control','settings'])await t.test(targetKind,async t=>{
 for(const kind of ['private','symlink','hardlink','permission'])await t.test(kind,async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'logs'),{mode:0o700});
  const temporary=path.join(directoryFor(f.root,targetKind),`.diagnostic-${targetKind}-${randomUUID()}.tmp`),target=path.join(f.root,'private-target'),canary='SYNTHETIC_PRIVATE_CONTROL';
  await fs.writeFile(target,canary,{mode:0o600});
  if(kind==='symlink')await fs.symlink(target,temporary);
  else if(kind==='hardlink')await fs.link(target,temporary);
  else{await fs.writeFile(temporary,JSON.stringify(targetKind==='control'?{prefix}:{enabled:false}),{mode:0o600});if(kind==='permission')await fs.chmod(temporary,0o644);}
  const log=f.writer();await log.flush();
  if(kind==='private'){assert.deepEqual(await temporaryFiles(f.root,targetKind),[]);assert.equal(await log.clear(),true);}
  else assert.equal(await log.clear(),false,'无法安全核验的孤儿不能被静默略过并宣称清除成功');
  assert.equal(await fs.readFile(target,'utf8'),canary);
 });
 });
});
