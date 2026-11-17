import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {configureRetrievalConnection} from '../src/retrieval/sqlite/extension.ts';
import {rankReplyRetrieval} from '../src/retrieval/sqlite/search.ts';
import {RETRIEVAL_MODEL_FINGERPRINT} from '../src/retrieval/sqlite/contracts.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {removeRetrievalVector} from '../src/retrieval/sqlite/text-index.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {registry} from '../src/storage/sqlite/registry.ts';
import {retrievalIndexMigration} from '../src/retrieval/sqlite/schema.ts';
import {sha256} from '../src/platform/sha256.ts';

const currentVersion=registry.migrations.at(-1).version;
const original56Checksum='fa55c1ee0fb65ad7b1d9efd94fa77aa22f71056fe68de3a8cec2bc8d47c4f95a';

const vector=()=>[1,...Array(511).fill(0)];
function connect(root){
 const db=new DatabaseSync(join(root,'managed/sqlite/notalone.sqlite'),{allowExtension:true});configureRetrievalConnection(db);
 const all=(sql,values=[])=>{const st=db.prepare(sql);st.setReadBigInts(true);return st.all(...values);};
 return {db,tx:{all,get:(sql,values)=>all(sql,values)[0],run:(sql,values=[])=>{db.prepare(sql).run(...values);}}};
}
async function vectors(storage){
 const batch=await storage.execute('retrieval.claimVectorBatch',{ownerId:owner,modelFingerprint:RETRIEVAL_MODEL_FINGERPRINT,limit:16});
 const result=await storage.execute('retrieval.commitVectorBatch',{ownerId:owner,items:batch.items.map(item=>({...item,vector:vector()}))});
 return {batch,result};
}

test('真实SQLite的FTS与向量在合法联系人及冻结范围内融合，查询不重算正文',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);await f.service.synchronize(f.saved[1].contact_id);
 const management=new SqliteMemoryManagement(f.storage,owner),memory=await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'喜欢园艺和玫瑰'});
 const {db,tx}=connect(f.root);try{
  assert.equal(tx.get("SELECT count(*) n FROM retrieval_fts WHERE retrieval_fts MATCH '合成'").n,2n);
  const scope={kind:'history',displayNo:tx.get('SELECT max(display_no) n FROM message').n,dataGeneration:tx.get('SELECT data_generation n FROM contact WHERE owner_id=? AND id=?',[owner,contactId]).n};
  const base={ownerId:owner,contactId,kind:'history',query:'合成正文',scope,limit:8};
  const lexical=rankReplyRetrieval(tx,base);assert.equal(lexical.hits.length,1);assert.equal(lexical.strategy,'bm25');assert.equal(lexical.indexIncomplete,false);
  assert.equal(rankReplyRetrieval(tx,{...base,queryVector:vector()}).indexIncomplete,true);
  const indexed=await vectors(f.storage);assert.equal(indexed.result.committed,3);
  const hybrid=rankReplyRetrieval(tx,{...base,queryVector:vector()});assert.equal(hybrid.strategy,'hybrid');assert.equal(hybrid.hits.length,1);assert.equal(hybrid.indexIncomplete,false);
  assert.equal(rankReplyRetrieval(tx,{...base,scope:{...scope,messageIds:[]},queryVector:vector()}).hits.length,0);
  const recalled=rankReplyRetrieval(tx,{ownerId:owner,contactId,kind:'memory',query:'玫瑰',queryVector:vector(),scope:{kind:'memory',anchors:[{id:memory.memoryId,versionNo:1n}]},limit:5});
  assert.equal(recalled.hits[0].id,memory.memoryId);assert.equal(recalled.strategy,'hybrid');
  assert.equal((await vectors(f.storage)).batch.items.length,0);
 }finally{db.close();}
});

