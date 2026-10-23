import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HostStorage,HostStorageError} from '../src/host-storage.ts';
import {SyncIncrementalStore} from '../src/sync-incremental-store.ts';
import {BindingService} from '../src/binding-service.ts';
import {normalizeCliEvents} from '../src/sync-incremental-normalize.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
async function fixture(t){
  const f=await createStorageFixture(),storage=await HostStorage.open(f.options),owner=randomUUID();
  t.after(async()=>{await storage.close();await f.close();});
  await f.client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)',[owner,'合成本人']);
  await f.client.query("INSERT INTO public.owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic_account','合成本人')",[owner]);
  const bindings=new BindingService({storage,ownerId:owner,channel:'wechat',accountScope:'synthetic_account',sessions:async()=>['synthetic_a','synthetic_b'].map(username=>({username,display_name:'合成联系人',chat_type:'private'}))});
  const rows=await bindings.confirm([{locator:'synthetic_a'},{locator:'synthetic_b'}]);await bindings.close();
  const options={storage,ownerId:owner,accountScope:'synthetic_account'},store=new SyncIncrementalStore(options);
  await store.setEnabled(true);
  return {...f,storage,owner,options,store,a:rows[0],b:rows[1]};
}
function message(binding,id='5',time=42){return normalizeCliEvents([{message_id:{local_id:id,talker:binding.conversation_locator,server_id_str:null},text:'合成增量消息',kind:'text',sender:null,sender_wxid:null,is_from_me:false,create_time:time,time:null,time_iso:null}])[0];}
async function input(f,b=f.a,{id='5',cursor='opaque_a',time=42,nonText=false}={}){
  const position=await f.store.readPosition(b),messages=nonText?[]:[message(b,id,time)];
  return {binding:b,page:{events:[],cursor,last_local_id:id,event_count:1,non_text_count:nonText?1:0,freshness_confirmed:true,filtered_records:[],has_more:false,local_history_state:null},messages,
    since_cursor:position.cursor?.last_cursor??null,since_local_id:position.cursor?.last_local_id??null,position_token:position.position_token,cli_version:'synthetic-v1'};
}
const count=async(f,table)=>(await f.client.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;


import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
function python(f,b,action,observation){
 assert.equal(action,'delete');
 const script=`import sys
from uuid import UUID
from notalone.persistence.observation_store import PostgresObservationStore
name=sys.argv[1]
assert name.startswith('notalone_ts_host_') and name.endswith('_test')
PostgresObservationStore('host=/tmp dbname='+name).delete_observation(owner_id=UUID(sys.argv[2]),contact_id=UUID(sys.argv[3]),observation_id=UUID(sys.argv[4]))
`;
 execFileSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,f.client.database,f.owner,b.contact_id,observation],{encoding:'utf8',env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_MANAGED_USER_DATA:f.directory,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},timeout:30000});
}


