import {sha256} from '../../platform/sha256.ts';
import {StorageFailure,type StorageTransaction,type StorageAction} from '../../storage/sqlite/contracts.ts';
import {assertReadEligibility} from '../../contacts/sqlite/actions.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistoryRecord,HistoryRecoveryPosition,HistoryRecoveryResult,HistorySupportReport,HistoryTarget} from './contracts.ts';
import {historyTargetTransition} from '../partition-growth.ts';
import {normalUseContinuity,prepareNormalUseTarget,fenceContinuity} from './continuity.ts';
import {assertHistoryReadBoundary} from './suppression.ts';

const fail=():never=>{throw new StorageFailure('history_source_continuity_unverified');};
const sourceKey=(r:Pick<HistoryRecord,'partition'|'table'|'localId'>)=>JSON.stringify([r.partition,r.table,r.localId]);
// 传输顺序、可重算引用与送达状态不属于正文锚点；撤回、身份、类型或正文变化仍拒绝。
function anchorDigest(r:HistoryRecord):string {
 return sha256(JSON.stringify([r.partition,r.table,r.localId,r.serverId,r.sender,r.kind,r.text,r.originalType,r.sentAt,r.timePrecision,r.metadataOnly??false,['recalled','absent'].includes(r.messageState??'')?r.messageState:null]));
}
export interface SourceRecoveryPlan {
 fenced:boolean; target:HistoryTarget; positions:HistoryRecoveryPosition[]; anchors:{key:string;digest:string}[]; digest:string;
}
/** 来源核对只读本联系人的索引范围；最多返回每表八个锚点摘要，不返回正文。 */
export function sourceRecoveryPlan(tx:StorageTransaction,token:ReadEligibility,report:HistorySupportReport,allowUnfenced=false):SourceRecoveryPlan|null {
 assertReadEligibility(tx,token);assertHistoryReadBoundary(tx,token,{kind:'history'});
 const fenced=Boolean(tx.get('SELECT 1 FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]));
 if(!fenced&&!allowUnfenced)return null;
 const scope=tx.get('SELECT * FROM history_continuity_scope WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 if(!scope&&!fenced)return null;
 const identity=tx.get('SELECT a.external_key account_key,c.external_key conversation_key FROM channel_account a JOIN channel_conversation c ON c.owner_id=a.owner_id AND c.account_id=a.id WHERE a.owner_id=? AND a.id=? AND c.id=?',[token.owner_id,token.account_id,token.conversation_id]);
 if(!scope||scope.conversation_id!==token.conversation_id||scope.source_generation!==token.source_generation||!scope.tables_json
  ||report.continuity!==normalUseContinuity||report.accountKey!==identity?.account_key||report.conversationKey!==identity?.conversation_key||report.sourceGeneration!==token.source_generation)fail();
 let stored:any;try{stored=JSON.parse(String(scope!.tables_json));}catch{return fail();}
 if(stored.accountKey!==report.accountKey||!Array.isArray(stored.tables)||stored.tables.length>128)fail();
 const target:HistoryTarget={protocol:'private-history-v1',descriptor:'stored-source-proof',sourceGeneration:token.source_generation,
  partitions:stored.partitions,tables:stored.tables.map(([partition,instance]:string[])=>({partition,instance})),...(stored.checkedPartitions?{checkedPartitions:stored.checkedPartitions}:{})};
 if(!historyTargetTransition(target,target,false))fail();
 const positions:HistoryRecoveryPosition[]=[],anchors:SourceRecoveryPlan['anchors']=[];
 for(const table of target.tables){
  const prefix=JSON.stringify([token.source_generation,table.partition,table.instance]).slice(0,-1)+',';
  const rows=tx.all(`SELECT r.observed_key,r.raw_payload,r.normalizer_version,m.text_body,max(c.captured_at) latest FROM capture_record r
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
   LEFT JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id AND m.availability='available'
   WHERE r.owner_id=? AND r.contact_id=? AND r.availability='available' AND g.binding_id=?
   AND r.observed_scheme='source-table-local-v1' AND r.observed_key>=? AND r.observed_key<?
   GROUP BY r.observed_key ORDER BY length(json_extract(r.observed_key,'$[3]')) DESC,json_extract(r.observed_key,'$[3]') DESC LIMIT 8`,
   [token.owner_id,token.contact_id,token.binding_id,prefix,prefix+'~']);
  const anchorLocalIds:string[]=[];let maxLocalId='0';
  for(const row of rows){
   const key=JSON.parse(String(row.observed_key));const localId=key[3];
   if(typeof localId!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(localId)||BigInt(localId)>18446744073709551615n)fail();
   if(BigInt(localId)>BigInt(maxLocalId))maxLocalId=localId;
   if(row.raw_payload){const raw=JSON.parse(String(row.raw_payload)) as HistoryRecord;if(row.normalizer_version==='2'&&raw.kind==='text')raw.text=row.text_body===null?null:String(row.text_body);if(sourceKey(raw)!==JSON.stringify([table.partition,table.instance,localId]))fail();anchorLocalIds.push(localId);anchors.push({key:sourceKey(raw),digest:anchorDigest(raw)});}
  }
  // 删除和清空可以擦除最后的捕获记录；无正文抑制仍证明这些位置已被处理。
  const suppressed=tx.get(`SELECT external_key FROM (
   SELECT external_key FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? AND scheme='local' AND external_key>=? AND external_key<?
   UNION ALL SELECT external_key FROM history_cutoff_member WHERE owner_id=? AND conversation_id=? AND scheme='local' AND external_key>=? AND external_key<?
   UNION ALL SELECT external_key FROM history_source_terminal WHERE owner_id=? AND contact_id=? AND binding_id=? AND external_key>=? AND external_key<?
  ) ORDER BY length(json_extract(external_key,'$[3]')) DESC,json_extract(external_key,'$[3]') DESC LIMIT 1`,
   [token.owner_id,token.conversation_id,prefix,prefix+'~',token.owner_id,token.conversation_id,prefix,prefix+'~',token.owner_id,token.contact_id,token.binding_id,prefix,prefix+'~']);
  if(suppressed){const localId=JSON.parse(String(suppressed.external_key))[3];if(typeof localId!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(localId)||BigInt(localId)>18446744073709551615n)fail();if(BigInt(localId)>BigInt(maxLocalId))maxLocalId=localId;}
  positions.push({partition:table.partition,table:table.instance,maxLocalId,anchorLocalIds});
 }
 const value={fenced,target,positions,anchors};return {...value,digest:sha256(JSON.stringify({token,...value}))};
}
export function prepareRecoveredSource(tx:StorageTransaction,input:{token:ReadEligibility;report:HistorySupportReport;planDigest:string;recovery:HistoryRecoveryResult;guardId:string}):{ok:boolean;revalidated:boolean} {
 const {token,report,recovery}=input,plan=sourceRecoveryPlan(tx,token,report,true);
 if(!plan||plan.digest!==input.planDigest||!historyTargetTransition(plan.target,recovery.target,report.capabilities?.partitionGrowth==='supported')||!Array.isArray(recovery.anchors)||recovery.anchors.length!==plan.anchors.length)return {ok:fenceContinuity(tx,token,'N04'),revalidated:false};
 const actual=new Map(recovery.anchors.map(r=>[sourceKey(r),anchorDigest(r)]));
 if(actual.size!==plan.anchors.length||plan.anchors.some(r=>actual.get(r.key)!==r.digest))return {ok:fenceContinuity(tx,token,'N04'),revalidated:false};
 // 清围栏与续期在同一事务；任何失败回滚，旧授权、删除代次及抑制表均不改写。
 tx.run('DELETE FROM history_continuity_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]);
 tx.run("UPDATE history_guard_lease SET state='lost' WHERE owner_id=? AND contact_id=?",[token.owner_id,token.contact_id]);
 const prepared=prepareNormalUseTarget(tx,token,recovery.target,report,input.guardId,true);
 if(!prepared.ok)fail();
 tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=?',[token.owner_id,token.contact_id]);
 return prepared;
}
export const sourceRecoveryActions:StorageAction[]=[
 {name:'history.sourceRecoveryPlan',mode:'read',retryBusy:true,execute:(tx,i:any)=>sourceRecoveryPlan(tx,i.token,i.report,i.allowUnfenced)},
 {name:'history.prepareRecoveredGuard',mode:'write',retryBusy:true,execute:(tx,i:any)=>prepareRecoveredSource(tx,i)},
];
