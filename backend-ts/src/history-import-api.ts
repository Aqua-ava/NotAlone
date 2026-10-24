/** 单联系人历史导入的公开 HTTP 适配器；文件、范围与数据库都由业务代码校验。 */
import {HistoryImportFormatError} from './history-import-format.ts';
import {HistoryImportError,HistoryImportService,type HistoryImportTransaction,type HistoryImportWake} from './history-import-service.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
export type {HistoryImportTransaction} from './history-import-service.ts';
export {HistoryImportError} from './history-import-service.ts';
export interface HistoryImportApiOptions {
  transaction:HistoryImportTransaction;
  ownerId:string;
  wake?:HistoryImportWake;
}
export interface HistoryImportResponse {status:number;body:Record<string,unknown>}

export class HistoryImportApi {
  private readonly service:HistoryImportService;
  constructor(options:HistoryImportApiOptions){this.service=new HistoryImportService(options);}

  async handle(method:string,pathname:string,body?:unknown):Promise<HistoryImportResponse|null>{
    if(!['/api/imports/preview','/api/imports/commit'].includes(pathname))return null;
    if(method!=='POST')return {status:400,body:{error:'import_request_invalid'}};
    const preview=pathname==='/api/imports/preview';
    try{
      if(preview){
        const request=this.previewRequest(body);
        return {status:200,body:await this.service.preview(request.path,request.contactId)};
      }
      const request=this.commitRequest(body);
      return {status:200,body:{...await this.service.commit(request.path,request.contactId,request.digest)}};
    }catch(error){
      if(error instanceof HistoryImportFormatError)return preview
        ?{status:422,body:{error:'import_preview_failed',reason:'preview_failed'}}
        :{status:409,body:{error:'import_commit_failed'}};
      if(error instanceof HistoryImportError)return {status:error.status,body:{error:error.code}};
      return preview
        ?{status:503,body:{error:'import_preview_failed',reason:'preview_failed'}}
        :{status:503,body:{error:'import_commit_failed'}};
    }
  }

  private previewRequest(value:unknown):{path:string;contactId:string}{
    if(!object(value)||Object.keys(value).sort().join(',')!=='contact_id,path'
      ||typeof value.path!=='string'||!value.path.trim()
      ||typeof value.contact_id!=='string'||!uuid.test(value.contact_id))throw new HistoryImportError('import_request_invalid',400);
    return {path:value.path,contactId:value.contact_id.toLowerCase()};
  }

  private commitRequest(value:unknown):{path:string;contactId:string;digest:string}{
    if(!object(value)||Object.keys(value).sort().join(',')!=='contact_id,expected_content_sha256,path'
      ||typeof value.path!=='string'||!value.path.trim()
      ||typeof value.contact_id!=='string'||!uuid.test(value.contact_id)
      ||typeof value.expected_content_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.expected_content_sha256))throw new HistoryImportError('import_request_invalid',400);
    return {path:value.path,contactId:value.contact_id.toLowerCase(),digest:value.expected_content_sha256};
  }
}
