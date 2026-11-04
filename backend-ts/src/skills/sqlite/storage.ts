import {randomUUID} from 'node:crypto';
import {StorageFailure, type StorageAction, type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {SkillAnchor, SkillEnabledState, SkillPackageState, SkillRunRevision, SkillVerificationState} from './contracts.ts';

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
 CHECK((enabled_state='unknown' AND enabled_origin IS NULL) OR (enabled_state<>'unknown' AND enabled_origin IS 'user_action')),
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
interface SkillRootRelocationPackage {
  id: string; directoryName: string; expectedHead: bigint; expectedDirectoryIdentity: string;
  directoryIdentity: string; manifestDigest: string; contentDigest: string;
}
interface SkillRootRelocation {ownerId: string; packages: SkillRootRelocationPackage[]}
function fail(code: string): never { throw new StorageFailure(code); }
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length>4096 || value.includes('\0')) fail('skill_input_invalid');
  return value;
}
function key(input: unknown): Key {
  if (!input || typeof input !== 'object') fail('skill_input_invalid');
  const i = input as Key; text(i.ownerId); text(i.id); return i;
}
/** 正常管理和运行都要求本人仍有效；账号删除处理器直接操作自己的元数据。 */
export function requireSkillOwner(tx: StorageTransaction,ownerId: string): void {
  if(tx.get('SELECT state FROM owner WHERE owner_id=?',[text(ownerId)])?.state!=='active')fail('skill_owner_unavailable');
}
function state(tx: StorageTransaction, ownerId: string, id: string): SkillPackageState {
  requireSkillOwner(tx,ownerId);
  const row = tx.get('SELECT * FROM skill_package WHERE owner_id=? AND id=?',[ownerId,id]);
  if (!row) fail('skill_missing');
  const revisions = tx.all('SELECT * FROM skill_package_revision WHERE owner_id=? AND package_id=? ORDER BY revision_no',[ownerId,id]);
  return {id:row.id as string,directoryName:row.directory_name as string,directoryIdentity:row.directory_identity as string,
    displayName:row.display_name as string,description:row.description as string,
    enabledState: row.default_enabled===1n?'enabled':row.enabled_state as SkillEnabledState,
     enabledOrigin: row.default_enabled===1n?'default':row.enabled_origin as 'user_action'|null,verificationState:row.verification_state as SkillVerificationState,
    verificationReason:row.verification_reason as string|null,currentRevisionNo:row.current_revision_no as bigint|null,headRevision:row.head_revision as bigint,
    revisions:revisions.map(r=>({revisionNo:r.revision_no as bigint,manifestDigest:r.manifest_digest as string,contentDigest:r.content_digest as string,
      sourceKind:'user_directory',verificationState:r.verification_state as 'verified'|'pending',verifiedAt:r.verified_at as bigint,availability:r.availability as 'current'|'unavailable'}))};
}
function expected(tx: StorageTransaction, input: unknown): SkillPackageState {
  const i=key(input) as Expected, item=state(tx,i.ownerId,i.id);
  if (typeof i.expectedHead!=='bigint' || i.expectedHead!==item.headRevision) fail('skill_revision_conflict');
  return item;
}
function relocation(input: unknown): SkillRootRelocation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('skill_input_invalid');
  const value=input as Partial<SkillRootRelocation>;
  const ownerId=text(value.ownerId);
  if (!Array.isArray(value.packages)) fail('skill_input_invalid');
  const ids=new Set<string>(),names=new Set<string>(),identities=new Set<string>();
  const packages=value.packages.map((entry):SkillRootRelocationPackage=>{
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('skill_input_invalid');
    const item=entry as Partial<SkillRootRelocationPackage>;
    const id=text(item.id),directoryName=text(item.directoryName),expectedDirectoryIdentity=text(item.expectedDirectoryIdentity),directoryIdentity=text(item.directoryIdentity);
    if (typeof item.expectedHead!=='bigint' || item.expectedHead<1n
      || typeof item.manifestDigest!=='string' || !/^[a-f0-9]{64}$/.test(item.manifestDigest)
      || typeof item.contentDigest!=='string' || !/^[a-f0-9]{64}$/.test(item.contentDigest)) fail('skill_input_invalid');
    if (ids.has(id) || names.has(directoryName) || identities.has(directoryIdentity)) fail('skill_root_relocation_conflict');
    ids.add(id);names.add(directoryName);identities.add(directoryIdentity);
    return {id,directoryName,expectedHead:item.expectedHead,expectedDirectoryIdentity,directoryIdentity,
      manifestDigest:item.manifestDigest,contentDigest:item.contentDigest};
  });
  return {ownerId,packages};
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
/** 与联系人／来源资格在同一短事务使用，避免末尾分离复验的交错窗口。 */
export function requireSkillRun(tx: StorageTransaction, ownerId: string, revision: SkillRunRevision): void {
  requireSkillOwner(tx,ownerId);
  const current=tx.all('SELECT id,head_revision FROM skill_package WHERE owner_id=?',[text(ownerId)]);
  if(current.length!==revision.packages.length || new Set(revision.packages.map(p=>p.id)).size!==current.length
    || current.some(row=>!revision.packages.some(p=>p.id===row.id && p.headRevision===row.head_revision)))fail('skill_run_invalidated');
  for(const anchor of revision.eligible)requireSkillRevision(tx,ownerId,anchor);
}
export const skillActions: StorageAction[] = [
  {name:'skills.list',mode:'read',retryBusy:false,execute(tx,input){
    const ownerId=text((input as {ownerId?:unknown})?.ownerId);
    requireSkillOwner(tx,ownerId);
    return tx.all('SELECT id FROM skill_package WHERE owner_id=? ORDER BY directory_name',[ownerId]).map(row=>state(tx,ownerId,row.id as string));
  }},
  {name:'skills.get',mode:'read',retryBusy:false,execute(tx,input){const i=key(input);return state(tx,i.ownerId,i.id);}},
  {name:'skills.associate',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as Key & {directoryName:string;directoryIdentity:string};
    requireSkillOwner(tx,i.ownerId);text(i.directoryName);text(i.directoryIdentity);
    const existing=tx.get('SELECT id FROM skill_package WHERE owner_id=? AND directory_name=?',[i.ownerId,i.directoryName]);
    if(existing)return state(tx,i.ownerId,existing.id as string);
    // 目录名是可展示元数据；发现不会读取正文，也不会发布可运行修订。
    tx.run(`INSERT INTO skill_package(owner_id,id,directory_name,directory_identity,display_name,description,enabled_state,enabled_origin,verification_state,verification_reason,current_revision_no,head_revision) VALUES(?,?,?,?,?,?,'unknown',NULL,'pending',NULL,NULL,1)`,[i.ownerId,i.id,i.directoryName,i.directoryIdentity,i.directoryName,'启用后校验策略说明']);
    return state(tx,i.ownerId,i.id);
  }},
  {name:'skills.relocateRoot',mode:'write',retryBusy:false,execute(tx,input){
    const i=relocation(input);requireSkillOwner(tx,i.ownerId);
    const rows=tx.all('SELECT id,directory_name,directory_identity,head_revision FROM skill_package WHERE owner_id=? ORDER BY id',[i.ownerId]);
    if (rows.length!==i.packages.length) fail('skill_root_relocation_conflict');
    const byId=new Map(i.packages.map(item=>[item.id,item]));
    for(const row of rows){
      const item=byId.get(row.id as string);
      if(!item)fail('skill_root_relocation_conflict');
      if(row.head_revision!==item.expectedHead)fail('skill_revision_conflict');
      if(row.directory_name!==item.directoryName || row.directory_identity!==item.expectedDirectoryIdentity)fail('skill_directory_conflict');
      const packageState=state(tx,i.ownerId,item.id);
      const latest=packageState.revisions.at(-1);
      if(latest && (latest.manifestDigest!==item.manifestDigest || latest.contentDigest!==item.contentDigest))fail('skill_content_changed');
    }
    // 先使用事务内唯一临时身份，避免合法身份交换触发表级唯一约束。
    const occupied=new Set([...rows.map(row=>row.directory_identity as string),...i.packages.map(item=>item.directoryIdentity)]);
    const temporary=i.packages.map(()=>{
      let identity:string;
      do {identity=`relocation:${randomUUID()}`;} while(occupied.has(identity));
      occupied.add(identity);return identity;
    });
    for(let index=0;index<i.packages.length;index++){
      const item=i.packages[index];
      tx.run('UPDATE skill_package SET directory_identity=? WHERE owner_id=? AND id=?',[temporary[index],i.ownerId,item.id]);
    }
    for(const item of i.packages){
      tx.run('UPDATE skill_package SET directory_identity=?,head_revision=head_revision+1 WHERE owner_id=? AND id=?',[item.directoryIdentity,i.ownerId,item.id]);
    }
    return tx.all('SELECT id FROM skill_package WHERE owner_id=? ORDER BY directory_name',[i.ownerId])
      .map(row=>state(tx,i.ownerId,row.id as string));
  }},
  {name:'skills.observe',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as SkillObservation;
    requireSkillOwner(tx,i.ownerId);
    for(const value of [i.directoryName,i.directoryIdentity,i.displayName,i.description]) text(value);
    if(!/^[a-f0-9]{64}$/.test(i.manifestDigest)||!/^[a-f0-9]{64}$/.test(i.contentDigest)||typeof i.verifiedAt!=='bigint'||i.verifiedAt<0n) fail('skill_input_invalid');
    const exists=tx.get('SELECT id FROM skill_package WHERE owner_id=? AND id=?',[i.ownerId,i.id]);
    if(!exists){
      if(i.expectedHead!==0n) fail('skill_revision_conflict');
      tx.run(`INSERT INTO skill_package(owner_id,id,directory_name,directory_identity,display_name,description,enabled_state,enabled_origin,verification_state,verification_reason,current_revision_no,head_revision) VALUES(?,?,?,?,?,?,'unknown',NULL,'pending',NULL,NULL,1)`,[i.ownerId,i.id,i.directoryName,i.directoryIdentity,i.displayName,i.description]);
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
  {name:'skills.rebindDirectory',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as SkillObservation & {expectedDirectoryIdentity:string},item=expected(tx,i);
    for(const value of [i.directoryName,i.directoryIdentity,i.expectedDirectoryIdentity,i.displayName,i.description])text(value);
    if(!/^[a-f0-9]{64}$/.test(i.manifestDigest)||!/^[a-f0-9]{64}$/.test(i.contentDigest)||typeof i.verifiedAt!=='bigint'||i.verifiedAt<0n)fail('skill_input_invalid');
    if(item.verificationReason==='source_qualification_changed')fail('skill_source_verification_required');
    if(item.directoryName!==i.directoryName || item.directoryIdentity!==i.expectedDirectoryIdentity)fail('skill_directory_conflict');
    // 物理定位可以迁移，内容只认最后一次核验；不能借迁移回退到任意历史版本。
    const latest=item.revisions.at(-1);
    if(!latest)fail('skill_directory_conflict');
    if(latest.manifestDigest!==i.manifestDigest || latest.contentDigest!==i.contentDigest)fail('skill_directory_content_changed');
    const number=latest.revisionNo+1n;
    tx.run("UPDATE skill_package_revision SET availability='unavailable' WHERE owner_id=? AND package_id=?",[i.ownerId,i.id]);
    tx.run("INSERT INTO skill_package_revision VALUES(?,?,?,?,?,'user_directory','verified',?,'current')",[i.ownerId,i.id,number,i.manifestDigest,i.contentDigest,i.verifiedAt]);
    tx.run("UPDATE skill_package SET directory_identity=?,display_name=?,description=?,verification_state='verified',verification_reason=NULL,current_revision_no=?,head_revision=head_revision+1 WHERE owner_id=? AND id=?",[i.directoryIdentity,i.displayName,i.description,number,i.ownerId,i.id]);
    return state(tx,i.ownerId,i.id);
  }},
  {name:'skills.setEnabled',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as Expected & {enabledState:SkillEnabledState};expected(tx,i);
    if(!['enabled','disabled'].includes(i.enabledState)) fail('skill_input_invalid');
    tx.run("UPDATE skill_package SET enabled_state=?,enabled_origin='user_action',default_enabled=0,head_revision=head_revision+1 WHERE owner_id=? AND id=?",[i.enabledState,i.ownerId,i.id]);
    return state(tx,i.ownerId,i.id);
  }},
  {name:'skills.defaultEnable',mode:'write',retryBusy:false,execute(tx,input){
    const i=key(input) as Expected,item=expected(tx,input);
    if(item.enabledState!=='unknown' || item.verificationState!=='verified' || item.verificationReason!==null || item.currentRevisionNo===null)
      fail('skill_default_enable_not_qualified');
    tx.run('UPDATE skill_package SET default_enabled=1,head_revision=head_revision+1 WHERE owner_id=? AND id=?',[i.ownerId,i.id]);
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
  {name:'skills.assertRevisions',mode:'read',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;anchors:SkillAnchor[]};
    if(!Array.isArray(i.anchors))throw new StorageFailure('skill_input_invalid');
    for(const anchor of i.anchors)requireSkillRevision(tx,i.ownerId,anchor);
    return true;
  }},
  {name:'skills.assertRevision',mode:'read',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;anchor:SkillAnchor}; requireSkillRevision(tx,i.ownerId,i.anchor);return true;
  }},
  {name:'skills.assertRun',mode:'read',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;revision:SkillRunRevision};requireSkillRun(tx,i.ownerId,i.revision);return true;
  }},
];


