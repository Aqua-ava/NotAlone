import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatusCoverages } from '../src/history/sqlite/status-coverage.ts';

test('大联系人目录刷新期间前台观察可在覆盖检查之间执行', async () => {
 const queue=[],finished=[];let release;
 const gate=new Promise(resolve=>{release=resolve;});let tail=gate;
 const execute=(name,value)=>{const task=tail.then(()=>{finished.push(name);return value;});tail=task.then(()=>{});return task;};
 const bindings=Array.from({length:12},(_,i)=>({binding_id:`b${i}`,contact_id:`c${i}`,status:'active'}));
 bindings.push({binding_id:'revoked',contact_id:'revoked',status:'revoked'});
 const status=readStatusCoverages(bindings,contactId=>execute(`coverage:${contactId}`,{contactId,phase:'complete'}));
 const foreground=execute('foreground',true);release();await foreground;
 assert.deepEqual(finished,['coverage:c0','coverage:c1','coverage:c2','coverage:c3','foreground']);
 assert.deepEqual(await status,bindings.filter(b=>b.status==='active').map(b=>({contactId:b.contact_id,phase:'complete',bindingId:b.binding_id})));
});
