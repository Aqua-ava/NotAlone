import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
const owner='00000000-0000-4000-8000-000000000001';
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-candidates-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({externalKey:'synthetic',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),sessions:async()=>['a','b'].map(externalKey=>({externalKey,displayName:'合成联系人',kind:'private',identityAssurance:'verified'}))});
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const snap=await contacts.candidates(true);await contacts.confirm(snap.snapshot_token,['a','b'].map(locator=>({locator,observed_display_name:'合成联系人',expected_selection_generation:'0'})));
 const ids=(await contacts.directory()).contacts.map(c=>c.contact_id),discussions=new SqliteDiscussionService(storage,owner);
 return {root,storage,contacts,ids,discussions,candidates:new SqliteReplyCandidateService(storage,owner)};
}
test('首次历史未完成时后端阻止候选受理，手动联系人确认不授予读取',async t=>{
 const f=await fixture(t),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),requestKey=randomUUID();
 const confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 await assert.rejects(f.candidates.begin({contactId,discussionId:discussion.id,requestKey,text:'帮我自然地回应',identity:{kind:'manual',confirmationId},acceptIncomplete:true}),{code:'reply_history_syncing'});
 assert.equal((await f.discussions.view(contactId,discussion.id)).entries.length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('正常模型输入产生v1多条消息，编辑追加v2且选择固定版本，历史回看不重新调用',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');
 const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const content=JSON.stringify({candidates:[{parts:['我理解你的意思。','我们晚点再聊。'],basis:[1]}]});
 const f=await realFixture(t,{content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'帮我自然地回应',confirmedContact:true};
 await turns.generate(input);
 const view=(await service.view(contactId,discussion.id))[0],first=view.candidates[0];
 assert.deepEqual(first.parts,['我理解你的意思。','我们晚点再聊。']);assert.equal(first.versionNo,1);assert.equal(first.origin,'model');assert.equal(first.basis[0].verification,'actual_input');
 const scope={contactId,discussionId:discussion.id,candidateId:first.candidateId};
 const edited=await service.edit({...scope,versionNo:1,parts:['我明白啦。','我们明天再聊。']});
 assert.equal(edited.versionNo,2);assert.equal(edited.parentVersionNo,1);assert.equal(edited.basis[0].verification,'inherited_unverified');
 const one=await service.select({...scope,versionNo:1}),two=await service.select({...scope,versionNo:2});assert.equal(one.selectionNo,1);assert.equal(two.selectionNo,2);
 assert.deepEqual((await service.version({...scope,versionNo:1})).parts,first.parts);
 await assert.rejects(service.edit({...scope,versionNo:1,parts:['过期改稿']}),{code:'reply_version_stale'});
 await assert.rejects(service.version({...scope,contactId:f.ids[1],versionNo:1}),{code:'discussion_unavailable'});
 const replay=await turns.generate(input);assert.equal(replay.replayed,true);assert.equal(f.requests.length,1);
 assert.equal((await f.discussions.view(contactId,discussion.id)).entries.filter(e=>e.role==='assistant').length,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('显式选稿才携入后续候选；删除完整输入窗口清候选、选择、追踪与非当前副本并保留另一联系人',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const f=await realFixture(t,{content:JSON.stringify({candidates:[{parts:['合成候选正文'],basis:[2]}]})}),contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'本轮表达要求',confirmedContact:true});
 const first=(await service.view(contactId,d.id))[0].candidates[0],selection=await service.select({contactId,discussionId:d.id,candidateId:first.candidateId,versionNo:1});
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'继续改得简洁',confirmedContact:true,carriedSelectionId:selection.id});
 assert.match(JSON.stringify(f.requests[1]),/用户明确选择继续的候选/);assert.equal(f.requests.length,2);
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId,sourceId:f.messages[0][0].sourceRecordIds[0]}});
 assert.equal((await service.view(contactId,d.id)).flatMap(r=>r.candidates).length,0);
 const done=await deletion.advance(op);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual(await service.view(contactId,d.id),[]);assert.equal((await f.contacts.directory()).contacts.length,2);
 assert.equal((await f.history.read(f.ids[1])).messages.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