/** v23 用独立字段记录系统默认启用，保留用户明确启停及 v4 原表约束。 */
export const skillDefaultEnablementMigration = {
  version: 23,
  sql: `
ALTER TABLE skill_package ADD COLUMN default_enabled INTEGER NOT NULL DEFAULT 0 CHECK(default_enabled IN (0,1));
CREATE TRIGGER skill_default_enabled_insert_guard BEFORE INSERT ON skill_package
WHEN NEW.default_enabled=1 AND (NEW.enabled_state<>'unknown' OR NEW.enabled_origin IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'skill_default_enable_requires_unknown'); END;
CREATE TRIGGER skill_default_enabled_update_guard BEFORE UPDATE OF default_enabled,enabled_state,enabled_origin ON skill_package
WHEN NEW.default_enabled=1 AND (NEW.enabled_state<>'unknown' OR NEW.enabled_origin IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'skill_default_enable_requires_unknown'); END;
`,
} as const;

/** v24 仅补强默认启用资格检查，不改写已应用的 v23。 */
export const skillDefaultQualificationMigration = {
  version: 24,
  sql: `
DROP TRIGGER skill_default_enabled_insert_guard;
DROP TRIGGER skill_default_enabled_update_guard;
CREATE TRIGGER skill_default_enabled_insert_guard BEFORE INSERT ON skill_package
WHEN NEW.default_enabled=1 AND (NEW.enabled_state<>'unknown' OR NEW.enabled_origin IS NOT NULL
 OR NEW.verification_state<>'verified' OR NEW.current_revision_no IS NULL OR NEW.verification_reason IS NOT NULL
 OR NOT EXISTS (SELECT 1 FROM skill_package_revision r WHERE r.owner_id=NEW.owner_id AND r.package_id=NEW.id
   AND r.revision_no=NEW.current_revision_no AND r.verification_state='verified' AND r.availability='current'))
BEGIN SELECT RAISE(ABORT,'skill_default_enable_requires_unknown'); END;
CREATE TRIGGER skill_default_enabled_update_guard BEFORE UPDATE OF default_enabled,enabled_state,enabled_origin ON skill_package
WHEN NEW.default_enabled=1 AND (NEW.enabled_state<>'unknown' OR NEW.enabled_origin IS NOT NULL
 OR NEW.verification_state<>'verified' OR NEW.current_revision_no IS NULL OR NEW.verification_reason IS NOT NULL
 OR NOT EXISTS (SELECT 1 FROM skill_package_revision r WHERE r.owner_id=NEW.owner_id AND r.package_id=NEW.id
   AND r.revision_no=NEW.current_revision_no AND r.verification_state='verified' AND r.availability='current'))
BEGIN SELECT RAISE(ABORT,'skill_default_enable_requires_unknown'); END;
`,
} as const;