test('大量L0在前时L1可按层及联系人直接回填，分层游标不跳过默认历史进度',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id,otherId=f.saved[1].contact_id,count=260;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:Array.from({length:count},(_,n)=>record(String(n+1))),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const management=new SqliteMemoryManagement(f.storage,owner);
 const contact=await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'合成当前联系人的园艺偏好'});
 await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId:otherId},body:'合成其他联系人的阅读偏好'});
 const self=await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'self',contactId:null},body:'合成本人喜欢安静散步'});
 const claim=scope=>f.storage.execute('retrieval.claimVectorBatch',{ownerId:owner,modelFingerprint:RETRIEVAL_MODEL_FINGERPRINT,limit:16,...scope});
 const commit=items=>f.storage.execute('retrieval.commitVectorBatch',{ownerId:owner,items:items.map(item=>({...item,vector:vector()}))});
 const first=await claim({limit:1});assert.equal(first.items[0].kind,'history');await commit(first.items);
 const memory=await claim({kind:'memory',contactId});
 assert.deepEqual(memory.items.map(item=>item.id).sort(),[contact.memoryId,self.memoryId].sort());
 assert.ok(memory.items.every(item=>item.kind==='memory'&&(item.contactId===contactId||item.contactId===null)));
 assert.equal(memory.remaining,0);assert.equal((await commit(memory.items)).committed,2);
 assert.deepEqual(await f.storage.execute('retrieval.pending',{ownerId:owner,contactId,kind:'memory'}),{textPending:0,vectorPending:0});
 assert.deepEqual(await f.storage.execute('retrieval.pending',{ownerId:owner,kind:'memory'}),{textPending:0,vectorPending:1});
 const check=connect(f.root);let next;
 try{
  assert.ok(check.tx.get("SELECT min(id) n FROM retrieval_document WHERE kind='memory'").n>check.tx.get("SELECT max(id) n FROM retrieval_document WHERE kind='history'").n,'L1身份确实排在全部历史之后');
  next=String(check.tx.get("SELECT min(id) n FROM retrieval_document WHERE kind='history' AND vector_seal IS NULL").n);
  check.db.exec("UPDATE retrieval_document SET tokenizer_fingerprint='synthetic-prior-tokenizer'");
 }finally{check.db.close();}
 assert.deepEqual(await f.storage.execute('retrieval.syncTextBatch',{ownerId:owner,contactId,kind:'memory',limit:128}),{processed:2,remaining:0});
 assert.equal((await f.storage.execute('retrieval.pending',{ownerId:owner,contactId,kind:'history'})).textPending,count,'L1修复不消费L0队列');
 const resumed=await claim({limit:1});assert.equal(resumed.items[0].kind,'history');assert.equal(resumed.items[0].docId,next,'默认游标继续最早未完成历史，不受L1游标推进影响');
 const history=await claim({contactId,kind:'history',limit:1});assert.ok(history.items.every(item=>item.kind==='history'&&item.contactId===contactId));
 assert.equal(history.items[0].docId,next,'history独立范围没有继承memory的高位游标');
 assert.equal((await f.storage.execute('retrieval.syncTextBatch',{ownerId:owner,limit:1})).processed,1,'默认全层仍可继续历史词法回填');
 await assert.rejects(()=>f.storage.execute('retrieval.pending',{ownerId:owner,kind:'unknown'}),{code:'retrieval_request_invalid'});
});

test('正文修正使旧向量领取CAS失败，FTS同事务跟随新版本',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id,management=new SqliteMemoryManagement(f.storage,owner);
 const created=await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'偏爱园艺玫瑰'});
 const batch=await f.storage.execute('retrieval.claimVectorBatch',{ownerId:owner,modelFingerprint:RETRIEVAL_MODEL_FINGERPRINT});assert.equal(batch.items.length,1);
 const m=(await management.read({scopeKind:'contact',contactId})).memories[0];
 await management.decide({requestKey:randomUUID(),action:'correct',memoryId:created.memoryId,expectedVersionNo:m.current.versionNo,expectedHeadRevision:m.headRevision,body:'偏爱安静阅读'});
 const stale=await f.storage.execute('retrieval.commitVectorBatch',{ownerId:owner,items:batch.items.map(item=>({...item,vector:vector()}))});assert.deepEqual(stale,{committed:0,rejected:1});
 const {db,tx}=connect(f.root);try{
  assert.equal(tx.get("SELECT count(*) n FROM retrieval_fts WHERE retrieval_fts MATCH '玫瑰'").n,0n);
  assert.equal(tx.get("SELECT count(*) n FROM retrieval_fts WHERE retrieval_fts MATCH '阅读'").n,1n);
  assert.equal(tx.get('SELECT count(*) n FROM retrieval_vec').n,0n);
 }finally{db.close();}
});

