import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {start} from './contact-context-support.mjs';

// 使用真实官方profile；切换前明确失败，不能把Python响应冒充TS验收。
async function fixture(t) {
  const f=await createStorageFixture();
  t.after(async()=>{for(const host of f.hosts??[])await host.terminate();await f.close();});
  const owner=randomUUID(),contact=randomUUID(),other=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  for(const id of [contact,other])await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成同名')",[id,owner]);
  await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\n`);
  const app=await start(t,f);
  const status=await app.request('/api/runtime/status');
  assert.equal(status.data.ownership.memory,'typescript','管理入口必须已转交TS');
  async function call(method,path,body,token=app.connection.token) {
    const response=await fetch(`http://${app.connection.address}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
    const text=await response.text();
    return {status:response.status,cache:response.headers.get('cache-control'),text,data:JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)&&/^-?\d+$/.test(context.source)?BigInt(context.source):value)};
  }
  return {...f,owner,contact,other,app,call};
}

test('官方profile管理认证、同名隔离、纠错幂等及删除后不再可读',async t=>{
  const f=await fixture(t),manual={contact_id:f.contact,text:'合成热饮偏好',category:'preference'};
  assert.equal((await f.call('POST','/api/memories/manual-contact',manual,'wrong-token')).status,401);
  assert.equal((await f.call('POST','/api/memories/manual-contact','{')).status,400);
  assert.equal((await f.call('POST','/api/memories/manual-contact',JSON.stringify({...manual,text:'字'.repeat(400000)}))).status,413);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM confirmed_memory')).rows[0].n,0);
  const created=await f.call('POST','/api/memories/manual-contact',manual);
  assert.equal(created.status,200);assert.match(created.cache,/no-store/);
  const id=created.data.memory.memory_id,base=`/api/contacts/${f.contact}/memories`;
  assert.deepEqual((await f.call('GET',`/api/contacts/${f.other}/memories`)).data,{memories:[]});
  assert.equal((await f.call('GET',`/api/contacts/${f.other}/memories/${id}/versions`)).status,404);
  const correction={text:'合成温水偏好'},updated=await f.call('POST',`${base}/${id}/correct`,correction);
  assert.equal(updated.status,200);
  assert.equal((await f.call('POST',`${base}/${id}/correct`,correction)).data.memory.memory_id,updated.data.memory.memory_id);
  assert.equal((await f.call('POST',`${base}/${id}/correct`,{text:'冲突正文'})).status,409);
  assert.equal((await f.call('POST',`${base}/${id}/delete`,{})).status,409);
  const current=updated.data.memory.memory_id;
  assert.equal((await f.call('POST',`${base}/${current}/delete`,{})).status,200);
  assert.equal((await f.call('GET',`${base}/${current}/versions`)).status,404);
  assert.equal((await f.call('GET',base)).data.memories.some(row=>row.memory_id===current),false);
});

test('官方HTTP偏好大修订数字往返、CAS冲突、删除重试及旧键不能复活',async t=>{
  const f=await fixture(t),body={operation_key:randomUUID(),text:'合成简洁偏好',scope:{contact_id:null,reply_mode:null},origin:{kind:'manual'},confirm_long_term:true};
  assert.equal((await f.call('POST','/api/expression-preferences',{...body,owner_id:randomUUID()})).status,400);
  const created=await f.call('POST','/api/expression-preferences',body);
  assert.equal(created.status,200);const id=created.data.preference.preference_id,path=`/api/expression-preferences/${id}`;
  for(const literal of ['1.0','1e0']) {
    const invalid=`{"operation_key":"${randomUUID()}","expected_revision":${literal},"text":"非整数修订","scope":{"contact_id":null,"reply_mode":null},"confirm_long_term":true}`;
    assert.equal((await f.call('PATCH',path,invalid)).status,400);
  }
  await f.client.query('UPDATE expression_preference SET revision=$2 WHERE id=$1',[id,'9007199254740993']);
  const read=await f.call('GET',path);
  assert.equal(read.data.preference.revision,9007199254740993n);assert.match(read.text,/"revision"\s*:\s*9007199254740993\b/);
  const key=randomUUID(),edit=`{"operation_key":"${key}","expected_revision":9007199254740993,"text":"修改合成偏好","scope":{"contact_id":null,"reply_mode":null},"confirm_long_term":true}`;
  const updated=await f.call('PATCH',path,edit);assert.equal(updated.status,200);assert.equal(updated.data.preference.revision,9007199254740994n);
  assert.deepEqual((await f.call('PATCH',path,edit)).data,updated.data);
  assert.equal((await f.call('PATCH',path,edit.replace(key,randomUUID()))).status,409);
  const remove=`{"operation_key":"${randomUUID()}","expected_revision":9007199254740994}`;
  assert.equal((await f.call('DELETE',path,remove)).status,200);
  assert.equal((await f.call('DELETE',path,remove)).status,200);
  assert.equal((await f.call('GET',path)).status,410);
  assert.equal((await f.call('POST','/api/expression-preferences',body)).status,410);
  assert.deepEqual((await f.call('GET','/api/expression-preferences')).data,{preferences:[]});
});

