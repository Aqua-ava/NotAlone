/** 记忆处理只读投影的路由适配；不读消息正文，也不触发排队或模型调用。 */
import {ExtractionTaskError,type ExtractionTaskStore} from './extraction-task-store.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ExtractionProgressResponse {status:number;body:unknown}

export class ExtractionProgressApi {
  private readonly store:ExtractionTaskStore;
  private readonly ownerId:string;
  constructor(store:ExtractionTaskStore,ownerId:string) {
    if(!uuid.test(ownerId))throw new ExtractionTaskError('progress_owner_invalid');
    this.store=store;this.ownerId=ownerId.toLowerCase();
  }

  /** 只接管原GET路径；其他方法或路径返回null，继续走现有公开入口。 */
  async handle(method:string,pathname:string):Promise<ExtractionProgressResponse|null>{
    if(method!=='GET')return null;
    if(pathname==='/api/owner/memory-processing'){
      return this.read(()=>this.store.ownerProgress(this.ownerId));
    }
    const match=/^\/api\/contacts\/([^/]+)\/memory-processing$/.exec(pathname);
    if(!match)return null;
    if(!uuid.test(match[1]!))return {status:400,body:{error:'memory_processing_request_invalid'}};
    const contactId=match[1]!.toLowerCase();
    return this.read(()=>this.store.progress({ownerId:this.ownerId,contactId}));
  }

  private async read(operation:()=>Promise<unknown>):Promise<ExtractionProgressResponse>{
    try{return {status:200,body:await operation()};}
    catch(error){
      if(error instanceof ExtractionTaskError&&['contact_not_found','owner_not_found'].includes(error.code)){
        return {status:404,body:{error:'memory_processing_not_found'}};
      }
      if(error instanceof ExtractionTaskError&&error.code==='worker_scan_invalid'){
        return {status:400,body:{error:'memory_processing_request_invalid'}};
      }
      return {status:503,body:{error:'memory_processing_unavailable'}};
    }
  }
}
