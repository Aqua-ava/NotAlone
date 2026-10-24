/** 合成公开链使用实际宿主装配、PG台账及唯一ModelHost；控制面只在测试存在。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {HostStorage} from '../src/host-storage.ts';
import {createHostReplyRuntime} from '../src/host-reply.ts';
import {startModelHost} from '../src/model-host.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../src/model-ledger.ts';
export const name='notalone-exploration-service-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
 const database=process.env.NOTALONE_SYNTHETIC_DATABASE!,owner=process.env.NOTALONE_SYNTHETIC_REPLY_OWNER!,home=process.env.HOME!;
 if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database)||!owner)throw Error('仅允许随机合成库');
 const envFilePath=join(home,'synthetic.env'),skillsRoot=process.env.NOTALONE_SYNTHETIC_SKILLS_ROOT??join(home,'skills');await mkdir(skillsRoot,{recursive:true,mode:0o700});
 await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\nNOTALONE_OWNER_ID=${owner}\n`,{mode:0o600});
 const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../../backend/database/migrations',import.meta.url).pathname,environment:{HOME:home}});
 const host=await startModelHost({runtimeEnvironment:{},businessHome:home,infoPath:join(home,'backend.info'),envFilePath});
 const ledger=new PostgresModelLedger({transaction:fn=>storage.businessTransaction(fn),details:new PostgresModelLedgerDetails()});
 const runtime=await createHostReplyRuntime({ctx,storage,arbiter:host.arbiter,ledger,token:process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN!,configuration:{skillsRoot,
  provider:{provider:'notalone-exploration-service',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never},
  model:{provider:'notalone-exploration-service',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',physical_limit:24,deadline_ms:20000,warning_ratio:0.8,budgetProfile:{context_window_tokens:1048576,safety_margin_tokens:128}}}});
 const server=createServer(async(req,res)=>{if(req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify(host.arbiter.snapshot()));return;}if(await runtime.handle(req,res))return;res.writeHead(404).end('{}');});
 const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const a=server.address();if(a&&typeof a!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${a.port}\n`);}));
 ctx.effect(()=>async()=>{ready();runtime.stopAccepting();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await runtime.close();await host.close(async()=>{});await storage.close();});
}
