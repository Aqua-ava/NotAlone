import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {fork,execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {once} from 'node:events';
const require=createRequire(import.meta.url),contact='11111111-1111-4111-8111-111111111111',trace='22222222-2222-4222-8222-222222222222';
async function ports(t,historical=false){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-trace-main-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=path.join(root,'ports.cjs');
 await build({stdin:{contents:`export {SqliteMemoryManagementController} from './src/main/memory/sqlite-management';export {createSqliteMemoryManagementBridge} from './src/preload/sqlite-memory-management';export {JsonClient,BackendRequestFailure} from './src/main/backend/json-client';export {ContactSession} from './src/main/contacts/session';export {selectionArguments} from './src/main/contacts/bridge';export {configureDiagnosticLog,withDiagnosticTrace,diagnose} from '../backend-ts/src/diagnostics/unified';export {tracedRequest} from '../backend-ts/src/diagnostics/request-trace';export {readDiagnosticRecords} from '../backend-ts/src/diagnostics/unified-log.mjs';`,resolveDir:process.cwd()},outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent',plugins:historical?[{name:'isolated-historical-controller',setup(b){b.onLoad({filter:/\/main\/memory\/sqlite-management\.ts$/},args=>({contents:execFileSync('git',['show','baae193625d43d7315f04c989d3685922f1f4fec:desktop/src/main/memory/sqlite-management.ts'],{encoding:'utf8'}),loader:'ts',resolveDir:path.dirname(args.path)}));}}]:[]});
 const api=require(output),log=api.configureDiagnosticLog(root,{proc:'main',development:true});t.after(()=>log.close());return {...api,root,log};
}
test('管理IPC仅增加合法trace白名单，范围撤下可追到被中断读取编号',async t=>{
 const p=await ports(t),requests=[],broadcasts=[];let fail;
 const controller=new p.SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async request=>{requests.push(request);if(fail)throw fail;return {generation:1,data:{memories:[],candidates:[]}};}},()=>broadcasts.push(true),{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 const read={scope:{scopeKind:'contact',contactId:contact},displayContactId:contact,scopeRevision:1,traceId:trace};
 await controller.read(read);assert.equal(requests[0].traceId,trace);
 await assert.rejects(controller.read({...read,traceId:'合成敏感姓名'}));await assert.rejects(controller.read({...read,unexpected:'正文'}));
 p.withDiagnosticTrace('33333333-3333-4333-8333-333333333333',()=>controller.synchronize('memory_scope_listener','scope_changed'));
 await p.log.flush();const rows=await p.readDiagnosticRecords(p.root),invalid=rows.find(row=>row.event==='management.invalidated');
 assert.equal(broadcasts.length,1);assert.equal(invalid.caller,'memory_scope_listener');assert.equal(invalid.interruptedTraceId,trace);
 fail=new p.BackendRequestFailure('connection',undefined,'request_timeout');await assert.rejects(controller.read(read),/超时/);assert.equal(broadcasts.length,1);
});

test('诊断分类遇到异常属性getter仍保留原业务异常身份，不记录敏感原文',async t=>{
 const p=await ports(t),canary='合成敏感异常正文与堆栈';
 for(const field of ['code','kind','name']){
  const original=new Error(canary);Object.defineProperty(original,field,{get(){throw new Error(canary);}});
  await assert.rejects(p.tracedRequest(trace,'memory.management','management_read',async()=>{throw original;}),error=>error===original);
 }
 await p.log.flush();const rows=await p.readDiagnosticRecords(p.root),failed=rows.filter(row=>row.event==='request.failed');
 assert.equal(failed.length,3);assert.ok(failed.every(row=>row.reasonCode==='request_failed'));assert.equal(JSON.stringify(rows).includes(canary),false);
});

test('联系人范围日志精确区分选择、前台调整和连接换代，并保留严格字段校验',async t=>{
 const p=await ports(t),contacts=new p.ContactSession(async()=>({generation:1,contacts:[{contactId:contact,displayName:'合成联系人',messageCount:0,sourceCount:0}]}));
 contacts.setConnection(1);await contacts.refreshContacts();const scope=contacts.getState().scopeRevision;
 contacts.selectContact(p.selectionArguments([{contactId:contact,scopeRevision:scope,traceId:trace}]));
 assert.throws(()=>p.selectionArguments([{contactId:contact,scopeRevision:scope,traceId:'合成敏感值'}]));assert.throws(()=>p.selectionArguments([{contactId:contact,scopeRevision:scope,body:'敏感正文'}]));
 contacts.invalidateReadingScope('reading_scope_begin');contacts.setConnection(undefined);await p.log.flush();
 const rows=(await p.readDiagnosticRecords(p.root)).filter(row=>row.event==='scope.revision_changed');
 assert.deepEqual(rows.map(row=>row.caller),['connection_generation','select_contact','reading_scope_begin','connection_generation']);
 assert.equal(rows[1].traceId,trace);assert.equal(rows[1].fromRevision,scope);assert.equal(rows[1].toRevision,scope+1);
 assert.equal(JSON.stringify(rows).includes('合成联系人'),false);
});

test('隔离原revision重现历史触发链：真实运输超时随后无条件广播资料失效',async t=>{
 const p=await ports(t,true),server=createServer(()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new p.JsonClient({port:server.address().port,token:'synthetic-token'}),invalidations=[];
 const controller=new p.SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async request=>({generation:1,data:(await client.perform({...request,traceId:trace,timeoutMs:20})).data})},()=>{
  invalidations.push(true);p.diagnose({event:'management.invalidated',caller:'management_read_failed',reasonCode:'request_timeout',traceId:trace,interruptedTraceId:trace});
 },{getState:()=>({selectedContactId:contact,scopeRevision:1})});
 await assert.rejects(p.withDiagnosticTrace(trace,()=>controller.read({scope:{scopeKind:'contact',contactId:contact},displayContactId:contact,scopeRevision:1})));
 assert.equal(invalidations.length,1);await p.log.flush();const rows=(await p.readDiagnosticRecords(p.root)).filter(row=>row.traceId===trace);
 assert.deepEqual(rows.filter(row=>['request.failed','management.invalidated'].includes(row.event)).map(row=>[row.event,row.reasonCode]),[['request.failed','request_timeout'],['management.invalidated','request_timeout']]);
 t.diagnostic(JSON.stringify({sourceRevision:'baae193625d43d7315f04c989d3685922f1f4fec',timeoutMs:20,events:rows.map(row=>row.event)}));
});

test('渲染桥经严格IPC、真实HTTP与SQLite Worker生成可还原的双进程时间线',{timeout:20000},async t=>{
 const p=await ports(t),child=fork(path.resolve('../backend-ts/test/fixtures/unified-trace-http.mjs'),[p.root],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','ignore','ipc']});
 const exited=once(child,'exit');t.after(async()=>{if(child.connected)child.send('close');const timer=setTimeout(()=>child.kill(),5000);try{await exited;}finally{clearTimeout(timer);}});
 const [{port}]=await once(child,'message',{signal:AbortSignal.timeout(10000)}),client=new p.JsonClient({port,token:'synthetic-token'}),read={scope:{scopeKind:'contact',contactId:contact},displayContactId:contact,scopeRevision:1};
 const controller=new p.SqliteMemoryManagementController({getConnectionGeneration:()=>1,requestJson:async request=>({generation:1,data:(await client.perform(request)).data})},()=>{}, {getState:()=>({selectedContactId:contact,scopeRevision:1})});
 let input;
 const bridge=p.createSqliteMemoryManagementBridge({invoke:(channel,value)=>{input=value;return channel==='memory:documents-read'?controller.readDocuments(value):controller.read(value);},on(){},removeListener(){}});
 assert.deepEqual((await bridge.read(read)).view,{memories:[],candidates:[]});assert.match(input.traceId,/^[a-f0-9-]{36}$/);
 assert.equal((await bridge.readDocuments({...read,traceId:input.traceId})).view.status,'idle');
 await assert.rejects(client.perform({method:'GET',path:'/api/memory-management?scope_kind=contact&contact_id='+contact,traceId:'合成敏感值'}));
 child.send('close');await exited;await p.log.flush();const rows=(await p.readDiagnosticRecords(p.root)).filter(row=>row.traceId===input.traceId);
 assert.deepEqual(new Set(rows.map(row=>row.proc)),new Set(['main','backend']));
 assert.ok(rows.some(row=>row.event==='request.started'&&row.caller==='management_read'));
 assert.ok(rows.some(row=>row.event==='request.finished'&&row.proc==='backend'));
 assert.ok(rows.some(row=>row.event==='request.finished'&&row.proc==='backend'&&row.caller==='management_documents'));
 assert.ok(rows.some(row=>row.event==='sql.summary'&&row.count===101));
 const timeline=execFileSync('pnpm',['run','diag','--data-dir',p.root,'--trace',input.traceId],{cwd:path.resolve('..'),encoding:'utf8'}).split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
 assert.equal(timeline.length,rows.length);assert.deepEqual(timeline.map(row=>row.time),timeline.map(row=>row.time).sort());
 t.diagnostic(JSON.stringify({traceId:input.traceId,eventCount:rows.length,processes:[...new Set(rows.map(row=>row.proc))]}));
});

test('轻量上下文在原生Node TypeScript与主进程CJS均能惰性初始化同一个写者',async t=>{
 const run=promisify(execFile),root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-trace-context-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const entry=path.resolve('../backend-ts/test/fixtures/unified-context-smoke.mjs'),output=path.join(root,'context.cjs');
 await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 for(const [name,args] of [['native',['--experimental-strip-types',entry]],['main-cjs',[output]]]){
  const data=await realpath(await mkdtemp(path.join(root,name+'-')));
  const {stdout}=await run(process.execPath,args,{env:{...process.env,NOTALONE_DIAGNOSTIC_ROOT:data,NOTALONE_DIAGNOSTIC_LEVEL:'debug'}});
  assert.deepEqual(JSON.parse(stdout),{count:1,proc:'backend'});
 }
});

test('首次惰性加载保留事件发生时间，初始化完成时间不能改变跨进程因果顺序',async t=>{
 const run=promisify(execFile),root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-trace-observed-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const entry=path.resolve('../backend-ts/test/fixtures/unified-context-smoke.mjs'),output=path.join(root,'context.cjs');
 await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 for(const [name,args] of [['native',['--experimental-strip-types',entry,'--timestamp']],['main-cjs',[output,'--timestamp']]]){
  const data=await realpath(await mkdtemp(path.join(root,name+'-')));
  const {stdout}=await run(process.execPath,args,{env:{...process.env,NOTALONE_DIAGNOSTIC_ROOT:data,NOTALONE_DIAGNOSTIC_LEVEL:'debug'}});
  assert.deepEqual(JSON.parse(stdout),{count:1,proc:'backend',withinObservedCall:true});
 }
});
