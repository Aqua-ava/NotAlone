import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostStorage } from '../src/platform/database/host-storage.ts';
import { MemoryService } from '../src/memory/records/service.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

test('管理入口只展示所选联系人有效来源资料，保留原UUID与auto并允许空目录', async () => {
  const f = await createStorageFixture();
  let storage;
  try {
    storage = await HostStorage.open(f.options);
    const {owner_id: owner} = await storage.initializeOwner('合成本人');
    const a=randomUUID(),b=randomUUID(),source=randomUUID(),memory=randomUUID();
    for (const id of [a,b]) await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[id,owner,'合成同名']);
    await f.client.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,a,'a'.repeat(64)]);
    await f.client.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,$3,'喜欢清淡食物','preference',$4,'auto')",[memory,owner,a,[source]]);
    const service = new MemoryService(storage);
    const read = contact => service.handle('GET',new URL(`http://localhost/api/contacts/${contact}/memories`));
    const result=await read(a);
    assert.equal(result.memories.length,1);
    assert.equal(result.memories[0].memory_id,memory);
    assert.equal(result.memories[0].adoption_method,'auto');
    assert.deepEqual(result.memories[0].source_ids,[source]);
    assert.deepEqual(await read(b),{memories:[]});
    await f.client.query("UPDATE public.source_document SET status='deleting' WHERE id=$1",[source]);
    assert.deepEqual(await read(a),{memories:[]});
  } finally { await storage?.close(); await f.close(); }
});

test('版本详情保留新到旧链、隔离联系人，并拒绝已删除来源', async () => {
  const f=await createStorageFixture();let storage;
  try {
    storage=await HostStorage.open(f.options);
    const {owner_id:owner}=await storage.initializeOwner('合成本人');
    const a=randomUUID(),b=randomUUID(),source=randomUUID(),old=randomUUID(),current=randomUUID();
    for(const id of [a,b]) await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[id,owner,'合成']);
    await f.client.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','synthetic.jsonl',$4,1)",[source,owner,a,'b'.repeat(64)]);
    for(const [id,parent,status] of [[old,null,'invalidated'],[current,old,'active']]) await f.client.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method,status,supersedes_memory_id) VALUES($1,$2,$3,'合成偏好','preference',$4,'manual',$5,$6)",[id,owner,a,[source],status,parent]);
    const service=new MemoryService(storage);
    const read=contact=>service.handle('GET',new URL(`http://localhost/api/contacts/${contact}/memories/${current}/versions`));
    assert.deepEqual((await read(a)).versions.map(x=>x.memory_id),[current,old]);
    await assert.rejects(read(b),{code:'memory_not_found',status:404});
    await f.client.query("UPDATE public.source_document SET status='deleting' WHERE id=$1",[source]);
    await assert.rejects(read(a),{code:'memory_not_found',status:404});
  } finally {await storage?.close();await f.close();}
});

test('明确手录本人资料按来源联系人展示，全局本人资料不会回填联系人页面', async()=>{
  const f=await createStorageFixture();let storage;
  try {
    storage=await HostStorage.open(f.options);const {owner_id:owner}=await storage.initializeOwner('合成本人');
    const a=randomUUID(),b=randomUUID();
    for(const id of[a,b])await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[id,owner,'合成']);
    const service=new MemoryService(storage),call=(method,path,body)=>service.handle(method,new URL(`http://localhost${path}`),body);
    const global=await call('POST','/api/memories/manual-owner',{text:'喜欢散步',category:'preference'});
    const scoped=await call('POST',`/api/contacts/${a}/owner-memories`,{text:'喜欢阅读',category:'preference'});
    assert.equal(global.memory.level,'owner');assert.equal(scoped.memory.adoption_method,'manual');
    assert.deepEqual((await call('GET',`/api/contacts/${a}/owner-memories`)).memories.map(x=>x.memory_id),[scoped.memory.memory_id]);
    assert.deepEqual(await call('GET',`/api/contacts/${b}/owner-memories`),{memories:[]});
    assert.equal((await call('GET','/api/memories/owner')).memories.length,2);
  } finally{await storage?.close();await f.close();}
});

