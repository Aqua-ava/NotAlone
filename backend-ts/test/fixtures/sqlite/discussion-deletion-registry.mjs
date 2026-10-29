import {registry as base} from './discussion-registry.mjs';
import {createDeletionActions} from '../../../src/storage/sqlite/deletion/actions.ts';
import {discussionDeletionAuthority,discussionDeletionDomain,withDiscussionDeletionAuthority} from '../../../src/reply/sqlite/deletion.ts';
import {discussionCallDeletionDomain} from '../../../src/reply/sqlite/model-deletion.ts';
import {memoryExtractionDeletionDomain} from '../../../src/memory/sqlite/deletion.ts';
import {historyDeletionDomain} from '../../../src/history/sqlite/deletion.ts';
import {identityDeletionAuthority,identityDeletionDomain} from '../../../src/contacts/sqlite/deletion.ts';
import {skillMetadataDeletionDomain} from '../../../src/skills/sqlite/deletion.ts';
export const registry={migrations:base.migrations,actions:[...base.actions.filter(a=>!a.name.startsWith('deletion.')),...createDeletionActions({authority:withDiscussionDeletionAuthority(identityDeletionAuthority),domains:[discussionCallDeletionDomain,memoryExtractionDeletionDomain,discussionDeletionDomain,historyDeletionDomain,identityDeletionDomain,skillMetadataDeletionDomain()],requiredDomains:['discussion_calls','memory_extraction','discussion','history','identity','skill_metadata']}),
 {name:'discussionTest.seed',mode:'write',retryBusy:false,execute(tx){
  tx.run("INSERT INTO owner(owner_id,created_at) VALUES('o',0)");
  tx.run("INSERT INTO contact(owner_id,id) VALUES('o','a'),('o','b')");
 }},
 {name:'discussionTest.copy',mode:'write',retryBusy:false,execute(tx,i){
  tx.run("INSERT INTO runtime_copy(owner_id,id,contact_id,discussion_id,sdk_instance_id,managed_locator,address_json,write_generation,accepted_data_generation,source_revision,state,manifest_complete) VALUES('o',?,'a',?,?,?,?,0,0,0,?,?)",[i.copyId,i.discussionId,`sdk-${i.copyId}`,i.copyId,i.address?JSON.stringify(i.address):null,i.address?'dirty':'preparing',i.complete?1:0]);
  for(const file of i.files??[])tx.run("INSERT INTO runtime_file(owner_id,copy_id,file_id,address_json) VALUES('o',?,?,?)",[i.copyId,file.id,JSON.stringify(file.address)]);
 }},
 {name:'discussionTest.registerManifest',mode:'write',retryBusy:false,execute(tx,i){
  for(const file of i.files??[])tx.run("INSERT INTO runtime_file(owner_id,copy_id,file_id,address_json) VALUES('o',?,?,?)",[i.copyId,file.id,JSON.stringify(file.address)]);
  tx.run("UPDATE runtime_copy SET manifest_complete=1 WHERE owner_id='o' AND id=?",[i.copyId]);
 }},
 {name:'discussionTest.control',mode:'read',retryBusy:false,execute(tx){return {contacts:tx.all("SELECT id,data_generation FROM contact WHERE owner_id='o' ORDER BY id"),discussions:tx.all("SELECT id,state,generation FROM assistant_discussion WHERE owner_id='o' ORDER BY id"),copies:tx.all("SELECT id,state,cleanup_operation_id FROM runtime_copy WHERE owner_id='o'")};}},
 {name:'discussionTest.calls',mode:'read',retryBusy:false,execute(tx,i){return tx.all('SELECT state,reserved_budget_units,actual_budget_units,settlement_state,receipt,model,input_cap,output_cap FROM model_call WHERE owner_id=?',[i.ownerId]);}},
]};
