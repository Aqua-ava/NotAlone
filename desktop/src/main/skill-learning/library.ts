/** 最小Skill管理适配；只走具名路径，旧学习与回滚不进入此合同。 */
import type {BackendHost} from '../backend/host';
import {isUuid} from '../uuid';
import type {SkillGroupItem,SkillGroupsSnapshot,SkillLibraryCommand,SkillLibraryItem,SkillLibrarySnapshot,SqliteSkillLibrarySnapshot} from '../../shared/skill-library-bridge';
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
const invalidGroup=()=>new Error('分组状态尚未核对，请刷新后再操作。');
function readGroup(value:unknown):SkillGroupItem{
 const i=row(value);
 if(!isUuid(i.group_id)||!text(i.name)||!i.name.trim()||[...i.name].length>30||!decimal(i.revision)||typeof i.all_packages!=='boolean'
  ||!Array.isArray(i.package_ids)||i.package_ids.length>256||i.package_ids.some(id=>!isUuid(id))||new Set(i.package_ids).size!==i.package_ids.length
  ||!Array.isArray(i.contact_ids)||i.contact_ids.some(id=>!isUuid(id))||new Set(i.contact_ids).size!==i.contact_ids.length)throw invalidGroup();
 return {groupId:i.group_id,name:i.name,revision:i.revision,allPackages:i.all_packages,packageIds:i.package_ids as string[],contactIds:i.contact_ids as string[]};
}
export class SkillLibraryController {
 private readonly backend:Pick<BackendHost,'getConnectionGeneration'|'requestJson'>;
 constructor(backend:Pick<BackendHost,'getConnectionGeneration'|'requestJson'>){this.backend=backend;}
 async read():Promise<SkillLibrarySnapshot>{
  const generation=this.backend.getConnectionGeneration();if(generation===undefined)throw invalid();
  const result=await this.backend.requestJson({method:'GET',path:'/api/skills',timeoutMs:10_000});
  if(result.generation!==generation||this.backend.getConnectionGeneration()!==generation)throw invalid();
  const data=row(result.data);
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

 async readGroups():Promise<SkillGroupsSnapshot>{
  const generation=this.backend.getConnectionGeneration();if(generation===undefined)throw invalidGroup();
  const result=await this.backend.requestJson({method:'GET',path:'/api/skills/groups',timeoutMs:10_000});
  if(result.generation!==generation||this.backend.getConnectionGeneration()!==generation)throw invalidGroup();
  const data=row(result.data);if(data.storage!=='sqlite'||!Array.isArray(data.groups))throw invalidGroup();
  const groups=data.groups.map(readGroup);if(new Set(groups.map(g=>g.groupId)).size!==groups.length)throw invalidGroup();
  // 一位联系人至多属于一个分组；后端异常时界面不展示含糊的归属。
  const contacts=groups.flatMap(g=>g.contactIds);if(new Set(contacts).size!==contacts.length)throw invalidGroup();
  return {connectionGeneration:generation,groups};
 }
 async createGroup(input:unknown):Promise<SkillGroupsSnapshot>{
  const i=this.groupCommand(input,['name','packageIds']);
  return this.groupWrite(i,'/api/skills/groups',{name:i.name,package_ids:i.packageIds,confirmed:true},receipt=>readGroup(receipt.group).name===i.name);
 }
 async updateGroup(input:unknown):Promise<SkillGroupsSnapshot>{
  const i=this.groupCommand(input,['groupId','expectedRevision','name','packageIds']);
  return this.groupWrite(i,`/api/skills/groups/${i.groupId}/update`,{expected_revision:i.expectedRevision,name:i.name,package_ids:i.packageIds,confirmed:true},receipt=>readGroup(receipt.group).groupId===i.groupId);
 }
 async deleteGroup(input:unknown):Promise<SkillGroupsSnapshot>{
  const i=this.groupCommand(input,['groupId','expectedRevision']);
  return this.groupWrite(i,`/api/skills/groups/${i.groupId}/delete`,{expected_revision:i.expectedRevision,confirmed:true},receipt=>receipt.deleted===true&&receipt.group_id===i.groupId);
 }
 async assignContactGroup(input:unknown):Promise<SkillGroupsSnapshot>{
  const i=this.groupCommand(input,['contactId','groupId','expectedGroupId']);
  return this.groupWrite(i,`/api/skills/contacts/${i.contactId}/group`,{group_id:i.groupId,expected_group_id:i.expectedGroupId,confirmed:true},receipt=>receipt.contact_id===i.contactId&&receipt.group_id===i.groupId);
 }
 private groupCommand(input:unknown,keys:string[]):Record<string,any>{
  const i=row(input);exact(i,[...keys,'connectionGeneration','confirmed']);
  if(i.confirmed!==true||!Number.isSafeInteger(i.connectionGeneration))throw invalidGroup();
  if('name' in i&&(typeof i.name!=='string'||i.name!==i.name.trim()||!i.name||[...i.name].length>30))throw new Error('分组名称需为 1–30 个字符，且首尾不能有空格。');
  if('packageIds' in i&&(!Array.isArray(i.packageIds)||i.packageIds.length>256||i.packageIds.some(id=>!isUuid(id))))throw invalidGroup();
  if('groupId' in i&&!(keys.includes('expectedGroupId')?(i.groupId===null||isUuid(i.groupId)):isUuid(i.groupId)))throw invalidGroup();
  if('expectedRevision' in i&&!decimal(i.expectedRevision))throw invalidGroup();
  if('expectedGroupId' in i&&!(i.expectedGroupId===null||isUuid(i.expectedGroupId)))throw invalidGroup();
  if('contactId' in i&&!isUuid(i.contactId))throw invalidGroup();
  return {...i,...('contactId' in i?{contactId:(i.contactId as string).toLowerCase()}:{})};
 }
 private async groupWrite(command:Record<string,any>,path:string,body:unknown,accept:(receipt:Record<string,unknown>)=>boolean):Promise<SkillGroupsSnapshot>{
  if(this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalidGroup();
  try {
   const result=await this.backend.requestJson({method:'POST',path,body,timeoutMs:10_000});
   if(result.generation!==command.connectionGeneration||this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalidGroup();
   if(!accept(row(result.data)))throw invalidGroup();
   const next=await this.readGroups();if(next.connectionGeneration!==command.connectionGeneration)throw invalidGroup();return next;
  }catch(error){
   // 名称非法、重名或预期修订过期等明确的后端拒绝保留可操作的提示；其余按未核对处理。
   const code=(error as {code?:string}|null)?.code;
   if(code==='skill_group_name_conflict')throw new Error('已有同名分组，请换一个名称。');
   if(code==='skill_group_name_invalid')throw new Error('分组名称需为 1–30 个字符，且首尾不能有空格。');
   if(code==='skill_group_revision_conflict'||code==='skill_group_assignment_conflict'||code==='skill_group_missing')throw new Error('分组已被其他操作改动，请刷新后再试。');
   if(code==='skill_group_builtin')throw new Error('内置的“恋人”分组使用全部回复场景，不能修改或删除。');
   if(code==='skill_group_limit')throw new Error('分组数量已达上限。');
   if(code==='skill_contact_unavailable')throw new Error('该联系人当前不可用，请刷新后再试。');
   throw new Error('分组操作结果尚未核对，请刷新分组状态后再操作。');
  }
 }
 private command(input:unknown):SkillLibraryCommand {
  const i=row(input);exact(i,['packageId','expectedHeadRevision','connectionGeneration','confirmed']);
  if(!isUuid(i.packageId)||!decimal(i.expectedHeadRevision))throw invalid();return i as unknown as SkillLibraryCommand;
 }
 private async write(command:SkillLibraryCommand,path:string,body:unknown):Promise<SqliteSkillLibrarySnapshot>{
  if(command.confirmed!==true||!Number.isSafeInteger(command.connectionGeneration)||this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalid();
  const current=await this.read();if(current.connectionGeneration!==command.connectionGeneration||this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalid();
  try {
   const result=await this.backend.requestJson({method:'POST',path,body,timeoutMs:10_000});
   if(result.generation!==command.connectionGeneration||this.backend.getConnectionGeneration()!==command.connectionGeneration)throw invalid();
   const receipt=readItem(row(result.data).skill);
   if(receipt.packageId!==command.packageId
    ||path.endsWith('/enable')&&receipt.enabledState!=='enabled'||path.endsWith('/disable')&&receipt.enabledState!=='disabled')throw invalid();
   const next=await this.read();if(next.connectionGeneration!==command.connectionGeneration)throw invalid();return next;
  }catch{throw new Error('操作结果尚未核对，请刷新 Skill 状态后再操作。');}
 }
}
