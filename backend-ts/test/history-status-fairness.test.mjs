import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatusCoverages } from '../src/history/sqlite/status-coverage.ts';
import { fixture } from './fixtures/memory-sqlite/support.mjs';

test('大联系人目录按有界批量读取覆盖，批次间允许前台观察', async () => {
 const queue=[],finished=[];let release;
 const gate=new Promise(resolve=>{release=resolve;});let tail=gate;
 const execute=(name,value)=>{const task=tail.then(()=>{finished.push(name);return value;});tail=task.then(()=>{});return task;};
 const bindings=Array.from({length:33},(_,i)=>({binding_id:`b${i}`,contact_id:`c${i}`,status:'active'}));
 bindings.push({binding_id:'revoked',contact_id:'revoked',status:'revoked'});
 const status=readStatusCoverages(bindings,async()=>{throw new Error('批量读取应负责联系人范围');},contactIds=>execute(`coverage:${contactIds.length}`,contactIds.map(contactId=>({contactId,phase:'complete'}))));
 const foreground=execute('foreground',true);release();await foreground;
 assert.equal(finished[0],'coverage:16');
 assert.equal(finished.indexOf('foreground'),1);
 assert.deepEqual(await status,bindings.filter(b=>b.status==='active').map(b=>({contactId:b.contact_id,phase:'complete',bindingId:b.binding_id})));
 assert.deepEqual(finished,['coverage:16','foreground','coverage:16','coverage:1']);
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
