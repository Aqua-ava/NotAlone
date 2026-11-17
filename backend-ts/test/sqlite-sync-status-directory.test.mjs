import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteContactHttp} from '../src/contacts/sqlite/http.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';

const active={binding_id:'b1',contact_id:'c1',status:'active'};
function service(readDirectory){
 const calls=[];
 const contacts=new SqliteContactService({execute:async name=>{
  calls.push(name);
  if(name==='identity.syncDirectory')return readDirectory();
  if(name==='identity.avatarRevision')return '7';
  throw Error('不应查询联系人正文统计或读取外部渠道');
 }},owner,{});
 return {contacts,calls};
}
test('同步状态仅读取当前授权目录，不查询联系人正文统计',async()=>{
 const directory={read_enabled:true,bindings:[active,{binding_id:'b2',contact_id:'c2',status:'revoked'}]};
 const f=service(()=>directory),snapshot=await f.contacts.syncSnapshot(),result=snapshot.status;
 assert.equal(snapshot.directory,directory);
 assert.deepEqual(f.calls,['identity.syncDirectory','identity.avatarRevision']);
 assert.equal(result.sync_enabled,true);assert.equal(result.sync_scope,'selected');
 assert.equal(result.contact_avatar_revision,'7');
 assert.equal(result.cli_bound_count,1);assert.equal(result.cli_history_coverages.length,1);
 assert.equal(result.cli_history_coverages[0].contact_id,'c1');
});
test('同步状态每次重新核对授权，开启和撤销快照不合并复用',async()=>{
 let reads=0;
 const {contacts}=service(()=>++reads===1
  ?{read_enabled:true,bindings:[active]}:{read_enabled:false,bindings:[{...active,status:'revoked'}]});
 const before=(await contacts.syncSnapshot()).status,after=(await contacts.syncSnapshot()).status;
 assert.equal(reads,2);assert.equal(before.sync_enabled,true);assert.equal(before.cli_bound_count,1);
 assert.equal(after.sync_enabled,false);assert.equal(after.cli_bound_count,0);assert.deepEqual(after.cli_history_coverages,[]);
});
test('SQLite真实授权目录保持同步状态字段，并立即反映逐人撤销与总开关',async t=>{
 const f=await fixture(t),full=await f.contacts.directory();
 const status=(await f.contacts.syncSnapshot()).status;assert.equal(status.sync_enabled,full.read_enabled);
 assert.equal(status.cli_bound_count,full.bindings.filter(x=>x.status==='active').length);
 const binding=f.saved[0];await f.contacts.revoke(binding.contact_id,binding.binding_id,binding.selection_generation);
 assert.equal((await f.contacts.syncSnapshot()).status.cli_bound_count,status.cli_bound_count-1);
 await f.contacts.setReading(false);assert.equal((await f.contacts.syncSnapshot()).status.sync_enabled,false);
});

test('HTTP状态入口消费联系人快照并保留响应协议',async t=>{
 const f=service(()=>({read_enabled:true,bindings:[active]}));
 const http=new SqliteContactHttp(f.contacts);
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res))res.writeHead(404).end();});
 t.after(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sync/status`);
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const status=await response.json();
 assert.equal(status.sync_enabled,true);assert.equal(status.cli_bound_count,1);assert.equal(status.contact_avatar_revision,'7');
 assert.deepEqual(f.calls,['identity.syncDirectory','identity.avatarRevision']);
});
