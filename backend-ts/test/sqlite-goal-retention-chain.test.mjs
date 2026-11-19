import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {owner,record,fixture,select} from './fixtures/history/sync-support.mjs';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const DAY=86_400_000;
const databaseFile=f=>join(f.root,'managed/sqlite/notalone.sqlite');
const open=(f,readOnly=false)=>{const db=new DatabaseSync(databaseFile(f),{readOnly,enableForeignKeyConstraints:!readOnly?false:true});db.function('notalone_sha256',{deterministic:true},v=>v);return db;};
const query=(f,sql,...args)=>{const db=open(f,true);try{return db.prepare(sql).all(...args);}finally{db.close();}};
const count=(f,sql,...args)=>Number(query(f,sql,...args)[0].n);
const j=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?`${v}n`:v);

/** 复制已有增量目标作模板，造 n 个已作废、已过期、无记录的增量目标；chain 为真时按 handoff_from_goal_id 串成链（真实运行中新增量目标交接自上一检查点）。 */
function seedIncrementals(f,contactId,n,{chain,failure='history_eligibility_changed',capturesPerGoal=0}={}){
 const db=open(f);
 try{
  const columns=db.prepare('SELECT name FROM pragma_table_info(?)').all('read_goal').map(c=>c.name);
  const template=db.prepare("SELECT * FROM read_goal WHERE contact_id=? AND kind='incremental' LIMIT 1").get(contactId);
  const insert=db.prepare(`INSERT INTO read_goal(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  const capture=db.prepare(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest,acceptance_no) VALUES(?,?,?,?,1,'rt',1,'1','a','b','accepted','d',?)`);
  let creationNo=Number(db.prepare('SELECT max(creation_no) m FROM read_goal').get().m),acceptanceNo=Number(db.prepare('SELECT coalesce(max(acceptance_no),0) m FROM sync_capture').get().m);
  const ids=[];let previous=null;
  for(let i=0;i<n;i++){
   const id=randomUUID();
   const row={...template,id,state:'invalidated',failure_code:failure,pages_accepted:1n,creation_no:BigInt(++creationNo),created_at:BigInt(Date.now()-3*DAY-(n-i)),handoff_from_goal_id:chain?previous:null};
   insert.run(...columns.map(c=>row[c]));
   for(let c=0;c<capturesPerGoal;c++)capture.run(template.owner_id,randomUUID(),contactId,id,++acceptanceNo);
   ids.push(id);previous=id;
  }
  return ids;
 }finally{db.close();}
}
const alive=(f,id)=>count(f,'SELECT count(*) n FROM read_goal WHERE id=?',id)===1;
const seededLeft=(f,ids)=>count(f,`SELECT count(*) n FROM read_goal WHERE id IN (${ids.map(()=>'?').join(',')})`,...ids);
async function round(f,contactId){await f.contacts.setReading(false);await f.contacts.setReading(true);f.state.historyRecords=[record('1')];await f.history.synchronize(contactId);}
async function prepared(t,names=['a']){
 const f=await fixture(t,names);f.state.historyRecords=[record('1')];
 const bindings=[];const binding=await select(f);
 for(const b of (await f.contacts.directory()).bindings){await f.history.synchronize(b.contact_id);bindings.push(b);}
 return {f,binding,bindings};
}

test('增量目标按 handoff 串成链时，清理仍随新建目标逐批进行，只保留最新增量及其直接前驱',async t=>{
 const {f,binding}=await prepared(t);
 const ids=seedIncrementals(f,binding.contact_id,300,{chain:true});
 assert.equal(seededLeft(f,ids),300);
 for(let i=0;i<12;i++)await round(f,binding.contact_id);
 // 旧实现：整条链互相引用，每轮只能清理链尾约 1 个，12 轮后仍剩 289；现在应近乎清空。
 assert.ok(seededLeft(f,ids)<=3,`链上无记录的旧目标应被清理，实际剩余 ${seededLeft(f,ids)}`);
 const latest=query(f,"SELECT id,handoff_from_goal_id FROM read_goal WHERE contact_id=? AND kind='incremental' AND creation_no IS NOT NULL ORDER BY creation_no DESC LIMIT 1",binding.contact_id)[0];
 if(latest.handoff_from_goal_id)assert.ok(alive(f,latest.handoff_from_goal_id),'最新增量目标的直接前驱保留，交接来源展示保持有效');
});

