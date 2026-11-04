import type {BackendHost} from '../backend/host';
import type {ContactSession} from '../contacts/session';
import type {PageCommands} from '../page-commands';
import {readSqliteCandidateOperation,readSqliteCandidatePage,readSqliteCandidateSkillPage,readSqliteCandidateVersion,readSqliteCandidateStatus,type SqliteCandidateOperation} from '../../shared/sqlite-reply-candidates';
import type {SqliteDiscussionController} from './sqlite-discussion-bridge';
const messages:Record<string,string>={reply_page_too_large:'本次候选记录超出可显示范围，请先处理较早记录后重试。',reply_skill_page_too_large:'本次Skill输入超出可显示范围。',reply_sources_not_ready:'聊天读取暂未恢复，请重试生成。',memory_knowledge_stale:'资料版本已变化，请重新读取。',skill_run_invalidated:'本次Skill资格已失效，请重新读取。',history_source_not_available:'本次候选来源已失效，请重新读取。',discussion_source_unavailable:'本次候选来源已失效，请重新读取。',reply_selection_unavailable:'原选稿来源已失效，请重新读取。',reply_knowledge_unavailable:'资料资格已失效，请重新读取。',discussion_generation_failed:'本次生成未完成，结果可能未知；请使用原请求核对。',reply_history_syncing:'历史状态已变化，请重新读取当前会话后重试。',reply_history_incomplete:'历史状态已变化，请重新读取当前会话后重试。',reply_model_unavailable:'现有模型配置尚未就绪。',discussion_model_unavailable:'现有模型配置尚未就绪。',discussion_call_unknown:'已有模型调用结果未知，请先核对原请求，不能换请求重发。',discussion_request_conflict:'本次输入或设置已改变，请用新请求重新生成。',reply_input_invalid:'本次工作区设置无效，请检查本次想法和背景内容。',reply_input_stale:'资料版本已变化，请重新读取。',reply_source_unavailable:'本次候选来源已失效，请重新读取。',reply_content_unavailable:'这版正文已不可用。',reply_version_stale:'候选已被更新，请先读取最新版本。',reply_candidate_unavailable:'候选来源已失效，请重新读取。',discussion_request_stale:'原请求已失效，请重新读取。'};
/** 仅当前连接、联系人和助手讨论可操作；失效先取消等待，迟到结果不穿过IPC。 */
export function installSqliteReplyCandidateCommands(commands:PageCommands,backend:Pick<BackendHost,'requestJson'|'getConnectionGeneration'>,contacts:Pick<ContactSession,'getState'>,discussion:SqliteDiscussionController,isContactConfirmed:()=>boolean=()=>true):void{
 let revision=0;const active=new Set<AbortController>();
 discussion.onInvalidated(()=>{++revision;for(const c of active)c.abort();active.clear();});
 commands.handle('sqlite-reply-candidates:execute',async(...args)=>{
  if(args.length!==1)throw new Error('本次候选操作无效。');const op=readSqliteCandidateOperation(args[0]);
  discussion.synchronize();const boundary=revision,generation=backend.getConnectionGeneration();
  const current=()=>{discussion.synchronize();if(!isContactConfirmed())throw new Error('请先确认本次联系人。');const state=contacts.getState();if(boundary!==revision||generation===undefined||backend.getConnectionGeneration()!==generation||state.directoryPhase!=='ready'||state.selectedContactId!==op.contactId||state.scopeRevision!==op.scopeRevision||!state.contacts.some(c=>c.contactId===op.contactId))throw new Error('联系人或来源范围已失效，请重新读取。');};
  current();const controller=new AbortController();active.add(controller);
  const path=`/api/contacts/${op.contactId}/assistant-sessions/${op.sessionId}/reply-candidates`;
  try{
   const request=operationRequest(op,path),response=await backend.requestJson({...request,signal:controller.signal,timeoutMs:op.action==='status'?8000:120000,maxResponseBytes:op.action==='status'?4096:2_000_000});
   current();if(controller.signal.aborted||response.generation!==generation)throw new Error('联系人或来源范围已失效，请重新读取。');
   if(op.action==='status'){const status=readSqliteCandidateStatus(response.data);if(status.requestKey!==op.requestKey)throw new Error('候选状态不匹配。');return status;}
   if(op.action==='read')return readSqliteCandidatePage(response.data);
   if(op.action==='skills')return readSqliteCandidateSkillPage(response.data);
   if(op.action==='version'||op.action==='edit')return readSqliteCandidateVersion(response.data);
   return response.data;
  }catch(error){current();const code=(error as {code?:string}).code;throw new Error(code&&messages[code]?messages[code]:'候选结果尚未确认，请保留原请求重试核对。');}
  finally{active.delete(controller);}
 },'helper');
}
function operationRequest(op:SqliteCandidateOperation,path:string){
 if(op.action==='status')return {method:'GET' as const,path:`${path}/status?request_key=${op.requestKey}`};
 if(op.action==='skills')return {method:'GET' as const,path:`${path}/${op.requestId}/skills?offset=${op.offset}`};
 if(op.action==='read')return {method:'GET' as const,path};
 if(op.action==='version')return {method:'GET' as const,path:`${path}/${op.candidateId}/versions/${op.versionNo}`};
 if(op.action==='generate')return {method:'POST' as const,path,body:{request_key:op.requestKey,text:op.text,confirmed_contact:true,accept_incomplete:op.acceptIncomplete,...(op.selectedPackageId?{selected_package_id:op.selectedPackageId}:{}),...(op.carriedSelectionId?{carried_selection_id:op.carriedSelectionId}:{}),...(op.workspace?{workspace:op.workspace}:{})}};
 return {method:'POST' as const,path:`${path}/${op.candidateId}/${op.action}`,body:{version_no:op.versionNo,...(op.action==='edit'?{parts:op.parts}:{})}};
}
