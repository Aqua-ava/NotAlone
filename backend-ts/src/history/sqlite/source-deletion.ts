import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {DeletionOperation} from '../../storage/sqlite/deletion/contracts.ts';

/** 同一已认证物理出现可跨binding重读；正文、时间及server别名不参与等价推断。 */
function trustedOccurrence(row:StorageRow):boolean {
 if(row.observed_scheme!=='source-table-local-v1'||typeof row.observed_key!=='string')return false;
 try{
  const key=JSON.parse(row.observed_key),target=JSON.parse(String(row.target_json)),token=JSON.parse(String(row.eligibility_json)),support=JSON.parse(String(row.support_json));
  return Array.isArray(key)&&key.length===4&&key.every(v=>typeof v==='string')&&JSON.stringify(key)===row.observed_key
   &&/^(0|[1-9][0-9]{0,19})$/.test(key[3])&&BigInt(key[3])<=18446744073709551615n
   &&support.status==='supported'&&support.identity==='source-table-local-v1'&&support.sourceGeneration===key[0]
   &&key[0]===target.sourceGeneration&&key[0]===token.source_generation&&token.conversation_id===row.conversation_id
   &&Array.isArray(target.partitions)&&target.partitions.includes(key[1])&&Array.isArray(target.tables)
   &&target.tables.some((table:{partition:string;instance:string})=>table.partition===key[1]&&table.instance===key[2]);
 }catch{return false;}
}
/** 首次计划冻结的capture目标是重试依据；种子已擦除时仍沿同一集合清理所有派生。 */
export function sourceDeletionIds(tx:StorageTransaction,op:DeletionOperation):string[]{
 if(op.scope.kind!=='source')return [];
 const planned=tx.all("SELECT row_key_snapshot FROM deletion_target WHERE operation_id=? AND domain='history' AND row_kind='capture_record' AND row_key_snapshot IS NOT NULL",[op.operationId]);
 if(planned.length)return [...new Set(planned.flatMap(row=>{try{const key=JSON.parse(String(row.row_key_snapshot));return key.owner_id===op.ownerId&&typeof key.id==='string'?[key.id]:[];}catch{return [];}}))];
 const {ownerId,scope}=op;
 const selection=`SELECT r.id,r.observed_scheme,r.observed_key,g.target_json,g.eligibility_json,g.support_json,b.conversation_id
  FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
  JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.contact_id=g.contact_id AND b.id=g.binding_id
  WHERE r.owner_id=? AND r.contact_id=? AND g.accepted_data_generation<?`;
 const args=[ownerId,scope.contactId,op.acceptedGeneration];
 const seed=tx.get(`${selection} AND r.id=?`,[...args,scope.sourceId]);
 if(!seed||!trustedOccurrence(seed))return [scope.sourceId];
 return tx.all(`${selection} AND r.observed_scheme='source-table-local-v1' AND r.observed_key=? AND b.conversation_id=?`,[...args,seed.observed_key,seed.conversation_id]).filter(trustedOccurrence).map(row=>String(row.id));
}
