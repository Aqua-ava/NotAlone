import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

test('真实08写者与12消费者同事务冻结正式版本，删除本人贡献者清另一联系人候选完整闭包',{timeout:20000},async t=>{
 const f=await fixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['结合本人记忆的合成回复'],basis:[4]}]})});
 const [a,b]=f.ids,original=f.channel.page;
 f.channel.page=async(...args)=>{const page=await original(...args);return {...page,records:[{...page.records[0],text:'我长期住在高雄。'},{...page.records[0],localId:'2',sender:'owner',text:'我长期偏好绿茶。'}]};};
 await f.contacts.setReading(true);for(const contactId of f.ids)await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const management=new SqliteMemoryManagement(f.storage,f.owner);let extraction;extraction=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>extraction.accounting,supplier().respond),f.holders,runId=>management.publishRun(runId));t.after(()=>extraction.close());
 await extraction.start('08-to-12-writer-consumer');await extraction.waitForIdle();
 assert.equal((await management.read({scopeKind:'self',contactId:null})).memories.length,2);
 const d=await f.discussions.newDiscussion(b),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId:b,discussionId:d.id,requestKey:randomUUID(),text:'结合当前本人资料表达',confirmedContact:true});
 const before=await service.view(b,d.id);assert.equal(before[0].candidates[0].basis[0].verification,'actual_input');
 assert.match(JSON.stringify(f.requests[0]),/用户长期偏好绿茶/);assert.equal(f.requests.length,1);
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:a}}),done=await deletion.advance(plan);
 assert.equal(done.state,'completed',JSON.stringify(done.checks));assert.deepEqual(await service.view(b,d.id),[]);
 assert.ok((await management.read({scopeKind:'self',contactId:null})).memories.every(m=>m.current===null));assert.equal(f.requests.length,1);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
