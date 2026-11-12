/** 固定本机 embedding 的宿主生命周期；惰性打开、并发复用，关闭前排空在途推理。 */
import {createLocalEmbedding,embeddingSnapshot,EmbeddingUnavailableError} from '../../retrieval/retrieval-embedding.ts';
import {isAbsolute,join} from 'node:path';
import {stat} from 'node:fs/promises';
import type {EmbedTexts} from '../../retrieval/retrieval-hybrid.ts';

type LocalEmbedding=Pick<Awaited<ReturnType<typeof createLocalEmbedding>>,'embed'|'close'>;
export interface LocalEmbeddingLifecycle {
  embed:EmbedTexts;
  close():Promise<void>;
  opened():boolean;
}

/** 项目目录下的固定语义模型缓存（由 scripts/prepare_memory_embedding.mjs 显式准备，运行时不联网）。 */
export function projectEmbeddingCache(projectDirectory:string):string{return join(projectDirectory,'.models/memory-embedding');}

/** 只核对固定快照的必要文件是否齐全，不加载模型；设置页据此提示安装。 */
export async function projectEmbeddingInstalled(projectDirectory:string):Promise<boolean>{
  const snapshot=embeddingSnapshot(projectEmbeddingCache(projectDirectory));
  const found=await Promise.all(['tokenizer.json','tokenizer_config.json','model_optimized.onnx']
    .map(file=>stat(join(snapshot,file)).then(entry=>entry.isFile(),()=>false)));
  return found.every(Boolean);
}

/** 业务资源由稳定目录定位，不能继承 DSH 为隔离运行而设置的 HOME。 */
export function createBusinessEmbeddingFactory(businessHome:string,cacheDirectory?:string):()=>Promise<LocalEmbedding>{
  const cache=cacheDirectory??join(businessHome,'.cache/notalone/memory-embedding');
  if(!isAbsolute(businessHome)||!isAbsolute(cache)||/[\0\r\n]/.test(businessHome+cache))
    throw new EmbeddingUnavailableError(new Error('embedding_cache_path_invalid'));
  const snapshot=embeddingSnapshot(cache);
  return ()=>createLocalEmbedding(snapshot);
}

export function createLocalEmbeddingLifecycle(
  open:()=>Promise<LocalEmbedding>=createLocalEmbedding,
):LocalEmbeddingLifecycle {
  let model:LocalEmbedding|undefined;
  let opening:Promise<LocalEmbedding>|undefined;
  let closing:Promise<void>|undefined;
  let closed=false;
  const active=new Set<Promise<readonly (readonly number[])[]>>();

  const modelFor=async():Promise<LocalEmbedding>=>{
    if(closed)throw new EmbeddingUnavailableError(new Error('embedding_host_closed'));
    if(model)return model;
    opening??=open().then(value=>{
      // 迟到的模型也交给关闭路径释放；失败时保留引用供明确重试。
      model=value;
      if(closed)throw new EmbeddingUnavailableError(new Error('embedding_host_closed'));
      return value;
    }).finally(()=>{opening=undefined;});
    return opening;
  };

  return {
    embed:async texts=>{
      const operation=modelFor().then(value=>value.embed(texts));
      active.add(operation);
      try{return await operation;}finally{active.delete(operation);}
    },
    opened:()=>Boolean(model),
    close:()=>closing??=(async()=>{
      closed=true;
      while(opening||active.size)await Promise.allSettled([...(opening?[opening]:[]),...active]);
      const current=model;
      await current?.close();
      model=undefined;
    })().catch(error=>{closing=undefined;throw error;}),
  };
}
