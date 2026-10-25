/** 官方 profile 的薄装配：生产 HTTP、管理、ModelHost 与真实 PG；不实现业务替身。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {HostStorage} from '../../../backend-ts/src/host-storage.ts';
import {startModelHost} from '../../../backend-ts/src/model-host.ts';
import {createHostModelAccounting} from '../../../backend-ts/src/host-model-accounting.ts';
import {resolveHostReplyConfiguration} from '../../../backend-ts/src/host-reply-config.ts';
import {installModelProvider} from '../../../backend-ts/src/model-provider.ts';
import {SourceProcessingTraceStore} from '../../../backend-ts/src/source-processing-trace.ts';
import {createL2ScenarioHost} from '../../../backend-ts/src/l2-scenario-host.ts';
import {createL2ScenarioHttp} from '../../../backend-ts/src/l2-scenario-http.ts';
import {createL2ScenarioSourceValidator} from '../../../backend-ts/src/l2-scenario-source-validation.ts';
import {createLayeredMemoryManagement} from '../../../backend-ts/src/layered-memory-management.ts';
export const name='notalone-layered-formal-driver';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
  if(process.env.NOTALONE_PROBLEM_BUDGET!==undefined||process.env.NOTALONE_PROBLEM_ROUND!==undefined)throw Error('inner_problem_budget_would_double_reserve');
  const home=process.env.HOME!,database=process.env.NA_LAYERED_DATABASE!,owner=process.env.NA_LAYERED_OWNER!,token=process.env.NA_LAYERED_TOKEN!;
  if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database))throw Error('synthetic_database_required');
  const envFilePath=join(home,'synthetic-fixture.env');await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\nNOTALONE_OWNER_ID=${owner}\n`,{mode:0o600});
  const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../../../backend/database/migrations/',import.meta.url).pathname,environment:{HOME:home}});
  const pool=await storage.businessPool(),transaction=storage.businessTransaction.bind(storage);
  const config=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS:'393216'});
  if(config.status!=='configured')throw Error('layered_profile_configuration_unavailable');
  let modelHost:Awaited<ReturnType<typeof startModelHost>>;
  const accounting=createHostModelAccounting({transaction,provider:'deepseek',typescriptProvider:config.model.provider,model:config.model.model,unconfirmedPermitIds:()=>modelHost?.unconfirmedPermitIds()??[]});
  modelHost=await startModelHost({runtimeEnvironment:{HOME:home,NOTALONE_EXTRACTION_BATCH_CONCURRENCY:'1'},businessHome:home,infoPath:join(home,'info.json'),envFilePath,accounting});
  const provider=installModelProvider(ctx,{...config.provider,connection:{...config.provider.connection,baseURL:process.env.NA_LAYERED_BROKER!+'/anthropic'},resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-only' as never});
  const asOf=new Date(process.env.NA_LAYERED_AS_OF!);if(!Number.isFinite(asOf.getTime()))throw Error('frozen_as_of_required');
  const clockMode=process.env.NA_LAYERED_CLOCK_MODE;
  if(!['wall','frozen_content'].includes(clockMode??''))throw Error('explicit_evaluation_clock_mode_required');
  const now=clockMode==='wall'?()=>new Date():()=>asOf;
  // L3 内部仍复用 now 创建租约，故冻结内容时钟保持未获正式资格；不改全局 Date 或 PG 时钟。
  const layered=createL2ScenarioHost({ctx,transaction,provider,permit:{path:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_SOCKET,token:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_TOKEN},
    binding:config.model,profile:config.model.budgetProfile,now,validateSources:createL2ScenarioSourceValidator(new SourceProcessingTraceStore(pool))});
  const management=createLayeredMemoryManagement({ownerId:owner,transaction,read:(scope,cursor)=>layered.read(scope,cursor),modelWorkAvailable:()=>true,now});
  const http=createL2ScenarioHttp({ownerId:owner,token,service:layered.service});
  const active=new Set<Promise<unknown>>();
  const server=createServer((req,res)=>{const p=(async()=>{try{
    if(await http.handlePrivate(req,res))return;
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('{}');return;}
    const url=new URL(req.url??'','http://localhost');let raw='';for await(const b of req)raw+=b;
    const result=await management.handle(req.method??'',url,raw?JSON.parse(raw):undefined,new AbortController().signal);
    res.writeHead(result?.status??404,{'content-type':'application/json'});res.end(JSON.stringify(result?.body??{}));
  }catch(error){process.stderr.write('LAYERED_HTTP_ERROR '+String((error as Error).stack)+'\n');res.writeHead(503);res.end('{"error":"layered_driver_http_failed"}');}})();active.add(p);p.finally(()=>active.delete(p));});
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')process.stdout.write('LAYERED_READY '+JSON.stringify({url:`http://127.0.0.1:${address.port}`,model_host:'startModelHost',model_host_state_path:modelHost.statePath,python_environment:modelHost.pythonEnvironment,
    controls:config.model,clock:{mode:clockMode,requested_content_as_of:asOf.toISOString(),effective_content_as_of:now().toISOString(),source:clockMode==='wall'?'actual_wall_clock_engineering_only':'frozen.input.as_of',leases:'PG clock_timestamp()',formal_qualified:false},sdk_retry:0,business_retry:0})+'\n');}));
  ctx.effect(()=>async()=>{ready();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await Promise.allSettled(active);await modelHost.close(async()=>{});await pool.end();await storage.close();});
}
