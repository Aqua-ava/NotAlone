import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const output=await build({stdin:{contents:`export {ReplySession} from './src/main/reply/session';export {ContactSession} from './src/main/contacts/session';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false});
const loaded={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const {ReplySession,ContactSession}=loaded.exports;
const id='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002',mid='00000000-0000-4000-8000-000000000003';
async function fixture(){
 const controls={failure:false,hold:null};
 const backend={getConnectionGeneration:()=>1,onStateChanged:()=>()=>{},subscribeMessages:()=>()=>{},requestJson:async req=>{
  if(req.path.includes('/history-messages?')){if(controls.hold)await controls.hold;if(controls.failure)throw Error('synthetic_denied');return {generation:1,data:{messages:[{message_id:mid,speaker:'contact',message_type:'text',text:'应撤下的合成正文',media_placeholder:null,occurred_at:null,quoted:null,ordering:'unknown',display_position:'1'}],next_cursor:null}};}
  const data=req.path.endsWith('/assistant-session/default')?{session_id:sid}:req.path.endsWith('/assistant-sessions')?{sessions:[{session_id:sid,is_current:true}],current_session_id:sid}:req.path.includes('/assistant-sessions/')?{session_id:sid,current_input_version_id:null,turns:[],inputs:[]}:req.path.startsWith('/api/deletions')?{operations:[]}:{};
  return {generation:1,data};
 }};
 const contacts=new ContactSession(async()=>({generation:1,contacts:[{contactId:id,displayName:'合成联系人',messageCount:1,sourceCount:1},{contactId:sid,displayName:'合成另一位',messageCount:1,sourceCount:1}]}));
 contacts.setConnection(1);await contacts.refreshContacts();const replies=new ReplySession(contacts,backend);
 contacts.selectContact({contactId:id,scopeRevision:contacts.getState().scopeRevision});
 for(let i=0;i<30&&replies.getState().savedSession?.phase==='loading';i++)await new Promise(setImmediate);
 const scope={contactId:id,scopeRevision:contacts.getState().scopeRevision};
 await replies.loadMessages(scope);assert.equal(replies.getState().messages.items.length,1);
 return {controls,contacts,replies,scope};
}
test('历史读取资格拒绝后撤下旧消息正文和翻页位置',async()=>{
 const f=await fixture();f.controls.failure=true;await f.replies.loadMessages(f.scope);
 assert.equal(f.replies.getState().messages.phase,'failed');assert.deepEqual(f.replies.getState().messages.items,[]);assert.equal(f.replies.getState().messages.nextCursor,null);assert.equal(f.replies.getState().targetMessageId,null);
});
test('旧范围迟到失败不能清除新范围的成功消息',async()=>{
 const f=await fixture();let release;f.controls.hold=new Promise(resolve=>{release=resolve;});
 const old=f.replies.loadMessages(f.scope);f.contacts.selectContact({contactId:sid,scopeRevision:f.contacts.getState().scopeRevision});
 f.controls.hold=null;const scope={contactId:sid,scopeRevision:f.contacts.getState().scopeRevision};
 for(let i=0;i<30&&f.replies.getState().savedSession?.phase==='loading';i++)await new Promise(setImmediate);
 await f.replies.loadMessages(scope);f.controls.failure=true;release();await old;
 assert.equal(f.replies.getState().messages.items[0]?.text,'应撤下的合成正文');
});
