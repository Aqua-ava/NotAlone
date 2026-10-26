import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {requireReplyScope} from '../src/reply/generation/reply-scope.ts';
import {parseReplyRequest} from '../src/reply/generation/reply-contract.ts';
import pg from 'pg';
test('手动确认必须映射同一原UUID，跨联系人和撤销均拒绝',async t=>{
  const f=await createStorageFixture();t.after(()=>f.close());const owner=randomUUID(),contact=randomUUID(),manual=randomUUID();
  await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner,'合成本人']);
  await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成联系人']);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[manual,owner,contact]);
  const input=parseReplyRequest({contact_id:contact,idempotency_key:randomUUID(),content:{type:'initiate_conversation',purpose:'约时间'}});
  const scope={owner_id:owner,contact_id:contact,conversation_binding_id:manual,confirmation:'manual'};
  await requireReplyScope(f.client,scope,input);
  await assert.rejects(requireReplyScope(f.client,{...scope,contact_id:randomUUID()},input),{reason:'scope_mismatch'});
  await assert.rejects(requireReplyScope(f.client,{...scope,confirmation:'unverified'},input),{reason:'invalid_verification'});
  const other=new pg.Client({host:'/tmp',database:f.client.database,user:f.client.user});await other.connect();
  try{
    await other.query("SET lock_timeout='100ms'");await f.client.query('BEGIN');
    await requireReplyScope(f.client,scope,input);
    await assert.rejects(other.query('DELETE FROM manual_contact_confirmation WHERE id=$1',[manual]),{code:'55P03'},'资格返回后原确认行共享锁持续到事务结束');
  }finally{await f.client.query('ROLLBACK');await other.end();}
  await f.client.query('DELETE FROM manual_contact_confirmation WHERE id=$1',[manual]);
  await assert.rejects(requireReplyScope(f.client,scope,input),{reason:'manual_contact_unconfirmed'});
});

test('账号历史已接受但任务未创建时仍阻止生成，拒绝授权的旧增量保持可用',async t=>{
  const f=await createStorageFixture();t.after(()=>f.close());
  const owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
  await f.client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner,'合成本人']);
  await f.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)',[contact,owner,'合成联系人']);
  await f.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,display_name)
    VALUES($1,$2,$3,'wechat','synthetic-account','friend-a','合成联系人')`,[binding,owner,contact]);
  await f.client.query(`INSERT INTO wechat_history_sync_authorization(owner_id,channel,account_scope,version,decision,decided_at)
    VALUES($1,'wechat','synthetic-account',1,'accepted',now())`,[owner]);
  const input=parseReplyRequest({contact_id:contact,idempotency_key:randomUUID(),content:{type:'initiate_conversation',purpose:'约时间'}});
  const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding,confirmation:'desktop'};
  await assert.rejects(requireReplyScope(f.client,scope,input),{reason:'history_sync_pending'});

  await f.client.query("UPDATE wechat_history_sync_authorization SET decision='declined' WHERE owner_id=$1",[owner]);
  await requireReplyScope(f.client,scope,input);

  await f.client.query("UPDATE wechat_history_sync_authorization SET decision='accepted' WHERE owner_id=$1",[owner]);
  await f.client.query(`INSERT INTO cli_history_sync_state(owner_id,contact_id,binding_id,phase,watermark_at,started_at)
    VALUES($1,$2,$3,'complete',now(),now())`,[owner,contact,binding]);
  await requireReplyScope(f.client,scope,input);

  const second=randomUUID();
  await f.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,display_name)
    VALUES($1,$2,$3,'wechat','synthetic-account','friend-a-second','合成联系人')`,[second,owner,contact]);
  await assert.rejects(requireReplyScope(f.client,scope,input),{reason:'history_sync_pending'});
});
