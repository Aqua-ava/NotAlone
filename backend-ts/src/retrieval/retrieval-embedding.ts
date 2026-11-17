import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Tokenizer } from '@huggingface/tokenizers';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import {EMBEDDING_REVISION} from './embedding-model.ts';
export type EmbedTexts = (texts:readonly string[])=>Promise<readonly (readonly number[])[]>;
export {EMBEDDING_REVISION,EMBEDDING_MODEL} from './embedding-model.ts';
export function embeddingSnapshot(cache=join(homedir(),'.cache/notalone/memory-embedding')):string {
 return join(cache,'models--Qdrant--bge-small-zh-v1.5/snapshots',EMBEDDING_REVISION);
}
export class EmbeddingUnavailableError extends Error {
 constructor(cause?:unknown){super('embedding_unavailable：本机语义模型不可用；请显式准备固定模型后重试，运行时不会下载模型。',{cause});this.name='EmbeddingUnavailableError';}
}
/** 固定公开BERT快照适配：本地文件、CLS pooling、L2归一化，不提供网络加载路径。 */
export async function createLocalEmbedding(snapshot=embeddingSnapshot()) {
 try {
  await stat(join(snapshot,'model_optimized.onnx'));
  const [raw,config]=await Promise.all(['tokenizer.json','tokenizer_config.json'].map(file=>readFile(join(snapshot,file),'utf8').then(JSON.parse)));
  if(config.model_max_length!==512||raw.model?.type!=='WordPiece')throw new Error('固定分词配置不匹配。');
  const tokenizer=new Tokenizer(raw,config);
  const special=['[CLS]','[SEP]','[PAD]'].map(token=>tokenizer.token_to_id(token));
  if(special.some(id=>id===undefined))throw new Error('模型特殊token缺失。');
  const [cls,sep,pad]=special as number[];
  const session=await InferenceSession.create(join(snapshot,'model_optimized.onnx'),{intraOpNumThreads:2,executionProviders:['cpu']});
  function encode(texts:readonly string[]) {
   const rows=texts.map(text=>[cls,...tokenizer.encode(text,{add_special_tokens:false}).ids.slice(0,510),sep]);
   const length=Math.max(0,...rows.map(row=>row.length));
   return {ids:rows.map(row=>[...row,...Array(length-row.length).fill(pad)]),mask:rows.map(row=>[...Array(row.length).fill(1),...Array(length-row.length).fill(0)])};
  }
  return {encode,async embed(texts:readonly string[]):Promise<number[][]> {
   if(!texts.length)return [];
   try {
    const {ids,mask}=encode(texts),shape=[ids.length,ids[0].length];
    const tensor=(rows:number[][])=>new Tensor('int64',BigInt64Array.from(rows.flat().map(BigInt)),shape);
    const inputs:Record<string,Tensor>={input_ids:tensor(ids),attention_mask:tensor(mask)};
    if(session.inputNames.includes('token_type_ids'))inputs.token_type_ids=tensor(ids.map(row=>row.map(()=>0)));
    const outputs=await session.run(inputs);const output=outputs[session.outputNames[0]];
    if(output.dims.length!==3||output.dims[0]!==texts.length||output.dims[2]!==512)throw new Error('模型输出维度不匹配。');
    return texts.map((_,i)=>{const start=i*Number(output.dims[1])*512;const row=Array.from(output.data.slice(start,start+512),Number);const norm=Math.max(1e-12,Math.sqrt(row.reduce((sum,x)=>sum+x*x,0)));return row.map(x=>x/norm);});
   }catch(error){throw new EmbeddingUnavailableError(error);}
  },async close(){await session.release();}};
 }catch(error){throw new EmbeddingUnavailableError(error);}
}
