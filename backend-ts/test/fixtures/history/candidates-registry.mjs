import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {randomUUID} from 'node:crypto';

// 仅测试用：为候选聚合测试批量合成被围栏联系人，并提供只读查询计划与只读状态变更入口。
// 不进入产品装配；所有写入均为匿名合成资料，不含真实联系人名称或正文。
const actions=[
 {name:'fixture.explain',mode:'read',retryBusy:false,execute:(tx,i)=>tx.all(`EXPLAIN QUERY PLAN ${String(i.sql)}`,i.params??[]).map(row=>({detail:String(row.detail)}))},
 {name:'fixture.fencedContacts',mode:'write',retryBusy:false,execute:(tx,i)=>{
  const owner=String(i.ownerId),count=Number(i.count);
  const account=tx.get("SELECT id FROM channel_account WHERE owner_id=? AND identity_state='verified'",[owner]);
  if(!account)throw new Error('synthetic account missing');
  const now=Date.now();
  let display=Number(tx.get('SELECT coalesce(max(display_no),0) AS n FROM message')?.n??0);
  const ids=[];
  for(let n=0;n<count;n++){
   const contact=randomUUID(),conversation=randomUUID(),binding=randomUUID(),grant=randomUUID(),verification=randomUUID(),text=randomUUID(),image=randomUUID();
   tx.run("INSERT INTO contact(owner_id,id,display_name,selection_generation,state) VALUES(?,?,?,1,'active')",[owner,contact,`合成候选人${n}`]);
   tx.run('INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key) VALUES(?,?,?,?,?)',[owner,conversation,account.id,'wechat.contact.v1',`synthetic-candidate-${n}`]);
   tx.run("INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,identity_generation,state) VALUES(?,?,?,?,0,'verified')",[owner,binding,contact,conversation]);
   tx.run('INSERT INTO binding_verification(owner_id,id,binding_id,identity_generation,method,proof_format,proof,verified_at) VALUES(?,?,?,0,\'channel_metadata\',\'identity-metadata-v1\',?,?)',[owner,verification,binding,JSON.stringify({synthetic:true}),now]);
   tx.run('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at) VALUES(?,?,?,?,?,1,?)',[owner,grant,contact,binding,verification,now]);
   tx.run('INSERT INTO history_continuity_fence VALUES(?,?,?)',[owner,contact,'history_source_continuity_unverified']);
   display+=1;
   tx.run("INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,display_no) VALUES(?,?,?,?,'synthetic','t-1','contact','text','合成批量文字','1',?)",[owner,text,contact,binding,display]);
   display+=1;
   tx.run("INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,display_no) VALUES(?,?,?,?,'synthetic','i-1','contact','image',NULL,'3',?)",[owner,image,contact,binding,display]);
   ids.push(contact);
  }
  return ids;
 }},
 {name:'fixture.candidateMutation',mode:'write',retryBusy:false,execute:(tx,i)=>{
  const owner=String(i.ownerId),contact=String(i.contactId);
  if(i.kind==='unfence')tx.run('DELETE FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[owner,contact]);
  else if(i.kind==='revoke')tx.run("UPDATE read_grant SET revoked_at=?,reason='synthetic-revoked' WHERE owner_id=? AND contact_id=? AND revoked_at IS NULL",[Date.now(),owner,contact]);
  else if(i.kind==='delete-contact')tx.run("UPDATE contact SET state='deleting' WHERE owner_id=? AND id=?",[owner,contact]);
  else if(i.kind==='disable-read')tx.run('UPDATE owner SET read_enabled=0 WHERE owner_id=?',[owner]);
  else throw new Error('synthetic mutation invalid');
  return true;
 }},
];
export const registry={...base,actions:[...base.actions,...actions]};
