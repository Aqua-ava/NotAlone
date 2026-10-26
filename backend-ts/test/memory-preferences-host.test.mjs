import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {start} from './contact-context-support.mjs';

// 使用真实官方 profile 验证当前 Node 管理入口。旧 Python 移交用例从固定 Git 历史入口恢复。
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

test('管理纠错后的 Node 分层读回重建缺失或过期概览缓存',async t=>{
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
    const saved=(await f.client.query('SELECT projection_revision,memory_ids FROM relationship_overview_projection WHERE owner_id=$1 AND contact_id=$2',[f.owner,f.contact])).rows;
    assert.equal(saved.length,1,'当前 Node 读回须重建缺失或过期投影');
    assert.notEqual(saved[0].projection_revision,prior.projection_revision,'纠错后的投影修订不能沿用旧缓存');
    assert.ok(saved[0].memory_ids.includes(corrected.data.memory.memory_id),'投影必须包含纠错后的有效记忆');
  }
});