test('来源删除清除消息FTS和向量，其他联系人及独立手录记忆保留',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);await f.service.synchronize(f.saved[1].contact_id);
 await new SqliteMemoryManagement(f.storage,owner).decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'独立手录园艺偏好'});
 await vectors(f.storage);
 const {db,tx}=connect(f.root);const recordId=tx.get("SELECT r.id FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id WHERE r.owner_id=? AND r.contact_id=? AND m.kind='text'",[owner,contactId]).id;
 db.close();
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const op=await deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId,sourceId:recordId}});
 assert.equal((await deletion.advance(op)).state,'completed');
 const check=connect(f.root);try{
  assert.equal(check.tx.get('SELECT count(*) n FROM retrieval_document WHERE owner_id=? AND contact_id=? AND kind=\'history\'',[owner,contactId]).n,0n);
  assert.equal(check.tx.get('SELECT count(*) n FROM retrieval_document').n,2n);
  assert.equal(check.tx.get('SELECT count(*) n FROM retrieval_fts').n,2n);assert.equal(check.tx.get('SELECT count(*) n FROM retrieval_vec').n,2n);
 }finally{check.db.close();}
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test(`55升级到${currentVersion}仅登记无正文回填身份，小批FTS完成后再领取向量`,async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/retrieval-schema55.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id;
 await f.service.synchronize(contactId);await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId});
 try{
  assert.deepEqual(await storage.execute('retrieval.pending',{ownerId:owner}),{textPending:1,vectorPending:0});
  const {db,tx}=connect(f.root);try{assert.deepEqual(tx.all('PRAGMA table_info(retrieval_text_pending)').map(r=>r.name),['owner_id','kind','entity_id','contact_id']);assert.equal(tx.get('SELECT count(*) n FROM retrieval_document').n,0n);}finally{db.close();}
  assert.deepEqual(await storage.execute('retrieval.syncTextBatch',{ownerId:owner,limit:1}),{processed:1,remaining:0});
  assert.deepEqual(await storage.execute('retrieval.pending',{ownerId:owner}),{textPending:0,vectorPending:1});
  assert.equal((await vectors(storage)).result.committed,1);
 }finally{await storage.close();}
});

test('删除向量先擦除vec0活chunk的旧槽，不能仅靠MATCH不可见或VACUUM',()=>{
 const db=new DatabaseSync(':memory:',{allowExtension:true});configureRetrievalConnection(db);
 try{
  db.exec('PRAGMA secure_delete=ON;CREATE VIRTUAL TABLE retrieval_vec USING vec0(doc_id INTEGER PRIMARY KEY,embedding FLOAT[512] distance_metric=cosine)');
  const packed=new Uint8Array(new Float32Array(Array(512).fill(0.1234567)).buffer);
  db.prepare('INSERT INTO retrieval_vec(doc_id,embedding) VALUES(?,?)').run(1n,packed);
  assert.ok(Buffer.from(db.prepare('SELECT vectors FROM retrieval_vec_vector_chunks00').get().vectors).includes(Buffer.from(packed)));
  removeRetrievalVector({run:(sql,args)=>{db.prepare(sql).run(...args);}},1n);
  assert.equal(db.prepare('SELECT count(*) n FROM retrieval_vec').get().n,0);
  assert.equal(Buffer.from(db.prepare('SELECT vectors FROM retrieval_vec_vector_chunks00').get().vectors).includes(Buffer.from(packed)),false);
 }finally{db.close();}
});

