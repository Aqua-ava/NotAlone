import {registry as base} from '../../../src/storage/sqlite/registry.ts';

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

export const registry={migrations:base.migrations.filter(migration=>migration.version<=25),actions:[...base.actions,seedQuote]};
