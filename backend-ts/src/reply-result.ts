/** 已保存回复的原HTTP DTO投影；内部来源、准备上下文和框架对象不进入响应。 */
import type {ReplyStoreResult} from './reply-store.ts';
import {ReplyError,record,replyUuid} from './reply-contract.ts';
const invalid=():never=>{throw new ReplyError('reply_result_invalid',502);};
function sameKeys(value:Record<string,unknown>,keys:string[]):boolean{return Object.keys(value).sort().join(',')===keys.sort().join(',');}
function preferenceReceipts(value:unknown,contact:string){
 if(!Array.isArray(value)||value.length>5)return invalid();
 const items=value.map(row=>{
  if(!record(row)||!sameKeys(row,['preference_id','text','revision','scope'])||!record(row.scope)||!sameKeys(row.scope,['contact_id','reply_mode']))return invalid();
  if(typeof row.text!=='string'||![...row.text.trim()].length||[...row.text].length>512||!(typeof row.revision==='bigint'||typeof row.revision==='number'&&Number.isSafeInteger(row.revision))||row.revision<1)return invalid();
  if(row.scope.contact_id!==null&&row.scope.contact_id!==contact||row.scope.reply_mode!==null&&!['rewrite_draft','reply_to_message','initiate_conversation'].includes(String(row.scope.reply_mode)))return invalid();
  let id:string;try{id=replyUuid(row.preference_id);}catch{return invalid();}
  return {preference_id:id,text:row.text,revision:row.revision,scope:{contact_id:row.scope.contact_id as string|null,reply_mode:row.scope.reply_mode as string|null}};
 });
 if(new Set(items.map(e=>e.preference_id)).size!==items.length||items.reduce((n,e)=>n+[...e.text].length,0)>1536)return invalid();
 return items.sort((a,b)=>a.preference_id.localeCompare(b.preference_id,'en'));
}
/** basisChanges来自同范围权威读取，不能用模型输出替代或静默省略。 */
export function replyGeneratedPayload(result:ReplyStoreResult,contactId:string,basisChanges:readonly Record<string,unknown>[]){
 const snap=result.context_snapshot;if(!record(snap)||!Array.isArray(basisChanges))return invalid();
 const flag=(name:string)=>{if(snap[name]===undefined)return false;if(typeof snap[name]!=='boolean')return invalid();return snap[name] as boolean;};
 const preferences=preferenceReceipts(snap.expression_preferences??[],contactId);
 const skill=result.used_skill;
 const used_skill=skill?{skill_id:skill.skill_id,version_id:skill.version_id,name:skill.name,selection_method:skill.selection_method,selection_reason:skill.selection_reason,resource_paths:skill.resource_paths,load_state:skill.load_state,version_number:skill.version_number??null,
  scope:{kind:skill.scope_kind??'owner',contact_id:skill.scope_contact_id??null,scene:skill.scope_scene??null},
  ...skill.execution_view?{execution_view:structuredClone(skill.execution_view)}:{}}:null;
 return {reply_request_id:result.reply_request_id,candidates:structuredClone(result.candidates),context_receipt:{
  evidence_ids:[...new Set(result.candidates.flatMap(c=>c.citation_ids))],expression_preference_ids:preferences.map(e=>e.preference_id),expression_preferences:preferences,
  layered_read_failed:flag('layered_read_failed'),owner_layered_read_failed:flag('owner_layered_read_failed'),overview_read_failed:flag('overview_read_failed')},used_skill,
  ...(basisChanges.length?{basis_changes:structuredClone(basisChanges)}:{}),...(snap.input_budget!=null?{input_budget:structuredClone(snap.input_budget)}:{})};
}
