import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {adjudicationFixture,adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

async function prepared(t,count=1){
 const f=await fixture(t),[contactId,otherContactId]=f.saved.map(value=>value.contact_id),scope={scopeKind:'contact',contactId};
 f.channel.page=async current=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:current.token.contact_id===contactId?count:1},(_,index)=>record(String(index+1),{text:`我长期保留合成事项${index+1}。`})),completedPartitions:['shard-a'],exhausted:true});
 for(const id of [contactId,otherContactId])await f.service.synchronize(id);await f.contacts.setReading(false);
 let extraction;extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));t.after(()=>extraction.close());
 const run=await extraction.start('candidate-history');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 return {...f,scope,contactId,otherContactId,management};
}

test('已处理候选不占待处理分页，修改采纳的原稿只随对应版本历史读取',{timeout:30000},async t=>{
 const f=await prepared(t,24),candidates=[];let cursor;
 do{const page=await f.management.read(f.scope,cursor?{cursor}:{});candidates.push(...page.candidates);cursor=page.page.nextCursor;}while(cursor);
 assert.equal(candidates.length,24);
 const original=candidates[0],editedBody='联系人明确保留第一项合成资料。';
 const adopted=await f.management.decide({requestKey:'edited',action:'edit_accept',candidateIds:[original.id],candidateRevisions:[original.stateRevision],body:editedBody});
 for(const candidate of candidates.slice(1,22))await f.management.decide({requestKey:`accept-${candidate.id}`,action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const rejected=candidates[22],pending=candidates[23];
 await f.management.decide({requestKey:'rejected',action:'reject',candidateIds:[rejected.id],candidateRevisions:[rejected.stateRevision]});
 const first=await f.management.read(f.scope),second=await f.management.read(f.scope,{cursor:first.page.nextCursor});
 assert.deepEqual(first.candidates.map(candidate=>candidate.id),[pending.id]);assert.deepEqual(second.candidates,[]);
 assert.equal(first.memories.length,20);assert.equal(second.memories.length,2);assert.equal(second.page.nextCursor,null);
 const summary=(await f.management.read(f.scope,{memoryId:adopted.memoryId})).memories[0];
 assert.equal(summary.current.body,editedBody);assert.equal(Object.hasOwn(summary.current,'originalCandidates'),false);
 assert.ok(summary.versions.every(version=>!Object.hasOwn(version,'originalCandidates')));
 const history=await f.management.readHistory(f.scope,adopted.memoryId,{displayContactId:f.contactId});
 assert.equal(history.versions.length,1);assert.equal(history.versions[0].body,editedBody);
 // 读取视图会给 pending 候选附加 pendingStage/pendingReason 派生字段；归档原稿按决定时刻快照，不含这类时效字段。
 const archivedOriginal=Object.fromEntries(Object.entries({...original,state:'adopted',stateRevision:'1'}).filter(([key])=>key!=='pendingStage'&&key!=='pendingReason'));
 assert.deepEqual(history.versions[0].originalCandidates,[archivedOriginal]);
 assert.equal((await f.management.read(f.scope,{candidateId:original.id})).candidates[0].state,'adopted');
 assert.equal((await f.management.read(f.scope,{candidateId:rejected.id})).candidates[0].state,'rejected');
 await assert.rejects(f.management.readHistory({scopeKind:'contact',contactId:f.otherContactId},adopted.memoryId));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('自动更新按各版本采纳决定关联原稿，人工修正不借用当前页或其他版本原稿',{timeout:30000},async t=>{
 const f=await adjudicationFixture(t);await f.extract(['我长期住在高雄。'],{publish:true});
 f.setRespond(adjudicationSupplier({action:'update'}));await f.extract(['我现在长期住在台南。'],{publish:true});
 const summary=(await f.management.read(f.scope)).memories[0];
 await f.management.decide({requestKey:'correct-current',action:'correct',memoryId:summary.id,expectedVersionNo:summary.current.versionNo,expectedHeadRevision:summary.headRevision,body:'联系人说目前长期住在台南。'});
 const history=await f.management.readHistory(f.scope,summary.id);
 assert.deepEqual(history.versions.map(version=>version.originalCandidates.map(candidate=>candidate.body)),[['联系人长期住在高雄。'],['联系人现在长期住在台南。'],[]]);
 assert.ok(history.versions.slice(0,2).every(version=>version.originalCandidates.every(candidate=>candidate.state==='adopted'&&candidate.sources.every(source=>source.contactId===f.contactId))));
});

test('原稿沿历史分页按需读取，来源删除立即拒绝旧历史且清除后不恢复原稿',{timeout:30000},async t=>{
 const f=await prepared(t),candidate=(await f.management.read(f.scope)).candidates[0];
 const adopted=await f.management.decide({requestKey:'first-version',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 for(let index=2;index<=23;index++){
  const memory=(await f.management.read(f.scope,{memoryId:adopted.memoryId})).memories[0];
  await f.management.decide({requestKey:`correction-${index}`,action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:`联系人合成资料修正${index}。`});
 }
 const recent=await f.management.readHistory(f.scope,adopted.memoryId),older=await f.management.readHistory(f.scope,adopted.memoryId,{cursor:recent.nextCursor});
 assert.equal(recent.versions.length,20);assert.ok(recent.versions.every(version=>version.originalCandidates.length===0));
 assert.equal(older.versions.length,3);assert.equal(older.versions[0].originalCandidates[0].id,candidate.id);assert.equal(older.nextCursor,null);
 assert.ok(Buffer.byteLength(JSON.stringify(recent))<6*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(older))<6*1024*1024);
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'erase-original-source',scope:{kind:'source',contactId:f.contactId,sourceId:candidate.sources[0].recordId}});
 await assert.rejects(f.management.readHistory(f.scope,adopted.memoryId,{cursor:recent.nextCursor}));
 const completed=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(completed.state,'completed',JSON.stringify(completed.checks));
 const erased=await f.management.readHistory(f.scope,adopted.memoryId);
 assert.ok(erased.versions.every(version=>version.body===null&&version.originalCandidates.length===0));
 assert.deepEqual((await f.management.read(f.scope,{candidateId:candidate.id})).candidates,[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