test('官方管理移交先停收并排空，在途取消回滚且两个责任方不双写',async t=>{
  const f=await fixture(t),{setTimeout:delay}=await import('node:timers/promises');
  const control='/api/runtime/memory-management',lock=`owner:${f.owner}`;
  async function until(check,message) {
    for(let i=0;i<100;i++){if(await check())return;await delay(25);}
    throw new Error(message);
  }
  await f.client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
  let pending,transfer;
  try {
    pending=f.call('POST','/api/memories/manual-owner',{text:'移交前取消合成资料',category:'preference'});
    await until(async()=> (await f.call('GET',`${control}/status`)).data.active_requests===1,'管理请求未进入租约');
    transfer=f.call('POST',`${control}/handoff`,{target:'python'});
    await until(async()=> (await f.call('GET',`${control}/status`)).data.state==='transferring','移交未先停收');
    assert.equal((await f.call('GET','/api/memories/owner')).status,503);
  } finally {
    await f.client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);
  }
  assert.ok([409,503].includes((await pending).status),'旧租约不能提交或返回成功');
  assert.equal((await transfer).status,200);
  const python=await f.call('GET',`${control}/status`);
  assert.equal(python.data.owner,'python');assert.equal(python.data.active_requests,0);
  assert.deepEqual((await f.call('GET','/api/memories/owner')).data,{memories:[]});
  assert.equal((await f.call('POST',`${control}/handoff`,{target:'typescript'})).status,200);
  assert.equal((await f.call('POST','/api/memories/manual-owner',{text:'移交后合成资料',category:'preference'})).status,200);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM owner_memory WHERE owner_id=$1',[f.owner])).rows[0].n,1);
});

test('管理移交原表列核验失败保持停收，不回退旧管理写入',async t=>{
  const f=await fixture(t),control='/api/runtime/memory-management';
  await f.client.query('ALTER TABLE expression_preference RENAME COLUMN revision TO synthetic_missing_revision');
  try {
    assert.equal((await f.call('POST',`${control}/handoff`,{target:'python'})).status,503);
    assert.equal((await f.call('GET',`${control}/status`)).data.state,'stopped');
    assert.equal((await f.call('POST','/api/memories/manual-owner',{text:'不应保存',category:'preference'})).status,503);
    assert.equal((await f.call('GET','/api/expression-preferences')).status,503);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM owner_memory WHERE owner_id=$1',[f.owner])).rows[0].n,0);
  } finally {
    await f.client.query('ALTER TABLE expression_preference RENAME COLUMN synthetic_missing_revision TO revision');
  }
  assert.equal((await f.call('POST',`${control}/handoff`,{target:'typescript'})).status,200);
});

test('管理纠错后的真实旧分层读回不依赖缺失或过期概览缓存',async t=>{
  const f=await fixture(t),base=`/api/contacts/${f.contact}`;
  for(const mode of ['absent','stale']) {
    const first=await f.call('POST','/api/memories/manual-contact',{contact_id:f.contact,text:'合成分层读回偏好',category:'preference'});
    assert.equal(first.status,200);
    assert.equal((await f.call('GET',`${base}/relationship-overview`)).status,200);
    const prior=(await f.client.query('SELECT to_jsonb(p) AS value FROM relationship_overview_projection p WHERE owner_id=$1 AND contact_id=$2',[f.owner,f.contact])).rows[0].value;
    const corrected=await f.call('POST',`${base}/memories/${first.data.memory.memory_id}/correct`,{text:'合成纠错后偏好',change_kind:'error_correction'});
    assert.equal(corrected.status,200);
    assert.equal((await f.client.query('SELECT 1 FROM relationship_overview_projection WHERE owner_id=$1 AND contact_id=$2',[f.owner,f.contact])).rowCount,0);
    if(mode==='stale')await f.client.query('INSERT INTO relationship_overview_projection SELECT * FROM jsonb_populate_record(NULL::relationship_overview_projection,$1::jsonb)',[JSON.stringify(prior)]);
    const layered=await f.call('GET',`${base}/layered-memory`);
    assert.equal(layered.status,200,JSON.stringify(layered.data));
    assert.equal(layered.data.layered_memory.eligible_count,mode==='absent'?1:2);
    const saved=(await f.client.query('SELECT projection_revision FROM relationship_overview_projection WHERE owner_id=$1 AND contact_id=$2',[f.owner,f.contact])).rows;
    assert.deepEqual(saved,mode==='absent'?[]:[{projection_revision:prior.projection_revision}],'旧进程不得恢复概览投影写入');
  }
});
