/** 唯一任务 Worker 的学习步骤：有界提案与来源复核，不持有HTTP发布权限。 */
import type {ExtractionClaim} from './extraction-task-store.ts';
import type {ExtractionWorkerResult,ExtractionWorkerRunner} from './extraction-worker.ts';
import {SkillLearningError,SkillLearningInvalid,type SkillLearningScope} from './skill-learning-contract.ts';
import type {SkillLearningRuntime} from './skill-learning-runtime.ts';
import type {SkillLearningStore} from './skill-learning-store.ts';

export interface SkillLearningTaskRunnerOptions {
  store:SkillLearningStore;
  runtime?:SkillLearningRuntime;
}
export class SkillLearningTaskRunner implements ExtractionWorkerRunner {
  private readonly options:SkillLearningTaskRunnerOptions;
  constructor(options:SkillLearningTaskRunnerOptions){this.options=options;}
  async run(claim:ExtractionClaim,signal:AbortSignal):Promise<ExtractionWorkerResult>{
    if(claim.taskType!=='skill_learning'||!['propose_skill','verify_skill_drafts'].includes(claim.stepName)
      ||claim.contactId===null)throw new SkillLearningInvalid();
    const scope:SkillLearningScope={owner_id:claim.ownerId,contact_id:claim.contactId};
    if(claim.stepName==='verify_skill_drafts'){
      await this.options.store.verify(scope);return {processedCount:0,totalCount:claim.messageCount};
    }
    if(!this.options.runtime)throw new SkillLearningError('skill_learning_unavailable',503,true);
    const batch=await this.options.store.capture(scope);
    signal.throwIfAborted();
    if(!batch.ready)return {processedCount:0,totalCount:claim.messageCount};
    const value=await this.options.runtime.propose(scope,claim,batch,signal);
    signal.throwIfAborted();
    const processed=await this.options.store.save(scope,claim,batch,value);
    return {processedCount:processed,totalCount:processed};
  }
}
