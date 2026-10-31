/** 用户 Skill 原目录只读；SQLite 只保存业务状态和不可变摘要，不复制历史文件。 */
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {sha256,validateName,type SkillPackage} from '../skill-package.ts';
import type {SkillAnchor,SkillEnabledState,SkillPackageState,SkillVerificationState} from './contracts.ts';
import type {SkillObservation} from './storage.ts';
import {SecureSkillDirectory} from '../secure-directory.ts';

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
/** 管理核验与显式根迁移共用同一原生快照和摘要规则。 */
export function readSkillDirectorySnapshot(directory: SecureSkillDirectory,name: string,expectedIdentity: string): DirectorySnapshot {
  const snapshot=directory.snapshot(name,expectedIdentity),{document,pkg}=snapshot;
  const manifest=[['SKILL.md',document.length,sha256(document)],...pkg.resources.map(r=>[r.relative_path,r.content.length,r.content_sha256])];
  return {directoryName:name,directoryIdentity:snapshot.directoryIdentity,manifestDigest:sha256(JSON.stringify(manifest)),contentDigest:pkg.package_sha256,pkg};
}
export function skillAnchor(item: SkillPackageState): SkillAnchor {
  const revision=item.revisions.find(r=>r.revisionNo===item.currentRevisionNo);
  if(!revision || revision.availability!=='current' || revision.verificationState!=='verified' || item.verificationState!=='verified')throw new SqliteSkillError('skill_unverified');
  return {packageId:item.id,revisionNo:revision.revisionNo,headRevision:item.headRevision,directoryIdentity:item.directoryIdentity,manifestDigest:revision.manifestDigest,contentDigest:revision.contentDigest};
}
export class SqliteSkillLibrary {
  readonly ownerId: string;
  private readonly directory: SecureSkillDirectory;
  private readonly storage: SqliteStorage;
  constructor(storage: SqliteStorage,ownerId: string,root: string) {
    if(!ownerId || !isAbsolute(root))throw new SqliteSkillError('skill_configuration_invalid');
    this.storage=storage;this.ownerId=ownerId;this.directory=new SecureSkillDirectory(root);
  }
  list(): Promise<SkillPackageState[]> {return this.storage.execute('skills.list',{ownerId:this.ownerId});}
  /** 管理刷新与运行前共用；只在明确配置的根内发现目录，不读取未启用正文。 */
  async refresh(): Promise<SkillPackageState[]> {
    await this.list(); // 在接触文件前拒绝已删除或不可用的账号。
    for(const name of this.directory.names())await this.discover(name);
    for(const item of await this.list()) {
      try {
        if(this.directory.directoryIdentity(item.directoryName)!==item.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
        // 停用/未知仅检查目录身份；来源撤销和身份冲突不能由扫描重新发布。
        if(item.enabledState==='enabled' && item.verificationReason!=='source_qualification_changed' && item.verificationState!=='conflict') {
          const snapshot=this.readDirectory(item.directoryName,item.directoryIdentity);
          if(snapshot.directoryIdentity!==item.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
          await this.commitObservation(item.id,item.headRevision,snapshot);
        }
      }catch(error){
        if((error as {code?:string})?.code==='skill_revision_conflict')continue;
        await this.recordProblem(item,error);
      }
    }
    return this.list();
  }
  inspect(): Promise<SkillPackageState[]> {return this.refresh();}
  get(id: string): Promise<SkillPackageState> {return this.storage.execute('skills.get',{ownerId:this.ownerId,id});}
  async discover(directoryName: string): Promise<SkillPackageState> {
    validateName(directoryName);
    const current=(await this.list()).find(item=>item.directoryName===directoryName);
    if(current)return current;
    let identity: string;
    try {identity=this.directory.directoryIdentity(directoryName);}
    catch(error){throw this.directoryError(error);}
    return this.storage.execute('skills.associate',{ownerId:this.ownerId,id:randomUUID(),directoryName,directoryIdentity:identity});
  }
  async verify(id: string,expectedHead: bigint): Promise<SkillPackageState> {
    const item=await this.get(id);
    if(item.headRevision!==expectedHead)throw new SqliteSkillError('skill_revision_conflict');
    if(item.verificationReason==='source_qualification_changed')throw new SqliteSkillError('skill_source_verification_required');
    let snapshot: DirectorySnapshot;
    try {
      snapshot=this.readDirectory(item.directoryName,item.directoryIdentity);
      if(snapshot.directoryIdentity!==item.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
    } catch(error) {await this.recordProblem(item,error);throw error;}
    return this.commitObservation(id,expectedHead,snapshot);
  }
  async setEnabled(id: string,expectedHead: bigint,enabledState: Exclude<SkillEnabledState,'unknown'>): Promise<SkillPackageState> {
    if(enabledState==='enabled') {
      // 用户明确启用才授予技术核验读取；核验/启用分别以 CAS 拒绝并发停用。
      const verified=await this.verify(id,expectedHead);
      return this.storage.execute('skills.setEnabled',{ownerId:this.ownerId,id,expectedHead:verified.headRevision,enabledState});
    }
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
      snapshot=this.readDirectory(item.directoryName,item.directoryIdentity);
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
  private readDirectory(directoryName: string,expectedIdentity:string): DirectorySnapshot {
    try {return this.readDirectorySnapshot(directoryName,expectedIdentity);}
    catch(error) {
      if(error instanceof SqliteSkillError || (error as {code?:string})?.code?.startsWith('skill_'))throw error;
      throw this.directoryError(error);
    }
  }
  private directoryError(error: unknown): SqliteSkillError {
    const code=(error as {code?:string})?.code;
    return new SqliteSkillError(code==='ENOENT'||code==='EACCES'||code==='file_unavailable'?'skill_directory_unavailable':'skill_package_invalid');
  }
  private readDirectorySnapshot(directoryName: string,expectedIdentity:string): DirectorySnapshot {
    return readSkillDirectorySnapshot(this.directory,directoryName,expectedIdentity);
  }
  private async recordProblem(item: SkillPackageState,error: unknown): Promise<void> {
    let code=(error as {code?:string})?.code;
    if(code==='ENOENT' || code==='EACCES' || code==='file_unavailable')code='skill_directory_unavailable';
    const verificationState: SkillVerificationState=code==='skill_directory_unavailable'?'missing':code==='skill_directory_conflict'?'conflict':code==='skill_content_changed'?'pending':'invalid';
    if(item.verificationState===verificationState && item.currentRevisionNo===null)return;
    try {await this.storage.execute('skills.invalidate',{ownerId:this.ownerId,id:item.id,expectedHead:item.headRevision,verificationState,reason:verificationState==='missing'?'directory_unavailable':verificationState==='conflict'?'directory_identity_changed':verificationState==='pending'?'content_changed':'package_invalid'});}
    catch(error){if((error as {code?:string}).code!=='skill_revision_conflict')throw error;}
  }
}
