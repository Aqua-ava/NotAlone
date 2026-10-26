/** 版本历史、合法回滚与明确范围方法停用；只保存无正文用户决定。 */
import type pg from 'pg';
import type {SkillFiles,SkillVersionFiles} from './skill-files.ts';
import type {SkillLibrary} from './skill-library.ts';
import {wholeStrategyId} from './skill-execution-view.ts';
import {
  SkillLearningInvalid,SkillLearningNotFound,skillContentDigest,skillUuid5,
  type SkillLearningScope,type SkillPublicationScope,
} from './skill-learning-contract.ts';
import {captureParentPublications,isSkillPersistenceError,requireVersionSources,type SkillDiscussionValidator} from './skill-source-proof.ts';
type Transaction=<T>(operation:(client:pg.Client)=>Promise<T>)=>Promise<T>;
type Row=Record<string,any>;
export interface SkillHistoryPolicyOptions {
  transaction:Transaction;
  files:SkillFiles;
  library:SkillLibrary;
  requireDiscussionDependencies?:SkillDiscussionValidator;
}
async function locks(client:pg.Client,scope:SkillLearningScope){
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${scope.owner_id}:${scope.contact_id}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
  if(!(await client.query("SELECT 1 FROM public.conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active'",
    [scope.owner_id,scope.contact_id])).rowCount)throw new SkillLearningNotFound();
}
function scopeResult(row:Row):SkillPublicationScope{
  return {kind:row.scope_kind??'owner',contact_id:row.scope_contact_id??null,scene:row.scene??null};
}
export class SkillHistoryPolicyStore {
  private readonly options:SkillHistoryPolicyOptions;
  constructor(options:SkillHistoryPolicyOptions){this.options=options;}
  private visit(){return {checking:new Set<string>(),validated:new Set<string>(),
    requireDiscussionDependencies:this.options.requireDiscussionDependencies};}
  private fingerprint(value:unknown){return skillContentDigest(value);}
  private async history(client:pg.Client,scope:SkillLearningScope,skillId:string){
    const skill=(await client.query(`SELECT id,name,status FROM public.reply_skill WHERE owner_id=$1 AND id=$2
      AND status<>'deleted' AND (contact_id IS NULL OR contact_id=$3)`,[scope.owner_id,skillId,scope.contact_id])).rows[0];
    if(!skill)throw new SkillLearningNotFound();
    const rows=(await client.query(`SELECT version.*,publication.scope_kind,publication.scope_contact_id,publication.scene,
      skill.owner_id,skill.name FROM public.reply_skill_version version JOIN public.reply_skill skill ON skill.id=version.skill_id
      LEFT JOIN public.reply_skill_publication publication ON publication.version_id=version.id
      WHERE version.skill_id=$1 AND version.status='active' AND version.content_path IS NOT NULL
      ORDER BY version.version_number DESC`,[skillId])).rows;
    const versions:Row[]=[];let current:string|null=null;
    for(const row of rows){
      try{
        await requireVersionSources(client,scope.owner_id,row.id,scope.contact_id,this.options.requireDiscussionDependencies);
        const document=this.options.files.readContent(row as SkillVersionFiles);
        const identities=(await client.query(`SELECT method_id,replaces_method_ids,mapping_state
          FROM public.reply_skill_method WHERE version_id=$1 ORDER BY ordinal`,[row.id])).rows;
        const bodies=identities.length?this.options.files.readMethods(row as SkillVersionFiles,
          identities.map(item=>item.method_id)):[];
        const bodyById=new Map(bodies.map(item=>[item.method_id,item]));
        const methods=identities.map(item=>{
          const body=bodyById.get(item.method_id);if(!body)throw new Error('method_missing');
          return {method_id:item.method_id,title:body.title,instruction:body.instruction,
            replaces_method_ids:item.replaces_method_ids,mapping_state:item.mapping_state};
        });
        const {inherited}=await captureParentPublications(client,scope.owner_id,scope.contact_id,[row.id],this.visit());
        versions.push({version_id:row.id,version_number:Number(row.version_number),document,
          is_current:Boolean(row.is_current),enabled:Boolean(row.enabled),scope:scopeResult(row),methods,
          source_dependency_count:inherited.size});
        if(row.is_current)current=row.id;
      }catch(error){
        if(isSkillPersistenceError(error))throw error;
        if(row.is_current)throw new SkillLearningNotFound();
      }
    }
    if(!versions.length)throw new SkillLearningNotFound();
    const revisionTable=(await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[scope.owner_id])).rows[0];
    return {skill_id:skillId,name:skill.name,status:skill.status,revision:Number(revisionTable?.revision??0),
      current_version_id:current,versions};
  }
  async readHistory(scope:SkillLearningScope,skillId?:string){
    return this.options.transaction(async client=>{
      await locks(client,scope);
      if(skillId)return this.history(client,scope,skillId);
      const rows=(await client.query(`SELECT id FROM public.reply_skill WHERE owner_id=$1 AND status<>'deleted'
        AND (contact_id IS NULL OR contact_id=$2) ORDER BY name,id`,[scope.owner_id,scope.contact_id])).rows;
      const skills:Row[]=[];
      for(const row of rows){try{skills.push(await this.history(client,scope,row.id));}catch(error){if(!(error instanceof SkillLearningNotFound))throw error;}}
      return {skills};
    });
  }
  async rollback(scope:SkillLearningScope,command:{
    skillId:string;versionId:string;expectedRevision:number;
    expectedCurrentVersionId:string|null;operationKey:string;
  }){
    let changed=false;
    const result=await this.options.transaction(async client=>{
      await locks(client,scope);
      let history=await this.history(client,scope,command.skillId);
      if(!history.versions.some((item:Row)=>item.version_id===command.versionId))throw new SkillLearningInvalid();
      const value={skill_id:command.skillId,version_id:command.versionId,revision:command.expectedRevision,
        current:command.expectedCurrentVersionId};
      const previous=(await client.query(`SELECT * FROM public.skill_history_operation
        WHERE owner_id=$1 AND contact_id=$2 AND operation_key=$3`,[scope.owner_id,scope.contact_id,command.operationKey])).rows[0];
      if(previous){
        if(previous.request_fingerprint!==this.fingerprint(value)||Number(previous.result_revision)!==history.revision
          ||history.current_version_id!==previous.version_id)throw new SkillLearningInvalid();
        return history;
      }
      if(Number(history.revision)!==command.expectedRevision||history.current_version_id!==command.expectedCurrentVersionId)
        throw new SkillLearningInvalid();
      const target=(await client.query(`SELECT version.*,skill.owner_id,skill.name FROM public.reply_skill_version version
        JOIN public.reply_skill skill ON skill.id=version.skill_id
        WHERE version.id=$1 AND version.skill_id=$2 AND version.status='active'
          AND version.content_path IS NOT NULL AND version.enabled`,[command.versionId,command.skillId])).rows[0];
      if(!target)throw new SkillLearningInvalid();
      await requireVersionSources(client,scope.owner_id,command.versionId,scope.contact_id,this.options.requireDiscussionDependencies);
      this.options.files.readContent(target as SkillVersionFiles);
      let revision=Number(history.revision);
      if(history.current_version_id!==command.versionId){
        changed=true;
        await client.query('UPDATE public.reply_skill_version SET is_current=false WHERE skill_id=$1 AND is_current',[command.skillId]);
        await client.query('UPDATE public.reply_skill_version SET is_current=true WHERE id=$1',[command.versionId]);
        await client.query('UPDATE public.reply_skill SET updated_at=now() WHERE id=$1',[command.skillId]);
        await client.query(`INSERT INTO public.reply_skill_working_copy(skill_id,version_id) VALUES($1,$2)
          ON CONFLICT(skill_id) DO UPDATE SET version_id=excluded.version_id`,[command.skillId,command.versionId]);
        revision=Number((await client.query('UPDATE public.skill_library SET revision=revision+1,updated_at=now() WHERE owner_id=$1 RETURNING revision',
          [scope.owner_id])).rows[0].revision);
      }
      await client.query(`INSERT INTO public.skill_history_operation(owner_id,contact_id,operation_key,skill_id,version_id,
        request_fingerprint,result_revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [scope.owner_id,scope.contact_id,command.operationKey,command.skillId,command.versionId,this.fingerprint(value),revision]);
      history=await this.history(client,scope,command.skillId);return history;
    });
    if(changed)await this.options.library.reconcileFiles(scope.owner_id);
    return result;
  }
  private async currentPolicies(client:pg.Client,scope:SkillLearningScope){
    const state=(await client.query('SELECT revision FROM public.skill_policy_state WHERE owner_id=$1',[scope.owner_id])).rows[0];
    const rows=(await client.query(`SELECT policy.*,skill.name FROM public.skill_scope_policy policy
      JOIN public.reply_skill skill ON skill.id=policy.skill_id WHERE policy.owner_id=$1
      AND (policy.contact_id IS NULL OR policy.contact_id=$2) ORDER BY policy.id`,[scope.owner_id,scope.contact_id])).rows;
    return {revision:Number(state?.revision??0),policies:rows.map(row=>({policy_id:row.id,skill_id:row.skill_id,
      name:row.name,method_id:row.method_id,scope:{kind:row.scope_kind,contact_id:row.contact_id,scene:row.scene},
      revision:Number(row.revision)}))};
  }
  async readPolicies(scope:SkillLearningScope){
    return this.options.transaction(async client=>{await locks(client,scope);return this.currentPolicies(client,scope);});
  }
  private async requirePolicyTarget(client:pg.Client,scope:SkillLearningScope,skillId:string,versionId:string,methodId:string|null){
    if(!(await client.query(`SELECT 1 FROM public.reply_skill WHERE owner_id=$1 AND id=$2 AND status<>'deleted'
      AND (contact_id IS NULL OR contact_id=$3)`,[scope.owner_id,skillId,scope.contact_id])).rowCount)throw new SkillLearningNotFound();
    const version=(await client.query(`SELECT is_current FROM public.reply_skill_version WHERE skill_id=$1 AND id=$2
      AND status='active' AND content_path IS NOT NULL`,[skillId,versionId])).rows[0];
    if(!version)throw new SkillLearningInvalid();
    try{await requireVersionSources(client,scope.owner_id,versionId,scope.contact_id,this.options.requireDiscussionDependencies);}
    catch(error){
      if(isSkillPersistenceError(error))throw error;
      if(version.is_current)throw new SkillLearningNotFound();throw new SkillLearningInvalid();
    }
    if(methodId===null)return;
    const found=(await client.query('SELECT 1 FROM public.reply_skill_method WHERE version_id=$1 AND method_id=$2',[versionId,methodId])).rowCount;
    const whole=methodId===wholeStrategyId(skillId)
      &&!(await client.query('SELECT 1 FROM public.reply_skill_method WHERE version_id=$1 LIMIT 1',[versionId])).rowCount;
    if(!found&&!whole)throw new SkillLearningInvalid();
  }
  async changePolicy(scope:SkillLearningScope,command:{
    skillId:string;versionId:string;methodId:string|null;scope:SkillPublicationScope;disabled:boolean;
    expectedRevision:number;operationKey:string;
  }){
    return this.options.transaction(async client=>{
      await locks(client,scope);
      await this.requirePolicyTarget(client,scope,command.skillId,command.versionId,command.methodId);
      const current=await this.currentPolicies(client,scope);
      const value={skill:command.skillId,version:command.versionId,method:command.methodId,scope:command.scope,
        disabled:command.disabled,revision:command.expectedRevision};
      const previous=(await client.query(`SELECT * FROM public.skill_policy_operation
        WHERE owner_id=$1 AND contact_id=$2 AND operation_key=$3`,[scope.owner_id,scope.contact_id,command.operationKey])).rows[0];
      if(previous){
        if(previous.request_fingerprint!==this.fingerprint(value)||Number(previous.result_revision)!==current.revision)
          throw new SkillLearningInvalid();
        return current;
      }
      if(current.revision!==command.expectedRevision)throw new SkillLearningInvalid();
      const identity={skill:command.skillId,method:command.methodId,scope:command.scope};
      const policyId=skillUuid5(scope.owner_id,`skill-policy:${this.fingerprint(identity)}`);
      const existing=Boolean((await client.query('SELECT 1 FROM public.skill_scope_policy WHERE owner_id=$1 AND id=$2',
        [scope.owner_id,policyId])).rowCount);
      const changed=existing!==command.disabled;
      if(changed){
        const revision=current.revision+1;
        await client.query(`INSERT INTO public.skill_policy_state(owner_id,revision) VALUES($1,$2)
          ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision`,[scope.owner_id,revision]);
        if(command.disabled)await client.query(`INSERT INTO public.skill_scope_policy(id,owner_id,skill_id,method_id,
          scope_kind,contact_id,scene,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [policyId,scope.owner_id,command.skillId,command.methodId,command.scope.kind,command.scope.contact_id,command.scope.scene,revision]);
        else await client.query('DELETE FROM public.skill_scope_policy WHERE owner_id=$1 AND id=$2',[scope.owner_id,policyId]);
        await client.query(`INSERT INTO public.skill_library(owner_id,revision) VALUES($1,1)
          ON CONFLICT(owner_id) DO UPDATE SET revision=public.skill_library.revision+1`,[scope.owner_id]);
      }
      await client.query(`INSERT INTO public.skill_policy_operation(owner_id,contact_id,operation_key,request_fingerprint,result_revision)
        VALUES($1,$2,$3,$4,$5)`,[scope.owner_id,scope.contact_id,command.operationKey,this.fingerprint(value),
        current.revision+Number(changed)]);
      return this.currentPolicies(client,scope);
    });
  }
  async undoPolicy(scope:SkillLearningScope,command:{policyId:string;expectedRevision:number;operationKey:string}){
    return this.options.transaction(async client=>{
      await locks(client,scope);
      const current=await this.currentPolicies(client,scope);
      const value={policy_id:command.policyId,revision:command.expectedRevision,action:'undo'};
      const previous=(await client.query(`SELECT * FROM public.skill_policy_operation
        WHERE owner_id=$1 AND contact_id=$2 AND operation_key=$3`,[scope.owner_id,scope.contact_id,command.operationKey])).rows[0];
      if(previous){
        if(previous.request_fingerprint!==this.fingerprint(value)||Number(previous.result_revision)!==current.revision)
          throw new SkillLearningInvalid();
        return current;
      }
      if(current.revision!==command.expectedRevision)throw new SkillLearningInvalid();
      if(!current.policies.some(item=>item.policy_id===command.policyId))throw new SkillLearningNotFound();
      await client.query('DELETE FROM public.skill_scope_policy WHERE owner_id=$1 AND id=$2',[scope.owner_id,command.policyId]);
      const revision=current.revision+1;
      await client.query('UPDATE public.skill_policy_state SET revision=$2 WHERE owner_id=$1',[scope.owner_id,revision]);
      await client.query('UPDATE public.skill_library SET revision=revision+1,updated_at=now() WHERE owner_id=$1',[scope.owner_id]);
      await client.query(`INSERT INTO public.skill_policy_operation(owner_id,contact_id,operation_key,request_fingerprint,result_revision)
        VALUES($1,$2,$3,$4,$5)`,[scope.owner_id,scope.contact_id,command.operationKey,this.fingerprint(value),revision]);
      return this.currentPolicies(client,scope);
    });
  }
}