test('不被引用的同类目标清理速度不变（对照）',async t=>{
 const {f,binding}=await prepared(t);
 const ids=seedIncrementals(f,binding.contact_id,300,{chain:false});
 for(let i=0;i<12;i++)await round(f,binding.contact_id);
 assert.equal(seededLeft(f,ids),0);
});

test('保留集合：带记录的目标及其前驱、被恢复操作引用的目标、宽限期内的目标及其前驱都不被清理',async t=>{
 const {f,binding}=await prepared(t);
 const contactId=binding.contact_id;
 // 链 a←b←c←d（旧到新）：b 名下有记录，c、d 无记录；a 被 b 引用，b 因带记录必须保留，故 a 也保留。
 const [a,b,c,d]=seedIncrementals(f,contactId,4,{chain:true});
 // 仅被无记录目标引用的单独链 x←y：二者都应清理。
 const [x,y]=seedIncrementals(f,contactId,2,{chain:true});
 {
  const db=open(f);try{
   const captureId=randomUUID(),template=db.prepare('SELECT * FROM capture_record LIMIT 1').get();
   db.prepare(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest,acceptance_no) VALUES(?,?,?,?,1,'rt',1,'1','a','b','accepted','d',(SELECT max(acceptance_no)+1 FROM sync_capture))`).run(template.owner_id,captureId,contactId,b);
   const columns=Object.keys(template);
   db.prepare(`INSERT INTO capture_record(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(column=>column==='id'?randomUUID():column==='capture_id'?captureId:column==='item_no'?900:template[column]));
  }finally{db.close();}
 }
 const [restored]=seedIncrementals(f,contactId,1,{chain:false});
 {const db=open(f);try{db.prepare(`INSERT INTO history_restore(owner_id,request_key,contact_id,authorization_id,conversation_id,binding_id,verification_id,grant_id,selection_generation,barrier_generation,cutoff_operation_id,goal_id,state,created_at)
  SELECT owner_id,'restore-key',contact_id,'authorization-1',(SELECT conversation_id FROM conversation_binding WHERE contact_id=g.contact_id LIMIT 1),binding_id,'verification-1',grant_id,1,0,NULL,id,'authorized',1 FROM read_goal g WHERE id=?`).run(restored);}finally{db.close();}}
 // 宽限期内（刚作废）的目标不清理，其前驱同样保留。
 const [graceOld,fresh]=seedIncrementals(f,contactId,2,{chain:true});
 {const db=open(f);try{db.prepare("UPDATE read_goal SET created_at=? WHERE id=?").run(BigInt(Date.now()),fresh);}finally{db.close();}}
 for(let i=0;i<6;i++)await round(f,contactId);
 for(const [name,id] of [['带记录的 b',b],['b 引用的前驱 a',a],['恢复引用',restored],['宽限期内的 fresh',fresh],['fresh 引用的前驱',graceOld]])assert.ok(alive(f,id),`${name}应保留`);
 for(const [name,id] of [['c',c],['d',d],['x',x],['y',y]])assert.ok(!alive(f,id),`${name}（无记录，仅被可清理目标引用）应清理`);
 assert.equal(count(f,'SELECT count(*) n FROM sync_capture WHERE goal_id=?',b),1,'带记录目标的抓取页保留');
 assert.equal((await f.history.read(contactId)).messages.length,1);
});