test('本人时间按owner消息来源投影，联系人时间不会借另一个联系人的消息', async()=>{
 const f=await createStorageFixture();let storage;
 try{
  storage=await HostStorage.open(f.options);const {owner_id:owner}=await storage.initializeOwner('合成本人');
  const a=randomUUID(),b=randomUUID(),source=randomUUID(),message=randomUUID(),om=randomUUID(),cm=randomUUID();
  for(const id of[a,b])await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[id,owner,'合成']);
  await f.client.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,a,'c'.repeat(64)]);
  await f.client.query("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'user','text','喜欢阅读','2026-10-01T01:02:03.123456Z')",[message,owner,a]);
  await f.client.query("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,a,source,{synthetic:true,time_iso:'2026-10-01T01:02:03.123456Z'}]);
  await f.client.query("INSERT INTO public.owner_memory(id,owner_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,'喜欢阅读','preference',$3,'manual')",[om,owner,[message]]);
  const service=new MemoryService(storage);
  const result=await service.handle('GET',new URL(`http://localhost/api/contacts/${a}/owner-memories`));
  assert.equal(result.memories[0].timing.source_started_at,'2026-10-01T01:02:03.123456+00:00');
  assert.equal(result.memories[0].timing.source_time_complete,true);
  assert.deepEqual(await service.handle('GET',new URL(`http://localhost/api/contacts/${b}/owner-memories`)),{memories:[]});
  const {projectTiming}=await import('../src/memory/overview/projection/time.ts');
  const timing=await projectTiming(f.client,{owner_id:owner,contact_id:b,source_ids:[message],created_at:null,category:'preference',text_content:'喜欢阅读'});
  assert.equal(timing.source_started_at,null);assert.equal(timing.source_time_complete,false);
 }finally{await storage?.close();await f.close();}
});

test('公开管理入口纠错同文幂等，旧版迟到删除不能伤新版，删除后不得重新读取', async()=>{
 const f=await createStorageFixture();let storage;
 try{
  storage=await HostStorage.open(f.options);const {owner_id:owner}=await storage.initializeOwner('合成本人');
  const contact=randomUUID();await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成']);
  const service=new MemoryService(storage),call=(method,path,body)=>service.handle(method,new URL(`http://localhost${path}`),body);
  const first=(await call('POST','/api/memories/manual-contact',{contact_id:contact,text:'喜欢热饮',category:'preference'})).memory;
  const base=`/api/contacts/${contact}/memories`;
  const second=(await call('POST',`${base}/${first.memory_id}/correct`,{text:'喜欢温水'})).memory;
  assert.equal(second.adoption_method,'manual');assert.notEqual(second.memory_id,first.memory_id);
  assert.equal((await call('POST',`${base}/${first.memory_id}/correct`,{text:'喜欢温水'})).memory.memory_id,second.memory_id);
  await assert.rejects(call('POST',`${base}/${first.memory_id}/correct`,{text:'喜欢冷水'}),{status:409});
  await assert.rejects(call('POST',`${base}/${first.memory_id}/delete`,{}),{status:409});
  assert.equal((await call('POST',`${base}/${second.memory_id}/delete`,{})).memory.status,'deleted');
  await assert.rejects(call('GET',`${base}/${second.memory_id}/versions`),{status:404});
  const listed=(await call('GET',base)).memories;
  assert.equal(listed.some(x=>x.memory_id===second.memory_id),false);
 }finally{await storage?.close();await f.close();}
});

test('管理写入提交前取消会回滚，旧scope不能留下已取消的新资料',async()=>{
 const f=await createStorageFixture();let storage;
 try{
  storage=await HostStorage.open(f.options);await storage.initializeOwner('合成本人');
  const service=new MemoryService(storage);let checks=0;
  const {MemoryError}=await import('../src/memory/records/errors.ts');
  await assert.rejects(service.handle('POST',new URL('http://localhost/api/memories/manual-owner'),{text:'本次取消',category:'preference'},()=>{if(++checks===2)throw new MemoryError('memory_version_changed',409);}),{status:409});
  assert.deepEqual(await service.handle('GET',new URL('http://localhost/api/memories/owner')),{memories:[]});
 }finally{await storage?.close();await f.close();}
});

test('手录与纠错后的联系人/本人管理DTO保留有效文本和隔离范围',async()=>{
 const f=await createStorageFixture();let storage;
 try{
  storage=await HostStorage.open(f.options);const {owner_id:owner}=await storage.initializeOwner('合成本人');
  const contact=randomUUID();await f.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成']);
  const service=new MemoryService(storage),call=(method,path,body)=>service.handle(method,new URL(`http://localhost${path}`),body);
  const a=(await call('POST','/api/memories/manual-contact',{contact_id:contact,text:'喜欢散步',category:'preference'})).memory;
  await call('POST',`/api/contacts/${contact}/memories/${a.memory_id}/correct`,{text:'喜欢慢走',change_kind:'state_changed'});
  await call('POST',`/api/contacts/${contact}/owner-memories`,{text:'喜欢阅读',category:'preference'});
  const contacts=(await call('GET',`/api/contacts/${contact}/memories`)).memories;
  const owners=(await call('GET',`/api/contacts/${contact}/owner-memories`)).memories;
  assert.equal(contacts.length,2);assert.equal(owners.length,1);
  assert.ok(JSON.stringify(contacts).includes('喜欢慢走'));
  assert.ok(JSON.stringify(owners).includes('喜欢阅读'));
  assert.deepEqual(await call('GET',`/api/contacts/${randomUUID()}/memories`),{memories:[]});
 }finally{await storage?.close();await f.close();}
});
