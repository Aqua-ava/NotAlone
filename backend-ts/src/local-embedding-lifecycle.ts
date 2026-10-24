/** 固定本机 embedding 的宿主生命周期；惰性打开、并发复用，关闭前排空在途推理。 */
import {createLocalEmbedding,EmbeddingUnavailableError} from './retrieval-embedding.ts';
import type {EmbedTexts} from './retrieval-hybrid.ts';

type LocalEmbedding=Pick<Awaited<ReturnType<typeof createLocalEmbedding>>,'embed'|'close'>;
export interface LocalEmbeddingLifecycle {
  embed:EmbedTexts;
  close():Promise<void>;
  opened():boolean;
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
    opening??=open().then(async value=>{
      if(!closed){
        model=value;
        return value;
      }
      await value.close();
      throw new EmbeddingUnavailableError(new Error('embedding_host_closed'));
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
      model=undefined;
      await current?.close();
    })(),
  };
}
