import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyCandidateHttp} from '../src/reply/sqlite/candidates/http.ts';
import {SqliteDiscussionHttp} from '../src/reply/sqlite/http.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {createAssistantReadChannel} from '../src/reply/sqlite/read-channel.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const content=JSON.stringify({candidates:[{parts:['合成候选'],basis:[1]}]});
const workspace={action:'express',draftText:'本次想法原文；语气温和，不要添加承诺',contextText:'本次补充聊天原文',includeRelationshipContext:true};
async function setup(t,options={}){
 const f=await fixture(t,{content,...options}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId);
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 return {...f,service,turns,scope:{contactId,discussionId:discussion.id}};
}

test('本次其他参考保留冻结输入与选稿版本，聊天原文仍由候选引用展示',async t=>{
 const f=await setup(t,{content:JSON.stringify({candidates:[{parts:['合成候选'],basis:[3]}]})});await f.turns.generate({...f.scope,requestKey:randomUUID(),text:workspace.draftText,workspace,confirmedContact:true});
 const view=(await f.service.view(f.scope.contactId,f.scope.discussionId))[0],page=await f.service.inputMaterials({...f.scope,requestId:view.requestId,offset:0});
 assert.equal(page.recorded,true);assert.equal(page.nextOffset,null);assert.equal(page.total,3);assert.equal(view.candidates[0].basis.length,1);
 assert.deepEqual(page.items.map(item=>item.kind),['entry','entry','entry']);
 assert.deepEqual(page.items.map(item=>item.itemNo),[2,3,4]);
 assert.deepEqual(page.items.map(item=>item.workspaceItem),['request','draft','supplemental_context']);
 assert.equal(view.candidates[0].basis[0].workspaceItem,'draft');
 assert.doesNotMatch(JSON.stringify(page),/合成会话/);
 for(const item of page.items)assert.ok(JSON.stringify(f.requests[0]).includes(item.text.replaceAll('\n','\\n')));
 assert.equal(JSON.stringify(page).includes('identity_json'),false);
 await f.service.edit({...f.scope,candidateId:view.candidates[0].candidateId,versionNo:1,parts:['用户修改的原文']});
 const selection=await f.service.select({...f.scope,candidateId:view.candidates[0].candidateId,versionNo:2});
 await f.turns.generate({...f.scope,requestKey:randomUUID(),text:'下一次想法原文',workspace:{...workspace,draftText:'下一次想法原文'},carriedSelectionId:selection.id,confirmedContact:true});
 const current=(await f.service.view(f.scope.contactId,f.scope.discussionId)).at(-1),currentInputs=await f.service.inputMaterials({...f.scope,requestId:current.requestId,offset:0});
 assert.equal(currentInputs.items.find(item=>item.kind==='selection').versionNo,2);
 assert.match(currentInputs.items.find(item=>item.workspaceItem==='draft').text,/下一次想法原文/);
 assert.deepEqual(await f.service.inputMaterials({...f.scope,requestId:view.requestId,offset:0}),page);
 await assert.rejects(f.service.inputMaterials({...f.scope,contactId:f.ids[1],requestId:view.requestId,offset:0}),{code:'discussion_unavailable'});
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));
 await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.scope.contactId,sourceId:f.messages[0][0].sourceRecordIds[0]}});
 await assert.rejects(f.service.inputMaterials({...f.scope,requestId:view.requestId,offset:0}));
});

