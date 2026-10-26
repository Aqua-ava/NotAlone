/** 已认证 owner 的原质量 HTTP 合同；认证仍由唯一公开宿主完成。 */
import {OrganizationQualityStore,type OrganizationQualityStoreOptions} from './organization-quality-store.ts';
import {OrganizationQualityError,qualityInvalid,QUALITY_UUID} from './organization-quality-contract.ts';
import {OrganizationQualityService} from './organization-quality-service.ts';
import type {OrganizationQualityRuntime} from './organization-quality-runtime.ts';

export interface OrganizationQualityApiOptions extends OrganizationQualityStoreOptions {
  ownerId:string;store?:OrganizationQualityStore;runtime?:OrganizationQualityRuntime;
}
export function createOrganizationQualityApi(options:OrganizationQualityApiOptions){
  const store=options.store??new OrganizationQualityStore(options);
  const service=new OrganizationQualityService({store,runtime:()=>options.runtime});
  return {store,service,
    matches(_method:string,url:URL){return /^\/api\/layered-memory\/(quality-inputs|quality-runs)(?:\/|$)/.test(url.pathname);},
    async handle(method:string,url:URL,body:unknown,signal:AbortSignal):Promise<{status:number;body:unknown}|undefined>{
      if(!this.matches(method,url))return;
      try{
        signal.throwIfAborted();
        if(!QUALITY_UUID.test(options.ownerId)||url.search)qualityInvalid();
        const parts=url.pathname.split('/').slice(3),[kind,id,action]=parts;
        if(id&&!QUALITY_UUID.test(id))qualityInvalid();
        if(parts.length===2&&method==='DELETE')return {status:200,body:await store.withdraw(options.ownerId,id,{run:kind==='quality-runs'})};
        if(kind==='quality-inputs'&&parts.length===2&&method==='GET')return {status:200,body:{quality_input:await store.readInput(options.ownerId,id)}};
        if(kind==='quality-inputs'&&parts.length===3&&method==='POST'&&['annotations','review'].includes(action))
          return {status:200,body:{quality_input:await store.reviewInput(options.ownerId,id,body,{output:action==='review'})}};
        if(kind==='quality-runs'){
          if(parts.length===1&&method==='POST')return {status:200,body:{quality_report:await service.createRun(options.ownerId,body)}};
          if(parts.length===2&&method==='GET')return {status:200,body:{quality_report:await service.report(options.ownerId,id)}};
          if(parts.length===3&&method==='POST'&&['execute','calibration'].includes(action)){
            const result=action==='calibration'?await service.calibrate(options.ownerId,id,body)
              :await service.execute(options.ownerId,id,body,signal);
            return {status:200,body:{quality_report:result}};
          }
        }
        return {status:404,body:{error:'not_found'}};
      }catch(error){
        if(error instanceof OrganizationQualityError)return {status:error.status,body:{error:error.code}};
        if(error instanceof TypeError||error instanceof SyntaxError)return {status:400,body:{error:'quality_request_invalid'}};
        return {status:503,body:{error:'quality_evaluation_unavailable'}};
      }
    },
  };
}
