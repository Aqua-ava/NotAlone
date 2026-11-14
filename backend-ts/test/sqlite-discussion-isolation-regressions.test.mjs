import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';

const owner='00000000-0000-4000-8000-000000000001';
const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,
 programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),
 declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
const model={provider:'synthetic-official',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off',
 physical_limit:1,deadline_ms:5000,warning_ratio:0.8,budgetProfile:{context_window_tokens:8192,safety_margin_tokens:512}};

async function fixture(t,{historyCount=0}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-discussion-isolation-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/discussion-isolation-registry.mjs',import.meta.url).href});
 const holders=new ActiveHolders(),files=new ManagedFiles(root);files.prepareArea('runtime');
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const contacts=new SqliteContactService(storage,owner,{
  account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),
  sessions:async()=>['a','b'].map((externalKey,index)=>({externalKey,displayName:index?'合成乙':'合成甲',kind:'private',identityAssurance:'verified'})),
 });
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);
 const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(session=>({
  locator:session.username,observed_display_name:session.display_name,expected_selection_generation:session.selection_generation,
 })));
 const directory=(await contacts.directory()).contacts,ids=directory.map(contact=>contact.contact_id);
 const contactId=directory.find(contact=>contact.display_name==='合成甲')?.contact_id??ids[0];
 const channel={
  inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),
  target:async scope=>({protocol:'private-history-v1',descriptor:`synthetic-target-${scope.conversationKey}`,
   partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'}),
  page:async(scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[{partition:'shard-a',table:'table-instance-1',
   localId:'1',serverId:'0',sender:'contact',kind:'text',text:`合成聊天-${scope.conversationKey}`,originalType:'1',sentAt:'1700000000000',
   timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['shard-a'],exhausted:true}),
 };
 const history=new SqliteHistoryService(storage,contacts,channel,holders);
 await contacts.setReading(true);await history.synchronize(contactId);
 const management=new SqliteMemoryManagement(storage,owner);
 await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'合成联系人记忆：不要删除。'});
 await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'self',contactId:null},body:'合成本人记忆：不要删除。'});
 const discussions=new SqliteDiscussionService(storage,owner);
 for(let index=0;index<historyCount;index++)await discussions.newDiscussion(contactId);
 const current=await discussions.newDiscussion(contactId);
 return {root,storage,holders,files,contacts,history,management,discussions,ids,contactId,current};
}

async function generateToFrozenFailure(f){
 const calls=[];
 const recording={execute(name,input){calls.push({name,contactId:input?.contactId});return f.storage.execute(name,input);}};
 const service=new SqliteReplyCandidateService(recording,owner),discussions=new SqliteDiscussionService(recording,owner);
 const runtime={run:async()=>{throw new StorageFailure('synthetic_runtime_stop');}};
 const provider={beginCall:async()=>{throw new Error('provider must not be called');}};
 const turns=new SqliteReplyTurns({storage:recording,service,discussions,runtime,model,provider,arbiter:new ModelPermitArbiter(),authorize:async()=>{}});
 try{
  await assert.rejects(turns.generate({contactId:f.contactId,discussionId:f.current.id,requestKey:randomUUID(),text:'用当前聊天和本次想法生成',
   confirmedContact:true,workspace:{action:'suggest',draftText:'用当前聊天和本次想法生成',contextText:'',
    includeRelationshipContext:true}}),/synthetic_runtime_stop/);
 }finally{await turns.close();}
 return calls;
}

