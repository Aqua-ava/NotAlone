/** 质量用例服务；HTTP 只能提交审核或请求执行，不能直接更改质量终态。 */
import type {OrganizationQualityStore} from './organization-quality-store.ts';
import type {OrganizationQualityRuntime} from './organization-quality-runtime.ts';
import {OrganizationQualityError,qualityInvalid,qualityKeys,type QualityRow} from './organization-quality-contract.ts';
import {buildOrganizationQualityReport} from './organization-quality-report.ts';

export class OrganizationQualityService {
  readonly store:OrganizationQualityStore;
  private readonly runtime:()=>OrganizationQualityRuntime|undefined;
  constructor(options:{store:OrganizationQualityStore;runtime?:()=>OrganizationQualityRuntime|undefined}){
    this.store=options.store;this.runtime=options.runtime??(()=>undefined);
  }
  async report(ownerId:string,runId:string):Promise<QualityRow>{
    const rows=await this.store.reportRows(ownerId,runId);
    return buildOrganizationQualityReport(rows.run,rows.cases,rows.attempts,this.store.contractId,this.store.now());
  }
  async createRun(ownerId:string,payload:unknown):Promise<QualityRow>{
    return this.report(ownerId,await this.store.createRun(ownerId,payload));
  }
  async execute(ownerId:string,runId:string,payload:unknown,signal:AbortSignal):Promise<QualityRow>{
    if(!qualityKeys(payload,['allow_unreviewed_smoke'])||typeof payload.allow_unreviewed_smoke!=='boolean')qualityInvalid();
    const runtime=this.runtime();
    if(!runtime)throw new OrganizationQualityError('quality_evaluation_unavailable',503);
    await runtime.executeNext(this.store,ownerId,runId,payload.allow_unreviewed_smoke,signal);
    return this.report(ownerId,runId);
  }
  async calibrate(ownerId:string,runId:string,payload:unknown):Promise<QualityRow>{
    await this.store.calibrate(ownerId,runId,payload);
    return this.report(ownerId,runId);
  }
}