test('混合及全过滤页保持原输入索引、计数、无正文并推进cursor',async t=>{
 const f=await fixture(t);
 await f.client.query('INSERT INTO wechat_auto_read_suppression(owner_id,contact_id,external_local_id,identity_create_time) VALUES($1,$2,5,42)',[f.owner,f.a.contact_id]);
 const i=await input(f);i.messages.push(message(f.a,'6',43));i.page.event_count=2;i.page.last_local_id='6';
 const saved=await f.store.save(i);
 assert.equal(saved.created_message_ids.length,2);assert.equal(saved.created_message_ids[0],null);
 assert.equal(saved.accepted_message_count,1);
 assert.equal((await f.client.query('SELECT record_count FROM local_wechat_observation WHERE id=$1',[saved.observation_id])).rows[0].record_count,1);
 const events=saved.created_message_ids.flatMap((id,index)=>id?[{id,at:i.messages[index].occurred_at}]:[]);
 assert.equal(events[0].at,i.messages[1].occurred_at);
 const raw=JSON.stringify((await f.client.query('SELECT payload FROM source_processing_record')).rows);
 assert.ok(!raw.includes('"local_id":"5"'));
 const all=await f.store.save(await input(f,f.a,{cursor:'all-filtered'}));
 assert.equal(all.accepted_message_count,0);assert.deepEqual(all.created_message_ids,[null]);
 assert.equal((await f.store.readPosition(f.a)).cursor.last_cursor,'all-filtered');
 assert.equal(await count(f,'message'),1);assert.equal(await count(f,'message_source_ref'),1);assert.equal(await count(f,'source_processing_record'),1);
 // 新capture和另一联系人不共用删除范围。
 await f.store.save(await input(f,f.b));assert.equal(await count(f,'message'),2);
});
test('多来源删除后新capture不复活，历史占用后完成交接继续过滤',async t=>{
 const f=await fixture(t),first=await f.store.save(await input(f));
 const second=await f.store.save(await input(f,f.a,{cursor:'second'}));
 python(f,f.a,'delete',first.observation_id);assert.equal(await count(f,'message'),1);
 await f.store.save(await input(f,f.a,{cursor:'third'}));assert.equal(await count(f,'message_source_ref'),1);
 python(f,f.a,'delete',second.observation_id);assert.equal(await count(f,'message'),0);
 await f.client.query('INSERT INTO wechat_binding_history_authorization(owner_id,contact_id,binding_id,version,authorized_at) VALUES($1,$2,$3,1,now())',[f.owner,f.a.contact_id,f.a.binding_id]);
 const i=await input(f,f.a,{cursor:'after-history'});await assert.rejects(f.store.save(i),{code:'sync_history_busy'});
 await f.client.query("INSERT INTO cli_history_sync_state(owner_id,contact_id,binding_id,phase,watermark_at,started_at,completed_at) VALUES($1,$2,$3,'complete',now(),now(),now())",[f.owner,f.a.contact_id,f.a.binding_id]);
 const saved=await f.store.save(await input(f,f.a,{cursor:'after-history'}));
 assert.equal(saved.accepted_message_count,0);assert.equal(await count(f,'message'),0);assert.ok(!JSON.stringify((await f.client.query('SELECT payload FROM source_processing_record')).rows).includes('合成增量消息'));
});
test('字符串大整数及缺省时间的独立processing记录同样被抑制',async t=>{
 const f=await fixture(t),id='9007199254740993';
 await f.client.query('INSERT INTO wechat_auto_read_suppression(owner_id,contact_id,external_local_id,identity_create_time) VALUES($1,$2,$3,-1)',[f.owner,f.a.contact_id,id]);
 const i=await input(f,f.a,{id,time:null,nonText:true});
 i.processing_records=[{record_id:randomUUID(),locator:'cli:'+id,payload_json:JSON.stringify({capture_layer:'raw',input_position:0,record_text:'独立合成敏感正文',parsed:{message:{id:{local_id:id},text:'独立合成敏感正文'}}})}];
 const saved=await f.store.save(i);assert.equal(saved.accepted_message_count,0);
 assert.equal(await count(f,'source_processing_record'),0);
});

test('同一消息对象重复输入仅首位置创建，事件不会重复',async t=>{
 const f=await fixture(t),i=await input(f);i.messages.push(i.messages[0]);i.page.event_count=2;
 const saved=await f.store.save(i);assert.equal(saved.created_message_ids.length,2);assert.ok(saved.created_message_ids[0]);assert.equal(saved.created_message_ids[1],null);
});
test('独立记录无损字符串时间匹配已删身份并拒绝浮点布尔',async t=>{
 const {filterAutoRead}=await import('../src/sync-auto-read-suppression.ts');
 const f=await fixture(t);
 await f.client.query('INSERT INTO wechat_auto_read_suppression(owner_id,contact_id,external_local_id,identity_create_time) VALUES($1,$2,6,42),($1,$2,6,-1)',[f.owner,f.a.contact_id]);
 const make=(id,time)=>({record_id:randomUUID(),locator:'cli:6',payload_json:JSON.stringify({parsed:{message:{id:{local_id:id},create_time:time,text:'合成已删正文'}},record_text:'合成已删正文'})});
 const records=[make('6','42'),make('6','-1'),make('6',null),make('6',42.5),make('6',true),make(true,'42'),make(6.5,'42'),make(undefined,'42'),make('6','42.0')];
 const filtered=await filterAutoRead(f.client,f.owner,f.a.contact_id,[],records);
 assert.deepEqual(filtered.records.map(r=>r.record_id),records.slice(3).map(r=>r.record_id));
});
