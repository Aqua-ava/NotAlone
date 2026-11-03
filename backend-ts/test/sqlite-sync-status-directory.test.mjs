import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteContactHttp} from '../src/contacts/sqlite/http.ts';
import {fixture} from './fixtures/memory-sqlite/support.mjs';

const active={binding_id:'b1',contact_id:'c1',status:'active'};
test('同步状态仅读取当前授权目录，不查询联系人正文统计',async()=>{
 let reads=0;
 const http=new SqliteContactHttp({directory:async()=>{throw Error('不应读取正文统计');},
  syncDirectory:async()=>{reads++;return {read_enabled:true,bindings:[active,{binding_id:'b2',contact_id:'c2',status:'revoked'}]};}});
 const result=await http.syncStatus();
 assert.equal(reads,1);assert.equal(result.sync_enabled,true);assert.equal(result.sync_scope,'selected');
 assert.equal(result.cli_bound_count,1);assert.equal(result.cli_history_coverages.length,1);
 assert.equal(result.cli_history_coverages[0].contact_id,'c1');
});
test('同步状态每次重新核对授权，开启和撤销快照不合并复用',async()=>{
 let reads=0;
 const http=new SqliteContactHttp({directory:async()=>{throw Error('不应读取正文统计');},syncDirectory:async()=>++reads===1
  ?{read_enabled:true,bindings:[active]}:{read_enabled:false,bindings:[{...active,status:'revoked'}]}});
 const before=await http.syncStatus(),after=await http.syncStatus();
 assert.equal(reads,2);assert.equal(before.sync_enabled,true);assert.equal(before.cli_bound_count,1);
 assert.equal(after.sync_enabled,false);assert.equal(after.cli_bound_count,0);assert.deepEqual(after.cli_history_coverages,[]);
});
test('SQLite真实授权目录保持同步状态字段，并立即反映逐人撤销与总开关',async t=>{
 const f=await fixture(t),http=new SqliteContactHttp(f.contacts),full=await f.contacts.directory();
 const status=await http.syncStatus();assert.equal(status.sync_enabled,full.read_enabled);
 assert.equal(status.cli_bound_count,full.bindings.filter(x=>x.status==='active').length);
 const binding=f.saved[0];await f.contacts.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);
 assert.equal((await http.syncStatus()).cli_bound_count,status.cli_bound_count-1);
 await f.contacts.setReading(false);assert.equal((await http.syncStatus()).sync_enabled,false);
});
