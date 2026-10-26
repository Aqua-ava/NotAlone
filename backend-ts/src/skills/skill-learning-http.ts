/** 学习、审核、版本政策公开 HTTP；认证与桌面控制器合同沿用原路由。 */
import {DatabaseError} from 'pg';
import {
  SkillLearningError,policyScope,publicationScope,reviewInput,type SkillLearningScope,
} from './skill-learning-contract.ts';
import type {SkillLearningStore} from './skill-learning-store.ts';
import type {SkillReviewService} from './skill-review-service.ts';
import type {SkillReviewStore} from './skill-review-store.ts';
import type {SkillHistoryPolicyStore} from './skill-history-policy-store.ts';
type Row=Record<string,any>;
export interface SkillLearningHttpOptions {
  ownerId?:string;
  learning:SkillLearningStore;
  review:SkillReviewStore;
  reviewService?:SkillReviewService;
  historyPolicy:SkillHistoryPolicyStore;
  canSchedule:boolean;
  wake:(scope:SkillLearningScope,taskId:string)=>Promise<void>;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exact(value:unknown,keys:string[]):value is Row{
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  return Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
function invalid():never{throw new SkillLearningError('skill_learning_request_invalid',400);}
function id(value:unknown):string {
  if(typeof value!=='string'||!uuid.test(value))invalid();
  return value.toLowerCase();
}
function revision(value:unknown,minimum=1):number{
  if(!Number.isSafeInteger(value)||Number(value)<minimum)invalid();return Number(value);
}
function parse<T>(operation:()=>T):T {
  try{return operation();}catch{invalid();}
}
function databaseUnavailable(error:unknown):boolean{
  const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  return error instanceof DatabaseError||/^[0-9A-Z]{5}$/.test(code)
    ||['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE'].includes(code);
}
export class SkillLearningHttp {
  private readonly options:SkillLearningHttpOptions;
  constructor(options:SkillLearningHttpOptions){this.options=options;}
  async notify(scope:SkillLearningScope,forceRetry=false):Promise<void>{
    if(!this.options.canSchedule)return;
    const taskId=await this.options.learning.enqueue(scope,forceRetry);
    if(taskId){
      try{await this.options.wake(scope,taskId);}
      catch{/* 持久任务已提交；后续权威读取会重新唤醒，临时资源故障不改写用户决定。 */}
    }
  }
  private async command(scope:SkillLearningScope,parts:string[],method:string,body:unknown,signal:AbortSignal){
    if(parts.length===5&&parts[4]==='policies'){
      if(method==='GET')return this.options.historyPolicy.readPolicies(scope);
      if(method!=='POST')throw new SkillLearningError('method_not_allowed',405);
      if(!exact(body,['skill_id','version_id','method_id','scope','disabled','expected_revision','operation_key'])
        ||typeof body.disabled!=='boolean')invalid();
      return this.options.historyPolicy.changePolicy(scope,{skillId:id(body.skill_id),versionId:id(body.version_id),
        methodId:body.method_id===null?null:id(body.method_id),
        scope:parse(()=>policyScope(body.scope,scope.contact_id)),disabled:body.disabled,
        expectedRevision:revision(body.expected_revision,0),operationKey:id(body.operation_key)});
    }
    if(parts.length===7&&parts[4]==='policies'&&parts[6]==='undo'&&method==='POST'){
      if(!exact(body,['expected_revision','operation_key']))invalid();
      return this.options.historyPolicy.undoPolicy(scope,{policyId:id(parts[5]),
        expectedRevision:revision(body.expected_revision,0),operationKey:id(body.operation_key)});
    }
    if((parts.length===5||parts.length===6)&&parts[4]==='skills'&&method==='GET')
      return this.options.historyPolicy.readHistory(scope,parts.length===6?id(parts[5]):undefined);
    if(parts.length===7&&parts[4]==='skills'&&parts[6]==='rollback'&&method==='POST'){
      if(!exact(body,['version_id','expected_revision','expected_current_version_id','operation_key'])
        ||body.expected_current_version_id!==null&&typeof body.expected_current_version_id!=='string')
        invalid();
      return this.options.historyPolicy.rollback(scope,{skillId:id(parts[5]),versionId:id(body.version_id),
        expectedRevision:revision(body.expected_revision,0),
        expectedCurrentVersionId:body.expected_current_version_id===null?null:id(body.expected_current_version_id),
        operationKey:id(body.operation_key)});
    }
    if(parts.length===6&&parts[4]==='drafts'&&method==='GET')
      return this.options.review.read(scope,id(parts[5]));
    if(parts.length!==7||parts[4]!=='drafts'||method!=='POST')throw new SkillLearningError('not_found',404);
    const draftId=id(parts[5]),action=parts[6];
    if(!['edit','compare','approve','decision'].includes(action))throw new SkillLearningError('not_found',404);
    if(!body||typeof body!=='object'||Array.isArray(body))invalid();
    const common=['expected_revision','operation_key'];
    const expectedRevision=revision((body as Row).expected_revision,1),operationKey=id((body as Row).operation_key);
    if(action==='edit'){
      if(!exact(body,[...common,'strategy'])||!body.strategy||typeof body.strategy!=='object'||Array.isArray(body.strategy))
        invalid();
      return this.options.review.change(scope,{draftId,expectedRevision,operationKey,strategy:body.strategy as Row});
    }
    if(action==='decision'){
      if(!exact(body,[...common,'decision'])||!['reject','defer'].includes(body.decision))
        invalid();
      return this.options.review.change(scope,{draftId,expectedRevision,operationKey,decision:body.decision});
    }
    if(action==='compare'){
      if(!exact(body,[...common,'input','scope']))invalid();
      const input=parse(()=>reviewInput(body.input));
      if(!this.options.reviewService)throw new SkillLearningError('skill_learning_unavailable',503,true);
      return this.options.reviewService.compare(scope,{draftId,expectedRevision,operationKey,input,
        scopeConfirmation:parse(()=>publicationScope(body.scope,scope.contact_id,input.scene))},signal);
    }
    if(!exact(body,[...common,'comparison_id','scope','confirmed','replacements_confirmed'])
      ||body.confirmed!==true||body.replacements_confirmed!==true||typeof body.comparison_id!=='string')
      invalid();
    return this.options.review.approve(scope,{draftId,expectedRevision,operationKey,
      comparisonId:id(body.comparison_id),scopeConfirmation:parse(()=>publicationScope(body.scope,scope.contact_id))});
  }
  async handle(method:string,url:URL,body:unknown,signal:AbortSignal):Promise<{status:number;body:unknown}>{
    try{
      if(!this.options.ownerId||!url.pathname.startsWith('/api/contacts/')||url.search)throw new SkillLearningError('invalid_request',400);
      const parts=url.pathname.replace(/\/$/,'').split('/').filter(Boolean);
      if(parts.length<4||parts[0]!=='api'||parts[1]!=='contacts'||parts[3]!=='skill-learning'||!uuid.test(parts[2]))
        throw new SkillLearningError('not_found',404);
      const scope={owner_id:this.options.ownerId!,contact_id:parts[2].toLowerCase()};
      if(parts.length===4){
        if(method==='GET'){
          await this.notify(scope);
          return {status:200,body:await this.options.learning.list(scope)};
        }
        if(method!=='POST')throw new SkillLearningError('method_not_allowed',405);
        if(!body||typeof body!=='object'||Array.isArray(body))invalid();
        if(exact(body,['resume'])&&body.resume===true){
          if(!this.options.canSchedule)throw new SkillLearningError('skill_learning_unavailable',503,true);
          await this.notify(scope,true);return {status:200,body:await this.options.learning.list(scope)};
        }
        if(!exact(body,['enabled','confirmed','operation_key','expected_revision'])||body.confirmed!==true
          ||typeof body.enabled!=='boolean')invalid();
        await this.options.learning.configure(scope,{enabled:body.enabled,operationKey:id(body.operation_key),
          expectedRevision:revision(body.expected_revision,0)});
        await this.notify(scope);return {status:200,body:await this.options.learning.list(scope)};
      }
      return {status:200,body:await this.command(scope,parts,method,body,signal)};
    }catch(error){
      if(signal.aborted)return {status:503,body:{error:'runtime_stopping'}};
      if(error instanceof SkillLearningError)return {status:error.status,body:{error:error.code}};
      if(databaseUnavailable(error))return {status:503,body:{error:'skill_learning_unavailable'}};
      return {status:500,body:{error:'internal_error'}};
    }
  }
}
export function skillLearningRoute(_method:string,pathname:string):boolean{
  return /^\/api\/contacts\/[^/]+\/skill-learning(?:\/|$)/.test(pathname);
}
