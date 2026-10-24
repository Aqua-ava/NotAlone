/** 只读分层资料资格：绑定当前事务中的来源指纹，不信任概览缓存或记录存在性。 */
import type {Client} from 'pg';
import {readReplyContactOverview,readReplyOwnerOverview} from './reply-context-overview.ts';
import {canonicalJSON,digest} from './contact-overview-evidence.ts';
import {epochMicros} from './contact-overview-time.ts';
import {ReplyContextError,type ContextMetadata} from './reply-context-types.ts';
import {forbiddenGenerationMemoryDependencies} from './reply-source-guards.ts';
export interface LayeredScope {owner_id:string;contact_id:string|null}
export interface LayeredSnapshot {schema_version:2;scope:LayeredScope;settings_generation:number;organization_generation:number;scenarios:ContextMetadata[];dependency_ids:string[];profile_version_id:string|null;profile_entries:ContextMetadata[];quality_receipt?:string|null}
export interface LayeredBudget {profile_entries:number;directory_entries:number;characters:number;scenario_read:{calls:number;paragraphs:number;characters:number}|null}
export interface LayeredMaterial {snapshot:LayeredSnapshot;payload_json:string}
export const CONTACT_LAYERED_BUDGET:LayeredBudget={profile_entries:4,directory_entries:4,characters:2400,scenario_read:{calls:2,paragraphs:8,characters:4000}};
export const OWNER_LAYERED_BUDGET:LayeredBudget={profile_entries:4,directory_entries:4,characters:1600,scenario_read:{calls:2,paragraphs:8,characters:2400}};
const sameSet=(a:string[],b:string[])=>canonicalJSON([...new Set(a)].sort())===canonicalJSON([...new Set(b)].sort());
async function stored(client:Client,scope:LayeredScope,generation:number){
 const manifest=(await client.query('SELECT * FROM public.layered_memory_generation WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3',[scope.owner_id,scope.contact_id,generation])).rows[0];
 if(!manifest)return null;
 const rows=(await client.query('SELECT v.*,b.input_manifest,b.dependency_ids FROM public.scenario_document_version v JOIN public.layered_memory_batch b ON b.id=v.batch_id WHERE v.owner_id=$1 AND v.contact_id IS NOT DISTINCT FROM $2::uuid AND v.id=ANY($3::uuid[]) ORDER BY v.scenario_id',[scope.owner_id,scope.contact_id,manifest.scenario_version_ids])).rows;
 const profile=manifest.profile_version_id?(await client.query('SELECT v.*,b.scenario_version_ids,b.input_manifest,b.dependency_ids FROM public.layered_profile_version v JOIN public.layered_profile_batch b ON b.id=v.batch_id WHERE v.id=$1 AND v.owner_id=$2 AND v.contact_id IS NOT DISTINCT FROM $3::uuid',[manifest.profile_version_id,scope.owner_id,scope.contact_id])).rows[0]:null;
 return {manifest,rows,profile};
}
export async function validateLayeredSnapshot(client:Client,snapshot:LayeredSnapshot):Promise<boolean>{
 if(snapshot.schema_version!==2)return false;
 const scope=snapshot.scope;
 // ADR-080：派生快照不能绕过任一底层记忆的失效或过期资格。
 if((await forbiddenGenerationMemoryDependencies(client,{owner_id:scope.owner_id,contact_id:scope.contact_id??scope.owner_id},snapshot.dependency_ids)).length)return false;
 const state=(await client.query('SELECT * FROM public.layered_memory_state WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid',[scope.owner_id,scope.contact_id])).rows[0];
 if(!state?.enabled||!['ready','paused','failed','updating','stale'].includes(state.status)||Number(state.settings_generation)!==snapshot.settings_generation||Number(state.organization_generation)!==snapshot.organization_generation)return false;
 const result=await stored(client,scope,snapshot.organization_generation);if(!result)return false;
 const {manifest,rows,profile}=result;
 const actual=rows.map(row=>({scenario_id:row.scenario_id,version_id:row.id,title:row.title,hint:row.hint,paragraph_count:row.paragraphs.length}));
 if(!actual.length||canonicalJSON([...actual].sort((a,b)=>a.scenario_id.localeCompare(b.scenario_id)))!==canonicalJSON([...snapshot.scenarios].sort((a,b)=>a.scenario_id.localeCompare(b.scenario_id)))||manifest.profile_version_id!==snapshot.profile_version_id||manifest.profile_version_id&&!profile)return false;
 const overview=scope.contact_id?await readReplyContactOverview(client,{owner_id:scope.owner_id,contact_id:scope.contact_id}):await readReplyOwnerOverview(client,scope.owner_id,true);
 const now=epochMicros((await client.query('SELECT clock_timestamp()::text AS time')).rows[0].time);
 const current=new Map<string,ContextMetadata>();
 for(const entry of overview.entries){const memory=entry.memory;if(!['manual_entry','source_supported'].includes(entry.provenance.kind)||memory.status!=='active'||!entry.is_latest||memory.valid_at&&epochMicros(memory.valid_at)>now||memory.invalid_at&&epochMicros(memory.invalid_at)<=now)continue;if(entry.dependency_manifest?.memory_id!==memory.memory_id)throw new ReplyContextError('整理实际输入指纹不可核验。');current.set(memory.memory_id,{...entry.dependency_manifest,organization_timing_sha256:digest(memory.timing)});}
 const inputsCurrent=(items:ContextMetadata[])=>Array.isArray(items)&&items.every(item=>canonicalJSON(current.get(item.memory_id))===canonicalJSON(item));
 const dependencies=rows.flatMap(row=>row.dependency_ids);
 if(profile){if(profile.withdrawn||!sameSet(profile.scenario_version_ids,rows.map(row=>row.id))||!inputsCurrent(profile.input_manifest))return false;dependencies.push(...profile.dependency_ids);}
 return canonicalJSON(snapshot.profile_entries)===canonicalJSON(profile?.entries??[])&&sameSet(snapshot.dependency_ids,manifest.dependency_ids)&&sameSet(snapshot.dependency_ids,dependencies)&&rows.every(row=>inputsCurrent(row.input_manifest));
}
export async function captureLayeredSnapshot(client:Client,scope:LayeredScope):Promise<LayeredSnapshot|null>{
 const state=(await client.query('SELECT * FROM public.layered_memory_state WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid',[scope.owner_id,scope.contact_id])).rows[0];
 if(!state?.enabled||!['ready','paused','failed','updating','stale'].includes(state.status))return null;
 const result=await stored(client,scope,Number(state.organization_generation));if(!result||!result.rows.length)return null;
 const {manifest,rows,profile}=result;
 const snapshot:LayeredSnapshot={schema_version:2,scope,settings_generation:Number(state.settings_generation),organization_generation:Number(state.organization_generation),scenarios:rows.map(row=>({scenario_id:row.scenario_id,version_id:row.id,title:row.title,hint:row.hint,paragraph_count:row.paragraphs.length})),dependency_ids:manifest.dependency_ids,profile_version_id:manifest.profile_version_id,profile_entries:profile?.entries??[]};
 return await validateLayeredSnapshot(client,snapshot)?snapshot:null;
}
// Python json.dumps 默认空格与Unicode码点预算；对象顺序保留原payload构造顺序。
export function payloadJSON(value:any):string {if(Array.isArray(value))return '['+value.map(payloadJSON).join(', ')+']';if(value!==null&&typeof value==='object')return '{'+Object.entries(value).map(([key,item])=>JSON.stringify(key)+': '+payloadJSON(item)).join(', ')+'}';return JSON.stringify(value);}
export function selectLayeredMaterial(snapshot:LayeredSnapshot,budget:LayeredBudget):LayeredMaterial|null{
 for(const value of [budget.profile_entries,budget.directory_entries,budget.characters])if(!Number.isInteger(value)||value<1||value>10000)throw new ReplyContextError('整理资料预算无效。');
 if(budget.scenario_read)for(const [key,limit] of [['calls',8],['paragraphs',32],['characters',32000]] as const){const value=budget.scenario_read[key];if(!Number.isInteger(value)||value<1||value>limit)throw new ReplyContextError('正文读取预算无效。');}
 const payload:ContextMetadata={schema_version:3,scope_kind:snapshot.scope.contact_id===null?'owner':'contact',settings_generation:snapshot.settings_generation,organization_generation:snapshot.organization_generation,profile_version_id:snapshot.profile_version_id,profile_entries:[],directory:[],read_policy:snapshot.quality_receipt?.startsWith('verified-items-v1:')?'verified-items-scoped-layered-v1':'synthetic-scoped-layered-v3',scenario_read_budget:budget.scenario_read?{call_limit:budget.scenario_read.calls,paragraph_limit:budget.scenario_read.paragraphs,character_limit:budget.scenario_read.characters}:null,budget:{profile_entries:budget.profile_entries,directory_entries:budget.directory_entries,characters:budget.characters}};
 for(const [key,values,limit] of [['profile_entries',snapshot.profile_entries,budget.profile_entries],['directory',snapshot.scenarios.map(item=>({...item,paragraph_range:[0,item.paragraph_count]})),budget.directory_entries]] as const)for(const item of values){if(payload[key].length>=limit)break;payload[key].push(item);if([...payloadJSON(payload)].length>budget.characters)payload[key].pop();}
 if(!payload.profile_entries.length&&!payload.directory.length)return null;if(!payload.profile_entries.length)payload.profile_version_id=null;
 return {snapshot,payload_json:payloadJSON(payload)};
}
export async function requireLayeredMaterial(client:Client,scope:LayeredScope,material:LayeredMaterial|null,budget:LayeredBudget):Promise<void>{
 if(!material)return;
 if(canonicalJSON(material.snapshot.scope)!==canonicalJSON(scope)||canonicalJSON(selectLayeredMaterial(material.snapshot,budget))!==canonicalJSON(material)||!await validateLayeredSnapshot(client,material.snapshot))throw new ReplyContextError('本次整理资料已变化。');
}
