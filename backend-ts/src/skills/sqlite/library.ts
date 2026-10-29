/** 用户 Skill 原目录只读；SQLite 只保存业务状态和不可变摘要，不复制历史文件。 */
import {randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {canonicalRoot,checkNoLinks,readBounded,readPackage,sha256,validateName,type SkillPackage} from '../skill-package.ts';
import type {SkillAnchor,SkillEnabledState,SkillPackageState,SkillVerificationState} from './contracts.ts';
import type {SkillObservation} from './storage.ts';

export class SqliteSkillError extends Error {
  readonly code: string;
  constructor(code: string) {super(code);this.code=code;}
}
export interface DirectorySnapshot {
  directoryName: string;
  directoryIdentity: string;
  manifestDigest: string;
  contentDigest: string;
  pkg: SkillPackage;
}
export function skillAnchor(item: SkillPackageState): SkillAnchor {
  const revision=item.revisions.find(r=>r.revisionNo===item.currentRevisionNo);
  if(!revision || revision.availability!=='current' || revision.verificationState!=='verified' || item.verificationState!=='verified')throw new SqliteSkillError('skill_unverified');
  return {packageId:item.id,revisionNo:revision.revisionNo,headRevision:item.headRevision,directoryIdentity:item.directoryIdentity,manifestDigest:revision.manifestDigest,contentDigest:revision.contentDigest};
}
export class SqliteSkillLibrary {
  readonly ownerId: string;
  private readonly root: string;
  private readonly storage: SqliteStorage;
  constructor(storage: SqliteStorage,ownerId: string,root: string) {
    if(!ownerId || !isAbsolute(root))throw new SqliteSkillError('skill_configuration_invalid');
    this.storage=storage;this.ownerId=ownerId;this.root=canonicalRoot(root);
  }
  list(): Promise<SkillPackageState[]> {return this.storage.execute('skills.list',{ownerId:this.ownerId});}
  /** 管理查询只检查现状；内容变更进入待核验，不在查询中接受新版本。 */
  async inspect(): Promise<SkillPackageState[]> {
    for(const item of await this.list()) {
      try {
        const snapshot=this.readDirectory(item.directoryName);
        if(snapshot.directoryIdentity!==item.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
        const current=item.revisions.find(r=>r.revisionNo===item.currentRevisionNo);
        if(current && (current.manifestDigest!==snapshot.manifestDigest || current.contentDigest!==snapshot.contentDigest))throw new SqliteSkillError('skill_content_changed');
      }catch(error){await this.recordProblem(item,error);}
    }
    return this.list();
  }
  get(id: string): Promise<SkillPackageState> {return this.storage.execute('skills.get',{ownerId:this.ownerId,id});}
  async discover(directoryName: string): Promise<SkillPackageState> {
    validateName(directoryName);
    const current=(await this.list()).find(item=>item.directoryName===directoryName);
    if(current)return this.verify(current.id,current.headRevision);
    const snapshot=this.readDirectory(directoryName);
    return this.commitObservation(randomUUID(),0n,snapshot);
  }
  async verify(id: string,expectedHead: bigint): Promise<SkillPackageState> {
    const item=await this.get(id);
    if(item.headRevision!==expectedHead)throw new SqliteSkillError('skill_revision_conflict');
    if(item.verificationReason==='source_qualification_changed')throw new SqliteSkillError('skill_source_verification_required');
    let snapshot: DirectorySnapshot;
    try {
      snapshot=this.readDirectory(item.directoryName);
      if(snapshot.directoryIdentity!==item.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
    } catch(error) {await this.recordProblem(item,error);throw error;}
    return this.commitObservation(id,expectedHead,snapshot);
  }
  setEnabled(id: string,expectedHead: bigint,enabledState: Exclude<SkillEnabledState,'unknown'>): Promise<SkillPackageState> {
    return this.storage.execute('skills.setEnabled',{ownerId:this.ownerId,id,expectedHead,enabledState});
  }
  /** 来源资格失效时由05调用；不删除目录，不将包复制成独立来源。 */
  requireVerification(id: string,expectedHead: bigint): Promise<SkillPackageState> {
    return this.storage.execute('skills.invalidate',{ownerId:this.ownerId,id,expectedHead,verificationState:'pending',reason:'source_qualification_changed'});
  }
  async assertAnchor(anchor: SkillAnchor): Promise<DirectorySnapshot> {
    await this.storage.execute('skills.assertRevision',{ownerId:this.ownerId,anchor});
    const item=await this.get(anchor.packageId);
    let snapshot: DirectorySnapshot;
    try {
      snapshot=this.readDirectory(item.directoryName);
      if(snapshot.directoryIdentity!==anchor.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
      if(snapshot.manifestDigest!==anchor.manifestDigest || snapshot.contentDigest!==anchor.contentDigest)throw new SqliteSkillError('skill_content_changed');
    }catch(error){await this.recordProblem(item,error);throw error;}
    await this.storage.execute('skills.assertRevision',{ownerId:this.ownerId,anchor});
    return snapshot;
  }
  private commitObservation(id: string,expectedHead: bigint,snapshot: DirectorySnapshot): Promise<SkillPackageState> {
    const input: SkillObservation={ownerId:this.ownerId,id,expectedHead,directoryName:snapshot.directoryName,
      directoryIdentity:snapshot.directoryIdentity,displayName:snapshot.pkg.name,description:snapshot.pkg.description,
      manifestDigest:snapshot.manifestDigest,contentDigest:snapshot.contentDigest,verifiedAt:BigInt(Date.now())};
    return this.storage.execute('skills.observe',input);
  }
  private readDirectory(directoryName: string): DirectorySnapshot {
    validateName(directoryName);
    const path=join(this.root,directoryName);checkNoLinks(path);
    const identity=()=>{const info=lstatSync(path,{bigint:true});if(!info.isDirectory())throw new SqliteSkillError('skill_directory_conflict');return JSON.stringify([path,info.dev.toString(),info.ino.toString()]);};
    const before=identity(),document=readBounded(join(path,'SKILL.md')),pkg=readPackage(path);
    // 原始文档和解析器读到的正文必须来自同一批字节，目录替换也拒绝。
    const bytes=[Buffer.from('SKILL.md\0'),document];
    for(const resource of pkg.resources)bytes.push(Buffer.from(resource.relative_path+'\0'),resource.content,Buffer.from('\0'));
    if(sha256(Buffer.concat(bytes))!==pkg.package_sha256 || identity()!==before)throw new SqliteSkillError('skill_content_changed');
    const manifest=[['SKILL.md',document.length,sha256(document)],...pkg.resources.map(r=>[r.relative_path,r.content.length,r.content_sha256])];
    return {directoryName,directoryIdentity:before,manifestDigest:sha256(JSON.stringify(manifest)),contentDigest:pkg.package_sha256,pkg};
  }
  private async recordProblem(item: SkillPackageState,error: unknown): Promise<void> {
    const code=(error as {code?:string})?.code;
    const verificationState: SkillVerificationState=code==='ENOENT'||code==='file_unavailable'?'missing':code==='skill_directory_conflict'?'conflict':code==='skill_content_changed'?'pending':'invalid';
    if(item.verificationState===verificationState && item.currentRevisionNo===null)return;
    try {await this.storage.execute('skills.invalidate',{ownerId:this.ownerId,id:item.id,expectedHead:item.headRevision,verificationState,reason:verificationState==='missing'?'directory_unavailable':verificationState==='conflict'?'directory_identity_changed':verificationState==='pending'?'content_changed':'package_invalid'});}
    catch(error){if((error as {code?:string}).code!=='skill_revision_conflict')throw error;}
  }
}
