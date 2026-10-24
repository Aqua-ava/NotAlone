/** 合成数据经过官方profile和真实宿主回复装配；控制端点仅存在于此测试插件。 */
import type {} from '@deepseek-ai/dsh-cmdline';
import type {Context} from '@deepseek-ai/cordis';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {HostStorage} from '../src/host-storage.ts';
import {createHostReplyRuntime} from '../src/host-reply.ts';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {PostgresModelLedger,PostgresModelLedgerDetails} from '../src/model-ledger.ts';
import {stringifyJson} from '../src/host-json.ts';
export const name='notalone-host-reply-test';
export const inject=['llm','agents','tools','sessions','systemPrompt','skills','appReady'];
export async function apply(ctx:Context){
  const database=process.env.NOTALONE_SYNTHETIC_DATABASE!,owner=process.env.NOTALONE_SYNTHETIC_REPLY_OWNER!;
  if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(database)||!owner)throw Error('仅允许随机合成库及指定合成本人');
  const home=process.env.HOME!,envFilePath=join(home,'synthetic.env'),skillsRoot=join(home,'skills');
  await mkdir(skillsRoot,{mode:0o700});
  await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\nNOTALONE_OWNER_ID=${owner}\n`,{mode:0o600});
  const storage=await HostStorage.open({envFilePath,migrationsDirectory:new URL('../../backend/database/migrations',import.meta.url).pathname,environment:{HOME:home}});
  const arbiter=new ModelPermitArbiter();
  const ledger=new PostgresModelLedger({transaction:work=>storage.businessTransaction(work),details:new PostgresModelLedgerDetails()});
  const runtime=await createHostReplyRuntime({ctx,storage,arbiter,ledger,token:process.env.NOTALONE_SYNTHETIC_REPLY_TOKEN!,configuration:{skillsRoot,
    provider:{provider:'notalone-host-reply-test',connection:resolveAdapterOptions({baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:256,retryPolicy:{mode:'normal',maxRetries:0}}),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-anonymous' as never},
    model:{provider:'notalone-host-reply-test',model:'deepseek-flash',maxTokens:256,temperature:0,reasoningEffort:'off',physical_limit:2,deadline_ms:10000,warning_ratio:0.8,budgetProfile:{context_window_tokens:65536,safety_margin_tokens:128}}}});
  const server=createServer(async(req,res)=>{
    if(await runtime.handle(req,res))return;
    if(req.method==='POST'&&req.url==='/close-reply'){
      runtime.stopAccepting();await Promise.all([runtime.close(),runtime.close()]);
      res.setHeader('content-type','application/json');res.end(stringifyJson({closed:true,permits:arbiter.snapshot()}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`VALIDATION_READY http://127.0.0.1:${address.port}\n`);}));
  ctx.effect(()=>async()=>{
    ready();runtime.stopAccepting();server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await runtime.close();await storage.close();
  });
}
