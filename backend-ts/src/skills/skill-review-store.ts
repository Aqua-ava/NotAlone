/** 草稿审核、冻结对照与原子发布；模型始终在事务外，只拿到只读草稿投影。 */
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {canonicalJSON} from '../memory/overview/contact-overview-evidence.ts';
import type {SkillFiles,SkillMethod,SkillVersionFiles} from './skill-files.ts';
import type {SkillLibrary} from './skill-library.ts';
import {validatePackage,type SkillPackage} from './skill-package.ts';
import {FILTERED_DESCRIPTION,skillDigest,SkillPortError,wholeStrategyId} from './skill-execution-view.ts';
import {
  SkillLearningInvalid,SkillLearningNotFound,editedStrategy,
  skillContentDigest,type SkillLearningScope,type SkillPublicationScope,
} from './skill-learning-contract.ts';
import {authorizedContact,draftPayload,type SkillLearningDraftRow,type SkillLearningStore} from './skill-learning-store.ts';
import {captureReviewSources,reviewSourcesCurrent,type ReviewLayeredMaterial} from './skill-review-sources.ts';
import {
  captureParentPublications,isSkillPersistenceError,requireVersionSources,type SkillDiscussionValidator,
} from './skill-source-proof.ts';
type Transaction=<T>(operation:(client:pg.Client)=>Promise<T>)=>Promise<T>;
type Row=Record<string,any>;
export interface SkillReviewStoreOptions {
  transaction:Transaction;
  learning:SkillLearningStore;
  files:SkillFiles;
  library:SkillLibrary;
  requireDiscussionDependencies?:SkillDiscussionValidator;
  now?:()=>Date;
}
async function locks(client:pg.Client,scope:SkillLearningScope):Promise<void>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${scope.owner_id}:${scope.contact_id}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
}
async function methodAncestry(client:pg.Client,owner:string,roots:string[]){
  const edges=new Map<string,Set<string>>(),logical=new Map<string,Set<string>>();let pending=new Set(roots);
  while(pending.size){
    if(edges.size+pending.size>256)throw new SkillPortError();
    const ids=[...pending];pending=new Set();
    for(const id of ids)edges.set(id,new Set());
    for(const row of (await client.query(`SELECT method.method_id,method.logical_skill_id,method.replaces_method_ids
      FROM public.reply_skill_method method JOIN public.reply_skill skill ON skill.id=method.logical_skill_id
      WHERE skill.owner_id=$1 AND method.method_id=ANY($2::uuid[])`,[owner,ids])).rows){
      const skills=logical.get(row.method_id)??new Set<string>();skills.add(row.logical_skill_id);logical.set(row.method_id,skills);
      for(const id of row.replaces_method_ids){edges.get(row.method_id)!.add(id);if(!edges.has(id))pending.add(id);}
    }
  }
  const result=new Map<string,{ancestors:Set<string>;logical:Set<string>}>();
  for(const root of roots){
    const seen=new Set<string>(),queue=[root],skills=new Set<string>();
    while(queue.length){const id=queue.pop()!;if(seen.has(id))continue;seen.add(id);queue.push(...(edges.get(id)??[]));for(const skill of logical.get(id)??[])skills.add(skill);}
    result.set(root,{ancestors:seen,logical:skills});
  }
  return result;
}
function blocked(policies:Row[],skill:string,tree:{ancestors:Set<string>;logical:Set<string>}){
  return policies.filter(policy=>policy.method_id!==null?tree.ancestors.has(policy.method_id):
    policy.skill_id===skill||tree.logical.has(policy.skill_id)||tree.ancestors.has(wholeStrategyId(policy.skill_id)));
}
export interface DraftExecutionProjection {
  content:string;contentHash:string;name:string;description:string;allowed:string[];
  execution_view:{policy_revision:number;method_ids:string[];sha256:string};filtered:boolean;
}
export async function projectDraftExecution(
  client:pg.Client,scope:SkillLearningScope,draft:SkillLearningDraftRow,comparisonId:string,scene:string,
):Promise<DraftExecutionProjection>{
  const strategy=draft.strategy;
  if(!strategy||!Array.isArray(strategy.methods))throw new SkillLearningInvalid();
  const policies=(await client.query(`SELECT * FROM public.skill_scope_policy WHERE owner_id=$1
    AND (contact_id IS NULL OR contact_id=$2) AND (scene IS NULL OR scene=$3) ORDER BY id`,
  [scope.owner_id,scope.contact_id,scene])).rows;
  if(!policies.length){
    const allowed=strategy.methods.map((method:Row)=>method.method_id);
    return {content:strategy.document,contentHash:skillContentDigest(strategy.document),name:strategy.name,
      description:strategy.description,allowed,filtered:false,
      execution_view:{policy_revision:0,method_ids:allowed,
        sha256:skillDigest({version_id:comparisonId,document:strategy.document,methods:allowed,policies:[]})}};
  }
  const roots=strategy.methods.map((method:Row)=>method.method_id);
  const replacements=[...new Set<string>(strategy.methods.flatMap((method:Row)=>method.replaces_method_ids??[]))];
  const tree=await methodAncestry(client,scope.owner_id,[...roots,...replacements]);
  for(const method of strategy.methods){
    const own=tree.get(method.method_id)!;
    for(const parent of method.replaces_method_ids??[]){
      const ancestry=tree.get(parent);if(!ancestry)throw new SkillLearningInvalid();
      for(const id of ancestry.ancestors)own.ancestors.add(id);
      for(const id of ancestry.logical)own.logical.add(id);
    }
    if(!['new','requires_review'].includes(method.mapping_status))throw new SkillLearningInvalid();
  }
  const allowed:string[]=[],relevant=new Map<string,Row>();
  for(const method of strategy.methods as Row[]){
    const found=blocked(policies,draft.logical_skill_id,tree.get(method.method_id)!);
    for(const policy of found)relevant.set(policy.id,policy);
    if(!found.length)allowed.push(method.method_id);
  }
  if(!allowed.length)throw new SkillLearningInvalid();
  const filtered=allowed.length!==roots.length;
  const description=filtered?FILTERED_DESCRIPTION:strategy.description;
  const content=filtered?`---\nname: ${strategy.name}\ndescription: ${JSON.stringify(description)}\n---\n# 本次允许的方法\n\n`+
    strategy.methods.filter((method:Row)=>allowed.includes(method.method_id))
      .map((method:Row)=>`## ${method.title}\n${method.instruction}`).join('\n\n'):strategy.document;
  const relevantPolicies=[...relevant.values()].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  const revision=Math.max(0,...relevantPolicies.map(row=>Number(row.revision)));
  return {content,contentHash:skillContentDigest(content),name:strategy.name,description,allowed,filtered,
    execution_view:{policy_revision:revision,method_ids:allowed,
      sha256:skillDigest({version_id:comparisonId,document:content,methods:allowed,
        policies:relevantPolicies.map(row=>[row.id,row.revision])})}};
}
function comparisonPayload(row:Row){
  return {comparison_id:row.id,draft_revision:Number(row.draft_revision),input_version:row.input_version,input:row.input,
    scope:row.confirmed_scope,...row.result,valid:true};
}
export class SkillReviewStore {
  private readonly options:SkillReviewStoreOptions;
  constructor(options:SkillReviewStoreOptions){this.options=options;}
  private now(){return this.options.now?.()??new Date();}
  private visit(){return {checking:new Set<string>(),validated:new Set<string>(),
    requireDiscussionDependencies:this.options.requireDiscussionDependencies};}
  private commandFingerprint(value:unknown){return skillContentDigest(value);}
  private async lockedDraft(client:pg.Client,scope:SkillLearningScope,draftId:string,lock=true):Promise<SkillLearningDraftRow>{
    await locks(client,scope);
    if(!(await client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id])).rowCount)
      throw new SkillLearningNotFound();
    await this.options.learning.clearUnavailable(client,scope);
    const row=(await client.query(`SELECT * FROM public.skill_draft WHERE owner_id=$1 AND contact_id=$2 AND id=$3${lock?' FOR UPDATE':''}`,
      [scope.owner_id,scope.contact_id,draftId])).rows[0] as SkillLearningDraftRow|undefined;
    if(!row)throw new SkillLearningNotFound();if(row.status==='invalidated')throw new SkillLearningInvalid();
    return row;
  }
  private async comparison(client:pg.Client,scope:SkillLearningScope,id:string):Promise<Row>{
    const row=(await client.query('SELECT * FROM public.skill_review_comparison WHERE id=$1 AND owner_id=$2 AND contact_id=$3',
      [id,scope.owner_id,scope.contact_id])).rows[0];
    if(!row)throw new SkillLearningNotFound();return row;
  }
  private async operation(client:pg.Client,scope:SkillLearningScope,key:string){
    return (await client.query(`SELECT * FROM public.skill_review_operation WHERE owner_id=$1 AND contact_id=$2 AND operation_key=$3`,
      [scope.owner_id,scope.contact_id,key])).rows[0];
  }
  private async recordOperation(client:pg.Client,scope:SkillLearningScope,draftId:string,key:string,action:string,
    command:unknown,comparisonId?:string|null,publishedVersionId?:string|null){
    await client.query(`INSERT INTO public.skill_review_operation(owner_id,contact_id,draft_id,operation_key,action,
      request_fingerprint,comparison_id,published_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [scope.owner_id,scope.contact_id,draftId,key,action,this.commandFingerprint(command),comparisonId??null,publishedVersionId??null]);
  }
  private requirePending(draft:SkillLearningDraftRow,revision:number){
    if(draft.status!=='pending'||Number(draft.revision)!==revision)throw new SkillLearningInvalid();
  }
  private async requireSanitized(client:pg.Client,scope:SkillLearningScope,strategy:Row){
    const row=(await client.query('SELECT display_name FROM public.contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id])).rows[0];
    if(row&&Array.from(row.display_name as string).length>=2&&String(strategy.document).includes(row.display_name))throw new SkillLearningInvalid();
  }
  private async requireTargets(client:pg.Client,scope:SkillLearningScope,targets:Row[]):Promise<void>{
    for(const target of targets){
      const row=(await client.query(`SELECT version.*,skill.owner_id,skill.name FROM public.reply_skill skill JOIN public.reply_skill_version version
        ON version.skill_id=skill.id WHERE skill.owner_id=$1 AND skill.id=$2 AND (skill.contact_id IS NULL OR skill.contact_id=$3)
        AND skill.status='active' AND version.id=$4 AND version.version_number=$5 AND version.is_current
        AND version.enabled AND version.status='active' AND version.content_path IS NOT NULL AND version.directory_available`,
      [scope.owner_id,target.skill_id,scope.contact_id,target.version_id,target.version_number])).rows[0];
      if(!row)throw new SkillLearningInvalid();
      try{
        const files=row as SkillVersionFiles;
        this.options.files.readManifest(files);
        this.options.files.readContent(files);
        await requireVersionSources(client,scope.owner_id,target.version_id,scope.contact_id,this.options.requireDiscussionDependencies);
      }catch(error){if(isSkillPersistenceError(error))throw error;throw new SkillLearningInvalid();}
    }
    if(targets.length>1){
      try{
        const {proofs}=await captureParentPublications(client,scope.owner_id,scope.contact_id,targets.map(item=>item.version_id),this.visit());
        if(proofs.length!==targets.length||new Set(proofs.map(item=>canonicalJSON(item.scope))).size!==1)throw new SkillLearningInvalid();
      }catch(error){if(isSkillPersistenceError(error))throw error;throw new SkillLearningInvalid();}
    }
  }
  private async requireRevisions(client:pg.Client,scope:SkillLearningScope,expected:Row):Promise<void>{
    if(!(await client.query("SELECT 1 FROM public.conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='active'",
      [scope.owner_id,scope.contact_id,expected.binding_id])).rowCount)throw new SkillLearningInvalid();
    const library=Number((await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[scope.owner_id])).rows[0]?.revision??0);
    if(library!==Number(expected.library))throw new SkillLearningInvalid();
    const memory=(await client.query(`SELECT state.memory_revision,index.built_from_memory_revision
      FROM public.contact_memory_state state LEFT JOIN public.contact_memory_index index
      ON index.owner_id=state.owner_id AND index.contact_id=state.contact_id
      WHERE state.owner_id=$1 AND state.contact_id=$2`,[scope.owner_id,scope.contact_id])).rows[0];
    const currentMemory=Number(memory?.memory_revision??0),currentIndex=memory?.built_from_memory_revision==null?null:Number(memory.built_from_memory_revision);
    if(expected.memory!==null&&expected.memory!==undefined&&Number(expected.memory)!==currentMemory
      ||expected.index!==null&&expected.index!==undefined&&Number(expected.index)!==currentIndex)throw new SkillLearningInvalid();
    if(expected.preferences!==null&&expected.preferences!==undefined){
      const current=Number((await client.query('SELECT revision FROM public.expression_preference_state WHERE owner_id=$1',[scope.owner_id])).rows[0]?.revision??0);
      if(Number(expected.preferences)!==current)throw new SkillLearningInvalid();
    }
  }
  private async requireComparison(client:pg.Client,scope:SkillLearningScope,draft:SkillLearningDraftRow,comparison:Row,
    fingerprint?:string):Promise<void>{
    if(comparison.state==='invalidated'||draft.status!=='pending'||comparison.draft_id!==draft.id
      ||Number(comparison.draft_revision)!==Number(draft.revision)||comparison.id!==draft.current_comparison_id
      ||fingerprint!==undefined&&fingerprint!==comparison.context_fingerprint||!await authorizedContact(client,scope))
      throw new SkillLearningInvalid();
    if(!await reviewSourcesCurrent(client,scope,comparison.dependency_ids??[],comparison.source_generation?.sources??{},this.visit()))
      throw new SkillLearningInvalid();
    await this.requireRevisions(client,scope,comparison.source_generation.revisions);
    await this.requireTargets(client,scope,comparison.target_versions??[]);
  }
  private async payload(client:pg.Client,scope:SkillLearningScope,draft:SkillLearningDraftRow){
    const result:Row={...draftPayload(draft),comparison:null};
    if(draft.current_comparison_id&&draft.status==='pending'){
      const comparison=await this.comparison(client,scope,draft.current_comparison_id);
      try{
        await this.requireComparison(client,scope,draft,comparison);
        if(comparison.state==='completed')result.comparison=comparisonPayload(comparison);
      }catch(error){
        if(isSkillPersistenceError(error))throw error;
        await client.query(`UPDATE public.skill_review_comparison SET state='invalidated',input=NULL,confirmed_scope=NULL,
          context_fingerprint=NULL,dependency_ids='{}',source_generation='{}',target_versions='[]',result=NULL,
          run_token=NULL,lease_expires_at=NULL WHERE owner_id=$1 AND draft_id=$2`,
        [scope.owner_id,draft.id]);
        await client.query("UPDATE public.skill_review_operation SET request_fingerprint=NULL WHERE owner_id=$1 AND draft_id=$2 AND action='compare'",[scope.owner_id,draft.id]);
        await client.query('UPDATE public.skill_draft SET current_comparison_id=NULL WHERE id=$1',[draft.id]);
      }
    }
    const response:Row={draft:result};
    if(draft.status==='published'){
      const row=(await client.query(`SELECT version.skill_id,version.id AS version_id,skill.name,version.version_number,
        publication.scope_kind,publication.scope_contact_id,publication.scene,library.revision
        FROM public.reply_skill_version version JOIN public.reply_skill_publication publication ON publication.version_id=version.id
        JOIN public.reply_skill skill ON skill.id=version.skill_id JOIN public.skill_library library ON library.owner_id=publication.owner_id
        WHERE version.id=$1 AND version.status='active' AND NOT publication.deleted`,[draft.published_version_id])).rows[0];
      if(!row)throw new SkillLearningInvalid();
      response.published={skill_id:row.skill_id,version_id:row.version_id,name:row.name,
        version_number:Number(row.version_number),revision:Number(row.revision),
        scope:{kind:row.scope_kind,contact_id:row.scope_contact_id,scene:row.scene}};
    }
    return response;
  }
  async read(scope:SkillLearningScope,draftId:string){
    return this.options.transaction(async client=>this.payload(client,scope,await this.lockedDraft(client,scope,draftId)));
  }
  async change(scope:SkillLearningScope,command:{
    draftId:string;expectedRevision:number;operationKey:string;strategy?:Record<string,unknown>;decision?:'reject'|'defer';
  }){
    return this.options.transaction(async client=>{
      const draft=await this.lockedDraft(client,scope,command.draftId),action=command.strategy?'edit':'decision';
      const value={revision:command.expectedRevision,strategy:command.strategy??null,decision:command.decision??null};
      const previous=await this.operation(client,scope,command.operationKey);
      if(previous){
        if(previous.draft_id!==command.draftId||previous.action!==action||previous.request_fingerprint!==this.commandFingerprint(value))
          throw new SkillLearningInvalid();
        return this.payload(client,scope,draft);
      }
      this.requirePending(draft,command.expectedRevision);
      let strategy:ReturnType<typeof editedStrategy>|undefined;
      if(command.strategy){
        if(!draft.private_evidence||!draft.target_versions||!draft.strategy)throw new SkillLearningInvalid();
        strategy=editedStrategy(scope,draft,command.strategy);
        await this.requireSanitized(client,scope,strategy);
        for(const method of strategy.methods){
          await client.query(`INSERT INTO public.skill_method_identity(owner_id,logical_skill_id,method_id,semantic_key_sha256)
            VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [scope.owner_id,draft.logical_skill_id,method.method_id,skillContentDigest(method.key)]);
        }
      }
      await client.query(`UPDATE public.skill_review_comparison SET state='invalidated',input=NULL,confirmed_scope=NULL,
        context_fingerprint=NULL,dependency_ids='{}',source_generation='{}',target_versions='[]',result=NULL,
        run_token=NULL,lease_expires_at=NULL WHERE owner_id=$1 AND draft_id=$2`,[scope.owner_id,command.draftId]);
      await client.query("UPDATE public.skill_review_operation SET request_fingerprint=NULL WHERE owner_id=$1 AND draft_id=$2 AND action='compare'",[scope.owner_id,command.draftId]);
      await client.query(`UPDATE public.skill_draft SET revision=revision+1,strategy=coalesce($2,strategy),
        status=$3,last_decision=$4,current_comparison_id=NULL WHERE id=$1`,
      [command.draftId,strategy??null,command.decision==='reject'?'rejected':'pending',command.decision??null]);
      await this.recordOperation(client,scope,command.draftId,command.operationKey,action,value);
      const updated=await this.lockedDraft(client,scope,command.draftId);
      return this.payload(client,scope,updated);
    });
  }
  async beginComparison(scope:SkillLearningScope,command:{
    draftId:string;expectedRevision:number;operationKey:string;input:Row;scopeConfirmation:SkillPublicationScope;
    contextFingerprint:string;contextDependencies:string[];contextRevisions:Row;navigation:Row[];
    layered?:ReviewLayeredMaterial[];
  }){
    return this.options.transaction(async client=>{
      let draft=await this.lockedDraft(client,scope,command.draftId);
      const value={revision:command.expectedRevision,input:command.input,scope:command.scopeConfirmation};
      const previous=await this.operation(client,scope,command.operationKey);
      let comparison:Row,inputVersion:string,replay=false;
      if(previous){
        if(previous.draft_id!==command.draftId||previous.action!=='compare'||previous.request_fingerprint!==this.commandFingerprint(value))
          throw new SkillLearningInvalid();
        comparison=await this.comparison(client,scope,previous.comparison_id);
        await this.requireComparison(client,scope,draft,comparison,command.contextFingerprint);
        if(comparison.state==='completed')return {draft,comparison,replay:true};
        if(comparison.state==='running'&&comparison.lease_expires_at&&new Date(comparison.lease_expires_at)>this.now())
          throw new SkillLearningInvalid();
        inputVersion=comparison.input_version;
      }else{
        this.requirePending(draft,command.expectedRevision);inputVersion=randomUUID();
      }
      if(!draft.strategy)throw new SkillLearningInvalid();
      await this.requireSanitized(client,scope,draft.strategy);
      if(!await authorizedContact(client,scope))throw new SkillLearningInvalid();
      await this.requireTargets(client,scope,draft.target_versions??[]);
      const captured=await captureReviewSources(client,scope,draft.dependency_ids??[],
        command.contextDependencies,command.navigation,draft.target_versions??[],this.visit(),command.layered??[]);
      const revisions={...command.contextRevisions};
      await this.requireRevisions(client,scope,revisions);
      const token=randomUUID(),comparisonId=previous?.comparison_id??randomUUID();
      if(!previous){
        await client.query(`UPDATE public.skill_review_comparison SET state='invalidated',input=NULL,confirmed_scope=NULL,
          context_fingerprint=NULL,dependency_ids='{}',source_generation='{}',target_versions='[]',result=NULL,
          run_token=NULL,lease_expires_at=NULL WHERE owner_id=$1 AND draft_id=$2`,[scope.owner_id,command.draftId]);
        await client.query(`INSERT INTO public.skill_review_comparison(id,owner_id,contact_id,draft_id,draft_revision,
          input_version,input,confirmed_scope,context_fingerprint,library_revision,dependency_ids,source_generation,
          target_versions,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'failed')`,
        [comparisonId,scope.owner_id,scope.contact_id,command.draftId,command.expectedRevision,inputVersion,
          command.input,command.scopeConfirmation,command.contextFingerprint,command.contextRevisions.library,
          captured.dependencies,{sources:captured.frozen,revisions},JSON.stringify(draft.target_versions)]);
        await client.query('UPDATE public.skill_draft SET current_comparison_id=$2 WHERE id=$1',[command.draftId,comparisonId]);
        await this.recordOperation(client,scope,command.draftId,command.operationKey,'compare',value,comparisonId);
      }
      await client.query(`UPDATE public.skill_review_comparison SET state='running',run_token=$2,lease_expires_at=$3 WHERE id=$1`,
        [comparisonId,token,new Date(this.now().getTime()+120_000)]);
      return {draft,comparison:await this.comparison(client,scope,comparisonId),replay};
    });
  }
  async validateComparison(scope:SkillLearningScope,id:string,token:string,fingerprint:string,withExecutionView=false){
    return this.options.transaction(async client=>{
      const comparison=await this.comparison(client,scope,id);
      const draft=await this.lockedDraft(client,scope,comparison.draft_id);
      const current=await this.comparison(client,scope,id);
      await this.requireComparison(client,scope,draft,current,fingerprint);
      if(current.state!=='running'||current.run_token!==token||!current.lease_expires_at
        ||new Date(current.lease_expires_at)<=this.now())throw new SkillLearningInvalid();
      if(!withExecutionView)return {draft,comparison:current};
      const projection=await projectDraftExecution(client,scope,draft,id,current.input.scene);
      return {draft,comparison:current,projection};
    });
  }
  async finishComparison(scope:SkillLearningScope,id:string,token:string,fingerprint:string,result:unknown){
    return this.options.transaction(async client=>{
      const comparison=await this.comparison(client,scope,id);
      const draft=await this.lockedDraft(client,scope,comparison.draft_id);
      const current=await this.comparison(client,scope,id);
      await this.requireComparison(client,scope,draft,current,fingerprint);
      if(current.state!=='running'||current.run_token!==token||!current.lease_expires_at
        ||new Date(current.lease_expires_at)<=this.now())throw new SkillLearningInvalid();
      await client.query("UPDATE public.skill_review_comparison SET state='completed',result=$2,run_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [id,result]);
      return this.payload(client,scope,draft);
    });
  }
  async failComparison(scope:SkillLearningScope,id:string,token:string):Promise<void>{
    await this.options.transaction(async client=>{
      await locks(client,scope);
      await client.query(`UPDATE public.skill_review_comparison SET state='failed',run_token=NULL,lease_expires_at=NULL
        WHERE id=$1 AND owner_id=$2 AND contact_id=$3 AND state='running' AND run_token=$4`,
      [id,scope.owner_id,scope.contact_id,token]);
    });
  }
  async recordCall(scope:SkillLearningScope,comparisonId:string,side:'before'|'after',entryId:string):Promise<void>{
    await this.options.transaction(async client=>{
      await client.query(`INSERT INTO public.skill_review_call(comparison_id,owner_id,contact_id,side,ledger_entry_id)
        SELECT id,owner_id,contact_id,$4,$5 FROM public.skill_review_comparison WHERE id=$1 AND owner_id=$2 AND contact_id=$3`,
      [comparisonId,scope.owner_id,scope.contact_id,side,entryId]);
    });
  }
  private async publishReviewed(client:pg.Client,scope:SkillLearningScope,draft:SkillLearningDraftRow,
    confirmed:SkillPublicationScope,dependencies:string[],sourceGeneration:Row):Promise<Row>{
    const strategy=draft.strategy;if(!strategy)throw new SkillLearningInvalid();
    let pkg:SkillPackage;
    try{pkg=validatePackage(strategy.name,Buffer.from(strategy.document),[]);}catch{throw new SkillLearningInvalid();}
    const skillId=draft.logical_skill_id,targets=draft.target_versions??[];
    let skill=(await client.query('SELECT id,name,status FROM public.reply_skill WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [scope.owner_id,skillId])).rows[0];
    await client.query('INSERT INTO public.skill_library(owner_id,revision) VALUES($1,0) ON CONFLICT DO NOTHING',[scope.owner_id]);
    const conflict=(await client.query('SELECT id FROM public.reply_skill WHERE owner_id=$1 AND name=$2 AND id<>$3',
      [scope.owner_id,pkg.name,skillId])).rows[0];
    if(conflict||skill&&(skill.status!=='active'||skill.name!==pkg.name))throw new SkillLearningInvalid();
    if(draft.proposal_kind==='create'){
      if(skill||targets.length)throw new SkillLearningInvalid();
      await client.query("INSERT INTO public.reply_skill(id,owner_id,contact_id,name,status) VALUES($1,$2,NULL,$3,'active')",
        [skillId,scope.owner_id,pkg.name]);
    }else if(!skill||!targets.length||targets[0].skill_id!==skillId)throw new SkillLearningInvalid();
    for(const target of targets){
      if(!(await client.query(`SELECT 1 FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id
        WHERE skill.owner_id=$1 AND skill.id=$2 AND skill.status='active' AND version.id=$3 AND version.is_current
          AND version.enabled AND version.status='active' FOR UPDATE OF version,skill`,
      [scope.owner_id,target.skill_id,target.version_id])).rowCount)throw new SkillLearningInvalid();
    }
    const number=Number((await client.query('SELECT coalesce(max(version_number),0)+1 AS number FROM public.reply_skill_version WHERE skill_id=$1',
      [skillId])).rows[0].number),versionId=randomUUID();
    const location=this.options.files.prepareVersion(scope.owner_id,skillId,versionId,pkg);
    await client.query('UPDATE public.reply_skill_version SET is_current=false WHERE skill_id=$1 AND is_current',[skillId]);
    await client.query(`INSERT INTO public.reply_skill_version(id,skill_id,version_number,content_sha256,source_locator,
      enabled,is_current,status,content_path,document_sha256,manifest_sha256)
      VALUES($1,$2,$3,$4,$5,true,true,'active',$6,$7,$8)`,
    [versionId,skillId,number,pkg.content_sha256,`reviewed-draft:${draft.id}`,location.content_path,location.document_sha256,location.manifest_sha256]);
    const methods:SkillMethod[]=strategy.methods.map((method:Row)=>({method_id:method.method_id,title:method.title,instruction:method.instruction}));
    const methodLocation=this.options.files.prepareMethods(scope.owner_id,skillId,versionId,methods);
    await client.query('UPDATE public.reply_skill_version SET method_manifest_path=$2,method_manifest_sha256=$3,review_origin=true WHERE id=$1',
      [versionId,methodLocation.method_manifest_path,methodLocation.method_manifest_sha256]);
    await client.query('INSERT INTO public.reply_skill_working_copy(skill_id,version_id) VALUES($1,$2) ON CONFLICT(skill_id) DO UPDATE SET version_id=excluded.version_id',[skillId,versionId]);
    await client.query('UPDATE public.reply_skill SET updated_at=now() WHERE id=$1',[skillId]);
    for(const target of targets.slice(1)){
      await client.query("UPDATE public.reply_skill SET status='disabled',updated_at=now() WHERE owner_id=$1 AND id=$2",
        [scope.owner_id,target.skill_id]);
    }
    await client.query(`INSERT INTO public.reply_skill_publication(version_id,owner_id,origin_contact_id,draft_id,
      logical_skill_id,scope_kind,scope_contact_id,scene,dependency_ids,source_generation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [versionId,scope.owner_id,scope.contact_id,draft.id,skillId,confirmed.kind,confirmed.contact_id,confirmed.scene,
      dependencies,sourceGeneration]);
    for(const [ordinal,method] of strategy.methods.entries()){
      await client.query(`INSERT INTO public.reply_skill_method(version_id,method_id,logical_skill_id,ordinal,
        replaces_method_ids,mapping_state) VALUES($1,$2,$3,$4,$5,$6)`,
      [versionId,method.method_id,method.logical_skill_id,ordinal,method.replaces_method_ids,
        targets.length?'confirmed':'new']);
    }
    const revision=Number((await client.query('UPDATE public.skill_library SET revision=revision+1,updated_at=now() WHERE owner_id=$1 RETURNING revision',
      [scope.owner_id])).rows[0].revision);
    return {skill_id:skillId,version_id:versionId,name:pkg.name,version_number:number,revision,scope:confirmed};
  }
  async approve(scope:SkillLearningScope,command:{
    draftId:string;expectedRevision:number;operationKey:string;comparisonId:string;scopeConfirmation:SkillPublicationScope;
  }){
    const result=await this.options.transaction(async client=>{
      let draft=await this.lockedDraft(client,scope,command.draftId);
      const value={revision:command.expectedRevision,comparison_id:command.comparisonId,scope:command.scopeConfirmation};
      const previous=await this.operation(client,scope,command.operationKey);
      if(previous){
        if(previous.draft_id!==command.draftId||previous.action!=='approve'||previous.request_fingerprint!==this.commandFingerprint(value))
          throw new SkillLearningInvalid();
        return this.payload(client,scope,draft);
      }
      this.requirePending(draft,command.expectedRevision);
      if(!draft.strategy)throw new SkillLearningInvalid();
      await this.requireSanitized(client,scope,draft.strategy);
      const comparison=await this.comparison(client,scope,command.comparisonId);
      await this.requireComparison(client,scope,draft,comparison);
      if(comparison.state!=='completed'||canonicalJSON(comparison.confirmed_scope)!==canonicalJSON(command.scopeConfirmation)
        ||!comparison.result?.after||comparison.result.after.load_state!=='loaded')throw new SkillLearningInvalid();
      const published=await this.publishReviewed(client,scope,draft,command.scopeConfirmation,
        comparison.dependency_ids??[],comparison.source_generation??{});
      await client.query(`UPDATE public.skill_draft SET status='published',revision=revision+1,last_decision='approve',
        published_version_id=$2 WHERE id=$1`,[command.draftId,published.version_id]);
      await this.recordOperation(client,scope,command.draftId,command.operationKey,'approve',value,
        command.comparisonId,published.version_id);
      const updated=await this.lockedDraft(client,scope,command.draftId);
      return this.payload(client,scope,updated);
    });
    await this.options.library.reconcileFiles(scope.owner_id);
    return result;
  }
}
