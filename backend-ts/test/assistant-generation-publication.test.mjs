import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
import {syntheticProvider,actualEvidenceId} from './pure-ts-provider-fixture.mjs';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';

const require=createRequire(new URL('../../desktop/package.json',import.meta.url));
const {build}=require('esbuild');
const bundled=await build({stdin:{contents:`
 export {ContactSession} from './src/main/contacts/session';
 export {ReplySession} from './src/main/reply/session';
 export {JsonClient,BackendRequestFailure} from './src/main/backend/json-client';
 `,resolveDir:new URL('../../desktop/',import.meta.url).pathname},bundle:true,platform:'node',format:'esm',write:false});
const desktop=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text+'\n//# sourceURL=assistant-publication-controller.mjs\n').toString('base64')}`);

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

// 只启动自有合成 PG、正式 TS 宿主与回环供应商；原生控制器不启动 Electron。
async function publicationFixture(t,{holdModel=false}={}){
 const previousMask=process.umask(0o077);t.after(()=>process.umask(previousMask));
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),otherContact=holdModel?randomUUID():null;
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 if(otherContact){
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'另一合成联系人')",[otherContact,owner]);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[randomUUID(),owner,otherContact]);
 }
 const provider=await syntheticProvider(t,async(body,res)=>{
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[1,2,3].map(n=>({text:`合成候选${n}`,basis:'本次合成草稿',citation_ids:[actualEvidenceId(body)],risk_notes:[]}))});
  entered.resolve();if(holdModel)await release.promise;
  sendEvents(res,events);
 });
 const app=await f.start({NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SYNTHETIC_PROVIDER_URL:provider.url});
 const port=Number(app.connection.address.split(':')[1]);
 const client=new desktop.JsonClient({...app.connection,port});
 t.after(()=>client.cancelPending());
 const trace=[],delivery={};
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},subscribeMessages:()=>{},
  requestJson:async options=>{
   let response;
   try{response=await client.perform({...options,manualContactId:options.path.split('/')[3]});}catch(error){trace.push({method:options.method,path:options.path,kind:error.kind,status:error.status,code:error.code});throw error;}
   trace.push({method:options.method,path:options.path,status:response.status,asyncPreparation:options.asyncPreparation===true,keys:Object.keys(response.data??{})});
   await delivery.after?.(options,response);
   return {generation:1,data:response.data};
  }};
 const contacts=new desktop.ContactSession(async()=>({generation:1,contacts:[contact,otherContact].filter(Boolean).map(contactId=>({contactId,displayName:'合成联系人',messageCount:0,sourceCount:0}))}));
 const replies=new desktop.ReplySession(contacts,backend);
 contacts.setConnection(1);await contacts.refreshContacts();
 const connect=async(contactId=contact)=>{
  contacts.selectContact({contactId,scopeRevision:contacts.getState().scopeRevision});
  const scope={contactId,scopeRevision:contacts.getState().scopeRevision};await replies.readSavedSession(scope);return scope;
 };
 const scope=await connect();
 contacts.setDraft({...scope,text:'合成草稿'});
 return {f,app,provider,owner,contact,otherContact,scope,client,backend,contacts,replies,connect,trace,delivery,entered:entered.promise,release:()=>release.resolve()};
}

test('纯 TS 公开异步生成完成后原生控制器直接发布，保存恢复不新增模型调用',{timeout:30000},async t=>{
 const x=await publicationFixture(t);
 await x.replies.generate({...x.scope,newRequest:true});
 const state=x.replies.getState();
 const stored=(await x.f.client.query('SELECT state FROM assistant_session_turn')).rows;
 const candidates=(await x.f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n;
 await x.replies.readSavedSession(x.scope);const restored=x.replies.getState();
 t.diagnostic(JSON.stringify({phase:state.phase,errorCode:state.errorCode,jobPhases:state.generationJobs?.map(job=>job.phase),stored,candidates,modelCalls:x.provider.requests.length,recoveredCandidates:restored.result?.candidates.length}));
 assert.deepEqual(stored,[{state:'completed'}]);
 assert.equal(candidates,3);
 assert.equal(x.provider.requests.length,1);
 assert.equal(restored.result?.candidates.length,3);
 assert.equal(restored.savedSession?.turns.at(-1)?.state,'completed');
 assert.equal(x.provider.requests.length,1,'读取已保存讨论不得重新生成');
 assert.equal(state.phase,'ready','后端完成并保存候选后，本次生成必须直接发布');
 assert.equal(state.result?.candidates.length,3);
 assert.equal(state.generationJobs?.at(-1)?.phase,'completed');
 assert.ok(x.trace.some(item=>item.path.endsWith('/prepare')&&item.asyncPreparation));
 assert.deepEqual(restored.result?.candidates.map(item=>item.candidateId),state.result?.candidates.map(item=>item.candidateId));
});

for(const fault of ['lost-response','wrong-session'])test(`公开完成回执${fault}仍保留未确认身份，明确读取原保存结果后恢复`,{timeout:30000},async t=>{
 const x=await publicationFixture(t);
 x.delivery.after=(options,response)=>{
  if(!options.path.endsWith('/replies'))return;
  if(fault==='lost-response')throw new desktop.BackendRequestFailure('connection');
  response.data={...response.data,session_id:randomUUID()};
 };
 await x.replies.generate({...x.scope,newRequest:true});
 const uncertain=x.replies.getState();
 assert.equal(uncertain.phase,'failed');assert.equal(uncertain.result,null);
 assert.equal(uncertain.generationJobs.at(-1).phase,'unconfirmed');
 assert.equal((await x.f.client.query('SELECT state FROM assistant_session_turn')).rows[0].state,'completed');
 await x.replies.readSavedSession(x.scope);
 assert.equal(x.replies.getState().result?.candidates.length,3);
 assert.equal(x.replies.getState().generationJobs.at(-1).phase,'completed');
 assert.equal(x.provider.requests.length,1);
});

test('生成中切换联系人后晚结果仅属于原会话，切回读取不重新生成',{timeout:30000},async t=>{
 const x=await publicationFixture(t,{holdModel:true});
 const running=x.replies.generate({...x.scope,newRequest:true});
 try{
  await x.entered;await x.connect(x.otherContact);x.release();await running;
  const other=x.replies.getState();assert.equal(other.contactId,x.otherContact);assert.equal(other.result,null);
  await x.connect();const restored=x.replies.getState();
  assert.equal(restored.contactId,x.contact);assert.equal(restored.result?.candidates.length,3);
  assert.equal(restored.generationJobs.at(-1).phase,'completed');assert.equal(x.provider.requests.length,1);
 }finally{x.release();await running;}
});

for(const idle of [false,true])test(`公开异步准备${idle?'空闲分段后':'同段内'}的接纳与查询保留受理身份，取消不发布完成候选`,{timeout:30000},async t=>{
 const x=await publicationFixture(t);
 assert.equal(x.replies.getState().savedSession.sessionId,null,'读取空目录不隐式创建会话');
 const created=await x.app.request(`/api/contacts/${x.contact}/assistant-sessions`,{},'POST',x.app.connection.token,{'X-NotAlone-Manual-Contact':x.contact});
 assert.equal(created.status,200);assert.match(created.data.session_id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 const session=created.data.session_id;
 if(idle)await x.f.client.query("UPDATE assistant_session SET last_user_activity_at=clock_timestamp()-interval '13 hours' WHERE owner_id=$1 AND contact_id=$2 AND id=$3",[x.owner,x.contact,session]);
 const path=`/api/contacts/${x.contact}/assistant-sessions/${session}`;
 const body={contact_id:x.contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:'合成草稿',include_relationship_context:false},skill_disabled:true};
 const accepted=await x.app.request(`${path}/replies/prepare`,body,'POST',x.app.connection.token,{Prefer:'respond-async','X-NotAlone-Manual-Contact':x.contact});
 assert.equal(accepted.status,202);assert.deepEqual(Object.keys(accepted.data).sort(),['preparation_id','state']);assert.equal(accepted.data.state,'preparing');
 const prepared=await x.client.perform({method:'POST',path:`${path}/replies/prepare`,body,asyncPreparation:true,manualContactId:x.contact});
 const queried=await x.client.perform({method:'GET',path:`${path}/replies/prepare/status/${accepted.data.preparation_id}`,manualContactId:x.contact});
 assert.equal(queried.status,200);assert.deepEqual(queried,prepared);
 assert.deepEqual(Object.keys(queried.data).sort(),['input_version_id',...(idle?['previous_session_id']:[]),'request_key','session_id','state','turn_id']);
 assert.equal(queried.data.request_key,body.idempotency_key);
 if(idle){assert.equal(queried.data.previous_session_id,session);assert.notEqual(queried.data.session_id,session);}
 else assert.equal(queried.data.session_id,session);
 const interrupted=await x.app.request(`${path}/interrupt`,{request_key:body.idempotency_key,input_version_id:prepared.data.input_version_id,reason:'user_cancelled'},'POST',x.app.connection.token,{'X-NotAlone-Manual-Contact':x.contact});
 assert.equal(interrupted.status,200);assert.equal(interrupted.data.state,'failed');assert.equal(interrupted.data.interruption_reason,'user_cancelled');
 assert.equal(x.provider.requests.length,0);
});
