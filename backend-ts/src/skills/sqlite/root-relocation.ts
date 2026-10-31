/** 显式宿主维护：只迁移目录定位与配置，不复制、编辑或删除 Skill 原件。 */
import assert from 'node:assert/strict';
import {constants,closeSync,existsSync,fsyncSync,linkSync,lstatSync,openSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {canonicalRoot,readBounded,validateName} from '../skill-package.ts';
import {SecureSkillDirectory} from '../secure-directory.ts';
import {readSkillDirectorySnapshot} from './library.ts';
import type {SkillPackageState} from './contracts.ts';
import {SqliteStorage} from '../../storage/sqlite/client.ts';
import {readSqliteCapabilities} from '../../sqlite-capabilities.ts';
import {cutoverDirectory,ensureControlDirectory,loadManifest,loadStartupConfiguration,saveStartupConfiguration} from '../../platform/cutover/control.ts';

interface RelocationEntry {
  id: string; directoryName: string; expectedHead: string; expectedDirectoryIdentity: string;
  directoryIdentity: string; manifestDigest: string; contentDigest: string;
}
const MAX_JOURNAL_BYTES=1024*1024;
export interface SkillRootRelocationPlan {
  formatVersion: 1; databaseId: string; ownerId: string; fromRoot: string; toRoot: string; packages: RelocationEntry[];
}
export function skillRootRelocationJournal(userData: string): string {
  return path.join(cutoverDirectory(userData),'skill-root-relocation.json');
}
function stopped(userData: string): void {
  const info=path.join(userData,'managed/sqlite-backend.info');
  assert.ok(!existsSync(info)&&!existsSync(info+'.dsh-lock'),'skill_root_relocation_busy');
}
function context(userData: string) {
  const configuration=loadStartupConfiguration(userData),manifest=loadManifest(userData);
  assert.ok(configuration?.skillPackageRoot && configuration.capabilities.includes('skills'),'skill_root_configuration_missing');
  assert.ok(manifest?.phase==='completed' && manifest.target?.ownerId && manifest.target.databaseId===configuration.expectedDatabaseId,'skill_root_owner_mismatch');
  return {configuration,ownerId:manifest.target.ownerId};
}
function sameNames(actual: string[],expected: string[]): void {
  assert.deepEqual([...actual].sort(),[...expected].sort(),'skill_root_package_set_changed');
}
function sameSnapshot(a: {manifestDigest:string;contentDigest:string},b: {manifestDigest:string;contentDigest:string}): void {
  assert.equal(a.manifestDigest,b.manifestDigest,'skill_root_content_changed');
  assert.equal(a.contentDigest,b.contentDigest,'skill_root_content_changed');
}
function currentMatches(item: SkillPackageState,snapshot: {manifestDigest:string;contentDigest:string}): void {
  if(item.currentRevisionNo===null)return;
  const current=item.revisions.find(r=>r.revisionNo===item.currentRevisionNo);
  assert.ok(current && item.verificationState==='verified' && current.availability==='current' && current.verificationState==='verified','skill_root_revision_invalid');
  sameSnapshot(current,snapshot);
}
function syncDirectory(directory: string): void {
  const fd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{fsyncSync(fd);}finally{closeSync(fd);}
}
function readPlan(userData: string): SkillRootRelocationPlan|undefined {
  const file=skillRootRelocationJournal(userData);
  try {
    let entry=lstatSync(file);
    assert.ok(entry.isFile()&&!entry.isSymbolicLink()&&entry.uid===process.getuid?.()&&(entry.mode&0o777)===0o600,'skill_root_journal_invalid');
    // 恢复发布后尚未来得及清理的同 inode 临时名；不接受控制目录外的硬链接。
    if(entry.nlink===2){
      for(const name of readdirSync(path.dirname(file)).filter(name=>/^\.skill-root-relocation\.[a-f0-9-]{36}\.tmp$/.test(name))){
        const temporary=path.join(path.dirname(file),name);
        try{const candidate=lstatSync(temporary);if(candidate.isFile()&&candidate.dev===entry.dev&&candidate.ino===entry.ino)unlinkSync(temporary);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      syncDirectory(path.dirname(file));entry=lstatSync(file);
    }
    assert.equal(entry.nlink,1,'skill_root_journal_invalid');
    const plan=JSON.parse(readBounded(file,MAX_JOURNAL_BYTES).toString('utf8')) as SkillRootRelocationPlan;
    assert.ok(plan.formatVersion===1 && typeof plan.databaseId==='string' && typeof plan.ownerId==='string' && Array.isArray(plan.packages),'skill_root_journal_invalid');
    for(const root of [plan.fromRoot,plan.toRoot])assert.ok(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root,'skill_root_journal_invalid');
    assert.notEqual(plan.fromRoot,plan.toRoot,'skill_root_journal_invalid');
    assert.equal(new Set(plan.packages.map(p=>p.id)).size,plan.packages.length,'skill_root_journal_invalid');
    for(const p of plan.packages){
      validateName(p.directoryName);
      assert.ok(typeof p.id==='string'&&p.id.length>0&&typeof p.expectedHead==='string'&&/^[1-9][0-9]*$/.test(p.expectedHead),'skill_root_journal_invalid');
      assert.match(p.manifestDigest,/^[a-f0-9]{64}$/);assert.match(p.contentDigest,/^[a-f0-9]{64}$/);
      for(const [root,identity]of [[plan.fromRoot,p.expectedDirectoryIdentity],[plan.toRoot,p.directoryIdentity]]){
        const value=JSON.parse(identity);
        assert.ok(Array.isArray(value)&&value.length===3&&value[0]===path.join(root,p.directoryName)&&value.slice(1).every(x=>typeof x==='string'&&/^[0-9]+$/.test(x)),'skill_root_journal_invalid');
      }
    }
    return plan;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
function publishPlan(userData: string,plan: SkillRootRelocationPlan): void {
  const content=JSON.stringify(plan)+'\n';
  assert.ok(Buffer.byteLength(content)<=MAX_JOURNAL_BYTES,'skill_root_journal_too_large');
  const directory=ensureControlDirectory(userData),file=skillRootRelocationJournal(userData);
  const temporary=path.join(directory,`.skill-root-relocation.${randomUUID()}.tmp`);
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}
  try{linkSync(temporary,file);}finally{try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  syncDirectory(directory);
}

/** 先验证全部新旧字节并持久化意图；未完成的意图由启动入口恢复，普通刷新不能抢先运行。 */
export async function prepareSkillRootRelocation(userData: string,targetRoot: string): Promise<SkillRootRelocationPlan|undefined> {
  stopped(userData);
  const {configuration,ownerId}=context(userData),toRoot=canonicalRoot(path.resolve(targetRoot));
  assert.ok(readSqliteCapabilities(configuration.capabilities,toRoot,userData),'skill_root_configuration_invalid');
  const pending=readPlan(userData);
  if(pending){
    assert.equal(pending.toRoot,toRoot,'skill_root_relocation_pending');
    assert.equal(pending.databaseId,configuration.expectedDatabaseId,'skill_root_owner_mismatch');assert.equal(pending.ownerId,ownerId,'skill_root_owner_mismatch');
    assert.ok([pending.fromRoot,pending.toRoot].includes(canonicalRoot(configuration.skillPackageRoot!)),'skill_root_configuration_changed');
    return pending;
  }
  const fromRoot=canonicalRoot(configuration.skillPackageRoot!);
  if(fromRoot===toRoot)return undefined;
  const source=new SecureSkillDirectory(fromRoot),target=new SecureSkillDirectory(toRoot);
  const storage=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:configuration.expectedDatabaseId});
  try {
    const items=await storage.execute<SkillPackageState[]>('skills.list',{ownerId});
    sameNames(source.names(),items.map(i=>i.directoryName));sameNames(target.names(),items.map(i=>i.directoryName));
    const packages=items.map(item=>{
      const old=readSkillDirectorySnapshot(source,item.directoryName,item.directoryIdentity);
      const directoryIdentity=target.directoryIdentity(item.directoryName);
      const next=readSkillDirectorySnapshot(target,item.directoryName,directoryIdentity);
      sameSnapshot(old,next);currentMatches(item,next);
      return {id:item.id,directoryName:item.directoryName,expectedHead:item.headRevision.toString(),expectedDirectoryIdentity:item.directoryIdentity,
        directoryIdentity,manifestDigest:next.manifestDigest,contentDigest:next.contentDigest};
    });
    const plan:SkillRootRelocationPlan={formatVersion:1,databaseId:configuration.expectedDatabaseId,ownerId,fromRoot,toRoot,packages};
    publishPlan(userData,plan);return plan;
  } finally {await storage.close();}
}

/** 可在数据库提交或配置切换后的任一点重试；保留启停、来源资格和不可变修订。 */
export async function recoverSkillRootRelocation(userData: string): Promise<SkillRootRelocationPlan|undefined> {
  const plan=readPlan(userData);if(!plan)return undefined;
  stopped(userData);
  const {configuration,ownerId}=context(userData);
  assert.equal(configuration.expectedDatabaseId,plan.databaseId,'skill_root_owner_mismatch');assert.equal(ownerId,plan.ownerId,'skill_root_owner_mismatch');
  const configured=canonicalRoot(configuration.skillPackageRoot!);
  assert.ok(configured===plan.fromRoot||configured===plan.toRoot,'skill_root_configuration_changed');
  assert.ok(readSqliteCapabilities(configuration.capabilities,plan.toRoot,userData),'skill_root_configuration_invalid');
  const storage=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:plan.databaseId});
  try {
    const items=await storage.execute<SkillPackageState[]>('skills.list',{ownerId});
    sameNames(items.map(i=>i.id),plan.packages.map(p=>p.id));
    const original=items.every(i=>{const p=plan.packages.find(p=>p.id===i.id)!;return i.directoryIdentity===p.expectedDirectoryIdentity&&i.headRevision===BigInt(p.expectedHead);});
    const applied=items.every(i=>{const p=plan.packages.find(p=>p.id===i.id)!;return i.directoryIdentity===p.directoryIdentity&&i.headRevision===BigInt(p.expectedHead)+1n;});
    assert.ok(original||applied,'skill_root_relocation_conflict');
    const target=new SecureSkillDirectory(plan.toRoot),source=original?new SecureSkillDirectory(plan.fromRoot):undefined;
    sameNames(target.names(),plan.packages.map(p=>p.directoryName));if(source)sameNames(source.names(),plan.packages.map(p=>p.directoryName));
    for(const p of plan.packages){
      const next=readSkillDirectorySnapshot(target,p.directoryName,p.directoryIdentity);sameSnapshot(next,p);
      currentMatches(items.find(i=>i.id===p.id)!,next);
      if(source)sameSnapshot(readSkillDirectorySnapshot(source,p.directoryName,p.expectedDirectoryIdentity),next);
    }
    if(original)await storage.execute('skills.relocateRoot',{ownerId,packages:plan.packages.map(p=>({...p,expectedHead:BigInt(p.expectedHead)}))});
    const latest=loadStartupConfiguration(userData);
    assert.ok(latest?.expectedDatabaseId===plan.databaseId && [plan.fromRoot,plan.toRoot].includes(canonicalRoot(latest.skillPackageRoot!)),'skill_root_configuration_changed');
    saveStartupConfiguration(userData,{...latest,skillPackageRoot:plan.toRoot});
    unlinkSync(skillRootRelocationJournal(userData));syncDirectory(cutoverDirectory(userData));
    return plan;
  } finally {await storage.close();}
}
