import {randomUUID} from 'node:crypto';
import {StorageFailure,type StorageAction,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {readCoverage} from '../../../history/sqlite/read.ts';
import {discussionRequestActions,requireAttempt} from '../requests.ts';
import {discussionModelActions} from '../model-actions.ts';
import {requireDiscussion} from '../actions.ts';
import {emptyReplyKnowledge,type ReplyKnowledgeReader} from './contracts.ts';
import {freezeReplyInput,requireReplyInput,requireSelection} from './input.ts';
import {insertModelCandidates,parseReplyOutput,readParts,requireCandidate,versionView} from './versions.ts';
export const INCOMPLETE_HISTORY_WARNING='历史覆盖不完整：本次仅使用已同步部分，可能缺少重要语境。';
function fail(code:string):never{throw new StorageFailure(code);}
export function requireReplyCoverage(tx:StorageTransaction,ownerId:string,contactId:string,acceptIncomplete:boolean){
 const coverage=readCoverage(tx,ownerId,contactId);
 if(coverage.phase==='not_started'||coverage.phase==='running')fail('reply_history_syncing');
 if(coverage.phase==='incomplete'&&!acceptIncomplete)fail('reply_history_incomplete');
 return {coverage,warning:coverage.phase==='incomplete'?INCOMPLETE_HISTORY_WARNING:null};
}
const begin=discussionRequestActions.find((a):a is Extract<StorageAction,{mode:'read'|'write'}>=>a.name==='discussion.begin'&&a.mode!=='maintenance')!;
const freeze=discussionRequestActions.find((a):a is Extract<StorageAction,{mode:'read'|'write'}>=>a.name==='discussion.freezeContext'&&a.mode!=='maintenance')!;
const commit=discussionModelActions.find((a):a is Extract<StorageAction,{mode:'read'|'write'}>=>a.name==='discussion.commitAssistant'&&a.mode!=='maintenance')!;
/** 只由受信任注册表安装正式08/09消费者；HTTP不能指定适配器。 */
export function createReplyCandidateActions(reader:ReplyKnowledgeReader=emptyReplyKnowledge):StorageAction[]{
 const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any,lease:any)=>unknown):StorageAction=>({name:`reply.${name}`,mode,retryBusy:mode==='write',execute});
 return [
 action('begin','write',(tx,i,lease)=>{
  const {coverage,warning}=requireReplyCoverage(tx,i.ownerId,i.contactId,i.acceptIncomplete===true);
  if(i.carriedSelectionId)requireSelection(tx,i,i.carriedSelectionId,reader);
  const accepted=begin.execute(tx,{...i,kind:'reply',discussionId:randomUUID(),requestId:randomUUID(),entryId:randomUUID(),attemptId:randomUUID(),leaseToken:randomUUID()},lease) as any;
  const old=tx.get('SELECT * FROM reply_candidate_request WHERE owner_id=? AND request_id=?',[i.ownerId,accepted.attempt.requestId]);
  if(accepted.replayed){if(!old||old.carried_selection_id!==(i.carriedSelectionId??null)||old.coverage_warning!==warning)fail('reply_request_conflict');}
  else{
   if(i.carriedSelectionId&&accepted.attempt.discussionId!==i.discussionId)fail('reply_selection_scope');
   tx.run('INSERT INTO reply_candidate_request VALUES(?,?,?,?,?)',[i.ownerId,accepted.attempt.requestId,JSON.stringify(coverage),warning,i.carriedSelectionId??null]);
  }
  return {...accepted,coverageWarning:warning};
 }),
 action('freezeInput','write',(tx,i,lease)=>{
  const details=tx.get('SELECT * FROM reply_candidate_request WHERE owner_id=? AND request_id=?',[i.ownerId,i.requestId])??fail('reply_request_unavailable');
  requireReplyCoverage(tx,i.ownerId,i.contactId,details.coverage_warning!==null);
  freeze.execute(tx,i,lease);return freezeReplyInput(tx,i,reader);
 }),
 action('assertInput','read',(tx,i)=>{requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader);return true;}),
 action('commitCandidates','write',(tx,i,lease)=>{
  requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader);parseReplyOutput(i.text);
  // 沿11真实调用结算合同；结构化候选不另存为可读讨论发言。
  const result=commit.execute(tx,i,lease);
  insertModelCandidates(tx,i);
  tx.run("DELETE FROM discussion_entry WHERE owner_id=? AND origin_call_id=? AND role='assistant'",[i.ownerId,i.callId]);
  return result;
 }),
 action('view','read',(tx,i)=>{
  requireDiscussion(tx,i);
  const requests=tx.all(`SELECT r.id,d.coverage_warning FROM reply_request r JOIN reply_candidate_request d ON d.owner_id=r.owner_id AND d.request_id=r.id WHERE r.owner_id=? AND r.contact_id=? AND r.discussion_id=? AND r.state='committed' ORDER BY r.rowid`,[i.ownerId,i.contactId,i.discussionId]);
  return requests.map(r=>{
   const candidates=tx.all('SELECT id FROM reply_candidate WHERE owner_id=? AND request_id=? ORDER BY candidate_no',[i.ownerId,r.id]).map(k=>{
    try{const v=requireCandidate(tx,{...i,candidateId:String(k.id)},reader);return versionView(tx,i.ownerId,String(k.id),v.version.version_no as bigint);}catch{return null;}
   }).filter(Boolean);
   return {...i,requestId:r.id,coverageWarning:r.coverage_warning,candidates,selections:candidates.length?tx.all('SELECT * FROM reply_selection WHERE owner_id=? AND request_id=? ORDER BY selection_no',[i.ownerId,r.id]).map(s=>({id:s.id,candidateId:s.candidate_id,versionNo:Number(s.version_no),selectionNo:Number(s.selection_no)})):[]};
  });
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
