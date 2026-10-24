/** 探索领域DTO沿用原业务JSON；DSH临时会话不拥有这些身份。 */
import type {ContextScope,ContextMetadata} from './reply-context-types.ts';
export type ExplorationScope=ContextScope;
export class ExplorationError extends Error {readonly code:string;readonly status=409;constructor(code='exploration_error'){super(code);this.code=code;}}
export class ExplorationStale extends ExplorationError {constructor(){super('exploration_stale');}}
export class ExplorationExpired extends ExplorationStale {}
export class ExplorationInProgress extends ExplorationError {constructor(){super('exploration_in_progress');}}
export type ExplorationReadPurpose='current'|'continue'|'history';
export interface ExplorationInput {type:'response_exploration'|'purpose_exploration';target_message_id?:string;purpose_hint?:string;correction:string;requirements:string;answer:string;confirmed_intent:string;skill_mode:'auto'|'disabled'|'user';skill_version_id:string|null;skill_scene?:string}
export interface EvidenceSnapshot {evidence_id:string;kind:'message'|'confirmed_memory';text:string;source_ids:string[];fingerprint:string;manual_contact:boolean;timing:ContextMetadata;valid_at:string|null;invalid_at:string|null;event:ContextMetadata|null;conditions:ContextMetadata|null;evolution:ContextMetadata|null;speaker_role?:'owner'|'contact'|'system'|'unknown'}
export interface ExplorationOpen {session_id:string;content:ExplorationInput;operation_key:string;expected_input_version_id?:string|null;previous_id?:string|null;automatic?:boolean;change_group?:boolean;question_id?:string|null}
export interface ExplorationOption {intent:string;label:string;reason:string;citation_ids:string[];recommended:boolean;pause:boolean;suggestion_id?:string}
export interface ExplorationResult {understanding:string;ambiguities:string[];citation_ids:string[];options:ExplorationOption[];question:{text:string;impact:'stance'|'commitment'|'ambiguity'}|null;question_id?:string|null;current_step:string;tradeoffs:string[]}
export interface ExplorationTask {exploration_id:string;scope:ExplorationScope;session_id:string;input_version_id:string;operation_key:string;request_key:string;content:ExplorationInput;snapshots:EvidenceSnapshot[];intent_snapshots:EvidenceSnapshot[];skill_library_revision:number;skill_version_id:string|null;root_created_at:string;automatic_call_count:number;state:string;result:ExplorationResult|null;selected_intent:string|null;selection_id:string|null;selection_source:'direct_input'|'confirmed_suggestion'|null;skill_selection_complete:boolean}
export interface ExplorationSkillSelection {catalog:{scope:ExplorationScope;revision:number;entries:readonly unknown[]};entry:{version_id:string}|null}
export interface ExplorationCompletedInput {exploration_id:string;request_key:string;input_payload:Record<string,any>}
export const hasConfirmedIntent=(task:ExplorationTask):boolean=>!!task.selected_intent&&isUUID(task.selection_id)&&['direct_input','confirmed_suggestion'].includes(task.selection_source??'');
export const isUUID=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function parseExplorationInput(value:unknown):ExplorationInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ExplorationStale();const p=value as Record<string,any>;
 if(!['response_exploration','purpose_exploration'].includes(p.type)||p.type==='response_exploration'&&!isUUID(p.target_message_id)||p.type==='purpose_exploration'&&p.target_message_id!=null||['purpose_hint','correction','requirements','answer','confirmed_intent'].some(k=>(k!=='purpose_hint'||p[k]!==undefined)&&(typeof p[k]!=='string'||[...p[k]].length>4096))||!['auto','disabled','user'].includes(p.skill_mode)||(p.skill_mode==='user'?!isUUID(p.skill_version_id):p.skill_version_id!==null)||p.skill_scene!==undefined&&(typeof p.skill_scene!=='string'||!p.skill_scene.trim()||p.skill_scene.trim()!==p.skill_scene||[...p.skill_scene].length>256))throw new ExplorationStale();
 return {type:p.type,...(p.type==='response_exploration'?{target_message_id:p.target_message_id}:{purpose_hint:p.purpose_hint??''}),correction:p.correction,requirements:p.requirements,answer:p.answer,confirmed_intent:p.confirmed_intent,skill_mode:p.skill_mode,skill_version_id:p.skill_version_id,...(p.skill_scene!==undefined?{skill_scene:p.skill_scene}:{})};
}
