import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {createServer} from 'node:http';
import {SqliteReplyCandidateHttp} from '../src/reply/sqlite/candidates/http.ts';

const registryModule=new URL('./fixtures/sqlite/reply-preparation-failure-registry.mjs',import.meta.url).href;

test('真实准备动作超时：原请求立即核对为未发送失败，重开后历史仍有明确中断原因',{timeout:10000},async t=>{
 const f=await fixture(t,{registryModule,actionTimeoutMs:500}),contactId=f.ids[0];
 const discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},embed:async()=>assert.fail('记忆池读取失败后不能执行语义模型')});t.after(()=>turns.close());
 const workspace={action:'express',draftText:'合成准备超时请求',tone:'original',instruction:'',contextText:'',includeRelationshipContext:true};
 const input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:workspace.draftText,workspace,confirmedContact:true};
 await assert.rejects(turns.generate(input),{code:'discussion_preparation_timeout'});
 assert.equal(f.storage.failureDiagnostic.cause,'action_timeout');assert.equal(f.storage.failureDiagnostic.action,'reply.memoryPool');
 const failed=await service.status(contactId,discussion.id,input.requestKey);
 assert.equal(failed.phase,'failed');assert.equal(failed.sent,false);assert.equal(failed.retryable,true);
 assert.equal(failed.errorCode,'discussion_preparation_timeout');assert.ok(failed.startedAt<=failed.finishedAt);
 assert.equal(f.requests.length,0,'准备失败没有模型出站');
 await assert.rejects(service.status(f.ids[1],discussion.id,input.requestKey),'终态回执不能串联系人');
 await assert.rejects(service.status(contactId,discussion.id,randomUUID()),'不能把未知请求猜作未发送');
 await turns.close();await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId});
 try{
  assert.equal(await storage.execute('discussion.recover',{ownerId:f.owner}),1);
  const reopened=new SqliteReplyCandidateService(storage,f.owner),status=await reopened.status(contactId,discussion.id,input.requestKey);
  assert.equal(status.phase,'failed');assert.equal(status.sent,false);assert.equal(status.errorCode,'runtime_interrupted');
  const [history]=await reopened.view(contactId,discussion.id);
  assert.equal(history.generationState,'failed');assert.equal(history.generationErrorCode,'runtime_interrupted');assert.equal(history.generationSent,false);
  const http=new SqliteReplyCandidateHttp({storage,service:reopened,authorize:()=>true});
  const server=createServer((req,res)=>{void http.handle(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const response=await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussion.id}/reply-candidates`);
   assert.equal(response.status,200);const page=await response.json();
   assert.equal(page.requests[0].generationErrorCode,'runtime_interrupted');assert.equal(page.requests[0].generationSent,false);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  assert.equal(await storage.execute('discussion.recover',{ownerId:f.owner}),0);
 }finally{await storage.close();}
});

test('已发送后存储线程中断：重开后自动放弃为已发送可重试失败，原请求不重发',{timeout:10000},async t=>{
 let f;
 f=await fixture(t,{registryModule,onRequest:async()=>{
  await assert.rejects(f.storage.execute('preparationFailureTest.exit',{}),{code:'worker_failed'});
 }});
 const contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'合成已发送请求',confirmedContact:true};
 await assert.rejects(turns.generate(input),error=>!['discussion_preparation_timeout','discussion_storage_interrupted'].includes(error.code));
 assert.equal(f.requests.length,1);
 await assert.rejects(service.status(contactId,discussion.id,input.requestKey),{code:'worker_failed'},'已发送后不能使用未发送失败回执');
 await turns.close();await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId});
 try{
  await storage.execute('discussion.recover',{ownerId:f.owner});
  const reopened=new SqliteReplyCandidateService(storage,f.owner),status=await reopened.status(contactId,discussion.id,input.requestKey);
  assert.equal(status.phase,'failed');assert.equal(status.sent,true);assert.equal(status.retryable,true);assert.equal(status.errorCode,'runtime_interrupted');
  const [history]=await reopened.view(contactId,discussion.id);
  assert.equal(history.generationState,'failed');assert.equal(history.generationSent,true);assert.equal(history.generationErrorCode,'runtime_interrupted');assert.deepEqual(history.candidates,[]);
  await assert.rejects(reopened.begin({...input,identity:{kind:'manual',confirmationId:randomUUID()}}),{code:'discussion_request_stale'});
  const requestKey=randomUUID(),confirmationId=await storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
  const fresh=await reopened.begin({...input,requestKey,identity:{kind:'manual',confirmationId}});
  assert.notEqual(fresh.attempt.requestId,history.requestId);assert.equal(f.requests.length,1,'恢复与新请求受理不自动发出模型调用');
  assert.equal(await storage.execute('discussion.recover',{ownerId:f.owner}),0);assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{await storage.close();}
});
