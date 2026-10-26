/** 业务只读端口：不发现、同步或改写工作副本，不暴露磁盘定位给模型。 */
import type {Client} from 'pg';
import type {SkillScope,SkillEntry,SkillReadPort} from './skill-runtime.ts';
import {SkillFiles,matchesSkillPackage} from './skill-files.ts';
import {readPackage,sha256,SkillPackageReadError} from './skill-package.ts';
import {selectMethods,skillDigest,SkillPortError,FILTERED_DESCRIPTION} from './skill-execution-view.ts';
import type {SkillRow} from './skill-execution-view.ts';
import type {SkillDiscussionValidator} from './skill-source-proof.ts';
export type {SkillDiscussionValidator} from './skill-source-proof.ts';
export {SkillPortError} from './skill-execution-view.ts';
export interface SkillExecutionView {policy_revision:number;method_ids:string[];sha256:string}
export interface SkillUseMetadata {selection_method?:'auto'|'user';selection_reason?:string;resource_paths?:readonly string[];load_state?:'loaded'|'resource_failed'}
export interface SkillUse {skill_id:string;version_id:string;name:string;selection_method:'auto'|'user';selection_reason:string;resource_paths:string[];load_state:'loaded'|'resource_failed';version_number:number;scope_kind:'owner'|'contact'|'scene';scope_contact_id:string|null;scope_scene:string|null;execution_view:SkillExecutionView}
export interface SkillDatabase {read<T>(operation:(client:Client)=>Promise<T>):Promise<T>}
const QUERY=`SELECT version.*,skill.owner_id,skill.contact_id,skill.name,
 publication.owner_id AS publication_owner_id,publication.origin_contact_id,publication.scope_kind,publication.scope_contact_id,
 publication.scene,publication.dependency_ids,publication.source_generation,publication.deleted AS publication_deleted
 FROM public.reply_skill skill JOIN public.reply_skill_version version ON version.skill_id=skill.id
 LEFT JOIN public.reply_skill_publication publication ON publication.version_id=version.id
 WHERE skill.owner_id=$1 AND (skill.contact_id IS NULL OR skill.contact_id=$2)
 AND skill.status='active' AND version.status='active' AND version.enabled AND version.is_current
 AND version.content_path IS NOT NULL AND version.manifest_sha256 IS NOT NULL AND version.directory_available
 AND NOT EXISTS(SELECT 1 FROM public.reply_skill_working_copy pending WHERE pending.skill_id=skill.id)
 AND NOT EXISTS(SELECT 1 FROM public.reply_skill_file_cleanup cleanup WHERE cleanup.relative_path=skill.owner_id::text
 OR(split_part(cleanup.relative_path,'/',1)=skill.owner_id::text AND split_part(cleanup.relative_path,'/',2)=skill.name))
 AND (NOT version.review_origin OR(publication.owner_id=skill.owner_id AND NOT publication.deleted
 AND (publication.scope_kind='owner' OR publication.scope_kind='contact' AND publication.scope_contact_id=$2
 OR publication.scope_kind='scene' AND publication.scene=$3)))`;
