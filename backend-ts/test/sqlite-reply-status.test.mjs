import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyCandidateHttp} from '../src/reply/sqlite/candidates/http.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

test('候选轻量状态只核对当前联系人请求，未接纳和准备中均不生成正文',async t=>{
 const f=await fixture(t,{synchronizeHistory:false}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),requestKey=randomUUID();
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service,authorize:req=>req.headers.authorization==='Bearer synthetic'});
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussion.id}/reply-candidates/status?request_key=${requestKey}`;
 assert.equal((await fetch(url)).status,401);
 const read=async target=>{const response=await fetch(target??url,{headers:{authorization:'Bearer synthetic'}});return {status:response.status,body:await response.json()};};
 const missing=await read();assert.equal(missing.status,200);assert.equal(missing.body.phase,'not_found');assert.equal(missing.body.retryable,false);
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 await service.begin({contactId,discussionId:discussion.id,requestKey,text:'合成表达要求',identity:{kind:'manual',confirmationId}});
 const preparing=await read();assert.equal(preparing.body.phase,'preparing');assert.equal(preparing.body.sent,false);assert.equal(preparing.body.requestKey,requestKey);assert.equal(preparing.body.retryable,false);
 assert.equal((await read(url+'&owner_id='+f.owner)).status,400);
 assert.equal((await read(url.replace(contactId,f.ids[1]))).status,409);
 assert.equal(f.requests.length,0);assert.equal(JSON.stringify(preparing.body).includes('合成表达要求'),false);
});

test('准备阶段明确未发送的失败可由用户新请求重试，旧请求核对不重发',async t=>{
 let stop=true;const f=await fixture(t,{content:JSON.stringify({candidates:[{parts:['新请求的合成候选'],basis:[1]}]}),runtimeFault:point=>{if(stop&&point==='afterIdentity'){stop=false;throw new StorageFailure('history_source_not_available');}}});
 const contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'合成准备请求',confirmedContact:true};
 await assert.rejects(turns.generate(input),{code:'history_source_not_available'});
 const failed=await service.status(contactId,discussion.id,input.requestKey);
 assert.equal(failed.phase,'failed');assert.equal(failed.sent,false);assert.equal(failed.retryable,true);assert.equal(failed.errorCode,'history_source_not_available');assert.equal(f.requests.length,0);
 await assert.rejects(turns.generate(input),{code:'discussion_request_stale'});assert.equal(f.requests.length,0);
 const requestKey=randomUUID();await turns.generate({...input,requestKey});
 assert.equal((await service.status(contactId,discussion.id,requestKey)).phase,'committed');assert.equal(f.requests.length,1);
});

test('已出站后超时保留真实原因与未知状态，状态核对不能重新发送',async t=>{
 const entered=Promise.withResolvers(),f=await fixture(t,{onRequest:async()=>{entered.resolve();return true;}}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,model:{...f.model,deadline_ms:500},service,authorize:async()=>{}});t.after(()=>turns.close());
 const requestKey=randomUUID(),pending=turns.generate({contactId,discussionId:discussion.id,requestKey,text:'合成超时请求',confirmedContact:true});
 const failed=assert.rejects(pending,{code:'discussion_generation_timeout'});
 await entered.promise;const running=await service.status(contactId,discussion.id,requestKey);
 assert.equal(running.phase,'generating');assert.equal(running.sent,true);assert.equal(running.retryable,false);
 await failed;const unknown=await service.status(contactId,discussion.id,requestKey);
 assert.equal(unknown.phase,'unknown');assert.equal(unknown.sent,true);assert.equal(unknown.retryable,false);assert.equal(unknown.errorCode,'discussion_generation_timeout');
 await service.status(contactId,discussion.id,requestKey);assert.equal(f.requests.length,1);
});
