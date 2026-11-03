import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import * as source from '../src/history/sqlite/source.ts';

async function sourceFixture(t){
 const f=await fixture(t);for(const binding of f.saved)await f.service.synchronize(binding.contact_id);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const tx={get(sql,values=[]){const q=db.prepare(sql);q.setReadBigInts(true);return q.get(...values);},all(sql,values=[]){const q=db.prepare(sql);q.setReadBigInts(true);return q.all(...values);},run(sql,values=[]){db.prepare(sql).run(...values);}};
 const refs=tx.all("SELECT r.owner_id,r.contact_id,r.id AS record_id,r.message_id FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.id=r.message_id WHERE m.kind='text' ORDER BY r.contact_id");
 assert.equal(refs.length,2);
 return {tx,refs};
}

test('批量来源资格保留合法引用、顺序和重复项，不把部分失效扩散到其他联系人',async t=>{
 const {tx,refs:[a,b]}=await sourceFixture(t);
 assert.equal(typeof source.eligibleSourceReferences,'function');
 const bad={...a,record_id:'synthetic-missing-source'},wrongContact={...a,contact_id:b.contact_id},wrongOwner={...a,owner_id:'00000000-0000-4000-8000-999999999999'};
 assert.deepEqual(source.eligibleSourceReferences(tx,[b,bad,a,wrongContact,a,wrongOwner]),[b,a,a]);
 let reads=0;const measured={...tx,get(sql,values){reads++;return tx.get(sql,values);},all(sql,values){reads++;return tx.all(sql,values);}};
 const many=Array.from({length:500},()=>a);
 assert.deepEqual(source.eligibleSourceReferences(measured,many),many);
 assert.equal(reads,1,'同一联系人批量来源只应执行一次资格查询');
});

test('来源失效后批量结果和原有强制资格断言保持相同拒绝规则',async t=>{
 const {tx,refs:[a,b]}=await sourceFixture(t);
 assert.equal(typeof source.eligibleSourceReferences,'function');
 tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[owner,a.contact_id,a.record_id]);
 assert.deepEqual(source.eligibleSourceReferences(tx,[a,b]),[b]);
 assert.throws(()=>source.assertSourcesEligibility(tx,[a,b]),{code:'history_source_not_available'});
 assert.doesNotThrow(()=>source.assertSourceEligibility(tx,b));
});