test('认证HTTP仍可回看退役前要求、原讨论和候选版本，不重新调用或改变当前讨论',async t=>{
 const f=await setup(t);await f.turns.generate({...f.scope,requestKey:randomUUID(),text:workspace.draftText,workspace,confirmedContact:true});
 const view=(await f.service.view(f.scope.contactId,f.scope.discussionId))[0],legacyText='本次一次性写作要求：\n简短一些，不增加承诺';
 // 用合成数据库构造退役前的已冻结材料，历史读取不通过当前新请求解析器。
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));
 try{
  const context=db.prepare('SELECT id FROM reply_context WHERE owner_id=? AND request_id=?').get(f.owner,view.requestId);
  const event=db.prepare(`SELECT e.id FROM execution_event e JOIN model_call c ON c.owner_id=e.owner_id AND c.id=e.originated_call_id WHERE e.owner_id=? AND c.reply_context_id=? AND e.kind='model_request' ORDER BY e.event_no DESC LIMIT 1`).get(f.owner,context.id);
  db.prepare('INSERT INTO reply_candidate_input VALUES(?,?,?,?,?,?)').run(f.owner,context.id,5,'entry',JSON.stringify({workspaceItem:'instruction'}),legacyText);
  db.prepare('INSERT INTO reply_execution_input VALUES(?,?,?,?)').run(f.owner,event.id,context.id,5);
 }finally{db.close();}
 const candidate=view.candidates[0];await f.service.edit({...f.scope,candidateId:candidate.candidateId,versionNo:1,parts:['用户保留的历史修改']});
 const current=await f.discussions.newDiscussion(f.scope.contactId);
 // 与正常宿主一致，回看经认证HTTP和独立只读Worker；供应商仅使用夹具环回边界。
 const reader=await createAssistantReadChannel({storage:f.storage,ownerId:f.owner,holders:f.holders});t.after(()=>reader.close());
 const authorize=req=>req.headers.authorization==='Bearer synthetic';
 const candidateHttp=new SqliteReplyCandidateHttp({storage:f.storage,service:new SqliteReplyCandidateService(f.storage,f.owner,reader),authorize});
 const discussionHttp=new SqliteDiscussionHttp(new SqliteDiscussionService(f.storage,f.owner,Date.now,reader),authorize);
 const server=createServer(async(req,res)=>{if(!await candidateHttp.handle(req,res)&&!await discussionHttp.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`,catalogPath=`/api/contacts/${f.scope.contactId}/assistant-sessions`,sessionPath=`${catalogPath}/${f.scope.discussionId}`,candidatePath=`${sessionPath}/reply-candidates`;
 const read=async path=>{const response=await fetch(origin+path,{headers:{authorization:'Bearer synthetic'}});return {status:response.status,body:await response.json()};};
 assert.equal((await fetch(origin+sessionPath)).status,401);
 const before=await read(catalogPath),inputs=await read(`${candidatePath}/${view.requestId}/inputs`);assert.equal(inputs.status,200);
 const page=inputs.body,legacy=page.items.find(item=>item.workspaceItem==='instruction');assert.equal(legacy?.text,legacyText);
 assert.deepEqual((await read(`${candidatePath}/${view.requestId}/inputs`)).body,page);
 const discussion=await read(sessionPath);assert.equal(discussion.status,200);
 assert.deepEqual(Object.keys(discussion.body).sort(),['entries','mode','runtime_recovery','session_id']);
 assert.equal(discussion.body.entries.length,1);assert.equal(discussion.body.entries[0].role,'user');
 assert.match(discussion.body.entries[0].text,/本次想法原文/);
 const candidates=await read(candidatePath);assert.equal(candidates.status,200);
 assert.deepEqual(candidates.body.requests[0].candidates[0].parts,['用户保留的历史修改']);
 assert.deepEqual((await read(`${candidatePath}/${candidate.candidateId}/versions/1`)).body.parts,['合成候选']);
 assert.deepEqual((await read(`${candidatePath}/${candidate.candidateId}/versions/2`)).body.parts,['用户保留的历史修改']);
 const after=await read(catalogPath);assert.deepEqual(after,before);assert.equal(after.body.current_session_id,current.id);
 assert.equal((await read(sessionPath.replace(f.scope.contactId,f.ids[1]))).status,404);
 assert.equal(f.requests.length,1);
});

test('实际输入缺少历史请求事件时明确标记记录缺失',async t=>{
 const f=await setup(t);await f.turns.generate({...f.scope,requestKey:randomUUID(),text:'合成请求',confirmedContact:true});
 const view=(await f.service.view(f.scope.contactId,f.scope.discussionId))[0];
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));
 try{db.prepare("DELETE FROM execution_event WHERE kind='model_request'").run();}finally{db.close();}
 assert.deepEqual(await f.service.inputMaterials({...f.scope,requestId:view.requestId,offset:0}),{recorded:false,items:[],nextOffset:null,total:0});
});

test('50条聊天不占其他参考的首屏和计数，HTTP保留候选引用与查询边界',{timeout:30_000},async t=>{
 const f=await setup(t,{synchronizeHistory:false});f.model.budgetProfile.context_window_tokens=3_000_000;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:Array.from({length:50},(_,index)=>({partition:'shard-a',table:'table-instance-1',localId:String(index+1),serverId:'0',sender:'contact',kind:'text',text:`合成消息${index+1}：`+'x'.repeat(1000),originalType:'1',sentAt:String(1700000000000+index*1000),timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.history.synchronize(f.scope.contactId);
 await f.turns.generate({...f.scope,requestKey:randomUUID(),text:workspace.draftText,workspace,confirmedContact:true});
 const view=(await f.service.view(f.scope.contactId,f.scope.discussionId))[0];
 assert.equal(view.candidates[0].basis[0].kind,'message');assert.match(view.candidates[0].basis[0].text,/合成消息/);
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service:f.service,authorize:req=>req.headers.authorization==='Bearer synthetic'});
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api/contacts/${f.scope.contactId}/assistant-sessions/${f.scope.discussionId}/reply-candidates/${view.requestId}/inputs`;
 assert.equal((await fetch(base)).status,401);
 const read=async suffix=>{const response=await fetch(base+suffix,{headers:{authorization:'Bearer synthetic'}}),wire=await response.text();return {status:response.status,wire,body:JSON.parse(wire)};};
 const first=await read('?offset=0');assert.equal(first.status,200,first.wire);assert.equal(first.body.recorded,true);assert.equal(first.body.total,3);assert.equal(first.body.items.length,3);assert.equal(first.body.nextOffset,null);assert.ok(Buffer.byteLength(first.wire)<1_501_000);
 assert.deepEqual(first.body.items.map(item=>item.itemNo),[51,52,53]);
 assert.deepEqual(first.body.items.map(item=>item.workspaceItem),['request','draft','supplemental_context']);
 assert.ok(first.body.items.every(item=>item.kind!=='message'));assert.doesNotMatch(first.wire,/合成消息/);
 const second=await read('?offset=3');assert.equal(second.status,200,second.wire);assert.deepEqual(second.body,{recorded:true,items:[],nextOffset:null,total:3});
 assert.equal((await read('?offset=-1')).status,400);assert.equal((await read('?offset=0&owner_id=foreign')).status,400);assert.equal((await read('?offset=0&offset=1')).status,400);
});
