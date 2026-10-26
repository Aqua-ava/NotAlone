/** Skill 管理业务；模型只读端口不引用此模块。沿用103结构和不可变文件定位。 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {DeleteSkillReplies} from './skill-cleanup.ts';
import type {SkillDiscussionValidator} from './skill-source-proof.ts';
import { HostStorage, HostStorageError } from '../platform/database/host-storage.ts';
import { SkillFiles, matchesSkillPackage, type SkillVersionFiles } from './skill-files.ts';
import { readPackage, SkillPackageError, type SkillPackage } from './skill-package.ts';

export class SkillLibraryError extends HostStorageError {
  readonly status: number;
  readonly reason?: string;
  constructor(code: string, status = 500, reason?: string) { super(code); this.status=status; this.reason=reason; }
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function skillLibraryRoute(_method: string, pathname: string): boolean { return pathname==='/api/skills' || pathname.startsWith('/api/skills/'); }
export const skillVersionQuery=`SELECT version.*,skill.owner_id,skill.name,skill.status AS skill_status FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id`;
export async function lockSkillOwner(client: pg.Client, owner: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
  if(!(await client.query('SELECT 1 FROM public.owner WHERE id=$1',[owner])).rowCount)throw new SkillLibraryError('skill_unavailable',503);
  await client.query('INSERT INTO public.skill_library(owner_id,revision) VALUES($1,0) ON CONFLICT DO NOTHING',[owner]);
}
export async function bumpSkillRevision(client: pg.Client,owner: string): Promise<number> {
  return Number((await client.query('UPDATE public.skill_library SET revision=revision+1,updated_at=now() WHERE owner_id=$1 RETURNING revision',[owner])).rows[0].revision);
}
export interface SkillLibraryOptions {
  deleteSourceReplies?: DeleteSkillReplies;
  requireDiscussionDependencies?: SkillDiscussionValidator;
  eraseManagedBackups?: (client: pg.Client) => Promise<unknown>;
}
export class SkillLibrary {
  readonly storage: HostStorage;
  readonly files: SkillFiles;
  private readonly failures=new Map<string,{operation:string;code:string;skill_id:string|null;occurred_at:string}>();
  private fileFailure(owner:string,operation:string,code:string|null,skill:string|null=null):void {
    const key=JSON.stringify([owner,operation,skill]);
    if(code)this.failures.set(key,{operation,code,skill_id:skill,occurred_at:new Date().toISOString()});else this.failures.delete(key);
    while(this.failures.size>512)this.failures.delete(this.failures.keys().next().value!);
  }
  async fileHealth(owner=this.owner()):Promise<unknown> {
    return this.readTransaction(async client=>{
      const working=Number((await client.query('SELECT count(*) AS count FROM public.reply_skill_working_copy job JOIN public.reply_skill skill ON skill.id=job.skill_id WHERE skill.owner_id=$1',[owner])).rows[0].count);
      const cleanup=Number((await client.query(`SELECT count(*) AS count FROM public.reply_skill_file_cleanup WHERE relative_path=$1 OR starts_with(relative_path,$1||'/') OR starts_with(relative_path,'.versions/'||$1||'/') OR starts_with(relative_path,'.staging/'||$1||'/')`,[owner])).rows[0].count);
      const failures=[...this.failures].filter(([key])=>JSON.parse(key)[0]===owner).map(([,value])=>value);
      return {state:working||cleanup||failures.length?'degraded':'ok',pending_working_copies:working,pending_cleanup_files:cleanup,failures};
    },()=>{});
  }
  readonly options: SkillLibraryOptions;
  constructor(storage: HostStorage, files: SkillFiles, options: SkillLibraryOptions = {}) { this.storage=storage; this.files=files; this.options=options; }
  private owner(): string {
    const owner=this.storage.runtimeOwnerId?.toLowerCase();
    if(!owner || !uuid.test(owner))throw new SkillLibraryError('skill_unavailable',503);
    return owner;
  }
  async handle(method: string,url: URL,body?: unknown,assertCurrent: () => void = () => {}): Promise<unknown> {
    const owner=this.owner(); assertCurrent();
    const path=url.pathname;
    if(path==='/api/skills/health' && method==='GET')return this.fileHealth(owner);
    if(path==='/api/skills' && method==='GET')return {skills:await this.list(owner,assertCurrent)};
    if(path==='/api/skills/import' && method==='POST') {
      const value=body as {package_path?:unknown};
      if(!value || typeof value.package_path!=='string' || !value.package_path.trim())throw new SkillLibraryError('skill_request_invalid',400);
      return this.importPackage(owner,value.package_path,assertCurrent);
    }
    const match=/^\/api\/skills\/([^/]+)\/(preview|versions|enable|disable|delete|rollback)$/.exec(path);
    if(!match || !uuid.test(match[1]))throw new SkillLibraryError('skill_request_invalid',400);
    const [,id,action]=match;
    if(['preview','versions'].includes(action) ? method!=='GET' : method!=='POST')throw new SkillLibraryError('skill_request_invalid',400);
    if(action==='preview')return this.preview(owner,id,assertCurrent);
    if(action==='versions')return {versions:await this.versions(owner,id,assertCurrent)};
    if(action==='delete')return this.delete(owner,id,assertCurrent);
    if(action==='rollback') {
      const version=(body as {version_id?:unknown})?.version_id;
      if(typeof version!=='string' || !uuid.test(version))throw new SkillLibraryError('skill_request_invalid',400);
      return this.rollback(owner,id,version,assertCurrent);
    }
    return this.setStatus(owner,id,action==='enable'?'active':'disabled',assertCurrent);
  }
  private async transaction<T>(owner: string,operation: (client: pg.Client)=>Promise<T>,assertCurrent: ()=>void): Promise<T> {
    return this.storage.businessTransaction(async client=>{
      assertCurrent(); await lockSkillOwner(client,owner);
      const result=await operation(client); assertCurrent(); return result;
    }).catch(error=>{if(error instanceof SkillLibraryError)throw error;throw new SkillLibraryError('skill_persistence_failed');});
  }
  private async readTransaction<T>(operation: (client: pg.Client)=>Promise<T>,assertCurrent: ()=>void): Promise<T> {
    return this.storage.businessReadTransaction(async client=>{assertCurrent();await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${this.owner()}`]);const result=await operation(client);assertCurrent();return result;})
      .catch(error=>{if(error instanceof SkillLibraryError)throw error;throw new SkillLibraryError('skill_persistence_failed');});
  }
  private async skill(client: pg.Client,owner: string,id: string,allowDeleted=false,lock=true): Promise<pg.QueryResultRow> {
    const row=(await client.query('SELECT * FROM public.reply_skill WHERE owner_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[owner,id])).rows[0];
    if(!row)throw new SkillLibraryError('skill_not_found',404,'skill_not_found');
    if(row.status==='deleted' && !allowDeleted)throw new SkillLibraryError('skill_deleted',409,'skill_deleted');
    return row;
  }
  private async version(client: pg.Client,owner: string,id: string,version?: string): Promise<SkillVersionFiles & pg.QueryResultRow> {
    const row=(await client.query(`${skillVersionQuery} WHERE skill.owner_id=$1 AND skill.id=$2 AND version.status='active' AND ${version?'version.id=$3':'version.is_current'}`,[owner,id,...(version?[version]:[])])).rows[0];
    if(!row)throw new SkillLibraryError('skill_version_not_found',404,'skill_version_not_found');
    return row;
  }
  private async insertVersion(client: pg.Client,owner: string,id: string,number: number,pkg: SkillPackage,working=true): Promise<string> {
    const version=randomUUID(); const location=this.files.prepareVersion(owner,id,version,pkg);
    await client.query(`INSERT INTO public.reply_skill_version(id,skill_id,version_number,content_sha256,source_locator,enabled,is_current,status,content_path,document_sha256,manifest_sha256)
      VALUES($1,$2,$3,$4,$5,true,true,'active',$6,$7,$8)`,[version,id,number,location.content_sha256,`local-package:${pkg.package_sha256}`,location.content_path,location.document_sha256,location.manifest_sha256]);
    if(working)await client.query(`INSERT INTO public.reply_skill_working_copy(skill_id,version_id) VALUES($1,$2) ON CONFLICT(skill_id) DO UPDATE SET version_id=excluded.version_id`,[id,version]);
    return version;
  }
  async importPackage(owner: string,path: string,assertCurrent=()=>{}): Promise<unknown> {
    let pkg: SkillPackage;
    try { pkg=readPackage(path); } catch { throw new SkillLibraryError('skill_import_rejected',409,'package_invalid'); }
    const result=await this.transaction(owner,async client=>{
      if((await client.query('SELECT id FROM public.reply_skill WHERE owner_id=$1 AND name=$2',[owner,pkg.name])).rowCount)throw new SkillLibraryError('skill_import_rejected',409,'package_invalid');
      const id=randomUUID();
      await client.query("INSERT INTO public.reply_skill(id,owner_id,name,status) VALUES($1,$2,$3,'active')",[id,owner,pkg.name]);
      await this.insertVersion(client,owner,id,1,pkg);
      return {skill_id:id,name:pkg.name,version_number:1,revision:await bumpSkillRevision(client,owner),warnings:pkg.warnings};
    },assertCurrent);
    await this.reconcileFiles(owner); return result;
  }
  /** 显式管理更新；不注册新 HTTP 路由，也不作为学习审核批准。 */
  async updatePackage(owner: string,path: string,assertCurrent=()=>{}): Promise<unknown> {
    let pkg: SkillPackage;
    try {pkg=readPackage(path);} catch {throw new SkillLibraryError('skill_import_rejected',409,'package_invalid');}
    const result=await this.transaction(owner,async client=>{
      const found=(await client.query('SELECT id FROM public.reply_skill WHERE owner_id=$1 AND name=$2',[owner,pkg.name])).rows[0];
      if(!found)throw new SkillLibraryError('skill_not_found',404,'skill_not_found');
      const skill=await this.skill(client,owner,found.id);
      const previous=await this.version(client,owner,skill.id);
      // 带审核来源的工作副本不能经普通更新洗去来源和政策。
      if(previous.review_origin)throw new SkillLibraryError('skill_review_required',409);
      const number=Number((await client.query('SELECT coalesce(max(version_number),0)+1 AS number FROM public.reply_skill_version WHERE skill_id=$1',[skill.id])).rows[0].number);
      await client.query('UPDATE public.reply_skill_version SET is_current=false WHERE skill_id=$1 AND is_current',[skill.id]);
      const version=await this.insertVersion(client,owner,skill.id,number,pkg);
      if(!previous.enabled)await client.query('UPDATE public.reply_skill_version SET enabled=false WHERE id=$1',[version]);
      await client.query('UPDATE public.reply_skill SET updated_at=now() WHERE id=$1',[skill.id]);
      return {skill_id:skill.id,version_id:version,name:pkg.name,version_number:number,revision:await bumpSkillRevision(client,owner),status:skill.status};
    },assertCurrent);
    await this.reconcileFiles(owner);return result;
  }
  async exportPackage(owner: string,id: string,destination: string,assertCurrent=()=>{}): Promise<unknown> {
    return this.readTransaction(async client=>{
      await this.skill(client,owner,id,false,false);const row=await this.version(client,owner,id);
      await this.requireSources(client,owner,row.id);assertCurrent();const exported=this.files.exportPackage(row,destination);
      return {owner_id:owner,skill_id:id,name:row.name,version_number:row.version_number,...exported};
    },assertCurrent);
  }
  async list(owner: string,assertCurrent=()=>{}): Promise<unknown[]> {
    await this.synchronize(owner,assertCurrent);
    return this.transaction(owner,async client=>{
      const rows=(await client.query(`SELECT skill.id AS skill_id,skill.name,skill.status,skill.contact_id,version.id AS current_version_id,
        version.version_number AS current_version_number,coalesce(version.enabled,false) AS enabled
        FROM public.reply_skill skill LEFT JOIN public.reply_skill_version version ON version.skill_id=skill.id AND version.is_current AND version.status='active'
        WHERE skill.owner_id=$1 ORDER BY skill.created_at,skill.id`,[owner])).rows;
      for(const row of rows)row.description=row.current_version_id?this.files.readManifest(await this.version(client,owner,row.skill_id)).description:'暂无可用版本';
      return rows;
    },assertCurrent);
  }
  async preview(owner: string,id: string,assertCurrent=()=>{}): Promise<unknown> {
    return this.readTransaction(async client=>{
      await this.skill(client,owner,id,false,false); const row=await this.version(client,owner,id);
      await this.requireSources(client,owner,row.id);
      const manifest=this.files.readManifest(row as SkillVersionFiles);
      return {skill_id:id,name:null,description:manifest.description,version_number:row.version_number,document:this.files.readContent(row),resources:manifest.resources.map(x=>x.relative_path)};
    },assertCurrent);
  }
  async versions(owner: string,id: string,assertCurrent=()=>{}): Promise<unknown[]> {
    return this.readTransaction(async client=>{
      const historyQuery=skillVersionQuery.replace('SELECT version.*', `SELECT CASE WHEN extract(microseconds from version.created_at)::bigint % 1000000=0 THEN to_char(version.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS') ELSE to_char(version.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') END || '+00:00' AS created_at_wire,version.*`);
      const rows=(await client.query(`${historyQuery} WHERE skill.owner_id=$1 AND skill.id=$2 AND version.status='active' ORDER BY version.version_number DESC`,[owner,id])).rows;
      return rows.map(row=>{const manifest=this.files.readManifest(row as SkillVersionFiles);return {version_id:row.id,version_number:row.version_number,name:manifest.name,description:manifest.description,is_current:row.is_current,enabled:row.enabled,created_at:row.created_at_wire};});
    },assertCurrent);
  }
  async setStatus(owner: string,id: string,status: 'active'|'disabled',assertCurrent=()=>{}): Promise<unknown> {
    return this.transaction(owner,async client=>{
      const skill=await this.skill(client,owner,id); await this.version(client,owner,id);
      if(skill.status!==status) {await client.query('UPDATE public.reply_skill SET status=$2,updated_at=now() WHERE id=$1',[id,status]);await bumpSkillRevision(client,owner);}
      return {skill_id:id,status};
    },assertCurrent);
  }
  async rollback(owner: string,id: string,version: string,assertCurrent=()=>{}): Promise<unknown> {
    const result=await this.transaction(owner,async client=>{
      const skill=await this.skill(client,owner,id); const row=await this.version(client,owner,id,version);
      if(!row.enabled)throw new SkillLibraryError('skill_version_not_found',404,'skill_version_not_found');
      try {this.files.readContent(row);await this.requireSources(client,owner,version);} catch {throw new SkillLibraryError('skill_version_not_found',404,'skill_version_not_found');}
      if(!row.is_current) {
        await client.query('UPDATE public.reply_skill_version SET is_current=false WHERE skill_id=$1 AND is_current',[id]);
        await client.query('UPDATE public.reply_skill_version SET is_current=true WHERE id=$1',[version]);
        await client.query('INSERT INTO public.reply_skill_working_copy(skill_id,version_id) VALUES($1,$2) ON CONFLICT(skill_id) DO UPDATE SET version_id=excluded.version_id',[id,version]);
        await bumpSkillRevision(client,owner);
      }
      return {skill_id:id,version_number:row.version_number,status:skill.status};
    },assertCurrent);
    await this.reconcileFiles(owner); return result;
  }
  private async requireSources(client: pg.Client,owner: string,version: string): Promise<void> {
    const row=(await client.query('SELECT review_origin FROM public.reply_skill_version WHERE id=$1',[version])).rows[0];
    if(!row)throw new SkillLibraryError('skill_version_not_found',404,'skill_version_not_found');
    if(!row.review_origin)return;
    const {requireVersionSources}=await import('./skill-source-proof.ts'); await requireVersionSources(client,owner,version,undefined,this.options.requireDiscussionDependencies);
  }
  async synchronize(owner: string,assertCurrent=()=>{}): Promise<number> {
    await this.reconcileFiles(owner);
    return this.transaction(owner,async client=>{
      const pending=(await client.query(`SELECT skill.name FROM public.reply_skill_working_copy job JOIN public.reply_skill skill ON skill.id=job.skill_id WHERE skill.owner_id=$1`,[owner])).rows;
      const cleanups=(await client.query(`SELECT relative_path FROM public.reply_skill_file_cleanup WHERE relative_path=$1 OR starts_with(relative_path,$1||'/')`,[owner])).rows;
      const allBlocked=cleanups.some(row=>row.relative_path===owner);
      const blocked=new Set<string>([...pending.map(row=>row.name),...cleanups.map(row=>row.relative_path.split('/')[1]).filter(Boolean)]);
      const scan=allBlocked?{packages:[],failedNames:[],rootFailed:true,failureCode:'cleanup_pending'}:this.files.scan(owner,blocked);
      this.fileFailure(owner,'directory_discovery',scan.failureCode);
      const packages: SkillPackage[]=[];
      const failed=new Set(scan.failedNames);
      for(const entry of scan.packages) {
        try {packages.push(readPackage(entry.package_path));}
        catch(error) {if(!(error instanceof SkillPackageError))failed.add(entry.name);this.fileFailure(owner,'directory_discovery',error instanceof SkillPackageError?'invalid_package':'file_unavailable');}
      }
      if(scan.rootFailed)return Number((await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[owner])).rows[0].revision);
      const rows=(await client.query(`SELECT skill.id AS skill_id,skill.name,skill.status,version.id,version.version_number,version.review_origin,version.enabled,version.directory_available,version.content_path,version.content_sha256,version.document_sha256,version.manifest_sha256,skill.owner_id
        FROM public.reply_skill skill LEFT JOIN public.reply_skill_version version ON version.skill_id=skill.id AND version.is_current AND version.status='active' WHERE skill.owner_id=$1`,[owner])).rows;
      const known=new Map(rows.map(row=>[row.name,row])); let changed=false;
      for(const pkg of packages) {
        const row=known.get(pkg.name);
        if(!row) {const id=randomUUID();await client.query("INSERT INTO public.reply_skill(id,owner_id,name,status) VALUES($1,$2,$3,'active')",[id,owner,pkg.name]);await this.insertVersion(client,owner,id,1,pkg,false);changed=true;continue;}
        if(row.status==='deleted' || !row.id)continue;
        const manifest=this.files.readManifest(row as SkillVersionFiles);
        const matches=matchesSkillPackage(row as SkillVersionFiles,manifest,pkg);
        if(matches) {if(!row.directory_available){await client.query('UPDATE public.reply_skill_version SET directory_available=true WHERE id=$1',[row.id]);changed=true;}continue;}
        if(row.review_origin) {if(row.directory_available){await client.query('UPDATE public.reply_skill_version SET directory_available=false WHERE id=$1',[row.id]);changed=true;}continue;}
        await client.query('UPDATE public.reply_skill_version SET is_current=false WHERE id=$1',[row.id]);
        const number=Number((await client.query('SELECT coalesce(max(version_number),0)+1 AS number FROM public.reply_skill_version WHERE skill_id=$1',[row.skill_id])).rows[0].number);
        const next=await this.insertVersion(client,owner,row.skill_id,number,pkg,false);
        if(!row.enabled)await client.query('UPDATE public.reply_skill_version SET enabled=false WHERE id=$1',[next]);
        changed=true;
      }
      const names=new Set(packages.map(pkg=>pkg.name));
      for(const row of rows)if(row.status!=='deleted' && row.id && row.directory_available && !blocked.has(row.name) && !failed.has(row.name) && !names.has(row.name)) {await client.query('UPDATE public.reply_skill_version SET directory_available=false WHERE id=$1',[row.id]);changed=true;}
      if(changed)return bumpSkillRevision(client,owner);
      return Number((await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[owner])).rows[0].revision);
    },assertCurrent);
  }
  async reconcileFiles(owner: string): Promise<void> {
    await this.transaction(owner,async client=>{
      const {cleanupSkillFiles,cleanupUnreferencedSkillSnapshots}=await import('./skill-cleanup.ts');
      await cleanupSkillFiles(client,owner,this.files);
      const jobs=(await client.query(`${skillVersionQuery} JOIN public.reply_skill_working_copy job ON job.version_id=version.id WHERE skill.owner_id=$1`,[owner])).rows;
      for(const row of jobs) {
        if(!row.is_current || row.status!=='active' || row.skill_status==='deleted' || !row.content_path) {await client.query('DELETE FROM public.reply_skill_working_copy WHERE skill_id=$1',[row.skill_id]);continue;}
        try {this.files.writeWorking(row as SkillVersionFiles);}
        catch {this.fileFailure(owner,'working_copy_sync','file_unavailable',row.skill_id);continue;}
        await client.query('DELETE FROM public.reply_skill_working_copy WHERE skill_id=$1',[row.skill_id]);
        this.fileFailure(owner,'working_copy_sync',null,row.skill_id);
      }
      await cleanupUnreferencedSkillSnapshots(client,owner,this.files);
      await cleanupSkillFiles(client,owner,this.files);
    },()=>{});
  }
  async delete(owner: string,id: string,assertCurrent=()=>{}): Promise<unknown> {
    const result=await this.transaction(owner,async client=>{
      const skill=await this.skill(client,owner,id,true);
      if(this.storage.runtimeEnvironment().NOTALONE_MANAGED_USER_DATA && !this.options.eraseManagedBackups)throw new SkillLibraryError('update_backup_cleanup_required',409);
      await this.options.eraseManagedBackups?.(client);
      if(skill.status!=='deleted') {
        const {eraseSkillLearning,queueSkillFileCleanup}=await import('./skill-cleanup.ts');
        const versions=(await client.query('SELECT id FROM public.reply_skill_version WHERE skill_id=$1',[id])).rows.map(row=>row.id);
        await eraseSkillLearning(client,owner,[id,...versions],this.options.deleteSourceReplies); await queueSkillFileCleanup(client,id);
        await client.query(`UPDATE public.reply_skill_version SET manifest_sha256=NULL,content_path=NULL,document_sha256=NULL,method_manifest_path=NULL,method_manifest_sha256=NULL,content_sha256=NULL,source_locator=NULL,enabled=false,is_current=false,status='deleted',deleted_at=now() WHERE skill_id=$1 AND status='active'`,[id]);
        await client.query("UPDATE public.reply_skill SET status='deleted',deleted_at=now(),deletion_operation_id=$2,deletion_error_code=NULL,updated_at=now() WHERE id=$1",[id,randomUUID()]);
        await bumpSkillRevision(client,owner);
      }
      return {skill_id:id,name:skill.name,deleted:true};
    },assertCurrent);
    await this.reconcileFiles(owner);
    await this.transaction(owner,async client=>{
      if((await client.query(`SELECT 1 FROM public.reply_skill_file_cleanup WHERE relative_path=$1 OR starts_with(relative_path,$1||'/') OR starts_with(relative_path,'.versions/'||$1||'/') OR starts_with(relative_path,'.staging/'||$1||'/') LIMIT 1`,[owner])).rowCount)throw new SkillLibraryError('skill_persistence_failed');
    },assertCurrent);
    return result;
  }
}
