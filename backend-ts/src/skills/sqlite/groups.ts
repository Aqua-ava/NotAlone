/** Skill 分组：用户自定义分组绑定可用 Skill，联系人至多归入一个分组；未分组联系人不使用任何 Skill。 */
import {StorageFailure,type StorageAction,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {requireSkillOwner} from './storage.ts';


export const SKILL_GROUP_LIMIT=50;
const NAME_LIMIT=30;

/** 分组表以 owner 为边界；联系人或分组删除时分配随之清除，Skill 包删除时绑定随之清除。 */
export const skillGroupMigration=(version: number)=>({version,sql:`
CREATE TABLE skill_group (
 owner_id TEXT NOT NULL REFERENCES owner(owner_id) ON DELETE CASCADE, id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${NAME_LIMIT} AND name=trim(name)),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,name)
) STRICT;
CREATE TABLE skill_group_package (
 owner_id TEXT NOT NULL, group_id TEXT NOT NULL, package_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,group_id,package_id),
 FOREIGN KEY(owner_id,group_id) REFERENCES skill_group(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,package_id) REFERENCES skill_package(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX skill_group_package_by_package ON skill_group_package(owner_id,package_id);
CREATE TABLE contact_skill_group (
 owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, group_id TEXT NOT NULL,
 PRIMARY KEY(owner_id,contact_id),
 FOREIGN KEY(owner_id,contact_id) REFERENCES contact(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,group_id) REFERENCES skill_group(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX contact_skill_group_by_group ON contact_skill_group(owner_id,group_id);
`});

export interface SkillGroupState {id: string; name: string; revision: bigint; packageIds: string[]; contactIds: string[]}
/** 本次联系人实际适用的分组范围；未分组时 groupId 为 null 且没有任何可用包。 */
export interface SkillGroupScope {groupId: string|null; revision: bigint; packageIds: string[]}

/** 冻结到运行修订中的分组范围；回复模块与受控运行必须用同一函数生成，保证字节一致。 */
export function skillRunGroup(contactId: string,scope: SkillGroupScope): {contactId: string;groupId: string|null;revision: bigint} {
  return {contactId,groupId:scope.groupId,revision:scope.revision};
}
/** 只保留联系人所在分组绑定的 Skill 包；未分组时为空。 */
export function inSkillGroup<T extends {id: string}>(items: readonly T[],scope: SkillGroupScope): T[] {
  const ids=new Set(scope.packageIds);
  return items.filter(item=>ids.has(item.id));
}
function fail(code: string): never {throw new StorageFailure(code);}
function text(value: unknown): string {
  if(typeof value!=='string'||!value.trim()||value.length>4096||value.includes('\0'))fail('skill_input_invalid');
  return value;
}
function groupName(value: unknown): string {
  if(typeof value!=='string'||value!==value.trim()||!value||[...value].length>NAME_LIMIT||/[\u0000-\u001f\u007f]/.test(value))fail('skill_group_name_invalid');
  return value;
}
function packageIds(tx: StorageTransaction,ownerId: string,value: unknown): string[] {
  if(!Array.isArray(value))fail('skill_input_invalid');
  const ids=value.map(text);
  if(new Set(ids).size!==ids.length)fail('skill_input_invalid');
  for(const id of ids)if(!tx.get('SELECT 1 FROM skill_package WHERE owner_id=? AND id=?',[ownerId,id]))fail('skill_missing');
  return ids.sort();
}
function view(tx: StorageTransaction,ownerId: string,id: string): SkillGroupState {
  const row=tx.get('SELECT id,name,revision FROM skill_group WHERE owner_id=? AND id=?',[ownerId,id]);
  if(!row)fail('skill_group_missing');
  return {id:row.id as string,name:row.name as string,revision:row.revision as bigint,
    packageIds:tx.all('SELECT package_id FROM skill_group_package WHERE owner_id=? AND group_id=? ORDER BY package_id',[ownerId,id]).map(r=>r.package_id as string),
    contactIds:tx.all('SELECT contact_id FROM contact_skill_group WHERE owner_id=? AND group_id=? ORDER BY contact_id',[ownerId,id]).map(r=>r.contact_id as string)};
}
function expectedGroup(tx: StorageTransaction,input: {ownerId: string;id: string;expectedRevision: bigint}): SkillGroupState {
  text(input.id);requireSkillOwner(tx,input.ownerId);
  const item=view(tx,input.ownerId,input.id);
  if(typeof input.expectedRevision!=='bigint'||input.expectedRevision!==item.revision)fail('skill_group_revision_conflict');
  return item;
}
function requireNameFree(tx: StorageTransaction,ownerId: string,name: string,exceptId?: string): void {
  const row=tx.get('SELECT id FROM skill_group WHERE owner_id=? AND name=?',[ownerId,name]);
  if(row&&row.id!==exceptId)fail('skill_group_name_conflict');
}
function replacePackages(tx: StorageTransaction,ownerId: string,groupId: string,ids: string[]): void {
  tx.run('DELETE FROM skill_group_package WHERE owner_id=? AND group_id=?',[ownerId,groupId]);
  for(const id of ids)tx.run('INSERT INTO skill_group_package(owner_id,group_id,package_id) VALUES(?,?,?)',[ownerId,groupId,id]);
}

export const skillGroupActions: StorageAction[] = [
  {name:'skillGroups.list',mode:'read',retryBusy:false,execute(tx,input){
    const ownerId=text((input as {ownerId?:unknown})?.ownerId);requireSkillOwner(tx,ownerId);
    return tx.all('SELECT id FROM skill_group WHERE owner_id=? ORDER BY name',[ownerId]).map(row=>view(tx,ownerId,row.id as string));
  }},
  {name:'skillGroups.create',mode:'write',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;id:string;name:string;packageIds:string[];at:bigint};
    text(i.ownerId);text(i.id);requireSkillOwner(tx,i.ownerId);
    const name=groupName(i.name);
    if(typeof i.at!=='bigint'||i.at<0n)fail('skill_input_invalid');
    if(tx.get('SELECT count(*) AS n FROM skill_group WHERE owner_id=?',[i.ownerId])!.n as bigint>=BigInt(SKILL_GROUP_LIMIT))fail('skill_group_limit');
    requireNameFree(tx,i.ownerId,name);
    const ids=packageIds(tx,i.ownerId,i.packageIds);
    tx.run('INSERT INTO skill_group(owner_id,id,name,revision,created_at) VALUES(?,?,?,1,?)',[i.ownerId,i.id,name,i.at]);
    replacePackages(tx,i.ownerId,i.id,ids);
    return view(tx,i.ownerId,i.id);
  }},
  {name:'skillGroups.update',mode:'write',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;id:string;expectedRevision:bigint;name:string;packageIds:string[]};
    const item=expectedGroup(tx,i),name=groupName(i.name),ids=packageIds(tx,i.ownerId,i.packageIds);
    // 没有实际变化时不推进修订，避免无谓撤销在途运行。
    if(name===item.name&&JSON.stringify(ids)===JSON.stringify(item.packageIds))return item;
    requireNameFree(tx,i.ownerId,name,i.id);
    tx.run('UPDATE skill_group SET name=?,revision=revision+1 WHERE owner_id=? AND id=?',[name,i.ownerId,i.id]);
    replacePackages(tx,i.ownerId,i.id,ids);
    return view(tx,i.ownerId,i.id);
  }},
  {name:'skillGroups.delete',mode:'write',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;id:string;expectedRevision:bigint};
    expectedGroup(tx,i);
    // 级联清除绑定和联系人分配；原 Skill 目录与包状态不受影响。
    tx.run('DELETE FROM skill_group WHERE owner_id=? AND id=?',[i.ownerId,i.id]);
    return true;
  }},
  {name:'skillGroups.assign',mode:'write',retryBusy:false,execute(tx,input){
    const i=input as {ownerId:string;contactId:string;groupId:string|null;expectedGroupId:string|null};
    text(i.ownerId);text(i.contactId);requireSkillOwner(tx,i.ownerId);
    if(i.groupId!==null)text(i.groupId);if(i.expectedGroupId!==null)text(i.expectedGroupId);
    if(!tx.get("SELECT 1 FROM contact WHERE owner_id=? AND id=? AND state='active'",[i.ownerId,i.contactId]))fail('skill_contact_unavailable');
    const current=tx.get('SELECT group_id FROM contact_skill_group WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId])?.group_id??null;
    if(current!==i.expectedGroupId)fail('skill_group_assignment_conflict');
    if(i.groupId===null){tx.run('DELETE FROM contact_skill_group WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);}
    else{
      view(tx,i.ownerId,i.groupId);
      tx.run('INSERT INTO contact_skill_group(owner_id,contact_id,group_id) VALUES(?,?,?) ON CONFLICT(owner_id,contact_id) DO UPDATE SET group_id=excluded.group_id',[i.ownerId,i.contactId,i.groupId]);
    }
    return {contactId:i.contactId,groupId:i.groupId};
  }},
  {name:'skillGroups.scope',mode:'read',retryBusy:false,execute(tx,input): SkillGroupScope {
    const i=input as {ownerId:string;contactId:string};text(i.ownerId);text(i.contactId);requireSkillOwner(tx,i.ownerId);
    const row=tx.get('SELECT a.group_id,s.revision FROM contact_skill_group a JOIN skill_group s ON s.owner_id=a.owner_id AND s.id=a.group_id WHERE a.owner_id=? AND a.contact_id=?',[i.ownerId,i.contactId]);
    if(!row)return {groupId:null,revision:0n,packageIds:[]};
    return {groupId:row.group_id as string,revision:row.revision as bigint,
      packageIds:tx.all('SELECT package_id FROM skill_group_package WHERE owner_id=? AND group_id=? ORDER BY package_id',[i.ownerId,row.group_id]).map(r=>r.package_id as string)};
  }},
];
