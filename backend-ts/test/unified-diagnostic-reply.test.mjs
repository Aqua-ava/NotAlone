import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {SqliteReplyCandidateHttp} from '../src/reply/sqlite/candidates/http.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';
test('正常候选HTTP继承合法trace到SQL，固定记录预算、来源及取消原因并拒绝坏头',async t=>{
 const f=await fixture(t),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});t.after(()=>log.close());
 const contactId=f.saved[0].contact_id,discussionId=randomUUID();let failure;
 const service={ownerId:owner};
 const turns=new SqliteReplyTurns({storage:f.storage,service,authorize:async()=>{await f.storage.execute('identity.directory',{ownerId:owner});throw failure;}});
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service,turns,authorize:req=>req.headers.authorization==='Bearer synthetic'&&req.headers.origin===undefined});
 const server=createServer((req,res)=>{http.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}},()=>{res.writeHead(500);res.end();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await turns.close();await new Promise(resolve=>server.close(resolve));});
 const api=traceId=>fetch(`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussionId}/reply-candidates`,{method:'POST',headers:{authorization:'Bearer synthetic','x-trace-id':traceId},body:JSON.stringify({request_key:randomUUID(),text:'合成私密请求正文',confirmed_contact:true})});
 for(const [code,reason]of [['input_budget_exceeded','budget_exhausted'],['discussion_context_stale','source_stale'],['discussion_generation_cancelled','aborted']]){
  const traceId=randomUUID();failure=new StorageFailure(code);const response=await api(traceId);assert.equal(response.status,409);await response.arrayBuffer();await log.flush();
  const rows=(await readDiagnosticRecords(f.root)).filter(row=>row.traceId===traceId);
  assert.ok(rows.some(row=>row.event==='sql.summary'),'实际SQLite工作须继承同一HTTP trace');
  assert.ok(rows.some(row=>row.module==='reply'&&row.reasonCode===reason),reason);
  assert.ok(rows.some(row=>row.event==='reply.state_changed'&&row.fromState==='preparing'&&row.toState==='failed'));
 }
 const traceId=randomUUID();failure=new Error('合成私密异常正文与路径');Object.defineProperty(failure,'code',{get(){throw new Error('不读取敏感getter');}});
 assert.equal((await api(traceId)).status,409);assert.equal((await api('synthetic-private-bad-trace')).status,400);
 const original=new StorageFailure('synthetic');Object.defineProperty(original,'code',{get(){throw new Error('不读取敏感getter');}});failure=original;
 await assert.rejects(turns.generate({contactId,discussionId,requestKey:randomUUID(),text:'合成私密请求正文',confirmedContact:true}),error=>error===original);
 await log.flush();assert.doesNotMatch(JSON.stringify(await readDiagnosticRecords(f.root)),/合成私密|synthetic-private-bad-trace|不读取敏感getter/);
});
