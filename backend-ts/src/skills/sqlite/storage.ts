import {StorageFailure, type StorageAction, type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {SkillAnchor, SkillEnabledState, SkillPackageState, SkillVerificationState} from './contracts.ts';

// 集成方在 owner 迁移之后分配连续版本；已发布迁移不修改。
export const skillSchemaSql = `
CREATE TABLE skill_package (
 owner_id TEXT NOT NULL REFERENCES owner(owner_id), id TEXT NOT NULL,
 directory_name TEXT NOT NULL, directory_identity TEXT NOT NULL,
 display_name TEXT NOT NULL, description TEXT NOT NULL,
 enabled_state TEXT NOT NULL CHECK(enabled_state IN ('enabled','disabled','unknown')),
 enabled_origin TEXT CHECK(enabled_origin='user_action'),
 verification_state TEXT NOT NULL CHECK(verification_state IN ('verified','pending','missing','conflict','invalid')),
 verification_reason TEXT, current_revision_no INTEGER,
 head_revision INTEGER NOT NULL CHECK(head_revision>=1),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,directory_identity), UNIQUE(owner_id,directory_name),
 CHECK((enabled_state='unknown' AND enabled_origin IS NULL) OR (enabled_state<>'unknown' AND enabled_origin='user_action')),
 FOREIGN KEY(owner_id,id,current_revision_no) REFERENCES skill_package_revision(owner_id,package_id,revision_no)
) STRICT;
CREATE TABLE skill_package_revision (
 owner_id TEXT NOT NULL, package_id TEXT NOT NULL, revision_no INTEGER NOT NULL CHECK(revision_no>=1),
 manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
 source_kind TEXT NOT NULL CHECK(source_kind='user_directory'),
 verification_state TEXT NOT NULL CHECK(verification_state IN ('verified','pending')),
 verified_at INTEGER NOT NULL CHECK(verified_at>=0),
 availability TEXT NOT NULL CHECK(availability IN ('current','unavailable')),
 PRIMARY KEY(owner_id,package_id,revision_no),
 FOREIGN KEY(owner_id,package_id) REFERENCES skill_package(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX skill_one_current_revision ON skill_package_revision(owner_id,package_id) WHERE availability='current';
CREATE TRIGGER skill_revision_anchor_immutable BEFORE UPDATE OF owner_id,package_id,revision_no,manifest_digest,content_digest,source_kind,verified_at ON skill_package_revision
BEGIN SELECT RAISE(ABORT,'skill_revision_immutable'); END;
`;
type Key = {ownerId: string; id: string};
type Expected = Key & {expectedHead: bigint};
export interface SkillObservation extends Expected {
  directoryName: string; directoryIdentity: string; displayName: string; description: string;
  manifestDigest: string; contentDigest: string; verifiedAt: bigint;
}
function fail(code: string): never { throw new StorageFailure(code); }
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length>4096 || value.includes('\0')) fail('skill_input_invalid');
  return value;
}
function key(input: unknown): Key {
  if (!input || typeof input !== 'object') fail('skill_input_invalid');
  const i = input as Key; text(i.ownerId); text(i.id); return i;
}
function state(tx: StorageTransaction, ownerId: string, id: string): SkillPackageState {
  const row = tx.get('SELECT * FROM skill_package WHERE owner_id=? AND id=?',[ownerId,id]);
  if (!row) fail('skill_missing');
  const revisions = tx.all('SELECT * FROM skill_package_revision WHERE owner_id=? AND package_id=? ORDER BY revision_no',[ownerId,id]);
  return {id:row.id as string,directoryName:row.directory_name as string,directoryIdentity:row.directory_identity as string,
    displayName:row.display_name as string,description:row.description as string,enabledState:row.enabled_state as SkillEnabledState,
    enabledOrigin:row.enabled_origin as 'user_action'|null,verificationState:row.verification_state as SkillVerificationState,
    verificationReason:row.verification_reason as string|null,currentRevisionNo:row.current_revision_no as bigint|null,headRevision:row.head_revision as bigint,
    revisions:revisions.map(r=>({revisionNo:r.revision_no as bigint,manifestDigest:r.manifest_digest as string,contentDigest:r.content_digest as string,
      sourceKind:'user_directory',verificationState:r.verification_state as 'verified'|'pending',verifiedAt:r.verified_at as bigint,availability:r.availability as 'current'|'unavailable'}))};
}
function expected(tx: StorageTransaction, input: unknown): SkillPackageState {
  const i=key(input) as Expected, item=state(tx,i.ownerId,i.id);
  if (typeof i.expectedHead!=='bigint' || i.expectedHead!==item.headRevision) fail('skill_revision_conflict');
  return item;
}
/** 供 11/12 实际输入提交事务复用；不接受 SQL 或事务外资格证明。 */
export function requireSkillRevision(tx: StorageTransaction, ownerId: string, anchor: SkillAnchor): void {
  const item=state(tx,text(ownerId),text(anchor.packageId));
  const revision=item.revisions.find(r=>r.revisionNo===anchor.revisionNo);
  if (item.enabledState!=='enabled' || item.verificationState!=='verified' || item.currentRevisionNo!==anchor.revisionNo
    || item.headRevision!==anchor.headRevision || item.directoryIdentity!==anchor.directoryIdentity || !revision
    || revision.availability!=='current' || revision.verificationState!=='verified'
    || revision.manifestDigest!==anchor.manifestDigest || revision.contentDigest!==anchor.contentDigest) fail('skill_run_invalidated');
}
export const skillActions: StorageAction[] = [
  {name:'skills.list',mode:'read',retryBusy:false,execute(tx,input){
    const ownerId=text((input as {ownerId?:unknown})?.ownerId);
    return tx.all('SELECT id FROM skill_package WHERE owner_id=? ORDER BY directory_name',[ownerId]).map(row=>state(tx,ownerId,row.id as string));
  }},
  {name:'skills.get',mode:'read',retryBusy:false,execute(tx,input){const i=key(input);return state(tx,i.ownerId,i.id);}},
  {name:'skills.observe',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as SkillObservation;
    for(const value of [i.directoryName,i.directoryIdentity,i.displayName,i.description]) text(value);
    if(!/^[a-f0-9]{64}$/.test(i.manifestDigest)||!/^[a-f0-9]{64}$/.test(i.contentDigest)||typeof i.verifiedAt!=='bigint'||i.verifiedAt<0n) fail('skill_input_invalid');
    const exists=tx.get('SELECT id FROM skill_package WHERE owner_id=? AND id=?',[i.ownerId,i.id]);
    if(!exists){
      if(i.expectedHead!==0n) fail('skill_revision_conflict');
      tx.run(`INSERT INTO skill_package VALUES(?,?,?,?,?,?,'unknown',NULL,'pending',NULL,NULL,1)`,[i.ownerId,i.id,i.directoryName,i.directoryIdentity,i.displayName,i.description]);
    }
    const item=exists?expected(tx,i):state(tx,i.ownerId,i.id);
    if(item.verificationReason==='source_qualification_changed')fail('skill_source_verification_required');
    if(item.directoryIdentity!==i.directoryIdentity || item.directoryName!==i.directoryName) fail('skill_directory_conflict');
    const current=item.revisions.find(r=>r.revisionNo===item.currentRevisionNo);
    // 已失效修订不复活；相同字节重新核验也产生新的操作锚点。
    if(current?.availability==='current' && current.manifestDigest===i.manifestDigest && current.contentDigest===i.contentDigest && item.verificationState==='verified')return item;
    const number=(item.revisions.at(-1)?.revisionNo??0n)+1n;
    tx.run("UPDATE skill_package_revision SET availability='unavailable' WHERE owner_id=? AND package_id=?",[i.ownerId,i.id]);
    tx.run("INSERT INTO skill_package_revision VALUES(?,?,?,?,?,'user_directory','verified',?,'current')",[i.ownerId,i.id,number,i.manifestDigest,i.contentDigest,i.verifiedAt]);
    tx.run("UPDATE skill_package SET display_name=?,description=?,verification_state='verified',verification_reason=NULL,current_revision_no=?,head_revision=head_revision+1 WHERE owner_id=? AND id=?",[i.displayName,i.description,number,i.ownerId,i.id]);
    return state(tx,i.ownerId,i.id);
  }},
  {name:'skills.setEnabled',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as Expected & {enabledState:SkillEnabledState};expected(tx,i);
    if(!['enabled','disabled'].includes(i.enabledState)) fail('skill_input_invalid');
    tx.run("UPDATE skill_package SET enabled_state=?,enabled_origin='user_action',head_revision=head_revision+1 WHERE owner_id=? AND id=?",[i.enabledState,i.ownerId,i.id]);
    return state(tx,i.ownerId,i.id);
  }},
  {name:'skills.invalidate',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as Expected & {verificationState:SkillVerificationState;reason:string};const item=expected(tx,i);
    if(!['pending','missing','conflict','invalid'].includes(i.verificationState))fail('skill_input_invalid');text(i.reason);
    tx.run("UPDATE skill_package_revision SET availability='unavailable',verification_state='pending' WHERE owner_id=? AND package_id=?",[i.ownerId,i.id]);
    const reason=item.verificationReason==='source_qualification_changed'?item.verificationReason:i.reason;
    tx.run('UPDATE skill_package SET verification_state=?,verification_reason=?,current_revision_no=NULL,head_revision=head_revision+1 WHERE owner_id=? AND id=?',[i.verificationState,reason,i.ownerId,i.id]);
    return state(tx,i.ownerId,i.id);
  }},
  {name:'skills.assertRevision',mode:'read',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;anchor:SkillAnchor}; requireSkillRevision(tx,i.ownerId,i.anchor);return true;
  }},
];
