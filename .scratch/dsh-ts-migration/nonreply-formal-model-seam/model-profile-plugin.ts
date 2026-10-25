/** 评测薄装配：正式 ModelHost、PG accounting 与公开提取 HTTP 合同。 */
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {HostStorage} from '../../../backend-ts/src/host-storage.ts';
import {startModelHost} from '../../../backend-ts/src/model-host.ts';
import {createHostModelAccounting} from '../../../backend-ts/src/host-model-accounting.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../../../backend-ts/src/model-ledger.ts';
import {createHostReplyRuntime} from '../../../backend-ts/src/host-reply.ts';
import {resolveHostReplyConfiguration} from '../../../backend-ts/src/host-reply-config.ts';
import {SourceProcessingTraceStore} from '../../../backend-ts/src/source-processing-trace.ts';
export const name='notalone-formal-executor-seam';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
  for(const key of ['NOTALONE_HOST_RUNTIME','NOTALONE_REPLY_RUNTIME','NOTALONE_EXTRACTION_RUNTIME','NOTALONE_EXTRACTION_B_RUNTIME',
    'NOTALONE_TASK_WORKER_RUNTIME','NOTALONE_LAYERED_MEMORY_RUNTIME','NOTALONE_SKILL_LEARNING_RUNTIME'])
    if(process.env[key]!=='typescript')throw Error('complete_typescript_responsibility_required');
  if(process.env.NOTALONE_PROBLEM_BUDGET!==undefined||process.env.NOTALONE_PROBLEM_ROUND!==undefined)
    throw Error('inner_problem_budget_would_double_reserve');
  const db=process.env.NA_SEAM_DATABASE!,home=process.env.HOME!,owner=process.env.NA_SEAM_OWNER!,token=process.env.NA_SEAM_TOKEN!;
  if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(db))throw Error('synthetic_database_required');
  const envFilePath=join(home,'synthetic-only.env');
  await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${db}\nNOTALONE_OWNER_ID=${owner}\n`,{mode:0o600});
  const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../../../backend/database/migrations/',import.meta.url).pathname,environment:{HOME:home}});
  let modelHost:Awaited<ReturnType<typeof startModelHost>>;
  const transaction=storage.businessTransaction.bind(storage);
  const effective=resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY:'synthetic-only'});
  if(effective.status!=='configured')throw Error('fixed_control_configuration_unavailable');
  const accounting=createHostModelAccounting({transaction,provider:'deepseek',typescriptProvider:effective.provider.provider,
    model:effective.model.model,unconfirmedPermitIds:()=>modelHost?.unconfirmedPermitIds()??[]});
  modelHost=await startModelHost({runtimeEnvironment:{HOME:home,NOTALONE_EXTRACTION_BATCH_CONCURRENCY:'1'},businessHome:home,
    infoPath:join(home,'info.json'),envFilePath,accounting});
  const skillsRoot=join(home,'skills');await mkdir(skillsRoot,{mode:0o700});
  const tracePool=await storage.businessPool();
  const runtime=await createHostReplyRuntime({ctx,storage,arbiter:modelHost.arbiter,token,publicRuntime:true,
    extractionRetryPolicy:{maxRetries:0,retryDelayMs:0},
    ledger:new PostgresModelLedger({transaction,details:new PostgresModelLedgerDetails()}),
    extractionEnabled:true,extractionAdoptionEnabled:true,extractionConcurrency:1,sourceTraces:new SourceProcessingTraceStore(tracePool),
    extractionPermit:{path:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_SOCKET,token:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_TOKEN},
    configuration:{skillsRoot,model:effective.model,provider:{...effective.provider,
      connection:{...effective.provider.connection,baseURL:process.env.NA_SEAM_BROKER!+'/anthropic'},
      strictVerificationEndpoint:process.env.NA_SEAM_BROKER!+'/beta/chat/completions',resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-only' as never}}});
  const server=createServer(async(req,res)=>{try{if(!await runtime.handle(req,res)){res.statusCode=404;res.end('{}');}}catch{res.statusCode=500;res.end('{}');}});
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const a=server.address();if(a&&typeof a!=='string')process.stdout.write('SEAM_READY '+JSON.stringify({url:`http://127.0.0.1:${a.port}`,
      inner_problem_budget_bound:false,model_host:'startModelHost',model_host_state_path:modelHost.statePath,
      runtime:'typescript',controls:effective.model,ownership:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.endsWith('_RUNTIME'))),
      permit_socket:modelHost.pythonEnvironment.NOTALONE_MODEL_PERMIT_SOCKET})+'\n');}));
  ctx.effect(()=>async()=>{ready();runtime.stopAccepting();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    await runtime.close();await modelHost.close(async()=>{});await tracePool.end();await storage.close();});
}
