import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pureTsFixture} from 'file:///Users/<REDACTED>/Documents/learn/NotAlone/backend-ts/test/pure-ts-runtime-fixture.mjs';
import {syntheticProvider,actualEvidenceId} from 'file:///Users/<REDACTED>/Documents/learn/NotAlone/backend-ts/test/pure-ts-provider-fixture.mjs';
import {sendEvents,useTool} from 'file:///Users/<REDACTED>/Documents/learn/NotAlone/backend-ts/test/reply-service-runtime-support.mjs';

const require=createRequire(new URL('file:///Users/<REDACTED>/Documents/learn/NotAlone/desktop/package.json',import.meta.url));
const {build}=require('esbuild');
const bundled=await build({stdin:{contents:`
 export {ContactSession} from './src/main/contacts/session';
 export {ReplySession} from './src/main/reply/session';
 export {JsonClient} from './src/main/backend/json-client';
 `,resolveDir:new URL('file:///Users/<REDACTED>/Documents/learn/NotAlone/desktop/',import.meta.url).pathname},bundle:true,platform:'node',format:'esm',write:false});
const desktop=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text+'\n//# sourceURL=assistant-publication-controller.mjs\n').toString('base64')}`);

test('纯 TS 公开异步生成完成后原生控制器直接发布，保存恢复不新增模型调用',{timeout:30000},async t=>{
 const previousMask=process.umask(0o077);t.after(()=>process.umask(previousMask));
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
 const provider=await syntheticProvider(t,async(body,res)=>{
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[1,2,3].map(n=>({text:`合成候选${n}`,basis:'本次合成草稿',citation_ids:[actualEvidenceId(body)],risk_notes:[]}))});
  sendEvents(res,events);
 });
 const app=await f.start({NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SYNTHETIC_PROVIDER_URL:provider.url});
 const port=Number(app.connection.address.split(':')[1]);
 const client=new desktop.JsonClient({...app.connection,port});
 t.after(()=>client.cancelPending());
 const trace=[];
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},subscribeMessages:()=>{},
  requestJson:async options=>{
   let response;
   try{response=await client.perform({...options,manualContactId:contact});}catch(error){trace.push({method:options.method,path:options.path,kind:error.kind,status:error.status,code:error.code});throw error;}
   trace.push({method:options.method,path:options.path,status:response.status,keys:Object.keys(response.data??{}),...(response.data?.reply?{replyKeys:Object.keys(response.data.reply)}:{})});
   return {generation:1,data:response.data};
  }};
 const contacts=new desktop.ContactSession(async()=>({generation:1,contacts:[{contactId:contact,displayName:'合成联系人',messageCount:0,sourceCount:0}]}));
 const replies=new desktop.ReplySession(contacts,backend);
 contacts.setConnection(1);await contacts.refreshContacts();
 contacts.selectContact({contactId:contact,scopeRevision:contacts.getState().scopeRevision});
 const scope={contactId:contact,scopeRevision:contacts.getState().scopeRevision};
 await replies.readSavedSession(scope);
 contacts.setDraft({...scope,text:'合成草稿'});
 await replies.generate({...scope,newRequest:true});
 const state=replies.getState();
 const stored=(await f.client.query('SELECT state FROM assistant_session_turn')).rows;
 const candidates=(await f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n;
 await replies.readSavedSession(scope);
 const restored=replies.getState();
 t.diagnostic(JSON.stringify({phase:state.phase,errorCode:state.errorCode,jobPhases:state.generationJobs?.map(job=>job.phase),stored,candidates,modelCalls:provider.requests.length,recoveredCandidates:restored.result?.candidates.length,trace}));
 assert.deepEqual(stored,[{state:'completed'}]);
 assert.equal(candidates,3);
 assert.equal(provider.requests.length,1);
 assert.equal(restored.result?.candidates.length,3);
 assert.equal(restored.savedSession?.turns.at(-1)?.state,'completed');
 assert.equal(provider.requests.length,1,'读取已保存讨论不得重新生成');
 assert.equal(state.phase,'ready','后端完成并保存候选后，本次生成必须直接发布');
 assert.equal(state.result?.candidates.length,3);
 assert.equal(state.generationJobs?.at(-1)?.phase,'completed');
});
