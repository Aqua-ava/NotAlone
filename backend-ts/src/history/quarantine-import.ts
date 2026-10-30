import {createHash} from 'node:crypto';
import type {HistoryRecord, HistoryTarget} from './sqlite/contracts.ts';
import type {NarrowWechatClient} from './wechat/native-client.ts';
import {QuarantineVault} from './quarantine-vault.ts';

type QuarantineClient=Pick<NarrowWechatClient,'accountMetadata'|'resolveSelected'|'inspectSelected'|'supportSelected'|'quarantineTargetSelected'|'quarantinePageSelected'|'close'>;
const failure=(code:string)=>Object.assign(new Error(code),{code});
// 原生读者退出或超时也代表守卫证明已丢失，不断言来源实际发生了替换。
const lostCodes=new Set(['history_source_changed','history_source_unverified','history_scope_changed','history_account_changed','history_schema_changed','history_native_closed','history_native_unavailable','history_native_timeout']);

/** 仅开发验收的隔离导入；既不接入普通业务库，也不产生正常历史资格。 */
export async function importSelectedQuarantine(client:QuarantineClient,options:{displayName:string;root:string;signal?:AbortSignal;onVault?:(vault:QuarantineVault)=>void}):Promise<QuarantineVault> {
 let vault:QuarantineVault|undefined;
 try {
  if(typeof options.displayName!=='string'||!options.displayName.length||options.displayName.length>255)throw failure('quarantine_scope_invalid');
  const account=await client.accountMetadata(options.signal);
  if(account.status!=='verified')throw failure('quarantine_scope_invalid');
  const scope=await client.resolveSelected(options.displayName,options.signal);
  if(scope.accountKey!==account.accountKey||scope.sourceGeneration!==account.sourceGeneration||scope.displayName!==options.displayName)throw failure('quarantine_scope_invalid');
  await client.inspectSelected(options.signal);
  const support=await client.supportSelected(options.signal);
  if(support.capabilities?.programVersion!=='supported'||support.capabilities?.exactSchema!=='supported'||support.capabilities?.declaredLocalKey!=='supported')throw failure('quarantine_scope_invalid');
  const target=await client.quarantineTargetSelected(options.signal);
  if(target.sourceGeneration!==scope.sourceGeneration)throw failure('quarantine_scope_invalid');
  const scopeDigest=createHash('sha256').update(JSON.stringify([scope.accountKey,scope.conversationKey,scope.sourceGeneration])).digest('hex');
  vault=await QuarantineVault.create(options.root,{scopeDigest,displayName:options.displayName});options.onVault?.(vault);
  vault.begin({expectedPartitions:target.partitions});
  const completed=new Set<string>(),seen=new Set<string>();let cursor:string|null=null;
  for(let index=0;index<10000;index++){
   if(options.signal?.aborted)throw failure('history_native_cancelled');
   const result=await client.quarantinePageSelected(target,cursor,options.signal);
   const page=result.page;
   if(result.kind!=='quarantine'||page.target!==target.descriptor||page.cursorIn!==cursor||!Array.isArray(page.records)||page.records.length>16
    ||!Array.isArray(page.completedPartitions)||page.completedPartitions.some(partition=>!target.partitions.includes(partition))
    ||(page.exhausted?page.cursorOut!==null:!page.cursorOut||page.cursorOut===cursor))throw failure('quarantine_page_invalid');
   for(const row of page.records){
    validateRecord(row,target);
    const key=JSON.stringify([row.partition,row.table,row.localId]);
    if(seen.has(key))throw failure('quarantine_page_invalid');seen.add(key);
   }
   vault.appendPage(page.records,{scopeDigest,completedPartitions:page.completedPartitions});
   for(const partition of page.completedPartitions)completed.add(partition);
   if(page.exhausted){
    if(completed.size!==target.partitions.length)throw failure('quarantine_page_invalid');
    vault.complete({scopeDigest,completedPartitions:[...completed],sourceContinuity:'held',snapshotComplete:true});
    return vault;
   }
   cursor=page.cursorOut;
  }
  throw failure('quarantine_page_budget_exhausted');
 }catch(error){
  const code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'quarantine_import_failed';
  vault?.abort(lostCodes.has(code)?'source_continuity_lost':code==='history_native_cancelled'?'snapshot_interrupted':'snapshot_failed');
  if(!options.onVault)vault?.close();
  throw failure(/^[a-z][a-z0-9_]{1,100}$/.test(code)?code:'quarantine_import_failed');
 }finally{await client.close();}
}

function validateRecord(row:HistoryRecord,target:HistoryTarget):void {
 if(!row||row.stateAssurance!=='unverified'||typeof row.localId!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(row.localId)
  ||!target.tables.some(table=>table.partition===row.partition&&table.instance===row.table)
  ||row.kind!=='text'&&row.text!==null||row.text!==null&&(typeof row.text!=='string'||!row.text.isWellFormed()||Buffer.byteLength(row.text)>65536))throw failure('quarantine_page_invalid');
}
