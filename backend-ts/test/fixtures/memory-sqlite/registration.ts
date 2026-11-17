import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {identityDeletionAuthority,identityDeletionDomain} from '../../../src/contacts/sqlite/deletion.ts';
import {historyDeletionDomain} from '../../../src/history/sqlite/deletion.ts';
import {skillMetadataDeletionDomain} from '../../../src/skills/sqlite/deletion.ts';
import type {DeletionAuthority,DeletionRegistration,DeletionScope} from '../../../src/storage/sqlite/deletion/contracts.ts';
import {memoryExtractionDeletionDomain} from '../../../src/memory/sqlite/deletion.ts';
const scopes=new Set(['source','contact','account']);
function scopeAvailable(scope:DeletionScope):boolean{return scopes.has(scope.kind);}
/** 复用05的唯一协调器；来源必须实际属于本owner/contact，不能靠空闭包放行。 */
export const memoryExtractionDeletionAuthority:DeletionAuthority={
 fence(tx,ownerId,scope){
  if(!scopeAvailable(scope))throw new StorageFailure('deletion_scope_unavailable');
  if(scope.kind==='source'&&!tx.get('SELECT 1 FROM capture_record WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,scope.contactId,scope.sourceId]))throw new StorageFailure('history_source_not_found');
  return identityDeletionAuthority.fence(tx,ownerId,scope);
 },
 verify(tx,op){return scopeAvailable(op.scope)?identityDeletionAuthority.verify(tx,op):{result:'blocked',proof:'memory_scope_handler_unavailable'};},
};
/** 公共宿主加入别的实际写者时须扩显式清单，不能用本分支代替全产品注册。 */
export function memoryExtractionDeletionRegistration():DeletionRegistration{return {
 authority:memoryExtractionDeletionAuthority,
 domains:[memoryExtractionDeletionDomain,historyDeletionDomain,identityDeletionDomain,skillMetadataDeletionDomain()],
 requiredDomains:['memory_extraction','history','identity','skill_metadata'],
};}
