import {registry as shared} from './shared-producer-registry.mjs';
import {createDeletionActions} from '../../../src/storage/sqlite/deletion/actions.ts';
import {memoryExtractionDeletionAuthority} from './registration.ts';
import {discussionCallDeletionDomain} from '../../../src/reply/sqlite/model-deletion.ts';
import {memoryExtractionDeletionDomain} from '../../../src/memory/sqlite/deletion.ts';
import {discussionDeletionDomain,withDiscussionDeletionAuthority} from '../../../src/reply/sqlite/deletion.ts';
import {historyDeletionDomain} from '../../../src/history/sqlite/deletion.ts';
import {identityDeletionDomain} from '../../../src/contacts/sqlite/deletion.ts';
import {skillMetadataDeletionDomain} from '../../../src/skills/sqlite/deletion.ts';
const inspect={name:'fixture.sharedExecutionState',mode:'read',retryBusy:false,execute(tx,{owner}){
 return {calls:tx.all('SELECT id,operation_id,state,step_attempt_id,reply_attempt_id,reply_context_id FROM model_call WHERE owner_id=?',[owner]),
  operations:tx.all('SELECT id,purpose,state,commit_forbidden_at,memory_step_id,reply_request_id FROM model_operation WHERE owner_id=?',[owner]),
  scopes:tx.all('SELECT operation_id,source_contact_id FROM operation_scope WHERE owner_id=?',[owner]),
  events:tx.all('SELECT id FROM execution_event WHERE owner_id=?',[owner]).map(row=>row.id),
  contexts:tx.all('SELECT id FROM reply_context WHERE owner_id=?',[owner]).map(row=>row.id),
  requests:tx.all('SELECT id FROM reply_request WHERE owner_id=?',[owner]).map(row=>row.id),
  tasks:tx.all('SELECT id FROM processing_task WHERE owner_id=?',[owner]).map(row=>row.id)};
}};
export const registry={migrations:shared.migrations,actions:[...shared.actions.filter(action=>!action.name.startsWith('deletion.')),inspect,...createDeletionActions({
 authority:withDiscussionDeletionAuthority(memoryExtractionDeletionAuthority),
 domains:[discussionCallDeletionDomain,memoryExtractionDeletionDomain,discussionDeletionDomain,historyDeletionDomain,identityDeletionDomain,skillMetadataDeletionDomain()],
 requiredDomains:['discussion_calls','memory_extraction','discussion','history','identity','skill_metadata'],
})]};
