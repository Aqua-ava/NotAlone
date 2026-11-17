import type {IncomingMessage,ServerResponse} from 'node:http';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {readHttpBody,HttpBodyError} from '../../platform/http/body.ts';
import {SqliteSkillLibrary,SqliteSkillError} from './library.ts';
import type {SkillPackageState} from './contracts.ts';
import type {SkillGroupState} from './groups.ts';
import {skillPresentation} from './presentation.ts';

const enabledLabels={enabled:'已启用',disabled:'已停用',unknown:'待核验启停'};
const verificationLabels={verified:'场景文件已核验',pending:'场景文件待核验',missing:'场景文件缺失',conflict:'无法确认场景文件',invalid:'场景文件校验未通过'};
/** 最小业务查询投影不含物理定位，也不冒充本次实际加载证据。 */
export function skillManagementView(item: SkillPackageState) {
 const presentation=skillPresentation(item.directoryName);
 return {package_id:item.id,name:item.displayName,title:presentation?.title??item.displayName,tags:presentation?.tags??[],description:item.description,directory_name:item.directoryName,
  enabled_state:item.enabledState,verification_state:item.verificationState,verification_reason:item.verificationReason,
  head_revision:item.headRevision.toString(),current_revision_no:item.currentRevisionNo?.toString()??null,
  state_label:`${enabledLabels[item.enabledState]} · ${item.verificationReason==='directory_content_changed'?'场景文件与上次核验不一致':verificationLabels[item.verificationState]}`,
  revisions:item.revisions.map(r=>({revision_no:r.revisionNo.toString(),manifest_digest:r.manifestDigest,content_digest:r.contentDigest,
   source_kind:r.sourceKind,availability:r.availability,verification_state:r.verificationState}))};
}
/** 分组投影只含业务标识与名称，不含物理路径或 Skill 正文。 */
export function skillGroupView(group: SkillGroupState) {
 return {group_id:group.id,name:group.name,revision:group.revision.toString(),all_packages:group.allPackages,package_ids:group.packageIds,contact_ids:group.contactIds};
}
const uuid=(value: unknown): string=>{
 if(typeof value!=='string' || !/^[a-f0-9-]{36}$/.test(value))throw new SqliteSkillError('skill_request_invalid');
 return value;
};
const nullableUuid=(value: unknown): string|null=>value===null?null:uuid(value);
function packageIds(value: unknown): string[] {
 if(!Array.isArray(value) || value.length>256)throw new SqliteSkillError('skill_request_invalid');
 return value.map(uuid);
}
function object(value: unknown): Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value))throw new SqliteSkillError('skill_request_invalid');
 return value as Record<string,unknown>;
}
function exact(value: Record<string,unknown>,keys: string[]): void {
 if(Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key)))throw new SqliteSkillError('skill_request_invalid');
}
function head(value: unknown): bigint {
 if(typeof value!=='string' || !/^[1-9][0-9]{0,18}$/.test(value))throw new SqliteSkillError('skill_request_invalid');
 return BigInt(value);
}
function respond(res: ServerResponse,status: number,value: unknown): void {
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));
}
/** 复用共享宿主路由，唯一认证函数必须由宿主注入；不接收owner、目录根、SQL或模块地址。 */
export class SqliteSkillHttp {
 private readonly library: SqliteSkillLibrary;
 private readonly authorize: (req: IncomingMessage)=>boolean;
 constructor(library: SqliteSkillLibrary,authorize: (req: IncomingMessage)=>boolean) {this.library=library;this.authorize=authorize;}
 async handle(req: IncomingMessage,res: ServerResponse): Promise<boolean> {
  const raw=req.url??'';let url: URL;
  try {url=new URL(raw,'http://localhost');}catch{return false;}
  const path=url.pathname,legacyLearning=/^\/api\/contacts\/[^/]+\/skill-learning(?:\/|$)/.test(path);
  if(path!=='/api/skills' && !path.startsWith('/api/skills/') && !legacyLearning)return false;
  if(!this.authorize(req)){respond(res,401,{error:'unauthorized'});return true;}
  const controller=new AbortController(),abort=()=>controller.abort(new SqliteSkillError('skill_operation_cancelled'));
  req.once('aborted',abort);res.once('close',abort);
  try {
   if(raw!==path)throw new SqliteSkillError('skill_request_invalid');
   if(legacyLearning){respond(res,503,{error:'sqlite_skill_operation_unavailable'});return true;}
   const groupRoute=/^\/api\/skills\/groups(?:\/([a-f0-9-]{36})\/(update|delete))?$/.exec(path),contactRoute=/^\/api\/skills\/contacts\/([A-Za-z0-9_.:-]{1,128})\/group$/.exec(path);
   if(groupRoute || contactRoute){await this.handleGroups(req,res,controller.signal,path,groupRoute,contactRoute);return true;}
   const match=/^\/api\/skills\/([a-f0-9-]{36})\/(verify|enable|disable)$/.exec(path);
   const query=path==='/api/skills';
   if(!query && !match){respond(res,503,{error:'sqlite_skill_operation_unavailable'});return true;}
   if(req.method!==(query?'GET':'POST')){respond(res,405,{error:'method_not_allowed'});return true;}
   if(query){respond(res,200,{storage:'sqlite',mode:'minimal',skills:(await this.library.inspect(controller.signal)).map(skillManagementView)});return true;}
   let parsed: unknown;
   try {parsed=JSON.parse((await readHttpBody(req,16_384,10_000)).toString('utf8'));}
   catch(error){if(error instanceof HttpBodyError)throw error;throw new SqliteSkillError('skill_request_invalid');}
   const body=object(parsed);
   exact(body,['expected_head_revision','confirmed']);
   if(body.confirmed!==true)throw new SqliteSkillError('skill_request_invalid');
   const [,id,action]=match!;const expectedHead=head(body.expected_head_revision);
   const item=action==='verify'?await this.library.verify(id,expectedHead,controller.signal):await this.library.setEnabled(id,expectedHead,action==='enable'?'enabled':'disabled',controller.signal);
   respond(res,200,{skill:skillManagementView(item)});
  }catch(error){
   const code=error instanceof StorageFailure || error instanceof SqliteSkillError?error.code:error instanceof HttpBodyError?error.code:'skill_operation_failed';
   if(!controller.signal.aborted)respond(res,error instanceof HttpBodyError?error.status:code==='skill_request_invalid'||/_invalid$/.test(code)?400:409,{error:code});
  }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);}
  return true;
 }
 /** 分组管理：读取列表、创建、修改、删除，以及联系人分配；所有写入都要求确认和预期修订。 */
 private async handleGroups(req: IncomingMessage,res: ServerResponse,signal: AbortSignal,path: string,groupRoute: RegExpExecArray|null,contactRoute: RegExpExecArray|null): Promise<void> {
  const list=!contactRoute && path==='/api/skills/groups' && req.method==='GET';
  if(list){await this.library.ensureBuiltinGroup(signal);respond(res,200,{storage:'sqlite',groups:(await this.library.listGroups(signal)).map(skillGroupView)});return;}
  if(req.method!=='POST'){respond(res,405,{error:'method_not_allowed'});return;}
  let parsed: unknown;
  try {parsed=JSON.parse((await readHttpBody(req,16_384,10_000)).toString('utf8'));}
  catch(error){if(error instanceof HttpBodyError)throw error;throw new SqliteSkillError('skill_request_invalid');}
  const body=object(parsed);
  if(body.confirmed!==true)throw new SqliteSkillError('skill_request_invalid');
  if(contactRoute){
   exact(body,['group_id','expected_group_id','confirmed']);
   const groupId=nullableUuid(body.group_id),expected=nullableUuid(body.expected_group_id);
   const result=await this.library.assignContactGroup(contactRoute[1],groupId,expected,signal);
   respond(res,200,{contact_id:result.contactId,group_id:result.groupId});return;
  }
  const [,id,action]=groupRoute!;
  if(!id){
   exact(body,['name','package_ids','confirmed']);
   if(typeof body.name!=='string')throw new SqliteSkillError('skill_request_invalid');
   respond(res,200,{group:skillGroupView(await this.library.createGroup(body.name,packageIds(body.package_ids),signal))});return;
  }
  if(action==='update'){
   exact(body,['expected_revision','name','package_ids','confirmed']);
   if(typeof body.name!=='string')throw new SqliteSkillError('skill_request_invalid');
   respond(res,200,{group:skillGroupView(await this.library.updateGroup(id,head(body.expected_revision),body.name,packageIds(body.package_ids),signal))});return;
  }
  exact(body,['expected_revision','confirmed']);
  await this.library.deleteGroup(id,head(body.expected_revision),signal);
  respond(res,200,{deleted:true,group_id:id});
 }
}
