import {sourceDeletionIds} from '../../history/sqlite/source-deletion.ts';
import {isMediaDeletionScope} from '../../media/sqlite/deletion.ts';
import {memoryDeletionImpact} from '../../memory/sqlite/deletion-impact.ts';
import {collectMemoryDocumentDeletionReferences} from '../../memory/sqlite/documents/deletion.ts';
import {createHash} from 'node:crypto';
import {StorageFailure,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {CheckResult,DeletionAuthority,DeletionDomain,DeletionOperation,DeletionScope,DeletionTarget,FileDeletionTarget,ManagedAddress,RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';
function fail(code:string):never{throw new StorageFailure(code);}
const pass=(proof:string):CheckResult=>({result:'passed',proof});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=(value:unknown):string=>createHash('sha256').update(canonical(value)).digest('hex');
const supported=(scope:DeletionScope)=>isMediaDeletionScope(scope)||['discussion','source','contact_history','contact','account'].includes(scope.kind);
const wholeDiscussion=(scope:DeletionScope)=>['discussion','contact','account'].includes(scope.kind);
/** 精确讨论的屏障只推进该讨论，不撤销同联系人的独立资料资格。 */
export const discussionDeletionAuthority:DeletionAuthority={
 fence(tx,ownerId,scope){
  if(scope.kind!=='discussion')fail('discussion_deletion_scope_invalid');
  const row=tx.get(`SELECT d.generation FROM assistant_discussion d JOIN contact c ON c.owner_id=d.owner_id AND c.id=d.contact_id JOIN owner o ON o.owner_id=c.owner_id
   WHERE d.owner_id=? AND d.contact_id=? AND d.id=? AND d.state='active' AND c.state='active' AND o.state='active'`,[ownerId,scope.contactId,scope.discussionId]);
  if(!row)fail('discussion_deletion_scope_invalid');
  tx.run("UPDATE assistant_discussion SET state='deleting',generation=generation+1,current_runtime_id=NULL,is_current=0 WHERE owner_id=? AND contact_id=? AND id=?",[ownerId,scope.contactId,scope.discussionId]);
  return (row.generation as bigint)+1n;
 },
 verify(tx,op){
  if(op.scope.kind!=='discussion')return {result:'blocked',proof:'discussion_scope_handler_unavailable'};
  const row=tx.get("SELECT generation FROM assistant_discussion WHERE owner_id=? AND contact_id=? AND id=? AND state IN ('deleting','deleted')",[op.ownerId,op.scope.contactId,op.scope.discussionId]);
  return row&&typeof row.generation==='bigint'&&row.generation>=op.acceptedGeneration?pass('discussion_generation_fenced'):{result:'blocked',proof:'discussion_generation_missing_or_changed'};
 },
};
/** 共用宿主以此组合已有账号/联系人authority，不能用contact.data_generation代替精确讨论。 */
export function withDiscussionDeletionAuthority(fallback:DeletionAuthority):DeletionAuthority{
 return {fence:(tx,ownerId,scope)=>scope.kind==='discussion'?discussionDeletionAuthority.fence(tx,ownerId,scope):fallback.fence(tx,ownerId,scope),
  verify:(tx,op)=>op.scope.kind==='discussion'?discussionDeletionAuthority.verify(tx,op):fallback.verify(tx,op)};
}
function discussions(tx:StorageTransaction,op:DeletionOperation):StorageRow[]{
 const s=op.scope;if(!supported(s))return [];
 return tx.all(`SELECT * FROM assistant_discussion WHERE owner_id=?${s.kind==='account'?'':' AND contact_id=?'}${s.kind==='discussion'?' AND id=?':''}`,
  s.kind==='account'?[op.ownerId]:s.kind==='discussion'?[op.ownerId,s.contactId,s.discussionId]:[op.ownerId,s.contactId]);
}
interface Closure {contexts:Set<string>;requests:Set<string>;copies:Set<string>}
/** 每条依赖只沿前沿传播一次；同副本只扩展尚未访问的后缀，保留跨联系人本人资料依赖。 */
function expandClosure(result:Closure,rows:{contexts:StorageRow[];items:StorageRow[];entries:StorageRow[];attempts:StorageRow[];preparing:StorageRow[];incorporations:StorageRow[];carried:StorageRow[]}):void{
 const append=(map:Map<string,string[]>,key:string,value:string)=>{const values=map.get(key);if(values)values.push(value);else map.set(key,[value]);};
 const contextRequests=new Map<string,string>(),requestContexts=new Map<string,string[]>(),requestEntries=new Map<string,string[]>(),requestCopies=new Map<string,string[]>(),carriedRequests=new Map<string,string[]>();
 for(const row of rows.contexts)if(row.request_id!==null){const request=String(row.request_id),context=String(row.id);contextRequests.set(context,request);append(requestContexts,request,context);}
 const entryRequests=new Map(rows.entries.filter(row=>row.origin_request_id!==null).map(row=>[String(row.id),String(row.origin_request_id)]));
 for(const row of rows.items)if(row.kind==='entry'){const request=entryRequests.get(String(row.entry_id));if(request)append(requestEntries,request,String(row.context_id));}
 const attemptRequests=new Map(rows.attempts.map(row=>[String(row.id),String(row.request_id)]));
 for(const row of rows.preparing)if(row.preparing_attempt_id!==null){const request=attemptRequests.get(String(row.preparing_attempt_id));if(request)append(requestCopies,request,String(row.id));}
 for(const row of rows.carried)append(carriedRequests,String(row.origin_request),String(row.request_id));
 type Incorporation={contextId:string;copyId:string;position:bigint;index:number};
 const byContext=new Map<string,Incorporation[]>(),byCopy=new Map<string,Incorporation[]>(),visitedSuffix=new Map<string,number>();
 for(const row of rows.incorporations){
  const item:Incorporation={contextId:String(row.context_id),copyId:String(row.copy_id),position:row.incorporation_no as bigint,index:0};
  const contexts=byContext.get(item.contextId);if(contexts)contexts.push(item);else byContext.set(item.contextId,[item]);
  const copies=byCopy.get(item.copyId);if(copies)copies.push(item);else byCopy.set(item.copyId,[item]);
 }
 for(const [copyId,items] of byCopy){
  items.sort((a,b)=>a.position<b.position?-1:a.position>b.position?1:0);
  let first=0;for(let index=0;index<items.length;index++){if(index&&items[index].position!==items[index-1].position)first=index;items[index].index=first;}
  visitedSuffix.set(copyId,items.length);
 }
 const queue:Array<{kind:'context'|'request';id:string}>=[...[...result.contexts].map(id=>({kind:'context' as const,id})),...[...result.requests].map(id=>({kind:'request' as const,id}))];
 const add=(kind:'context'|'request',id:string)=>{const set=kind==='context'?result.contexts:result.requests;if(!set.has(id)){set.add(id);queue.push({kind,id});}};
 for(let cursor=0;cursor<queue.length;cursor++){
  const current=queue[cursor];
  if(current.kind==='request'){
   for(const context of requestContexts.get(current.id)??[])add('context',context);
   for(const context of requestEntries.get(current.id)??[])add('context',context);
   for(const request of carriedRequests.get(current.id)??[])add('request',request);
   for(const copy of requestCopies.get(current.id)??[])result.copies.add(copy);
  }else{
   const request=contextRequests.get(current.id);if(request)add('request',request);
   for(const item of byContext.get(current.id)??[]){
    result.copies.add(item.copyId);
    const end=visitedSuffix.get(item.copyId)!;
    if(item.index>=end)continue;
    visitedSuffix.set(item.copyId,item.index);
    const copies=byCopy.get(item.copyId)!;
    for(let index=item.index;index<end;index++)add('context',copies[index].contextId);
   }
  }
 }
}
/** 反查实际输入；后续复用同副本的上下文也确实接触过先前输入，按纳入顺序传播。 */
function closure(tx:StorageTransaction,op:DeletionOperation,sourceKeys?:ReadonlySet<string>,staleContexts?:ReadonlySet<string>):Closure{
 const deletionSources=new Set(sourceDeletionIds(tx,op));
 const result:Closure={contexts:new Set(staleContexts),requests:new Set(),copies:new Set()};
 if(!supported(op.scope))return result;
 const ds=new Set(sourceKeys?[]:discussions(tx,op).map(d=>String(d.id)));
 const contexts=tx.all('SELECT id,discussion_id,request_id FROM reply_context WHERE owner_id=?',[op.ownerId]);
 const requests=tx.all('SELECT id,discussion_id FROM reply_request WHERE owner_id=?',[op.ownerId]);
 const items=tx.all('SELECT context_id,kind,source_contact_id,record_id,entry_id FROM reply_context_item WHERE owner_id=?',[op.ownerId]);
 const entries=tx.all('SELECT id,origin_request_id FROM discussion_entry WHERE owner_id=?',[op.ownerId]);
 const incorporations=tx.all('SELECT context_id,copy_id,incorporation_no FROM runtime_context WHERE owner_id=?',[op.ownerId]);
 const attempts=tx.all('SELECT id,request_id FROM reply_attempt WHERE owner_id=?',[op.ownerId]);
 const preparing=tx.all("SELECT id,preparing_attempt_id FROM runtime_copy WHERE owner_id=? AND state<>'deleted'",[op.ownerId]);
 const mediaImpact=isMediaDeletionScope(op.scope)?memoryDeletionImpact(tx,op):null;
 const selectedSourceKeys=sourceKeys??(mediaImpact?new Set(mediaImpact.inputs.map(input=>JSON.stringify([input.source_contact_id,input.record_id]))):undefined);
 if(wholeDiscussion(op.scope)){
  for(const c of contexts)if(ds.has(String(c.discussion_id)))result.contexts.add(String(c.id));
  for(const r of requests)if(ds.has(String(r.discussion_id)))result.requests.add(String(r.id));
  for(const c of tx.all("SELECT id,discussion_id FROM runtime_copy WHERE owner_id=? AND state<>'deleted'",[op.ownerId]))if(ds.has(String(c.discussion_id)))result.copies.add(String(c.id));
 }else{
  const scope=op.scope;
  for(const item of items)if(item.kind==='message'&&(selectedSourceKeys?selectedSourceKeys.has(JSON.stringify([item.source_contact_id,item.record_id])):'contactId' in scope&&item.source_contact_id===scope.contactId&&(scope.kind!=='source'||deletionSources.has(String(item.record_id)))))result.contexts.add(String(item.context_id));
 }
 if(tx.get("SELECT 1 FROM sqlite_master WHERE name='reply_candidate_input_source'")){
  const scope=op.scope;
  if(selectedSourceKeys||scope.kind==='source'||scope.kind==='contact_history'||scope.kind==='contact')for(const item of tx.all('SELECT * FROM reply_candidate_input_source WHERE owner_id=?',[op.ownerId]))if(selectedSourceKeys?selectedSourceKeys.has(JSON.stringify([item.source_contact_id,item.record_id])):'contactId' in scope&&item.source_contact_id===scope.contactId&&(scope.kind!=='source'||deletionSources.has(String(item.record_id))))result.contexts.add(String(item.context_id));
  if(mediaImpact){
   const documents=collectMemoryDocumentDeletionReferences(tx,op);
   const version=(raw:unknown):string=>raw&&typeof raw==='object'&&'$integer' in raw?String((raw as {$integer:unknown}).$integer):String(raw);
   for(const item of tx.all("SELECT context_id,kind,identity_json FROM reply_candidate_input WHERE owner_id=? AND kind IN ('memory','memory_candidate','document')",[op.ownerId])){
    const identity=JSON.parse(String(item.identity_json));
    const selected=item.kind==='memory_candidate'?mediaImpact.candidates.includes(String(identity.id)):
     item.kind==='memory'?mediaImpact.memories.includes(String(identity.id))||mediaImpact.versions.some(ref=>ref.memoryId===identity.id&&String(ref.versionNo)===version(identity.versionNo)):
     documents.publications.includes(String(identity.publicationId))||documents.versions.some(ref=>ref.documentId===identity.id&&String(ref.versionNo)===version(identity.versionNo));
    if(selected)result.contexts.add(String(item.context_id));
   }
  }
 }
 // request_tombstone是05同操作持久闭包；清context后仍能找到尚待清理的请求。
 if(!sourceKeys)for(const r of tx.all(`SELECT r.id FROM reply_request r JOIN request_tombstone t ON t.owner_identity=r.owner_id AND t.request_key=r.request_key
  WHERE r.owner_id=? AND t.deletion_operation_id=? AND t.request_namespace GLOB '*:discussion.begin'`,[op.ownerId,op.operationId]))result.requests.add(String(r.id));
 if(!sourceKeys)for(const c of tx.all('SELECT id FROM runtime_copy WHERE owner_id=? AND cleanup_operation_id=?',[op.ownerId,op.operationId]))result.copies.add(String(c.id));
 const carried=tx.get("SELECT 1 FROM sqlite_master WHERE name='reply_candidate_request'")
  ?tx.all('SELECT d.request_id,s.request_id origin_request FROM reply_candidate_request d JOIN reply_selection s ON s.owner_id=d.owner_id AND s.id=d.carried_selection_id WHERE d.owner_id=?',[op.ownerId]):[];
 expandClosure(result,{contexts,items,entries,attempts,preparing,incorporations,carried});
 return result;
}
export interface DiscussionDeletionImpact {contextIds:string[];requestIds:string[];attemptIds:string[];entryIds:string[];runtimeCopyIds:string[];discussionIds:string[];holderKeys:string[]}
/** 07复用的无正文影响清单；与本域完全相同的实际输入及后续复用闭包。 */
export function collectDiscussionDeletionImpact(tx:StorageTransaction,op:DeletionOperation):DiscussionDeletionImpact{
 const affected=closure(tx,op),ids=new Set<string>();
 const requests=tx.all('SELECT id,discussion_id FROM reply_request WHERE owner_id=?',[op.ownerId]).filter(r=>affected.requests.has(String(r.id)));
 const contexts=tx.all('SELECT id,discussion_id FROM reply_context WHERE owner_id=?',[op.ownerId]).filter(c=>affected.contexts.has(String(c.id)));
 const runtime=tx.all('SELECT id,discussion_id FROM runtime_copy WHERE owner_id=?',[op.ownerId]).filter(c=>affected.copies.has(String(c.id)));
 for(const row of [...requests,...contexts,...runtime])ids.add(String(row.discussion_id));
 if(wholeDiscussion(op.scope))for(const d of discussions(tx,op))ids.add(String(d.id));
 return {contextIds:[...affected.contexts].sort(),requestIds:[...affected.requests].sort(),runtimeCopyIds:[...affected.copies].sort(),discussionIds:[...ids].sort(),
  attemptIds:tx.all('SELECT id,request_id FROM reply_attempt WHERE owner_id=?',[op.ownerId]).filter(a=>affected.requests.has(String(a.request_id))).map(a=>String(a.id)).sort(),
  entryIds:tx.all('SELECT id,origin_request_id FROM discussion_entry WHERE owner_id=?',[op.ownerId]).filter(e=>affected.requests.has(String(e.origin_request_id))).map(e=>String(e.id)).sort(),
  holderKeys:[...[...ids].map(id=>`discussion:${id}`),...[...affected.copies].map(id=>`runtime:${id}`)].sort()};
}
function copies(tx:StorageTransaction,op:DeletionOperation):StorageRow[]{
 const ids=closure(tx,op).copies;
 return tx.all("SELECT * FROM runtime_copy WHERE owner_id=? AND state<>'deleted'",[op.ownerId]).filter(c=>ids.has(String(c.id)));
}
const rowKinds={discussion_content:{keys:['owner_id','id'],ownerKey:'owner_id'},reply_context:{keys:['owner_id','id'],ownerKey:'owner_id'},reply_request:{keys:['owner_id','id'],ownerKey:'owner_id'},runtime_barrier:{keys:['owner_id','id'],ownerKey:'owner_id'}};
const holderKeys=(discussionId:string,copyId?:string)=>[`discussion:${discussionId}`,...(copyId?[`runtime:${copyId}`]:[])];
function rowTarget(op:DeletionOperation,rowKind:keyof typeof rowKinds,id:string,discussionId:string,copyId?:string):RowDeletionTarget{
 return {kind:'row',domain:'discussion',rowKind,key:{owner_id:op.ownerId,id},identity:hash([op.ownerId,op.operationId,rowKind,id]),holderKeys:holderKeys(discussionId,copyId)};
}
function fileTarget(op:DeletionOperation,copy:StorageRow,file:StorageRow):FileDeletionTarget{
 return {kind:'file',domain:'discussion',ownerId:op.ownerId,fileId:String(file.file_id),generation:String(copy.write_generation),address:JSON.parse(String(file.address_json)),holderKeys:holderKeys(String(copy.discussion_id),String(copy.id))};
}
function collect(tx:StorageTransaction,op:DeletionOperation):DeletionTarget[]{
 const targets:DeletionTarget[]=[],affected=closure(tx,op);
 // 07先解除通用追踪FK；本域先清context，再在单事务内清entry/attempt/request的闭环。
 for(const c of tx.all('SELECT id,discussion_id FROM reply_context WHERE owner_id=?',[op.ownerId]))if(affected.contexts.has(String(c.id)))targets.push(rowTarget(op,'reply_context',String(c.id),String(c.discussion_id)));
 for(const r of tx.all('SELECT id,discussion_id FROM reply_request WHERE owner_id=?',[op.ownerId]))if(affected.requests.has(String(r.id)))targets.push(rowTarget(op,'reply_request',String(r.id),String(r.discussion_id)));
 if(wholeDiscussion(op.scope))for(const d of discussions(tx,op))if(d.state!=='deleted'||d.title!==null)targets.push(rowTarget(op,'discussion_content',String(d.id),String(d.id)));
 for(const c of copies(tx,op)){
  targets.push(rowTarget(op,'runtime_barrier',String(c.id),String(c.discussion_id),String(c.id)));
  // 活动writer的旧清单不能提前成为文件目标；排空关闭登记完整身份后由05重新收集。
  if(c.manifest_complete===1n)for(const f of tx.all('SELECT * FROM runtime_file WHERE owner_id=? AND copy_id=? AND cleared=0',[op.ownerId,c.id]))targets.push(fileTarget(op,c,f));
 }
 return targets;
}
function requireCopy(tx:StorageTransaction,op:DeletionOperation,id:string):StorageRow{
 const copy=copies(tx,op).find(c=>c.id===id);
 if(!copy||copy.state!=='deleting'||copy.cleanup_operation_id!==op.operationId)fail('discussion_runtime_fence_missing');
 return copy;
}
function requireManifest(tx:StorageTransaction,copy:StorageRow):void{
 if(copy.manifest_complete!==1n)fail('discussion_runtime_manifest_incomplete');
 const files=tx.all('SELECT address_json FROM runtime_file WHERE owner_id=? AND copy_id=?',[copy.owner_id,copy.id]);
 if(copy.address_json!==null&&!files.some(f=>canonical(JSON.parse(String(f.address_json)))===canonical(JSON.parse(String(copy.address_json)))))fail('discussion_runtime_manifest_incomplete');
 if(copy.address_json===null&&files.length)fail('discussion_runtime_manifest_conflict');
}
function removeCopy(tx:StorageTransaction,copy:StorageRow):void{
 tx.run('DELETE FROM runtime_context WHERE owner_id=? AND copy_id=?',[copy.owner_id,copy.id]);
 tx.run('DELETE FROM runtime_file WHERE owner_id=? AND copy_id=?',[copy.owner_id,copy.id]);
 tx.run('DELETE FROM runtime_copy WHERE owner_id=? AND id=?',[copy.owner_id,copy.id]);
}
function requireFile(tx:StorageTransaction,op:DeletionOperation,target:FileDeletionTarget):{copy:StorageRow;file:StorageRow;address:ManagedAddress}{
 if(target.domain!=='discussion'||target.ownerId!==op.ownerId)fail('discussion_deletion_target_invalid');
 const file=tx.get('SELECT * FROM runtime_file WHERE owner_id=? AND file_id=?',[op.ownerId,target.fileId]);
 if(!file)fail('discussion_deletion_target_invalid');
 const copy=requireCopy(tx,op,String(file.copy_id));requireManifest(tx,copy);
 const address=JSON.parse(String(file.address_json)) as ManagedAddress;
 if(target.generation!==String(copy.write_generation)||canonical(address)!==canonical(target.address)||canonical(target.holderKeys)!==canonical(holderKeys(String(copy.discussion_id),String(copy.id))))fail('discussion_deletion_target_invalid');
 if(address.area!=='runtime'||!(address.locator===copy.managed_locator||address.locator.startsWith(`${copy.managed_locator}/`)))fail('discussion_runtime_manifest_conflict');
 if(address.locator===copy.managed_locator&&address.kind!=='directory')fail('discussion_runtime_manifest_conflict');
 if(address.locator===copy.managed_locator&&tx.get('SELECT 1 FROM runtime_file WHERE owner_id=? AND copy_id=? AND file_id<>? AND cleared=0',[op.ownerId,copy.id,target.fileId]))fail('discussion_runtime_children_remain');
 return {copy,file,address};
}
function requireModelContextReleased(tx:StorageTransaction,ownerId:string,contextId:string):void{
 if(tx.get('SELECT 1 FROM model_call WHERE owner_id=? AND reply_context_id=?',[ownerId,contextId])||tx.get('SELECT 1 FROM execution_input WHERE owner_id=? AND reply_context_id=?',[ownerId,contextId]))fail('discussion_model_cleanup_pending');
}
function requireModelRequestReleased(tx:StorageTransaction,ownerId:string,requestId:string):void{
 if(tx.get('SELECT 1 FROM model_operation WHERE owner_id=? AND reply_request_id=?',[ownerId,requestId])
  ||tx.get('SELECT 1 FROM model_call c JOIN reply_attempt a ON a.owner_id=c.owner_id AND a.id=c.reply_attempt_id WHERE a.owner_id=? AND a.request_id=?',[ownerId,requestId])
  ||tx.get('SELECT 1 FROM execution_event e JOIN reply_attempt a ON a.owner_id=e.owner_id AND a.id=e.reply_attempt_id WHERE a.owner_id=? AND a.request_id=?',[ownerId,requestId]))fail('discussion_model_cleanup_pending');
}
export const discussionDeletionRequiredDomains=['discussion_calls','discussion'] as const;
/** 注册次序：07模型/追踪域→本域→identity→skill_metadata。文件I/O始终由05在事务外执行。 */
export const discussionDeletionDomain:DeletionDomain={
 id:'discussion',rowKinds,
 fence(tx,op){
  if(!supported(op.scope))return [];
  const affected=closure(tx,op),invalidated:{namespace:string;key:string}[]=[];
  for(const requestId of affected.requests){
   const request=tx.get('SELECT request_key FROM reply_request WHERE owner_id=? AND id=?',[op.ownerId,requestId]);
   if(!request)continue;
   if(tx.get("SELECT 1 FROM request_tombstone WHERE owner_identity=? AND request_key=? AND request_namespace GLOB '*:discussion.begin' AND deletion_operation_id IS NOT ?",[op.ownerId,request.request_key,op.operationId]))fail('discussion_request_cleanup_conflict');
   invalidated.push({namespace:'discussion.begin',key:String(request.request_key)});
   tx.run("UPDATE reply_attempt SET state='invalidated',lease_token=?,finished_at=COALESCE(finished_at,?),error_code='source_deleted' WHERE owner_id=? AND request_id=? AND state<>'invalidated'",[hash([op.operationId,requestId]),Date.now(),op.ownerId,requestId]);
   tx.run("UPDATE reply_request SET state='invalidated' WHERE owner_id=? AND id=?",[op.ownerId,requestId]);
   tx.run("UPDATE discussion_entry SET body=NULL,content_state='cleared',origin_call_id=NULL,origin_event_id=NULL WHERE owner_id=? AND origin_request_id=? AND content_state='available'",[op.ownerId,requestId]);
  }
  for(const id of affected.contexts)tx.run("UPDATE reply_context SET state='invalidated' WHERE owner_id=? AND id=?",[op.ownerId,id]);
  if(wholeDiscussion(op.scope))for(const d of discussions(tx,op)){
   if(d.state==='active')tx.run("UPDATE assistant_discussion SET state='deleting',generation=generation+1,current_runtime_id=NULL,is_current=0 WHERE owner_id=? AND id=?",[op.ownerId,d.id]);
   else tx.run('UPDATE assistant_discussion SET current_runtime_id=NULL,is_current=0 WHERE owner_id=? AND id=?',[op.ownerId,d.id]);
  }
  for(const c of copies(tx,op)){
   // 未提交Skill运行的技术清理没有独立删除授权；正式删除接管其已冻结清单与逐项进度。
   const skillDiscard=c.state==='blocked'&&c.committed_request_id===null&&c.committed_event_boundary===null
    &&c.manifest_complete===1n&&typeof c.preparing_attempt_id==='string'&&c.preparing_attempt_id.length>0
    &&c.cleanup_operation_id==='skill-discard:'+c.preparing_attempt_id;
   if(c.cleanup_operation_id!==null&&c.cleanup_operation_id!==op.operationId&&!skillDiscard)fail('discussion_runtime_cleanup_conflict');
   tx.run("UPDATE assistant_discussion SET current_runtime_id=NULL WHERE owner_id=? AND current_runtime_id=?",[op.ownerId,c.id]);
   tx.run("UPDATE runtime_copy SET state='deleting',cleanup_operation_id=?,committed_request_id=NULL,committed_event_boundary=NULL,configuration_digest=NULL,preparing_attempt_id=NULL WHERE owner_id=? AND id=?",[op.operationId,op.ownerId,c.id]);
   tx.run("UPDATE runtime_context SET provenance_state='invalidated' WHERE owner_id=? AND copy_id=?",[op.ownerId,c.id]);
  }
  return invalidated;
 },
 collect,
 clearRow(tx,op,target){
  if(target.domain!=='discussion'||target.key.owner_id!==op.ownerId||!Object.hasOwn(rowKinds,target.rowKind)||target.identity!==hash([op.ownerId,op.operationId,target.rowKind,target.key.id]))fail('discussion_deletion_target_invalid');
  const current=collect(tx,op).find(t=>t.kind==='row'&&t.rowKind===target.rowKind&&t.identity===target.identity&&canonical(t.key)===canonical(target.key));
  if(!current)return;
  if(target.rowKind==='discussion_content'){
   tx.run("UPDATE assistant_discussion SET state='deleted',title=NULL,current_runtime_id=NULL,is_current=0 WHERE owner_id=? AND id=?",[op.ownerId,target.key.id]);
  }else if(target.rowKind==='reply_context'){
   requireModelContextReleased(tx,op.ownerId,target.key.id);
   tx.run('DELETE FROM runtime_context WHERE owner_id=? AND context_id=?',[op.ownerId,target.key.id]);
   tx.run('DELETE FROM reply_context_item WHERE owner_id=? AND context_id=?',[op.ownerId,target.key.id]);
   tx.run('DELETE FROM reply_context WHERE owner_id=? AND id=?',[op.ownerId,target.key.id]);
  }else if(target.rowKind==='reply_request'){
   requireModelRequestReleased(tx,op.ownerId,target.key.id);
   if(tx.get('SELECT 1 FROM reply_context WHERE owner_id=? AND request_id=?',[op.ownerId,target.key.id]))fail('discussion_context_cleanup_pending');
   tx.run('DELETE FROM discussion_entry WHERE owner_id=? AND origin_request_id=?',[op.ownerId,target.key.id]);
   tx.run('DELETE FROM reply_attempt WHERE owner_id=? AND request_id=?',[op.ownerId,target.key.id]);
   tx.run('DELETE FROM reply_request WHERE owner_id=? AND id=?',[op.ownerId,target.key.id]);
  }else{
   const copy=requireCopy(tx,op,target.key.id);requireManifest(tx,copy);
   if(!tx.get('SELECT 1 FROM runtime_file WHERE owner_id=? AND copy_id=? AND cleared=0',[op.ownerId,copy.id]))removeCopy(tx,copy);
  }
 },
 authorizeFile(tx,op,target){requireFile(tx,op,target);},
 fileCleared(tx,op,target){
  const {copy}=requireFile(tx,op,target);
  tx.run('UPDATE runtime_file SET cleared=1 WHERE owner_id=? AND file_id=?',[op.ownerId,target.fileId]);
  if(!tx.get('SELECT 1 FROM runtime_file WHERE owner_id=? AND copy_id=? AND cleared=0',[op.ownerId,copy.id]))removeCopy(tx,copy);
 },
 verify(tx,op){
  if(!supported(op.scope)){const na:CheckResult={result:'not_applicable',proof:'discussion_scope_not_applicable'};return {database_rows:na,derived_eligibility:na,trace_payloads:na,request_replay:na,scope_suppression:na};}
  const empty=collect(tx,op).length===0;
  const checked:CheckResult=empty?pass('discussion_payloads_and_copies_cleared'):{result:'blocked',proof:'discussion_payloads_or_copies_remain'};
  const affected=closure(tx,op),fenced=(!wholeDiscussion(op.scope)||discussions(tx,op).every(d=>d.state!=='active'))&&affected.requests.size===0;
  return {database_rows:checked,derived_eligibility:checked,trace_payloads:checked,
   request_replay:fenced?pass('discussion_generations_fenced'):{result:'blocked',proof:'discussion_writer_remains'},
   scope_suppression:{result:'not_applicable',proof:'discussion_deletion_does_not_grant_or_restore_chat_reading'}};
 },
};
