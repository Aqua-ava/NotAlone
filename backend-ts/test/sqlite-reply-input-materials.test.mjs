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
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const content=JSON.stringify({candidates:[{parts:['合成候选'],basis:[1]}]});
const workspace={action:'express',draftText:'本次想法原文',tone:'warm',instruction:'不要添加承诺',contextText:'本次补充聊天原文',includeRelationshipContext:true};
async function setup(t,options={}){
 const f=await fixture(t,{content,...options}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId);
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 return {...f,service,turns,scope:{contactId,discussionId:discussion.id}};
}

test('本次实际输入展示完整冻结原文，与候选引用分开且不读取当前聊天替代旧快照',async t=>{
 const f=await setup(t,{content:JSON.stringify({candidates:[{parts:['合成候选'],basis:[3]}]})});await f.turns.generate({...f.scope,requestKey:randomUUID(),text:workspace.draftText,workspace,confirmedContact:true});
 const view=(await f.service.view(f.scope.contactId,f.scope.discussionId))[0],page=await f.service.inputMaterials({...f.scope,requestId:view.requestId,offset:0});
 assert.equal(page.recorded,true);assert.equal(page.nextOffset,null);assert.equal(page.total,5);assert.equal(view.candidates[0].basis.length,1);
 assert.deepEqual(page.items.map(item=>item.kind),['message','entry','entry','entry','entry']);
 assert.deepEqual(page.items.slice(1).map(item=>item.workspaceItem),['request','draft','instruction','supplemental_context']);
 assert.equal(view.candidates[0].basis[0].workspaceItem,'draft');
 assert.match(page.items[0].text,/^（2023-11-\d{2} \d{2}:\d{2}）对方：合成会话/);
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

test('实际输入缺少历史请求事件时明确标记记录缺失',async t=>{
 const f=await setup(t);await f.turns.generate({...f.scope,requestKey:randomUUID(),text:'合成请求',confirmedContact:true});
 const view=(await f.service.view(f.scope.contactId,f.scope.discussionId))[0];
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));
 try{db.prepare("DELETE FROM execution_event WHERE kind='model_request'").run();}finally{db.close();}
 assert.deepEqual(await f.service.inputMaterials({...f.scope,requestId:view.requestId,offset:0}),{recorded:false,items:[],nextOffset:null,total:0});
});

test('实际输入按数量分页并限制运输体积，HTTP拒绝越界查询',{timeout:30_000},async t=>{
 const f=await setup(t,{synchronizeHistory:false});f.model.budgetProfile.context_window_tokens=3_000_000;
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:Array.from({length:50},(_,index)=>({partition:'shard-a',table:'table-instance-1',localId:String(index+1),serverId:'0',sender:'contact',kind:'text',text:`合成消息${index+1}：`+'x'.repeat(1000),originalType:'1',sentAt:String(1700000000000+index*1000),timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'})),completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.history.synchronize(f.scope.contactId);
 await f.turns.generate({...f.scope,requestKey:randomUUID(),text:workspace.draftText,workspace,confirmedContact:true});
 const view=(await f.service.view(f.scope.contactId,f.scope.discussionId))[0];
 const http=new SqliteReplyCandidateHttp({storage:f.storage,service:f.service,authorize:req=>req.headers.authorization==='Bearer synthetic'});
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/api/contacts/${f.scope.contactId}/assistant-sessions/${f.scope.discussionId}/reply-candidates/${view.requestId}/inputs`;
 assert.equal((await fetch(base)).status,401);
 const read=async suffix=>{const response=await fetch(base+suffix,{headers:{authorization:'Bearer synthetic'}}),wire=await response.text();return {status:response.status,wire,body:JSON.parse(wire)};};
 const first=await read('?offset=0');assert.equal(first.status,200,first.wire);assert.equal(first.body.recorded,true);assert.equal(first.body.total,54);assert.ok(first.body.items.length<=50);assert.ok(first.body.nextOffset>0);assert.ok(Buffer.byteLength(first.wire)<1_501_000);
 const second=await read(`?offset=${first.body.nextOffset}`);assert.equal(second.status,200,second.wire);assert.equal(second.body.nextOffset,null);assert.equal(first.body.items.length+second.body.items.length,54);
 assert.equal(new Set([...first.body.items,...second.body.items].map(item=>item.itemNo)).size,54);
 assert.equal((await read('?offset=-1')).status,400);assert.equal((await read('?offset=0&owner_id=foreign')).status,400);assert.equal((await read('?offset=0&offset=1')).status,400);
});
