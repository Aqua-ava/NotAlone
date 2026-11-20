import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {sqliteAssistantFixture} from './fixtures/sqlite-assistant-session.mjs';
const output=await build({stdin:{contents:"export {ContactSession} from './src/main/contacts/session';export {ReplySession} from './src/main/reply/session';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {ContactSession,ReplySession}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('SQLite讨论切换甲乙再回甲不读取旧候选选择端口，独立草稿仍按原联系人恢复',async t=>{
 const contactIds=[randomUUID(),randomUUID()],sessionIds=contactIds.map(()=>randomUUID()),requests=[],emptySessions=new Set();
 const backend={getConnectionGeneration:()=>7,onStateChanged:()=>()=>{},subscribeMessages:()=>{},requestJson:async request=>{
  requests.push(request.path);const index=contactIds.findIndex(id=>request.path.includes(id));let data;
  if(request.path.startsWith('/api/deletions?'))data={operations:[]};
  else if(request.path.endsWith('/assistant-sessions')&&request.method==='POST'){sessionIds[index]=randomUUID();emptySessions.add(sessionIds[index]);data={session_id:sessionIds[index]};}
  else if(request.path.endsWith('/assistant-sessions'))data={sessions:[{session_id:sessionIds[index],is_current:true}],current_session_id:sessionIds[index]};
  else if(request.path.endsWith('/continue'))data={session_id:sessionIds[index]};
  else if(request.path.endsWith('/assistant-session/binding'))data={confirmed:true};
  else if(request.path.includes('/history-messages?'))data={messages:[],next_cursor:null};
  else if(request.path.endsWith('/assistant-sessions/'+sessionIds[index]))data={mode:'sqlite',session_id:sessionIds[index],runtime_recovery:'ready',entries:emptySessions.has(sessionIds[index])?[]:[
   {entry_id:randomUUID(),position:'1',role:'user',text:index===0?'合成甲用户发言':'合成乙用户发言',request_id:randomUUID(),call_id:null,content_state:'available'}]};
  else throw new Error('SQLite讨论不提供旧候选选择端口');
  return {generation:7,data};
 }};
 const contacts=new ContactSession(async()=>({generation:7,contacts:contactIds.map((contactId,index)=>({contactId,displayName:'合成联系人'+index,messageCount:0,sourceCount:0}))}));
 contacts.setConnection(7);await contacts.refreshContacts();const session=new ReplySession(contacts,backend);t.after(()=>contacts.setConnection(undefined));
 const select=async index=>{contacts.selectContact({contactId:contactIds[index],scopeRevision:contacts.getState().scopeRevision});await session.readSavedSession({contactId:contactIds[index],scopeRevision:contacts.getState().scopeRevision});};
 await select(0);contacts.setDraft({contactId:contactIds[0],scopeRevision:contacts.getState().scopeRevision,text:'甲的独立合成草稿'});
 await select(1);assert.equal(session.getState().savedSession.discussionEntries[0].text,'合成乙用户发言');
 await select(0);assert.equal(session.getState().savedSession.phase,'ready');assert.equal(session.getState().savedSession.discussionEntries[0].text,'合成甲用户发言');
 assert.equal(contacts.getState().draft,'甲的独立合成草稿');
 const scope={contactId:contactIds[0],scopeRevision:contacts.getState().scopeRevision};
 await session.viewSavedSession({...scope,sessionId:sessionIds[0]});assert.equal(session.getState().savedSession.phase,'ready');
 await session.resumeSavedSession({...scope,sessionId:sessionIds[0]});assert.equal(session.getState().sessionCatalog.selectionPending,false);
 await session.newSavedSession(scope);assert.equal(session.getState().savedSession.phase,'ready');assert.deepEqual(session.getState().savedSession.discussionEntries,[]);
 assert.equal(session.getState().sessionCatalog.selectionPending,false);assert.equal(requests.some(path=>path.endsWith('/selections')),false);
});

async function helperFixture(t){
 const contactId=randomUUID(),otherContactId=randomUUID(),sessionId=randomUUID(),entryId=randomUUID(),requestId=randomUUID(),listeners=new Set();
 let generation=7,discussionReads=0,discussionGate;
 let body='同一范围已核验的合成发言';
 const backend={getConnectionGeneration:()=>generation,onStateChanged:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},subscribeMessages:()=>{},requestJson:async request=>{
  let data;
  if(request.path.startsWith('/api/deletions?'))data={operations:[]};
  else if(request.path.endsWith('/assistant-sessions'))data={sessions:[{session_id:sessionId,is_current:true}],current_session_id:sessionId};
  else if(request.path.endsWith('/assistant-session/default'))data={session_id:sessionId};
  else if(request.path.endsWith('/assistant-session/binding'))data={confirmed:true};
  else if(request.path.includes('/history-messages?'))data={messages:[],next_cursor:null};
  else if(request.path.endsWith('/assistant-sessions/'+sessionId)){
   ++discussionReads;const heldGeneration=generation,heldBody=body;const gate=discussionGate;discussionGate=undefined;if(gate)await gate;
   return {generation:heldGeneration,data:{mode:'sqlite',session_id:sessionId,runtime_recovery:'ready',entries:[{entry_id:entryId,position:'1',role:'user',text:heldBody,request_id:requestId,call_id:null,content_state:'available'}]}};
  }else throw new Error('未安排的合成端口');return {generation,data};
 }};
 const contacts=new ContactSession(async()=>({generation,contacts:[contactId,otherContactId].map(id=>({contactId:id,displayName:'合成联系人',messageCount:0,sourceCount:0}))}));
 contacts.setConnection(7);await contacts.refreshContacts();const session=new ReplySession(contacts,backend);t.after(()=>contacts.setConnection(undefined));
 contacts.selectContact({contactId,scopeRevision:contacts.getState().scopeRevision});
 await session.readSavedSession({contactId,scopeRevision:contacts.getState().scopeRevision});
 return {session,contacts,contactId,otherContactId,body,setBody(text){body=text;},get reads(){return discussionReads;},hold(){const gate=Promise.withResolvers();discussionGate=gate.promise;t.after(()=>gate.resolve());return gate;},disconnect(){generation=undefined;for(const listener of listeners)listener();}};
}

