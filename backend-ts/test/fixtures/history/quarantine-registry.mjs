import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {invalidHistoryDiscussionImpact} from '../../../src/reply/sqlite/deletion.ts';
export const registry={migrations:base.migrations,actions:[...base.actions,
 {name:'fixture.seedCrossContactInput',mode:'write',retryBusy:false,execute(tx,i){
  const message=tx.get('SELECT interpretation_revision FROM message WHERE owner_id=? AND contact_id=? AND id=?',[i.ownerId,i.sourceContactId,i.messageId]);
  tx.run("INSERT INTO reply_candidate_input VALUES(?,?,1,'memory','{}','合成本人资料')",[i.ownerId,i.contextId]);
  tx.run('INSERT INTO reply_candidate_input_source VALUES(?,?,1,?,?,?,?)',[i.ownerId,i.contextId,i.sourceContactId,i.recordId,i.messageId,message.interpretation_revision]);
 }},
 {name:'fixture.quarantineImpact',mode:'read',retryBusy:false,execute(tx,i){const value=invalidHistoryDiscussionImpact(tx,i.ownerId);return {requests:[...value.requests],contexts:[...value.contexts],copies:[...value.copies]};}},
]};
