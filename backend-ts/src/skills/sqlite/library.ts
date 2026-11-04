/** 用户 Skill 原目录只读；SQLite 只保存业务状态和不可变摘要，不复制历史文件。 */
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {sha256,validateName,type SkillPackage} from '../skill-package.ts';
import type {SkillAnchor,SkillEnabledState,SkillPackageState,SkillVerificationState} from './contracts.ts';
import type {SkillObservation} from './storage.ts';
import {SecureSkillDirectory} from '../secure-directory.ts';
import {AsyncSecureSkillDirectory} from '../secure-directory-async.ts';

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
export interface VerifiedSkillSnapshot {
  item: SkillPackageState;
  anchor: SkillAnchor;
  snapshot: DirectorySnapshot;
}
type RefreshWork={controller:AbortController;promise:Promise<SkillPackageState[]>;waiters:number;settled:boolean};
/** 管理核验与显式根迁移共用同一原生快照和摘要规则。 */
export function readSkillDirectorySnapshot(directory: SecureSkillDirectory,name: string,expectedIdentity: string): DirectorySnapshot {
  return directorySnapshot(name,directory.snapshot(name,expectedIdentity));
}
function directorySnapshot(name:string,snapshot:ReturnType<SecureSkillDirectory['snapshot']>):DirectorySnapshot{
  const {document,pkg}=snapshot;
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
  private readonly directory: AsyncSecureSkillDirectory;
  private readonly storage: SqliteStorage;
  private readonly controller=new AbortController();
  private readonly pending=new Set<Promise<unknown>>();
  private closing?:Promise<void>;
  private refreshInFlight?:RefreshWork;
  constructor(storage: SqliteStorage,ownerId: string,root: string,options:{readerBinary?:string}={}) {
    if(!ownerId || !isAbsolute(root))throw new SqliteSkillError('skill_configuration_invalid');
    this.storage=storage;this.ownerId=ownerId;this.directory=new AsyncSecureSkillDirectory(root,options.readerBinary);
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.controller.abort(new SqliteSkillError('skill_library_closed'));
    return this.closing=(async()=>{await Promise.all([this.directory.close(),Promise.allSettled([...this.pending])]);})();
  }
  private active(signal?:AbortSignal):void{this.controller.signal.throwIfAborted();signal?.throwIfAborted();}
  private signal(signal?:AbortSignal):AbortSignal{return signal?AbortSignal.any([this.controller.signal,signal]):this.controller.signal;}
  private async execute<T=any>(name:string,input:unknown,signal?:AbortSignal):Promise<T>{
    this.active(signal);
    const pending=this.storage.execute<T>(name,input);this.pending.add(pending);
    try{const value=await pending;this.active(signal);return value;}
    finally{this.pending.delete(pending);}
  }
  list(signal?:AbortSignal): Promise<SkillPackageState[]> {return this.execute('skills.list',{ownerId:this.ownerId},signal);}
  /** 管理刷新与运行前共用；在授权根中发现、核验并默认启用合格项目，保留用户停用。 */
  refresh(signal?:AbortSignal): Promise<SkillPackageState[]> {
    if(signal?.aborted)return Promise.reject(signal.reason);
    let current=this.refreshInFlight;
    if(!current||current.controller.signal.aborted){
      const controller=new AbortController(),pending=this.refreshCurrent(this.signal(controller.signal));
      const work:RefreshWork={controller,promise:pending,waiters:0,settled:false};
      work.promise=pending.finally(()=>{work.settled=true;if(this.refreshInFlight===work)this.refreshInFlight=undefined;});
      this.refreshInFlight=current=work;
    }
    const work=current;work.waiters++;
    return new Promise((resolve,reject)=>{
      let finished=false;
      const leave=()=>{
        if(finished)return;finished=true;signal?.removeEventListener('abort',abort);
        if(--work.waiters===0&&!work.settled)work.controller.abort(new SqliteSkillError('skill_refresh_cancelled'));
      };
      const abort=()=>{leave();reject(signal!.reason);};
      signal?.addEventListener('abort',abort,{once:true});
      work.promise.then(value=>{leave();resolve(value);},error=>{leave();reject(error);});
    });
  }
  private async refreshCurrent(signal=this.controller.signal): Promise<SkillPackageState[]> {
    const catalog=await this.list(signal); // 在接触文件前拒绝已删除或不可用的账号。
    const known=new Set(catalog.map(item=>item.directoryName));
    for(const name of await this.directory.names(signal))if(!known.has(name))catalog.push(await this.associateDirectory(name,signal));
    for(const item of catalog) {
      try {
        if(item.enabledState==='disabled' || item.verificationReason==='source_qualification_changed') {
          if(await this.directory.directoryIdentity(item.directoryName,signal)!==item.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
          continue;
        }
        // 原生快照在读取正文前已核对目录身份，无需另起进程重复检查。
        let snapshot: DirectorySnapshot;
        try {snapshot=await this.readDirectory(item.directoryName,item.directoryIdentity,signal);}
        catch(error) {
          if((error as {code?:string})?.code!=='skill_directory_conflict')throw error;
          await this.defaultEnable(await this.rebindDirectory(item,signal),signal);
          continue;
        }
        const current=item.revisions.find(revision=>revision.revisionNo===item.currentRevisionNo);
        if(item.enabledState==='enabled' && item.verificationState==='verified' && current?.availability==='current'
          && current.manifestDigest===snapshot.manifestDigest && current.contentDigest===snapshot.contentDigest)continue;
        const verified=await this.commitObservation(item.id,item.headRevision,snapshot,signal);
        // 默认开启只适用于完整核验成功的未知项；CAS 保留并发显式停用优先级。
        await this.defaultEnable(verified,signal);
      }catch(error){
        this.active(signal);
        if((error as {code?:string})?.code==='skill_revision_conflict')continue;
        await this.recordProblem(item,error,signal);
      }
    }
    return this.list(signal);
  }
  inspect(signal?:AbortSignal): Promise<SkillPackageState[]> {return this.refresh(signal);}
  get(id: string,signal?:AbortSignal): Promise<SkillPackageState> {return this.execute('skills.get',{ownerId:this.ownerId,id},signal);}
  async discover(directoryName: string,signal?:AbortSignal): Promise<SkillPackageState> {
    return this.change(async()=>{
      validateName(directoryName);
      const current=(await this.list(signal)).find(item=>item.directoryName===directoryName);
      return current??this.associateDirectory(directoryName,signal);
    });
  }
  private async associateDirectory(directoryName: string,signal?:AbortSignal): Promise<SkillPackageState> {
    let identity: string;
    try {identity=await this.directory.directoryIdentity(directoryName,this.signal(signal));}
    catch(error){this.active(signal);throw this.directoryError(error);}
    return this.execute('skills.associate',{ownerId:this.ownerId,id:randomUUID(),directoryName,directoryIdentity:identity},signal);
  }
  async verify(id: string,expectedHead: bigint,signal?:AbortSignal): Promise<SkillPackageState> {
    return this.change(async()=>{
      const item=await this.get(id,signal);
      if(item.headRevision!==expectedHead)throw new SqliteSkillError('skill_revision_conflict');
      if(item.verificationReason==='source_qualification_changed')throw new SqliteSkillError('skill_source_verification_required');
      let snapshot: DirectorySnapshot;
      try {
        try {snapshot=await this.readDirectory(item.directoryName,item.directoryIdentity,signal);}
        catch(error) {
          if((error as {code?:string})?.code!=='skill_directory_conflict')throw error;
          return await this.rebindDirectory(item,signal);
        }
        if(snapshot.directoryIdentity!==item.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
      } catch(error) {this.active(signal);await this.recordProblem(item,error,signal);throw error;}
      return this.commitObservation(id,expectedHead,snapshot,signal);
    });
  }
  async setEnabled(id: string,expectedHead: bigint,enabledState: Exclude<SkillEnabledState,'unknown'>,signal?:AbortSignal): Promise<SkillPackageState> {
    return this.change(async()=>{
      if(enabledState==='enabled') {
        // 用户明确启用才授予技术核验读取；核验/启用分别以 CAS 拒绝并发停用。
        const verified=await this.verify(id,expectedHead,signal);
        return this.execute('skills.setEnabled',{ownerId:this.ownerId,id,expectedHead:verified.headRevision,enabledState},signal);
      }
      return this.execute('skills.setEnabled',{ownerId:this.ownerId,id,expectedHead,enabledState},signal);
    });
  }
  /** 来源资格失效时由05调用；不删除目录，不将包复制成独立来源。 */
  requireVerification(id: string,expectedHead: bigint,signal?:AbortSignal): Promise<SkillPackageState> {
    return this.change(()=>this.execute('skills.invalidate',{ownerId:this.ownerId,id,expectedHead,verificationState:'pending',reason:'source_qualification_changed'},signal));
  }
  /** 只共享在途只读核验；显式操作开始和完成后均须脱离旧一轮结果。 */
  private async change<T>(operation:()=>Promise<T>): Promise<T> {
    this.refreshInFlight=undefined;
    try {return await operation();}
    finally {this.refreshInFlight=undefined;}
  }
  async assertAnchor(anchor: SkillAnchor,signal?:AbortSignal): Promise<DirectorySnapshot> {
    return (await this.assertAnchors([anchor],signal))[0]!.snapshot;
  }
  /** 先在一个短事务中复验全部anchor，再逐个读取目录，最后再次原子复验；避免逐Skill放大主worker往返。 */
  async assertAnchors(anchors: readonly SkillAnchor[],signal?:AbortSignal,catalog?:readonly SkillPackageState[]): Promise<VerifiedSkillSnapshot[]> {
    this.active(signal);
    if(!Array.isArray(anchors))throw new SqliteSkillError('skill_input_invalid');
    await this.execute('skills.assertRevisions',{ownerId:this.ownerId,anchors},signal);
    const items=catalog??await this.list(signal),byId=new Map(items.map(item=>[item.id,item])),verified:VerifiedSkillSnapshot[]=[];
    for(const anchor of anchors){
      const item=byId.get(anchor.packageId);
      if(!item)throw new SqliteSkillError('skill_run_invalidated');
      let snapshot: DirectorySnapshot;
      try {
        snapshot=await this.readDirectory(item.directoryName,item.directoryIdentity,signal);
        if(snapshot.directoryIdentity!==anchor.directoryIdentity)throw new SqliteSkillError('skill_directory_conflict');
        if(snapshot.manifestDigest!==anchor.manifestDigest || snapshot.contentDigest!==anchor.contentDigest)throw new SqliteSkillError('skill_content_changed');
      }catch(error){this.active(signal);await this.change(()=>this.recordProblem(item,error,signal));throw error;}
      verified.push({item,anchor:{...anchor},snapshot});
    }
    await this.execute('skills.assertRevisions',{ownerId:this.ownerId,anchors},signal);
    return verified;
  }
  private commitObservation(id: string,expectedHead: bigint,snapshot: DirectorySnapshot,signal?:AbortSignal): Promise<SkillPackageState> {
    const input: SkillObservation={ownerId:this.ownerId,id,expectedHead,directoryName:snapshot.directoryName,
      directoryIdentity:snapshot.directoryIdentity,displayName:snapshot.pkg.name,description:snapshot.pkg.description,
      manifestDigest:snapshot.manifestDigest,contentDigest:snapshot.contentDigest,verifiedAt:BigInt(Date.now())};
    return this.execute('skills.observe',input,signal);
  }
  private async defaultEnable(item: SkillPackageState,signal?:AbortSignal): Promise<void> {
    if(item.enabledState==='unknown')await this.execute('skills.defaultEnable',{
      ownerId:this.ownerId,id:item.id,expectedHead:item.headRevision,
    },signal);
  }
  /** 只在已授权根中读取当前快照；数据库原子复验最新摘要和资格后重建定位。 */
  private async rebindDirectory(item: SkillPackageState,signal?:AbortSignal): Promise<SkillPackageState> {
    const identity=await this.directory.directoryIdentity(item.directoryName,this.signal(signal));
    const snapshot=await this.readDirectory(item.directoryName,identity,signal);
    return this.execute('skills.rebindDirectory',{
      ownerId:this.ownerId,id:item.id,expectedHead:item.headRevision,expectedDirectoryIdentity:item.directoryIdentity,
      directoryName:snapshot.directoryName,directoryIdentity:snapshot.directoryIdentity,
      displayName:snapshot.pkg.name,description:snapshot.pkg.description,
      manifestDigest:snapshot.manifestDigest,contentDigest:snapshot.contentDigest,verifiedAt:BigInt(Date.now()),
    },signal);
  }
  private async readDirectory(directoryName: string,expectedIdentity:string,signal?:AbortSignal): Promise<DirectorySnapshot> {
    try {return await this.readDirectorySnapshot(directoryName,expectedIdentity,signal);}
    catch(error) {
      this.active(signal);
      if(error instanceof SqliteSkillError || (error as {code?:string})?.code?.startsWith('skill_'))throw error;
      throw this.directoryError(error);
    }
  }
  private directoryError(error: unknown): SqliteSkillError {
    const code=(error as {code?:string})?.code;
    if(code==='skill_reader_busy'||code==='skill_reader_unavailable')return new SqliteSkillError(code);
    return new SqliteSkillError(code==='ENOENT'||code==='EACCES'||code==='file_unavailable'?'skill_directory_unavailable':'skill_package_invalid');
  }
  private async readDirectorySnapshot(directoryName: string,expectedIdentity:string,signal?:AbortSignal): Promise<DirectorySnapshot> {
    return directorySnapshot(directoryName,await this.directory.snapshot(directoryName,expectedIdentity,this.signal(signal)));
  }
  private async recordProblem(item: SkillPackageState,error: unknown,signal?:AbortSignal): Promise<void> {
    this.active(signal);
    let code=(error as {code?:string})?.code;
    if(code==='skill_reader_busy'||code==='skill_reader_unavailable')throw error;
    if(code==='ENOENT' || code==='EACCES' || code==='file_unavailable')code='skill_directory_unavailable';
    const verificationState: SkillVerificationState=code==='skill_directory_unavailable'?'missing':code==='skill_directory_conflict'||code==='skill_directory_content_changed'?'conflict':code==='skill_content_changed'?'pending':'invalid';
    const reason=item.verificationReason==='source_qualification_changed'?item.verificationReason:verificationState==='missing'?'directory_unavailable':code==='skill_directory_content_changed'?'directory_content_changed':verificationState==='conflict'?'directory_identity_changed':verificationState==='pending'?'content_changed':'package_invalid';
    if(item.verificationState===verificationState && item.verificationReason===reason && item.currentRevisionNo===null)return;
    try {await this.execute('skills.invalidate',{ownerId:this.ownerId,id:item.id,expectedHead:item.headRevision,verificationState,reason},signal);}
    catch(error){if((error as {code?:string}).code!=='skill_revision_conflict')throw error;}
  }
}
