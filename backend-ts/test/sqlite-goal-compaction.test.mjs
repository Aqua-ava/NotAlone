import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {owner,record,fixture,select} from './fixtures/history/sync-support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {currentSourceScopeCTE,savedSourceScopeCTE} from '../src/history/sqlite/current-scope.ts';

const DAY=86_400_000;
const databaseFile=f=>join(f.root,'managed/sqlite/notalone.sqlite');
const open=(f,readOnly=false)=>{const db=new DatabaseSync(databaseFile(f),{readOnly,enableForeignKeyConstraints:readOnly});db.function('notalone_sha256',{deterministic:true},v=>v);return db;};
const query=(f,sql,...args)=>{const db=open(f,true);try{return db.prepare(sql).all(...args);}finally{db.close();}};
const count=(f,sql,...args)=>Number(query(f,sql,...args)[0].n);
const j=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?`${v}n`:v);

/**
 * 在联系人下造一批确定 id 的合成目标：链式增量（各带一个空抓取页）、被取代的历史完成目标（各带空抓取页）、
 * 带记录的目标、被恢复操作引用的目标、宽限期内的目标。前缀区分，便于断言幸存集合。
 */
function seed(f,contactId,{chain=120,history=120,withRecord=3,fresh=2,tag='x',restore=true}={}){
 const db=open(f);
 try{
  const columns=db.prepare('SELECT name FROM pragma_table_info(?)').all('read_goal').map(c=>c.name);
  const tpl={incremental:db.prepare("SELECT * FROM read_goal WHERE contact_id=? AND kind='incremental' LIMIT 1").get(contactId),history:db.prepare("SELECT * FROM read_goal WHERE contact_id=? AND kind='history' LIMIT 1").get(contactId)};
  const insert=db.prepare(`INSERT INTO read_goal(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  const capture=db.prepare(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest,acceptance_no) VALUES(?,?,?,?,1,'rt',1,'1','a','b','accepted','d',?)`);
  let creationNo=Number(db.prepare('SELECT max(creation_no) m FROM read_goal').get().m),acceptanceNo=Number(db.prepare('SELECT coalesce(max(acceptance_no),0) m FROM sync_capture').get().m);
  const make=(id,kind,{age=3*DAY,previous=null,state='invalidated',failure='history_eligibility_changed',withCapture=true}={})=>{
   const base=tpl[kind];
   const row={...base,id,state:kind==='history'?'complete':state,failure_code:kind==='history'?null:failure,pages_accepted:kind==='history'?0n:1n,creation_no:BigInt(++creationNo),
    created_at:BigInt(Date.now()-age+creationNo),handoff_from_goal_id:previous,cursor:kind==='history'?null:base.cursor,resume_cursor:kind==='history'?'tail-seed':base.resume_cursor};
   insert.run(...columns.map(c=>row[c]));if(withCapture)capture.run(base.owner_id,randomUUID(),contactId,id,++acceptanceNo);return id;
  };
  let previous=null;const ids={chain:[],history:[],record:[],fresh:[],restored:null};
  for(let i=0;i<history;i++)ids.history.push(make(`seed-${tag}-history-${i}`,'history'));
  for(let i=0;i<chain;i++){ids.chain.push(make(`seed-${tag}-chain-${i}`,'incremental',{previous}));previous=`seed-${tag}-chain-${i}`;}
  for(let i=0;i<withRecord;i++)ids.record.push(make(`seed-${tag}-record-${i}`,'history'));
  for(const id of ids.record){
   const cap=db.prepare('SELECT id FROM sync_capture WHERE goal_id=?').get(id),template=db.prepare('SELECT * FROM capture_record LIMIT 1').get(),cols=Object.keys(template);
   db.prepare(`INSERT INTO capture_record(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>c==='id'?randomUUID():c==='capture_id'?cap.id:c==='item_no'?901:template[c]));
  }
  ids.restored=make(`seed-${tag}-restored`,'incremental');
  if(restore)db.prepare(`INSERT INTO history_restore(owner_id,request_key,contact_id,authorization_id,conversation_id,binding_id,verification_id,grant_id,selection_generation,barrier_generation,cutoff_operation_id,goal_id,state,created_at)
   SELECT owner_id,'restore-key-'||?,contact_id,'authorization-'||?,(SELECT conversation_id FROM conversation_binding WHERE contact_id=g.contact_id LIMIT 1),binding_id,'verification-'||?,grant_id,1,0,NULL,id,'authorized',1 FROM read_goal g WHERE id=?`).run(tag,tag,tag,ids.restored);
  for(let i=0;i<fresh;i++)ids.fresh.push(make(`seed-${tag}-fresh-${i}`,'incremental',{age:0}));
  return ids;
 }finally{db.close();}
}
async function prepared(t,names=['a','b']){
 const f=await fixture(t,names);f.state.historyRecords=[record('1')];await select(f);
 // 联系人 ID 是随机 UUID，目录顺序会变；按显示名固定顺序，才能在两个库之间逐个对应。
 const bindings=[...(await f.contacts.directory()).bindings].sort((x,y)=>String(x.display_name).localeCompare(String(y.display_name)));
 for(const b of bindings)await f.history.synchronize(b.contact_id);
 return {f,contacts:bindings.map(b=>b.contact_id)};
}
const compact=(f,contactId,{dryRun=false,limit=200}={})=>f.storage.execute('history.compactGoals',{ownerId:owner,contactId,dryRun,limit});
async function drain(f,contactId){let deleted=0,batches=0;for(;;){const r=await compact(f,contactId);if(r.skipped)return {deleted,batches,skipped:r.skipped};if(!r.deleted)return {deleted,batches,skipped:null};assert.ok(r.deleted<=200);deleted+=r.deleted;batches++;}}
const surviving=(f,ids)=>new Set(query(f,`SELECT id FROM read_goal WHERE id IN (${ids.map(()=>'?').join(',')})`,...ids).map(r=>r.id));
const allSeedIds=ids=>[...ids.chain,...ids.history,...ids.record,ids.restored,...ids.fresh];
const digest=f=>createHash('sha256').update(j(['read_goal','sync_capture','capture_record','history_restore','message','source_proof','contact'].map(t=>query(f,`SELECT * FROM ${t} ORDER BY 1,2`)))).digest('hex');

test('试算不改任何行，且与逐批实际删除的总数、批数一致；重复执行幂等',async t=>{
 const {f,contacts}=await prepared(t);const ids=seed(f,contacts[0]);
 const before=digest(f);
 const dry=await compact(f,contacts[0],{dryRun:true});
 assert.equal(digest(f),before,'试算后库内容逐字节不变');
 assert.equal(dry.skipped,null);assert.equal(dry.deleted,0);assert.ok(dry.projectedTotal>=200,'造数量足以跨多批');assert.equal(dry.projectedTruncated,false);
 const actual=await drain(f,contacts[0]);
 assert.equal(actual.deleted,dry.projectedTotal,'实际总数＝试算总数');assert.equal(actual.batches,dry.projectedBatches);
 assert.ok(actual.batches>=2);
 const again=await compact(f,contacts[0],{dryRun:true});assert.equal(again.projectedTotal,0);
 assert.equal((await compact(f,contacts[0])).deleted,0,'再次执行没有可删目标');
 // 保留集合：带记录、被恢复引用、宽限期内的目标仍在；清理掉的都是无记录的链与历史空目标。
 const left=surviving(f,allSeedIds(ids));
 for(const id of [...ids.record,ids.restored,...ids.fresh])assert.ok(left.has(id),`${id} 应保留`);
 assert.ok(ids.chain.filter(id=>left.has(id)).length<=2,'链上无记录目标基本清空（最多保留最新前驱）');
 assert.equal(ids.history.filter(id=>left.has(id)).length,0);
 assert.equal(count(f,'SELECT count(*) n FROM sync_capture WHERE goal_id IN (SELECT id FROM read_goal WHERE id LIKE ?)','seed-x-record-%'),3,'带记录目标的抓取页保留');
 assert.equal(count(f,"SELECT count(*) n FROM capture_record WHERE item_no=901"),3);
});

test('中途中断后重跑：与一次性排空得到相同的幸存集合',async t=>{
 const one=await prepared(t),two=await prepared(t);
 const big={chain:300,history:300,tag:'x'};
 const idsOne=seed(one.f,one.contacts[0],big),idsTwo=seed(two.f,two.contacts[0],big);
 await drain(one.f,one.contacts[0]);
 // 第二个库只做两批就“中断”（关闭存储），重新打开后继续。
 for(let i=0;i<2;i++)assert.equal((await compact(two.f,two.contacts[0])).deleted,200);
 const databaseId=two.f.storage.status.databaseId;
 await two.f.history.close();await two.f.storage.close();
 const reopened=await SqliteStorage.open({userData:two.f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});
 t.after(()=>reopened.close());
 two.f.storage=reopened;
 const rest=await drain(two.f,two.contacts[0]);assert.ok(rest.deleted>0);
 assert.deepEqual([...surviving(two.f,allSeedIds(idsTwo))].sort(),[...surviving(one.f,allSeedIds(idsOne))].sort());
});

test('删除中的联系人被跳过（围栏、已计划未结案的删除操作、联系人状态），其余联系人照常压缩',async t=>{
 const {f,contacts}=await prepared(t);const [a,b]=contacts;
 const idsA=seed(f,a,{tag:'a',restore:false}),idsB=seed(f,b,{tag:'b',restore:false});
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root),{drainTimeoutMs:20});
 const operation=await deletion.plan({ownerId:owner,requestKey:'compaction-skip-delete',scope:{kind:'contact',contactId:a}});
 const before=count(f,'SELECT count(*) n FROM read_goal WHERE contact_id=?',a);
 const skipped=await compact(f,a);
 assert.equal(skipped.skipped,'contact_not_active');assert.equal(skipped.deleted,0);
 assert.equal((await compact(f,a,{dryRun:true})).skipped,'contact_not_active');
 assert.equal(count(f,'SELECT count(*) n FROM read_goal WHERE contact_id=?',a),before,'计划中的删除目标集合不被改动');
 assert.ok((await compact(f,b)).deleted>0,'另一联系人照常压缩');
 assert.equal((await deletion.advance(operation)).state,'completed');
 assert.equal(count(f,'SELECT count(*) n FROM read_goal WHERE contact_id=?',a),0);
 // 联系人仍 active 但存在未结案的删除操作／围栏时同样跳过。
 const c=await prepared(t);const [ca]=c.contacts;seed(c.f,ca,{restore:false});
 const db=open(c.f);try{db.prepare("INSERT INTO history_deletion_fence(owner_id,contact_id,operation_id) VALUES(?,?,'op')").run(owner,ca);}finally{db.close();}
 assert.equal((await compact(c.f,ca)).skipped,'deletion_in_progress');
 assert.ok(idsA.chain.length&&idsB.chain.length);
});

test('排空前后：当前历史范围、读取、覆盖、再同步与联系人删除结果与未排空对照一致，另一联系人不受影响',async t=>{
 const control=await prepared(t),drained=await prepared(t);
 seed(control.f,control.contacts[0],{restore:false});const ids=seed(drained.f,drained.contacts[0],{restore:false});
 const scope=side=>{const db=open(side.f,true);try{return [currentSourceScopeCTE,savedSourceScopeCTE].map(cte=>[[owner,null,null],...side.contacts.map(c=>[owner,1,c])].map(params=>db.prepare(`WITH ${cte} SELECT contact_id,target_json FROM current_history_scope ORDER BY contact_id,binding_id`).all(...params).map(r=>r.target_json).sort()));}finally{db.close();}};
 const view=async side=>{const out=[];for(const id of side.contacts){const read=await side.f.history.read(id),c=read.coverage;
  out.push({messages:read.messages.map(m=>[m.text,m.sourceRecordIds.length]),coverage:[c.phase,c.failureCode,c.traversalComplete,c.savedHistoryComplete,c.messageCount,c.incremental.phase,c.incremental.failureCode,c.incremental.pagesAccepted]});}return out;};
 const beforeScope=j(scope(drained)),beforeView=j(await view(drained));
 assert.equal(beforeScope,j(scope(control)));
 const result=await drain(drained.f,drained.contacts[0]);assert.ok(result.deleted>200);
 assert.equal(j(scope(drained)),beforeScope,'排空前后当前历史范围逐字节相同');
 assert.equal(j(await view(drained)),beforeView,'排空前后读取与覆盖一致');
 assert.equal(j(await view(drained)),j(await view(control)),'与未排空对照一致');
 // 增量续读：再同步一条新消息，两侧同样增长。
 for(const side of [control,drained]){for(let i=0;i<2;i++){await side.f.contacts.setReading(false);await side.f.contacts.setReading(true);side.f.state.historyRecords=[record('1'),record('2')];await side.f.history.synchronize(side.contacts[0]);}}
 assert.equal(j(await view(drained)),j(await view(control)),'再同步后一致');
 // 删除：两侧联系人 0 都完成并清零，联系人 1 不受影响且一致。
 for(const side of [control,drained]){
  const deletion=new DeletionService(side.f.storage,new ActiveHolders(),new ManagedFiles(side.f.root),{drainTimeoutMs:20});
  const operation=await deletion.plan({ownerId:owner,requestKey:'compaction-delete',scope:{kind:'contact',contactId:side.contacts[0]}});
  assert.equal((await deletion.advance(operation)).state,'completed');
  for(const table of ['message','capture_record','sync_capture','read_goal'])assert.equal(count(side.f,`SELECT count(*) n FROM ${table} WHERE contact_id=?`,side.contacts[0]),0,table);
 }
 const other=side=>j(['message','capture_record','sync_capture','read_goal'].map(table=>count(side.f,`SELECT count(*) n FROM ${table} WHERE contact_id=?`,side.contacts[1])));
 assert.equal(other(drained),other(control));
 assert.ok(ids.chain.length);
});

test('输入校验与结果结构：非法批量上限、非布尔试算开关被拒绝',async t=>{
 const {f,contacts}=await prepared(t,['a']);
 for(const bad of [{limit:0},{limit:201},{limit:1.5},{dryRun:'yes'}])await assert.rejects(f.storage.execute('history.compactGoals',{ownerId:owner,contactId:contacts[0],dryRun:false,limit:200,...bad}),error=>error instanceof StorageFailure&&error.code==='history_compaction_invalid');
 const r=await compact(f,contacts[0]);assert.deepEqual(Object.keys(r).sort(),['contactId','deleted','projectedBatches','projectedTotal','projectedTruncated','skipped']);
 assert.equal((await compact(f,'no-such-contact')).skipped,'contact_not_active');
});
