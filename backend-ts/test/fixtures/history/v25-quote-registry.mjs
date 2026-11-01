import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {randomUUID} from 'node:crypto';

const seedIdentity={name:'fixture.seedIdentityV25',mode:'write',retryBusy:false,execute(tx,input){
 const owner=input.ownerId,contact=randomUUID(),account=randomUUID(),conversation=randomUUID(),binding=randomUUID(),verification=randomUUID(),grant=randomUUID(),at=Date.now();
 tx.run('INSERT INTO contact(owner_id,id,display_name,selection_generation) VALUES(?,?,?,1)',[owner,contact,'合成迁移联系人']);
 tx.run("INSERT INTO channel_account(owner_id,id,identity_scheme,external_key,identity_state,source_generation) VALUES(?,?,'wechat.account.v1','synthetic-account','verified','source-1')",[owner,account]);
 tx.run("INSERT INTO channel_conversation(owner_id,id,account_id,identity_scheme,external_key) VALUES(?,?,?,'wechat.conversation.v1','friend-a')",[owner,conversation,account]);
 tx.run("INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,state) VALUES(?,?,?,?,'verified')",[owner,binding,contact,conversation]);
 tx.run("INSERT INTO binding_verification VALUES(?,?,?,0,'channel_metadata','identity-metadata-v1',?,?)",[owner,verification,binding,JSON.stringify({support_profile:'synthetic-metadata-v1',source_generation:'source-1',account_id:account,conversation_id:conversation}),at]);
 tx.run('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at) VALUES(?,?,?,?,?,1,?)',[owner,grant,contact,binding,verification,at]);
 tx.run('UPDATE owner SET read_enabled=1 WHERE owner_id=?',[owner]);return {contactId:contact};
}};

// 真正的v25结构只种旧资料；不让新运行时查询依赖v29认证账本的读取接口。
const seedHistory={name:'fixture.seedHistoryV25',mode:'write',retryBusy:false,execute(tx,input){
 const {token,goalId,records}=input,captureId=randomUUID(),at=Date.now(),result=[];
 tx.run("INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,state,response_digest,acceptance_no) VALUES(?,?,?,?,?,?,?,'1','accepted',?,(SELECT coalesce(max(acceptance_no),0)+1 FROM sync_capture))",[token.owner_id,captureId,token.contact_id,goalId,BigInt(token.read_epoch),'synthetic-v25',at,'a'.repeat(64)]);
 for(const [index,r] of records.entries()){
  const id=randomUUID(),recordId=randomUUID(),key=JSON.stringify([token.source_generation,r.partition,r.table,r.localId]);
  tx.run(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,display_no,status_code,status_observed_at)
   VALUES(?,?,?,?,'source-table-local-v1',?,?,?,?,?,?,?,?,?,(SELECT coalesce(max(display_no),0)+1 FROM message),?,?)`,[token.owner_id,id,token.contact_id,token.binding_id,key,r.sender,r.kind,r.text,r.originalType,BigInt(r.sentAt),r.timePrecision,r.orderScheme,r.orderKey,r.status,at]);
  for(const [scheme,externalKey] of [['local',key],['server',r.serverId]])tx.run('INSERT INTO message_alias VALUES(?,?,?,?,?,?,?)',[token.owner_id,randomUUID(),token.contact_id,token.binding_id,scheme,externalKey,id]);
  tx.run("INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version) VALUES(?,?,?,?,?,'normalized',?,?,'source-table-local-v1',?,?)",[token.owner_id,recordId,token.contact_id,captureId,index,id,JSON.stringify(r.kind==='text'?{...r,text:null}:r),key,r.kind==='text'?'2':'1']);
  result.push({id,recordId,originalType:r.originalType});
 }
 tx.run("UPDATE read_goal SET state='complete',coverage_state='complete',completed_partitions=? WHERE owner_id=? AND id=?",[JSON.stringify(input.target.partitions),token.owner_id,goalId]);return result;
}};

const seedQuote={name:'fixture.seedQuoteV25',mode:'write',retryBusy:false,execute(tx,input){
 const message=tx.get('SELECT * FROM message WHERE owner_id=? AND contact_id=? AND id=?',[input.ownerId,input.contactId,input.messageId]);
 const source=tx.get('SELECT * FROM capture_record WHERE owner_id=? AND contact_id=? AND id=? AND message_id=?',[input.ownerId,input.contactId,input.recordId,input.messageId]);
 if(!message||!source)throw new Error('synthetic quote source missing');
 tx.run(`INSERT INTO history_quote(owner_id,id,contact_id,message_id,binding_id,source_record_id,source_generation,version,reply_text,
  referenced_text,referenced_sender,referenced_sender_role,referenced_type,referenced_server_id,target_message_id,state,proof_digest,
  source_revision,interpretation_revision,carrier_interpretation_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [input.ownerId,input.quoteId,input.contactId,input.messageId,message.binding_id,input.recordId,input.sourceGeneration,input.version,input.replyText,
   input.referencedText,'合成发送者','contact','1',null,null,'unresolved','d'.repeat(64),1,1,message.interpretation_revision]);
 tx.run(`INSERT INTO history_quote_attempt(owner_id,id,contact_id,message_id,binding_id,record_id,source_generation,version,outcome,error_code)
  VALUES(?,?,?,?,?,?,?,?,'saved',NULL)`,[input.ownerId,input.attemptId,input.contactId,input.messageId,message.binding_id,input.recordId,input.sourceGeneration,input.version]);
 return {seeded:true};
}};

export const registry={migrations:base.migrations.filter(migration=>migration.version<=25),actions:[...base.actions,seedIdentity,seedHistory,seedQuote]};