test('删除讨论清候选输入和生成闭包但保留真实聊天、关系记忆、本人记忆和兄弟讨论',async t=>{
 const f=await fixture(t);
 await generateToFrozenFailure(f);
 const before=await f.storage.execute('discussionIsolation.inspect',{ownerId:owner,contactId:f.contactId,discussionId:f.current.id});
 assert.equal(before.candidateInputs.length>0,true);
 assert.deepEqual(before.messages.map(row=>row.text_body),[`合成聊天-a`]);
 assert.deepEqual(before.memories.map(row=>row.body).sort(),['合成本人记忆：不要删除。','合成联系人记忆：不要删除。'].sort());
 const sibling=await f.discussions.newDiscussion(f.contactId);
 const operation=await new DeletionService(f.storage,f.holders,f.files,{drainTimeoutMs:100}).plan({ownerId:owner,requestKey:'delete-isolated-history',
  scope:{kind:'discussion',contactId:f.contactId,discussionId:f.current.id}});
 const done=await new DeletionService(f.storage,f.holders,f.files,{drainTimeoutMs:100}).advance(operation);
 assert.equal(done.state,'completed');
 const after=await f.storage.execute('discussionIsolation.inspect',{ownerId:owner,contactId:f.contactId,discussionId:f.current.id});
 assert.equal(after.requestCount,0n);assert.equal(after.contextCount,0n);assert.deepEqual(after.candidateInputs,[]);
 assert.equal(after.discussions.find(row=>row.id===f.current.id).state,'deleted');
 assert.equal(after.discussions.find(row=>row.id===sibling.id).state,'active');
 assert.deepEqual(after.messages,before.messages);
 assert.deepEqual(after.memories,before.memories);
});

test('一段与四十段历史讨论不改变新候选材料和读取动作集合',async t=>{
 const measurements=[];
 for(const count of [1,40]){
  const f=await fixture(t,{historyCount:count});
  const calls=await generateToFrozenFailure(f);
  const inspected=await f.storage.execute('discussionIsolation.inspect',{ownerId:owner,contactId:f.contactId,discussionId:f.current.id});
  measurements.push({discussionCount:inspected.discussions.length,
   materials:inspected.candidateInputs.map(row=>({kind:row.kind,text:row.text_body,sources:String(row.source_count)})),
   readActions:calls.map(call=>call.name).filter(name=>/^(discussion\.(localMessages|messages)|reply\.freezeInput)$/.test(name))});
 }
 t.diagnostic(JSON.stringify(measurements));
 assert.equal(measurements[1].discussionCount,measurements[0].discussionCount+39);
 assert.deepEqual(measurements[1].materials,measurements[0].materials);
 assert.deepEqual(measurements[1].readActions,measurements[0].readActions);
 assert.equal(measurements.every(item=>item.materials.some(material=>material.text.includes('合成聊天-a'))),true);
 assert.equal(measurements.every(item=>!item.readActions.some(name=>name==='discussion.list'||name==='discussion.view')),true);
});

test('删除候选实际来源后回看和继续不恢复旧聊天或讨论正文',async t=>{
 const f=await fixture(t);
 await generateToFrozenFailure(f);
 const before=await f.storage.execute('discussionIsolation.inspect',{ownerId:owner,contactId:f.contactId,discussionId:f.current.id});
 assert.equal(before.sourceIds.length,1);
 const deletion=new DeletionService(f.storage,f.holders,f.files,{drainTimeoutMs:100});
 const operation=await deletion.plan({ownerId:owner,requestKey:'delete-candidate-source',
  scope:{kind:'source',contactId:f.contactId,sourceId:before.sourceIds[0]}});
 const done=await deletion.advance(operation);
 assert.equal(done.state,'completed');
 const reviewed=await f.discussions.view(f.contactId,f.current.id);
 const after=await f.storage.execute('discussionIsolation.inspect',{ownerId:owner,contactId:f.contactId,discussionId:f.current.id});
 assert.equal(reviewed.entries.some(entry=>typeof entry.body==='string'&&entry.body.includes('合成聊天-a')),false);
 await f.discussions.continueDiscussion(f.contactId,f.current.id);
 assert.equal((await f.discussions.view(f.contactId,f.current.id)).entries.length,0);
 assert.equal(after.messages.some(message=>typeof message.text_body==='string'&&message.text_body.includes('合成聊天-a')),false);
});
