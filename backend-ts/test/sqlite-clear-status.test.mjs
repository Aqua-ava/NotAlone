import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { historyClearActions } from '../src/history/sqlite/clear-actions.ts';
import { fixture, owner, record } from './sqlite-clear-support.mjs';

test('清空状态逐消息按同一联系人的来源索引查找，不扫描账号全部来源',async t=>{
 const f=await fixture(t);
 f.state.pageRecords=[record('shard-a','1'),record('shard-a','2',{kind:'voice',text:null}),
  record('shard-b','3',{stateAssurance:'unverified',text:null})];
 await f.current.history.synchronize(f.contactA);
 f.state.pageRecords=Array.from({length:12},(_,index)=>record('shard-a',String(index+1)));
 await f.current.history.synchronize(f.contactB);
 const expected=await f.current.storage.execute('history.clearStatus',{ownerId:owner,contactId:f.contactA});
 assert.equal(expected.storedMessages,2);assert.equal(expected.storedSources,3);assert.equal(expected.openGoals,1);
 assert.equal(expected.phase,'none');assert.equal(expected.completed,false);

 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 const provenancePlans=[];
 const all=(sql,args=[])=>{
  if(sql.includes('FROM message')&&sql.includes('EXISTS')){
   provenancePlans.push(...db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(row=>row.detail));
  }
  const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...args);
 };
 try{
  const action=historyClearActions.find(action=>action.name==='history.clearStatus');
  const actual=action.execute({all,get:(sql,args)=>all(sql,args)[0],run:()=>{throw Error('只读状态不得写入');}},
   {ownerId:owner,contactId:f.contactA});
  assert.deepEqual(actual,expected);
  // 这里约束实际 SQLite 执行计划，避免每条消息再次遍历该账号的所有捕获记录。
  assert.ok(provenancePlans.some(plan=>plan.startsWith('SEARCH r ')
   &&plan.includes('contact_id=?')&&plan.includes('message_id=?')),provenancePlans.join('\n'));
 }finally{db.close();}
});