test('分词版本变化只回填过期词法表示，并复用相同正文的向量',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);await vectors(f.storage);
 const old=connect(f.root);old.db.exec("UPDATE retrieval_document SET tokenizer_fingerprint='synthetic-prior-tokenizer'");old.db.close();
 assert.deepEqual(await f.storage.execute('retrieval.pending',{ownerId:owner}),{textPending:1,vectorPending:0});
 assert.deepEqual(await f.storage.execute('retrieval.syncTextBatch',{ownerId:owner,limit:1}),{processed:1,remaining:0});
 assert.deepEqual(await f.storage.execute('retrieval.pending',{ownerId:owner}),{textPending:0,vectorPending:0});
 assert.equal((await vectors(f.storage)).batch.items.length,0);
});

for(const kind of ['contact','account'])test(`${kind}删除覆盖索引全部存储面且拒绝迟到向量`,async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id;await f.service.synchronize(contactId);await f.service.synchronize(f.saved[1].contact_id);
 const indexed=await vectors(f.storage),late=indexed.batch.items.find(item=>item.contactId===contactId);
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const scope=kind==='account'?{kind}:{kind,contactId};
 const operation=await deletion.plan({ownerId:owner,requestKey:randomUUID(),scope});
 assert.equal((await deletion.advance(operation)).state,'completed');
 assert.deepEqual(await f.storage.execute('retrieval.commitVectorBatch',{ownerId:owner,items:[{...late,vector:vector()}]}),{committed:0,rejected:1});
 const check=connect(f.root);try{
  const remaining=kind==='account'?0n:1n;
  for(const table of ['retrieval_document','retrieval_fts','retrieval_vec'])assert.equal(check.tx.get(`SELECT count(*) n FROM ${table}`).n,remaining);
  assert.equal(check.tx.get('SELECT count(*) n FROM retrieval_text_pending').n,0n);
  assert.equal(check.tx.get('SELECT count(*) n FROM retrieval_vector_cursor').n,0n);
 }finally{check.db.close();}
});

async function unfinishedUpgrade(t,kind,unknown=false,legacyVersion=55){
 const f=await fixture(t,{registryModule:new URL(`./fixtures/retrieval-schema${legacyVersion}.mjs`,import.meta.url).href}),contactId=f.saved[0].contact_id;
 await f.service.synchronize(contactId);
 await new SqliteMemoryManagement(f.storage,owner).decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'contact',contactId},body:'合成升级中的独立记忆'});
 const prior=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));
 const sourceId=prior.prepare("SELECT id FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id IS NOT NULL LIMIT 1").get(owner,contactId).id;prior.close();
 const held=new ActiveHolders();held.register({ownerId:owner,key:'synthetic-upgrade-holder',contactId,coversAllSources:true,coversAllContacts:true,generation:0n,close:async()=>{throw new Error('synthetic_holder_blocked');}});
 const deletion=new DeletionService(f.storage,held,new ManagedFiles(f.root));
 const scope=kind==='account'?{kind}:kind==='source'?{kind,contactId,sourceId}:{kind,contactId};
 const operation=await deletion.plan({ownerId:owner,requestKey:randomUUID(),scope});
 const blocked=await deletion.advance(operation);assert.equal(blocked.state,'blocked');
 if(unknown){const raw=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));raw.prepare('UPDATE deletion_operation SET domain_manifest=? WHERE operation_id=?').run('["unknown_domain"]',operation.operationId);raw.close();}
 await f.service.close();await f.contacts.close();await f.storage.close();
 const upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId});
 return {f,operation,blocked,upgraded};
}
for(const legacyVersion of [55,56])for(const kind of ['source','contact','account'])test(`${legacyVersion}→${currentVersion}升级后${kind}受阻删除沿原操作重新收集并完成`,async t=>{
 const {f,operation,blocked,upgraded}=await unfinishedUpgrade(t,kind,false,legacyVersion);
 try{
  const deletion=new DeletionService(upgraded,new ActiveHolders(),new ManagedFiles(f.root));
  const resumed=await deletion.status(operation);assert.equal(resumed.state,'fenced');assert.ok(resumed.planRevision>blocked.planRevision);
  assert.equal((await deletion.advance(operation)).state,'completed');
  assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{await upgraded.close();}
});
for(const legacyVersion of [55,56])test(`${legacyVersion}→${currentVersion}不会为未知删除manifest猜测恢复资格`,async t=>{
 const {f,operation,upgraded}=await unfinishedUpgrade(t,'source',true,legacyVersion);
 try{await assert.rejects(()=>new DeletionService(upgraded,new ActiveHolders(),new ManagedFiles(f.root)).advance(operation),{code:'deletion_registry_changed'});}
 finally{await upgraded.close();}
});

test(`最初56的checksum和无游标结构保持，正常升级到${currentVersion}且不改旧账本`,async t=>{
 assert.equal(sha256(retrievalIndexMigration(56).sql),original56Checksum,'已应用56不可再修改，后续变化必须追加迁移');
 const f=await fixture(t,{registryModule:new URL('./fixtures/retrieval-schema56.mjs',import.meta.url).href}),contactId=f.saved[0].contact_id;
 await f.service.synchronize(contactId);
 const prior=connect(f.root);let docId;
 try{
  assert.equal(prior.tx.get("SELECT name FROM sqlite_schema WHERE name='retrieval_vector_cursor'"),undefined);
  assert.equal(prior.tx.get('SELECT checksum FROM schema_migration WHERE version=56').checksum,original56Checksum);
  docId=prior.tx.get("SELECT id FROM retrieval_document WHERE kind='history'").id;
 }finally{prior.db.close();}
 await f.service.close();await f.contacts.close();await f.storage.close();
 const upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId});
 try{
  assert.equal(upgraded.status.schemaVersion,currentVersion);
  const check=connect(f.root);try{
   assert.ok(check.tx.get("SELECT name FROM sqlite_schema WHERE name='retrieval_vector_cursor'"));
   assert.equal(check.tx.get('SELECT checksum FROM schema_migration WHERE version=56').checksum,original56Checksum);
   assert.equal(check.tx.get("SELECT id FROM retrieval_document WHERE kind='history'").id,docId,'升级保留既有索引身份');
  }finally{check.db.close();}
  assert.equal((await vectors(upgraded)).result.committed,1);
  assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{await upgraded.close();}
});

