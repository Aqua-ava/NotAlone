import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {CheckResult,DeletionAuthority,DeletionDomain,DeletionOperation,DeletionRegistration,DeletionScope,RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';
import {historyTarget} from './deletion-target.ts';
import {batchBoundary,batchTargets,clearableMessages,messageStillClearable,supersededBindings,supersededGate} from './superseded.ts';

/**
 * 修复同步后清理被取代绑定副本的统一删除范围（ADR-175）。
 *
 * 这不是用户删除：不写 `history_deletion_fence`、来源排除或清空边界，不推进联系人资料代次，
 * 也不撤销任何读取资格，因此不会阻止以后重读。它只清理被取代绑定下没有派生引用的消息束，
 * 由现有删除账本分批、可续跑地执行，并复用媒体域清除托管文件。
 */
export type SupersededScope=Extract<DeletionScope,{kind:'superseded_history'}>;
export const isSupersededScope=(scope:DeletionScope):scope is SupersededScope=>scope.kind==='superseded_history';
/**
 * 单个操作最多处理的消息数；批次上界在计划时固定，使有界操作能够结案。
 * 每个操作结案前要做一次整库压缩（VACUUM 加校验，1.3 GB 库约 9 秒），批次太小会让压缩次数成为主要耗时；
 * 清除本身是一条消息束一个短事务，批次大小不增加单个事务的时长。
 */
export const supersededBatchMessages=5000;

const fail=(code:string):never=>{throw new StorageFailure(code);};
const passed=(proof:string):CheckResult=>({result:'passed',proof});
const notApplicable=(proof:string):CheckResult=>({result:'not_applicable',proof});

/** 本操作冻结的消息：账本里已计划的消息束；首次计划前按批次上界现算。 */
export function supersededMessageIds(tx:StorageTransaction,op:DeletionOperation):string[] {
 if(!isSupersededScope(op.scope))return [];
 const planned=tx.all("SELECT row_key_snapshot FROM deletion_target WHERE operation_id=? AND domain='history' AND row_kind='superseded_message' AND row_key_snapshot IS NOT NULL",[op.operationId]);
 const frozen=[...new Set(planned.flatMap(row=>{try{const key=JSON.parse(String(row.row_key_snapshot));return key.owner_id===op.ownerId&&typeof key.id==='string'?[key.id]:[];}catch{return [];}}))];
 if(!planned.length)return batchTargets(tx,op.ownerId,op.scope.contactId,op.acceptedGeneration).messages.map(m=>m.id);
 const bindings=supersededBindings(tx,op.ownerId,op.scope.contactId);
 // 门禁关闭（出现围栏、进行中的修复或其他删除）时，历史域的消息束会被跳过，媒体同样不再清除，保持消息与媒体一致。
 if(!frozen.length||supersededGate(tx,op.ownerId,op.scope.contactId,bindings))return [];
 // 已计划的消息束仍须逐条满足“当前仍可清”，期间新增的引用使其保留，媒体不再被连带清除。
 return clearableMessages(tx,op.ownerId,op.scope.contactId,bindings.map(b=>b.bindingId),{ids:frozen}).map(m=>m.id);
}

export function supersededCollect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[] {
 if(!isSupersededScope(op.scope))return [];
 const batch=batchTargets(tx,op.ownerId,op.scope.contactId,op.acceptedGeneration);
 return [...batch.messages.map(m=>historyTarget('superseded_message',{owner_id:op.ownerId,id:m.id})),
  ...batch.captureIds.map(id=>historyTarget('sync_capture',{owner_id:op.ownerId,id}))];
}

/** 逐条在写事务内复验后清理；任何不再可清（新引用、围栏、进行中的修复或删除）的对象保持原样。 */
export function supersededClearRow(tx:StorageTransaction,op:DeletionOperation,target:RowDeletionTarget):void {
 if(!isSupersededScope(op.scope))return fail('history_deletion_target_invalid');
 const {ownerId}=op,contactId=op.scope.contactId;
 if(target.rowKind==='sync_capture'){
  const gate=supersededGate(tx,ownerId,contactId);
  if(gate)return;
  const capture=tx.get('SELECT c.id,g.binding_id FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE c.owner_id=? AND c.contact_id=? AND c.id=?',[ownerId,contactId,target.key.id!]);
  if(!capture)return;
  if(!supersededBindings(tx,ownerId,contactId).some(b=>b.bindingId===capture.binding_id))return;
  if(tx.get('SELECT 1 FROM capture_record WHERE owner_id=? AND contact_id=? AND capture_id=? LIMIT 1',[ownerId,contactId,target.key.id!]))return;
  tx.run('DELETE FROM sync_capture WHERE owner_id=? AND id=?',[ownerId,target.key.id!]);
  return;
 }
 if(target.rowKind!=='superseded_message')return fail('history_deletion_target_invalid');
 const messageId=target.key.id!;
 if(!tx.get('SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,contactId,messageId]))return;
 if(!messageStillClearable(tx,ownerId,contactId,messageId))return;
 // 媒体域排在历史域之前清除其行与托管文件；仍有残留说明文件字节尚未擦除。此处跳过而不是报错：
 // 核验时重新收集会把本消息束重新置为待清理，媒体清完后下一轮再清，避免晚到的媒体目标被前面的失败挡住。
 if(tx.get('SELECT 1 FROM message_media WHERE owner_id=? AND message_id=?',[ownerId,messageId])
  ||tx.get('SELECT 1 FROM media_extraction_attempt WHERE owner_id=? AND message_id=? LIMIT 1',[ownerId,messageId]))return;
 // 外键顺序：引用尝试→引用（含以本消息为目标的、载体同属被取代集合的引用）→来源记录→别名→消息。
 tx.run('DELETE FROM history_quote_attempt WHERE owner_id=? AND contact_id=? AND message_id=?',[ownerId,contactId,messageId]);
 tx.run('DELETE FROM history_quote WHERE owner_id=? AND contact_id=? AND (message_id=? OR target_message_id=?)',[ownerId,contactId,messageId,messageId]);
 tx.run('DELETE FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=?',[ownerId,contactId,messageId]);
 tx.run('DELETE FROM message_alias WHERE owner_id=? AND contact_id=? AND message_id=?',[ownerId,contactId,messageId]);
 tx.run('DELETE FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,contactId,messageId]);
}

export function supersededVerify(tx:StorageTransaction,op:DeletionOperation):ReturnType<DeletionDomain['verify']> {
 if(!isSupersededScope(op.scope))return fail('history_deletion_target_invalid');
 const remaining=supersededCollect(tx,op).length;
 const rows:CheckResult=remaining===0?passed('history_rows_cleared'):{result:'blocked',proof:'history_rows_remain'};
 return {database_rows:rows,derived_eligibility:notApplicable('superseded_cleanup_keeps_referenced_results'),
  trace_payloads:remaining===0?passed('history_capture_payloads_cleared'):{result:'blocked',proof:'history_payloads_remain'},
  request_replay:notApplicable('superseded_cleanup_has_no_request_state'),
  scope_suppression:notApplicable('superseded_cleanup_keeps_suppression_records')};
}

/** 只改变本范围的授权代次判断：不推进联系人资料代次，也不撤销读取资格。 */
export function supersededAuthority(options:{batchSize?:number}={}):Pick<DeletionAuthority,'fence'|'verify'> {
 const batchSize=options.batchSize??supersededBatchMessages;
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>supersededBatchMessages*10)throw new RangeError('superseded_batch_size_invalid');
 return {
  fence(tx,ownerId,scope){
   if(!isSupersededScope(scope))return fail('superseded_deletion_scope_invalid');
   const reason=supersededGate(tx,ownerId,scope.contactId);
   if(reason)return fail(`superseded_cleanup_${reason}`);
   const batch=batchBoundary(tx,ownerId,scope.contactId,batchSize);
   if(!batch)return fail('superseded_cleanup_nothing_to_clear');
   return batch.boundary;
  },
  verify(tx,op){
   if(!isSupersededScope(op.scope))return {result:'blocked',proof:'superseded_deletion_scope_invalid'};
   return tx.get('SELECT 1 FROM contact WHERE owner_id=? AND id=?',[op.ownerId,op.scope.contactId])
    ?passed('superseded_scope_read_authority_unchanged'):{result:'blocked',proof:'superseded_contact_missing'};
  },
 };
}

/**
 * 只有历史域与媒体域参与本范围；其余领域不会有被取代消息的派生结果（有派生引用的消息已被保留），
 * 因此不收集目标、不撤销请求，核验记为不适用。
 */
export function composeSupersededHistoryRegistration(base:DeletionRegistration,options:{batchSize?:number}={}):DeletionRegistration {
 const participants=new Set(['history','media']);
 const authority=supersededAuthority(options);
 const irrelevant=notApplicable('superseded_cleanup_touches_only_history_and_media');
 const domains=base.domains.map(domain=>participants.has(domain.id)?domain:{...domain,
  fence(tx:StorageTransaction,op:DeletionOperation){return isSupersededScope(op.scope)?[]:domain.fence(tx,op);},
  collect(tx:StorageTransaction,op:DeletionOperation){return isSupersededScope(op.scope)?[]:domain.collect(tx,op);},
  verify(tx:StorageTransaction,op:DeletionOperation){
   return isSupersededScope(op.scope)?{database_rows:irrelevant,derived_eligibility:irrelevant,trace_payloads:irrelevant,request_replay:irrelevant,scope_suppression:irrelevant}:domain.verify(tx,op);
  },
 });
 return {...base,domains,authority:{
  fence:(tx,owner,scope)=>isSupersededScope(scope)?authority.fence(tx,owner,scope):base.authority.fence(tx,owner,scope),
  verify:(tx,op)=>isSupersededScope(op.scope)?authority.verify(tx,op):base.authority.verify(tx,op),
 }};
}
