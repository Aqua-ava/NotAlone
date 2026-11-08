import type {StorageTransaction} from '../../storage/sqlite/contracts.ts';

/** 已核验物理键的等价闭包只用于删除；点证明只连同一行。 */
export function deletionEquivalentKeys(tx:StorageTransaction,scope:{ownerId:string;contactId:string;conversationId:string;key:string}):string[]{
 const [generation,partition,table,localId]=JSON.parse(scope.key) as [string,string,string,string];
 if(!tx.get("SELECT 1 FROM sqlite_schema WHERE name='history_source_equivalence'"))return [scope.key];
 return tx.all(`WITH RECURSIVE edges AS MATERIALIZED (
  SELECT generation_a a,generation_b b FROM history_source_equivalence WHERE owner_id=? AND contact_id=? AND conversation_id=?
   AND partition_id=? AND table_instance=? AND local_id IN ('',?)
 ), closure(generation) AS (SELECT ? UNION SELECT CASE WHEN a=generation THEN b ELSE a END FROM closure JOIN edges ON a=generation OR b=generation)
 SELECT generation FROM closure`,[scope.ownerId,scope.contactId,scope.conversationId,partition,table,localId,generation])
  .map(row=>JSON.stringify([row.generation,partition,table,localId]));
}
