/** 发布来源只读核验；既有证明保留原格式，不用当前资料补写旧证明。 */
import {DatabaseError} from 'pg';
import type {Client} from 'pg';
import {captureSnapshot,validateFrozen,canonicalJSON,parseStoredJSON} from '../memory/overview/evidence/sources.ts';
import {SkillPortError,skillDigest} from './skill-execution-view.ts';
import type {SkillRow} from './skill-execution-view.ts';
import {requireSkillDependencies} from './skill-source-dependencies.ts';
import {captureSkillNavigation} from './skill-source-navigation.ts';
import {
  CONTACT_LAYERED_BUDGET,OWNER_LAYERED_BUDGET,requireLayeredMaterial,selectLayeredMaterial,
  validateLayeredSnapshot,
} from '../reply/context/reply-context-layered.ts';
function same(a:unknown,b:unknown){return canonicalJSON(a)===canonicalJSON(b);}
export function isSkillPersistenceError(error:unknown):boolean{
 const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
 return error instanceof DatabaseError||/^[0-9A-Z]{5}$/.test(code)
  ||['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE'].includes(code);
}
function ids(value:unknown):string[]{if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)))throw new SkillPortError();return value;}
export async function captureSkillGeneration(client:Client,owner:string,contact:string,dependencies:string[]){
 const values=ids(dependencies),params=[owner,contact,values];
 const messages=(await client.query('SELECT id FROM public.message WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])',params)).rows.map(r=>r.id);
 const sources=(await client.query('SELECT id,content_sha256,status FROM public.source_document WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])',params)).rows;
 const observations=(await client.query('SELECT id,to_jsonb(observation)::text AS record FROM public.local_wechat_observation observation WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[])',params)).rows;
 const memories=(await client.query('SELECT id,to_jsonb(memory)::text AS record FROM public.confirmed_memory memory WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) UNION ALL SELECT id,to_jsonb(memory)::text AS record FROM public.owner_memory memory WHERE owner_id=$1 AND id=ANY($3::uuid[])',params)).rows;
 const preferences=(await client.query('SELECT id,to_jsonb(preference)::text AS record FROM public.expression_preference preference WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2) AND id=ANY($3::uuid[])',params)).rows;
 return {version:1,dependencies:[...values].sort(),messages:await captureSnapshot(client,owner,messages,[],contact),
  sources:Object.fromEntries(sources.map(r=>[r.id,skillDigest([r.content_sha256,r.status])])),
  observations:Object.fromEntries(observations.map(r=>[r.id,skillDigest([parseStoredJSON(r.record)])])),
  memories:Object.fromEntries(memories.map(r=>[r.id,skillDigest(parseStoredJSON(r.record))])),
  preferences:Object.fromEntries(preferences.map(r=>[r.id,skillDigest(parseStoredJSON(r.record))]))};
}
async function generation(client:Client,owner:string,contact:string,frozen:SkillRow){
 if(frozen?.version!==1||frozen.styles&&(!Array.isArray(frozen.styles)||frozen.styles.length))throw new SkillPortError();
 await validateFrozen(client,owner,frozen.messages);const {styles:_,...expected}=frozen;
 if(!same(await captureSkillGeneration(client,owner,contact,ids(frozen.dependencies)),expected))throw new SkillPortError();
}
const PARENT_QUERY=`SELECT version.id,version.skill_id,version.content_sha256,version.review_origin,
 skill.contact_id,publication.origin_contact_id,publication.scope_kind,publication.scope_contact_id,
 publication.scene,publication.dependency_ids,publication.source_generation,publication.deleted
 FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id
 LEFT JOIN public.reply_skill_publication publication ON publication.version_id=version.id
 WHERE skill.owner_id=$1 AND skill.status<>'deleted' AND version.status='active' AND version.content_path IS NOT NULL AND version.id=ANY($2::uuid[]) ORDER BY version.id`;
