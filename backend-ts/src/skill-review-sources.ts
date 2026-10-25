/** 审核对照的完整来源世代；父发布、导航记忆与普通学习材料分别证明。 */
import type {Client} from 'pg';
import {SkillLearningInvalid} from './skill-learning-contract.ts';
import {expandSkillProvenance,requireSkillDependencies} from './skill-source-dependencies.ts';
import {captureParentPublications,captureSkillGeneration,isSkillPersistenceError,
  requireReviewSources as verifyFrozen,type Visit} from './skill-source-proof.ts';
import {captureSkillNavigation} from './skill-source-navigation.ts';
import type {LayeredSnapshot} from './reply-context-layered.ts';
type Row=Record<string,any>;
export interface ReviewLayeredMaterial {
  scope:{owner_id:string;contact_id:string|null};
  snapshot:LayeredSnapshot;
}
function navigationIds(proof:Row[]):string[]{
  return proof.flatMap(item=>[item.identity.memory_id,...item.identity.dependency_ids]);
}
async function captureBaseReviewSources(
  client:Client,scope:{owner_id:string;contact_id:string},draftDependencies:string[],
  contextDependencies:string[],navigation:Row[],targets:Row[],visit:Visit,
):Promise<{dependencies:string[];frozen:Row}>{
  const targetIds=targets.map(item=>item.version_id);
  const requested=[...new Set([...draftDependencies,...contextDependencies,...targetIds])];
  let parents:Row[],inherited:Set<string>;
  try{({proofs:parents,inherited}=await captureParentPublications(client,scope.owner_id,scope.contact_id,requested,visit));}
  catch{throw new SkillLearningInvalid();}
  if(targetIds.some(id=>!parents.some(item=>item.version_id===id)))throw new SkillLearningInvalid();
  if(parents.length){
    const base=await captureBaseReviewSources(client,scope,
      draftDependencies.filter(id=>!inherited.has(id)),contextDependencies.filter(id=>!inherited.has(id)),
      navigation,[],visit);
    return {dependencies:[...new Set([...base.dependencies,...inherited])].sort(),
      frozen:{version:3,base:base.frozen,parents}};
  }
  let proof:Row[];
  try{proof=await captureSkillNavigation(client,scope.owner_id,scope.contact_id,navigation);}
  catch{throw new SkillLearningInvalid();}
  const navigationSet=new Set(navigationIds(proof));
  let ordinary:Set<string>;
  try{ordinary=await expandSkillProvenance(client,scope.owner_id,scope.contact_id,
    [...new Set([...draftDependencies,...contextDependencies.filter(id=>!navigationSet.has(id))])],visit);}
  catch{throw new SkillLearningInvalid();}
  try{await requireSkillDependencies(client,scope.owner_id,scope.contact_id,[...ordinary],visit);}
  catch{throw new SkillLearningInvalid();}
  return {dependencies:[...new Set([...ordinary,...navigationSet])].sort(),
    frozen:{version:2,ordinary:await captureSkillGeneration(client,scope.owner_id,scope.contact_id,[...ordinary]),navigation:proof}};
}
export async function captureReviewSources(
  client:Client,scope:{owner_id:string;contact_id:string},draftDependencies:string[],
  contextDependencies:string[],navigation:Row[],targets:Row[],visit:Visit,
  layered:ReviewLayeredMaterial[]=[],
):Promise<{dependencies:string[];frozen:Row}>{
  const base=await captureBaseReviewSources(client,scope,draftDependencies,contextDependencies,navigation,targets,visit);
  if(!layered.length)return base;
  const seen=new Set<string>();
  for(const item of layered){
    if(item.scope.owner_id!==scope.owner_id||item.scope.contact_id!==null&&item.scope.contact_id!==scope.contact_id)
      throw new SkillLearningInvalid();
    const key=item.scope.contact_id??'owner';
    if(seen.has(key))throw new SkillLearningInvalid();
    if(item.snapshot?.scope?.owner_id!==scope.owner_id
      ||(item.snapshot.scope.contact_id??null)!==item.scope.contact_id)throw new SkillLearningInvalid();
    seen.add(key);
  }
  const dependencies=[...new Set([...base.dependencies,...layered.flatMap(item=>item.snapshot.dependency_ids)])].sort();
  return {dependencies,
    frozen:{version:4,base:base.frozen,base_dependencies:base.dependencies,layered}};
}
export async function reviewSourcesCurrent(
  client:Client,scope:{owner_id:string;contact_id:string},dependencies:string[],frozen:Row,visit:Visit,
):Promise<boolean>{
  try{await verifyFrozen(client,scope.owner_id,scope.contact_id,dependencies,frozen,visit);return true;}
  catch(error){if(isSkillPersistenceError(error))throw error;return false;}
}