test('覆盖探测与精确计数在范围、缺向量、分词过期和排队状态下等价',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id,otherId=f.saved[1].contact_id;
 const management=new SqliteMemoryManagement(f.storage,owner);
 const scopes=[{}, {contactId}, {contactId,kind:'history'}, {contactId,kind:'memory'}, {contactId:otherId,kind:'history'}, {modelFingerprint:'synthetic-other-model'}, {ownerId:'synthetic-missing-owner'}, {contactId:'synthetic-missing-contact'}];
 const equivalent=async()=>{
  for(const scope of scopes){
   const input={ownerId:owner,...scope};
   const counts=await f.storage.execute('retrieval.pending',input);
   assert.deepEqual(await f.storage.execute('retrieval.coverage',input),{indexIncomplete:counts.textPending>0||counts.vectorPending>0});
  }
 };
 await equivalent();
 await f.service.synchronize(contactId);
 await management.decide({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'self',contactId:null},body:'合成本人喜欢园艺'});
 await equivalent();
 assert.deepEqual(await f.storage.execute('retrieval.coverage',{ownerId:owner,contactId,kind:'history'}),{indexIncomplete:true});
 await vectors(f.storage);await equivalent();
 assert.deepEqual(await f.storage.execute('retrieval.coverage',{ownerId:owner,contactId,kind:'history'}),{indexIncomplete:false});
 const {db}=connect(f.root);
 try{
  db.exec("UPDATE retrieval_document SET tokenizer_fingerprint='synthetic-stale-tokenizer' WHERE kind='history'");
  await equivalent();
  db.exec('INSERT INTO retrieval_text_pending SELECT owner_id,kind,entity_id,contact_id FROM retrieval_document');
  await equivalent();
  db.exec('DELETE FROM retrieval_text_pending');
 }finally{db.close();}
 await assert.rejects(()=>f.storage.execute('retrieval.coverage',{ownerId:owner,kind:'unknown'}),{code:'retrieval_request_invalid'});
});
