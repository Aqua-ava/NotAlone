/** 持续要求只从当前持久输入派生；候选编号与版本必须完整匹配已展示组。 */
import type {Client} from 'pg';
import {record,replyUuid,parseReplyRequest} from '../generation/reply-contract.ts';
import {canonical} from '../generation/reply-assistant-erasure.ts';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import {AssistantGenerationStore,AssistantGenerationError,generationReject,generationRequest,type GenerationRow} from './assistant-generation-store.ts';
export class AssistantContinuationClarification extends Error {
 readonly reason:string;readonly requirements:string[];readonly previous:string[];
 constructor(reason:string,requirements:string[]=[],previous:string[]=[]){super('assistant_continuation_clarification_required');this.reason=reason;this.requirements=requirements;this.previous=previous;}
 payload(){const options=this.requirements.map(requirement=>({requirement,origin:this.previous.includes(requirement)?'existing':'new',actions:this.previous.includes(requirement)?['keep','replace','remove']:['add']}));return {error:this.message,clarification:{reason:this.reason,requirements:this.requirements,requirement_options:options,requirement_actions:[...new Set(options.flatMap(option=>option.actions))]}};}
}
const clarify=(reason:string,requirements:string[]=[],previous:string[]=[]):never=>{throw new AssistantContinuationClarification(reason,requirements,previous);};
const invalid=():never=>{throw new AssistantGenerationError('assistant_continuation_request_invalid',undefined,400);};
const exact=(v:unknown,required:string[],optional:string[]=[]):v is GenerationRow=>record(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
function text(v:unknown):string{if(typeof v!=='string'||!v.trim()||[...v.trim()].length>4096)return invalid();return v.trim();}
export function parseAssistantContinuation(value:unknown):GenerationRow {
 if(!exact(value,['idempotency_key','expected_input_version_id','instruction','displayed_group'],['intention_update','requirement_changes','allow_incomplete_history']))return invalid();
 const frame=value.displayed_group;if(!exact(frame,['session_id','candidate_group_id','candidates'])||!Array.isArray(frame.candidates)||frame.candidates.length>3)return invalid();
 const candidates=frame.candidates.map((item:unknown)=>{if(!exact(item,['number','candidate_id','version_id'])||!Number.isInteger(item.number)||item.number<1||item.number>3)return invalid();return {number:item.number,candidate_id:replyUuid(item.candidate_id),version_id:replyUuid(item.version_id)};});
 if(value.allow_incomplete_history!==undefined&&typeof value.allow_incomplete_history!=='boolean'||value.requirement_changes!==undefined&&!Array.isArray(value.requirement_changes))return invalid();
 const changes=(value.requirement_changes??[]).map((change:unknown)=>{
  if(!record(change))return invalid();const keys=({keep:['action','previous'],remove:['action','previous'],replace:['action','previous','replacement'],add:['action','replacement']} as GenerationRow)[change.action as string];
  if(!keys||!exact(change,keys))return invalid();return {action:change.action,...('previous'in change?{previous:text(change.previous)}:{}),...('replacement'in change?{replacement:text(change.replacement)}:{})};
 });
 return {idempotency_key:replyUuid(value.idempotency_key),expected_input_version_id:replyUuid(value.expected_input_version_id),instruction:text(value.instruction),displayed_group:{session_id:replyUuid(frame.session_id),candidate_group_id:replyUuid(frame.candidate_group_id),candidates},...(value.intention_update!==undefined?{intention_update:text(value.intention_update)}:{}),...(changes.length?{requirement_changes:changes}:{}),...(value.allow_incomplete_history?{allow_incomplete_history:true}:{})};
}
const clauses=(v:string|null|undefined):string[]=>[...new Set((v??'').split(/[；;，,\n]+/).map(s=>s.trim()).filter(Boolean))];
const parts=(v:string)=>clauses(v).flatMap(clause=>clause.split(/并且|而且|并/).map(p=>p.trim()));
function dimension(value:string):[string,string]|null {
 const v=value.replace(/[。\s]/g,''),choices:[string,string,string][]=[['tone','natural','(?:自然|口语化?)(?:一点|一些|些|点)?'],['tone','formal','(?:正式|书面)(?:一点|一些|些|点)?'],['length','brief','(?:简短|简洁)(?:一点|一些|些|点)?|短一点'],['length','detailed','(?:详细|展开)(?:一点|一些|些|点)?'],['initiative','reserved','(?:别|不要|不)太主动'],['initiative','active','主动一点'],['commitment','none','(?:不作|不做|别|不要)承诺']];
 const found=choices.filter(([_d,_c,pattern])=>new RegExp('^(?:请|尽量|保持|语气|表达|回复)?(?:'+pattern+')$').test(v));return found.length===1?[found[0][0],found[0][1]]:null;
}
function requirements(previous:string[],instruction:string,changes:GenerationRow[],intentionChanged:boolean):string[]{
 const effective=[...previous],confirmed=new Set<string>(),touched=new Set<string>(),additions:string[]=[];
 for(const change of changes){
  if(change.action==='add'){additions.push(change.replacement);confirmed.add(change.replacement);continue;}
  if(!previous.includes(change.previous)||touched.has(change.previous))clarify('requirement_change_stale',previous,previous);touched.add(change.previous);
  if(change.action==='keep')confirmed.add(change.previous);
  else if(change.action==='remove')effective.splice(effective.indexOf(change.previous),1);
  else {effective[effective.indexOf(change.previous)]=change.replacement;confirmed.add(change.replacement);}
 }
 if(instruction&&!/^(?:再)?(?:改一下|修改|继续|再改一下)$/.test(instruction))additions.push(...clauses(instruction));
 for(const addition of additions)if(!effective.includes(addition))effective.push(addition);
 const introduced=new Set(effective.filter(v=>!previous.includes(v)));
 const unknown=effective.filter(v=>!confirmed.has(v)&&parts(v).some(p=>dimension(p)===null)&&(intentionChanged||introduced.has(v)&&parts(v).length>1||effective.some(other=>other!==v&&(introduced.has(v)||introduced.has(other)))));
 if(unknown.length)clarify('requirements_need_confirmation',unknown,previous);
 const known=new Map<string,[string,string]>();
 for(const value of effective)for(const part of parts(value)){const d=dimension(part);if(!d)continue;const old=known.get(d[0]);if(old&&old[0]!==d[1])clarify('requirements_conflict',[old[1]],previous);if(!old)known.set(d[0],[d[1],value]);}
 return [...new Set(effective)];
}
function reference(instruction:string):{number:number|null;instruction:string}{
 const ordinal=/第\s*([一二三四五六七八九十百\d]+)\s*(?:条|个)(?:候选)?/g,matches=[...instruction.matchAll(ordinal)],numbers=new Set<number>();
 if(!matches.length&&(/第[^，,。；;\s]{1,8}(?:条|个)/.test(instruction)||/\d+(?:号|条)?候选/.test(instruction)))clarify('candidate_number_unclear');
 const chinese:GenerationRow={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
 for(const match of matches){const number=/^\d+$/.test(match[1])?Number(match[1]):chinese[match[1]];if(!Number.isSafeInteger(number))clarify('candidate_number_unclear');numbers.add(number);}
 if(numbers.size>1||/之前|那个|那条|这条|这个|旧版|版本|上次那/.test(instruction))clarify('candidate_reference_ambiguous');
 return {number:numbers.size?[...numbers][0]:null,instruction:instruction.replace(ordinal,'').replace(/^[ ，,。；;：:]+|[ ，,。；;：:]+$/g,'')};
}
const knownIntention=(value:string)=>value.match(/^(?:还是|改为|改口[:：]?)(答应|拒绝|同意|不去)(?:吧)?[。！!]?$/)?.[1]??null;
export async function reserveAssistantContinuation(store:AssistantGenerationStore,client:Client,scope:VerifiedReplyScope,session:string,command:GenerationRow){
 await store.session(client,scope,session);
 const existing=await store.existing(client,scope,command.idempotency_key);
 if(existing){
  if(existing.state==='redacted'||!existing.input_payload)generationReject('source_deleted');
  if(existing.session_id!==session||canonical(existing.input_payload?.continuation?.submission??null)!==canonical(command))throw new AssistantGenerationError('assistant_session_input_conflict');
  const auth=await store.auth(client,scope,session,existing.input_payload),input={...generationRequest(scope,command.idempotency_key,existing.input_payload,auth),expected_input_version_id:command.expected_input_version_id};
  const row=await store.reserve(client,scope,session,input,{auth});return {row,input,auth};
 }
 const deps=await store.current(client,scope,session,command.expected_input_version_id);
 const current=(await client.query("SELECT * FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND input_version_id=$4 AND state='completed'",[scope.owner_id,scope.contact_id,session,command.expected_input_version_id])).rows[0];
 if(!current?.input_payload||!current.reply_request_id)clarify('completed_generation_required');
 await store.guards.ports.requireSavedSkillPolicy(client,scope,current.reply_request_id);
 const frame=command.displayed_group;if(frame.session_id!==session)clarify('candidate_session_mismatch');
 if(!frame.candidates.length)clarify('candidate_group_missing');
 if(new Set(frame.candidates.map((c:GenerationRow)=>c.number)).size!==frame.candidates.length||new Set(frame.candidates.map((c:GenerationRow)=>c.candidate_id)).size!==frame.candidates.length)clarify('candidate_frame_ambiguous');
 const members=(await client.query("SELECT c.id,c.ordinal,c.message_group,c.reply_request_id FROM reply_candidate c JOIN assistant_session_turn t ON t.reply_request_id=c.reply_request_id AND t.owner_id=c.owner_id AND t.contact_id=c.contact_id AND t.conversation_binding_id=c.conversation_binding_id WHERE c.owner_id=$1 AND c.contact_id=$2 AND t.session_id=$3 AND c.reply_request_id=$4 AND t.state='completed'",[scope.owner_id,scope.contact_id,session,frame.candidate_group_id])).rows;
 if(canonical(members.map(m=>[m.ordinal+1,m.id]).sort())!==canonical(frame.candidates.map((c:GenerationRow)=>[c.number,c.candidate_id]).sort()))clarify('candidate_group_unavailable');
 const histories=new Map<number,GenerationRow>();
 for(const item of frame.candidates){
  const member=members.find(c=>c.id===item.candidate_id)!;await store.guards.assistant.readContinuationBasis(client,scope,scope.conversation_binding_id,member.id);
  const version=(await client.query('SELECT * FROM assistant_candidate_version WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND candidate_id=$4 AND id=$5',[scope.owner_id,scope.contact_id,session,member.id,item.version_id])).rows[0];
  if(!version&&item.version_id!==member.id)clarify('candidate_version_unavailable');histories.set(item.number,{candidate_id:member.id,version_id:item.version_id,messages:version?.message_group??member.message_group,requirements:version?.requirements??null});
 }
 let {number,instruction}=reference(command.instruction);if(number!==null&&!histories.has(number))clarify('candidate_number_missing');
 const selected=number===null?null:histories.get(number)!,payload=current.input_payload,content={...payload.content},pasted=content.type==='rewrite_draft'&&content.input_kind==='current_chat';
 const source=content.type==='reply_to_message'||pasted?'direction':content.type==='initiate_conversation'?'purpose':'draft_text',intentKey=pasted?'pasted_direction':source,priorIntent=content[intentKey];
 const instructionIntention=knownIntention(instruction),update=command.intention_update??null,canonicalIntent:GenerationRow={答应:'accept',同意:'accept',拒绝:'decline',不去:'decline'};
 if(instructionIntention&&update){const value=knownIntention(update)??update;if(canonicalIntent[value]&&canonicalIntent[value]!==canonicalIntent[instructionIntention])clarify('intention_conflict');}
 const intention=update??instructionIntention;if(intention!==null&&(instructionIntention!==null||instruction===intention))instruction='';
 const previous=[...new Set([...(payload.continuation?.effective_requirements??clauses(content.user_instruction)),...clauses(selected?.requirements)])] as string[];
 const effective=requirements(previous,instruction,command.requirement_changes??[],intention!==null&&intention!==priorIntent);
 content.user_instruction=effective.length?effective.join('；'):null;
 if(intention!==null){content[intentKey]=intention;if(content.type!=='rewrite_draft'){content[source+'_source']='direct_input';content.clarification_answer=null;}else if(content.input_kind==='workspace')content.workspace_action='express';}
 const metadata={version:1,submission:command,candidate_group_id:frame.candidate_group_id,candidate_number:number,candidate_id:selected?.candidate_id??null,version_id:selected?.version_id??null,effective_intent:{source},effective_requirements:effective,intention_changed:intention!==null,scope:'this_assistant_session_only'};
 const auth={continuation:metadata,continuation_reference:selected?{candidate_id:selected.candidate_id,version_id:selected.version_id,messages:selected.messages}:null};
 const suggestion=intention===null?content.suggestion??null:null;delete content.suggestion;
 const input=parseReplyRequest({contact_id:scope.contact_id,idempotency_key:command.idempotency_key,content,continued_from_candidate_id:selected?.candidate_id??null,skill_version_id:payload.skill_version_id,skill_disabled:payload.skill_disabled,scene:payload.scene??null,allow_incomplete_history:command.allow_incomplete_history??false,suggestion,expected_input_version_id:command.expected_input_version_id},auth);
 const row=await store.reserve(client,scope,session,input,{auth,dependencies:deps});return {row,input,auth};
}
