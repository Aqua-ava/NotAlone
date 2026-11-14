import {hasReplyDocumentTool,readReplyDocument} from './document-input.ts';
import {initializeReplySearch,hasReplySearchScope,beginReplySearch,finishReplySearch} from './search.ts';
import {randomUUID} from 'node:crypto';
import {withReplyValidation} from './validation.ts';
import {StorageFailure,type StorageAction,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {readCoverage} from '../../../history/sqlite/read.ts';
import {discussionRequestActions,requireAttempt,decode} from '../requests.ts';
import {discussionModelActions,dropSkillForCurrentCall,requireDiscussionCall} from '../model-actions.ts';
import {requireDiscussion} from '../actions.ts';
import {sanitizeDiscussionErrorCode} from '../failure.ts';
import {emptyReplyKnowledge,type ReplyKnowledgeItem,type ReplyKnowledgeReader} from './contracts.ts';
import {freezeReplyInput,requireReplyInput,requireSelection,replySourceContacts,selectionSourceContacts} from './input.ts';
import {insertModelCandidates,parseReplyOutput,readParts,requireCandidate,versionView} from './versions.ts';
import {readInputMaterials} from './input-materials.ts';
export const INCOMPLETE_HISTORY_WARNING='历史覆盖不完整：本次使用当前可用资料，可能缺少重要语境。';
function fail(code:string):never{throw new StorageFailure(code);}
function storedWorkspaceFingerprint(value:string):string|null{const parsed=JSON.parse(value);return parsed?.kind==='reply_candidate_request_v1'&&typeof parsed.workspaceFingerprint==='string'?parsed.workspaceFingerprint:null;}
function revisionNumber(value:unknown):number{const n=Number((value as {$integer?:unknown})?.$integer??value);return Number.isSafeInteger(n)&&n>0?n:0;}
/** 只从真实 skill_input 事件投影已预加载身份和实际进入模型的正文/资源。 */
function skillViews(tx:StorageTransaction,ownerId:string,requestId:string,includeText=true){
 const rows=tx.all("SELECT e.payload FROM execution_event e JOIN reply_attempt a ON a.owner_id=e.owner_id AND a.id=e.reply_attempt_id WHERE e.owner_id=? AND a.request_id=? AND e.kind='skill_input' ORDER BY e.event_no",[ownerId,requestId]).map(e=>JSON.parse(String(e.payload)));
 const loaded=rows.map(p=>{
  const storedName=typeof p.name==='string'&&p.name?p.name:null;
  const name=storedName??tx.get('SELECT display_name FROM skill_package WHERE owner_id=? AND id=?',[ownerId,p.loaded.packageId])?.display_name;
  const origin=p.preload&&['explicit','auto_preload'].includes(p.preload.origin)?p.preload.origin:null;
  const catalogRevision=p.preload&&typeof p.preload.catalogRevision==='string'?p.preload.catalogRevision:null;
  return {packageId:String(p.loaded.packageId),...(name?{name:String(name)}:{}),revisionNo:revisionNumber(p.loaded.revisionNo),relativePath:String(p.relativePath),...(includeText?{text:String(p.text)}:{}),origin,catalogRevision};
 });
 const preloaded=loaded.filter((skill,index)=>rows[index].relativePath==='SKILL.md'&&rows[index].preload&&skill.origin!==null&&skill.catalogRevision!==null).map(skill=>({packageId:skill.packageId,...(skill.name?{name:skill.name}:{}),revisionNo:skill.revisionNo,origin:skill.origin!,catalogRevision:skill.catalogRevision!}));
 return {loadedSkills:loaded,preloadedSkills:preloaded};
}
export const SKILL_DETAIL_PAGE_MAX_BYTES=1_500_000;
function skillInputPage(tx:StorageTransaction,ownerId:string,requestId:string,offset:number){
 const all=skillViews(tx,ownerId,requestId,true).loadedSkills,items:unknown[]=[];let bytes=0;
 for(let index=offset;index<all.length;index++){
  const item=all[index],size=Buffer.byteLength(JSON.stringify(item),'utf8');
  if(size>SKILL_DETAIL_PAGE_MAX_BYTES)fail('reply_skill_page_too_large');
  if(items.length&&bytes+size+1>SKILL_DETAIL_PAGE_MAX_BYTES)break;
  items.push(item);bytes+=size+1;
 }
 return {items,nextOffset:offset+items.length<all.length?offset+items.length:null,total:all.length};
}
function requestCoverageJson(coverage:unknown,workspaceFingerprint:unknown):string{
 if(workspaceFingerprint===undefined)return JSON.stringify(coverage);
 if(typeof workspaceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(workspaceFingerprint))fail('reply_input_invalid');
 return JSON.stringify({kind:'reply_candidate_request_v1',coverage,workspaceFingerprint});
}
function snapshotReplyCoverage(tx:StorageTransaction,ownerId:string,contactId:string){
 const coverage=readCoverage(tx,ownerId,contactId);
 return {coverage,warning:coverage.phase!=='complete'?INCOMPLETE_HISTORY_WARNING:null};
}
const begin=discussionRequestActions.find((a):a is Extract<StorageAction,{mode:'read'|'write'}>=>a.name==='discussion.begin'&&a.mode!=='maintenance')!;
const freeze=discussionRequestActions.find((a):a is Extract<StorageAction,{mode:'read'|'write'}>=>a.name==='discussion.freezeContext'&&a.mode!=='maintenance')!;
const commit=discussionModelActions.find((a):a is Extract<StorageAction,{mode:'read'|'write'}>=>a.name==='discussion.commitAssistant'&&a.mode!=='maintenance')!;
const dispatch=discussionModelActions.find((a):a is Extract<StorageAction,{mode:'read'|'write'}>=>a.name==='discussion.dispatchCall'&&a.mode!=='maintenance')!;
/** 只由受信任注册表安装正式08/09消费者；HTTP不能指定适配器。 */
export function createReplyCandidateActions(reader:ReplyKnowledgeReader=emptyReplyKnowledge):StorageAction[]{
 const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any,lease:any)=>unknown):StorageAction=>({name:`reply.${name}`,mode,retryBusy:mode==='write',execute:(tx,i,lease)=>withReplyValidation(tx,scoped=>execute(scoped,i,lease))});
 return [
 action('status','read',(tx,i)=>{
  requireDiscussion(tx,i);
  if(typeof i.requestKey!=='string'||!/^[a-f0-9-]{36}$/.test(i.requestKey))fail('reply_input_invalid');
  const row=tx.get(`SELECT r.id,r.state request_state,a.id attempt_id,a.state attempt_state,a.started_at,a.finished_at,a.error_code FROM reply_request r LEFT JOIN reply_attempt a ON a.owner_id=r.owner_id AND a.request_id=r.id WHERE r.owner_id=? AND r.contact_id=? AND r.discussion_id=? AND r.request_key=? AND r.kind='reply' ORDER BY a.attempt_no DESC LIMIT 1`,[i.ownerId,i.contactId,i.discussionId,i.requestKey]);
  if(!row)return {requestKey:i.requestKey,phase:'not_found',sent:false,abandoned:false,errorCode:null,retryable:false,startedAt:null,finishedAt:null};
  const calls=tx.all('SELECT state,sent_at,error_code FROM model_call WHERE owner_id=? AND reply_attempt_id=?',[i.ownerId,row.attempt_id]);
  // 已放弃专指“已发出但未收到结果”的未知调用；已收到响应的失败同样 sent，却不是被放弃的。
  const sent=calls.some(c=>c.sent_at!==null),abandoned=calls.some(c=>c.error_code==='unknown_abandoned'),unknown=calls.some(c=>c.state==='unknown'),running=row.request_state==='running'&&row.attempt_state==='running';
  const phase=unknown?'unknown':row.request_state==='committed'?'committed':running?'preparing':'failed';
  return {requestKey:i.requestKey,phase,sent,abandoned,errorCode:row.error_code===null?null:sanitizeDiscussionErrorCode(row.error_code),retryable:phase==='failed'&&!calls.some(c=>['sending','unknown'].includes(String(c.state))),startedAt:row.started_at===null?null:Number(row.started_at),finishedAt:row.finished_at===null?null:Number(row.finished_at)};
 }),
 action('failPreparation','write',(tx,i,lease)=>{
  // 仅结束原运行中且尚未创建模型调用的任务；来源变化不能让失败永远停在准备中。
  const attempt=tx.get(`SELECT a.id FROM reply_attempt a JOIN reply_request r ON r.owner_id=a.owner_id AND r.id=a.request_id
   WHERE a.owner_id=? AND a.id=? AND a.request_id=? AND a.lease_token=? AND r.contact_id=? AND r.discussion_id=?
   AND a.accepted_runtime_id=? AND a.accepted_storage_epoch=? AND a.state='running' AND r.state='running'`,[i.ownerId,i.attemptId,i.requestId,i.leaseToken,i.contactId,i.discussionId,lease.runtimeId,lease.epoch]);
  if(!attempt)return;
  if(tx.get('SELECT 1 FROM model_call WHERE owner_id=? AND reply_attempt_id=?',[i.ownerId,i.attemptId]))return;
  tx.run("UPDATE reply_attempt SET state='failed',finished_at=?,error_code=? WHERE owner_id=? AND id=?",[Date.now(),sanitizeDiscussionErrorCode(i.code),i.ownerId,i.attemptId]);
  tx.run("UPDATE reply_request SET state='cancelled' WHERE owner_id=? AND id=?",[i.ownerId,i.requestId]);
 }),
 action('begin','write',(tx,i,lease)=>{
  const {coverage,warning:capturedWarning}=snapshotReplyCoverage(tx,i.ownerId,i.contactId),warning=i.includeRelationshipContext===false?null:capturedWarning;
  const coverageJson=requestCoverageJson(coverage,i.workspaceFingerprint);
  if(i.carriedSelectionId)requireSelection(tx,i,i.carriedSelectionId,reader);
  const accepted=begin.execute(tx,{...i,kind:'reply',discussionId:randomUUID(),requestId:randomUUID(),entryId:randomUUID(),attemptId:randomUUID(),leaseToken:randomUUID()},lease) as any;
  const old=tx.get('SELECT * FROM reply_candidate_request WHERE owner_id=? AND request_id=?',[i.ownerId,accepted.attempt.requestId]);
  if(accepted.replayed){if(!old||old.carried_selection_id!==(i.carriedSelectionId??null))fail('reply_request_conflict');if(storedWorkspaceFingerprint(String(old.coverage_json))!==(i.workspaceFingerprint??null))fail('discussion_request_conflict');}
  else{
   if(i.carriedSelectionId&&accepted.attempt.discussionId!==i.discussionId)fail('reply_selection_scope');
   tx.run('INSERT INTO reply_candidate_request VALUES(?,?,?,?,?)',[i.ownerId,accepted.attempt.requestId,coverageJson,warning,i.carriedSelectionId??null]);
  }
  return {...accepted,coverageWarning:accepted.replayed?old!.coverage_warning:warning};
 }),
 action('freezeInput','write',(tx,i,lease)=>{
  // 使用本次受理时冻结的覆盖事实，后台同步进展不阻断或改写当前请求。
  freeze.execute(tx,i,lease);const inputs=freezeReplyInput(tx,i,reader);
  if(!i.workspace||i.workspace.includeRelationshipContext)initializeReplySearch(tx,i,reader);
  return inputs;
 }),
 action('searchAvailable','read',(tx,i)=>hasReplySearchScope(tx,i,reader)),
 action('beginSearch','write',(tx,i)=>beginReplySearch(tx,i,reader)),
 action('finishSearch','write',(tx,i)=>finishReplySearch(tx,i,reader)),
 action('sourceContacts','read',(tx,i)=>{requireAttempt(tx,i);return replySourceContacts(tx,i,reader);}),
 action('selectionSourceContacts','read',(tx,i)=>{requireDiscussion(tx,i);return selectionSourceContacts(tx,i);}),
 action('configuration','read',(tx,i)=>{
  const d=requireDiscussion(tx,i);if(!d.current_runtime_id)return null;
  const row=tx.get("SELECT r.id,c.id context_id,c.skill_run_json FROM runtime_copy x JOIN reply_request r ON r.owner_id=x.owner_id AND r.id=x.committed_request_id JOIN reply_context c ON c.owner_id=r.owner_id AND c.request_id=r.id WHERE x.owner_id=? AND x.id=? AND r.kind='reply' AND r.state='committed' AND c.state='active'",[i.ownerId,d.current_runtime_id]);
  if(!row)return null;requireReplyInput(tx,i,String(row.context_id),reader);return {requestId:String(row.id),revision:decode(String(row.skill_run_json))};
 }),
 action('documentToolAvailable','read',(tx,i)=>hasReplyDocumentTool(tx,i,reader)),
 action('readDocument','write',(tx,i)=>readReplyDocument(tx,i,reader)),
 action('assertInput','read',(tx,i)=>{requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader);return true;}),
 action('assertInputWithoutSkill','read',(tx,i)=>{requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader,{ignoreSkill:true});return true;}),
 action('dispatchCall','write',(tx,i,lease)=>{requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader);return dispatch.execute(tx,i,lease);}),
 action('dropSkill','write',(tx,i)=>{
  requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader,{ignoreSkill:true});
  const result=dropSkillForCurrentCall(tx,i);
  // 新运行副本没有旧工具事件；把仍保留并计入预算的实际正文重新放入输入。
  const retrievedInputs=tx.all('SELECT item_no,kind,identity_json,text_body FROM reply_candidate_input WHERE owner_id=? AND context_id=? ORDER BY item_no',[i.ownerId,result.contextId])
   .filter(row=>row.kind==='memory'||row.kind==='message'&&decode<{retrieved?:boolean}>(String(row.identity_json)).retrieved===true||row.kind==='document'&&decode<ReplyKnowledgeItem>(String(row.identity_json)).projection?.kind==='blocks')
   .map(row=>({itemNo:Number(row.item_no),kind:String(row.kind),text:String(row.text_body)}));
  return {...result,retrievedInputs};
 }),
 action('commitCandidates','write',(tx,i,lease)=>{
  requireDiscussionCall(tx,i);requireReplyInput(tx,i,i.contextId,reader);parseReplyOutput(i.text);
  // 沿11真实调用结算合同；结构化候选不另存为可读讨论发言。
  const result=commit.execute(tx,i,lease);
  insertModelCandidates(tx,i);
  tx.run("DELETE FROM discussion_entry WHERE owner_id=? AND origin_call_id=? AND role='assistant'",[i.ownerId,i.physicalCallId??i.callId]);
  return result;
 }),
 action('view','read',(tx,i)=>{
  requireDiscussion(tx,i);
  if(i.includeSkillText!==undefined&&typeof i.includeSkillText!=='boolean')fail('reply_input_invalid');
  if(i.limit!==undefined&&(!Number.isSafeInteger(i.limit)||i.limit<1||i.limit>21))fail('reply_input_invalid');
  const requests=tx.all(`SELECT id,state,coverage_warning FROM (SELECT r.rowid request_rowid,r.id,r.state,d.coverage_warning FROM reply_request r JOIN reply_candidate_request d ON d.owner_id=r.owner_id AND d.request_id=r.id WHERE r.owner_id=? AND r.contact_id=? AND r.discussion_id=? ORDER BY r.rowid DESC LIMIT ?) ORDER BY request_rowid`,[i.ownerId,i.contactId,i.discussionId,i.limit??-1]);
  return requests.map(r=>{
   const candidates=tx.all('SELECT id FROM reply_candidate WHERE owner_id=? AND request_id=? ORDER BY candidate_no',[i.ownerId,r.id]).map(k=>{
    try{const v=requireCandidate(tx,{...i,candidateId:String(k.id)},reader);return versionView(tx,i.ownerId,String(k.id),v.version.version_no as bigint);}catch{return null;}
   }).filter(Boolean);
   const skills=candidates.length?skillViews(tx,i.ownerId,String(r.id),i.includeSkillText!==false):{loadedSkills:[],preloadedSkills:[]};
   const latest=tx.get('SELECT error_code FROM reply_attempt WHERE owner_id=? AND request_id=? ORDER BY attempt_no DESC LIMIT 1',[i.ownerId,r.id]);
   const generationErrorCode=latest?.error_code==null?null:sanitizeDiscussionErrorCode(latest.error_code);
   const generationSent=!!tx.get('SELECT 1 FROM model_call c JOIN reply_attempt a ON a.owner_id=c.owner_id AND a.id=c.reply_attempt_id WHERE a.owner_id=? AND a.request_id=? AND c.sent_at IS NOT NULL LIMIT 1',[i.ownerId,r.id]);
   const generationAbandoned=!!tx.get("SELECT 1 FROM model_call c JOIN reply_attempt a ON a.owner_id=c.owner_id AND a.id=c.reply_attempt_id WHERE a.owner_id=? AND a.request_id=? AND c.error_code='unknown_abandoned' LIMIT 1",[i.ownerId,r.id]);
   return {...i,requestId:r.id,generationErrorCode,generationSent,generationAbandoned,generationState:tx.get("SELECT 1 FROM model_call c JOIN reply_attempt a ON a.owner_id=c.owner_id AND a.id=c.reply_attempt_id WHERE a.owner_id=? AND a.request_id=? AND c.state='unknown'",[i.ownerId,r.id])?'unknown':r.state==='cancelled'?'failed':r.state,coverageWarning:r.coverage_warning,skillWarning:candidates.length&&tx.get("SELECT 1 FROM execution_event e JOIN reply_attempt a ON a.owner_id=e.owner_id AND a.id=e.reply_attempt_id WHERE e.owner_id=? AND a.request_id=? AND e.kind='skill_unavailable'",[i.ownerId,r.id])?'回复策略暂不可用':null,candidates,sourceState:candidates.length?'available':'unavailable',loadedSkills:skills.loadedSkills,preloadedSkills:skills.preloadedSkills,selections:candidates.length?tx.all('SELECT * FROM reply_selection WHERE owner_id=? AND request_id=? ORDER BY selection_no',[i.ownerId,r.id]).map(s=>({id:s.id,candidateId:s.candidate_id,versionNo:Number(s.version_no),selectionNo:Number(s.selection_no)})):[]};
  });
 }),
 action('inputs','read',(tx,i)=>readInputMaterials(tx,i,reader)),
 action('skillInputs','read',(tx,i)=>{
  requireDiscussion(tx,i);
  if(typeof i.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(i.requestId)||!Number.isSafeInteger(i.offset)||i.offset<0||i.offset>1_000_000)fail('reply_input_invalid');
  const request=tx.get("SELECT 1 FROM reply_request WHERE owner_id=? AND id=? AND contact_id=? AND discussion_id=? AND kind='reply' AND state='committed'",[i.ownerId,i.requestId,i.contactId,i.discussionId])??fail('reply_candidate_unavailable');
  const candidate=tx.get('SELECT id FROM reply_candidate WHERE owner_id=? AND request_id=? ORDER BY candidate_no LIMIT 1',[i.ownerId,i.requestId]);
  if(!candidate)return {items:[],nextOffset:null,total:0};
  requireCandidate(tx,{...i,candidateId:String(candidate.id)},reader);
  return skillInputPage(tx,i.ownerId,i.requestId,i.offset);
 }),
 action('version','read',(tx,i)=>{const v=requireCandidate(tx,i,reader);return versionView(tx,i.ownerId,i.candidateId,v.version.version_no as bigint);}),
 action('edit','write',(tx,i)=>{
  const {version}=requireCandidate(tx,i,reader),parts=readParts(i.parts);
  const head=tx.get('SELECT MAX(version_no) n FROM reply_candidate_version WHERE owner_id=? AND candidate_id=?',[i.ownerId,i.candidateId])!.n as bigint;
  if(!Number.isSafeInteger(i.versionNo)||version.version_no!==head)fail('reply_version_stale');
  const next=head+1n;
  tx.run("INSERT INTO reply_candidate_version VALUES(?,?,?,'manual',?,NULL,NULL,'available',?)",[i.ownerId,i.candidateId,next,head,parts.length]);
  for(const [index,part] of parts.entries())tx.run('INSERT INTO reply_version_part VALUES(?,?,?,?,?)',[i.ownerId,i.candidateId,next,index+1,part]);
  tx.run("INSERT INTO reply_basis SELECT owner_id,candidate_id,?,basis_no,context_id,item_no,'inherited_unverified' FROM reply_basis WHERE owner_id=? AND candidate_id=? AND version_no=?",[next,i.ownerId,i.candidateId,head]);
  return versionView(tx,i.ownerId,i.candidateId,next);
 }),
 action('select','write',(tx,i)=>{
  const {candidate,version}=requireCandidate(tx,i,reader);
  if(!Number.isSafeInteger(i.versionNo)||version.version_no!==BigInt(i.versionNo))fail('reply_version_stale');
  const selectionNo=tx.get('SELECT COALESCE(MAX(selection_no),0)+1 n FROM reply_selection WHERE owner_id=? AND request_id=?',[i.ownerId,candidate.request_id])!.n;
  const id=randomUUID();tx.run('INSERT INTO reply_selection VALUES(?,?,?,?,?,?,?)',[i.ownerId,id,candidate.request_id,selectionNo,i.candidateId,i.versionNo,Date.now()]);
  return {id,candidateId:i.candidateId,versionNo:i.versionNo,selectionNo:Number(selectionNo)};
 }),
 ];
}
export const replyCandidateActions=createReplyCandidateActions();
