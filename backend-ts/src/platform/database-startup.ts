/** 正常桌面启动：完成态只准备既有实例；首次创建或阻断恢复才加载完整启动编排。 */
import path from 'node:path';
import {controlledFiles} from '../storage/sqlite/files.ts';
import {CUTOVER_STARTUP_CONFIG,type CutoverManifest,type CutoverResult} from './cutover/contracts.ts';
import {CutoverControlError,loadManifest,loadStartupConfiguration,saveManifest} from './cutover/control.ts';
import {assertPrivateUserData,unrecognizedManagedTargets} from './cutover/targets.ts';
import type {DefaultDatabaseOptions,PreparedDatabaseStartup} from './cutover/startup.ts';

export async function prepareDatabaseStartup(options:DefaultDatabaseOptions):Promise<PreparedDatabaseStartup|CutoverResult>{
 const userData=path.resolve(options.userData);let manifest:CutoverManifest|undefined;
 try{
  assertPrivateUserData(userData);manifest=loadManifest(userData);
  if(!manifest||manifest.phase!=='completed'){
   const {runDatabaseStartup}=await import('./cutover/startup.ts');
   return await runDatabaseStartup(options);
  }
  if(manifest.configPath!==CUTOVER_STARTUP_CONFIG)throw new CutoverControlError('cutover_manifest_invalid');
  // 受管目录边界仍核验；退役写入器、旧备份及其清理状态不再参与完成态启动。
  if(unrecognizedManagedTargets(userData).length)return {phase:'maintenance',code:'cutover_legacy_target_unclassified',detail:'unsupported_managed_entry',manifestRevision:manifest.revision};
  const configuration=loadStartupConfiguration(userData);
  if(!configuration||!manifest.target?.ownerId||configuration.expectedDatabaseId!==manifest.target.databaseId)
   return {phase:'maintenance',code:'cutover_configuration_conflict',detail:'startup_configuration_identity_mismatch',manifestRevision:manifest.revision};
  controlledFiles(userData,false).verify();
  // 不打开数据库或推进租约；正式宿主及启动器仍复验实例、迁移账本、本人身份和运行互斥。
  return {phase:'prepared',code:'sqlite_prepared',databaseId:configuration.expectedDatabaseId,ownerId:manifest.target.ownerId,
   configuration:{capabilities:configuration.capabilities,...(configuration.skillPackageRoot?{skillPackageRoot:configuration.skillPackageRoot}:{})},manifestRevision:manifest.revision};
 }catch(error){
  const code=error instanceof CutoverControlError?error.code:'cutover_storage_failed';
  // 物理资料核对失败必须留下阻断；修正权限后进入一次完整维护复验，不能把既有身份丢失伪装成已准备。
  if(manifest)try{manifest=saveManifest(userData,{...manifest,phase:'blocked',blockedCode:code});}catch{/* 无法持久化时保留现场，不创建新身份。 */}
  return {phase:'maintenance',code,detail:'startup_preparation_failed',manifestRevision:manifest?.revision??0};
 }
}
