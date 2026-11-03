import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatusCoverages } from '../src/history/sqlite/status-coverage.ts';
import { fixture } from './fixtures/memory-sqlite/support.mjs';

test('大联系人目录每批最多四位，前台观察可在每批之间执行', async () => {
 const finished=[];let release;
 const gate=new Promise(resolve=>{release=resolve;});let tail=gate;
 const execute=(name,value)=>{const task=tail.then(()=>{finished.push(name);return value;});tail=task.then(()=>{});return task;};
 const bindings=Array.from({length:9},(_,i)=>({binding_id:`b${i}`,contact_id:`c${i}`,status:'active'}));
 bindings.splice(2,0,{binding_id:'revoked',contact_id:'revoked',status:'revoked'});
 const status=readStatusCoverages(bindings,async()=>{throw new Error('批量读取应负责联系人范围');},contactIds=>{
  const reading=execute(`coverage:${contactIds.length}`,contactIds.map(contactId=>({contactId,phase:'complete'})));
  // 模拟每批入队后到达的前台请求，应先于下一批后台覆盖执行。
  void execute('foreground',true);return reading;
 });
 release();
 assert.deepEqual(await status,bindings.filter(b=>b.status==='active').map(b=>({contactId:b.contact_id,phase:'complete',bindingId:b.binding_id})));
 await tail;
 assert.deepEqual(finished,['coverage:4','foreground','coverage:4','foreground','coverage:1','foreground']);
});

test('状态批量响应必须与请求联系人一一对应', async () => {
 const bindings=[{binding_id:'b1',contact_id:'c1',status:'active'}];
 await assert.rejects(readStatusCoverages(bindings,async()=>({contactId:'c1',phase:'complete'}),async()=>[]),/覆盖/);
 await assert.rejects(readStatusCoverages(bindings,async()=>({contactId:'c1',phase:'complete'}),async()=>[{contactId:'other',phase:'complete'}]),/覆盖/);
});

test('SQLite 批量历史覆盖与逐联系人覆盖保持一致并限制每批规模', async t => {
 const f=await fixture(t),ids=f.saved.map(binding=>binding.contact_id);
 await f.service.synchronize(ids[0]);
 const expected=await Promise.all(ids.map(contactId=>f.service.coverage(contactId)));
 assert.deepEqual(await f.service.coverages(ids),expected);
 assert.throws(()=>f.service.coverages(Array.from({length:17},()=>ids[0])),{code:'history_request_invalid'});
});
