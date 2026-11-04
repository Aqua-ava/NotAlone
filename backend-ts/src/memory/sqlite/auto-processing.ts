import type {StorageAction,StorageMigration} from '../../storage/sqlite/contracts.ts';
import {fail} from './qualification.ts';

/**
 * 记忆自动处理总开关：库单例行上的偏好，只存 0/1，不含聊天内容。
 * 既有库升级后同样为关闭；开启必须由用户明确操作。
 */
export const memoryAutoProcessingMigration=(version:number):StorageMigration=>({version,sql:`
ALTER TABLE database_instance ADD COLUMN memory_auto_processing INTEGER NOT NULL DEFAULT 0 CHECK(memory_auto_processing IN (0,1));
`});

export const autoProcessingActions:StorageAction[]=[{
 name:'memoryExtraction.readAutomatic',mode:'read',retryBusy:false,execute(tx){
  const row=tx.get('SELECT memory_auto_processing AS enabled FROM database_instance WHERE slot=1');
  if(!row)return fail('memory_extraction_not_found');
  return {enabled:Number(row.enabled)===1};
 },
},{
 name:'memoryExtraction.setAutomatic',mode:'write',retryBusy:true,execute(tx,raw){
  const input=raw as {enabled?:unknown};
  if(typeof input?.enabled!=='boolean')return fail('memory_extraction_request_invalid');
  tx.run('UPDATE database_instance SET memory_auto_processing=? WHERE slot=1',[input.enabled?1:0]);
  return {enabled:input.enabled};
 },
}];
