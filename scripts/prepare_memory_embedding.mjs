/** 显式准备固定公开向量模型；正常运行只读取同一缓存，不联网。 */
import { mkdir, stat, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createLocalEmbedding, embeddingSnapshot, EMBEDDING_REVISION } from '../backend-ts/src/retrieval/retrieval-embedding.ts';
const repository='Qdrant/bge-small-zh-v1.5', args=process.argv.slice(2);
// 默认放在项目目录的 .models 下（已被 git 忽略），后台从同一位置读取；可用环境变量或 --cache 覆盖。
let cache=process.env.NOTALONE_MEMORY_EMBEDDING_CACHE??resolve(fileURLToPath(new URL('..', import.meta.url)),'.models/memory-embedding'), offline=false;
for(let i=0;i<args.length;i++){
 if(args[i]==='--offline'&&!offline)offline=true;
 else if(args[i]==='--cache'&&args[i+1])cache=resolve(args[++i]);
 else throw Error('embedding_prepare_arguments');
}
const snapshot=embeddingSnapshot(cache);
for(const file of ['tokenizer.json','tokenizer_config.json','model_optimized.onnx']){
 const target=join(snapshot,file), existing=await stat(target).catch(()=>undefined);
 if(existing?.isFile())continue;
 if(offline)throw Error('embedding_snapshot_missing:'+file);
 await mkdir(snapshot,{recursive:true,mode:0o700});
 const response=await fetch(`https://huggingface.co/${repository}/resolve/${EMBEDDING_REVISION}/${file}`,{signal:AbortSignal.timeout(300000)});
 if(!response.ok||!response.body)throw Error('embedding_download_failed:'+file);
 const temporary=target+'.partial-'+process.pid;
 try{await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary,{flags:'wx',mode:0o600}));await rename(temporary,target);}
 finally{await rm(temporary,{force:true});}
}
const model=await createLocalEmbedding(snapshot);
try{const [vector]=await model.embed(['本地中文向量模型自检。']);if(vector.length!==512)throw Error('embedding_dimensions_invalid');console.log(JSON.stringify({model:'BAAI/bge-small-zh-v1.5',revision:EMBEDDING_REVISION,dimensions:vector.length,offline_inference:true}));}
finally{await model.close();}