/** 只读检查工作目录是否待同步；与旧 check_only 一样不修改文件或版本。 */
export async function checkSkillDirectory(client:Client,owner:string,files:SkillFiles):Promise<boolean>{
 const rows=(await client.query(`SELECT version.*,skill.id AS skill_id,skill.owner_id,skill.name,skill.status AS skill_status FROM public.reply_skill skill LEFT JOIN public.reply_skill_version version ON version.skill_id=skill.id AND version.is_current AND version.status='active' WHERE skill.owner_id=$1`,[owner])).rows;
 const excluded=new Set<string>((await client.query('SELECT skill.name FROM public.reply_skill_working_copy pending JOIN public.reply_skill skill ON skill.id=pending.skill_id WHERE skill.owner_id=$1',[owner])).rows.map(r=>r.name));
 for(const row of (await client.query("SELECT relative_path FROM public.reply_skill_file_cleanup WHERE relative_path=$1 OR starts_with(relative_path,$1||'/')",[owner])).rows){if(row.relative_path===owner)return false;excluded.add(row.relative_path.split('/')[1]);}
 const scan=files.scan(owner,excluded);if(scan.rootFailed)return false;
 const packages=new Map<string,ReturnType<typeof readPackage>>();
 for(const entry of scan.packages){try{packages.set(entry.name,readPackage(entry.package_path));}catch(error){if(error instanceof SkillPackageReadError)scan.failedNames.push(entry.name);/* 非法包视为不可用；瞬时IO失败保留目录状态。 */}}
 const known=new Set(rows.map(r=>r.name));if([...packages.keys()].some(name=>!known.has(name)))return true;
 for(const row of rows){
  if(row.skill_status==='deleted'||!row.id||excluded.has(row.name)||scan.failedNames.includes(row.name))continue;
  const pkg=packages.get(row.name);if(!pkg){if(row.directory_available)return true;continue;}
  const manifest=files.readManifest(row as any);
  const matches=matchesSkillPackage(row as any,manifest,pkg);
  if(matches? !row.directory_available:!row.review_origin||row.directory_available)return true;
 }
 return false;
}
export class PostgresSkillPort implements SkillReadPort {
 private readonly db:SkillDatabase;private readonly files:SkillFiles;private readonly requireDiscussionDependencies?:SkillDiscussionValidator;
 private readonly views=new Map<string,string>();
 private readonly resources=new Map<string,Map<string,string>>();
 private readonly loadedEntries=new Map<string,SkillEntry>();
 dispose(){this.views.clear();this.resources.clear();this.loadedEntries.clear();}
 constructor(db:SkillDatabase,root:string,options:{requireDiscussionDependencies?:SkillDiscussionValidator}={}){this.db=db;this.files=new SkillFiles(root);this.requireDiscussionDependencies=options.requireDiscussionDependencies;}
 private key(scope:SkillScope,revision:string,id:string){return JSON.stringify([scope.ownerId,scope.contactId,scope.scene,revision,id]);}
 private async scope(client:Client,scope:SkillScope,signal?:AbortSignal){
  signal?.throwIfAborted();const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuid.test(scope.ownerId)||!uuid.test(scope.contactId)||typeof scope.scene!=='string'||scope.scene.length>256||scope.scene.trim()!==scope.scene)throw new SkillPortError();
  if(!(await client.query("SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2 AND (EXISTS(SELECT 1 FROM public.conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active') OR EXISTS(SELECT 1 FROM public.manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2))",[scope.ownerId,scope.contactId])).rowCount)throw new SkillPortError();
 }
 private async revision(client:Client,owner:string){return String((await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[owner])).rows[0]?.revision??0);}
 private async sources(client:Client,scope:SkillScope,row:SkillRow){
  if(row.review_origin){const {requireVersionSources}=await import('./skill-source-proof.ts');await requireVersionSources(client,scope.ownerId,row.id,scope.contactId,this.requireDiscussionDependencies);}
 }
 private async entry(client:Client,scope:SkillScope,row:SkillRow){
  await this.sources(client,scope,row);const selection=await selectMethods(client,scope,row);const manifest=this.files.readManifest(row as any);
  return {entry:{skillId:row.skill_id,versionId:row.id,name:row.name,description:selection.filtered?FILTERED_DESCRIPTION:manifest.description,contentHash:row.document_sha256,resourcePaths:selection.filtered?[]:manifest.resources.map(r=>r.relative_path).sort()} as SkillEntry,selection};
 }
 private async selected(client:Client,scope:SkillScope,entry:SkillEntry,revision:string){
  if(await this.revision(client,scope.ownerId)!==revision)throw new SkillPortError('reply_input_invalidated');
  const row=(await client.query(QUERY+' AND version.id=$4',[scope.ownerId,scope.contactId,scope.scene||null,entry.versionId])).rows[0];
  if(!row)throw new SkillPortError('reply_input_invalidated');const projected=await this.entry(client,scope,row);
  if(skillDigest(projected.entry)!==skillDigest(entry))throw new SkillPortError('reply_input_invalidated');return {row,...projected};
 }
 private projection(row:SkillRow,selection:Awaited<ReturnType<typeof selectMethods>>){
  let content:string;
  if(selection.filtered){const methods=this.files.readMethods(row as any,selection.ordered,selection.allowed);content='---\nname: '+row.name+'\ndescription: '+JSON.stringify(FILTERED_DESCRIPTION)+'\n---\n# 本次允许的方法\n\n'+methods.map(m=>'## '+m.title+'\n'+m.instruction).join('\n\n');}
  else content=this.files.readContent(row as any);
  return {content,view:skillDigest({version_id:row.id,document:content,methods:selection.allowed,policies:selection.policies.map(p=>[p.id,p.revision])})};
 }
 async catalog(scope:SkillScope,signal?:AbortSignal){return this.db.read(async client=>{await this.scope(client,scope,signal);const revision=await this.revision(client,scope.ownerId),entries:SkillEntry[]=[];
  for(const row of (await client.query(QUERY+' ORDER BY skill.contact_id NULLS FIRST,skill.name,version.id',[scope.ownerId,scope.contactId,scope.scene||null])).rows){try{entries.push((await this.entry(client,scope,row)).entry);}catch(error){if(error instanceof SkillPortError)continue;throw error;}}
  signal?.throwIfAborted();return {revision,entries};});}
 async loadVersion(scope:SkillScope,entry:SkillEntry,revision:string,signal?:AbortSignal){return this.db.read(async client=>{
  await this.scope(client,scope,signal);const {row,selection}=await this.selected(client,scope,entry,revision);const {content,view}=this.projection(row,selection),key=this.key(scope,revision,entry.versionId);
  if(this.views.has(key)&&this.views.get(key)!==view)throw new SkillPortError('reply_input_invalidated');signal?.throwIfAborted();this.views.set(key,view);this.loadedEntries.set(key,entry);return {content,contentHash:entry.contentHash};});}
 async resource(scope:SkillScope,entry:SkillEntry,revision:string,path:string,signal?:AbortSignal){return this.db.read(async client=>{
  await this.scope(client,scope,signal);const {row,selection}=await this.selected(client,scope,entry,revision);
  if(selection.filtered||!entry.resourcePaths.includes(path)||!this.views.has(this.key(scope,revision,entry.versionId)))throw new SkillPortError();
  const content=this.files.readResource(row as any,path);signal?.throwIfAborted();const key=this.key(scope,revision,entry.versionId),paths=this.resources.get(key)??new Map<string,string>();if(paths.has(path)&&paths.get(path)!==sha256(content))throw new SkillPortError('reply_input_invalidated');paths.set(path,sha256(content));this.resources.set(key,paths);return {content};});}
 async captureUse(scope:SkillScope,entry:SkillEntry,revision:string,metadata:SkillUseMetadata={},signal?:AbortSignal):Promise<SkillUse>{return this.db.read(async client=>{
  await this.scope(client,scope,signal);const key=this.key(scope,revision,entry.versionId);
  if(!this.views.has(key))throw new SkillPortError();
  const {row,selection}=await this.selected(client,scope,entry,revision),projection=this.projection(row,selection);
  if(this.views.get(key)!==projection.view)throw new SkillPortError('reply_input_invalidated');
  const paths=[...(metadata.resource_paths??[])];
  if(new Set(paths).size!==paths.length||paths.some(path=>!this.resources.get(key)?.has(path))||!['auto','user'].includes(metadata.selection_method??'auto')||typeof (metadata.selection_reason??'')!=='string'||!['loaded','resource_failed'].includes(metadata.load_state??'loaded'))throw new SkillPortError();
  signal?.throwIfAborted();return {skill_id:row.skill_id,version_id:row.id,name:row.name,selection_method:metadata.selection_method??'auto',selection_reason:metadata.selection_reason??'',resource_paths:paths,load_state:metadata.load_state??'loaded',version_number:row.version_number,scope_kind:row.scope_kind??(row.contact_id?'contact':'owner'),scope_contact_id:row.review_origin?row.scope_contact_id:row.contact_id,scope_scene:row.scene??null,execution_view:{policy_revision:selection.policyRevision,method_ids:[...selection.allowed],sha256:projection.view}};
 });}
 /** 与候选写入共用事务和 owner 锁，不重新开启事务或读取替代版本。 */
 async validateUseInTransaction(client:Client,scope:SkillScope,revision:string,use:SkillUse|null,signal?:AbortSignal):Promise<void>{
  try{
   if(use===null){await this.validateInTransaction(client,scope,revision,null,signal);return;}
   const key=this.key(scope,revision,use.version_id),entry=this.loadedEntries.get(key);
   if(!entry||!this.views.has(key))throw new SkillPortError();
   await this.validateInTransaction(client,scope,revision,entry,signal);
   const {row,selection}=await this.selected(client,scope,entry,revision),projection=this.projection(row,selection);
   const expected={...use,skill_id:row.skill_id,version_id:row.id,name:row.name,version_number:row.version_number,scope_kind:row.scope_kind??(row.contact_id?'contact':'owner'),scope_contact_id:row.review_origin?row.scope_contact_id:row.contact_id,scope_scene:row.scene??null,execution_view:{policy_revision:selection.policyRevision,method_ids:[...selection.allowed],sha256:projection.view}};
   if(skillDigest(expected)!==skillDigest(use)||!['auto','user'].includes(use.selection_method)||typeof use.selection_reason!=='string'||!['loaded','resource_failed'].includes(use.load_state)||!Array.isArray(use.resource_paths)||new Set(use.resource_paths).size!==use.resource_paths.length||use.resource_paths.some(path=>!this.resources.get(key)?.has(path)))throw new SkillPortError();
   signal?.throwIfAborted();
  }catch(error){if(signal?.aborted)throw error;throw new SkillPortError('reply_input_invalidated');}
 }
 async validate(scope:SkillScope,revision:string,selected:SkillEntry|null,signal?:AbortSignal){await this.db.read(client=>this.validateInTransaction(client,scope,revision,selected,signal));}
 /** 候选保存事务使用同一个 client；调用方负责与撤销／删除共用锁。 */
 async validateInTransaction(client:Client,scope:SkillScope,revision:string,selected:SkillEntry|null,signal?:AbortSignal){
  await this.scope(client,scope,signal);if(await this.revision(client,scope.ownerId)!==revision)throw new SkillPortError('reply_input_invalidated');
  if(selected){try{if(await checkSkillDirectory(client,scope.ownerId,this.files))throw new SkillPortError();}catch{throw new SkillPortError('reply_input_invalidated');}const {row,selection}=await this.selected(client,scope,selected,revision),key=this.key(scope,revision,selected.versionId),frozen=this.views.get(key);
   try{if(frozen!==undefined&&this.projection(row,selection).view!==frozen)throw new SkillPortError();
    for(const [path,hash] of this.resources.get(key)??[])if(sha256(this.files.readResource(row as any,path))!==hash)throw new SkillPortError();
   }catch{throw new SkillPortError('reply_input_invalidated');}}
  signal?.throwIfAborted();
 }
}
