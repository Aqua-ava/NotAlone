/** 真实官方profile/HTTP/PG核对宿主回复装配，模型只替换为本地SSE端点。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';

function evidenceId(body){
  let result;
  const visit=value=>{
    if(Array.isArray(value)){for(const item of value)visit(item);return;}
    if(value&&typeof value==='object'){if(Array.isArray(value.evidence)&&value.evidence.length)result??=value.evidence[0].evidence_id;for(const item of Object.values(value))visit(item);return;}
    if(typeof value==='string'){try{visit(JSON.parse(value));}catch{const begin=value.indexOf('{'),end=value.lastIndexOf('}');if(begin>=0&&end>begin){try{visit(JSON.parse(value.slice(begin,end+1)));}catch{}}}}
  };
  visit(body);assert.ok(result,'只能使用实际官方请求包含的证据');return result;
}

test('宿主回复装配：独立鉴权、原UUID重放、关闭取消实际stream并排空',{timeout:60000},async t=>{
  const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token=randomUUID()+randomUUID();
  let host,fixtureClosing;
  const closeFixture=()=>fixtureClosing??=f.close();
  t.after(async()=>{if(host)await host.stop();await closeFixture();});
  assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') AS table_name")).rows[0].table_name,'model_call_receipt','收据必须由正式migrator创建');
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成装配本人')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
  let late=false,entered,releaseLate;
  const began=new Promise(resolve=>{entered=resolve;});
  host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:closeFixture},(_req,res,requests,events)=>{
    const id=evidenceId(requests.at(-1).body);
    useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次原句',citation_ids:[id],risk_notes:[]}]});
    if(late){releaseLate=()=>sendEvents(res,events);entered();return;}
    sendEvents(res,events);
  },{pluginPath:'test/host-reply-runtime-plugin.ts'});
  const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding};
  const request=()=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'draft',draft_text:'明天见',include_relationship_context:false},skill_disabled:true});
  async function generate(body,auth=token){const response=await fetch(host.url+'/internal/reply/generate',{method:'POST',headers:{Authorization:`Bearer ${auth}`,'content-type':'application/json'},body:JSON.stringify({verified_scope:scope,request:body,internal:{}})});return {status:response.status,body:await response.json()};}
  const invalid=await generate(request(),'synthetic-public-token');assert.equal(invalid.status,401);assert.equal(host.requests.length,0);
  const firstRequest=request(),first=await generate(firstRequest);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.reply.candidates[0].text,'明天见');
  const again=await generate(firstRequest);assert.equal(again.status,200);assert.deepEqual(again.body,first.body);assert.equal(host.requests.length,1);
  late=true;const lateRequest=request(),inFlight=generate(lateRequest);
  await Promise.race([began,inFlight.then(value=>{throw Error('取消前意外完成：'+value.status);})]);
  const closed=await host.request('/close-reply',{});assert.equal(closed.closed,true);assert.equal(closed.permits.foregroundActive,false);
  const cancelled=await inFlight;assert.equal(cancelled.status,409);assert.equal(cancelled.body.error,'reply_cancelled');
  releaseLate();
  const rows=(await f.client.query('SELECT outcome,dispatch,input_tokens,cost_amount FROM model_call_receipt ORDER BY created_at')).rows;
  // 本机SDK已取消并退出；未收到响应时仍不声称发送确认、已知用量或费用。
  assert.equal(rows.length,2);assert.equal(rows[0].outcome,'succeeded');assert.equal(rows[1].outcome,'cancelled');assert.equal(rows[1].dispatch,'authorized_unconfirmed');assert.equal(rows[1].input_tokens,null);assert.equal(rows[1].cost_amount,null);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_candidate c JOIN reply_request r ON r.id=c.reply_request_id WHERE r.idempotency_key=$1',[lateRequest.idempotency_key])).rows[0].n,0);
  const after=await generate(request());assert.equal(after.status,503);assert.equal(after.body.error,'reply_remote_unavailable');assert.equal(host.requests.length,2);
});
