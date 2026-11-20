import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';

const output = await build({ stdin: { contents: `
  export { DesktopDataLifecycle } from './src/main/data-lifecycle';
  export { SqliteDiscussionController } from './src/main/reply/sqlite-discussion-bridge';
  export { ContactHistoryController } from './src/main/contact-history/controller';
  export { ReplySession } from './src/main/reply/session';
  export { ContactSession } from './src/main/contacts/session';
  export { installHistoryClearBridge } from './src/main/history-clear/bridge';
  export { createHistoryClearBridge } from './src/preload/history-clear';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { DesktopDataLifecycle, SqliteDiscussionController, ContactHistoryController, ReplySession, ContactSession,
  installHistoryClearBridge, createHistoryClearBridge } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function fixture() {
 const contactId=randomUUID(),sessionId=randomUUID(),requestKey=randomUUID(),gate=Promise.withResolvers(),requests=[];
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},requestJson:request=>{requests.push(request);return gate.promise;}};
 const contacts={getState:()=>({selectedContactId:contactId,scopeRevision:1,directoryPhase:'ready',contacts:[{contactId}]}),onStateChanged:()=>()=>{}};
 const discussion=new SqliteDiscussionController(backend,contacts),state={history:'旧聊天',media:'旧图片',processing:'旧进度',management:'旧记忆'},events=[];
 const clear=key=>()=>{state[key]=null;};
 const ports={history:{invalidate:clear('history'),refreshCurrent:async id=>{events.push(['refresh',id]);}},media:{invalidate:clear('media'),invalidateAndDrain:async()=>{clear('media')();events.push(['drain']);}},
  processing:{synchronize:clear('processing')},management:{synchronize:clear('management')},discussion,
  replies:{prepareConnectionChange:async()=>{events.push(['connection']);},beginHistoryClear:()=>async()=>{}}};
 return {lifecycle:new DesktopDataLifecycle(ports),ports,discussion,state,events,requests,gate,request:{contactId,sessionId,requestKey,scopeRevision:1,text:'合成讨论要求'}};
}

test('删除联系人和清空历史均撤下旧资料并拒绝在途讨论的晚到成功',async t=>{
 for(const reason of ['contact-deletion','history-clear'])await t.test(reason,async()=>{
  const f=fixture();
  try{
   const pending=f.discussion.submit(f.request),rejected=assert.rejects(pending,/失效|变化/);
   if (reason === 'history-clear') f.lifecycle.beginHistoryClear(); else f.lifecycle.withdraw(reason);
   assert.ok(Object.values(f.state).every(value=>value===null));
   assert.equal(f.requests[0].signal.aborted,true);
   f.gate.resolve({generation:1,data:{session_id:f.request.sessionId,request_key:f.request.requestKey,segmented:false,replayed:false}});
   await rejected;
   await assert.rejects(f.discussion.submit(f.request),/失效|变化/);
   assert.equal(f.requests.length,1,'失效的旧请求不能恢复');
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

async function replyFixture(t) {
 const f=fixture(),contactId=randomUUID(),otherId=randomUUID(),sessionId=randomUUID(),otherSessionId=randomUUID(),requests=[];
 const message={message_id:randomUUID(),speaker:'contact',message_type:'text',text:'清空前的合成聊天',media_placeholder:null,occurred_at:null,quoted:null};
 const otherMessage={...message,message_id:randomUUID(),text:'另一联系人独立聊天'};
 const control={deleted:false,hold:undefined,failSessionReads:false,failClearReceipt:false};
 const clearEntered=Promise.withResolvers(),clearReply=Promise.withResolvers();
 const backend={getConnectionGeneration:()=>7,onStateChanged:()=>()=>{},subscribeMessages:()=>{},requestJson:async request=>{
  requests.push(request);let data;
  const other=request.path.includes(otherId),requestedSession=other?otherSessionId:sessionId;
  if(request.path.endsWith('/history/clear')){
   const requestedContact=request.path.split('/')[3];
   if(request.method==='POST'){
    assert.equal(requestedContact,contactId);
    control.deleted=true;clearEntered.resolve();await clearReply.promise;
    if(control.failClearReceipt)throw new Error('合成后端已接纳且回包丢失');
   }
   const completed=control.deleted&&requestedContact===contactId;
   data={contact_id:requestedContact,phase:completed?'completed':'none',completed,boundary_pending:false};
  }else if(request.path.endsWith('/history/resync')){
   data={contact_id:request.path.split('/')[3],request_key:null,state:'none',completed:false,goal:null};
  }else if(request.path.includes('/history-messages?')){
   const gate=control.hold;control.hold=undefined;
   const messages=other?[otherMessage]:control.deleted?[]:[message];
   if(gate)await gate.promise;
   data={messages,next_cursor:null};
  }else if(request.path.startsWith('/api/deletions?'))data={operations:[]};
  else if(request.path.endsWith('/assistant-sessions'))data={sessions:[{session_id:requestedSession,is_current:true}],current_session_id:requestedSession};
  else if(request.path.endsWith('/assistant-session/default'))data={session_id:requestedSession};
  else if(request.path.endsWith('/assistant-session/binding'))data={confirmed:true};
  else if(request.path.endsWith('/selections'))data={selection:null};
  else if(request.path.endsWith('/assistant-sessions/'+requestedSession)){
   if(control.failSessionReads)throw new Error('合成权威会话暂不可读');
   data={mode:'sqlite',session_id:requestedSession,runtime_recovery:'blocked',entries:control.deleted&&!other?[]:[{entry_id:randomUUID(),position:'1',role:'assistant',text:other?'另一联系人独立讨论':'清空前的合成讨论',request_id:randomUUID(),call_id:randomUUID(),content_state:'available'}]};
  }else throw new Error(`未安排的合成端口：${request.path}`);
  return {generation:7,data};
 }};
 const contacts=new ContactSession(async()=>({generation:7,contacts:[contactId,otherId].map(id=>({contactId:id,displayName:'合成联系人',messageCount:1,sourceCount:1}))}));
 contacts.setConnection(7);await contacts.refreshContacts();const replies=new ReplySession(contacts,backend);
 const select=id=>{contacts.selectContact({contactId:id,scopeRevision:contacts.getState().scopeRevision});return {contactId:id,scopeRevision:contacts.getState().scopeRevision};};
 const history=new ContactHistoryController(backend,contacts);
 const scope=select(contactId);await replies.readSavedSession(scope);await history.load({...scope,older:false});
 assert.equal(replies.getState().savedSession.discussionEntries[0].text,'清空前的合成讨论');
 assert.equal(history.getState().messages.items[0].messageId,message.message_id);
 const lifecycle=new DesktopDataLifecycle({...f.ports,replies,history});
 const handlers=new Map();
 const clearController=installHistoryClearBridge({handle:(name,handler)=>handlers.set(name,handler),publish:()=>{}},backend,contacts,lifecycle);
 const clear=createHistoryClearBridge({invoke:async (name,...args)=>handlers.get(name)(...args)});
 await clear.refresh(scope);
 t.after(()=>{clearReply.resolve();clearController.dispose();history.dispose();contacts.setConnection(undefined);f.discussion.close();});
 return {replies,history,contacts,lifecycle,scope,contactId,otherId,select,control,requests,otherMessage,clear,clearEntered,clearReply};
}

test('经聊天清空 IPC 撤下实际历史与讨论快照，回执丢失和失败复验不能复活旧正文', { timeout:5000 }, async t=>{
 for(const failed of [false,true])await t.test(String(failed),async t=>{
  const f=await replyFixture(t),gate=Promise.withResolvers();f.control.hold=gate;
  const pending=f.history.load({...f.scope,older:false});
  const request=f.requests.filter(row=>row.path.includes('/history-messages?')).at(-1);
  const clearing=f.clear.clear(f.scope);await f.clearEntered.promise;
  assert.equal(request.signal.aborted,true);
  assert.equal(f.history.getState().messages.items.length,0);
  assert.equal(JSON.stringify(f.replies.getState()).includes('清空前的合成讨论'),false);
  const before=f.requests.length;await f.replies.readSavedSession(f.scope);
  assert.equal(f.requests.length,before,'等待清空回执时不读取讨论正文');
  await f.clear.refresh(f.scope);
  assert.equal(f.requests.length,before,'补读进度不取消在途清空');
  f.control.failClearReceipt=failed;f.control.failSessionReads=failed;
  f.clearReply.resolve();await clearing;gate.resolve();await pending;
  assert.equal(f.history.getState().messages.items.length,0);
  assert.equal(JSON.stringify(f.replies.getState()).includes('清空前的合成讨论'),false);
  if(failed)assert.match((await f.clear.getState()).error,/尚未确认/);
  await f.clear.refresh(f.scope);
  assert.equal((await f.clear.getState()).clear.completed,true);
  f.control.failSessionReads=false;await f.replies.readSavedSession(f.scope);
  await f.history.load({...f.scope,older:false});
  assert.equal(f.history.getState().messages.phase,'ready');
  assert.equal(f.history.getState().messages.items.length,0);
  assert.equal(f.requests.filter(request=>request.method==='POST').length,1,'失败核对只读取状态，不重发清空');
 });
});

test('聊天清空幂等结算不解除另一在途清空读锁，另一联系人消息也不被旧清空抹掉',async t=>{
 const f=await replyFixture(t);
 const settleEarlier=f.lifecycle.beginHistoryClear();
 const settle=f.lifecycle.beginHistoryClear();f.control.deleted=true;
 await settle();await settle();
 const before=f.requests.length;await f.replies.readSavedSession(f.scope);
 assert.equal(f.requests.length,before,'重复清空结算不能释放另一操作的读锁');
 assert.equal(f.history.getState().messages.items.length,0);
 await settleEarlier();
 assert.equal(f.history.getState().messages.items.length,0);
 const lateSettle=f.lifecycle.beginHistoryClear(),other=f.select(f.otherId);
 await f.history.load({...other,older:false});
 await f.replies.readSavedSession(other);
 assert.deepEqual(f.replies.getState().savedSession.discussionEntries,[]);
 await lateSettle();
 assert.equal(f.replies.getState().contactId,f.otherId);
 assert.equal(f.replies.getState().savedSession.discussionEntries[0].text,'另一联系人独立讨论');
 assert.equal(f.history.getState().messages.items[0].messageId,f.otherMessage.message_id);
});
