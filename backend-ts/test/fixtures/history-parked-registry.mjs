import {registry as base} from '../../src/storage/sqlite/registry.ts';
import {assertSourceEligibility} from '../../src/history/sqlite/source.ts';

export const registry={...base,actions:[...base.actions,{
 name:'fixture.sourceProofStates',mode:'read',retryBusy:false,execute(tx,input){return tx.all('SELECT contact_id,state,checked_at FROM source_proof WHERE owner_id=? ORDER BY contact_id',[input.ownerId]);}
},{
 name:'fixture.currentSourceValid',mode:'read',retryBusy:false,execute(tx,input){
  const refs=tx.all("SELECT owner_id,contact_id,id record_id,message_id FROM capture_record WHERE owner_id=? AND contact_id=? AND state='normalized' AND availability='available'",[input.ownerId,input.contactId]);
  for(const ref of refs)assertSourceEligibility(tx,ref);
  return refs.length;
 }
}]};
