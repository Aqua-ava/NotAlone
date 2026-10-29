import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
const output=await build({stdin:{contents:"export {ContactSession} from './src/main/contacts/session';export {ReplySession} from './src/main/reply/session';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {ContactSession,ReplySession}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('既有ReplySession来源失效同步擦除实际发言快照，旧快照不能继续持有正文',async t=>{
 const contactId=randomUUID(),sessionId=randomUUID(),requestId=randomUUID(),body='必须从旧快照撤下的合成发言';
 let messageGate;
 const backend={getConnectionGeneration:()=>7,onStateChanged:()=>()=>{},subscribeMessages:()=>{},requestJson:async request=>{
  let data;
  if(request.path.startsWith('/api/deletions?'))data={operations:[]};
  else if(request.path.endsWith('/assistant-sessions'))data={sessions:[{session_id:sessionId,is_current:true}],current_session_id:sessionId};
  else if(request.path.endsWith('/assistant-session/default'))data={session_id:sessionId};
  else if(request.path.endsWith('/assistant-session/binding'))data={confirmed:true};
  else if(request.path.includes('/messages?')){if(messageGate)await messageGate;data={messages:[],next_cursor:null};}
  else if(request.path.endsWith('/assistant-sessions/'+sessionId)){
   data={mode:'sqlite',session_id:sessionId,runtime_recovery:'ready',entries:[{entry_id:randomUUID(),position:'1',role:'user',text:body,request_id:requestId,call_id:null,content_state:'available'}]};
  }else throw new Error('未安排的合成端口');return {generation:7,data};
 }};
 const contacts=new ContactSession(async()=>({generation:7,contacts:[{contactId,displayName:'合成联系人',messageCount:0,sourceCount:0}]}));
 contacts.setConnection(7);await contacts.refreshContacts();const session=new ReplySession(contacts,backend);t.after(()=>contacts.setConnection(undefined));
 contacts.selectContact({contactId,scopeRevision:contacts.getState().scopeRevision});const scope={contactId,scopeRevision:contacts.getState().scopeRevision};
 await session.readSavedSession(scope);assert.equal(session.getState().savedSession.discussionEntries[0].text,body);
 const release=Promise.withResolvers();messageGate=release.promise;
 const invalidating=session.revalidateDeletedSource(contactId);
 assert.equal(JSON.stringify(session.getState()).includes(body),false);
 release.resolve();await invalidating;assert.equal(JSON.stringify(session.getState()).includes(body),false);
});
