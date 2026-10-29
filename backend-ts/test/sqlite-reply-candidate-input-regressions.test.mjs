import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
const knowledgeRegistry=new URL('./fixtures/sqlite-reply-candidates/knowledge-registry.mjs',import.meta.url).href;
test('媒体占位和文字混合的近期会话仍可生成，媒体占位不冒充正文进入候选输入',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['混合会话的合成候选'],basis:[1]}]})}),original=f.channel.page;
 f.channel.page=async(...args)=>{const page=await original(...args);return {...page,records:[...page.records,{...page.records[0],localId:'2',kind:'image',text:null,originalType:'3'}]};};await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 const d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'根据文字回应',confirmedContact:true});assert.equal((await service.view(f.ids[0],d.id))[0].candidates.length,1);assert.equal(f.requests.length,1);
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/\[图片\]|媒体占位/);assert.equal((await f.history.read(f.ids[0])).messages.length,2);
});

test('合成本人记忆消费者保留跨联系人真实来源，删除贡献联系人也清另一讨论候选完整闭包',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const f=await realFixture(t,{registryModule:knowledgeRegistry,content:JSON.stringify({candidates:[{parts:['依据本人资料形成的合成候选'],basis:[3]}]})});const contactId=f.ids[1],sourceContact=f.ids[0];
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId:sourceContact,mode:'owner'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'结合本人资料表达',confirmedContact:true});assert.match((await service.view(contactId,d.id))[0].candidates[0].basis[0].text,/本人已采纳/);
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:sourceContact}}),done=await deletion.advance(op);assert.equal(done.state,'completed',JSON.stringify(done.checks));assert.deepEqual(await service.view(contactId,d.id),[]);assert.equal((await f.contacts.directory()).contacts.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
