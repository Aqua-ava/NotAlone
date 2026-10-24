import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {ReplyHistory} from '../src/reply-history.ts';
async function setup(t){
  const f=await createStorageFixture();t.after(()=>f.close());
  const owner=randomUUID(),contact=randomUUID(),other=randomUUID(),binding=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  for(const c of [contact,other])await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[c,owner]);
  const seed=async(c,text,date)=>{const source=randomUUID(),id=randomUUID();await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual','合成资料',$4,1)",[source,owner,c,source.replaceAll('-','').repeat(2)]);await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,$5)",[id,owner,c,text,date]);await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),id,owner,c,source]);return {id,source};};
  const options={scope:{owner_id:owner,contact_id:contact},binding_id:binding,initial_evidence_ids:[],requireCurrent:async()=>{},transaction:async fn=>{await f.client.query('BEGIN');try{const r=await fn(f.client);await f.client.query('COMMIT');return r;}catch(e){await f.client.query('ROLLBACK');throw e;}}};
  return {f,contact,other,binding,seed,options};
}
test('历史Tool按联系人搜索、来源删除失效、原始来源不冒充会话ID',async t=>{
  const {f,contact,other,seed,options}=await setup(t),a=await seed(contact,'喜欢清淡饮食','2026-01-01T00:00:00.123456Z');await seed(other,'喜欢清淡饮食','2026-01-01T00:00:00Z');
  const history=new ReplyHistory(options);
  const result=JSON.parse(await history.search({query:'清淡'}));
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].message_id,a.id);assert.equal(result.messages[0].session_id,null);assert.equal(result.messages[0].can_query_context,false);
  await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1",[a.source]);
  assert.equal(JSON.parse(await history.search({query:'清淡'})).status,'empty');
});
test('查询只读本轮锚点、排除项不加入证据，三次后无继续读库',async t=>{
  const {contact,binding,seed,options}=await setup(t),a=await seed(contact,'第一条','2026-01-01T00:00:00Z'),b=await seed(contact,'第二条','2026-01-02T00:00:00Z');
  const history=new ReplyHistory({...options,initial_evidence_ids:[a.id],excluded_message_ids:[b.id]});
  const result=JSON.parse(await history.query({session_id:binding,anchor_message_id:a.id,before:0,after:2}));
  assert.deepEqual(result.messages.map(m=>m.message_id),[a.id]);
  assert.equal(JSON.parse(await history.query({session_id:randomUUID()})).status,'failed');
  assert.equal(JSON.parse(await history.query({session_id:binding,anchor_message_id:b.id})).status,'failed');
  assert.equal(JSON.parse(await history.search({query:'第一'})).status,'budget_exceeded');
  assert.equal(history.evidence.length,0);
});