test('小窗同范围重新聚焦保留已核验讨论，恢复读取在后台且不重复启动',async t=>{
 const f=await helperFixture(t),seen=[];f.session.onStateChanged(state=>seen.push(state));
 const gate=f.hold(),before=f.reads;
 f.session.notifyHelperLifecycle('hidden');f.session.notifyHelperLifecycle('focused');
 assert.equal(f.reads,before+1,'仍通过正式端口恢复讨论和任务');
 assert.equal(f.session.getState().savedSession.phase,'ready');
 assert.equal(f.session.getState().savedSession.discussionEntries[0].text,f.body);
 f.session.notifyHelperLifecycle('focused');assert.equal(f.reads,before+1);
 const finished=Promise.withResolvers();const off=f.session.onStateChanged(state=>{
  if(state.savedSession?.phase==='ready'&&state.savedSession.discussionEntries?.[0]?.text===f.body)finished.resolve();
 });t.after(off);gate.resolve();await finished.promise;
 assert.ok(seen.every(state=>state.savedSession?.phase==='ready'));
});

test('小窗后台恢复期间连接、联系人或聊天清空立即清除，迟到读取不能复活正文',async t=>{
 for(const boundary of ['connection','contact','history-clear']){
  const f=await helperFixture(t),gate=f.hold();
  f.session.notifyHelperLifecycle('hidden');f.session.notifyHelperLifecycle('focused');
  assert.equal(f.session.getState().savedSession.discussionEntries?.[0]?.text,f.body);
  if(boundary==='connection')f.disconnect();else if(boundary==='contact')f.contacts.selectContact({contactId:f.otherContactId,scopeRevision:f.contacts.getState().scopeRevision});else f.session.beginHistoryClear();
  assert.equal(JSON.stringify(f.session.getState()).includes(f.body),false,boundary);
  gate.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(JSON.stringify(f.session.getState()).includes(f.body),false,boundary);
 }
});

test('小窗后台核验失败撤下已展示讨论，不把旧快照继续当作核验成功',async t=>{
 const f=await helperFixture(t),gate=f.hold(),failed=Promise.withResolvers();
 const off=f.session.onStateChanged(state=>{if(state.savedSession?.phase==='failed')failed.resolve();});t.after(off);
 f.session.notifyHelperLifecycle('hidden');f.session.notifyHelperLifecycle('focused');
 assert.equal(f.session.getState().savedSession.discussionEntries[0].text,f.body);
 gate.reject(new Error('合成读取失败'));await failed.promise;
 assert.equal(JSON.stringify(f.session.getState()).includes(f.body),false);
});

for (const outcome of ['success', 'failure']) {
 test(`同一范围新读取接管后，忽略取消的旧读取${outcome==='success'?'成功':'失败'}不能覆盖新讨论`, {timeout:5000}, async t=>{
  const f=await helperFixture(t),gate=f.hold();
  const scope={contactId:f.contactId,scopeRevision:f.contacts.getState().scopeRevision};
  const old=f.session.readSavedSession(scope,true);
  const body='新读取已核验的合成讨论';f.setBody(body);
  await f.session.readSavedSession(scope,true);
  assert.equal(f.session.getState().savedSession.discussionEntries[0].text,body);
  const revision=f.session.getState().revision;
  if(outcome==='success')gate.resolve();else gate.reject(new Error('旧请求迟到失败'));
  await old;
  assert.equal(f.session.getState().revision,revision,'旧请求不能发布快照或失败状态');
  assert.equal(f.session.getState().savedSession.phase,'ready');
  assert.equal(f.session.getState().savedSession.discussionEntries[0].text,body);
 });
}

for (const outcome of ['success', 'failure']) {
 test(`回看另一会话后，旧后台读取迟到${outcome==='success'?'成功':'失败'}不能恢复原会话`, {timeout:5000}, async t=>{
  const f=await sqliteAssistantFixture(t),otherSessionId=randomUUID();
  f.control.sessions.push(otherSessionId);f.entries.set(otherSessionId,[]);
  const gate={entered:Promise.withResolvers(),release:Promise.withResolvers()};
  t.after(()=>gate.release.resolve());f.control.readGate=gate;
  const old=f.replies.readSavedSession(f.scope(),true);await gate.entered.promise;
  await f.bridge.viewSavedSession({...f.scope(),sessionId:otherSessionId});
  const state=await f.bridge.getState();assert.equal(state.savedSession.sessionId,otherSessionId);
  if(outcome==='success')gate.release.resolve();else gate.release.reject(new Error('旧会话迟到失败'));
  await old;
  const actual=await f.bridge.getState();assert.equal(actual.revision,state.revision);
  assert.equal(actual.savedSession.sessionId,otherSessionId);assert.equal(actual.savedSession.phase,'ready');
  assert.deepEqual(actual.savedSession.discussionEntries,[]);
 });
}
