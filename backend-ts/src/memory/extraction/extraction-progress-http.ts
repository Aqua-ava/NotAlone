/** 记忆处理状态与显式恢复路由；不读正文，也不启动第二个 Worker。 */
import {ExtractionTaskError,type ExtractionTaskStore} from './extraction-task-store.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ExtractionProgressResponse {status:number;body:unknown}
export interface ExtractionProgressApiOptions {
  /** 仅在任务已持久化为queued后提示既有唯一Worker；不直接执行模型。 */
  wake?:(scope:{ownerId:string;contactId:string},taskId:string)=>void|Promise<void>;
}

export class ExtractionProgressApi {
  private readonly store:ExtractionTaskStore;
  private readonly ownerId:string;
  private readonly wake:ExtractionProgressApiOptions['wake'];
  constructor(store:ExtractionTaskStore,ownerId:string,options:ExtractionProgressApiOptions={}) {
    if(!uuid.test(ownerId))throw new ExtractionTaskError('progress_owner_invalid');
    this.store=store;this.ownerId=ownerId.toLowerCase();this.wake=options.wake;
  }

  /** 只接管原GET与显式POST恢复路径；其他方法和路径返回null。 */
  async handle(method:string,pathname:string,body?:unknown):Promise<ExtractionProgressResponse|null>{
    if(!['GET','POST'].includes(method))return null;
    const route=(pathname.match(/^\/api\/contacts\/([^/]+)\/memory-processing(\/resume)?$/)
      ??pathname.match(/^\/api\/owner\/memory-processing(\/resume)?$/));
    if(!route)return null;
    const ownerScope=pathname.startsWith('/api/owner/');
    const contactRaw=ownerScope?null:route[1]!;
    if(contactRaw!==null&&!uuid.test(contactRaw))return {status:400,body:{error:'memory_processing_request_invalid'}};
    const contactId=contactRaw?.toLowerCase()??null;
    const resume=Boolean(ownerScope?route[1]:route[2]);
    if(method==='GET'&&resume||method==='POST'&&!resume)return null;
    if(method==='GET')return this.read(()=>ownerScope?this.store.ownerProgress(this.ownerId):this.store.progress({ownerId:this.ownerId,contactId:contactId!}));
    let request:Record<string,unknown>;
    try{
      if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();
      request=body as Record<string,unknown>;
      if(Object.keys(request).sort().join(',')!=='action,task_id'||typeof request.task_id!=='string'||!uuid.test(request.task_id)
        ||!['resume','restart'].includes(String(request.action)))throw new Error();
    }catch{return {status:400,body:{error:'memory_processing_request_invalid'}};}
    const taskId=request.task_id.toLowerCase(),action=request.action as 'resume'|'restart';
    try{
      const result=ownerScope?await this.store.resumeOwner(this.ownerId,taskId,action):await this.store.resume({ownerId:this.ownerId,contactId:contactId!},taskId,action);
      if(result.status==='queued')await this.wake?.({ownerId:this.ownerId,contactId:contactId??await this.contactFor(taskId)},taskId);
      return {status:200,body:result};
    }catch(error){return this.conflict(error);}
  }

  private async read(operation:()=>Promise<unknown>):Promise<ExtractionProgressResponse>{
    try{return {status:200,body:await operation()};}
    catch(error){return this.failure(error,true);}
  }
  private async contactFor(taskId:string):Promise<string>{
    const progress=await this.store.ownerProgress(this.ownerId,taskId),task=progress.tasks.find(item=>item.task_id===taskId);
    if(!task)throw new ExtractionTaskError('task_not_found');return task.contact_id;
  }
  private conflict(error:unknown):ExtractionProgressResponse{
    return this.failure(error,false);
  }
  private failure(error:unknown,read:boolean):ExtractionProgressResponse{
    if(error instanceof ExtractionTaskError&&['contact_not_found','owner_not_found','task_not_found'].includes(error.code)){
      return {status:404,body:{error:'memory_processing_not_found'}};
    }
    if(error instanceof ExtractionTaskError&&['worker_scan_invalid','resume_request_invalid'].includes(error.code)){
      return {status:400,body:{error:'memory_processing_request_invalid'}};
    }
    if(error instanceof ExtractionTaskError&&['source_unavailable','resume_action_mismatch','task_no_remaining_step'].includes(error.code)){
      return {status:409,body:{error:'memory_processing_state_conflict'}};
    }
    return {status:503,body:{error:'memory_processing_unavailable'}};
  }
}
