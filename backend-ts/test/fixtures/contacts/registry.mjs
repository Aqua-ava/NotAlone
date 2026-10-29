import {registry as production} from '../../../src/storage/sqlite/registry.ts';
import {identityDeletionAuthority,identityDeletionDomain} from '../../../src/contacts/sqlite/deletion.ts';
import {assertReadEligibility} from '../../../src/contacts/sqlite/actions.ts';
export const registry={migrations:[...production.migrations,{version:production.migrations.length+1,sql:`CREATE TABLE synthetic_result(owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,id TEXT PRIMARY KEY,FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id)) STRICT;`}],actions:[...production.actions,
 {name:'fixture.acceptResult',mode:'write',retryBusy:true,execute(tx,i){assertReadEligibility(tx,i.token);tx.run('INSERT INTO synthetic_result(owner_id,contact_id,id) VALUES(?,?,?)',[i.token.owner_id,i.token.contact_id,i.id]);return {accepted:true};}},
 {name:'fixture.advanceBarrier',mode:'write',retryBusy:true,execute(tx,i){tx.run('UPDATE contact SET data_generation=data_generation+1 WHERE owner_id=? AND id=?',[i.owner_id,i.contact_id]);tx.run('UPDATE channel_conversation SET barrier_generation=barrier_generation+1 WHERE owner_id=? AND id=?',[i.owner_id,i.conversation_id]);return {advanced:true};}},
 {name:'fixture.tryGrant',mode:'write',retryBusy:true,execute(tx,i){tx.run('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at) VALUES(?,?,?,?,?,?,0)',[i.owner_id,i.id,i.contact_id,i.binding_id,i.verification_id,BigInt(i.selection_generation)]);return {inserted:true};}},
 {name:'fixture.reopenGrant',mode:'write',retryBusy:true,execute(tx,i){tx.run('UPDATE read_grant SET revoked_at=NULL,reason=NULL WHERE owner_id=? AND id=?',[i.owner_id,i.grant_id]);return {updated:true};}},
 {name:'fixture.fenceIdentity',mode:'write',retryBusy:true,execute(tx,i){const generation=identityDeletionAuthority.fence(tx,i.ownerId,i.scope);return {ownerId:i.ownerId,scope:i.scope,acceptedGeneration:generation};}},
 {name:'fixture.conversationName',mode:'read',retryBusy:true,execute(tx,i){return tx.get('SELECT display_name FROM channel_conversation WHERE owner_id=? AND external_key=?',[i.ownerId,i.locator])?.display_name;}},
 {name:'fixture.confirmationExists',mode:'read',retryBusy:true,execute(tx,i){return Boolean(tx.get('SELECT id FROM manual_confirmation WHERE owner_id=? AND id=?',[i.ownerId,i.id]));}},
 {name:'fixture.cleanIdentity',mode:'write',retryBusy:true,execute(tx,i){for(const target of identityDeletionDomain.collect(tx,i))identityDeletionDomain.clearRow(tx,i,target);return identityDeletionDomain.verify(tx,i);}},
 {name:'fixture.verifyFence',mode:'read',retryBusy:true,execute(tx,i){return identityDeletionAuthority.verify(tx,i);}},
 {name:'fixture.readBarrier',mode:'read',retryBusy:true,execute(tx,i){return tx.get('SELECT barrier_generation FROM channel_conversation WHERE owner_id=? AND id=?',[i.owner_id,i.conversation_id]);}}
]};
