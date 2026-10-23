/** 方法停用按逻辑身份与全部祖先继承；目录阶段不读取方法正文。 */
import {createHash} from 'node:crypto';
import type {Client} from 'pg';
import type {SkillScope} from './skill-runtime.ts';
import {canonicalJSON} from './contact-overview-evidence.ts';
export type SkillRow=Record<string,any>;
export class SkillPortError extends Error {readonly code:string;constructor(code='skill_unavailable'){super(code);this.code=code;}}
export function skillDigest(value:unknown):string{return createHash('sha256').update(canonicalJSON(value,true)).digest('hex');}
export function wholeStrategyId(id:string):string{
 const bytes=createHash('sha1').update(Buffer.from(id.replaceAll('-',''),'hex')).update('whole_strategy').digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|0x50;bytes[8]=(bytes[8]&63)|0x80;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
async function ancestry(client:Client,owner:string,roots:string[]){
 const edges=new Map<string,Set<string>>(),logical=new Map<string,Set<string>>();let pending=new Set(roots);
 while(pending.size){
  if(edges.size+pending.size>256)throw new SkillPortError();
  const ids=[...pending];pending=new Set();for(const id of ids)edges.set(id,new Set());
  const rows=(await client.query('SELECT method.method_id,method.logical_skill_id,method.replaces_method_ids FROM public.reply_skill_method method JOIN public.reply_skill skill ON skill.id=method.logical_skill_id WHERE skill.owner_id=$1 AND method.method_id=ANY($2::uuid[])',[owner,ids])).rows;
  for(const r of rows){const skills=logical.get(r.method_id)??new Set();skills.add(r.logical_skill_id);logical.set(r.method_id,skills);for(const id of r.replaces_method_ids){edges.get(r.method_id)!.add(id);if(!edges.has(id))pending.add(id);}}
 }
 const result=new Map<string,{ancestors:Set<string>;logical:Set<string>}>();
 for(const root of roots){const seen=new Set<string>(),queue=[root],skills=new Set<string>();while(queue.length){const id=queue.pop()!;if(seen.has(id))continue;seen.add(id);queue.push(...edges.get(id)!);for(const skill of logical.get(id)??[])skills.add(skill);}result.set(root,{ancestors:seen,logical:skills});}return result;
}
function blocked(policies:SkillRow[],skill:string,a:{ancestors:Set<string>;logical:Set<string>}){
 return policies.filter(p=>p.method_id!==null?a.ancestors.has(p.method_id):p.skill_id===skill||a.logical.has(p.skill_id)||a.ancestors.has(wholeStrategyId(p.skill_id)));
}
export async function selectMethods(client:Client,scope:SkillScope,row:SkillRow){
 const policies=(await client.query('SELECT * FROM public.skill_scope_policy WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2) AND (scene IS NULL OR scene=$3) ORDER BY id',[scope.ownerId,scope.contactId,scope.scene||null])).rows;
 const methods=(await client.query('SELECT method_id,replaces_method_ids,mapping_state FROM public.reply_skill_method WHERE version_id=$1 ORDER BY ordinal',[row.id])).rows;
 if(!row.review_origin&&policies.length){
  const historical=(await client.query('SELECT method.method_id FROM public.reply_skill_method method JOIN public.reply_skill skill ON skill.id=method.logical_skill_id WHERE skill.owner_id=$1 AND skill.id=$2',[scope.ownerId,row.skill_id])).rows.map(r=>r.method_id);
  if(policies.some(p=>p.skill_id===row.skill_id)||[...(await ancestry(client,scope.ownerId,historical)).values()].some(a=>blocked(policies,row.skill_id,a).length))throw new SkillPortError();
 }
 if(row.review_origin&&policies.length&&(!methods.length||!row.method_manifest_path||!row.method_manifest_sha256||methods.some(m=>!['new','confirmed'].includes(m.mapping_state))))throw new SkillPortError();
 const roots=methods.length?methods.map(m=>m.method_id):[wholeStrategyId(row.skill_id)];
 const tree=policies.length?await ancestry(client,scope.ownerId,roots):new Map(roots.map(id=>[id,{ancestors:new Set([id]),logical:new Set([row.skill_id])}]));
 const relevant=new Map<string,SkillRow>(),allowed:string[]=[];
 for(const id of roots){const found=blocked(policies,row.skill_id,tree.get(id)!);for(const p of found)relevant.set(p.id,p);if(!found.length)allowed.push(id);}
 if(!allowed.length)throw new SkillPortError();
 const filtered=allowed.length!==roots.length;if(filtered&&(!row.review_origin||!methods.length))throw new SkillPortError();
 return {allowed,ordered:methods.map(m=>m.method_id),filtered,policies:[...relevant.values()].sort((a,b)=>a.id.localeCompare(b.id)),policyRevision:Math.max(0,...[...relevant.values()].map(p=>p.revision))};
}
export const FILTERED_DESCRIPTION='已按用户范围决定筛选的教学方法，只使用本次可读正文。';