export type SkillDiscussionValidator=(client:Client,owner:string,contact:string,requestId:string)=>Promise<readonly string[]>;
export interface Visit {checking:Set<string>;validated:Set<string>;requireDiscussionDependencies?:SkillDiscussionValidator}
export async function captureParentPublications(client:Client,owner:string,contact:string,identifiers:string[],visit:Visit={checking:new Set(),validated:new Set()}){
 const rows=(await client.query(PARENT_QUERY,[owner,ids(identifiers)])).rows,proofs:SkillRow[]=[],inherited=new Set<string>(),privateAncestors=new Set<string>();
 for(const row of rows){
  if(row.contact_id!==null&&row.contact_id!==contact||row.review_origin&&row.scope_kind==='contact'&&row.scope_contact_id!==contact){privateAncestors.add(row.id);continue;}
  const dependencies=new Set<string>([row.id,row.skill_id]);
  if(row.review_origin){
   if(row.deleted!==false||!['contact','scene','owner'].includes(row.scope_kind)||visit.checking.has(row.id)||visit.checking.size>=256)throw new SkillPortError();
   const key=JSON.stringify([contact,row.id,skillDigest(row)]);
   if(!visit.validated.has(key)){
    if(!(await client.query("SELECT 1 FROM public.conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active'",[owner,row.origin_contact_id])).rowCount)throw new SkillPortError();
    visit.checking.add(row.id);try{await requireReviewSources(client,owner,row.origin_contact_id,row.dependency_ids,row.source_generation?.sources,visit);visit.validated.add(key);}finally{visit.checking.delete(row.id);}
   }
   for(const id of ids(row.dependency_ids))dependencies.add(id);
  }
  proofs.push({skill_id:row.skill_id,version_id:row.id,sha256:skillDigest(row),scope:{kind:row.scope_kind??(row.contact_id?'contact':'owner'),contact_id:row.scope_contact_id??row.contact_id,scene:row.scene},dependencies:[...dependencies].sort()});
  for(const id of dependencies)inherited.add(id);
 }
 if([...privateAncestors].some(id=>!inherited.has(id)))throw new SkillPortError();return {proofs,inherited};
}
export async function requireReviewSources(client:Client,owner:string,contact:string,dependencies:string[],frozen:SkillRow,visit:Visit={checking:new Set(),validated:new Set()}):Promise<void>{
 try{
  ids(dependencies);if(!frozen||typeof frozen!=='object')throw new SkillPortError();
  if(frozen.version===4){
   if(!Array.isArray(frozen.layered)||frozen.layered.length<1||frozen.layered.length>2
    ||!Array.isArray(frozen.base_dependencies))throw new SkillPortError();
   const layeredDependencies=new Set<string>(),seen=new Set<string>();
   for(const item of frozen.layered){
    const scope=item?.scope,snapshot=item?.snapshot;
    if(!scope||scope.owner_id!==owner||scope.contact_id!==null&&scope.contact_id!==contact
     ||!snapshot||!Array.isArray(snapshot.dependency_ids)
     ||!same(scope,snapshot.scope)||seen.has(scope.contact_id??'owner'))throw new SkillPortError();
    seen.add(scope.contact_id??'owner');
    const budget=scope.contact_id===null?OWNER_LAYERED_BUDGET:CONTACT_LAYERED_BUDGET;
    const material=selectLayeredMaterial(snapshot,budget);
    if(!material||!await validateLayeredSnapshot(client,snapshot))throw new SkillPortError();
    await requireLayeredMaterial(client,scope,material,budget);
    for(const id of ids(snapshot.dependency_ids))layeredDependencies.add(id);
   }
   await requireReviewSources(client,owner,contact,ids(frozen.base_dependencies),frozen.base,visit);
   const expected=[...new Set([...ids(frozen.base_dependencies),...layeredDependencies])].sort();
   if(!same(expected,[...new Set(dependencies)].sort()))throw new SkillPortError();
   return;
  }
  if(frozen.version===3){
   if(!Array.isArray(frozen.parents))throw new SkillPortError();
   const {proofs,inherited}=await captureParentPublications(client,owner,contact,frozen.parents.map((p:SkillRow)=>p.version_id),visit);
   const ordinary=new Set<string>([...ids(frozen.base.ordinary.dependencies),...navigationIds(frozen.base.navigation)]);
   if(!same(proofs,frozen.parents)||!same([...new Set([...ordinary,...inherited])].sort(),[...new Set(dependencies)].sort()))throw new SkillPortError();
   await requireReviewSources(client,owner,contact,[...ordinary],frozen.base,visit);return;
  }
  if(frozen.version===2){
   const current=await captureSkillNavigation(client,owner,contact,frozen.navigation.map((p:SkillRow)=>p.identity));
   if(!same(current,frozen.navigation)||!same([...new Set([...ids(frozen.ordinary.dependencies),...navigationIds(current)])].sort(),[...new Set(dependencies)].sort()))throw new SkillPortError();
   await generation(client,owner,contact,frozen.ordinary);await requireSkillDependencies(client,owner,contact,ids(frozen.ordinary.dependencies),visit);return;
  }
  await generation(client,owner,contact,frozen);await requireSkillDependencies(client,owner,contact,dependencies,visit);
 }catch(error){
  if(error instanceof SkillPortError||isSkillPersistenceError(error))throw error;
  throw new SkillPortError();
 }
}
function navigationIds(proof:SkillRow[]):string[]{return proof.flatMap(p=>[p.identity.memory_id,...ids(p.identity.dependency_ids)]);}
/** 管理历史与回滚只核对来源及既有范围；不要求当前版本或当前启用。 */
export async function requireVersionSources(client:Client,owner:string,version:string,contact?:string,requireDiscussionDependencies?:SkillDiscussionValidator):Promise<void>{
 const row=(await client.query(PARENT_QUERY,[owner,[version]])).rows[0];if(!row)throw new SkillPortError();
 if(!row.review_origin){if(contact&&row.contact_id&&contact!==row.contact_id)throw new SkillPortError();return;}
 const {proofs}=await captureParentPublications(client,owner,contact??row.origin_contact_id,[version],{checking:new Set(),validated:new Set(),requireDiscussionDependencies});if(!proofs.some(p=>p.version_id===version))throw new SkillPortError();
}
