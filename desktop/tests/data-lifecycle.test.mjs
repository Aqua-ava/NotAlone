import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';

const output=await build({stdin:{contents:"export {DesktopDataLifecycle} from './src/main/data-lifecycle';export {SqliteDiscussionController} from './src/main/reply/sqlite-discussion-bridge';export {ContactHistoryController} from './src/main/contact-history/controller';export {ReplySession} from './src/main/reply/session';export {ContactSession} from './src/main/contacts/session';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const {DesktopDataLifecycle,SqliteDiscussionController,ContactHistoryController,ReplySession,ContactSession}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function fixture() {
 const contactId=randomUUID(),sessionId=randomUUID(),requestKey=randomUUID(),gate=Promise.withResolvers(),requests=[];
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},requestJson:request=>{requests.push(request);return gate.promise;}};
 const contacts={getState:()=>({selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]}),onStateChanged:()=>()=>{}};
 const discussion=new SqliteDiscussionController(backend,contacts),state={history:'旧聊天',media:'旧图片',processing:'旧进度',management:'旧记忆'},events=[];
 const clear=key=>()=>{state[key]=null;};
 const ports={history:{getState:()=>({contactId}),invalidate:clear('history'),refreshCurrent:async id=>{events.push(['refresh',id]);}},media:{invalidate:clear('media'),invalidateAndDrain:async()=>{clear('media')();events.push(['drain']);}},
  processing:{synchronize:clear('processing')},management:{synchronize:clear('management')},discussion,
  replies:{revalidateDeletedSource:async id=>{events.push(['reply',id]);},prepareConnectionChange:async()=>{events.push(['connection']);},beginHistoryClear:()=>async()=>{}}};
 return {lifecycle:new DesktopDataLifecycle(ports),ports,discussion,state,events,requests,gate,request:{contactId,sessionId,requestKey,scopeRevision:1,text:'合成讨论要求'}};
}

test('删除来源、联系人和清空历史均撤下旧资料并拒绝在途讨论的晚到成功',async t=>{
 for(const reason of ['source-deletion','contact-deletion','history-clear'])await t.test(reason,async()=>{
  const f=fixture();
  try{
   const pending=f.discussion.submit(f.request),rejected=assert.rejects(pending,/失效|变化/);
   f.lifecycle.withdraw(reason);
   assert.ok(Object.values(f.state).every(value=>value===null));
   assert.equal(f.requests[0].signal.aborted,true);
   f.gate.resolve({generation:1,data:{session_id:f.request.sessionId,request_key:f.request.requestKey,segmented:false,replayed:false}});
   await rejected;
   await assert.rejects(f.discussion.submit(f.request),/失效|变化/);
   assert.equal(f.requests.length,1,'失效的旧请求不能恢复');
  }finally{f.discussion.close();}
 });
});

test('来源复验全部完成后才刷新聊天，复验失败不恢复旧快照',async t=>{
 for(const fail of [false,true])await t.test(String(fail),async()=>{
  const f=fixture(),gate=Promise.withResolvers();f.ports.replies.revalidateDeletedSource=()=>gate.promise;
  try{
   const pending=f.lifecycle.sourceChanged(f.request.contactId);
   const result=fail?assert.rejects(pending,/合成复验失败/):pending;
   assert.ok(Object.values(f.state).every(value=>value===null));
   assert.equal(f.events.some(([event])=>event==='refresh'),false);
   if(fail)gate.reject(new Error('合成复验失败'));else gate.resolve();
   await result;
   assert.equal(f.events.filter(([event])=>event==='refresh').length,fail?0:1);
   assert.ok(f.events.every(([,id])=>id===f.request.contactId));
  }finally{f.discussion.close();}
 });
});

test('连接切换先撤下SQLite资料并排空媒体，再结算回复任务',async()=>{
 const f=fixture(),gate=Promise.withResolvers();
 f.ports.media.invalidateAndDrain=async()=>{f.state.media=null;await gate.promise;f.events.push(['drain']);};
 try{
  const pending=f.lifecycle.connectionChanging();
  assert.equal(f.state.management,null);assert.equal(f.state.processing,null);assert.equal(f.state.media,null);
  assert.equal(f.events.some(([event])=>event==='connection'),false);
  gate.resolve();await pending;assert.deepEqual(f.events,[['drain'],['connection']]);
 }finally{f.discussion.close();}
});

test('原联系人删除迟到回调保留当前联系人聊天、媒体及在途读取，仍复验回复会话',async()=>{
 const f=fixture(),oldContact=randomUUID(),currentContact=f.request.contactId,reads=[],streams=[],held=Promise.withResolvers();
 const message={message_id:randomUUID(),speaker:'contact',message_type:'text',text:'当前联系人的合成聊天',media_placeholder:null,occurred_at:null,quoted:null};
 const page={generation:1,data:{messages:[message],next_cursor:null}};
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},subscribeMessages:(_observer,signal)=>streams.push(signal),
  requestJson:async request=>{reads.push(request);return reads.length===2?held.promise:page;}};
 const contacts={getState:()=>({selectedContactId:currentContact,scopeRevision:2,directoryPhase:'ready',contacts:[{contactId:oldContact},{contactId:currentContact}]}),onStateChanged:()=>()=>{}};
 const history=new ContactHistoryController(backend,contacts),lifecycle=new DesktopDataLifecycle({...f.ports,history});
 const selection={contactId:currentContact,scopeRevision:2,older:false};
 try{
  await history.load(selection);
  await lifecycle.sourceChanged(oldContact);
  assert.equal(history.getState().messages.phase,'ready');
  assert.equal(history.getState().messages.items[0].messageId,message.message_id);
  assert.equal(f.state.media,'旧图片');assert.equal(reads.length,1);
  assert.ok(streams.every(signal=>!signal.aborted));
  for(const key of ['processing','management'])assert.equal(f.state[key],null);
  assert.deepEqual(f.events,[['reply',oldContact]]);
  const pending=history.load(selection);
  await lifecycle.sourceChanged(oldContact);
  assert.equal(reads[1].signal.aborted,false);
  held.resolve(page);await pending;
  assert.equal(history.getState().messages.items[0].messageId,message.message_id);
  await lifecycle.sourceChanged(currentContact);
  assert.equal(f.state.media,null);
  assert.equal(reads.length,3,'同联系人来源变化仍重读当前聊天');
  assert.equal(history.getState().messages.phase,'ready');
 }finally{history.dispose();f.discussion.close();}
});