test('清理链上目标后：读取、覆盖、再同步与联系人删除结果与未清理的对照一致，其他联系人不受影响',async t=>{
 const control=await prepared(t,['a','b']),compacted=await prepared(t,['a','b']);
 const [contactA,contactB]=[0,1].map(i=>({control:control.bindings[i].contact_id,compacted:compacted.bindings[i].contact_id}));
 const ids=seedIncrementals(compacted.f,contactA.compacted,300,{chain:true});
 for(let i=0;i<12;i++){await round(control.f,contactA.control);await round(compacted.f,contactA.compacted);}
 assert.ok(seededLeft(compacted.f,ids)<=3);
 assert.ok(count(compacted.f,'SELECT count(*) n FROM read_goal WHERE contact_id=?',contactA.compacted)<=count(control.f,'SELECT count(*) n FROM read_goal WHERE contact_id=?',contactA.control)+3,'清理后目标数与未造链的对照同阶');
 const view=async(side,contacts)=>{
  const out={};
  for(const key of ['a','b']){
   const id=key==='a'?contacts[0]:contacts[1];const read=await side.f.history.read(id);const c=read.coverage;
   out[key]={messages:read.messages.map(m=>[m.text,m.sourceRecordIds.length]),coverage:{phase:c.phase,failureCode:c.failureCode,traversalComplete:c.traversalComplete,savedHistoryComplete:c.savedHistoryComplete,
     messageCount:c.messageCount,pageCount:c.pageCount,incremental:{phase:c.incremental.phase,failureCode:c.incremental.failureCode,pagesAccepted:c.incremental.pagesAccepted}}};
  }
  return out;
 };
 const pair=[[contactA.control,contactB.control],[contactA.compacted,contactB.compacted]];
 assert.equal(j(await view(compacted,pair[1])),j(await view(control,pair[0])),'清理后读取与覆盖一致');
 // 再同步幂等：同一页重读后消息与来源数不变；新增一条消息两侧同样增长。
 for(const side of [control,compacted]){side.f.state.historyRecords=[record('1'),record('2')];}
 for(const [side,contacts] of [[control,pair[0]],[compacted,pair[1]]]){await round(side.f,contacts[0]);side.f.state.historyRecords=[record('1'),record('2')];await side.f.history.synchronize(contacts[0]);}
 assert.equal(j(await view(compacted,pair[1])),j(await view(control,pair[0])),'再同步后一致');
 const tables=(side,contactId)=>Object.fromEntries(['message','capture_record','sync_capture','read_goal','source_proof'].map(table=>[table,count(side.f,`SELECT count(*) n FROM ${table} WHERE contact_id=?`,contactId)]));
 const factsA=tables(compacted,contactA.compacted),factsControlA=tables(control,contactA.control);
 assert.equal(factsA.message,factsControlA.message);assert.equal(factsA.capture_record,factsControlA.capture_record);
 // 联系人删除：两侧都完成，该联系人各表清零，另一联系人资料不变。
 const beforeB=[tables(control,contactB.control),tables(compacted,contactB.compacted)];
 for(const [side,contacts,label] of [[control,pair[0],'对照'],[compacted,pair[1],'清理后']]){
  const deletion=new DeletionService(side.f.storage,new ActiveHolders(),new ManagedFiles(side.f.root),{drainTimeoutMs:20});
  const operation=await deletion.plan({ownerId:owner,requestKey:`delete-${label}`,scope:{kind:'contact',contactId:contacts[0]}});
  assert.equal((await deletion.advance(operation)).state,'completed',label);
  const left=tables(side,contacts[0]);
  for(const table of ['message','capture_record','sync_capture','read_goal'])assert.equal(left[table],0,`${label}：${table} 应清零`);
 }
 assert.equal(j(tables(control,contactB.control)),j(beforeB[0]));assert.equal(j(tables(compacted,contactB.compacted)),j(beforeB[1]));
 assert.equal(j(tables(compacted,contactB.compacted)),j(tables(control,contactB.control)),'另一联系人在两侧一致');
 assert.equal((await compacted.f.history.read(contactB.compacted)).messages.length,1);
});
