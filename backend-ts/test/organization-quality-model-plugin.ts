/** 仅供合成验收：官方 profile 下的原公开 HTTP、质量运行器与正式 caller。 */
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-cmdline';
import pg from 'pg';
import {createServer} from 'node:http';
import {resolveAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import {installModelProvider} from '../src/model-provider.ts';
import {createQualityModelCaller} from '../src/quality-model-caller.ts';
import {OrganizationQualityStore,qualityInputSourceRef} from '../src/organization-quality-store.ts';
import {createOrganizationQualityRuntime} from '../src/organization-quality-runtime.ts';
import {createOrganizationQualityApi} from '../src/organization-quality-api.ts';
import {createLayeredMemoryManagement} from '../src/layered-memory-management.ts';

export const name='organization-quality-public-synthetic';
export const inject=['llm','appReady'];
export async function apply(ctx:Context){
  const config=JSON.parse(process.env.NOTALONE_QUALITY_MODEL_CONFIG!);
  const pool=new pg.Pool({host:'/tmp',database:config.database,max:6});
  const transaction=async<T>(work:(client:pg.PoolClient)=>Promise<T>)=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  };
  const owners=(await pool.query('SELECT id FROM public.owner')).rows;
  if(owners.length!==1)throw new Error('合成夹具必须只有一个owner');
  const ownerId=owners[0].id;
  const provider=installModelProvider(ctx,{provider:'synthetic-route',connection:resolveAdapterOptions({
    baseURL:process.env.NOTALONE_SYNTHETIC_PROVIDER_URL!,thinking:'disabled',maxTokens:1024,retryPolicy:{mode:'normal',maxRetries:0},
  }),resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic-quality-public' as never});
  const caller=createQualityModelCaller({ctx,provider,permit:{path:process.env.NOTALONE_MODEL_PERMIT_SOCKET!,token:process.env.NOTALONE_MODEL_PERMIT_TOKEN!}});
  const store=new OrganizationQualityStore({transaction,contract:config.contract});
  const runtime=createOrganizationQualityRuntime({call:input=>caller.call(input),
    binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:1024,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:128_000,safety_margin_tokens:512},
    transportKind:caller.diagnosticProblemBudgetBound?'sdk':'synthetic',
    diagnosticProblemBudgetBound:caller.diagnosticProblemBudgetBound,sourceRef:qualityInputSourceRef});
  const quality=createOrganizationQualityApi({ownerId,transaction,store,runtime});
  const manager=createLayeredMemoryManagement({ownerId,transaction,qualityInput:(client,scope,versions)=>store.insertInputInTransaction(client,scope,versions)});
  const closing=new AbortController(),pending=new Set<Promise<unknown>>();
  const server=createServer(async(req,res)=>{
    const controller=new AbortController();req.once('aborted',()=>controller.abort());
    res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    const work=(async()=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;
      const url=new URL(req.url!,'http://127.0.0.1');
      const signal=AbortSignal.any([controller.signal,closing.signal]);
      const result=await quality.handle(req.method!,url,body,signal)??await manager.handle(req.method!,url,body,signal);
      res.writeHead(result?.status??404,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(result?.body??{error:'not_found'}));
    })();
    pending.add(work);
    try{await work;}catch{if(!res.destroyed){res.writeHead(500);res.end('{}');}}finally{pending.delete(work);}
  });
  const ready=ctx.appReady!.onReady(()=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address();if(address&&typeof address!=='string')process.stdout.write(`QUALITY_MODEL_READY http://127.0.0.1:${address.port}\n`);
  }));
  ctx.on('dispose',async()=>{
    ready();closing.abort();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));
    await Promise.allSettled(pending);await provider.dispose();await pool.end();
  });
}
