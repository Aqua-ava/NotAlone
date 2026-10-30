/** 只清账号范围的Skill业务元数据；原目录不是受管删除目标。 */
import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';

// 仅使用本领域所需的结构子集；与05 DeletionDomain结构兼容，由集成方注册时核对。
type Operation={ownerId:string;operationId:string;scope:{kind:string}};
type RowTarget={kind:'row';domain:string;rowKind:string;key:Record<string,string>;identity:string;holderKeys:string[]};
type Check={result:'passed'|'blocked'|'not_applicable';proof:string};
const domainId='skill_metadata';
function fenced(tx:StorageTransaction,operation:Operation):void {
 const owner=tx.get('SELECT state FROM owner WHERE owner_id=?',[operation.ownerId]);
 if(owner && owner.state!=='deleting' && owner.state!=='deleted')throw new StorageFailure('skill_deletion_not_fenced');
}
const check=(passed:boolean,proof:string):Check=>({result:passed?'passed':'blocked',proof});
const notApplicable=(proof:string):Check=>({result:'not_applicable',proof});
/** 返回值满足05的DeletionDomain；运行输入及副本须由实际写入领域另行注册。 */
export function skillMetadataDeletionDomain() {
 return {
  id:domainId,
  rowKinds:{skill_package:{keys:['owner_id','id'],ownerKey:'owner_id'},skill_package_revision:{keys:['owner_id','package_id','revision_no'],ownerKey:'owner_id'}},
  fence(tx:StorageTransaction,operation:Operation):{namespace:string;key:string}[]{
   if(operation.scope.kind!=='account')return [];
   fenced(tx,operation);
   tx.run("UPDATE skill_package SET current_revision_no=NULL,verification_state='pending',verification_reason='account_deletion' WHERE owner_id=?",[operation.ownerId]);
   tx.run("UPDATE skill_package_revision SET availability='unavailable',verification_state='pending' WHERE owner_id=?",[operation.ownerId]);
   return [];
  },
  collect(tx:StorageTransaction,operation:Operation):RowTarget[]{
   if(operation.scope.kind!=='account')return [];
   fenced(tx,operation);
   const revisions=tx.all('SELECT package_id,revision_no FROM skill_package_revision WHERE owner_id=? ORDER BY package_id,revision_no',[operation.ownerId]);
   const packages=tx.all('SELECT id,head_revision FROM skill_package WHERE owner_id=? ORDER BY id',[operation.ownerId]);
   return [...revisions.map(row=>({kind:'row' as const,domain:domainId,rowKind:'skill_package_revision',key:{owner_id:operation.ownerId,package_id:row.package_id as string,revision_no:String(row.revision_no)},identity:String(row.revision_no),holderKeys:[]})),
    ...packages.map(row=>({kind:'row' as const,domain:domainId,rowKind:'skill_package',key:{owner_id:operation.ownerId,id:row.id as string},identity:String(row.head_revision),holderKeys:[]}))];
  },
  clearRow(tx:StorageTransaction,operation:Operation,target:RowTarget):void {
   if(operation.scope.kind!=='account'||target.kind!=='row'||target.domain!==domainId||target.key.owner_id!==operation.ownerId)throw new StorageFailure('skill_deletion_target_invalid');
   fenced(tx,operation);
   if(target.rowKind==='skill_package'){
    if(Object.keys(target.key).sort().join(',')!=='id,owner_id')throw new StorageFailure('skill_deletion_target_invalid');
    const row=tx.get('SELECT head_revision FROM skill_package WHERE owner_id=? AND id=?',[operation.ownerId,target.key.id]);
    if(!row)return;if(String(row.head_revision)!==target.identity)throw new StorageFailure('skill_deletion_target_changed');
    tx.run('DELETE FROM skill_package WHERE owner_id=? AND id=?',[operation.ownerId,target.key.id]);
   }else if(target.rowKind==='skill_package_revision'){
    if(Object.keys(target.key).sort().join(',')!=='owner_id,package_id,revision_no'||!/^[1-9][0-9]{0,18}$/.test(target.key.revision_no)||target.identity!==target.key.revision_no)throw new StorageFailure('skill_deletion_target_invalid');
    // 不依赖目标清理顺序；其他领域的外键未清时仍由SQLite拒绝并等待同操作重试。
    tx.run('UPDATE skill_package SET current_revision_no=NULL WHERE owner_id=? AND id=? AND current_revision_no=?',[operation.ownerId,target.key.package_id,BigInt(target.key.revision_no)]);
    tx.run('DELETE FROM skill_package_revision WHERE owner_id=? AND package_id=? AND revision_no=?',[operation.ownerId,target.key.package_id,BigInt(target.key.revision_no)]);
   }else throw new StorageFailure('skill_deletion_target_invalid');
  },
  fileCleared():never {throw new StorageFailure('skill_original_directory_protected');},
  authorizeFile():never {throw new StorageFailure('skill_original_directory_protected');},
  verify(tx:StorageTransaction,operation:Operation) {
   if(operation.scope.kind!=='account')return {database_rows:notApplicable('skill_metadata_account_only'),derived_eligibility:notApplicable('skill_metadata_account_only'),
    trace_payloads:notApplicable('skill_inputs_owned_by_trace_domains'),request_replay:notApplicable('skill_runtime_owned_by_runtime_domains'),scope_suppression:notApplicable('skill_metadata_account_only')};
   const owner=tx.get('SELECT state FROM owner WHERE owner_id=?',[operation.ownerId]);
   const count=tx.get('SELECT (SELECT count(*) FROM skill_package WHERE owner_id=?)+(SELECT count(*) FROM skill_package_revision WHERE owner_id=?) AS n',[operation.ownerId,operation.ownerId])!.n;
   const inactive=!owner||owner.state==='deleting'||owner.state==='deleted';
   return {database_rows:check(count===0n,'skill_metadata_rows'),derived_eligibility:check(inactive,'skill_owner_inactive'),
    trace_payloads:notApplicable('skill_inputs_owned_by_trace_domains'),request_replay:notApplicable('skill_runtime_owned_by_runtime_domains'),scope_suppression:check(inactive,'skill_owner_inactive')};
  },
 };
}