async function replyFixture(t) {
 const f=fixture(),contactId=randomUUID(),otherId=randomUUID(),sessionId=randomUUID(),requests=[];
 const message={message_id:randomUUID(),speaker:'contact',message_type:'text',text:'清空前的合成聊天',media_placeholder:null,occurred_at:null,quoted:null};
 const control={deleted:false,hold:undefined,failSessionReads:false};
 const backend={getConnectionGeneration:()=>7,onStateChanged:()=>()=>{},subscribeMessages:()=>{},requestJson:async request=>{
  requests.push(request);let data;
  if(request.path.includes('/history-messages?')){
   const gate=control.hold;control.hold=undefined;
   const messages=control.deleted&&request.path.includes(contactId)?[]:[message];
   if(gate)await gate.promise;
   data={messages,next_cursor:null};
  }else if(request.path.startsWith('/api/deletions?'))data={operations:[]};
  else if(request.path.endsWith('/assistant-sessions'))data={sessions:[{session_id:sessionId,is_current:true}],current_session_id:sessionId};
  else if(request.path.endsWith('/assistant-session/default'))data={session_id:sessionId};
  else if(request.path.endsWith('/assistant-session/binding'))data={confirmed:true};
  else if(request.path.endsWith('/selections'))data={selection:null};
  else if(request.path.endsWith('/assistant-sessions/'+sessionId)){
   if(control.failSessionReads)throw new Error('合成权威会话暂不可读');
   data={mode:'sqlite',session_id:sessionId,runtime_recovery:'blocked',entries:control.deleted?[]:[{entry_id:randomUUID(),position:'1',role:'assistant',text:'清空前的合成讨论',request_id:randomUUID(),call_id:null,content_state:'available'}]};
  }else throw new Error(`未安排的合成端口：${request.path}`);
  return {generation:7,data};
 }};
 const contacts=new ContactSession(async()=>({generation:7,contacts:[contactId,otherId].map(id=>({contactId:id,displayName:'合成联系人',messageCount:1,sourceCount:1}))}));
 contacts.setConnection(7);await contacts.refreshContacts();const replies=new ReplySession(contacts,backend);
 const select=id=>{contacts.selectContact({contactId:id,scopeRevision:contacts.getState().scopeRevision});return {contactId:id,scopeRevision:contacts.getState().scopeRevision};};
 const history=new ContactHistoryController(backend,contacts);
 const scope=select(contactId);await replies.readSavedSession(scope);await history.load({...scope,older:false});
 t.after(()=>{history.dispose();contacts.setConnection(undefined);f.discussion.close();});
 return {replies,history,contacts,lifecycle:new DesktopDataLifecycle({...f.ports,replies,history}),scope,contactId,otherId,select,control,requests,message};
}

test('聊天清空结算前后撤下实际历史与讨论快照，迟到读取和失败复验不能复活旧正文',async t=>{
 for(const failed of [false,true])await t.test(String(failed),async t=>{
  const f=await replyFixture(t),gate=Promise.withResolvers();f.control.hold=gate;
  const pending=f.history.load({...f.scope,older:false});
  const request=f.requests.filter(row=>row.path.includes('/history-messages?')).at(-1);
  const settle=f.lifecycle.beginHistoryClear(f.contactId);
  assert.equal(request.signal.aborted,true);
  assert.equal(f.history.getState().messages.items.length,0);
  assert.equal(JSON.stringify(f.replies.getState()).includes('清空前的合成讨论'),false);
  f.control.deleted=true;f.control.failSessionReads=failed;
  await settle();gate.resolve();await pending;
  assert.equal(f.history.getState().messages.items.length,0);
  await settle();assert.equal(f.history.getState().messages.items.length,0);
  f.control.failSessionReads=false;await f.replies.readSavedSession(f.scope);
  await f.history.load({...f.scope,older:false});
  assert.equal(f.history.getState().messages.phase,'ready');
  assert.equal(f.history.getState().messages.items.length,0);
 });
});

test('聊天清空幂等结算不解除重叠本人变更读锁，另一联系人消息也不被旧清空抹掉',async t=>{
 const f=await replyFixture(t);
 f.replies.beginOwnerContextChange();
 const settle=f.lifecycle.beginHistoryClear(f.contactId);f.control.deleted=true;
 await settle();await settle();
 const before=f.requests.length;await f.replies.readSavedSession(f.scope);
 assert.equal(f.requests.length,before,'重复清空结算不能释放另一操作的读锁');
 assert.equal(f.history.getState().messages.items.length,0);
 await f.replies.revalidateOwnerContextChange();
 assert.equal(f.history.getState().messages.items.length,0);
 const lateSettle=f.lifecycle.beginHistoryClear(f.contactId),other=f.select(f.otherId);
 await f.history.load({...other,older:false});
 await lateSettle();
 assert.equal(f.replies.getState().contactId,f.otherId);
 assert.equal(f.history.getState().messages.items[0].messageId,f.message.message_id);
});
