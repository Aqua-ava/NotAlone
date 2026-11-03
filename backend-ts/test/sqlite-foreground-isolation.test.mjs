import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {ContactMetadataLifetime} from '../src/storage/sqlite/deletion/contact-metadata.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {SqliteForeground} from '../src/foreground/sqlite-foreground.ts';

const registryModule=new URL('./fixtures/sqlite/foreground-isolation-registry.mjs',import.meta.url).href;
async function foregroundFixture(t){
 const f=await fixture(t,{registryModule}),holders=new ActiveHolders();
 const contacts=new ContactMetadataLifetime(f.storage,owner,holders,()=>({account:async()=>{throw new Error('本测试不读取渠道');},sessions:async()=>[],close:async()=>{}}));
 await contacts.initialize();
 const snapshot=await contacts.foregroundSnapshot(),binding=snapshot.bindings[0];
 const probe={observe:async()=>({wechat_in_front:true,display_name:binding.display_name,captured_at:new Date().toISOString(),capture_version:'automatic-header-v4',quality:{layout_verified:true,name_complete:true,display_name_confidence:.98}}),close:async()=>{},dispose:async()=>{}};
 const foreground=new SqliteForeground({ownerId:owner,probe,snapshot:()=>contacts.foregroundSnapshot(),sessions:async()=>[{username:binding.conversation_locator,display_name:binding.display_name,chat_type:'private'}],closeSessions:async()=>{}});
 t.after(async()=>{await foreground.close();await contacts.close();});
 return {...f,contacts,holders,foreground,probe,binding};
}

test('后台长SQL尚未完成时，正式前台链路仍能匹配已有联系人',{timeout:30_000},async t=>{
 const f=await foregroundFixture(t);
 assert.equal((await f.foreground.observe()).contact_id,f.binding.contact_id);
 const ready=new Int32Array(new SharedArrayBuffer(4));let completed=false;
 const began=performance.now();
 const scanning=f.storage.execute('foregroundTest.scan',{ready:ready.buffer}).finally(()=>{completed=true;});
 await Atomics.waitAsync(ready,0,0,10_000).value;
 assert.equal(Atomics.load(ready,0),1,'后台SQL应已开始执行');
 try{
  const start=performance.now(),result=await f.foreground.observe(),elapsed=performance.now()-start;
  t.diagnostic(`前台匹配 ${elapsed.toFixed(1)}ms，后台查询完成=${completed}`);
  assert.equal(result.phase,'confirmed');assert.equal(result.contact_id,f.binding.contact_id);
  assert.equal(completed,false,'前台不应等待后台SQL结束');
  assert.ok(elapsed<1000,`前台身份读取不应出现秒级排队，实际 ${elapsed.toFixed(1)}ms`);
 }finally{await scanning;t.diagnostic(`后台长查询 ${(performance.now()-began).toFixed(1)}ms`);}
});

test('联系人删除排空前台读者，在途识别不接受旧身份且其他联系人可重新读取',async t=>{
 const f=await foregroundFixture(t);
 let release,start;const started=new Promise(resolve=>{start=resolve;});
 const original=f.probe.observe;
 f.probe.observe=async()=>{start();await new Promise(resolve=>{release=resolve;});return original();};
 const observation=f.foreground.observe();await started;
 await f.storage.execute('foregroundTest.removeContact',{ownerId:owner,contactId:f.binding.contact_id});
 const operation={ownerId:owner,scope:{kind:'contact',contactId:f.binding.contact_id},acceptedGeneration:1n};
 await f.holders.drain(operation,[],2000);
 assert.equal(f.holders.verify(operation,[]),true,'删除必须真正排空名单及其附属读者');
 release();
 await assert.rejects(observation,{code:'foreground_observation_cancelled'});
 const current=await f.contacts.foregroundSnapshot();
 assert.equal(current.bindings.some(row=>row.contact_id===f.binding.contact_id),false);
 assert.equal(current.bindings.length,1,'删除其他联系人后仍能重新读取现有名单');
});
