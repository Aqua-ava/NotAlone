import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createReplyHttp} from '../src/reply-http.ts';
import {ReplyError} from '../src/reply-contract.ts';
import {parseJson} from '../src/host-json.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
async function setup(t){
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token='synthetic-private-token-'.repeat(3);
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 const calls=[];let reads=0;
 const service={prepare:async(...args)=>{calls.push(['prepare',...args]);return {receipt:{synthetic:true}};},generate:async(...args)=>{calls.push(['generate',...args]);return {synthetic:true,revision:9007199254740993n};}};
 const handler=createReplyHttp({ownerId:owner,token,read:async fn=>{reads++;return fn(f.client);},service});
 const server=createServer((req,res)=>{void handler.handle(req,res).then(handled=>{if(!handled)res.writeHead(404).end();},()=>{res.writeHead(500).end();});});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();});
 const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding};
 const payload=()=>({verified_scope:scope,request:{contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:'合成原稿'}},internal:{}});
 function send(body=payload(),headers={},path='/internal/reply/generate',method='POST',headersOnly=false){
  const encoded=typeof body==='string'?body:JSON.stringify(body);
  return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path,method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded),...headers}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>{resolve({status:res.statusCode,text,body:parseJson(text)});if(headersOnly)req.destroy();});});req.on('error',reject);if(headersOnly)req.flushHeaders();else req.end(encoded);});
 }
 // 早拒绝必须在正文尚未发送时完成，避免大上传与主动关连接相互竞速。
 const sendHeaders=(length,headers={})=>send('',{'Content-Length':length,...headers},'/internal/reply/generate','POST',true);
 return {f,owner,contact,binding,token,scope,payload,send,sendHeaders,server,calls,service,get reads(){return reads;}};
}
test('认证先于正文/DB，固定owner及严格envelope；1MiB与路径边界',async t=>{
 const x=await setup(t);
 assert.equal((await x.send('{', {Authorization:'Bearer public-token'})).status,401);assert.equal(x.reads,0);
 assert.equal((await x.sendHeaders(1024*1024+1,{Authorization:'Bearer wrong'})).status,401);assert.equal(x.reads,0);
 assert.equal((await x.send(x.payload(),{Origin:'http://synthetic.invalid'})).status,401);
 assert.equal((await x.send('{')).status,400);assert.equal(x.reads,0);
 assert.equal((await x.sendHeaders(1024*1024+1)).status,413);assert.equal(x.reads,0);
 for(const mutate of [p=>p.verified_scope.owner_id=randomUUID(),p=>p.verified_scope.confirmation='desktop',p=>p.request.continuation={},p=>p.internal.history_message_ids=[],p=>p.request.contact_id=randomUUID()]){
  const p=structuredClone(x.payload());mutate(p);assert.equal((await x.send(p)).status,400);
 }
 assert.equal(x.reads,0);assert.equal(x.calls.length,0);
 assert.equal((await x.send(x.payload(),{},'/internal/reply/generate?trusted=true')).status,404);
 assert.throws(()=>createReplyHttp({ownerId:x.owner,token:'short',read:async()=>{},service:x.service}),/config_invalid/);
});
test('真实PG唯一manual/desktop分类、scope回显、bigint整数无损与身份冲突拒绝',async t=>{
 const x=await setup(t),c=x.f.client;
 assert.equal((await x.send()).status,409);assert.equal(x.calls.length,0);
 await c.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[x.binding,x.owner,x.contact]);
 const prepared=await x.send(x.payload(),{},'/internal/reply/prepare');assert.equal(prepared.status,200);assert.deepEqual(prepared.body,{verified_scope:x.scope,prepared:true,receipt:{synthetic:true}});assert.equal(x.calls.at(-1)[1].confirmation,'manual');
 const validPrepare=x.service.prepare;x.service.prepare=async()=>undefined;assert.equal((await x.send(x.payload(),{},'/internal/reply/prepare')).status,503);x.service.prepare=validPrepare;
 await c.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator)VALUES($1,$2,$3,'wechat','synthetic','synthetic-contact')",[x.binding,x.owner,x.contact]);
 const count=x.calls.length;assert.equal((await x.send()).status,409);assert.equal(x.calls.length,count);
 await c.query('DELETE FROM manual_contact_confirmation WHERE id=$1',[x.binding]);
 const generated=await x.send();assert.equal(generated.status,200);assert.deepEqual(generated.body.verified_scope,x.scope);assert.equal(generated.body.reply.revision,9007199254740993n);assert.match(generated.text,/:9007199254740993/);assert.equal(x.calls.at(-1)[1].confirmation,'desktop');
 await c.query("UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE id=$1",[x.binding]);assert.equal((await x.send()).status,409);
});
test('可信续写只走私有internal；错误脱敏，真实DTO预算错误按白名单返回',async t=>{
 const x=await setup(t);await x.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[x.binding,x.owner,x.contact]);
 const p=x.payload(),candidate=randomUUID();p.request.continued_from_candidate_id=candidate;p.internal.authenticatedContinuation={continuation:{version:1},continuation_reference:{candidate_id:candidate,version_id:randomUUID(),messages:[{message_id:randomUUID(),text:'合成已选候选'}]}};
 assert.equal((await x.send(p)).status,200);assert.deepEqual(x.calls.at(-1)[4],p.internal);assert.equal(x.calls.at(-1)[2].continuation,undefined);
 x.service.generate=async()=>{throw new Error('secret-synthetic-provider-response');};assert.deepEqual((await x.send()).body,{error:'reply_remote_unavailable'});
 x.service.generate=async()=>{throw new ReplyError('reply_input_invalidated',409);};assert.equal((await x.send()).status,409);
 const b={state:'exceeded',allowed:false,model_id:'synthetic',context_window_tokens:100,input_tokens:100,output_reserve_tokens:20,total_tokens:130,measurement_kind:'approximate',measurement_id:'synthetic-v1',reason:null,safety_margin_tokens:10};
 x.service.generate=async()=>{throw Object.assign(new ReplyError('input_budget_exceeded',409),{input_budget:b});};assert.deepEqual((await x.send()).body,{error:'input_budget_exceeded',input_budget:b});
 x.service.generate=async()=>{throw Object.assign(new ReplyError('input_budget_exceeded',409),{input_budget:{...b,messages:'合成正文不可泄漏'}});};assert.deepEqual((await x.send()).body,{error:'reply_remote_unavailable'});
});
test('私有累计续写在认证及internal形状通过后接受完整要求，公开与不匹配值拒绝',async t=>{
 const x=await setup(t);await x.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[x.binding,x.owner,x.contact]);
 const requirements=['甲'.repeat(4000),'乙'.repeat(4000),'丙'.repeat(4000)],p=x.payload();
 p.request.content={type:'initiate_conversation',purpose:'合成问候',purpose_source:'direct_input',user_instruction:requirements.join('；')};
 p.internal.authenticatedContinuation={continuation:{version:1,scope:'this_assistant_session_only',candidate_id:null,version_id:null,effective_requirements:requirements},continuation_reference:null};
 assert.equal((await x.send(p,{Authorization:'Bearer wrong'})).status,401);assert.equal(x.calls.length,0);assert.equal(x.reads,0);
 for(const path of ['/internal/reply/prepare','/internal/reply/generate'])assert.equal((await x.send(p,{},path)).status,200);
 assert.equal(x.calls.length,2);assert.equal(x.calls[0][2].content.user_instruction.length,12002);assert.deepEqual(x.calls[0][4],p.internal);
 for(const mutate of [
  input=>input.internal={},
  input=>input.request.continuation=input.internal.authenticatedContinuation.continuation,
  input=>input.internal.authenticatedContinuation.continuation.effective_requirements.reverse(),
  input=>input.request.content.user_instruction+=' ',
  input=>input.internal.authenticatedContinuation.continuation=[],
  input=>input.internal.authenticatedContinuation.extra='合成伪造',
 ]){const invalid=structuredClone(p);mutate(invalid);assert.equal((await x.send(invalid)).status,400);}
 assert.equal(x.calls.length,2);assert.equal(x.reads,2);
});
test('实际HTTP断开触发传入service的AbortSignal，不额外调用或重试',{timeout:10000},async t=>{
 const x=await setup(t);await x.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[x.binding,x.owner,x.contact]);
 let enter,observed;const entered=new Promise(r=>enter=r),aborted=new Promise(r=>observed=r);let invocations=0;
 x.service.generate=async(_scope,_body,signal)=>{invocations++;enter();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{observed();reject(new Error('cancelled'));},{once:true}));};
 const bytes=JSON.stringify(x.payload());const req=request({host:'127.0.0.1',port:x.server.address().port,path:'/internal/reply/generate',method:'POST',headers:{Authorization:`Bearer ${x.token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}});req.on('error',()=>{});req.end(bytes);
 await entered;req.destroy();await aborted;assert.equal(invocations,1);
});

test('业务错误code和scope reason稳定透传；未知拒绝原因不捏造',async t=>{
 const x=await setup(t);await x.f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[x.binding,x.owner,x.contact]);
 for(const code of ['reply_context_invalidated','reply_context_unavailable','exploration_stale','exploration_expired','reply_cancelled','runtime_stopping','provider_context_limit','reply_budget_exceeded','reply_budget_unavailable','reply_persistence_unavailable']){
  x.service.generate=async()=>{throw new ReplyError(code,409);};assert.deepEqual((await x.send()).body,{error:code});
 }
 for(const reason of ['scope_mismatch','no_active_binding','manual_contact_unconfirmed','invalid_verification','history_sync_pending','history_incomplete_confirmation_required']){
  x.service.generate=async()=>{throw Object.assign(new ReplyError('reply_rejected',409),{reason});};assert.deepEqual((await x.send()).body,{error:'reply_rejected',reason});
 }
 for(const reason of [undefined,'secret-synthetic-unknown',13]){
  x.service.generate=async()=>{throw Object.assign(new ReplyError('reply_rejected',409),{reason});};assert.deepEqual((await x.send()).body,{error:'reply_remote_unavailable'});
 }
});
