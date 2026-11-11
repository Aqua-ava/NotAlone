import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,chmod,mkdir,rm,lstat,symlink,link,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {UnifiedDiagnosticLog,readDiagnosticRecords,writeObservedDiagnostic} from '../src/diagnostics/unified-log.mjs';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {fixture,owner} from './sqlite-clear-support.mjs';
import {SqliteDeletionHttp} from '../src/storage/sqlite/deletion/http.ts';
const a='11111111',b='22222222';
const event=contactPrefix=>({event:'scope.revision_changed',caller:'select_contact',reasonCode:'contact_selected',contactPrefix});
async function rootFor(t){const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-erasure-')));await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('两个写者在前缀删除后拒绝迟到及重启回放，整清除后仍接纳新事件',async t=>{
 const root=await rootFor(t),main=new UnifiedDiagnosticLog(root,{proc:'main'}),backend=new UnifiedDiagnosticLog(root,{proc:'backend'});
 t.after(async()=>{await main.close();await backend.close();});
 for(const log of [main,backend]){log.diagnose(event(a));log.diagnose(event(b));}await Promise.all([main.flush(),backend.flush()]);
 const erasing=main.eraseContact(a);backend.diagnose(event(a));await erasing;await backend.flush();
 backend.diagnose(event(a));backend.diagnose(event(b));await backend.flush();
 const restarted=new UnifiedDiagnosticLog(root,{proc:'backend'});t.after(()=>restarted.close());restarted.diagnose(event(a));restarted.diagnose(event(b));await restarted.flush();
 assert.ok((await readDiagnosticRecords(root)).every(row=>row.contactPrefix!==a));
 assert.equal(await main.clear(),true);main.diagnose(event(b));backend.diagnose(event(b));await Promise.all([main.flush(),backend.flush()]);
 assert.equal((await readDiagnosticRecords(root)).length,2);
 const lock=await lstat(join(root,'logs','diagnostic-maintenance.lock'));assert.equal(lock.mode&0o777,0o600);assert.equal(lock.size,0);
});
test('固定毫秒时钟下新首条仍可写，旧可信lazy回放不能越过单调屏障',async t=>{
 const root=await rootFor(t),fixed=Date.now(),main=new UnifiedDiagnosticLog(root,{proc:'main',now:()=>fixed}),backend=new UnifiedDiagnosticLog(root,{proc:'backend',now:()=>fixed});await Promise.all([main.flush(),backend.flush()]);t.after(async()=>{await main.close();await backend.close();});
 const isolated=await import(`../src/diagnostics/context.ts?erasure=${fixed}`),previous=process.env.NOTALONE_DIAGNOSTIC_ROOT;let captured;
 process.env.NOTALONE_DIAGNOSTIC_ROOT=root;
 try{isolated.diagnose(event(b));isolated.registerDiagnosticLog(main,(event,observedAt,observedNs)=>{captured={event,observedAt,observedNs};});}finally{if(previous===undefined)delete process.env.NOTALONE_DIAGNOSTIC_ROOT;else process.env.NOTALONE_DIAGNOSTIC_ROOT=previous;}
 assert.equal(typeof captured.observedNs,'bigint');assert.equal(await main.clear(),true);
 writeObservedDiagnostic(backend,captured.event,captured.observedAt,captured.observedNs);backend.diagnose(event(b));main.diagnose(event(b));
 backend.diagnose({...event(b),observedNs:'不得进入公共事件'});await Promise.all([main.flush(),backend.flush()]);
 const rows=await readDiagnosticRecords(root);assert.equal(rows.length,2);assert.ok(rows.every(row=>row.time===new Date(fixed).toISOString()));assert.doesNotMatch(JSON.stringify(rows),/observedNs|clearedNs/);assert.equal(backend.stats().rejected,1);
});
test('单调时钟回退模拟在持锁初始化时重置旧屏障，越界Ns仍拒绝',async t=>{
 const root=await rootFor(t),log=new UnifiedDiagnosticLog(root,{proc:'main'});await log.flush();t.after(()=>log.close());const file=join(root,'logs','diagnostic-control.json');
 const control={version:1,epoch:1,clearedAt:Date.now(),clearedNs:(process.hrtime.bigint()+1000000000000n).toString(),prefixes:[]};await writeFile(file,JSON.stringify(control),{mode:0o600});
 const restarted=new UnifiedDiagnosticLog(root,{proc:'backend'});t.after(()=>restarted.close());restarted.diagnose(event(b));await restarted.flush();assert.equal(JSON.parse(await readFile(file,'utf8')).clearedNs,'0');assert.equal((await readDiagnosticRecords(root)).length,1);
 for(const clearedNs of ['-1','01','1.5','18446744073709551616']){await writeFile(file,JSON.stringify({...control,clearedNs}),{mode:0o600});assert.equal(await restarted.clear(),false);}
});
test('真实子进程持锁时清除有界失败，杀退出后由内核释放并可立即重试',async t=>{
 const root=await rootFor(t),log=new UnifiedDiagnosticLog(root,{proc:'main'});await log.flush();t.after(()=>log.close());
 const child=fork(new URL('./fixtures/unified-lock-child.mjs',import.meta.url),[root],{stdio:['ignore','ignore','ignore','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const [message]=await once(child,'message',{signal:AbortSignal.timeout(3000)});assert.equal(message,'locked');
 assert.equal(await log.clear(),false);const closed=once(child,'exit');child.kill('SIGKILL');await closed;
 assert.equal(await log.clear(),true);log.diagnose(event(b));await log.flush();assert.equal((await readDiagnosticRecords(root)).length,1);
});
test('真实main/backend两进程并发追加与前缀清除，保留另一前缀全部200条',async t=>{
 const root=await rootFor(t),main=new UnifiedDiagnosticLog(root,{proc:'main'});await main.flush();t.after(()=>main.close());
 const child=fork(new URL('./fixtures/unified-lock-child.mjs',import.meta.url),[root,'append'],{stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const [ready]=await once(child,'message',{signal:AbortSignal.timeout(3000)});assert.equal(ready,'ready');
 const done=once(child,'message',{signal:AbortSignal.timeout(5000)}),exited=once(child,'exit');child.send('append');
 const erased=main.eraseContact(a);for(let n=0;n<100;n++){main.diagnose(event(a));main.diagnose(event(b));}
 await Promise.all([erased,main.flush()]);assert.equal((await done)[0],'done');await exited;
 const rows=await readDiagnosticRecords(root);assert.equal(rows.filter(row=>row.contactPrefix===a).length,0);assert.equal(rows.filter(row=>row.contactPrefix===b).length,200);
});
test('维护锁或抑制文件的符号链接及越界控制字段不被跟随，明确清除不报成功',async t=>{
 for(const name of ['diagnostic-maintenance.lock','diagnostic-control.json'])await t.test(name,async t=>{
  const root=await rootFor(t);await mkdir(join(root,'logs'),{mode:0o700});const target=join(root,'target');await writeFile(target,'合成私密目标',{mode:0o600});await symlink(target,join(root,'logs',name));
  const log=new UnifiedDiagnosticLog(root,{proc:'main'});t.after(()=>log.close());assert.doesNotThrow(()=>log.diagnose(event(a)));await log.flush();assert.equal(await log.clear(),false);assert.equal(await readFile(target,'utf8'),'合成私密目标');
 });
});
test('真实联系人删除只清目标前缀，账号删除从两个联系人墓碑取集并阻止旧队列',async t=>{
 const f=await fixture(t),backend=configureDiagnosticLog(f.root,{proc:'backend',development:true}),main=new UnifiedDiagnosticLog(f.root,{proc:'main'});t.after(async()=>{await backend.close();await main.close();});
 const first=f.contactA.slice(0,8),second=f.contactB.slice(0,8);
 for(const log of [main,backend]){log.diagnose(event(first));log.diagnose(event(second));}await Promise.all([main.flush(),backend.flush()]);
 const contact=await f.current.deletion.plan({ownerId:owner,requestKey:'diagnostic-contact',scope:{kind:'contact',contactId:f.contactA}});
 assert.equal((await f.current.deletion.advance({ownerId:owner,operationId:contact.operationId})).state,'completed');await backend.flush();
 let rows=await readDiagnosticRecords(f.root);assert.equal(rows.some(row=>row.contactPrefix===first),false);assert.equal(rows.filter(row=>row.contactPrefix===second).length,2);
 const account=await f.current.deletion.plan({ownerId:owner,requestKey:'diagnostic-account',scope:{kind:'account'}});
 assert.equal((await f.current.deletion.advance({ownerId:owner,operationId:account.operationId})).state,'completed');
 for(const log of [main,backend]){log.diagnose(event(first));log.diagnose(event(second));}await Promise.all([main.flush(),backend.flush()]);
 rows=await readDiagnosticRecords(f.root);assert.ok(rows.every(row=>![first,second].includes(row.contactPrefix)));
 const control=JSON.parse(await readFile(join(f.root,'logs','diagnostic-control.json'),'utf8'));
 assert.ok(control.prefixes.some(row=>row.prefix===first));assert.ok(control.prefixes.some(row=>row.prefix===second));
 await assert.rejects(f.current.storage.eraseDiagnostics({ownerId:owner,operationId:account.operationId,token:'forged',planRevision:1n}),{code:'deletion_stale_runner'});
});
test('真实联系人删除遇统一控制文件不安全保持blocked，修复后可沿原任务重试',async t=>{
 const f=await fixture(t),log=configureDiagnosticLog(f.root,{proc:'backend'});t.after(()=>log.close());await log.flush();
 const target=join(f.root,'private-target');await writeFile(target,'合成私密原件',{mode:0o600});const control=join(f.root,'logs','diagnostic-control.json');await symlink(target,control);
 const op=await f.current.deletion.plan({ownerId:owner,requestKey:'diagnostic-unsafe',scope:{kind:'contact',contactId:f.contactA}});
 assert.equal((await f.current.deletion.advance({ownerId:owner,operationId:op.operationId})).state,'blocked');assert.equal(await readFile(target,'utf8'),'合成私密原件');
 await rm(control);assert.equal((await f.current.deletion.advance({ownerId:owner,operationId:op.operationId})).state,'completed');
});
test('删除HTTP在原确认边界内继承trace到终态和SQL，拒绝额外或坏关联字段',async t=>{
 const f=await fixture(t),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());
 const http=new SqliteDeletionHttp(f.current.deletion,owner),server=createServer((req,res)=>{http.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const trace=randomUUID(),url=`http://127.0.0.1:${server.address().port}/api/contacts/${f.contactA}`;
 const api=(head,body)=>fetch(url,{method:'DELETE',headers:{'x-trace-id':head},body:JSON.stringify(body)});
 assert.equal((await api('bad-private-trace',{confirmed:true,confirm_contact_id:f.contactA})).status,400);
 assert.equal((await api(trace,{confirmed:true,confirm_contact_id:f.contactA,traceId:trace})).status,400);
 const result=await api(trace,{confirmed:true,confirm_contact_id:f.contactA});assert.equal(result.status,202);const receipt=await result.json();assert.equal(receipt.state,'completed');await log.flush();
 const rows=(await readDiagnosticRecords(f.root)).filter(row=>row.traceId===trace);assert.ok(rows.some(row=>row.event==='sql.summary'));assert.ok(rows.some(row=>row.event==='deletion.decision'&&row.taskId===receipt.operation_id&&row.reasonCode==='completed'));assert.doesNotMatch(JSON.stringify(rows),/bad-private-trace/);
});
test('抑制有14天期限与4096前缀硬界限，过期会物理淘汰且控制字段严格拒绝越界',async t=>{
 const root=await rootFor(t);let now=Date.now();const log=new UnifiedDiagnosticLog(root,{proc:'main',now:()=>now});t.after(()=>log.close());await log.flush();
 assert.equal(await log.eraseContact(a),true);const location=join(root,'logs','diagnostic-control.json');
 now+=15*86400_000;log.diagnose(event(a));await log.flush();assert.equal((await readDiagnosticRecords(root)).length,1);assert.deepEqual(JSON.parse(await readFile(location,'utf8')).prefixes,[]);
 const prefixes=Array.from({length:4096},(_,n)=>({prefix:n.toString(16).padStart(8,'0'),createdAt:now,expiresAt:now+14*86400_000}));
 await writeFile(location,JSON.stringify({version:1,epoch:0,clearedAt:0,clearedNs:'0',prefixes}),{mode:0o600});assert.equal(await log.eraseContact(a),false);
 await writeFile(location,JSON.stringify({version:1,epoch:0,clearedAt:0,clearedNs:'0',prefixes:[],body:'合成私密正文'}),{mode:0o600});assert.equal(await log.clear(),false);
 assert.equal((await log.status()).available,false);
});
test('控制文件拒绝宽松权限、多硬链接及超容量，失败不写入也不清除目标',async t=>{
 for(const kind of ['permission','hardlink','oversize'])await t.test(kind,async t=>{
  const root=await rootFor(t),log=new UnifiedDiagnosticLog(root,{proc:'main'});await log.flush();t.after(()=>log.close());
  const file=join(root,'logs','diagnostic-control.json'),text=JSON.stringify({version:1,epoch:0,clearedAt:0,clearedNs:'0',prefixes:[]});
  if(kind==='hardlink'){const target=join(root,'target');await writeFile(target,text,{mode:0o600});await link(target,file);}
  else{await writeFile(file,kind==='oversize'?'x'.repeat(512*1024+1):text,{mode:0o600});if(kind==='permission')await chmod(file,0o644);}
  const before=await readFile(file,'utf8');log.diagnose(event(b));await log.flush();assert.equal(await log.clear(),false);assert.equal(await readFile(file,'utf8'),before);
 });
});
