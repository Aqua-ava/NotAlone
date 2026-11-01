import {sourceDeletionIds} from '../../../src/history/sqlite/source-deletion.ts';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {assertSourceEligibility} from '../../../src/history/sqlite/source.ts';
export const registry={...base,actions:[...base.actions,
{name:'diag.sourceIds',mode:'read',retryBusy:true,execute:(tx,i)=>sourceDeletionIds(tx,i.operation)},
{name:'diag.mediaHead',mode:'write',retryBusy:true,execute(tx,i){tx.run("INSERT INTO message_media(owner_id,contact_id,message_id,media_generation,head_revision,state,created_at) VALUES(?,?,?,0,0,'active',?)",[i.ownerId,i.contactId,i.messageId,Date.now()]);return true;}},
{name:'diag.dependencies',mode:'read',retryBusy:true,execute(tx,i){const count=(table)=>Number(tx.get(`SELECT count(*) n FROM ${table} WHERE owner_id=?`,[i.ownerId]).n);return Object.fromEntries(['reply_context','reply_context_item','reply_candidate_input_source','media_extraction_attempt','message_media'].map(table=>[table,count(table)]));}},

{name:'diag.sourceRows',mode:'read',retryBusy:true,execute(tx,i){return tx.all(`SELECT r.id,r.message_id,r.observed_key,r.availability,g.binding_id,b.conversation_id,g.accepted_data_generation,m.text_body FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id LEFT JOIN message m ON m.owner_id=r.owner_id AND m.id=r.message_id WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=?`,[i.ownerId,i.contactId,i.key]);}},
{name:'diag.sourceEligible',mode:'read',retryBusy:true,execute(tx,i){try{assertSourceEligibility(tx,i);return {eligible:true};}catch(error){return {eligible:false,code:error.code};}}}
]};
