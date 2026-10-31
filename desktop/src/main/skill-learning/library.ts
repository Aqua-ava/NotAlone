/** 最小Skill管理适配；只走具名路径，旧学习与回滚不进入此合同。 */
import type {BackendHost} from '../backend/host';
import {isUuid} from '../uuid';
import type {SkillLibraryCommand,SkillLibraryItem,SkillLibrarySnapshot,SqliteSkillLibrarySnapshot} from '../../shared/skill-library-bridge';
const invalid=()=>new Error('Skill 状态尚未核对，请刷新后再操作。');
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
function row(value: unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,keys:string[]):void{if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw invalid();}
function text(value:unknown):value is string{return typeof value==='string'&&value.length<=4096;}
function readItem(value:unknown):SkillLibraryItem {
 const i=row(value);
 if(!isUuid(i.package_id)||!text(i.name)||!text(i.description)||!text(i.directory_name)
  ||!text(i.title)||!i.title.trim()||!Array.isArray(i.tags)||i.tags.length>20||i.tags.some(tag=>!text(tag)||!tag.trim())||new Set(i.tags).size!==i.tags.length
  ||!['enabled','disabled','unknown'].includes(i.enabled_state as string)||!['verified','pending','missing','conflict','invalid'].includes(i.verification_state as string)
  ||!(i.verification_reason===null||text(i.verification_reason))||!decimal(i.head_revision)||!(i.current_revision_no===null||decimal(i.current_revision_no))||!Array.isArray(i.revisions))throw invalid();
 const revisions=i.revisions.map(value=>{const r=row(value);if(!decimal(r.revision_no)||!['current','unavailable'].includes(r.availability as string)
  ||typeof r.manifest_digest!=='string'||!/^[a-f0-9]{64}$/.test(r.manifest_digest)||typeof r.content_digest!=='string'||!/^[a-f0-9]{64}$/.test(r.content_digest))throw invalid();
  return {revisionNo:r.revision_no,availability:r.availability as 'current'|'unavailable',manifestDigest:r.manifest_digest,contentDigest:r.content_digest};});
 if(new Set(revisions.map(r=>r.revisionNo)).size!==revisions.length||revisions.filter(r=>r.availability==='current').length!==(i.current_revision_no===null?0:1)
  ||i.current_revision_no!==null&&!revisions.some(r=>r.revisionNo===i.current_revision_no&&r.availability==='current'))throw invalid();
 return {packageId:i.package_id,name:i.name,title:i.title,tags:i.tags as string[],description:i.description,directoryName:i.directory_name,enabledState:i.enabled_state as SkillLibraryItem['enabledState'],verificationState:i.verification_state as SkillLibraryItem['verificationState'],verificationReason:i.verification_reason as string|null,headRevision:i.head_revision,currentRevisionNo:i.current_revision_no,revisions};
}
export class SkillLibraryController {
 private readonly backend:Pick<BackendHost,'getConnectionGeneration'|'requestJson'>;
 constructor(backend:Pick<BackendHost,'getConnectionGeneration'|'requestJson'>){this.backend=backend;}
 async read():Promise<SkillLibrarySnapshot>{
  const generation=this.backend.getConnectionGeneration();if(generation===undefined)throw invalid();
  const result=await this.backend.requestJson({method:'GET',path:'/api/skills',timeoutMs:10_000});
  if(result.generation!==generation||this.backend.getConnectionGeneration()!==generation)throw invalid();
  const data=row(result.data);
  if(data.storage===undefined&&data.mode===undefined&&Array.isArray(data.skills))return {mode:'legacy',connectionGeneration:generation};
  if(data.storage!=='sqlite'||data.mode!=='minimal'||!Array.isArray(data.skills))throw invalid();
  const skills=data.skills.map(readItem);if(new Set(skills.map(i=>i.packageId)).size!==skills.length)throw invalid();
  return {mode:'sqlite',connectionGeneration:generation,skills};
 }
 async verify(input:unknown):Promise<SqliteSkillLibrarySnapshot>{const i=this.command(input);return this.write(i,`/api/skills/${i.packageId}/verify`,{expected_head_revision:i.expectedHeadRevision,confirmed:true});}
 async changeEnabled(input:unknown):Promise<SqliteSkillLibrarySnapshot>{
  const raw=row(input);exact(raw,['packageId','expectedHeadRevision','connectionGeneration','confirmed','enabled']);if(typeof raw.enabled!=='boolean')throw invalid();
  const {enabled,...rest}=raw;const i=this.command(rest);
  return this.write(i,`/api/skills/${i.packageId}/${enabled?'enable':'disable'}`,{expected_head_revision:i.expectedHeadRevision,confirmed:true});
 }
 private command(input:unknown):SkillLibraryCommand {
  const i=row(input);exact(i,['packageId','expectedHeadRevision','connectionGeneration','confirmed']);
  if(!isUuid(i.packageId)||!decimal(i.expectedHeadRevision))throw invalid();return i as unknown as SkillLibraryCommand;
 }
 private async write(command:SkillLibraryCommand,path:string,body:unknown):Promise<SqliteSkillLibrarySnapshot>{
  if(command.confirmed!==true||!Number.isSafeInteger(command.connectionGeneration)||this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalid();
  const current=await this.read();if(current.mode!=='sqlite'||current.connectionGeneration!==command.connectionGeneration||this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalid();
  try {
   const result=await this.backend.requestJson({method:'POST',path,body,timeoutMs:10_000});
   if(result.generation!==command.connectionGeneration||this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalid();
   const receipt=readItem(row(result.data).skill);
   if(receipt.packageId!==command.packageId
    ||path.endsWith('/enable')&&receipt.enabledState!=='enabled'||path.endsWith('/disable')&&receipt.enabledState!=='disabled')throw invalid();
   const next=await this.read();if(next.mode!=='sqlite'||next.connectionGeneration!==command.connectionGeneration)throw invalid();return next;
  }catch{throw new Error('操作结果尚未核对，请刷新 Skill 状态后再操作。');}
 }
}
