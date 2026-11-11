/** 正常桌面启动：完成切换后只准备既有实例；首次初始化才加载旧目标维护流程。 */
import path from 'node:path';
import {controlledFiles} from '../storage/sqlite/files.ts';
import {recoverSkillRootRelocation} from '../skills/sqlite/root-relocation.ts';
import {CUTOVER_STARTUP_CONFIG,type CutoverManifest,type CutoverResult} from './cutover/contracts.ts';
import {CutoverControlError,loadManifest,loadStartupConfiguration} from './cutover/control.ts';
import {assertPrivateUserData,unrecognizedManagedTargets} from './cutover/targets.ts';
import type {DefaultDatabaseOptions,PreparedDatabaseStartup} from './cutover/startup.ts';

export async function prepareDatabaseStartup(options:DefaultDatabaseOptions):Promise<PreparedDatabaseStartup|CutoverResult>{
 const userData=path.resolve(options.userData);let manifest:CutoverManifest|undefined;
 try{
  assertPrivateUserData(userData);manifest=loadManifest(userData);
  if(!manifest||manifest.phase!=='completed'){
   const {prepareLegacyDatabaseStartup}=await import('./cutover/startup.ts');
   return await prepareLegacyDatabaseStartup(options);
  }
  if(manifest.configPath!==CUTOVER_STARTUP_CONFIG)throw new CutoverControlError('cutover_manifest_invalid');
  // 受管目录边界仍核验；退役写入器、旧备份及其清理状态不再参与完成态启动。
  if(unrecognizedManagedTargets(userData).length)return {phase:'maintenance',code:'cutover_legacy_target_unclassified',detail:'unsupported_managed_entry',manifestRevision:manifest.revision};
  try{await recoverSkillRootRelocation(userData);}
  catch{return {phase:'maintenance',code:'cutover_configuration_conflict',detail:'skill_root_relocation_pending',manifestRevision:manifest.revision};}
  const configuration=loadStartupConfiguration(userData);
  if(!configuration||!manifest.target?.ownerId||configuration.expectedDatabaseId!==manifest.target.databaseId)
   return {phase:'maintenance',code:'cutover_configuration_conflict',detail:'startup_configuration_identity_mismatch',manifestRevision:manifest.revision};
  controlledFiles(userData,false).verify();
  // 不打开数据库或推进租约；正式宿主及启动器仍复验实例、迁移账本、本人身份和运行互斥。
  return {phase:'prepared',code:'sqlite_prepared',databaseId:configuration.expectedDatabaseId,ownerId:manifest.target.ownerId,
   configuration:{capabilities:configuration.capabilities,...(configuration.skillPackageRoot?{skillPackageRoot:configuration.skillPackageRoot}:{})},manifestRevision:manifest.revision};
 }catch(error){
  const code=error instanceof CutoverControlError?error.code:'cutover_storage_failed';
  return {phase:'maintenance',code,detail:'startup_preparation_failed',manifestRevision:manifest?.revision??0};
 }
}
